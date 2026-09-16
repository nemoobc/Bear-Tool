// Bear Tool — wallet.test.js
// Tests for wallet create/import/encrypt/decrypt/derive + address helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// mock localStorage (browser-only API)
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => store.has(k) ? store.get(k) : null,
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k)
};

// load real ethers and expose as global (wallet.js uses global `ethers`)
const { ethers } = await import('ethers');
globalThis.ethers = ethers;

const wallet = await import('../js/wallet.js');

test('createWallet: returns address + 12-word mnemonic, stores keystore', async () => {
  store.clear();
  const res = await wallet.createWallet('password123');
  assert.match(res.address, /^0x[a-fA-F0-9]{40}$/);
  assert.equal(res.mnemonic.split(' ').length, 12);
  assert.ok(wallet.getKeystore());
  assert.equal(wallet.getAccounts().length, 1);
  assert.equal(wallet.getAccounts()[0].address, res.address);
});

test('encryptData/decryptData roundtrip', async () => {
  const payload = await wallet.encryptData('secret phrase here', 'pw');
  assert.ok(payload.salt.length === 16);
  assert.ok(payload.iv.length === 12);
  assert.ok(payload.data.length > 0);
  const plain = await wallet.decryptData(payload, 'pw');
  assert.equal(plain, 'secret phrase here');
});

test('decryptData: wrong password throws', async () => {
  const payload = await wallet.encryptData('x', 'right');
  await assert.rejects(() => wallet.decryptData(payload, 'wrong'));
});

test('importWallet: private key works', async () => {
  store.clear();
  const w = ethers.Wallet.createRandom();
  const res = await wallet.importWallet(w.privateKey, 'password123');
  assert.equal(res.address.toLowerCase(), w.address.toLowerCase());
  assert.equal(wallet.getAccounts()[0].path, 'imported');
});

test('importWallet: 12-word phrase works', async () => {
  store.clear();
  const w = ethers.Wallet.createRandom();
  const res = await wallet.importWallet(w.mnemonic.phrase, 'password123');
  assert.equal(res.address.toLowerCase(), w.address.toLowerCase());
});

test('importWallet: invalid input throws', async () => {
  store.clear();
  await assert.rejects(() => wallet.importWallet('not a valid input', 'password123'));
});

test('unlockWallet: roundtrip create → unlock → same address', async () => {
  store.clear();
  const created = await wallet.createWallet('password123');
  const signer = await wallet.unlockWallet('password123');
  assert.equal(signer.address.toLowerCase(), created.address.toLowerCase());
});

test('deriveNextAccount: derives m/44/60/0/0/1', async () => {
  store.clear();
  await wallet.createWallet('password123');
  const addr = await wallet.deriveNextAccount('password123');
  assert.match(addr, /^0x[a-fA-F0-9]{40}$/);
  assert.equal(wallet.getAccounts().length, 2);
  assert.equal(wallet.getAccounts()[1].path, "m/44'/60'/0'/0/1");
});

test('shortAddress: 6+4 format', () => {
  assert.equal(wallet.shortAddress('0x1234567890abcdef1234567890abcdef12345678'), '0x1234…5678');
});

test('isValidAddress: accepts checksummed, rejects garbage', () => {
  assert.ok(wallet.isValidAddress('0x1234567890123456789012345678901234567890'));
  assert.ok(!wallet.isValidAddress('0xzzz'));
  assert.ok(!wallet.isValidAddress(''));
});

test('isSuspiciousSimilar: catches address poisoning (same prefix+suffix)', () => {
  const real = '0x1234567890abcdef1234567890abcdef12345678';
  const evil = '0x1234999999999999999999999999999999995678'; // same 6+4, diff middle
  assert.ok(wallet.isSuspiciousSimilar(real, evil));
  assert.ok(!wallet.isSuspiciousSimilar(real, '0x9999999990abcdef1234567890abcdef12345678'));
  assert.ok(!wallet.isSuspiciousSimilar(real, real));
});

test('clearKeystore: wipes all wallet data', async () => {
  store.clear();
  await wallet.createWallet('password123');
  wallet.clearKeystore();
  assert.equal(wallet.getKeystore(), null);
  assert.equal(wallet.getAccounts().length, 0);
});