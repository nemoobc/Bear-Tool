// The whole journey, from an empty app to a transaction on chain.
//
// Why this file exists. js/wallet.js has 25 exports and is the first thing a
// person touches, and it had no test that called it. The same blindness that let
// js/swap.js ship with two undefined ABI constants — a ReferenceError on every
// quote and every swap, on every chain, while the suite was green — applied to the
// module that decides whether the app is usable at all. If createWallet or
// signerFromSecret is broken, there is no application to test afterwards.
//
// The point is that the wallet is created HERE, funded HERE, and used to sign
// something that a chain accepts. Checking that an address has the right shape
// would pass with a wallet that cannot sign.
//
// Safety: the wallet is generated inside the test with a throwaway password. No
// real key, no real seed, and nothing printed — the assertions are about addresses
// and signature recovery, never about the secret itself.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

// A storage shim before the app modules load: wallet.js writes the keystore to
// localStorage and the session secret to sessionStorage at call time, and the
// point of these tests is to exercise those writes, not to stub them away.
const store = () => {
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
globalThis.localStorage = store();
globalThis.sessionStorage = store();
globalThis.ethers = await import('ethers');

const here = path.dirname(fileURLToPath(import.meta.url));
const app = (rel) => import(pathToFileURL(path.join(here, '..', '..', rel)).href);
// Sibling helper, in this directory. Through app() it resolved to
// <repo>/fork-helper.mjs, because app() is rooted at the repo, not at tests/fork.
const sib = (f) => import(pathToFileURL(path.join(here, f)).href);
const W = await app('js/wallet.js');
const { isValidAddress, isSuspiciousSimilar, shortAddress, createWallet, importWallet,
        unlockWallet, unlockSession, signerFromSecret, getKeystore, getAccounts,
        getActiveAccountIndex, clearKeystore, getSession, clearSession, saveSession } = W;

const PW = 'journey-test-only-password';
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];

// ── the wallet itself, no chain needed ─────────────────────────────────────

test('creating a wallet yields a usable signer and a stored keystore', async () => {
  clearKeystore();
  const w = await createWallet(PW, 'Journey');
  assert.ok(isValidAddress(w.address), `alamat hasil createWallet tidak valid: ${w.address}`);
  assert.equal(w.name, 'Journey');
  // 12 words, and the words are never asserted on or printed — only counted.
  assert.equal(w.mnemonic.trim().split(/\s+/).length, 12);
  assert.ok(getKeystore(), 'keystore tidak tersimpan');
  assert.equal(getAccounts().length, 1);
  assert.equal(getActiveAccountIndex(), 0);

  // The address must be recoverable from the stored keystore, or the wallet is a
  // one-shot object that does not survive a refresh.
  const signer = await unlockWallet(PW);
  assert.equal(signer.address, w.address,
    'unlock menghasilkan alamat berbeda dari createWallet — keystore dan akun tidak sinkron');
  assert.equal(getAccounts()[0].path, "m/44'/60'/0'/0/0");
});

test('the wrong password does not unlock it', async () => {
  clearKeystore();
  const w = await createWallet(PW, 'Lock check');
  await assert.rejects(() => unlockWallet('not-the-password'));
  // …and a good one still does, so the check above proved the rejection was about
  // the password rather than the wallet being broken to begin with.
  const signer = await unlockWallet(PW);
  assert.equal(signer.address, w.address);
});

test('importing the seed phrase recovers the same address', async () => {
  // The round trip a user actually performs: create on one machine, restore on
  // another. If the derivation path or the account index is off by anything, this
  // is where it shows.
  clearKeystore();
  const created = await createWallet(PW, 'Round trip');
  const restored = await importWallet(created.mnemonic, PW, 'Restored');
  assert.equal(restored.address, created.address,
    'mnemonic yang sama menghasilkan alamat berbeda — derivasi tidak konsisten');
  assert.equal(getAccounts()[0].path, 'imported');
  const signer = await unlockWallet(PW);
  assert.equal(signer.address, created.address);
});

test('importing a private key and rejecting junk', async () => {
  clearKeystore();
  // A throwaway key produced here, not written down anywhere.
  const { ethers: E } = globalThis;
  const w = E.Wallet.createRandom();
  const imported = await importWallet(w.privateKey, PW, 'By key');
  assert.equal(imported.address, w.address);

  for (const junk of ['not-a-key', '0x123', 'two words']) {
    await assert.rejects(() => importWallet(junk, PW, 'Bad'),
      `harus menolak input: ${junk}`);
  }
  // The message is the app's own and already a sentence; the translator must leave
  // it alone rather than dressing it up.
  const err = await importWallet('two words', PW, 'Bad').catch((e) => e);
  assert.match(err.message, /seed phrase or a private key/i);
});
test('the phishing guard catches address poisoning, not general resemblance', () => {
  // isSuspiciousSimilar exists for one job, and js/send.js:194 is the only caller:
  // before sending, it compares the destination against addresses this wallet has
  // already sent to. Address poisoning works by sending dust from an address that
  // shares the first and last characters of an address the user trusts, so that a
  // later "recent destination" is the attacker's. Same prefix AND same suffix is
  // therefore the whole signal.
  //
  // The first version of this test asserted that an address differing by one
  // character in the LAST position is flagged. It is not, and it should not be —
  // that check found nothing wrong with the code and a wrong expectation about it,
  // which is the more expensive kind of wrong because it looks like a finding.
  // The distinction the guard does not make is pinned below rather than left
  // assumed.
  const real = '0x52908400098527886E0F7030069857D2E4169EE7';
  const poisoned = '0x52908400098527886E0F00000000000000009EE7'; // same ends, new middle, exactly 40 hex
  // A mistyped fixture is worse than no fixture: a 41-character address ending in
  // 0EE7 fails this guard for the right reason and the wrong one, and reads as
  // "the guard missed it". So the fixture's own shape is asserted here.
  assert.equal(poisoned.length, 42, 'alamat racun harus 40 hex + 0x');
  assert.equal(poisoned.slice(0, 6), real.slice(0, 6), 'harus sama awalan');
  assert.equal(poisoned.slice(-4), real.slice(-4), 'harus sama 4 karakter akhir');
  assert.notEqual(poisoned, real);
  assert.equal(isSuspiciousSimilar(real, poisoned), true,
    'alamat racun dengan awalan dan akhir sama harus ditandai');
  assert.equal(isSuspiciousSimilar(real, real), false, 'alamat yang sama bukan racun');
  assert.equal(isSuspiciousSimilar(real, '0x1111111111111111111111111111111111111111'), false,
    'alamat yang tidak mirip tidak boleh ditandai — guard yang terlalu mudah menyala membuat tool tidak berguna');
  assert.equal(isSuspiciousSimilar(real, '0x52908400098527886E0F7030069857D2E4169EE8'), false,
    'beda di posisi terakhir mengubah akhir, jadi bukan pola racun — dicatat agar sifat ini diketahui');
  assert.equal(isSuspiciousSimilar(real, ''), false, 'alamat kosong tidak boleh memicu peringatan');
  assert.equal(isSuspiciousSimilar(null, real), false);
  // Case must not matter: the same address typed in a different case is the same
  // address, and a case-sensitive guard would warn about the user's own wallet.
  assert.equal(isSuspiciousSimilar(real, real.toLowerCase()), false,
    'huruf besar/kecil diperlakukan berbeda — guard akan memperingatkan wallet sendiri');
  assert.equal(isSuspiciousSimilar(real.toUpperCase().replace('0X', '0x'), poisoned), true,
    'perbandingan harus tahan huruf besar/kecil');
});

test('a session can be stored and cleared', async () => {
  clearKeystore();
  const w = await createWallet(PW, 'Session');
  const { signer, secret } = await unlockSession(PW);
  assert.equal(signer.address, w.address);
  saveSession(secret);
  assert.ok(getSession(), 'session tidak tersimpan');
  clearSession();
  assert.equal(getSession(), null, 'session tidak terhapus');
  // Clearing must leave the keystore alone: locking is not the same as deleting.
  assert.ok(getKeystore(), 'clearSession ikut menghapus keystore — itu berarti kehilangan wallet');
});

test('an empty keystore is a clear message, not a crash', async () => {
  clearKeystore();
  await assert.rejects(() => unlockWallet(PW), (e) => {
    assert.match(e.message, /no wallet found|create or import/i);
    return true;
  });
});

// ── and now the same wallet, on a chain ────────────────────────────────────

let fork = null;
const { startFork, forkSkipReason, stopFork, waitForTx, ANVIL_ACCOUNT } =
  await sib('fork-helper.mjs');
const skip = forkSkipReason();

before(async () => { if (!skip) fork = await startFork(); });
after(async () => { if (!skip) await stopFork(); });

test('a wallet created here can be funded and can send value', { skip }, async (t) => {
  // anvil_setBalance is a cheatcode, so a wallet minted moments ago in this test
  // can hold real balance on a fork of the real chain. Without that, "the wallet
  // works" can only ever mean "the address has the right shape", which is a much
  // smaller claim than the one a user makes when they create a wallet.
  const { provider } = fork;
  const { ethers: E } = globalThis;
  clearKeystore();
  const w = await createWallet(PW, 'On chain');
  // unlockWallet hands back a key-only Wallet (provider binding is the
  // caller's job, exactly as app flows do). sendTransaction needs the fork.
  const signer = (await unlockWallet(PW)).connect(provider);

  t.diagnostic(`wallet baru: ${w.address}`);

  // Sign something the chain-independent tooling can verify, before funding: a
  // signature that recovers to this address proves the signer is real.
  const message = 'bear-tool journey';
  const sig = await signer.signMessage(message);
  assert.equal(E.verifyMessage(message, sig), w.address,
    'tanda tangan tidak pulih ke alamat wallet — signer bukan pemilik key itu');

  const balBefore = await provider.getBalance(w.address);
  assert.equal(balBefore, 0n, 'wallet baru harus mulai kosong');

  const fund = E.parseEther('0.75');
  await provider.send('anvil_setBalance', [w.address, '0x' + fund.toString(16)]);
  assert.equal(await provider.getBalance(w.address), fund,
    'anvil_setBalance tidak mengisi wallet — fork tidak bisa menguji wallet baru');

  // And spend it. A signer that can recover its own signature but cannot produce
  // a chain-accepted transaction would still pass the check above.
  // A fresh destination: anvil prefunds its built-in accounts with 10000 ETH
  // on every fork, so an exact-balance assert against one of them can never
  // pass (the address already holds more than this test sends).
  const dest = E.Wallet.createRandom().address;
  const amount = E.parseEther('0.25');
  const tx = await signer.sendTransaction({ to: dest, value: amount });
  const r = await waitForTx(tx, 'journey send');
  assert.equal(r?.status, 1, `transaksi wallet baru gagal: ${r?.status}`);
  // Poll instead of one read: anvil's fork state can lag a receipt by a block
  // (same pattern as fork-eip7702.test.js and fork-send.test.js).
  const poll = async (addr, want) => {
    const until = Date.now() + 30000;
    let bal = await provider.getBalance(addr);
    while (bal !== want && Date.now() < until) {
      await new Promise((res) => setTimeout(res, 500));
      bal = await provider.getBalance(addr);
    }
    return bal;
  };
  assert.equal(await poll(dest, amount), amount, 'tujuan tidak menerima dana');
  // ethers v6 renamed the receipt field: effectiveGasPrice no longer exists on
  // TransactionReceipt (undefined → BigInt() throws); gasPrice is it.
  const expectLeft = fund - amount - BigInt(r.gasUsed) * BigInt(r.gasPrice);
  assert.equal(await poll(w.address, expectLeft), expectLeft,
    'sisa saldo tidak sesuai dengan yang dikirim dikurangi gas');
  t.diagnostic(`wallet baru mengirim ${E.formatEther(amount)} ETH, gas ${E.formatEther(BigInt(r.gasUsed) * BigInt(r.gasPrice))} ETH`);

  // The anvil-funded account and the created wallet are different actors; if the
  // test ever silently substituted one for the other, the whole journey would be
  // measuring the harness instead of the wallet.
  assert.notEqual(w.address.toLowerCase(), ANVIL_ACCOUNT.toLowerCase(),
    'wallet yang diuji ternyata akun anvil — journey tidak menguji apa pun');
});
