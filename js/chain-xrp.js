// js/chain-xrp.js — XRP Ledger sending, pure functions only (no network).
//
// Scope (docs/NON-EVM-SENDING.md M4): decode a classic r… address, serialize a
// Payment the way the ledger's binary format demands, sign it with secp256k1
// and produce the blob a node will accept plus the transaction id.
//
// The field ids, the field ORDER and the amount encoding are not guesses: the
// official definitions (XRPLF/xrpl.js ripple-binary-codec definitions.json) say
// which id each field has, and tests/chain-xrp.test.js replays a REAL mainnet
// payment — if a single id, order byte or length prefix were wrong, the
// recomputed transaction hash would not equal the one the ledger published.
//
// Deliberately NOT here: issued currencies (Amount as "100/USD/rXXX"), trust
// lines, memos, X-addresses (X… packs a tag into the address — refusing it is
// safer than unpacking it wrong), pathfinding.
import { xrpBase58Decode, xrpBase58Encode } from './coin-trees.js';
import { derSignature } from './chain-btc.js';

const { ethers } = globalThis;

export const XRP_DROPS = 1000000;
export const XRP_MIN_FEE_DROPS = 12;

export const XRP_NETWORKS = {
  mainnet: { label: 'XRP Ledger', rpc: 'https://s1.ripple.com:51234' },
  testnet: { label: 'XRP testnet', rpc: 'https://s.altnet.rippletest.net:51234' },
};

// Every XRP transaction is hashed with one of two four-byte prefixes.
const STX_PREFIX = Uint8Array.from([0x53, 0x54, 0x58, 0x00]); // "STX\0" — signing
const TXN_PREFIX = Uint8Array.from([0x54, 0x58, 0x4e, 0x00]); // "TXN\0" — id

// The high bit of an XRP-denominated amount is set; a clear high bit means an
// issued currency, which we refuse rather than mis-encode.
const XRP_AMOUNT_FLAG = 0x4000000000000000n;

const PAYMENT = 0;

// Type codes from definitions.json (TYPES).
const TYPES = { UInt16: 1, UInt32: 2, UInt64: 3, Amount: 6, Blob: 7, AccountID: 8 };

// Field ids from definitions.json (FIELDS): type + nth. Anything not listed
// here is refused — a silently dropped field is a wrong transaction.
const FIELDS = {
  TransactionType: { type: 'UInt16', nth: 2 },
  Flags: { type: 'UInt32', nth: 2 },
  SourceTag: { type: 'UInt32', nth: 3 },
  Sequence: { type: 'UInt32', nth: 4 },
  DestinationTag: { type: 'UInt32', nth: 14 },
  LastLedgerSequence: { type: 'UInt32', nth: 27 },
  Amount: { type: 'Amount', nth: 1 },
  Fee: { type: 'Amount', nth: 8 },
  SigningPubKey: { type: 'Blob', nth: 3 },
  TxnSignature: { type: 'Blob', nth: 4 },
  Account: { type: 'AccountID', nth: 1 },
  Destination: { type: 'AccountID', nth: 3 },
};

// TxnSignature is the only field that is serialized but NOT signed.
const NOT_SIGNED = new Set(['TxnSignature']);

function fieldId(name) {
  const f = FIELDS[name];
  if (!f) throw new Error(`XRP: unknown field "${name}"`);
  return (TYPES[f.type] << 16) | f.nth;
}

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

function beBytes(value, width) {
  let v = BigInt(value);
  if (v < 0n) throw new Error('XRP: cannot serialize a negative number');
  const out = new Uint8Array(width);
  for (let i = width - 1; i >= 0; i -= 1) { out[i] = Number(v & 0xffn); v >>= 8n; }
  if (v !== 0n) throw new Error('XRP: number does not fit the field');
  return out;
}

// Ripple's own length prefix, which is NOT Bitcoin's varint. Up to 192 bytes it
// is a single byte — every blob we build is — but the wide forms are here so a
// longer field can never be silently mis-encoded.
function lengthPrefix(len) {
  if (len <= 192) return Uint8Array.from([len]);
  if (len <= 12480) {
    const n = len - 193;
    return Uint8Array.from([193 + (n >> 8), n & 0xff]);
  }
  if (len <= 918744) {
    const n = len - 12481;
    return Uint8Array.from([241 + (n >> 16), (n >> 8) & 0xff, n & 0xff]);
  }
  throw new Error('XRP: field is too long to serialize');
}

function vl(bytes) {
  return concat(lengthPrefix(bytes.length), bytes);
}

/** First 32 bytes of SHA-512 — what XRP hashes with. */
export function sha512half(bytes) {
  return ethers.getBytes(ethers.sha512(bytes)).slice(0, 32);
}

// ── addresses ───────────────────────────────────────────────────────────

/**
 * Decode a classic r… address. X-addresses (X…) are refused on purpose: they
 * carry a destination tag and a network id in the address itself, and getting
 * that wrong sends funds to the wrong place.
 */
export function decodeXrpAddress(address) {
  const text = String(address == null ? '' : address).trim();
  if (!text) throw new Error('XRP: enter a destination address');
  if (/^X/i.test(text)) throw new Error('XRP: X-addresses are not supported yet — use a classic r… address');
  if (!text.startsWith('r')) throw new Error('XRP: a classic address starts with "r"');
  let raw;
  try {
    raw = xrpBase58Decode(text);
  } catch {
    throw new Error('XRP: that is not a valid address');
  }
  if (raw.length !== 25) throw new Error('XRP: that is not a valid address (wrong length)');
  const payload = raw.slice(0, 21);
  const checksum = raw.slice(21);
  const want = ethers.getBytes(ethers.sha256(ethers.sha256(payload))).slice(0, 4);
  for (let i = 0; i < 4; i += 1) if (checksum[i] !== want[i]) throw new Error('XRP: address checksum does not match');
  if (payload[0] !== 0x00) throw new Error('XRP: not a classic account address (version byte)');
  return { accountId: payload.slice(1), classic: text };
}

/** A classic r… address for a 20-byte account id. */
export function xrpClassicAddress(accountId) {
  const id = bytesOf(accountId);
  if (id.length !== 20) throw new Error('XRP: an account id is 20 bytes');
  const payload = concat(Uint8Array.from([0x00]), id);
  const checksum = ethers.getBytes(ethers.sha256(ethers.sha256(payload))).slice(0, 4);
  return xrpBase58Encode(concat(payload, checksum));
}

// ── amount ──────────────────────────────────────────────────────────────

/** XRP (a decimal string) → drops. No floating point: 0.1 + 0.2 must not bite. */
export function xrpToDrops(amountXrp) {
  const text = String(amountXrp == null ? '' : amountXrp).trim();
  if (!/^\d*(\.\d*)?$/.test(text) || text === '' || text === '.') throw new Error('XRP: enter an amount');
  const [whole, frac = ''] = text.split('.');
  if (frac.length > 6) throw new Error('XRP: an XRP amount has at most 6 decimal places');
  const drops = BigInt(whole || '0') * BigInt(XRP_DROPS) + BigInt((frac + '000000').slice(0, 6));
  if (drops <= 0n) throw new Error('XRP: amount must be greater than zero');
  return drops;
}

/** drops → "1.5" — the display form. */
export function dropsToXrp(drops) {
  const value = BigInt(drops);
  const whole = value / BigInt(XRP_DROPS);
  const frac = (value % BigInt(XRP_DROPS)).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}

function encodeAmount(value) {
  if (typeof value === 'object' && value !== null) {
    throw new Error('XRP: issued currencies are not supported yet — this wallet sends XRP only');
  }
  const text = String(value).trim();
  if (text.includes('/')) throw new Error('XRP: issued currencies are not supported yet — this wallet sends XRP only');
  if (!/^\d+$/.test(text)) throw new Error(`XRP: amount must be a whole number of drops, got "${text}"`);
  const drops = BigInt(text);
  if (drops > 0x3fffffffffffffffn) throw new Error('XRP: amount is larger than the ledger allows');
  return beBytes(drops | XRP_AMOUNT_FLAG, 8);
}

// ── serialization ───────────────────────────────────────────────────────

function encodeValue(name, value) {
  const { type } = FIELDS[name];
  if (type === 'UInt16') return beBytes(value, 2);
  if (type === 'UInt32') return beBytes(value, 4);
  if (type === 'UInt64') return beBytes(value, 8);
  if (type === 'Amount') return encodeAmount(value);
  if (type === 'Blob') return vl(bytesOf(value));
  if (type === 'AccountID') return vl(decodeXrpAddress(value).accountId);
  throw new Error(`XRP: cannot serialize type ${type}`);
}

function idBytes(name) {
  const f = FIELDS[name];
  const type = TYPES[f.type];
  // The id is one byte when nth fits in a nibble, otherwise two.
  return f.nth > 15
    ? Uint8Array.from([type << 4, f.nth])
    : Uint8Array.from([(type << 4) | f.nth]);
}

/**
 * Serialize the fields of a transaction, in canonical order (ascending field
 * id), each value in its own wire form. Unknown or undefined fields are an
 * error / skipped respectively — never guessed at.
 */
export function serializeXrpTx(tx) {
  const names = Object.keys(tx)
    .filter((k) => tx[k] !== undefined && tx[k] !== null)
    .sort((a, b) => fieldId(a) - fieldId(b));
  if (!names.includes('TransactionType')) throw new Error('XRP: a transaction needs a TransactionType');
  const parts = [];
  for (const name of names) {
    parts.push(idBytes(name), encodeValue(name, tx[name]));
  }
  return ethers.hexlify(concat(...parts));
}

/** The bytes that get signed: every field except TxnSignature. */
export function xrpSigningBlob(tx) {
  const signing = {};
  for (const [key, value] of Object.entries(tx)) {
    if (!NOT_SIGNED.has(key)) signing[key] = value;
  }
  if (!signing.SigningPubKey) throw new Error('XRP: SigningPubKey is required before signing');
  return serializeXrpTx(signing);
}

/** The 32-byte digest the private key signs. */
export function xrpSigningHash(tx) {
  return sha512half(concat(STX_PREFIX, bytesOf(xrpSigningBlob(tx))));
}

/** The transaction id — sha512half("TXN\0" ‖ signed blob), shown uppercase. */
export function xrpTxHash(blob) {
  return ethers.hexlify(sha512half(concat(TXN_PREFIX, bytesOf(blob)))).slice(2).toUpperCase();
}

// ── signing ─────────────────────────────────────────────────────────────

/** secp256k1 DER signature (low-S, canonical) — the same rule as Bitcoin's. */
export function signXrpDigest(privateKey, digest) {
  const key = privateKey instanceof Uint8Array ? ethers.hexlify(privateKey) : privateKey;
  const sig = new ethers.SigningKey(key).sign(digest);
  return ethers.hexlify(derSignature(sig.r, sig.s)).slice(2).toUpperCase();
}

/**
 * Build and sign one XRP Payment.
 *
 * The Account we sign for is checked against the key: signing a transaction
 * whose Account field is not ours would be rejected at best and, if it somehow
 * went through, would spend someone else's sequence.
 */
export function buildSignedXrp({ privateKey, account, destination, amountDrops, feeDrops = XRP_MIN_FEE_DROPS, sequence, lastLedgerSequence, destinationTag, sourceTag }) {
  if (sequence == null) throw new Error('XRP: a sequence number is required');
  if (lastLedgerSequence == null) {
    throw new Error('XRP: LastLedgerSequence is required — without it a transaction can land at any time');
  }
  const key = privateKey instanceof Uint8Array ? ethers.hexlify(privateKey) : privateKey;
  const sk = new ethers.SigningKey(key);
  const publicKey = ethers.hexlify(ethers.getBytes(sk.compressedPublicKey)).slice(2).toUpperCase();

  const mine = decodeXrpAddress(account);
  const derived = ethers.getBytes(ethers.ripemd160(ethers.sha256(sk.compressedPublicKey)));
  for (let i = 0; i < 20; i += 1) {
    if (mine.accountId[i] !== derived[i]) throw new Error('XRP: this wallet does not control the sending account');
  }
  decodeXrpAddress(destination);
  if (BigInt(feeDrops) < BigInt(XRP_MIN_FEE_DROPS)) throw new Error(`XRP: the network fee is at least ${XRP_MIN_FEE_DROPS} drops`);

  // Drops are whole units: "1.5" is not a smaller payment, it is a number that
  // cannot exist on the ledger. Validated here so the caller gets a sentence
  // instead of BigInt's "Cannot convert 1000000.5 to a BigInt", and so a
  // zero-drop Payment (which the ledger refuses as temBAD_AMOUNT) never gets
  // signed in the first place.
  const dropsText = String(amountDrops).trim();
  if (!/^\d+$/.test(dropsText)) throw new Error(`XRP: amount must be a whole number of drops, got "${amountDrops}"`);
  const drops = BigInt(dropsText);
  if (drops <= 0n) throw new Error('XRP: amount must be greater than zero');

  const tx = {
    TransactionType: PAYMENT,
    Sequence: Number(sequence),
    LastLedgerSequence: Number(lastLedgerSequence),
    Amount: String(drops),
    Fee: String(BigInt(feeDrops)),
    SigningPubKey: publicKey,
    Account: account,
    Destination: destination,
  };
  if (destinationTag != null) tx.DestinationTag = Number(destinationTag);
  if (sourceTag != null) tx.SourceTag = Number(sourceTag);

  const digest = xrpSigningHash(tx);
  const signed = { ...tx, TxnSignature: signXrpDigest(key, digest) };
  const blob = serializeXrpTx(signed).slice(2).toUpperCase();
  return { blob, hash: xrpTxHash(blob), digest: ethers.hexlify(digest), txJson: signed };
}

/** The unsigned transaction JSON a node expects for `submit` (blob also works). */
export function xrpUnsignedJson({ account, destination, amountDrops, feeDrops = XRP_MIN_FEE_DROPS, sequence, lastLedgerSequence, destinationTag }) {
  const tx = {
    TransactionType: 'Payment',
    Account: account,
    Destination: destination,
    Amount: String(BigInt(amountDrops)),
    Fee: String(BigInt(feeDrops)),
    Sequence: Number(sequence),
    LastLedgerSequence: Number(lastLedgerSequence),
  };
  if (destinationTag != null) tx.DestinationTag = Number(destinationTag);
  return tx;
}
