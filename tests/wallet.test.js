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

// mock sessionStorage (browser-only API)
const session = new Map();
globalThis.sessionStorage = {
  getItem: (k) => session.has(k) ? session.get(k) : null,
  setItem: (k, v) => session.set(k, String(v)),
  removeItem: (k) => session.delete(k)
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
  const res = await wallet.createWallet('password123');
  const signer = await wallet.unlockWallet('password123');
  assert.equal(signer.address, res.address);
});

test('session: saveSession/getSession/clearSession roundtrip', async () => {
  session.clear();
  const res = await wallet.createWallet('password123');
  wallet.saveSession(res.mnemonic);
  assert.equal(wallet.getSession(), res.mnemonic);
  wallet.clearSession();
  assert.equal(wallet.getSession(), null);
});

test('session: localStorage fallback restores a closed tab (within window)', async () => {
  session.clear();
  store.clear();
  const res = await wallet.createWallet('password123');
  wallet.saveSession(res.mnemonic);
  // simulate tab close: sessionStorage wiped, localStorage survives
  session.clear();
  assert.equal(wallet.hasSessionStorage(), false, 'sessionStorage copy must be gone after tab close');
  assert.equal(wallet.getSession(), res.mnemonic, 'localStorage copy must restore the session');
  assert.ok(wallet.getSessionTs() > 0, 'localStorage copy must carry a timestamp');
  wallet.clearSession();
  assert.equal(wallet.getSession(), null, 'clearSession must wipe the localStorage copy too');
  assert.equal(wallet.getSessionTs(), null);
});

test('signerFromSecret: derives the same address as unlockWallet', async () => {
  store.clear();
  const res = await wallet.createWallet('password123');
  const signer = await wallet.unlockWallet('password123');
  const fromSecret = wallet.signerFromSecret(res.mnemonic);
  assert.equal(fromSecret.address, signer.address);
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
test('nextAccountName: walks Wallet, Wallet 1, Wallet 2 …', () => {
  assert.equal(wallet.nextAccountName([]), 'Wallet');
  assert.equal(wallet.nextAccountName([{ name: 'Wallet' }]), 'Wallet 1');
  assert.equal(wallet.nextAccountName([{ name: 'Wallet' }, { name: 'Wallet 1' }]), 'Wallet 2');
  assert.equal(wallet.nextAccountName([{ name: 'WALLET' }]), 'Wallet 1', 'dedupe must be case-insensitive');
  assert.equal(wallet.nextAccountName([], 'Main'), 'Main', 'custom base name');
  assert.equal(wallet.nextAccountName([{ name: 'Main' }], 'Main'), 'Main 1');
});

test('createWallet/importWallet: store the given name, default to Wallet', async () => {
  store.clear();
  await wallet.createWallet('password123', '  Trading  ');
  assert.equal(wallet.getAccounts()[0].name, 'Trading', 'name must be trimmed and kept');
  store.clear();
  await wallet.createWallet('password123');
  assert.equal(wallet.getAccounts()[0].name, 'Wallet', 'blank name must auto-resolve');
  store.clear();
  const w = ethers.Wallet.createRandom();
  await wallet.importWallet(w.privateKey, 'password123', 'Cold');
  assert.equal(wallet.getAccounts()[0].name, 'Cold');
});

test('deriveNextAccount: auto-names each new account', async () => {
  store.clear();
  await wallet.createWallet('password123');
  await wallet.deriveNextAccount('password123');
  await wallet.deriveNextAccount('password123');
  assert.deepEqual(wallet.getAccounts().map(a => a.name), ['Wallet', 'Wallet 1', 'Wallet 2']);
});

// Choosing an account in the switcher used to move the pointer FIRST and ask for
// the password afterwards:
//
//     wallet.setActiveAccount(i);
//     const pw = await promptPassword(...);
//     if (!pw) return;            // cancelled — the pointer has already moved
//     ... catch { toast('Wrong password') }   // wrong — same
//
// setActiveAccount writes localStorage immediately, so cancelling the prompt left
// the stored active index pointing at an account the topbar was still not showing.
// The next unlock — after a lock, a reload, or an expired session — then derived
// that other account's key. In a wallet the worst outcome is not a wrong number on
// screen: it is the displayed address and the signing address being different
// accounts, and nothing in the UI saying so.
//
// The invariant, stated where it can be enforced: deriving a signer for an account
// must not change which account is active. Only an explicit commit may.
test('a failed or cancelled account switch leaves the active account untouched', async () => {
  store.clear();
  await wallet.createWallet('password123', 'Main');
  await wallet.deriveNextAccount('password123', 'Second');
  assert.equal(wallet.getAccounts().length, 2);
  wallet.setActiveAccount(0);
  assert.equal(wallet.getActiveAccountIndex(), 0);

  // A wrong password must leave the pointer exactly where it was. The message is
  // not asserted: a wrong password surfaces as a bare DOMException ("The operation
  // failed for an operation-specific reason"), which says nothing about the cause,
  // and pinning a test to that string would only lock the unhelpful wording in.
  await assert.rejects(() => wallet.unlockWallet('not-the-password', 1));
  assert.equal(wallet.getActiveAccountIndex(), 0,
    'a wrong password moved the active account — the next unlock would use a different account than the one on screen');

  // The right password derives the requested account WITHOUT switching to it.
  const signer = await wallet.unlockWallet('password123', 1);
  assert.equal(signer.address, wallet.getAccounts()[1].address,
    'unlockWallet(password, index) must derive the requested account');
  assert.equal(wallet.getActiveAccountIndex(), 0,
    'deriving a signer must not switch the active account; only the commit may');

  // The commit is the one and only thing that moves it.
  wallet.setActiveAccount(1);
  assert.equal(wallet.getActiveAccountIndex(), 1);
  assert.equal((await wallet.unlockWallet('password123')).address, wallet.getAccounts()[1].address,
    'with no index, the active account is the one used');
});
