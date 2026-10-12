// js/chain-sol.js — Solana sending, pure functions only (no network).
//
// Scope (docs/NON-EVM-SENDING.md M5): a System Program transfer of SOL, built
// and signed exactly the way a validator will read it. No SPL tokens, no
// associated token accounts, no versioned/address-lookup transactions.
//
// Proving it: tests/chain-sol.test.js takes a REAL mainnet transaction (slot
// 455795337), rebuilds its message from the plain fields, and compares the
// bytes — then verifies the published signature against the sender's address.
// A Solana address IS the base58 of the 32-byte ed25519 public key, so a
// verified signature over a byte-exact rebuilt message pins the whole layout:
// header, account ordering, compact-u16 lengths, the blockhash and the
// 12-byte transfer payload. Nothing about it can be off by a byte.
import { base58Decode, base58Encode, ed25519Sign, ed25519Verify, ed25519PublicKey } from './coin-trees.js';

const { ethers } = globalThis;

export const SOL_SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const SOL_LAMPORTS = 1000000000n;
export const SOL_BASE_FEE = 5000n;            // per signature, in lamports
export const SOL_TRANSFER_INSTRUCTION = 2;    // System Program: Transfer

export const SOL_NETWORKS = {
  mainnet: { label: 'Solana', rpc: 'https://api.mainnet-beta.solana.com' },
  devnet: { label: 'Solana devnet', rpc: 'https://api.devnet.solana.com' },
};

// ── byte helpers ────────────────────────────────────────────────────────

function bytesOf(value) {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value) || ArrayBuffer.isView(value)) return Uint8Array.from(value);
  if (typeof value === 'string' && value.length % 2 === 0 && /^[0-9a-fA-F]*$/.test(value)) {
    return ethers.getBytes(`0x${value}`);
  }
  return ethers.getBytes(value);
}

function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/**
 * Solana's "short_vec" length prefix: 7 bits per byte, little-endian groups,
 * high bit = "more follows". Every count we emit is tiny, but a wrong length
 * byte shifts the entire message, so the general form is here rather than a
 * single-byte shortcut.
 */
export function compactU16(value) {
  let v = Number(value);
  if (!Number.isInteger(v) || v < 0) throw new Error('SOL: compact-u16 needs a non-negative integer');
  const out = [];
  do { let b = v & 0x7f; v >>>= 7; if (v > 0) b |= 0x80; out.push(b); } while (v > 0);
  return Uint8Array.from(out);
}

function u64le(value) {
  let v = BigInt(value);
  if (v < 0n) throw new Error('SOL: cannot serialize a negative amount');
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i += 1) { out[i] = Number(v & 0xffn); v >>= 8n; }
  if (v !== 0n) throw new Error('SOL: amount does not fit in 64 bits');
  return out;
}

// ── addresses ───────────────────────────────────────────────────────────

/** A Solana address is the base58 of a 32-byte public key — nothing else. */
export function decodeSolAddress(address) {
  const text = String(address == null ? '' : address).trim();
  if (!text) throw new Error('SOL: enter a destination address');
  let raw;
  try {
    raw = base58Decode(text);
  } catch {
    throw new Error('SOL: that is not a valid address');
  }
  if (raw.length !== 32) throw new Error('SOL: a Solana address is 32 bytes (48 base58 characters or fewer)');
  return { publicKey: raw, address: text };
}

export function solAddressFromPublicKey(publicKey) {
  const key = bytesOf(publicKey);
  if (key.length !== 32) throw new Error('SOL: a public key is 32 bytes');
  return base58Encode(key);
}

// ── amount ──────────────────────────────────────────────────────────────

/** SOL (a decimal string) → lamports, with no floating point anywhere. */
export function solToLamports(amountSol) {
  const text = String(amountSol == null ? '' : amountSol).trim();
  if (!/^\d*(\.\d*)?$/.test(text) || text === '' || text === '.') throw new Error('SOL: enter an amount');
  const [whole, frac = ''] = text.split('.');
  if (frac.length > 9) throw new Error('SOL: a SOL amount has at most 9 decimal places');
  const lamports = BigInt(whole || '0') * SOL_LAMPORTS + BigInt((frac + '000000000').slice(0, 9));
  if (lamports <= 0n) throw new Error('SOL: amount must be greater than zero');
  return lamports;
}

export function lamportsToSol(lamports) {
  const value = BigInt(lamports);
  const whole = value / SOL_LAMPORTS;
  const frac = (value % SOL_LAMPORTS).toString().padStart(9, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}

// ── instruction ─────────────────────────────────────────────────────────

/**
 * System Program Transfer: 4-byte little-endian instruction index (2) followed
 * by the amount as a 64-bit little-endian integer.
 */
export function systemTransferInstruction({ from, to, lamports }) {
  const amount = BigInt(lamports);
  if (amount <= 0n) throw new Error('SOL: amount must be greater than zero');
  decodeSolAddress(from);
  const destination = decodeSolAddress(to);
  // The System Program's own address — 32 zero bytes, "111…1" — is a valid key
  // with no known private key. The ledger accepts a transfer to it and the funds
  // are gone, so it is refused here by name rather than left as a trap.
  if (destination.publicKey.every((b) => b === 0)) {
    throw new Error('SOL: that address has no known key — anything sent there is lost');
  }
  const data = concat(Uint8Array.from([SOL_TRANSFER_INSTRUCTION, 0, 0, 0]), u64le(amount));
  return {
    programId: SOL_SYSTEM_PROGRAM,
    keys: [
      { address: from, signer: true, writable: true },
      { address: to, signer: false, writable: true },
    ],
    data,
  };
}

// ── message ─────────────────────────────────────────────────────────────

/**
 * Compile a legacy message. The account list is not free-form: signers come
 * before non-signers, writable before read-only, and the fee payer must sit at
 * index 0. A validator derives who signs what from the header counts alone, so
 * getting the buckets wrong changes the meaning of the transaction.
 */
export function compileSolMessage({ feePayer, instructions, recentBlockhash }) {
  if (!feePayer) throw new Error('SOL: a fee payer is required');
  if (!recentBlockhash) throw new Error('SOL: a recent blockhash is required');
  const blockhash = decodeSolAddress(recentBlockhash).publicKey;
  decodeSolAddress(feePayer);
  if (!Array.isArray(instructions) || instructions.length === 0) throw new Error('SOL: at least one instruction is required');

  // Merge duplicate keys (an address can appear as both payer and signer), OR-ing
  // the signer/writable flags, so the same account is never listed twice.
  const byAddress = new Map();
  const note = (address, signer, writable) => {
    decodeSolAddress(address);
    const prev = byAddress.get(address);
    byAddress.set(address, {
      address,
      signer: Boolean(signer) || Boolean(prev && prev.signer),
      writable: Boolean(writable) || Boolean(prev && prev.writable),
    });
  };
  note(feePayer, true, true); // the fee payer is always a writable signer
  for (const ix of instructions) {
    if (!ix || !ix.programId) throw new Error('SOL: every instruction needs a programId');
    note(ix.programId, false, false);
    for (const key of ix.keys || []) note(key.address, key.signer, key.writable);
  }

  const buckets = [
    [...byAddress.values()].filter((k) => k.signer && k.writable),
    [...byAddress.values()].filter((k) => k.signer && !k.writable),
    [...byAddress.values()].filter((k) => !k.signer && k.writable),
    [...byAddress.values()].filter((k) => !k.signer && !k.writable),
  ];
  // Fee payer first, then the rest in stable insertion order.
  const ordered = [];
  for (const bucket of buckets) {
    bucket.sort((a, b) => (a.address === feePayer ? -1 : b.address === feePayer ? 1 : 0));
    ordered.push(...bucket);
  }
  const index = new Map(ordered.map((k, i) => [k.address, i]));

  const requiredSignatures = ordered.filter((k) => k.signer).length;
  const readonlySigned = ordered.filter((k) => k.signer && !k.writable).length;
  const readonlyUnsigned = ordered.filter((k) => !k.signer && !k.writable).length;
  if (requiredSignatures > 255) throw new Error('SOL: too many signers for a legacy transaction');

  const header = Uint8Array.from([requiredSignatures, readonlySigned, readonlyUnsigned]);
  const keysBytes = concat(...ordered.map((k) => decodeSolAddress(k.address).publicKey));

  const encodedIx = instructions.map((ix) => {
    const programIndex = index.get(ix.programId);
    if (programIndex === undefined) throw new Error('SOL: instruction program is not in the account list');
    const accountIndexes = (ix.keys || []).map((key) => {
      const at = index.get(key.address);
      if (at === undefined) throw new Error('SOL: instruction account is not in the account list');
      return Uint8Array.from([at]);
    });
    const data = bytesOf(ix.data || new Uint8Array(0));
    return concat(
      Uint8Array.from([programIndex]),
      compactU16(accountIndexes.length),
      ...accountIndexes,
      compactU16(data.length),
      data,
    );
  });

  return concat(
    header,
    compactU16(ordered.length),
    keysBytes,
    blockhash,
    compactU16(encodedIx.length),
    ...encodedIx,
  );
}

// ── signing ─────────────────────────────────────────────────────────────

/** Deterministic RFC-8032 signature over the message, 64 bytes. */
export function signSolMessage(privateKey, message) {
  return ed25519Sign(privateKey, message);
}

/**
 * Build, sign and serialize one SOL transfer.
 *
 * Returns the raw transaction as bytes and as base64 (what `sendTransaction`
 * takes), plus the transaction id — which on Solana is simply the base58 of the
 * first signature.
 */
export function buildSolSend({ privateKey, from, to, lamports, recentBlockhash }) {
  const payer = decodeSolAddress(from);
  const key = bytesOf(privateKey);
  if (key.length !== 32) throw new Error('SOL: a private key is 32 bytes');
  // The payer we sign for must be the account whose key we hold, or we would be
  // building a transaction our own key cannot authorise.
  const derived = solAddressFromPublicKey(ed25519PublicKeyOf(key));
  if (derived !== payer.address) throw new Error('SOL: this wallet does not control the sending account');

  const instruction = systemTransferInstruction({ from, to, lamports });
  const message = compileSolMessage({
    feePayer: from,
    instructions: [instruction],
    recentBlockhash,
  });
  const signature = signSolMessage(key, message);
  const raw = concat(compactU16(1), signature, message);
  return {
    rawTransaction: ethers.hexlify(raw),
    rawTransactionBase64: base64FromBytes(raw),
    signature: base58Encode(signature),
    txid: base58Encode(signature),
    message: ethers.hexlify(message),
  };
}

// The public key for a 32-byte ed25519 private key, without re-deriving the
// HD path — ed25519Sign/Verify live in coin-trees next to the curve maths.
function ed25519PublicKeyOf(privateKey32) {
  // Derived from the same clamped scalar the signer uses, so address and key
  // can never disagree (see coin-trees: ed25519PublicKey/ed25519Sign).
  return ed25519PublicKey(privateKey32);
}

export function bytesFromBase64(text) {
  const binary = globalThis.atob(String(text));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export function base64FromBytes(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return globalThis.btoa(binary);
}

export { ed25519Verify, base58Encode };
