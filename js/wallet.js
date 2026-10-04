// ═══════════════════════════════════════════════════════════════
// Bear Tool — wallet.js
// Wallet management: create/import/encrypt/decrypt/derive/sign.
// Keys NEVER leave the browser. Encrypted keystore in localStorage.
// Original implementation — no copying.
// ═══════════════════════════════════════════════════════════════

const KEYSTORE_KEY = 'bear.keystore';
const ACCOUNTS_KEY = 'bear.accounts';
const ACTIVE_KEY = 'bear.activeAccount';
// Session secret lives in sessionStorage (per-tab): a page refresh keeps the
// wallet unlocked, closing the tab wipes it. The encrypted keystore in
// localStorage is the durable source of truth.
const SESSION_KEY = 'bear.session';

// PBKDF2 + AES-GCM encryption (Web Crypto API)
async function deriveKey(password, salt) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptData(plaintext, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const enc = new TextEncoder();
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(plaintext)
  );
  return {
    salt: Array.from(salt),
    iv: Array.from(iv),
    data: Array.from(new Uint8Array(cipher))
  };
}

export async function decryptData(payload, password) {
  const key = await deriveKey(password, new Uint8Array(payload.salt));
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(payload.iv) },
    key,
    new Uint8Array(payload.data)
  );
  return new TextDecoder().decode(plain);
}

// ── keystore ──
export function saveKeystore(keystore) {
  localStorage.setItem(KEYSTORE_KEY, JSON.stringify(keystore));
}

export function getKeystore() {
  try { return JSON.parse(localStorage.getItem(KEYSTORE_KEY)); }
  catch { return null; }
}

export function clearKeystore() {
  localStorage.removeItem(KEYSTORE_KEY);
  localStorage.removeItem(ACCOUNTS_KEY);
  localStorage.removeItem(ACTIVE_KEY);
}

// ── accounts ──
export function saveAccounts(accounts) {
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
}

export function getAccounts() {
  try { return JSON.parse(localStorage.getItem(ACCOUNTS_KEY) || '[]'); }
  catch { return []; }
}

export function setActiveAccount(index) {
  localStorage.setItem(ACTIVE_KEY, String(index));
}

export function getActiveAccountIndex() {
  return Number(localStorage.getItem(ACTIVE_KEY) || '0');
}

// ── create / import ──
// Wallet names are non-secret labels. Auto-naming walks "Wallet",
// "Wallet 1", "Wallet 2", … and skips anything already taken.
export function nextAccountName(accounts = [], base = 'Wallet') {
  const taken = new Set((accounts || []).map(a => (a?.name || '').trim().toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 1; i < 100000; i++) {
    const candidate = `${base} ${i}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${base} ${Date.now()}`;
}

export async function createWallet(password, name) {
  const wallet = ethers.Wallet.createRandom();
  const mnemonic = wallet.mnemonic.phrase;
  const keystore = await encryptData(mnemonic, password);
  saveKeystore(keystore);
  const label = (name || '').trim() || nextAccountName([]);
  const accounts = [{ address: wallet.address, path: "m/44'/60'/0'/0/0", name: label }];
  saveAccounts(accounts);
  setActiveAccount(0);
  return { address: wallet.address, mnemonic, name: label };
}

export async function importWallet(input, password, name) {
  let wallet;
  const trimmed = input.trim();
  if (trimmed.split(/\s+/).length >= 12) {
    // seed phrase
    wallet = ethers.Wallet.fromPhrase(trimmed);
  } else if (/^0x[a-fA-F0-9]{64}$/.test(trimmed)) {
    // private key
    wallet = new ethers.Wallet(trimmed);
  } else {
    throw new Error('Invalid input. Use a 12/24-word seed phrase or a private key (0x...).');
  }
  const keystore = await encryptData(trimmed, password);
  saveKeystore(keystore);
  const label = (name || '').trim() || nextAccountName([]);
  const accounts = [{ address: wallet.address, path: 'imported', name: label }];
  saveAccounts(accounts);
  setActiveAccount(0);
  return { address: wallet.address, name: label };
}

// unlock: decrypt keystore, return signer for active account
export async function unlockWallet(password, index) {
  const keystore = getKeystore();
  if (!keystore) throw new Error('No wallet found. Create or import one first.');
  const secret = await decryptData(keystore, password);
  return signerFromSecret(secret, index);
}

// unlock + return the decrypted secret so the caller can persist the session
export async function unlockSession(password, index) {
  const keystore = getKeystore();
  if (!keystore) throw new Error('No wallet found. Create or import one first.');
  const secret = await decryptData(keystore, password);
  return { signer: signerFromSecret(secret, index), secret };
}

// Derive a signer from a raw secret (seed phrase or key).
//
// `index` defaults to the active account, and is passed explicitly when a caller
// needs a signer for an account it has NOT switched to yet. That distinction is
// the whole point: deriving must not be a side effect of choosing. When the
// switcher set the active index first and asked for the password afterwards, a
// cancelled prompt or a typo left localStorage pointing at an account the topbar
// was still not showing — and the next unlock signed with it.
export function signerFromSecret(secret, index = getActiveAccountIndex()) {
  const idx = Number(index);
  const accounts = getAccounts();
  if (!accounts[idx]) throw new Error('Account not found.');
  let wallet;
  if (accounts[idx].path === 'imported') {
    // secret can be a private key (0x...) or a seed phrase (12/24 words)
    wallet = /^0x[a-fA-F0-9]{64}$/.test(secret)
      ? new ethers.Wallet(secret)
      : ethers.Wallet.fromPhrase(secret);
  } else {
    const hd = ethers.HDNodeWallet.fromPhrase(secret, undefined, "m/44'/60'/0'/0");
    // Derive at the index recorded in THIS account's path, never at its array
    // position: deleteAccount splices the list, and position-based derivation
    // would hand back a different key than the address shown beside it —
    // a signer that signs for the wrong wallet without saying so.
    const m = /\/(\d+)$/.exec(String(accounts[idx].path || ''));
    wallet = hd.derivePath(m ? m[1] : String(idx));
  }
  return wallet;
}

// ── session persistence (refresh keeps wallet unlocked) ──
// The secret is written to sessionStorage (per-tab, survives refresh) AND to
// localStorage with a timestamp. The localStorage copy lets a closed-and-
// reopened tab come back unlocked — but only within the auto-lock window
// (checked in app.js boot), so closing the tab can never leave the wallet
// unlocked forever. Lock / auto-lock clears both copies.
const SESSION_LS_KEY = 'bear.session.ls';
export function saveSession(secret) {
  try { sessionStorage.setItem(SESSION_KEY, secret); } catch { /* private mode */ }
  try { localStorage.setItem(SESSION_LS_KEY, JSON.stringify({ s: secret, ts: Date.now() })); } catch { /* private mode */ }
}
export function getSession() {
  try {
    const ss = sessionStorage.getItem(SESSION_KEY);
    if (ss) return ss;
  } catch { /* ignore */ }
  try {
    const ls = JSON.parse(localStorage.getItem(SESSION_LS_KEY) || 'null');
    if (ls && ls.s) return ls.s;
  } catch { /* ignore */ }
  return null;
}
// Timestamp of the localStorage copy (null when absent). Used by app.js boot
// to reject tab-reopen restores older than the auto-lock window.
export function getSessionTs() {
  try {
    const ls = JSON.parse(localStorage.getItem(SESSION_LS_KEY) || 'null');
    return ls && typeof ls.ts === 'number' ? ls.ts : null;
  } catch { return null; }
}
// True when the sessionStorage copy exists (a true refresh keeps it fresh).
export function hasSessionStorage() {
  try { return sessionStorage.getItem(SESSION_KEY) !== null; } catch { return false; }
}
export function clearSession() {
  try { sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
  try { localStorage.removeItem(SESSION_LS_KEY); } catch { /* ignore */ }
}

// derive additional account from seed
export async function deriveNextAccount(password, name) {
  const keystore = getKeystore();
  if (!keystore) throw new Error('No wallet found.');
  // A wrong password must SAY so: the caller shows err.message, and the bare
  // OperationError a decrypt failure produces says nothing a person can act on
  // (same contract deleteAccount already has).
  let secret;
  try {
    secret = await decryptData(keystore, password);
  } catch {
    throw new Error('Wrong password');
  }
  // Only a recovery phrase HAS an HD tree. A private-key import has none —
  // HDNodeWallet.fromPhrase would throw an unrelated "invalid phrase" error
  // that the caller used to report as "Wrong password", which sends the user
  // back to retype a password that was right all along.
  if (/^0x[a-fA-F0-9]{64}$/.test(String(secret).trim())) {
    throw new Error('Tambah akun hanya untuk seed-phrase wallet');
  }
  const accounts = getAccounts();
  // HD index = highest recorded path index + 1, NOT accounts.length:
  // deleteAccount splices the list, and deriving at `length` would collide
  // with a surviving entry (delete idx1 of [0,1,2] → [0,2], length 2 = the
  // index already stored on path .../2 → two entries, one key).
  const nextIdx = accounts.reduce((mx, a) => {
    const m = /\/(\d+)$/.exec(String(a?.path || ''));
    return m ? Math.max(mx, Number(m[1])) : mx;
  }, -1) + 1;
  const hd = ethers.HDNodeWallet.fromPhrase(secret, undefined, "m/44'/60'/0'/0");
  // …and a recorded path index is only a STARTING POINT. An imported phrase
  // stores path:'imported' — it contributes no index at all — while the phrase
  // itself IS m/44'/60'/0'/0/0, so nextIdx came out as 0 and the "new" account
  // was a twin of the imported one (repro: DUPLICATE true). Walk the index
  // forward until the derived address is not already on the list; bounded, so
  // a pathological list fails loudly instead of spinning forever.
  const taken = new Set(accounts.map((a) => String(a?.address || '').toLowerCase()));
  let idx = nextIdx;
  let derived = null;
  for (let guard = 0; guard < 1000; guard++) {
    const cand = hd.derivePath(String(idx));
    if (!taken.has(String(cand.address).toLowerCase())) { derived = cand; break; }
    idx += 1;
  }
  if (!derived) throw new Error('No free HD index — too many derived accounts');
  const path = `m/44'/60'/0'/0/${idx}`;
  const label = (name || '').trim() || nextAccountName(accounts);
  accounts.push({ address: derived.address, path, name: label });
  saveAccounts(accounts);
  return derived.address;
}

// Remove one account from the switcher (live request: "hapus wallet pilihan
// user"). Only the LIST entry goes away — the recovery phrase still controls
// the HD index, so nothing is destroyed, but the address stops being shown
// until it is derived again elsewhere. Password required: the same gate as
// switching, so a borrowed phone cannot empty the list. The wrong password
// rejects BEFORE anything is written (decrypt runs first), and the last
// remaining wallet can never be removed — an empty list bricks the app.
export async function deleteAccount(idx, password) {
  const i = Number(idx);
  const accounts = getAccounts();
  if (!accounts[i]) throw new Error('Account not found.');
  if (accounts.length <= 1) throw new Error('Cannot delete the last wallet.');
  const keystore = getKeystore();
  if (!keystore) throw new Error('No wallet found.');
  try {
    await decryptData(keystore, password);
  } catch {
    // crypto.subtle throws a bare OperationError; the caller deserves the
    // one word that tells them what to retype.
    throw new Error('Wrong password');
  }

  const removed = accounts.splice(i, 1)[0];
  saveAccounts(accounts);
  // Keep the stored active index pointing at the same ACCOUNT, not the same
  // number: entries after the deleted one shifted down by one.
  const act = getActiveAccountIndex();
  if (act > i) setActiveAccount(act - 1);
  else if (act === i) setActiveAccount(0);
  return removed;
}

// export secret (requires password)
export async function exportSecret(password) {
  const keystore = getKeystore();
  if (!keystore) throw new Error('No wallet found.');
  return decryptData(keystore, password);
}

// ── helpers ──
export function shortAddress(addr) {
  if (!addr) return '';
  return addr.slice(0, 6) + '…' + addr.slice(-4);
}

export function isValidAddress(addr) {
  try {
    ethers.getAddress(addr);
    return true;
  } catch { return false; }
}

// address poisoning detection: similar prefix/suffix
export function isSuspiciousSimilar(a, b) {
  if (!a || !b) return false;
  // Compare case-insensitively BEFORE deciding whether the two are the same
  // address. The equality check used to run on the raw strings, so an address
  // typed in a different case from the one already in the activity log was not
  // recognised as itself: it skipped the early return, then matched its own prefix
  // and suffix, and the guard reported the user's own wallet as poisoned. The
  // caller in send.js compares a stored lowercase address against whatever the
  // user typed, so this was reachable by pasting the same address back in — and a
  // warning that fires on your own address is how people learn to ignore warnings.
  const al = String(a).toLowerCase(), bl = String(b).toLowerCase();
  if (al === bl) return false;
  const prefix = 6, suffix = 4;
  return al.slice(0, prefix) === bl.slice(0, prefix) && al.slice(-suffix) === bl.slice(-suffix);
}