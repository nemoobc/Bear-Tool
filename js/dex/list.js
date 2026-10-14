// Bear Tool — js/dex/list.js
// Delisting: hiding a coin from YOUR feed.
//
// A coin on the chain cannot be deleted — the contract exists, the trades exist,
// the price is real. So "delist" here means exactly what it can honestly mean:
// stop showing it to you. Nothing is hidden from anyone else, and nothing is
// hidden permanently, because the chain is not ours to edit.
//
// That distinction is the whole design. A delist button that claimed to remove a
// coin, or that was impossible to undo, would be a lie with a button on it.
//
// Per chain, like the launched-coin index: hiding a Sepolia coin must not hide a
// mainnet one in the same browser.

import { get, set } from '../state.js';
import { DEX_CHAIN_ID } from './core.js';

const HIDDEN_KEY = 'bear.dex.hidden';

function storeKey() {
  return `${HIDDEN_KEY}.${DEX_CHAIN_ID}`;
}

function read() {
  try {
    const raw = JSON.parse(localStorage.getItem(storeKey()) || '[]');
    if (!Array.isArray(raw)) return [];
    // Addresses only, lowercased. Anything else in storage is ignored rather than
    // trusted — this list is written from innerHTML-adjacent code, and a stray
    // object must not become a key we later compare against.
    return raw
      .filter((x) => typeof x === 'string' && /^0x[0-9a-fA-F]{40}$/.test(x))
      .map((x) => x.toLowerCase());
  } catch {
    return [];
  }
}

function write(list) {
  try {
    localStorage.setItem(storeKey(), JSON.stringify(list));
  } catch {
    // Private mode or a full quota. The in-memory mirror still serves this
    // session, so hiding works until reload — and says so rather than pretending
    // it persisted.
  }
  set('dex.hidden', list);
}

/** Every address hidden on this chain. */
export function hiddenCoins() {
  const fromStore = read();
  const fromState = Array.isArray(get('dex.hidden')) ? get('dex.hidden') : [];
  return [...new Set([...fromState, ...fromStore].map((x) => String(x).toLowerCase()))];
}

export function isHidden(address) {
  return hiddenCoins().includes(String(address || '').toLowerCase());
}

/**
 * Hide a coin from this feed. Returns false when it was already hidden, so a
 * double click cannot add it twice.
 */
export function hideCoin(address) {
  const a = String(address || '').toLowerCase();
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return false;
  const list = hiddenCoins();
  if (list.includes(a)) return false;
  write([...list, a]);
  return true;
}

/** Bring a coin back. Returns false when it was not hidden. */
export function unhideCoin(address) {
  const a = String(address || '').toLowerCase();
  const list = hiddenCoins();
  if (!list.includes(a)) return false;
  write(list.filter((x) => x !== a));
  return true;
}

export function hiddenCount() {
  return hiddenCoins().length;
}

/** Drop every hidden coin on this chain. */
export function unhideAll() {
  write([]);
}

/**
 * The feed, minus what this wallet has delisted.
 *
 * Filtering lives here rather than in the view so the feed and the hidden count
 * can never disagree about which coins are on screen.
 */
export function withoutHidden(coins) {
  const hidden = new Set(hiddenCoins());
  return coins.filter((c) => !hidden.has(String(c.address).toLowerCase()));
}
