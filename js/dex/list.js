// Bear Tool — js/dex/list.js
// Deleting a coin from YOUR feed — for real.
//
// A coin on the chain cannot be deleted: the contract exists, the trades exist,
// the price is real. But the FEED is ours, and "delete" must mean delete. The
// old design hid a coin behind a "Hidden" tab and a "Restore all" button; the
// user (APK, 2026-10-15) called it what it was: "bener² hapus coin bukan hide
// coin". So:
//
//   • the coin leaves the local launched index (tokens.js forgetLaunchedToken)
//     — the app's own record of it is gone,
//   • a tombstone here keeps it gone: the chain scan is creator-scoped
//     (discover.js) and would otherwise re-find the Launched log and put the
//     coin back on the grid — a resurrection that reads as "delete didn't
//     work",
//   • nothing in the UI shows, restores or undoes it. The tombstone is an
//     implementation detail of permanence, not a surface.
//
// Per chain, like the launched-coin index: deleting a Sepolia coin must not
// delete a mainnet one in the same browser. Coins hidden under the old design
// (bear.dex.hidden.*) are read as deleted — they stay gone, which is what the
// user meant when they tapped that button back then too.

import { get, set } from '../state.js';
import { DEX_CHAIN_ID } from './core.js';

const DELETED_KEY = 'bear.dex.deleted';
const LEGACY_HIDDEN_KEY = 'bear.dex.hidden';

function storeKey(base) {
  return `${base}.${DEX_CHAIN_ID}`;
}

function readAddresses(base) {
  try {
    const raw = JSON.parse(localStorage.getItem(storeKey(base)) || '[]');
    if (!Array.isArray(raw)) return [];
    // Addresses only, lowercased. Anything else in storage is ignored rather
    // than trusted — this list is written from innerHTML-adjacent code, and a
    // stray object must not become a key we later compare against.
    return raw
      .filter((x) => typeof x === 'string' && /^0x[0-9a-fA-F]{40}$/.test(x))
      .map((x) => x.toLowerCase());
  } catch {
    return [];
  }
}

function write(list) {
  try {
    localStorage.setItem(storeKey(DELETED_KEY), JSON.stringify(list));
  } catch {
    // Private mode or a full quota. The in-memory mirror still serves this
    // session, so deleting works until reload — and says so rather than
    // pretending it persisted.
  }
  set('dex.deleted', list);
}

/**
 * Every address deleted on this chain: the current list, plus whatever the
 * pre-delete design called "hidden" — a coin the user chose to take out of the
 * feed stays out, under whichever name the storage used at the time.
 */
export function deletedCoins() {
  const fromState = Array.isArray(get('dex.deleted')) ? get('dex.deleted') : [];
  const union = [
    ...fromState,
    ...readAddresses(DELETED_KEY),
    ...readAddresses(LEGACY_HIDDEN_KEY),
  ].map((x) => String(x).toLowerCase());
  return [...new Set(union)];
}

/** True when this wallet has deleted the coin from its feed. */
export function isDeleted(address) {
  return deletedCoins().includes(String(address || '').toLowerCase());
}

/**
 * Delete a coin from this feed, permanently. Returns false when it was already
 * deleted, so a double click cannot add it twice.
 */
export function deleteCoin(address) {
  const a = String(address || '').toLowerCase();
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return false;
  const list = deletedCoins();
  if (list.includes(a)) return false;
  write([...list, a]);
  return true;
}

/**
 * The feed, minus what this wallet has deleted.
 *
 * Filtering lives here rather than in the view so the feed and the delete log
 * can never disagree about which coins are on screen. It is applied to coins
 * that came FROM the chain, so it can only ever remove things from a list that
 * was already real — it never invents entries.
 */
export function withoutDeleted(coins) {
  const gone = new Set(deletedCoins());
  return coins.filter((c) => !gone.has(String(c.address).toLowerCase()));
}
