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
export async function unlockWallet(password) {
  const keystore = getKeystore();
  if (!keystore) throw new Error('No wallet found. Create or import one first.');
  const secret = await decryptData(keystore, password);
  return signerFromSecret(secret);
}

// unlock + return the decrypted secret so the caller can persist the session
export async function unlockSession(password) {
  const keystore = getKeystore();
  if (!keystore) throw new Error('No wallet found. Create or import one first.');
  const secret = await decryptData(keystore, password);
  return { signer: signerFromSecret(secret), secret };
}

// derive the active-account signer from a raw secret (seed phrase or key)
export function signerFromSecret(secret) {
  const idx = getActiveAccountIndex();
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
    wallet = hd.derivePath(String(idx));
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
  const secret = await decryptData(keystore, password);
  const accounts = getAccounts();
  const nextIdx = accounts.length;
  const hd = ethers.HDNodeWallet.fromPhrase(secret, undefined, "m/44'/60'/0'/0");
  const path = `m/44'/60'/0'/0/${nextIdx}`;
  const derived = hd.derivePath(String(nextIdx));
  const label = (name || '').trim() || nextAccountName(accounts);
  accounts.push({ address: derived.address, path, name: label });
  saveAccounts(accounts);
  return derived.address;
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
  if (!a || !b || a === b) return false;
  const al = a.toLowerCase(), bl = b.toLowerCase();
  const prefix = 6, suffix = 4;
  return al.slice(0, prefix) === bl.slice(0, prefix) && al.slice(-suffix) === bl.slice(-suffix);
}