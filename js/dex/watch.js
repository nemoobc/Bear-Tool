// Bear Tool — js/dex/watch.js
// The watchlist, and the watcher that guards it.
//
// A watch is ONE thing this browser chose to keep an eye on: an address and a
// ticker. It is stored per chain (a watch made on Sepolia must not leak onto
// mainnet), and it stores no price — the price is read from the pair on every
// tick, so a stored entry can never show a stale price.
//
// The watcher is honest about what it is: it runs only while the app is open
// (there is no backend and no background push, and the copy says so), it
// checks at most WATCH_MAX coins a tick, and a coin that cannot be read this
// tick is skipped — a failed read is not a price, and it must never alert.
//
// An alert is a MOVE, never a price: the seen map keeps the last alerted ratio
// per coin, and only a move past WATCH_MOVE_BPS since that ratio — after
// WATCH_COOLDOWN_MS of quiet — rings the bell. The first sighting establishes
// the baseline silently; the bell only rings when there is a real change.
import { t, isAddr, provider, ethersLib, dexChainOk, toast, DEX_CHAIN_ID } from './core.js';
import { poolState } from './pool-data.js';
import { BEAR_FACTORY_ABI } from './bear-source.js';
import { factoryAddress } from './factory.js';

export const WATCH_MAX = 24;
export const WATCH_MOVE_BPS = 1000; // 10% — the move that deserves a word
export const WATCH_COOLDOWN_MS = 10 * 60_000; // after a bell: at most one per coin per 10 min
export const WATCH_TICK_MS = 60_000;

const watchKey = () => `bear.dex.watch.${DEX_CHAIN_ID}`;
const seenKey = () => `bear.dex.watchseen.${DEX_CHAIN_ID}`;

// ── pure ───────────────────────────────────────────────────────

/** Whatever is in storage, reduced to watchers that can be trusted: a 0x
 *  address and a short ticker. Junk is dropped, duplicates collapse, order is
 *  kept. Nothing here reads a price. */
export function parseWatch(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const x of raw) {
    const a = x && typeof x.address === 'string' ? x.address.toLowerCase() : '';
    if (!isAddr(a) || out.some((e) => e.address === a)) continue;
    out.push({ address: a, symbol: x.symbol ? String(x.symbol).slice(0, 16) : '' });
    if (out.length >= WATCH_MAX) break;
  }
  return out;
}

/** Toggle, purely: same list in, a new list out. null means "full" — refusing
 *  is the honest answer, and the caller says it out loud. Newest first, so a
 *  fresh star is visible at the top of its own list. */
export function nextWatch(list, address, symbol) {
  const a = String(address || '').toLowerCase();
  if (!isAddr(a)) return list;
  if (list.some((e) => e.address === a)) return list.filter((e) => e.address !== a);
  if (list.length >= WATCH_MAX) return null;
  return [{ address: a, symbol: symbol ? String(symbol).slice(0, 16) : '' }, ...list];
}

/** The one decision that rings the bell: a move of at least WATCH_MOVE_BPS
 *  since the last alerted ratio, and not inside the cooldown. A ratio that is
 *  not a positive number makes no claim — null, and the caller skips. */
export function alertFor(prev, next, lastAt, now) {
  if (!Number.isFinite(prev) || !Number.isFinite(next) || prev <= 0 || next <= 0) return null;
  if (!Number.isFinite(lastAt) || now - lastAt < WATCH_COOLDOWN_MS) return null;
  const move = (next - prev) / prev;
  const bps = Math.round(Math.abs(move) * 10_000);
  if (bps < WATCH_MOVE_BPS) return null;
  return { dir: move > 0 ? 'up' : 'down', bps };
}

// ── storage ────────────────────────────────────────────────────

function readJSON(key, dflt) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || 'null');
    return v == null ? dflt : v;
  } catch {
    return dflt;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode / quota: the session keeps working, the list just will not
    // survive a reload — the same bargain the launched index makes.
  }
}

export function watchList() {
  return parseWatch(readJSON(watchKey(), []));
}

export function isWatched(address) {
  const a = String(address || '').toLowerCase();
  return watchList().some((e) => e.address === a);
}

/** Toggle and persist. true = now watching, false = stopped, null = full
 *  (nothing changed). Stopping a watch also drops its baseline: a future
 *  re-watch starts clean instead of waking up to a stale move. */
export function toggleWatch(address, symbol) {
  const next = nextWatch(watchList(), address, symbol);
  if (next === null) return null;
  const a = String(address || '').toLowerCase();
  const watched = next.some((e) => e.address === a);
  writeJSON(watchKey(), next);
  if (!watched) {
    const seen = readJSON(seenKey(), {});
    delete seen[a];
    writeJSON(seenKey(), seen);
  }
  return watched;
}

// ── reads ──────────────────────────────────────────────────────

/** The factory pair for a token — the same read the token page's poolOf
 *  makes, kept local so watch.js stays below both tokens.js and token-page.js
 *  (a shared import would close a cycle). Never guesses, never throws. */
export async function pairOf(address) {
  if (!isAddr(address) || !dexChainOk()) return null;
  const f = factoryAddress();
  const E = ethersLib();
  const p = provider();
  if (!isAddr(f) || !E || !p) return null;
  try {
    const c = new E.Contract(f, BEAR_FACTORY_ABI, p);
    const pair = await c.pairFor(address);
    return isAddr(pair) && pair !== '0x0000000000000000000000000000000000000000' ? pair : null;
  } catch {
    return null;
  }
}

function ratioOf(ps) {
  if (!ps || !ps.ok) return null;
  const q = Number(ps.quoteReserve);
  const tr = Number(ps.tokenReserve);
  return q > 0 && tr > 0 ? q / tr : null;
}

const shortAddr = (a) => `${String(a).slice(0, 6)}…${String(a).slice(-4)}`;

/** One pass over the watchlist. Reads each coin's pair, compares the ratio
 *  with its last alerted baseline, rings at most one bell per coin. Returns
 *  what it did so a caller (or a test) can see it without screen-reading. */
export async function sweepWatches({ now = Date.now(), notify = true } = {}) {
  const list = watchList();
  if (!list.length) return { checked: 0, alerts: 0 };
  const seen = readJSON(seenKey(), {});
  let alerts = 0;

  await Promise.all(list.map(async (w) => {
    let ratio = null;
    try {
      const pair = await pairOf(w.address);
      ratio = pair ? ratioOf(await poolState(pair)) : null;
    } catch {
      ratio = null;
    }
    if (ratio == null) return; // cannot read → no price, no claim, no bell
    const s = seen[w.address];
    if (!s || !Number.isFinite(s.r) || s.r <= 0) {
      seen[w.address] = { r: ratio, at: 0 }; // first sighting: baseline, quietly
      return;
    }
    const hit = alertFor(s.r, ratio, s.at, now);
    if (!hit) return;
    alerts += 1;
    seen[w.address] = { r: ratio, at: now }; // the new baseline is the price the bell named
    if (!notify) return;
    toast(t('dex.watch.moved', {
      sym: w.symbol || shortAddr(w.address),
      dir: t(hit.dir === 'up' ? 'dex.watch.dirUp' : 'dex.watch.dirDown'),
      pct: (hit.bps / 100).toFixed(1),
    }));
  }));

  writeJSON(seenKey(), seen);
  return { checked: list.length, alerts };
}

// ── the clock ──────────────────────────────────────────────────

// Started once per session (ensureWatcher is idempotent), only when there is
// a provider to read through: an interval that can never do useful work is
// one more timer the tab (or a test runner) holds open. The tick itself
// re-checks the guards, so a backgrounded page skips its pass instead of
// spending battery on reads nobody will see.
let timer = null;

export function ensureWatcher() {
  if (timer) return;
  if (!dexChainOk() || !provider()) return;
  timer = setInterval(() => {
    if (typeof document !== 'undefined' && document.hidden) return;
    sweepWatches().catch(() => {});
  }, WATCH_TICK_MS);
  // Node test runners: a live interval would hold the process open.
  if (typeof timer === 'object' && timer && typeof timer.unref === 'function') timer.unref();
}

export function stopWatcher() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
