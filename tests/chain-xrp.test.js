// js/chain-xrp.js — XRP serialization and signing.
//
// This file is built around ONE real mainnet payment, captured from the XRP
// Ledger (ledger 107591743, validated):
//
//   hash       024B165844BEEF347E40992FBB71C4D281EB364E2491E5285015802D53A2EA3C
//   Account    rp2zmfCyJwCV4qRmDmD4ATPiHeY4pSHbs4
//   Destination rn6i8gZz2qpaecE9G5TRceZqJ1nz3bW9C5
//   Amount     240000000 drops (240 XRP)      Fee 12 drops
//   Sequence   69931753                       LastLedgerSequence 107591761
//   SigningPubKey 03C708952F528F4B1A4C8A12C5C6EB4130FF6D1B1392ACDA8CE8EE5B0DFE5DEB0E
//   TxnSignature  304402206FF16A0E99878A3BC4B3873D478AB37FE1B5A83F481A8B15F2EEB77A85C585C702204FF38957C99F055A486AF5568F2D5DE6B01D51CB5C50F7AC05A7B782E7A87474
//
// Two things are checked against it, and between them they pin the whole wire
// format: the digest that the published signature actually signs (recovered to
// the published public key), and the transaction hash the ledger published. A
// wrong field id, a wrong field order, a wrong length prefix or a wrong amount
// flag changes the hash — there is nowhere for a mistake to hide.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';

globalThis.ethers = ethers;
const xrp = await import('../js/chain-xrp.js');

const HASH = '024B165844BEEF347E40992FBB71C4D281EB364E2491E5285015802D53A2EA3C';
const PUB = '03C708952F528F4B1A4C8A12C5C6EB4130FF6D1B1392ACDA8CE8EE5B0DFE5DEB0E';
const SIG = '304402206FF16A0E99878A3BC4B3873D478AB37FE1B5A83F481A8B15F2EEB77A85C585C702204FF38957C99F055A486AF5568F2D5DE6B01D51CB5C50F7AC05A7B782E7A87474';
const ACCOUNT = 'rp2zmfCyJwCV4qRmDmD4ATPiHeY4pSHbs4';
const DESTINATION = 'rn6i8gZz2qpaecE9G5TRceZqJ1nz3bW9C5';

const TX = {
  TransactionType: 0,
  Sequence: 69931753,
  LastLedgerSequence: 107591761,
  Amount: '240000000',
  Fee: '12',
  SigningPubKey: PUB,
  Account: ACCOUNT,
  Destination: DESTINATION,
};

const SIGNED = { ...TX, TxnSignature: SIG };

// A DER signature (what the ledger stores) is not one of ethers' SignatureLike
// shapes, so pull r and s out of it by hand before asking ethers to recover —
// otherwise it reads the DER header as if it were a 65-byte raw signature.
function derToRS(hex) {
  const b = ethers.getBytes(`0x${String(hex).replace(/^0x/, '')}`);
  if (b[0] !== 0x30) throw new Error('not a DER signature');
  let at = 2;
  if (b[at] !== 0x02) throw new Error('not a DER signature');
  const rLen = b[at + 1];
  const rRaw = b.slice(at + 2, at + 2 + rLen);
  at += 2 + rLen;
  if (b[at] !== 0x02) throw new Error('not a DER signature');
  const sLen = b[at + 1];
  const sRaw = b.slice(at + 2, at + 2 + sLen);
  const pad = (x) => ethers.hexlify(x.length > 32 ? x.slice(x.length - 32) : x);
  return { r: pad(rRaw), s: pad(sRaw) };
}

/** The addresses that could have produced `der` over `digest`, both v values. */
function recoverBoth(digest, der) {
  const { r, s } = derToRS(der);
  return [27, 28]
    .map((v) => { try { return ethers.recoverAddress(digest, { r, s, v }); } catch { return null; } })
    .filter(Boolean);
}

test('the published transaction serializes to bytes whose hash the ledger agrees with', () => {
  const blob = xrp.serializeXrpTx(SIGNED);
  assert.equal(xrp.xrpTxHash(blob), HASH);
});

test('the signing preimage is what the published signature actually signed', () => {
  const digest = xrp.xrpSigningHash(TX);
  const expected = ethers.computeAddress(`0x${PUB}`);
  // Exactly one of the two possible recovery ids must yield the published key.
  const matches = recoverBoth(digest, SIG).filter((a) => a.toLowerCase() === expected.toLowerCase());
  assert.equal(matches.length, 1);
});

test('the Account field really is the account that owns the signing key', () => {
  const decoded = xrp.decodeXrpAddress(ACCOUNT);
  const derived = ethers.getBytes(ethers.ripemd160(ethers.sha256(`0x${PUB}`)));
  assert.equal(ethers.hexlify(decoded.accountId), ethers.hexlify(derived));
  assert.equal(xrp.xrpClassicAddress(decoded.accountId), ACCOUNT);
});

test('field order is canonical, not insertion order', () => {
  // Same fields, shuffled. Serialization must be identical.
  const shuffled = { Destination: DESTINATION, Fee: '12', Account: ACCOUNT, Amount: '240000000', SigningPubKey: PUB, LastLedgerSequence: 107591761, Sequence: 69931753, TransactionType: 0 };
  assert.equal(xrp.serializeXrpTx(shuffled), xrp.serializeXrpTx(TX));
});

test('an unknown field is refused instead of silently dropped', () => {
  assert.throws(() => xrp.serializeXrpTx({ ...TX, NotARealField: 1 }), /unknown field/);
});

test('issued currencies are refused by name', () => {
  assert.throws(() => xrp.serializeXrpTx({ ...TX, Amount: { value: '1', currency: 'USD', issuer: DESTINATION } }), /issued currencies/);
  assert.throws(() => xrp.serializeXrpTx({ ...TX, Amount: '1/USD/rn6i8gZz2qpaecE9G5TRceZqJ1nz3bW9C5' }), /issued currencies/);
});

test('X-addresses are refused, a wrong checksum is refused, a wrong network prefix is refused', () => {
  assert.throws(() => xrp.decodeXrpAddress('X7AcgcsBL6XDcUb289X4mJ8djcdyKaB5hJDWMArnXr61cqZ'), /X-addresses/);
  assert.throws(() => xrp.decodeXrpAddress('rp2zmfCyJwCV4qRmDmD4ATPiHeY4pSHbs5'), /checksum/);
  assert.throws(() => xrp.decodeXrpAddress('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'), /starts with "r"/);
  assert.throws(() => xrp.decodeXrpAddress(''), /enter a destination/);
});

test('buildSignedXrp signs for our own account and produces a verifiable blob', async () => {
  const { xrpKeypair } = await import('../js/coin-trees.js');
  const seed = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const mine = xrpKeypair(seed, 0);
  const dest = xrpKeypair(seed, 1);
  assert.notEqual(mine.classic, dest.classic);

  const built = xrp.buildSignedXrp({
    privateKey: mine.privateKey,
    account: mine.classic,
    destination: dest.classic,
    amountDrops: '1500000',
    feeDrops: 12,
    sequence: 42,
    lastLedgerSequence: 1000,
    destinationTag: 777,
  });

  // the blob hashes to the id we report, and the signature verifies against the
  // key we published in SigningPubKey
  assert.equal(xrp.xrpTxHash(built.blob), built.hash);
  assert.equal(built.txJson.SigningPubKey, mine.publicKey);
  const digest = ethers.getBytes(built.digest);
  const expected = ethers.computeAddress(`0x${mine.publicKey}`);
  const matches = recoverBoth(digest, built.txJson.TxnSignature).filter((a) => a.toLowerCase() === expected.toLowerCase());
  assert.equal(matches.length, 1);

  // the DestinationTag we asked for is in the blob
  assert.equal(built.txJson.DestinationTag, 777);

  // deterministic: same inputs, same bytes
  const again = xrp.buildSignedXrp({
    privateKey: mine.privateKey, account: mine.classic, destination: dest.classic,
    amountDrops: '1500000', feeDrops: 12, sequence: 42, lastLedgerSequence: 1000, destinationTag: 777,
  });
  assert.equal(again.blob, built.blob);
});

test('buildSignedXrp refuses an account this key does not control', async () => {
  const { xrpKeypair } = await import('../js/coin-trees.js');
  const seed = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const mine = xrpKeypair(seed, 0);
  const other = xrpKeypair(seed, 3);
  assert.throws(() => xrp.buildSignedXrp({
    privateKey: mine.privateKey, account: other.classic, destination: mine.classic,
    amountDrops: '1500000', sequence: 1, lastLedgerSequence: 100,
  }), /does not control the sending account/);
});

test('buildSignedXrp demands a LastLedgerSequence and a real fee', async () => {
  const { xrpKeypair } = await import('../js/coin-trees.js');
  const mine = xrpKeypair('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', 0);
  const base = { privateKey: mine.privateKey, account: mine.classic, destination: mine.classic, amountDrops: '1000000', sequence: 1 };
  assert.throws(() => xrp.buildSignedXrp({ ...base, lastLedgerSequence: null }), /LastLedgerSequence is required/);
  assert.throws(() => xrp.buildSignedXrp({ ...base, lastLedgerSequence: 99, feeDrops: 5 }), /at least 12 drops/);
  assert.throws(() => xrp.buildSignedXrp({ ...base, sequence: null, lastLedgerSequence: 99 }), /sequence number is required/);
});

test('XRP ↔ drops never touches floating point', () => {
  assert.equal(xrp.xrpToDrops('1'), 1000000n);
  assert.equal(xrp.xrpToDrops('0.000001'), 1n);
  assert.equal(xrp.xrpToDrops('240'), 240000000n);
  assert.equal(xrp.dropsToXrp(240000000n), '240');
  assert.equal(xrp.dropsToXrp(1500000n), '1.5');
  assert.equal(xrp.dropsToXrp(1n), '0.000001');
  assert.throws(() => xrp.xrpToDrops('0.0000001'), /6 decimal places/);
  assert.throws(() => xrp.xrpToDrops('0'), /greater than zero/);
  assert.throws(() => xrp.xrpToDrops('abc'), /enter an amount/);
});

test('sha512half is the first 32 bytes of SHA-512', () => {
  const out = xrp.sha512half(Uint8Array.from([0x61, 0x62, 0x63]));
  assert.equal(out.length, 32);
  assert.equal(ethers.hexlify(out), ethers.hexlify(ethers.getBytes(ethers.sha512('0x616263')).slice(0, 32)));
});
