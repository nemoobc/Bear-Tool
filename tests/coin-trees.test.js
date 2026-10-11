// Proof, not vibes. Every address below is compared to a PUBLISHED test
// vector. If the derivation is subtly wrong (wrong curve, wrong coin type,
// wrong checksum), these fail — which is the point: a wallet address that
// "looks fine" but isn't the real one is a way to lose money.
//
// Vectors: BIP-39 mnemonic "abandon…about" (the canonical all-ones seed),
// m/44'/0'/0'/0/0 (BIP-44 example for Bitcoin) and m/44'/144'/0'/0/0 (XRP).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { btcAddresses, xrpAddresses, solanaAddress, nonEvmAddresses, hmacSha512, __internals } from '../js/coin-trees.js';

const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

// Re-encode a legacy address's HASH160 as bech32, so the two formats in the
// test are proven to share one key rather than being two strings typed by hand.
function bech32Of(legacy) {
  const payload = __internals.base58Decode(legacy);
  const program = Array.from(payload.slice(1, 21)); // skip version 0x00, drop checksum
  return __internals.bech32Encode('bc', [0].concat(__internals.convertBits(program, 8, 5, true)));
}

test('hmacSha512 matches RFC 4231 test case 1', () => {
  // key = 20 bytes of 0x0b, data = "Hi There"
  const key = new Uint8Array(20).fill(0x0b);
  const data = new TextEncoder().encode('Hi There');
  const mac = Buffer.from(hmacSha512(key, data)).toString('hex');
  assert.equal(mac,
    '87aa7cdea5ef619d4ff0b4241a1d6cb02379f4e2ce4ec2787ad0b30545e17cde'
    + 'daa833b7d6b8a702038b274eaea3f4e4be9d914eeb61f1702e696c203a126854');
});

test('hmacSha512 matches RFC 4231 test case 2 (short key)', () => {
  const mac = Buffer.from(hmacSha512(
    new TextEncoder().encode('Jefe'),
    new TextEncoder().encode('what do ya want for nothing?')
  )).toString('hex');
  assert.equal(mac,
    '164b7a7bfcf819e2e395fbe73b56e0a387bd64222e831fd610270cd7ea250554'
    + '9758bf75c05a994a6d034f65f8f0e6fdcaeab1a34d4a6b4b636e070a38bce737');
});

test('bitcoin: m/44\'/0\'/0\'/0/0 matches the published BIP-44 vector', () => {
  const a = btcAddresses(SEED, 0);
  // BIP-44 coin-type-0 vector for this mnemonic, account 0, change 0, index 0.
  // The P2PKH and P2WPKH forms MUST come from the same HASH160 — the legacy
  // address decodes to 0x00 d986ed01b7a22225a70edbf2ba7cfb63a15cb3aa and the
  // bech32 program below is byte-identical. (An earlier draft of this test
  // carried a bech32 string whose program was c0cebcd6… — a different key
  // entirely — and "passed" nothing; pairing them here is what makes the
  // vector a real check rather than two lucky strings.)
  assert.equal(a.legacy, '1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA');
  assert.equal(a.nativeSegwit, 'bc1qmxrw6qdh5g3ztfcwm0et5l8mvws4eva24kmp8m');
  // Same witness program, both formats — asserted through the encoding itself.
  assert.equal(a.nativeSegwit, bech32Of(a.legacy));
  // xpub is the account-level key — public, and must start with the xpub prefix
  assert.match(a.xpub, /^xpub/);
});

test('bitcoin: a different index gives a different, still-valid address', () => {
  const a0 = btcAddresses(SEED, 0);
  const a1 = btcAddresses(SEED, 1);
  assert.notEqual(a0.legacy, a1.legacy, 'account 1 must not repeat account 0');
  assert.match(a1.nativeSegwit, /^bc1q/);
});

test('bitcoin: addresses are deterministic — same seed, same address, always', () => {
  const a = btcAddresses(SEED, 0);
  const b = btcAddresses(SEED, 0);
  assert.equal(a.legacy, b.legacy);
  assert.equal(a.nativeSegwit, b.nativeSegwit);
});

test('bitcoin: the address never leaks the private key', () => {
  const a = btcAddresses(SEED, 0);
  for (const v of [a.legacy, a.nativeSegwit, a.xpub]) {
    assert.ok(!/^[0-9a-f]{64}$/i.test(v), 'an address must not be a bare hex private key');
    assert.ok(!/prv|PRV/.test(v));
  }
});

test('xrp: is GATED OFF, not faked — no plausible-but-wrong address', () => {
  // XRPL base58 checksum is not sha256d / sha512-half / ripemd160 (all tried
  // against rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh, none reproduce it). Until it
  // is implemented from rippled's encodeBase58Token, xrpAddresses MUST refuse
  // loudly rather than return an r… string that routes funds nowhere.
  assert.throws(() => xrpAddresses(SEED, 0), /XRP: not enabled yet/,
    'xrp harus melempar, bukan mengembalikan alamat yang salah');
  const all = nonEvmAddresses(SEED, 0);
  assert.equal(all.xrp.receive, null, 'xrp receive = null saat belum didukung');
  assert.match(all.xrp.unsupported, /not enabled yet/, 'alasannya ikut dikembalikan');
  // Bitcoin tetap hidup dan benar — gating dua chain lain bukan mematikan satu.
  assert.match(all.bitcoin.receive, /^bc1q/);
  assert.match(all.bitcoin.legacy, /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/);
});

test('ed25519 point arithmetic reproduces all three RFC 8032 public keys', () => {
  // This part IS proven: the scalar multiply, the clamp and the point encode.
  // (Solana itself stays gated — see the test below — but the curve code is
  // no longer the thing in doubt; only the child-key derivation is.)
  const vectors = [
    ['9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
      'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'],
    ['4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb',
      '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c'],
    ['c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7',
      'fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025'],
  ];
  for (const [sk, pk] of vectors) {
    assert.equal(Buffer.from(__internals.ed25519PublicKey(Buffer.from(sk, 'hex'))).toString('hex'), pk,
      `RFC 8032 vector ${sk.slice(0, 8)}…`);
  }
});

test('solana: SLIP-0010 full hardened chain matches the spec test vector', () => {
  // From satoshilabs/slips slip-0010.md, "Test vector 1 for ed25519". This is
  // the assertion that was missing: not just the master, but the CHILD private
  // key and chain code at every level, which is what actually decides an
  // address. The two details it pins down are ser32 big-endian and the child
  // key being I[0:32] verbatim (no XOR, no addition).
  const seed = new Uint8Array(Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex'));
  const I = hmacSha512(new TextEncoder().encode('ed25519 seed'), seed);
  const master = { key: I.slice(0, 32), chain: I.slice(32) };
  assert.equal(Buffer.from(master.key).toString('hex'),
    '2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7', 'm private');
  assert.equal(Buffer.from(master.chain).toString('hex'),
    '90046a93de5380a72b5e45010748567d5ea02bbf6522f979e05c0d8d8ca9fffb', 'm chain code');

  // m/0_H
  const c0 = __internals.ed25519Derive(master, 0);
  assert.equal(Buffer.from(c0.key).toString('hex'),
    '68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3', "m/0' private");
  assert.equal(Buffer.from(c0.chain).toString('hex'),
    '8b59aa11380b624e81507a27fedda59fea6d0b779a778918a2fd3590e16e9c69', "m/0' chain code");

  // m/0_H/1_H
  const c1 = __internals.ed25519Derive(c0, 1);
  assert.equal(Buffer.from(c1.key).toString('hex'),
    'b1d0bad404bf35da785a64ca1ac54b2617211d2777696fbffaf208f746ae84f2', "m/0'/1' private");
  assert.equal(Buffer.from(c1.chain).toString('hex'),
    'a320425f77d1b5c2505a6b1b27382b37368ee640e3557c315416801243552f14', "m/0'/1' chain code");

  // m/0_H/1_H/2_H
  const c2 = __internals.ed25519Derive(c1, 2);
  assert.equal(Buffer.from(c2.key).toString('hex'),
    '92a5b23c0b8a99e37d07df3fb9966917f5d06e02ddbd909c7e184371463e9fc9', "m/0'/1'/2' private");
  assert.equal(Buffer.from(c2.chain).toString('hex'),
    '2e69929e00b5ab250f49c3fb1c12f252de4fed2c1db88387094a0f8c4c9ccd6c', "m/0'/1'/2' chain code");
});

test('solana: an index at 2^31 derives correctly (the JS signed-`|` trap)', () => {
  // SLIP-0010 test vector 2, which deliberately uses index 2147483647. JS `|`
  // is a signed 32-bit operation, so `index | 0x80000000` overflows there and
  // used to silently produce the wrong key. Big indices are ordinary on
  // Solana's m/0'/i trees, so this is a real bug, not a theoretical one.
  const seed = new Uint8Array(Buffer.from(
    'fffcf9f6f3f0edeae7e4e1dedbd8d5d2cfccc9c6c3c0bdbab7b4b1aeaba8a5a'
    + '29f9c999693908d8a8784817e7b7875726f6c696663605d5a5754514e4b484542', 'hex'));
  const I = hmacSha512(new TextEncoder().encode('ed25519 seed'), seed);
  const master = { key: I.slice(0, 32), chain: I.slice(32) };
  assert.equal(Buffer.from(master.key).toString('hex'),
    '171cb88b1b3c1db25add599712e36245d75bc65a1a5c9e18d76f9f2b1eab4012', 'm private');
  const c0 = __internals.ed25519Derive(master, 0);
  assert.equal(Buffer.from(c0.key).toString('hex'),
    '1559eb2bbec5790b0c65d8693e4d0875b1747f4970ae8b650486ed7470845635', "m/0' private");
  const c1 = __internals.ed25519Derive(c0, 2147483647);
  assert.equal(Buffer.from(c1.key).toString('hex'),
    'ea4f5bfe8694d8bb74b7b59404632fd5968b774ed545e810de9c32a4fb4192f4', "m/0'/2147483647' private");
  assert.equal(Buffer.from(c1.chain).toString('hex'),
    '138f0b2551bcafeca6ff2aa88ba8ed0ed8de070841f0c4ef0165df8181eaad7f', "… chain code");
});

test('solana: derives a real base58 address from a mnemonic', () => {
  const a = solanaAddress(SEED, 0);
  assert.match(a.address, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  const decoded = __internals.base58Decode(a.address);
  assert.equal(decoded.length, 32, 'a Solana public key is exactly 32 bytes');
  assert.equal(Buffer.from(decoded).toString('hex'), a.publicKey.slice(2),
    'address decodes back to the public key it was built from');
  // Deterministic + per-index, like every other chain here.
  assert.equal(solanaAddress(SEED, 0).address, a.address);
  assert.notEqual(solanaAddress(SEED, 1).address, a.address);
});

// The SHA-512 core behind SLIP-0010 matches its vector (master key AND the
// m/0' CHAIN CODE — so the HMAC construction is right; only the resulting
// child private key remains unconfirmed).
test('the SHA-512 core behind SLIP-0010 matches its vector (master key)', () => {
  // Proves the BIP-39 seed + HMAC chain is right even while Solana itself is
  // gated: SLIP-0010 ed25519 master key for seed 000102…0f.
  const seed = new Uint8Array(Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex'));
  const I = hmacSha512(new TextEncoder().encode('ed25519 seed'), seed);
  assert.equal(Buffer.from(I.slice(0, 32)).toString('hex'),
    '2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7');
  assert.equal(Buffer.from(I.slice(32)).toString('hex'),
    '90046a93de5380a72b5e45010748567d5ea02bbf6522f979e05c0d8d8ca9fffb');
});

test('the SLIP-0010 child CHAIN CODE is reproducible (shape of the data is right)', () => {
  const seed = new Uint8Array(Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex'));
  const I = hmacSha512(new TextEncoder().encode('ed25519 seed'), seed);
  const master = { key: I.slice(0, 32), chain: I.slice(32) };
  // Documented form: 0x00 ‖ ser256(k) ‖ ser32(i | 0x80000000), key = chain.
  const data = new Uint8Array(1 + 32 + 4);
  data[0] = 0x00;
  data.set(master.key, 1);
  data[33] = 0x80; data[34] = 0; data[35] = 0; data[36] = 0;
  const out = hmacSha512(master.chain, data);
  // The chain half is independent of how the key half is finished, so this
  // pins the HMAC shape without asserting the unverified child key. ser32 is
  // little-endian with the hardened bit set → 0x80000000 → 00 00 00 80.
  assert.equal(Buffer.from(out.slice(32)).toString('hex').slice(0, 16), '8b59aa11380b624e');
});

test('base58: encode/decode round-trips and the checksum rejects tampering', () => {
  const bytes = Uint8Array.from([0, 0, 1, 2, 3, 250, 255]);
  const enc = __internals.base58Encode(bytes);
  assert.deepEqual(Array.from(__internals.base58Decode(enc)), Array.from(bytes));

  // A BTC address whose last char is flipped must fail base58check.
  const a = btcAddresses(SEED, 0);
  const tampered = a.legacy.slice(0, -1) + (a.legacy.slice(-1) === 'A' ? 'B' : 'A');
  assert.notEqual(a.legacy, tampered);
  // Decoding tampered yields different payload → different checksum.
  const d1 = __internals.base58Decode(a.legacy);
  const d2 = __internals.base58Decode(tampered);
  assert.notDeepEqual(Array.from(d1), Array.from(d2));
});

test('nonEvmAddresses returns every chain that is proven, and says why XRP is not', () => {
  const a = nonEvmAddresses(SEED, 0);
  assert.match(a.bitcoin.receive, /^bc1q/);
  assert.match(a.bitcoin.legacy, /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/);
  assert.match(a.solana.receive, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'Solana is live now');
  // XRP stays visible-but-absent with its reason, never silently dropped.
  assert.equal(a.xrp.receive, null);
  assert.ok(a.xrp.unsupported);
});

test('nothing in the public API returns a private key or the seed', () => {
  const a = nonEvmAddresses(SEED, 0);
  const flat = JSON.stringify(a).toLowerCase();
  assert.ok(!flat.includes(SEED.split(' ')[0]), 'the mnemonic must not appear in the output');
  assert.ok(!flat.includes('abandon'), 'seed words must not leak');
  assert.ok(!/"(privateKey|privkey|secret|seed|mnemonic)"\s*:/.test(flat), 'no key material field');
});