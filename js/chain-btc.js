// js/chain-btc.js — Bitcoin sending, pure functions only (no network).
//
// Scope (docs/NON-EVM-SENDING.md M2): decode/validate a destination, build the
// BIP-143 sighash for a P2WPKH input, sign it with a low-S DER secp256k1
// signature, and assemble the signed transaction. Everything here is provable
// offline against the official BIP-143 test vector (tests/chain-btc.test.js).
//
// Deliberately NOT here: UTXO fetching, broadcast, coin-selection policy, UI.
// Those live in js/non-evm-rpc.js + js/app.js so this file stays deterministic.
//
// `const { ethers } = globalThis` at module load — the same rule as js/app.js
// and js/coin-trees.js (the vendored bundle runs before the module).
import { bech32Decode, base58Decode, convertBits, sha256d } from './coin-trees.js';

const { ethers } = globalThis;

// ── network parameters ──────────────────────────────────────────────────
// A Bitcoin address carries the network it belongs to (an hrp, or a base58
// version byte). Sending on the wrong one is how funds get lost, so the active
// network must match the address EXACTLY — no fallback, no guessing.
export const BTC_NETWORKS = {
  mainnet: { label: 'Bitcoin', hrp: 'bc', p2pkh: 0x00, p2sh: 0x05, dust: 546 },
  testnet: { label: 'Bitcoin testnet', hrp: 'tb', p2pkh: 0x6f, p2sh: 0xc4, dust: 546 },
  signet: { label: 'Bitcoin signet', hrp: 'tb', p2pkh: 0x6f, p2sh: 0xc4, dust: 546 },
  regtest: { label: 'Bitcoin regtest', hrp: 'bcrt', p2pkh: 0x6f, p2sh: 0xc4, dust: 546 },
};

export const BTC_DUST = 546;
const SIGHASH_ALL = 1;
const DEFAULT_SEQUENCE = 0xfffffffd; // RBF-signalling, and not final

// secp256k1 group order. Signatures with s > n/2 are flipped to the low form so
// every transaction we sign is standard and its signature cannot be mutated.
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SECP256K1_HALF_N = SECP256K1_N / 2n;

function netParams(network) {
  const p = BTC_NETWORKS[network];
  if (!p) throw new Error(`Bitcoin: unknown network "${network}"`);
  return p;
}

// ── small byte helpers (Uint8Array only — this runs in a browser) ───────

function bytesOf(value) {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value) || ArrayBuffer.isView(value)) return Uint8Array.from(value);
  // Bare hex is accepted on purpose: BIPs and block explorers print scripts and
  // txids without a 0x prefix, and a caller pasting those should not have to
  // remember which of our fields wants the prefix.
  if (typeof value === 'string' && value.length % 2 === 0 && /^[0-9a-fA-F]*$/.test(value)) {
    return ethers.getBytes(`0x${value}`);
  }
  return ethers.getBytes(value);
}

function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function u16(n) {
  return Uint8Array.from([n & 0xff, (n >>> 8) & 0xff]);
}

function u32(n) {
  const v = Number(n) >>> 0;
  return Uint8Array.from([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);
}

function u64(n) {
  let v = BigInt(n);
  if (v < 0n) throw new Error('Bitcoin: cannot serialize a negative amount');
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i += 1) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function varint(n) {
  const v = Number(n);
  if (v < 0) throw new Error('Bitcoin: cannot serialize a negative count');
  if (v < 0xfd) return Uint8Array.from([v]);
  if (v <= 0xffff) return concat(Uint8Array.from([0xfd]), u16(v));
  if (v <= 0xffffffff) return concat(Uint8Array.from([0xfe]), u32(v));
  return concat(Uint8Array.from([0xff]), u64(v));
}

/** A txid (display big-endian hex) becomes the little-endian outpoint bytes. */
function outpointBytes(txidHex) {
  const h = String(txidHex).replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new Error(`Bitcoin: not a txid — "${txidHex}"`);
  const out = ethers.getBytes(`0x${h}`);
  out.reverse();
  return out;
}

// ── address decoding ────────────────────────────────────────────────────

/**
 * Decode a Bitcoin destination into the script it pays and the network it
 * belongs to. Throws — never returns a best guess — for a wrong network, a bad
 * checksum, a taproot destination, or anything else we cannot pay.
 */
export function decodeBtcAddress(address, network = 'mainnet') {
  const p = netParams(network);
  const addr = String(address == null ? '' : address).trim();
  if (!addr) throw new Error('Bitcoin: enter a destination address');

  if (/^(bc|tb|bcrt)1/i.test(addr)) {
    const { hrp, data, encoding } = bech32Decode(addr);
    if (hrp !== p.hrp) {
      throw new Error(`Bitcoin: that is not a ${p.label} address (expected ${p.hrp}1…)`);
    }
    if (encoding === 'bech32m') throw new Error('Bitcoin: taproot (bc1p…) destinations are not supported yet');
    // `data` holds 5-bit words: [witnessVersion, ...programWords].
    const version = data[0];
    if (version !== 0) throw new Error('Bitcoin: only segwit v0 (P2WPKH) destinations are supported');
    const program = Uint8Array.from(convertBits(data.slice(1), 5, 8, false));
    if (program.length !== 20) throw new Error('Bitcoin: witness program must be 20 bytes');
    return { type: 'p2wpkh', program, network, hrp };
  }

  // Everything else is base58check: P2PKH ("1…/m…/n…") or P2SH ("3…/2…").
  let raw;
  try {
    raw = base58Decode(addr);
  } catch {
    throw new Error('Bitcoin: that is not a valid address (neither bech32 nor base58check)');
  }
  if (raw.length !== 25) throw new Error('Bitcoin: that is not a valid address (wrong length)');
  const payload = raw.slice(0, 21);
  const checksum = raw.slice(21);
  if (!sameBytes(checksum, sha256d(payload).slice(0, 4))) throw new Error('Bitcoin: address checksum does not match');
  const version = payload[0];
  const hash160 = payload.slice(1);
  if (version === p.p2pkh) return { type: 'p2pkh', hash160, network };
  if (version === p.p2sh) return { type: 'p2sh', hash160, network };
  throw new Error(`Bitcoin: that is not a ${p.label} address (version byte 0x${version.toString(16)})`);
}

/** The output script that pays a decoded destination. */
export function btcScriptPubKey(dest) {
  if (dest.type === 'p2wpkh') return concat(Uint8Array.from([0x00, 0x14]), dest.program);
  if (dest.type === 'p2pkh') return concat(Uint8Array.from([0x76, 0xa9, 0x14]), dest.hash160, Uint8Array.from([0x88, 0xac]));
  if (dest.type === 'p2sh') return concat(Uint8Array.from([0xa9, 0x14]), dest.hash160, Uint8Array.from([0x87]));
  throw new Error(`Bitcoin: no script for destination type "${dest.type}"`);
}

/** P2WPKH scriptCode for BIP-143: OP_DUP OP_HASH160 <20> OP_EQUALVERIFY OP_CHECKSIG. */
export function p2wpkhScriptCode(hash160) {
  return concat(Uint8Array.from([0x76, 0xa9, 0x14]), hash160, Uint8Array.from([0x88, 0xac]));
}

/** The P2WPKH scriptPubKey / scriptCode for one compressed public key. */
export function p2wpkhProgram(compressedPubKey) {
  return ethers.getBytes(ethers.ripemd160(ethers.sha256(compressedPubKey)));
}

// ── serialization ───────────────────────────────────────────────────────

function dsha256(bytes) {
  return sha256d(bytes);
}

/** txid of a serialized transaction: double-SHA256, byte-reversed to display order. */
export function btcTxid(rawHexOrBytes) {
  const bytes = bytesOf(rawHexOrBytes);
  const hash = dsha256(bytes);
  const hex = ethers.hexlify(hash).slice(2);
  return hex.match(/../g).reverse().join('');
}

/**
 * Serialize a transaction. Each input is `{ txid, vout, sequence, scriptSig,
 * witness }`; a transaction with any witness input is written with the BIP-144
 * marker/flag so its txid is the witness txid (not a hash of the stripped form).
 */
export function serializeBtcTx({ version = 2, inputs, outputs, lockTime = 0 }) {
  if (!Array.isArray(inputs) || !inputs.length) throw new Error('Bitcoin: a transaction needs at least one input');
  if (!Array.isArray(outputs) || !outputs.length) throw new Error('Bitcoin: a transaction needs at least one output');
  const hasWitness = inputs.some((i) => Array.isArray(i.witness) && i.witness.length > 0);
  const parts = [u32(version)];
  if (hasWitness) parts.push(Uint8Array.from([0x00, 0x01]));
  parts.push(varint(inputs.length));
  for (const i of inputs) {
    const script = i.scriptSig ? bytesOf(i.scriptSig) : new Uint8Array();
    parts.push(outpointBytes(i.txid), u32(i.vout), varint(script.length), script, u32(i.sequence == null ? DEFAULT_SEQUENCE : i.sequence));
  }
  parts.push(varint(outputs.length));
  for (const o of outputs) {
    const script = bytesOf(o.script);
    parts.push(u64(o.value), varint(script.length), script);
  }
  if (hasWitness) {
    for (const i of inputs) {
      const witness = Array.isArray(i.witness) ? i.witness : [];
      parts.push(varint(witness.length));
      for (const item of witness) {
        const bytes = bytesOf(item);
        parts.push(varint(bytes.length), bytes);
      }
    }
  }
  parts.push(u32(lockTime));
  return ethers.hexlify(concat(...parts));
}

/** BIP-143 sighash for one P2WPKH input (SIGHASH_ALL — the only flavour we sign). */
export function bip143Sighash({ version = 2, inputs, outputs, lockTime = 0, inputIndex, amount, scriptCode, hashType = SIGHASH_ALL }) {
  if (!(inputIndex >= 0 && inputIndex < inputs.length)) throw new Error('Bitcoin: input index out of range');
  if (hashType !== SIGHASH_ALL) throw new Error('Bitcoin: only SIGHASH_ALL is supported');
  const prevouts = concat(...inputs.map((i) => concat(outpointBytes(i.txid), u32(i.vout))));
  const sequences = concat(...inputs.map((i) => u32(i.sequence == null ? DEFAULT_SEQUENCE : i.sequence)));
  const outputsBlob = concat(...outputs.map((o) => {
    const script = bytesOf(o.script);
    return concat(u64(o.value), varint(script.length), script);
  }));
  const it = inputs[inputIndex];
  const code = bytesOf(scriptCode);
  const preimage = concat(
    u32(version),
    dsha256(prevouts),
    dsha256(sequences),
    outpointBytes(it.txid),
    u32(it.vout),
    varint(code.length),
    code,
    u64(amount),
    u32(it.sequence == null ? DEFAULT_SEQUENCE : it.sequence),
    dsha256(outputsBlob),
    u32(lockTime),
    u32(hashType),
  );
  return ethers.hexlify(dsha256(preimage));
}

// ── signing ─────────────────────────────────────────────────────────────

function derInteger(bytes) {
  let b = bytes;
  while (b.length > 1 && b[0] === 0) b = b.slice(1);
  const out = b[0] & 0x80 ? concat(Uint8Array.from([0x00]), b) : b;
  return concat(Uint8Array.from([0x02, out.length]), out);
}

/** DER-encode a signature, flipping s to its low form first. */
export function derSignature(r, s) {
  let sBytes = bytesOf(s);
  const sValue = BigInt(ethers.hexlify(sBytes));
  if (sValue > SECP256K1_HALF_N) sBytes = ethers.getBytes(ethers.toBeHex(SECP256K1_N - sValue, 32));
  const body = concat(derInteger(bytesOf(r)), derInteger(sBytes));
  return concat(Uint8Array.from([0x30, body.length]), body);
}

/**
 * Sign a 32-byte digest, returning the DER signature plus the trailing
 * SIGHASH_ALL byte — exactly what a P2WPKH witness item carries. Nonces are
 * RFC-6979 deterministic through ethers; the official BIP-143 vector proves
 * this reproduces a published signature byte for byte.
 */
export function signDer(privateKey, digest) {
  const key = privateKey instanceof Uint8Array ? ethers.hexlify(privateKey) : privateKey;
  const sig = new ethers.SigningKey(key).sign(digest);
  return concat(derSignature(sig.r, sig.s), Uint8Array.from([SIGHASH_ALL]));
}

// ── the whole flow ──────────────────────────────────────────────────────

/**
 * Build and sign a transaction spending P2WPKH coins to one destination.
 *
 * `utxos` are `{ txid, vout, value }` in satoshi, already selected by the
 * caller. Change (when it clears dust) always returns to our own P2WPKH
 * address — and we verify the key really controls that address before signing.
 */
export function buildBtcSend({ privateKey, utxos, to, amountSat, feeSat, changeAddress, network = 'mainnet', lockTime = 0, sequence = DEFAULT_SEQUENCE }) {
  const p = netParams(network);
  if (!Array.isArray(utxos) || !utxos.length) throw new Error('Bitcoin: nothing to spend on this address yet');
  const amount = BigInt(amountSat);
  const fee = BigInt(feeSat);
  if (amount <= 0n) throw new Error('Bitcoin: amount must be greater than zero');
  const total = utxos.reduce((acc, u) => acc + BigInt(u.value), 0n);
  if (total < amount + fee) throw new Error('Bitcoin: not enough to cover the amount plus the fee');

  const dest = decodeBtcAddress(to, network);
  const change = decodeBtcAddress(changeAddress, network);
  if (change.type !== 'p2wpkh') throw new Error('Bitcoin: change must return to our own segwit address');

  const sk = new ethers.SigningKey(privateKey);
  const program = p2wpkhProgram(ethers.getBytes(sk.compressedPublicKey));
  if (!sameBytes(program, change.program)) throw new Error('Bitcoin: this wallet does not control the change address');

  const inputs = utxos.map((u) => ({ txid: u.txid, vout: u.vout, sequence }));
  const outputs = [{ value: amount, script: btcScriptPubKey(dest) }];
  const changeValue = total - amount - fee;
  // A change output below dust can never be spent, so it is dropped. Note the
  // leftover is not returned to us when that happens: fee = inputs - outputs,
  // so the whole remainder is taken by the miner.
  const changeKept = changeValue >= BigInt(p.dust);
  if (changeKept) outputs.push({ value: changeValue, script: btcScriptPubKey(change) });

  const scriptCode = p2wpkhScriptCode(change.program);
  const signed = inputs.map((input, index) => {
    const digest = bip143Sighash({ inputs, outputs, lockTime, inputIndex: index, amount: utxos[index].value, scriptCode });
    return { ...input, witness: [signDer(privateKey, digest), ethers.getBytes(sk.compressedPublicKey)] };
  });
  const hex = serializeBtcTx({ inputs: signed, outputs, lockTime });
  // The txid covers the STRIPPED transaction. `inputs` are still bare here, so
  // re-serializing them (no witness) is exactly the stripped form — hashing the
  // signed hex instead would produce an id no explorer would recognise.
  const stripped = serializeBtcTx({ inputs, outputs, lockTime });
  // Report what the chain will really see. With no change output the fee is
  // inputs - outputs = total - amount (larger than the estimate), and the change
  // is zero — echoing the passed fee/changeValue here would describe a different
  // transaction than the one this hex signs.
  const feePaid = changeKept ? fee : total - amount;
  const changeOut = changeKept ? changeValue : 0n;
  return { hex, txid: btcTxid(stripped), fee: Number(feePaid), change: Number(changeOut), bytes: (hex.length - 2) / 2 };
}

/**
 * Weight of a transaction BEFORE the witness exists: 4 × the stripped size plus
 * the witness. A P2WPKH input is 41 base bytes + 108 witness bytes; outputs are
 * 31 (P2WPKH), 32 (P2SH) or 34 (P2PKH) with the count and overhead included.
 */
export function estimateVsize({ nIn = 1, outputs = ['p2wpkh'] } = {}) {
  const OUT = { p2wpkh: 31, p2sh: 32, p2pkh: 34 };
  const stripped = 10 + nIn * 41 + outputs.reduce((n, t) => n + (OUT[t] == null ? 34 : OUT[t]), 0);
  const witness = nIn * 108;
  return Math.ceil(stripped + witness / 4);
}
