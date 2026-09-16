// ═══════════════════════════════════════════════════════════════
// Bear Tool — wallet.js
// Wallet management: create/import/encrypt/decrypt/derive/sign.
// Keys NEVER leave the browser. Encrypted keystore in localStorage.
// Original implementation — no copying.
// ═══════════════════════════════════════════════════════════════

const KEYSTORE_KEY = 'bear.keystore';
const ACCOUNTS_KEY = 'bear.accounts';
const ACTIVE_KEY = 'bear.activeAccount';

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
export async function createWallet(password) {
  const wallet = ethers.Wallet.createRandom();
  const mnemonic = wallet.mnemonic.phrase;
  const keystore = await encryptData(mnemonic, password);
  saveKeystore(keystore);
  const accounts = [{ address: wallet.address, path: "m/44'/60'/0'/0/0" }];
  saveAccounts(accounts);
  setActiveAccount(0);
  return { address: wallet.address, mnemonic };
}

export async function importWallet(input, password) {
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
  const accounts = [{ address: wallet.address, path: 'imported' }];
  saveAccounts(accounts);
  setActiveAccount(0);
  return { address: wallet.address };
}

// unlock: decrypt keystore, return signer for active account
export async function unlockWallet(password) {
  const keystore = getKeystore();
  if (!keystore) throw new Error('No wallet found. Create or import one first.');
  const secret = await decryptData(keystore, password);
  const idx = getActiveAccountIndex();
  const accounts = getAccounts();
  if (!accounts[idx]) throw new Error('Account not found.');
  let wallet;
  if (accounts[idx].path === 'imported') {
    wallet = new ethers.Wallet(secret);
  } else {
    const hd = ethers.HDNodeWallet.fromPhrase(secret, undefined, "m/44'/60'/0'/0");
    wallet = hd.derivePath(String(idx));
  }
  return wallet;
}

// derive additional account from seed
export async function deriveNextAccount(password) {
  const keystore = getKeystore();
  if (!keystore) throw new Error('No wallet found.');
  const secret = await decryptData(keystore, password);
  const accounts = getAccounts();
  const nextIdx = accounts.length;
  const hd = ethers.HDNodeWallet.fromPhrase(secret, undefined, "m/44'/60'/0'/0");
  const path = `m/44'/60'/0'/0/${nextIdx}`;
  const derived = hd.derivePath(String(nextIdx));
  accounts.push({ address: derived.address, path });
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