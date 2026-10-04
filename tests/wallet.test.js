// Bear Tool — wallet.test.js
// Tests for wallet create/import/encrypt/decrypt/derive + address helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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

// A phrase import records path:'imported' — no path index — while the phrase
// itself IS m/44'/60'/0'/0/0. The old "highest recorded index + 1" therefore
// started at 0 and derived a TWIN of the imported account: two rows in the
// switcher, one key, and the user signing with a wallet that already existed.
test('deriveNextAccount: import phrase lalu derive → alamat unik, bukan kembar', async () => {
  store.clear();
  const w = ethers.Wallet.createRandom();
  const res = await wallet.importWallet(w.mnemonic.phrase, 'password123');
  assert.equal(wallet.getAccounts().length, 1, 'pra-kondisi: satu akun imported');

  const addr = await wallet.deriveNextAccount('password123');
  const accs = wallet.getAccounts();
  assert.equal(accs.length, 2, 'akun baru bertambah');
  assert.notEqual(addr.toLowerCase(), res.address.toLowerCase(),
    'alamat akun baru tidak boleh sama dengan alamat imported (repro: DUPLICATE true)');
  const addrs = accs.map((a) => String(a.address).toLowerCase());
  assert.equal(new Set(addrs).size, addrs.length,
    'tak ada alamat kembar di seluruh daftar');
  assert.equal(accs[1].path, "m/44'/60'/0'/0/1",
    'index lompat ke /1 karena /0 sudah dipakai imported');
});

test('deriveNextAccount: wallet private-key → pesan "bukan seed-phrase", bukan Wrong password', async () => {
  store.clear();
  const w = ethers.Wallet.createRandom();
  await wallet.importWallet(w.privateKey, 'password123');
  await assert.rejects(() => wallet.deriveNextAccount('password123'),
    /Tambah akun hanya untuk seed-phrase wallet/,
    'tipe non-HD harus diberi pesan yang benar, bukan salah sandi');
  // and a genuinely wrong password still says exactly that
  await assert.rejects(() => wallet.deriveNextAccount('bukan-sandi-ini'), /Wrong password/);
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

// ── delete wallet (live request: hapus wallet pilihan user) ──
// Deleting SPLICES the accounts array, and signerFromSecret used to derive by
// ARRAY POSITION — every shifted account would silently resolve a different
// key than the address shown beside it. These tests pin the whole contract.

test('deleteAccount: hapus akun, aktif menyesuaikan, akun terakhir ditolak', async () => {
  store.clear();
  await wallet.createWallet('password123');
  await wallet.deriveNextAccount('password123');
  await wallet.deriveNextAccount('password123');
  assert.equal(wallet.getAccounts().length, 3);

  wallet.setActiveAccount(2);
  // wrong password must reject AND leave the list untouched
  await assert.rejects(wallet.deleteAccount(1, 'wrong'));
  assert.equal(wallet.getAccounts().length, 3, 'password salah = daftar tak berubah');

  // delete the ACTIVE account (idx 2) → active falls back to 0
  await wallet.deleteAccount(2, 'password123');
  assert.equal(wallet.getAccounts().length, 2);
  assert.equal(wallet.getActiveAccountIndex(), 0, 'hapus akun aktif → aktif = 0');

  // active shifts down when an entry BEFORE it disappears
  wallet.setActiveAccount(1);
  await wallet.deleteAccount(0, 'password123');
  assert.equal(wallet.getActiveAccountIndex(), 0, 'hapus entry sebelum aktif → aktif -1');

  // the last remaining wallet can never be deleted
  await assert.rejects(wallet.deleteAccount(0, 'password123'), /last/i);
  assert.equal(wallet.getAccounts().length, 1);
});

test('deleteAccount: kunci ikut PATH tersimpan — hapus tengah tak boleh salah kunci', async () => {
  store.clear();
  await wallet.createWallet('password123');
  await wallet.deriveNextAccount('password123');
  await wallet.deriveNextAccount('password123');
  const secret = await wallet.exportSecret('password123');
  const third = wallet.getAccounts()[2];
  assert.equal(wallet.signerFromSecret(secret, 2).address, third.address, 'pra-kondisi');

  await wallet.deleteAccount(1, 'password123');
  const shifted = wallet.getAccounts()[1];
  assert.equal(shifted.address, third.address, 'entry lama idx2 bergeser ke posisi 1');
  assert.equal(wallet.signerFromSecret(secret, 1).address, shifted.address,
    'setelah splice, posisi 1 harus tetap membuka kunci entry itu (derive by path)');
});

test('deriveNextAccount: derive setelah delete tengah tidak tabrakan HD index', async () => {
  store.clear();
  await wallet.createWallet('password123');
  await wallet.deriveNextAccount('password123');
  await wallet.deriveNextAccount('password123');
  await wallet.deleteAccount(1, 'password123');
  await wallet.deriveNextAccount('password123');
  const addrs = wallet.getAccounts().map((a) => a.address.toLowerCase());
  assert.equal(addrs.length, 3, 'jumlah kembali 3');
  assert.equal(new Set(addrs).size, addrs.length, 'tak ada alamat kembar (index tak ditimpa)');
});

test('UI wiring: tombol hapus per baris + handler di accounts modal + CSS sendiri', () => {
  const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
  assert.ok(app.includes('data-del-acc'), 'baris akun harus membawa tombol data-del-acc');
  assert.ok(app.includes('deleteAccount('), 'handler harus memanggil wallet.deleteAccount');
  assert.ok(/\[data-del-acc\].*addEventListener/s.test(app), 'tombol hapus wajib di-wire');
  const css = readFileSync(new URL('../css/cartoon.css', import.meta.url), 'utf8');
  assert.ok(css.includes('.acc-del-btn'), 'tombol hapus butuh style sendiri (.acc-del-btn)');
});

// ── app.js: the switcher's delete + add handlers ────────────────────────────
// wallet.js can only promise that the LIST is right. What the screen does with
// it — repointing the signer, re-reading the home label, refusing a derive it
// cannot perform — is app.js's half of the same contract.
const appSrc = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');

test('app: delete tetap refresh daftar walau re-unlock pasca-delete gagal', () => {
  const start = appSrc.indexOf('const wasActive = i === wallet.getActiveAccountIndex();');
  const end = appSrc.indexOf("$('#addAccBtn').onclick", start);
  assert.ok(start > -1 && end > start, 'blok handler delete harus ditemukan');
  const body = appSrc.slice(start, end);

  // deleteAccount menolak SEBELUM splice → daftar di layar masih benar, jadi
  // keluar tanpa menyentuh modal.
  assert.match(body, /try \{\s*removed = await wallet\.deleteAccount\(i, pw\);[\s\S]{0,400}return;/,
    'kegatal delete keluar lebih dulu, daftar tak di-render ulang');

  // Re-unlock punya try/catch SENDIRI supaya kegagalannya tidak memotong
  // refresh: index basi di modal terbuka = pindah akun mendarat di akun salah.
  assert.match(body, /if \(wasActive\) \{\s*try \{\s*const signer = await wallet\.unlockWallet\(/,
    're-unlock wajib dibungkus try/catch sendiri');
  assert.match(body, /catch \(e\) \{[\s\S]{0,700}set\('signer', null\);/,
    'signer akun yang sudah terhapus tidak boleh dipertahankan');

  const failPath = body.indexOf("set('unlocked', false);");
  const refresh = body.indexOf('showAccountModal();');
  const label = body.indexOf('syncHomeWalletName();');
  assert.ok(failPath > -1, 'jalur gagal harus ada');
  assert.ok(refresh > failPath, 'showAccountModal() tetap jalan SETELAH jalur gagal — tak ada index basi');
  assert.ok(label > failPath && label < refresh,
    'label home ikut diperbarui di jalur yang sama');
  assert.match(body, /toast\(`Removed \$\{name\}/, 'pesan sukses tetap diutarakan');
});

test('app: #homeWalletName ikut sinkron setelah akun dihapus (tanpa reload)', () => {
  // Satu penulis untuk dua pemicu: load dashboard dan delete dari switcher.
  assert.match(appSrc, /function syncHomeWalletName\(\)/,
    'helper satu-sumber untuk label home harus ada');
  const fnAt = appSrc.indexOf('function syncHomeWalletName()');
  const fnEnd = appSrc.indexOf('\n}', fnAt);
  const fn = appSrc.slice(fnAt, fnEnd);
  assert.match(fn, /wallet\.getActiveAccountIndex\(\)/, 'label = akun aktif, bukan teks statis');
  assert.match(fn, /acct\.name \|\| 'Account'/, 'nama yang sama dengan yang dipakai loadDashboard');
  assert.match(fn, /\$\('#homeWalletName'\)/, 'menulis ke #homeWalletName');
  // dipakai di loadDashboard…
  assert.match(appSrc, /syncHomeWalletName\(\);[\s\S]{0,400}if \(!soft\) assetList\.innerHTML = spinner/,
    'loadDashboard memanggil helper, bukan duplikat kodenya');
});

test('app: handler derive menampilkan penyebab sebenarnya, bukan "Wrong password"', () => {
  const start = appSrc.indexOf("$('#addAccBtn').onclick");
  const end = appSrc.indexOf("$('#exportBtn').onclick", start);
  assert.ok(start > -1 && end > start, 'handler derive harus ditemukan');
  const body = appSrc.slice(start, end);
  assert.match(body, /catch \(err\) \{[\s\S]{0,400}toast\(err\?\.message \|\| 'Could not add account', 'error'\)/,
    'pesan error dari wallet.deriveNextAccount harus diteruskan apa adanya');
  assert.doesNotMatch(body, /toast\('Wrong password'/,
    'wallet tanpa HD tree (import private key) bukan salah sandi');
  // dan wallet.js sendiri yang membedakan dua kasus itu
  const w = readFileSync(new URL('../js/wallet.js', import.meta.url), 'utf8');
  assert.match(w, /throw new Error\('Tambah akun hanya untuk seed-phrase wallet'\)/,
    'tipe non-HD diberi pesan yang benar');
  assert.match(w, /try \{\s*secret = await decryptData\(keystore, password\);\s*\} catch \{\s*throw new Error\('Wrong password'\)/,
    'salah sandi tetap dikatakan sebagai salah sandi');
});
