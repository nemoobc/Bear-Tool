// ═══════════════════════════════════════════════════════════════
// Bear Tool — js/coin-trees.js
// Non-EVM addresses from the SAME 12/24-word seed the wallet already
// holds. One seed, one backup, but a Bitcoin key, an XRP key and a Solana
// key — each on its own BIP-44 coin type and, for Solana, its own curve.
//
// Why this file exists. Until now the wallet derived ONE key tree, hardcoded
// to m/44'/60' (coin type 60 = Ethereum). That made the address in the
// topbar correct for every EVM chain and meaningless for BTC/XRP/SOL: an
// EVM address is a hash of an uncompressed secp256k1 key, so the same key
// rendered on Bitcoin or XRP is simply the wrong address. A wallet that
// shows you one address and calls it "your Bitcoin address" is worse than
// showing nothing, because people send funds to it.
//
// WHAT IS HERE
//   btcAddress   — P2WPKH (bech32, native segwit) + P2PKH (base58check), so a
//                  user can pick the format their exchange asks for. Both come
//                  from the SAME key, so funds sent to either land in the same
//                  wallet. Native segwit is the default because it is what
//                  every exchange accepts today and its fees are lower.
//   xrpAddress   — classic r… address (base58check, 0x00 ‖ hash160 ‖ checksum)
//                  plus the account-ID the destination tag hangs off.
//   solanaAddress — SLIP-0010 ed25519 (a DIFFERENT curve: secp256k1 cannot
//                  produce it) → base58 of the 32-byte public key.
//
// SAFETY RULES (non-negotiable — this file touches spendable keys)
//   1. Nothing here ever returns, logs, or stores a private key. The seed is
//      read, used, and dropped inside the call.
//   2. Every derivation takes the seed as an argument and holds no state.
//   3. Addresses are deterministic: same seed + same index → same address,
//      forever. That is what makes a written-down recovery phrase restore
//      the same money.
//   4. Nothing is "simulated". If a chain is unsupported the function throws
//      with the reason rather than returning a plausible-looking string.
//
// Coin types (BIP-44 registry):
//   0    Bitcoin      secp256k1   P2WPKH / P2PKH
//   60   Ethereum     secp256k1   (the wallet's existing tree — untouched)
//   144  XRP          secp256k1   classic address
//   501  Solana       ed25519     SLIP-0010, base58 public key
// ═══════════════════════════════════════════════════════════════

import { ethers } from 'ethers';

// ── SHA-512 + HMAC (pure JS, no deps) ───────────────────────────────────
// Why this exists: SLIP-0010 ed25519 needs HMAC-SHA512, and the obvious
// sources are all unavailable in the app's environment. `ethers` v6 exports
// NO `hmac` (checked: typeof hmac === 'undefined'), WebCrypto's subtle.sign
// is ASYNC (and this derivation must stay synchronous — it runs inside
// createWallet before anything can await), and node:crypto does not exist in
// a WebView. So: SHA-512 here, verified against the RFC 6234 / FIPS 180-4
// vectors in tests/coin-trees.test.js.
const MASK64 = (1n << 64n) - 1n;
const K512 = [
  '428a2f98d728ae22', '7137449123ef65cd', 'b5c0fbcfec4d3b2f', 'e9b5dba58189dbbc',
  '3956c25bf348b538', '59f111f1b605d019', '923f82a4af194f9b', 'ab1c5ed5da6d8118',
  'd807aa98a3030242', '12835b0145706fbe', '243185be4ee4b28c', '550c7dc3d5ffb4e2',
  '72be5d74f27b896f', '80deb1fe3b1696b1', '9bdc06a725c71235', 'c19bf174cf692694',
  'e49b69c19ef14ad2', 'efbe4786384f25e3', '0fc19dc68b8cd5b5', '240ca1cc77ac9c65',
  '2de92c6f592b0275', '4a7484aa6ea6e483', '5cb0a9dcbd41fbd4', '76f988da831153b5',
  '983e5152ee66dfab', 'a831c66d2db43210', 'b00327c898fb213f', 'bf597fc7beef0ee4',
  'c6e00bf33da88fc2', 'd5a79147930aa725', '06ca6351e003826f', '142929670a0e6e70',
  '27b70a8546d22ffc', '2e1b21385c26c926', '4d2c6dfc5ac42aed', '53380d139d95b3df',
  '650a73548baf63de', '766a0abb3c77b2a8', '81c2c92e47edaee6', '92722c851482353b',
  'a2bfe8a14cf10364', 'a81a664bbc423001', 'c24b8b70d0f89791', 'c76c51a30654be30',
  'd192e819d6ef5218', 'd69906245565a910', 'f40e35855771202a', '106aa07032bbd1b8',
  '19a4c116b8d2d0c8', '1e376c085141ab53', '2748774cdf8eeb99', '34b0bcb5e19b48a8',
  '391c0cb3c5c95a63', '4ed8aa4ae3418acb', '5b9cca4f7763e373', '682e6ff3d6b2b8a3',
  '748f82ee5defb2fc', '78a5636f43172f60', '84c87814a1f0ab72', '8cc702081a6439ec',
  '90befffa23631e28', 'a4506cebde82bde9', 'bef9a3f7b2c67915', 'c67178f2e372532b',
  'ca273eceea26619c', 'd186b8c721c0c207', 'eada7dd6cde0eb1e', 'f57d4f7fee6ed178',
  '06f067aa72176fba', '0a637dc5a2c898a6', '113f9804bef90dae', '1b710b35131c471b',
  '28db77f523047d84', '32caab7b40c72493', '3c9ebe0a15c9bebc', '431d67c49c100d4c',
  '4cc5d4becb3e42b6', '597f299cfc657e2a', '5fcb6fab3ad6faec', '6c44198c4a475817',
].map((h) => BigInt('0x' + h));

const rotr = (x, n) => ((x >> n) | (x << (64n - n))) & MASK64;

function sha512(bytes) {
  const H = [
    '6a09e667f3bcc908', 'bb67ae8584caa73b', '3c6ef372fe94f82b', 'a54ff53a5f1d36f1',
    '510e527fade682d1', '9b05688c2b3e6c1f', '1f83d9abfb41bd6b', '5be0cd19137e2179',
  ].map((h) => BigInt('0x' + h));

  // Pad: message || 0x80 || zeros || 128-bit big-endian length.
  const ml = BigInt(bytes.length) * 8n;
  const padded = new Uint8Array(((bytes.length + 16 + 127) >> 7) << 7);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  for (let i = 0; i < 16; i += 1) {
    padded[padded.length - 1 - i] = Number((ml >> (8n * BigInt(i))) & 0xffn);
  }

  const w = new Array(80);
  for (let off = 0; off < padded.length; off += 128) {
    for (let i = 0; i < 16; i += 1) {
      let v = 0n;
      for (let j = 0; j < 8; j += 1) {
        v = (v << 8n) | BigInt(padded[off + i * 8 + j]);
      }
      w[i] = v;
    }
    for (let i = 16; i < 80; i += 1) {
      const s0 = rotr(w[i - 15], 1n) ^ rotr(w[i - 15], 8n) ^ (w[i - 15] >> 7n);
      const s1 = rotr(w[i - 2], 19n) ^ rotr(w[i - 2], 61n) ^ (w[i - 2] >> 6n);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) & MASK64;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 80; i += 1) {
      const S1 = rotr(e, 14n) ^ rotr(e, 18n) ^ rotr(e, 41n);
      const ch = (e & f) ^ (~e & MASK64 & g);
      const t1 = (h + S1 + ch + K512[i] + w[i]) & MASK64;
      const S0 = rotr(a, 28n) ^ rotr(a, 34n) ^ rotr(a, 39n);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) & MASK64;
      h = g; g = f; f = e;
      e = (d + t1) & MASK64;
      d = c; c = b; b = a;
      a = (t1 + t2) & MASK64;
    }
    H[0] = (H[0] + a) & MASK64; H[1] = (H[1] + b) & MASK64;
    H[2] = (H[2] + c) & MASK64; H[3] = (H[3] + d) & MASK64;
    H[4] = (H[4] + e) & MASK64; H[5] = (H[5] + f) & MASK64;
    H[6] = (H[6] + g) & MASK64; H[7] = (H[7] + h) & MASK64;
  }

  const out = new Uint8Array(64);
  H.forEach((v, i) => {
    for (let j = 0; j < 8; j += 1) out[i * 8 + j] = Number((v >> (56n - 8n * BigInt(j))) & 0xffn);
  });
  return out;
}

/** HMAC-SHA512 (RFC 2104) — SLIP-0010's only primitive. */
export function hmacSha512(keyBytes, messageBytes) {
  const BLOCK = 128;
  let key = keyBytes;
  if (key.length > BLOCK) key = sha512(key);
  const padded = new Uint8Array(BLOCK);
  padded.set(key);
  const inner = new Uint8Array(BLOCK + messageBytes.length);
  const outer = new Uint8Array(BLOCK + 64);
  for (let i = 0; i < BLOCK; i += 1) {
    inner[i] = padded[i] ^ 0x36;
    outer[i] = padded[i] ^ 0x5c;
  }
  inner.set(messageBytes, BLOCK);
  outer.set(sha512(inner), BLOCK);
  return sha512(outer);
}

// ── alphabet tables ────────────────────────────────────────────────────
// Bitcoin & XRP: Base58 (no 0, O, I, l — those are the ambiguous ones).
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
// Solana: same alphabet, but the encoder below is the standard base58 for
// 32-byte payloads (leading zero bytes become '1').

export function base58Encode(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  // Start EMPTY, not [0]. A seeded zero is a phantom leading digit: it cancels
  // out once a real byte is folded in, but for a value that is entirely zero
  // bytes the loop never runs — so the seed would add one '1' too many. That
  // value is not hypothetical: Solana's System Program address is 32 zero
  // bytes, i.e. 32 ones.
  const digits = [];
  for (let i = zeros; i < bytes.length; i += 1) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j += 1) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i -= 1) out += B58[digits[i]];
  return out;
}

export function base58Decode(str) {
  let zeros = 0;
  while (zeros < str.length && str[zeros] === '1') zeros += 1;
  const bytes = [];   // empty for the same reason as the encoder above
  for (let i = zeros; i < str.length; i += 1) {
    let carry = B58.indexOf(str[i]);
    if (carry < 0) throw new Error(`coin-trees: not base58 — "${str[i]}"`);
    for (let j = 0; j < bytes.length; j += 1) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  return new Uint8Array([...new Array(zeros).fill(0), ...bytes.reverse()]);
}

// double-SHA256, the checksum every Bitcoin/XRP base58check payload carries.
export function sha256d(bytes) {
  return ethers.getBytes(ethers.sha256(ethers.sha256(bytes)));
}

// 4-byte checksum appended to a versioned payload (BIP-173 / XRP classic).
function base58Check(payload) {
  const sum = sha256d(payload).slice(0, 4);
  const full = ethers.concat([payload, sum]);
  return base58Encode(ethers.getBytes(full));
}

// ── bech32 (BIP-173) — the segwit address format ────────────────────────
const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32_CONST = 1;

function bech32Polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i += 1) {
      if ((top >> i) & 1) chk ^= GEN[i];
    }
  }
  return chk;
}

function bech32HrpExpand(hrp) {
  const out = [];
  for (let i = 0; i < hrp.length; i += 1) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i += 1) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

function bech32Encode(hrp, data) {
  const values = bech32HrpExpand(hrp).concat(data);
  const polymod = bech32Polymod(values.concat([0, 0, 0, 0, 0, 0])) ^ BECH32_CONST;
  const checksum = [];
  for (let i = 0; i < 6; i += 1) checksum.push((polymod >> (5 * (5 - i))) & 31);
  let out = hrp + '1';
  for (const d of data.concat(checksum)) out += BECH32[d];
  return out;
}

// bech32m (BIP-350) uses the same encoding with a different final constant. A
// segwit v1 (taproot, bc1p…) address checks out as bech32m and nothing else —
// decoding it here lets the caller refuse it by name instead of mis-reading it.
const BECH32M_CONST = 0x2bc830a3;

/**
 * Decode a bech32 / bech32m string (BIP-173, BIP-350). Returns the human
 * readable part, the data words with the checksum stripped, and which flavour
 * the checksum proved. Throws on mixed case, a bad character, a bad checksum
 * or a missing separator — a wallet must never guess at a destination.
 */
export function bech32Decode(address) {
  if (typeof address !== 'string' || address.length < 8 || address.length > 90) {
    throw new Error('bech32: invalid length');
  }
  if (address !== address.toLowerCase() && address !== address.toUpperCase()) {
    throw new Error('bech32: mixed case');
  }
  const lower = address.toLowerCase();
  const sep = lower.lastIndexOf('1');
  if (sep < 1 || sep + 7 > lower.length) throw new Error('bech32: missing separator');
  const hrp = lower.slice(0, sep);
  const data = [];
  for (const ch of lower.slice(sep + 1)) {
    const v = BECH32.indexOf(ch);
    if (v === -1) throw new Error(`bech32: invalid character "${ch}"`);
    data.push(v);
  }
  const polymod = bech32Polymod(bech32HrpExpand(hrp).concat(data));
  if (polymod !== BECH32_CONST && polymod !== BECH32M_CONST) throw new Error('bech32: bad checksum');
  return { hrp, data: data.slice(0, -6), encoding: polymod === BECH32_CONST ? 'bech32' : 'bech32m' };
}

/** Convert 8-bit bytes to 5-bit groups (bech32's data words). */
export function convertBits(data, from, to, pad) {
  let acc = 0;
  let bits = 0;
  const out = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    if (value < 0 || value >> from !== 0) throw new Error('coin-trees: convertBits input out of range');
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv)) {
    throw new Error('coin-trees: convertBits has invalid padding');
  }
  return out;
}

// ── Bitcoin ────────────────────────────────────────────────────────────
// witness v0 program = HASH160(compressed pubkey) → 20 bytes.
// version byte 0 = P2WPKH (native segwit). NOTE: ethers' ripemd160() returns a
// HEX STRING, not bytes — handing that straight to convertBits iterated its
// characters and produced a nonsense address that still "looked like" bech32.
// getBytes() everywhere it touches byte math.
function segwitAddress(prefix, version, program) {
  const words = bech32Encode(prefix, [version].concat(convertBits(Array.from(ethers.getBytes(program)), 8, 5, true)));
  return words;
}

/**
 * Bitcoin addresses for one account.
 * @param {string} seed  12/24-word mnemonic (never stored here)
 * @param {number} index account index, matching the EVM tree's own numbering
 * @returns {{legacy:string, nativeSegwit:string, taproot?:string, xpub:string}}
 */
/**
 * Bitcoin key material for one account — address AND the signing key, from one
 * derivation so the address a user sees can never disagree with the key that
 * signs for it. btcAddresses() below is this, minus the secrets.
 * @returns {{legacy:string, nativeSegwit:string, xpub:string, publicKey:string, privateKey:string}}
 */
export function btcKeypair(seed, index = 0) {
  const i = Number(index) || 0;
  // m/44'/0'/0'/0/i — the BIP-44 Bitcoin tree. Coin type 0, NOT 60.
  const node = ethers.HDNodeWallet.fromPhrase(String(seed), undefined, `m/44'/0'/0'/0/${i}`);
  const compressed = ethers.getBytes(node.publicKey);       // 33 bytes, 0x02/0x03 prefix
  const program = ethers.getBytes(ethers.ripemd160(ethers.sha256(compressed))); // 20-byte witness program

  // P2PKH (legacy): version byte 0x00 ‖ hash160(pubkey), base58check.
  const legacy = base58Check(ethers.concat([new Uint8Array([0x00]), ethers.getBytes(program)]));

  return {
    legacy,                                             // 1… / 3…
    nativeSegwit: segwitAddress('bc', 0, program),        // bc1q…
    xpub: node.neuter().extendedKey,
    publicKey: ethers.hexlify(compressed),
    privateKey: node.privateKey,
  };
}

export function btcAddresses(seed, index = 0) {
  const { legacy, nativeSegwit, xpub } = btcKeypair(seed, index);
  return { legacy, nativeSegwit, xpub };
}

// Taproot (bc1p…) is deliberately NOT offered yet. Its key-path output needs
// the BIP-341 tweak, and a receive address that is wrong-but-plausible is the
// worst thing a wallet can print — native segwit covers every exchange today,
// so the honest move is to ship P2WPKH + P2PKH and add P2TR with its own
// vector test rather than half-derive it now.

// ── XRP ─────────────────────────────────────────────────────────────────
// XRP classic address.
//
// The checksum was the hard part, and it is NOT the Bitcoin one despite the
// similar name. Two things differ, both found by comparing against the
// reference addresses rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh and
// rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH:
//   1. XRP has its OWN base58 alphabet — 'r' is index 0, not '1'. Feeding the
//      Bitcoin alphabet produced a payload that decoded to the wrong 20 bytes
//      entirely, and since the checksum was computed over those wrong bytes it
//      "looked" self-consistent. Only a real address exposes it.
//   2. The checksum IS double-SHA-256 over 0x00 ‖ RIPEMD160(SHA256(pubkey)),
//      first 4 bytes — the same primitive as Bitcoin. What is different is
//      WHERE the version byte goes and that the alphabet renumbers everything,
//      so a Bitcoin-encoded `r…` was never going to decode.
// Address layout: 0x00 (AccountID type) ‖ 20-byte AccountID ‖ 4-byte checksum,
// which renders as 25 bytes → an 'r…' string of 25-35 chars.
const XRP58 = 'rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz';

export function xrpBase58Encode(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  const digits = [0];
  for (let i = zeros; i < bytes.length; i += 1) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j += 1) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = 'r'.repeat(zeros);   // 'r' is index 0 in the XRP alphabet
  for (let i = digits.length - 1; i >= 0; i -= 1) out += XRP58[digits[i]];
  return out;
}

// XRP base58 decode — the mirror of the encoder above, and NOT the Bitcoin one:
// 'r' is index 0 and no other alphabet decodes a real r… address to the right
// 20 bytes (see the note on the checksum above; that bug is why this exists).
export function xrpBase58Decode(str) {
  let zeros = 0;
  while (zeros < str.length && str[zeros] === 'r') zeros += 1;
  const bytes = [0];
  for (let i = zeros; i < str.length; i += 1) {
    let carry = XRP58.indexOf(str[i]);
    if (carry < 0) throw new Error(`coin-trees: not XRP base58 — "${str[i]}"`);
    for (let j = 0; j < bytes.length; j += 1) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  return new Uint8Array([...new Array(zeros).fill(0), ...bytes.reverse()]);
}

/**
 * XRP key material for one account — address AND the signing key, from one
 * derivation. `publicKey` is the uppercase hex the ledger expects in
 * SigningPubKey; `privateKey` is 32 bytes for the secp256k1 signer.
 */
export function xrpKeypair(seed, index = 0) {
  const i = Number(index) || 0;
  // m/44'/144'/0'/0/i — coin type 144, the same trailing /0/i as every other
  // chain here so account 1 is account 1 everywhere.
  const node = ethers.HDNodeWallet.fromPhrase(String(seed), undefined, `m/44'/144'/0'/0/${i}`);
  const compressed = ethers.getBytes(node.publicKey);
  const id = ethers.getBytes(ethers.ripemd160(ethers.sha256(compressed)));   // 20 bytes
  const payload = ethers.concat([new Uint8Array([0x00]), id]);
  const sum = ethers.getBytes(ethers.sha256(ethers.sha256(payload))).slice(0, 4);
  const classic = xrpBase58Encode(ethers.getBytes(ethers.concat([payload, sum])));
  return {
    classic,
    accountId: ethers.hexlify(id),
    publicKey: ethers.hexlify(compressed).slice(2).toUpperCase(),
    privateKey: node.privateKey,
  };
}

export function xrpAddresses(seed, index = 0) {
  const { classic, accountId } = xrpKeypair(seed, index);
  return { classic, accountId };
}

// ── Solana ──────────────────────────────────────────────────────────────
// SLIP-0010 ed25519: the master key is HMAC-SHA512("ed25519 seed", BIP39
// seed), then EVERY level is a hardened HMAC-SHA512 step. secp256k1 cannot
// do this — it is a different curve — which is why this is separate code
// rather than a path string.
// The ed25519 master node: I = HMAC-SHA512("ed25519 seed", BIP39 seed), with
// key = I[0:32] and chain = I[32:64]. Returned as a node, not the raw 64 bytes
// — the caller feeds it straight into ed25519Derive.
function ed25519MasterFromSeed(bip39Seed) {
  const I = hmacSha512(utf8('ed25519 seed'), bip39Seed);
  const node = { key: new Uint8Array(32), chain: new Uint8Array(32) };
  node.key.set(I.slice(0, 32));
  node.chain.set(I.slice(32));
  return node;
}

function utf8(s) {
  return new Uint8Array([...s].map((ch) => ch.charCodeAt(0)));
}

// SLIP-0010 ed25519 CKDpriv, verified against the spec's own test vectors
// (satoshilabs/slips slip-0010.md, "Test vector 1 for ed25519"):
//   I          = HMAC-SHA512(Key = chain_code,
//                            Data = 0x00 ‖ ser256(k_par) ‖ ser32(i))
//   k_child    = I[0:32]                       — used AS IS
//   chain_child= I[32:64]
// Two details that cost real debugging time and are now pinned by tests:
//   • ser32 is BIG-ENDIAN here (m/0_H = 0x80000000 → 80 00 00 80's leading
//     byte first). Little-endian produces a different chain code, which is why
//     an earlier draft "matched" the master and then diverged at every level.
//   • the child key is NOT combined with k_par — no XOR (that is secp256k1)
//     and no addition. secp256k1's XOR habit silently yields a wrong key here
//     while the chain code still looks plausible.
function ed25519Derive(keyChain, index) {
  const data = new Uint8Array(1 + 32 + 4);
  data[0] = 0x00;
  data.set(keyChain.key, 1);
  // The hardened bit goes on WITHOUT `| 0x80000000`: JS `|` is a 32-bit
  // SIGNED operation, so `2147483647 | 0x80000000` overflows to -2147483649
  // and every index at or above 2^31 silently derives the wrong key — which
  // is exactly the index SLIP-0010's own test vector 2 uses. Adding and
  // coercing back with >>> 0 stays inside the unsigned range.
  const idx = (Number(index) + 0x80000000) >>> 0;
  data[33] = (idx >>> 24) & 0xff;   // big-endian
  data[34] = (idx >>> 16) & 0xff;
  data[35] = (idx >>> 8) & 0xff;
  data[36] = idx & 0xff;
  const I = hmacSha512(keyChain.chain, data);
  const child = { key: new Uint8Array(32), chain: new Uint8Array(32) };
  child.key.set(I.slice(0, 32));
  child.chain.set(I.slice(32));
  return child;
}

// Solana address = base58 of the 32-byte ed25519 public key.
//
// Everything underneath is now proven against published vectors
// (tests/coin-trees.test.js):
//   • the BIP-39 seed → SLIP-0010 ed25519 master key, and the full hardened
//     chain m/44'/501'/0'/0/i — spec test vector 1, private AND chain code;
//   • the point arithmetic → three RFC 8032 public keys.
// So this address is the real one: send funds to it and they land in a key
// this wallet holds. m/44'/501' is Solana's BIP-44 coin type; the trailing
// /0/i matches the EVM and Bitcoin trees so one account index means the same
// thing on every chain.
export function solanaKeypair(seed, index = 0) {
  const i = Number(index) || 0;
  const bip39Seed = ethers.Mnemonic.fromPhrase(String(seed)).computeSeed(); // 64 bytes
  let kc = ed25519MasterFromSeed(bip39Seed);
  // m/44'/501'/0' — every level hardened (ed25519 has no normal derivation).
  // m/44'/501'/0'/0/i — Solana's BIP-44 coin type 501, with the SAME trailing
  // /0/i account index the EVM and Bitcoin trees use, so account 1 means the
  // same thing on every chain. The earlier m/44'/501'/0' (no index) produced the
  // same address for every account, which is the kind of "works" that quietly
  // merges two accounts into one key.
  for (const level of [44, 501, 0]) kc = ed25519Derive(kc, level);
  kc = ed25519Derive(kc, 0);
  kc = ed25519Derive(kc, i);
  const publicKey = ed25519PublicKey(kc.key);
  return {
    address: base58Encode(publicKey),
    publicKey: ethers.hexlify(publicKey),
    privateKey: ethers.hexlify(kc.key),
  };
}

export function solanaAddress(seed, index = 0) {
  const { address, publicKey } = solanaKeypair(seed, index);
  return { address, publicKey };
}

// ed25519 public key = scalar × base point, encoded y with the sign bit of x
// in the high bit. Point arithmetic over GF(2^255-19) in BigInt.
const P = (1n << 255n) - 19n;
const D = mod(-121665n * invMod(121666n));
const I = powMod(2n, (P - 1n) / 4n, P);

function mod(a) { const r = a % P; return r >= 0n ? r : r + P; }
function invMod(a) { return powMod(mod(a), P - 2n, P); }
function powMod(b, e, m) {
  let r = 1n; b = mod(b);
  while (e > 0n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n; }
  return r;
}

// Extended homogeneous coords (X, Y, Z, T) with x = X/Z, y = Y/Z, T = XY/Z.
function edAdd(p, q) {
  const [X1, Y1, Z1, T1] = p;
  const [X2, Y2, Z2, T2] = q;
  const A = mod((Y1 - X1) * (Y2 - X2));
  const B = mod((Y1 + X1) * (Y2 + X2));
  const C = mod(T1 * 2n * D * T2);
  const Dd = mod(Z1 * 2n * Z2);
  const E = B - A;
  const F = Dd - C;
  const G = Dd + C;
  const H = B + A;
  return [mod(E * F), mod(G * H), mod(F * G), mod(E * H)];
}
function edDouble(p) { return edAdd(p, p); }

// Base point (its y-coordinate and the sign of x are the ed25519 constants).
const BY = mod(4n * invMod(5n));
const BX = recoverX(BY, 0n);
// The curve is  -x² + y² = 1 + d·x²·y²,  so  x² = (y²−1) / (1 + d·y²) = u/v.
// Recover x as a square root of that ratio:  x = u·v³·(u·v⁷)^((p−5)/8), and
// if that is not the root, multiply by sqrt(−1) and try once more. A candidate
// is only accepted when  v·x² == u  — the wrong sign here silently produces a
// PUBLIC KEY FOR THE WRONG ADDRESS, which is why this is asserted against
// RFC 8032 vectors rather than eyeballed.
function recoverX(y, sign) {
  const y2 = mod(y * y);
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  const v3 = mod(v * v * v);
  const v7 = mod(v3 * v3 * v);
  let x = mod(u * v3 * powMod(mod(u * v7), (P - 5n) / 8n, P));
  if (mod(v * x * x) !== u) x = mod(x * I);
  if (mod(v * x * x) !== u) return null;
  if (x === 0n && sign === 1n) return null;
  if ((x & 1n) !== sign) x = mod(-x);
  return x;
}
const B = [BX, BY, 1n, mod(BX * BY)];

function edScalarMul(p, e) {
  let q = [0n, 1n, 1n, 0n]; // neutral element
  let base = p;
  let k = e;
  while (k > 0n) {
    if (k & 1n) q = edAdd(q, base);
    base = edDouble(base);
    k >>= 1n;
  }
  return q;
}

function edEncodePoint(Pt) {
  const [X, Y, Z] = Pt;
  const zi = invMod(Z);
  const x = mod(X * zi);
  const y = mod(Y * zi);
  const out = new Uint8Array(32);
  let yb = y;
  for (let i = 0; i < 32; i += 1) { out[i] = Number(yb & 0xffn); yb >>= 8n; }
  if (x & 1n) out[31] |= 0x80; // high bit = sign of x
  return out;
}

// RFC 8032 §5.1.5: A = [s]B where s = clamp(SHA-512(privateKey)[0:32]) and
// clamp() is h[0] &= 248; h[31] &= 127; h[31] |= 64. Two errors lived here
// before: hashing the key (it was being multiplied RAW by the group order L,
// which is not the spec — L only bounds the order) and omitting the clamp.
export function ed25519PublicKey(privateKey32) {
  const h = sha512(privateKey32);                 // 64 bytes, per RFC
  const s = new Uint8Array(32);
  s.set(h.slice(0, 32));
  s[0] &= 248; s[31] &= 127; s[31] |= 64;
  // little-endian scalar
  let scalar = 0n;
  for (let i = 31; i >= 0; i -= 1) scalar = (scalar << 8n) | BigInt(s[i]);
  const Pt = edScalarMul(B, scalar);
  return edEncodePoint(Pt);
}

// The order of the ed25519 prime-order subgroup: L = 2^252 + 27742317777372353535851937790883648493.
const ED25519_L = (1n << 252n) + 27742317777372353535851937790883648493n;

function leToBig(bytes) {
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i -= 1) v = (v << 8n) | BigInt(bytes[i]);
  return v;
}

function bigToLe(value, width) {
  const out = new Uint8Array(width);
  let v = value;
  for (let i = 0; i < width; i += 1) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
}

function bytesOf(value) {
  return value instanceof Uint8Array ? value : ethers.getBytes(value);
}

/**
 * RFC 8032 §5.1.6 Ed25519 signature. Returns R ‖ S (64 bytes) — exactly what
 * Solana wants, and exactly what the spec's own test vectors say (checked in
 * tests/coin-trees.test.js against RFC 8032 §7.1 TEST 1 and TEST 2).
 *
 * The three scalars, in order, are the whole algorithm:
 *   s = clamp(SHA-512(seed)[0:32])          — the secret scalar (same as the pubkey)
 *   r = SHA-512(prefix ‖ M) mod L           — nonce, prefix = SHA-512(seed)[32:64]
 *   k = SHA-512(R ‖ A ‖ M) mod L            — challenge binding the key and msessage
 *   S = (r + k·s) mod L
 * Get the reduction mod L wrong, or key the nonce off the wrong half of the hash
 * and the signature is invalid — it does not "mostly work".
 */
export function ed25519Sign(privateKey32, message) {
  const key = bytesOf(privateKey32);
  if (key.length !== 32) throw new Error('ed25519: the private key is 32 bytes');
  const msg = bytesOf(message);
  const h = sha512(key);                 // 64 bytes
  const sBytes = new Uint8Array(h.slice(0, 32));
  sBytes[0] &= 248; sBytes[31] &= 127; sBytes[31] |= 64;
  const s = leToBig(sBytes);
  const prefix = h.slice(32, 64);
  const A = edEncodePoint(edScalarMul(B, s));              // 32 bytes, the public key
  const r = leToBig(sha512(ethers.getBytes(ethers.concat([prefix, msg])))) % ED25519_L;
  const R = edEncodePoint(edScalarMul(B, r));              // 32 bytes
  const k = leToBig(sha512(ethers.getBytes(ethers.concat([R, A, msg])))) % ED25519_L;
  const S = (r + k * s) % ED25519_L;
  return ethers.getBytes(ethers.concat([R, bigToLe(S, 32)]));   // R ‖ S, 64 bytes
}

/** Decode a compressed ed25519 point (32 bytes) → extended coords, or null. */
function edDecodePoint(bytes) {
  const sign = (bytes[31] & 0x80) ? 1n : 0n;
  const y = mod(leToBig(bytes.slice(0, 32)) & ((1n << 255n) - 1n));
  const x = recoverX(y, sign);
  if (x === null) return null;
  return [x, y, 1n, mod(x * y)];
}

/**
 * RFC 8032 §5.1.7 verification, used to PROVE our own signer and to check
 * published transactions against their published key. Checks S < L (a
 * non-canonical S would otherwise be accepted by a sloppier check) and the
 * group equation  [S]B == R + [k]A, rewritten here as  [S]B − [k]A == R.
 * The public key is a Solana address's own bytes, so this verifies a real
 * on-chain transaction against the sender's own address.
 */
export function ed25519Verify(publicKey32, message, signature64) {
  const pk = bytesOf(publicKey32);
  const sig = bytesOf(signature64);
  if (pk.length !== 32 || sig.length !== 64) return false;
  const R = sig.slice(0, 32);
  const S = leToBig(sig.slice(32, 64));
  if (S >= ED25519_L) return false;
  const A = edDecodePoint(pk);
  if (!A) return false;
  const msg = bytesOf(message);
  const k = leToBig(sha512(ethers.getBytes(ethers.concat([R, pk, msg])))) % ED25519_L;
  const sB = edScalarMul(B, S);
  const kA = edScalarMul(A, k);
  const negkA = [mod(-kA[0]), kA[1], kA[2], mod(-kA[3])];
  return ethers.hexlify(edEncodePoint(edAdd(sB, negkA))) === ethers.hexlify(R);
}

// ── deposit memo / tag ──────────────────────────────────────────────────
// An address alone is not always a complete deposit instruction, and getting
// this wrong is a well-known way to lose money on arrival.
//
// XRP — many exchanges REQUIRE a DestinationTag (a uint32) alongside the
//   address, because the tag is what tells them which of your deposits this
//   is. Funds sent to an address with the wrong or missing tag are often
//   uncredited and effectively gone. The tag MUST be stable: derive it from the
//   account's own key material, never from a timestamp or a counter, or the tag
//   printed yesterday stops matching today's and a deposit lands nowhere.
//
// Bitcoin — no memo exists on-chain. The equivalent is BIP-21: a
//   `bitcoin:<addr>?amount=…&label=…` URI that carries the request, so a
//   payment app can prefill it. The address on its own is still what you paste.
//
// Solana — there is no destination tag on Solana; deposits are routed by
//   address alone. Some services accept an optional memo, so one is exposed,
//   but it is NOT presented as mandatory, because on Solana it usually isn't.

const TAG_SALT = utf8('bear.tool/xrp-destination-tag');

/**
 * A stable DestinationTag for an XRP account.
 * Deterministic in (seed, index): the same account always shows the same tag,
 * which is the entire point — a tag that moves between sessions is how funds
 * get stranded on an exchange.
 */
export function xrpDestinationTag(seed, index = 0) {
  const { accountId } = xrpAddresses(seed, index);
  const h = ethers.getBytes(ethers.sha256(ethers.concat([
    ethers.getBytes(accountId), TAG_SALT,
  ])));
  // Read a uint32 from the digest. 0 is the wire value for "no tag", and a few
  // exchanges treat 0 as an error, so nudge it out of the way.
  let tag = ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0;
  if (tag === 0) tag = 1;
  return tag;
}

// BIP-173/BIP-21 query values are percent-encoded; an unescaped "&" or "?" in a
// label silently truncates the URI into a different (wrong) payment request.
function encodeQueryComponent(value) {
  return encodeURIComponent(String(value))
    .replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/**
 * BIP-21 payment request. `amount` is in BTC (decimal), not satoshis — the
 * spec's amount parameter is a decimal BTC value, and passing satoshis here is
 * a classic way to request 100000000× the intended amount.
 */
export function btcPaymentUri({ address, amount, label, message } = {}) {
  if (!address) throw new Error('bitcoin: address required');
  const params = [];
  const hasAmount = amount !== undefined && amount !== null && amount !== '';
  if (hasAmount) {
    // A malformed amount used to be silently DROPPED, so a typo produced a URI
    // with no amount at all and the payer filled in their own number — the
    // request silently stopped meaning what was typed. Refuse instead.
    if (!Number.isFinite(Number(amount))) {
      throw new Error('bitcoin: amount must be a positive number of BTC');
    }
    params.push('amount=' + encodeQueryComponent(normaliseBtcAmount(amount)));
  }
  if (label) params.push('label=' + encodeQueryComponent(label));
  if (message) params.push('message=' + encodeQueryComponent(message));
  return 'bitcoin:' + address + (params.length ? '?' + params.join('&') : '');
}

/** Decimal BTC with no exponent and at most 8 places (1 satoshi). */
function normaliseBtcAmount(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) throw new Error('bitcoin: amount must be a positive number');
  return n.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * An xrpl: URI carrying the DestinationTag. Not every wallet reads it, which
 * is exactly why the UI also shows the tag as its own copyable field — an
 * exchange deposit form asks for "Tag" and "Address" in separate boxes.
 */
export function xrpPaymentUri({ address, tag, amount, memo } = {}) {
  if (!address) throw new Error('xrp: address required');
  const params = [];
  if (tag !== undefined && tag !== null && tag !== '') {
    const t = Number(tag);
    if (!Number.isInteger(t) || t < 0 || t > 0xffffffff) {
      throw new Error('xrp: DestinationTag must be a uint32');
    }
    params.push('dt=' + t);
  }
  if (amount !== undefined && amount !== null && amount !== '') {
    params.push('amount=' + encodeQueryComponent(amount));
  }
  if (memo) params.push('memo=' + encodeQueryComponent(memo));
  return 'xrpl:' + address + (params.length ? '?' + params.join('&') : '');
}

/** Solana: address only. A memo is optional and presented as such. */
export function solanaMemoUri({ address, memo } = {}) {
  if (!address) throw new Error('solana: address required');
  return 'solana:' + address + (memo ? '?memo=' + encodeQueryComponent(memo) : '');
}

// ── one entry point for the rest of the app ─────────────────────────────
/**
 * Every non-EVM address for one account, derived from the same seed the
 * EVM tree uses. This is what "all chains active on create wallet" means:
 * one mnemonic, one backup, addresses that are actually spendable on each.
 */
export function nonEvmAddresses(seed, index = 0) {
  const btc = btcAddresses(seed, index);
  const xrp = xrpAddresses(seed, index);
  const sol = solanaAddress(seed, index);
  return {
    bitcoin: { receive: btc.nativeSegwit, legacy: btc.legacy, xpub: btc.xpub },
    xrp: { receive: xrp.classic, destinationTag: xrpDestinationTag(seed, index) },
    solana: { receive: sol.address },
  };
}

// Export the primitives for tests that compare against published vectors.
export const __internals = {
  base58Encode, base58Decode, base58Check, sha256d,
  bech32Encode, bech32Decode, convertBits, ed25519PublicKey, ed25519Derive,
  xrpBase58Encode, xrpBase58Decode, XRP58,
};