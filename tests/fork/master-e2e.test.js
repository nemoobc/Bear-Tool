// ═══════════════════════════════════════════════════════════════
// Bear Tool — tests/fork/master-e2e.test.js
// THE master journey, end to end, against a real chain.
//
// Everything else in this suite tests a slice: the send handler, the swap
// path, the deploy builder, the OpenSea calls, the derivation vectors. Each of
// those can be green while the thing a person actually does — create a wallet,
// unlock it, see their addresses, add an account, delete one, and move money —
// is broken in a way no single slice would notice. This file walks that path
// once, in order, through the PRODUCTION modules (js/wallet.js, js/coin-trees.js)
// and a real anvil fork, so a break between the slices still lands somewhere.
//
// What makes this a bug-finder rather than a smoke test:
//   • It uses the real keystore (PBKDF2 310k + AES-GCM), not a fixture key, so
//     a corrupt save/unlock round-trip is caught here.
//   • It re-derives addresses from the SECRET the app actually stored, not from
//     the mnemonic the test happened to start with.
//   • It asserts money moved on chain and arrived at the address the app
//     derived — the only end of the chain that means anything to a user.
//
// Safety: anvil keys are public dev keys; the wallet created here is
// throwaway; no mnemonic is printed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFork, stopFork, forkSkipReason } from './fork-helper.mjs';

// ── storage shims BEFORE importing wallet.js (it writes on import paths) ──
const makeStore = () => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
  };
};
globalThis.localStorage = makeStore();
globalThis.sessionStorage = makeStore();

// wallet.js reaches for ethers on the global (no ESM import), same as the
// browser does after Capacitor loads it.
const { ethers } = await import('ethers');
globalThis.ethers = ethers;

const wallet = await import('../../js/wallet.js');
const { nonEvmAddresses, btcAddresses, solanaAddress, xrpAddresses } = await import('../../js/coin-trees.js');

const skip = forkSkipReason();
const PASSWORD = 'master-e2e-pass';

before(async () => { if (!skip) await startFork(); });
after(async () => { if (!skip) await stopFork(); });

// ── 1. create ────────────────────────────────────────────────────────────
test('master: create a wallet — the address on screen is the one it can sign for', { skip }, async () => {
  const created = await wallet.createWallet(PASSWORD, 'Master');

  assert.match(created.address, /^0x[0-9a-fA-F]{40}$/, 'an EVM address exists');
  assert.equal(created.mnemonic.trim().split(/\s+/).length, 12, 'a 12-word recovery phrase');
  assert.equal(created.name, 'Master', 'the name the user typed is what is stored');

  // The keystore is durable and encrypted: a saved wallet must not leave the
  // phrase sitting in localStorage in the clear.
  const dumped = JSON.stringify(globalThis.localStorage);
  assert.ok(!dumped.includes(created.mnemonic), 'the phrase is NEVER stored in the clear');
  assert.ok(!dumped.includes(PASSWORD), 'the password is never stored');

  // The account is recorded with a derivation PATH, not just an address — that
  // path is the only way a second account can be recovered later.
  const accounts = wallet.getAccounts();
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].address, created.address);
  assert.match(accounts[0].path, /^m\/44'\/60'\/0'\/0\/0$/);
});

// ── 2. unlock round-trip ─────────────────────────────────────────────────
test('master: unlock returns a signer for the SAME address, via the real keystore', { skip }, async () => {
  const created = await wallet.createWallet(PASSWORD, 'Master');
  // A fresh page: only the durable keystore survives, the session is gone.
  globalThis.sessionStorage.clear();

  const { signer, secret } = await wallet.unlockSession(PASSWORD);
  assert.equal(await signer.getAddress(), created.address,
    'signer must be the address shown at create time');
  assert.equal(secret, created.mnemonic, 'unlock yields the original phrase');

  // The app's own unlock handler (app.js doUnlock) persists the secret right
  // after unlocking — without that step the Receive screen, which derives every
  // chain's address from getSession(), would have nothing to derive from and
  // would silently show one address. Mirroring the real sequence is the point.
  assert.equal(wallet.getSession(), null, 'unlock alone does not persist a session');
  wallet.saveSession(secret);
  assert.equal(wallet.getSession(), created.mnemonic,
    'after saveSession, the Receive screen has the phrase it derives from');

  // Wrong password must fail loudly, not return some other wallet.
  await assert.rejects(() => wallet.unlockSession('wrong-password'),
    'a wrong password must not produce a signer');
});

// ── 3. every chain, from the secret the app actually stored ──────────────
test('master: one recovery phrase yields a real address on Bitcoin, Solana and XRP', { skip }, async () => {
  await wallet.createWallet(PASSWORD, 'Master');
  const { secret } = await wallet.unlockSession(PASSWORD);

  const addrs = nonEvmAddresses(secret, wallet.getActiveAccountIndex());

  // Present, plausible, and each in its own chain's encoding.
  assert.match(addrs.bitcoin.receive, /^bc1q[0-9a-z]{38}$/, 'bitcoin bech32');
  assert.match(addrs.bitcoin.legacy, /^[13][1-9A-HJ-NP-Za-km-z]{25,34}$/, 'bitcoin legacy');
  assert.match(addrs.solana.receive, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'solana base58');
  assert.match(addrs.xrp.receive, /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/, 'xrp classic');

  // Three different chains, three different addresses. One address serving two
  // chains is the shape of a derivation bug that a single-chain test misses.
  const seen = new Set([addrs.bitcoin.receive, addrs.solana.receive, addrs.xrp.receive]);
  assert.equal(seen.size, 3, 'the three chains must not share an address');

  // Deterministic: the phrase is the source of truth, so it must reproduce.
  assert.equal(nonEvmAddresses(secret, 0).bitcoin.receive, addrs.bitcoin.receive);
  assert.equal(solanaAddress(secret, 0).address, addrs.solana.receive);
  assert.equal(xrpAddresses(secret, 0).classic, addrs.xrp.receive);
});

// ── 4. second account — identity, not position ───────────────────────────
test('master: a second account is a different person on EVERY chain', { skip }, async () => {
  await wallet.createWallet(PASSWORD, 'Master');
  const first = await wallet.unlockSession(PASSWORD);
  const firstAddrs = nonEvmAddresses(first.secret, 0);

  const secondAddress = await wallet.deriveNextAccount(PASSWORD, 'Second');
  assert.notEqual(secondAddress, await first.signer.getAddress(),
    'account 2 must not repeat account 1');

  const accounts = wallet.getAccounts();
  assert.equal(accounts.length, 2);
  assert.equal(accounts[1].address, secondAddress);
  assert.equal(accounts[1].path, "m/44'/60'/0'/0/1", 'account 2 has its own path');

  const secondAddrs = nonEvmAddresses(first.secret, 1);
  for (const key of ['bitcoin', 'solana', 'xrp']) {
    assert.notEqual(secondAddrs[key].receive, firstAddrs[key].receive,
      `${key}: account 2 must not repeat account 1`);
  }
});

// ── 5. delete the FIRST account — survivors keep their keys ──────────────
// This is the regression that made position-based derivation dangerous: with
// two accounts, deleting index 0 splices the list, so anything that derived
// from the array position would hand back a DIFFERENT key than the address
// shown beside it — a wallet that signs with the wrong account and says
// nothing.
test('master: deleting the first account leaves the survivor signing as itself', { skip }, async () => {
  await wallet.createWallet(PASSWORD, 'Master');
  await wallet.deriveNextAccount(PASSWORD, 'Second');
  const before = wallet.getAccounts();
  const survivorAddressBefore = before[1].address;

  await wallet.deleteAccount(0, PASSWORD);

  const after = wallet.getAccounts();
  assert.equal(after.length, 1, 'one account left');
  assert.equal(after[0].address, survivorAddressBefore,
    'the survivor keeps ITS address — it does not inherit the deleted slot');

  // And it still signs as itself: unlock must agree with what is displayed.
  const { signer } = await wallet.unlockSession(PASSWORD);
  assert.equal(await signer.getAddress(), survivorAddressBefore,
    'unlock after a delete must return the surviving account, not a shifted one');
});

// ── 6. real money, on a real chain ───────────────────────────────────────
// The point of the whole file: an address the app derives is a key it can
// actually spend from. Anything short of a confirmed transaction leaves the
// "it shows the right address" claim unproven at the end that matters.
test('master: funds move on chain, and land at an address this wallet derived', { skip }, async () => {
  await wallet.createWallet(PASSWORD, 'Master');
  const { signer, secret } = await wallet.unlockSession(PASSWORD);

  // Recipient = THIS wallet's second account, derived by the app itself. Two
  // reasons it is the right choice: it is genuinely an address the Receive
  // screen would print, and it is derived from a freshly random seed, so it has
  // no history on mainnet.
  //
  // The obvious alternative — m/44'/60'/0'/0/0 of the "abandon…about" mnemonic
  // — is a trap worth recording: that address (0x9858EfFD…) is an EIP-7702
  // DELEGATED address on mainnet (its code is 0xef0100‖0x8a67b5…), so value
  // sent to it is forwarded to the delegate and its own balance stays 0. A
  // test asserting "balance went up" there fails with a perfectly healthy
  // transaction — measured, not guessed.
  const recipient = await wallet.deriveNextAccount(PASSWORD, 'Recipient');

  const { provider } = await startFork();
  const connected = signer.connect(provider);
  const me = await connected.getAddress();
  assert.notEqual(recipient, me, 'sender and recipient must differ');

  const amount = 10n ** 15n; // 0.001 ETH
  const before = await provider.getBalance(recipient);
  assert.equal(before, 0n, 'recipient starts empty (fresh address has no forked state)');

  // A freshly created wallet holds nothing, so fund it the way a faucet would.
  // Skipping this is not a shortcut — it is the difference between a test that
  // proves money moves and one that only proves the code compiles.
  await provider.send('anvil_setBalance', [me, '0x' + (10n ** 18n * 10n).toString(16)]);
  assert.ok(await provider.getBalance(me) > 0n, 'sender is funded');

  const tx = await connected.sendTransaction({ to: recipient, value: amount });
  const receipt = await tx.wait();
  assert.equal(receipt.status, 1, 'the transfer must actually succeed');

  const after = await provider.getBalance(recipient);
  assert.equal(after - before, amount,
    `recipient ${recipient} should hold ${amount}; got ${after} `
    + `(tx.to=${tx.to} block=${receipt.blockNumber} status=${receipt.status})`);

  // And the wallet still derives every chain's address after spending — the
  // receive screen must keep working once the account has a history.
  const printed = nonEvmAddresses(secret, 0);
  assert.ok(printed.bitcoin.receive && printed.solana.receive && printed.xrp.receive,
    'the receiving wallet still derives all three chain addresses after spending');
});