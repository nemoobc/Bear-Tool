// Bear Tool — js/dex/holders.js
// Who holds a coin — read from the chain's own Transfer logs, or not claimed.
//
// An ERC-20 never stores a holder list: a balance is the sum of every Transfer
// that has ever touched an address. So "who holds this" is a LOG SCAN, and how
// far back a node is willing to serve logs is a hard fact of the node — public
// testnet nodes prune old ranges (benchmarked on Sepolia: ~10k blocks, JSON-RPC
// error "pruned history unavailable"). A scan that ignored that and summed a
// truncated window would print a holder list that is simply wrong — the exact
// lie this card exists to prevent.
//
// So the scanner goes BACKWARD in fixed chunks, saves its progress per token,
// and calls a list complete in ONE case only: it has seen the mint that created
// the supply AND the balances add up to totalSupply() with no negative pocket.
// Anything less is said out loud — still scanning, node pruned the history, or
// a read failed. The card never invents numbers to fill the space.
//
// The same discipline covers the 24h tape: Swap logs of the last day folded
// into one quote volume and a trade count, with `ok:false` whenever the node
// could not serve the window — a zero must never mean "could not look".

import { DEX_CHAIN_ID } from './core.js';

// Benchmarked, not guessed: a Sepolia public node accepted 10,001-block ranges
// and refused 11,000+ with "pruned history unavailable"; 9k sits on the safe
// side of every cap seen, including the 10k ranges MetaMask-class RPCs allow.
export const HOLDER_CHUNK = 9000;
export const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

export function transferTopic(E) {
  return E.id('Transfer(address,address,uint256)');
}

// ── folding logs into balances ───────────────────────────────────────

/** Apply one decoded Transfer to the balance map. The 0x0 side of a mint/burn
 *  only moves one leg; the map keeps RAW signed sums, so a missed chunk shows
 *  up as a negative pocket instead of a silently small balance. */
export function applyTransfer(balances, from, to, value) {
  const v = BigInt(value);
  const f = String(from || '').toLowerCase();
  const t = String(to || '').toLowerCase();
  if (f && f !== ZERO_ADDR) balances.set(f, (balances.get(f) || 0n) - v);
  if (t && t !== ZERO_ADDR) balances.set(t, (balances.get(t) || 0n) + v);
  return balances;
}

/** One raw log → banance delta, or an honest `ok:false` for a log that does
 *  not decode (an unreadable log makes every downstream number a guess). */
export function foldTransferLog(E, balances, log) {
  try {
    const from = E.getAddress('0x' + String(log.topics?.[1] || '').slice(-40));
    const to = E.getAddress('0x' + String(log.topics?.[2] || '').slice(-40));
    const [raw] = E.AbiCoder.defaultAbiCoder().decode(['uint256'], log.data);
    const v = BigInt(raw);
    applyTransfer(balances, from, to, v);
    return { ok: true, mint: from.toLowerCase() === ZERO_ADDR, value: v };
  } catch {
    return { ok: false };
  }
}

export function aggregateTransfers(E, logs, balances = new Map()) {
  const state = { balances, mintSeen: false, mintSum: 0n, bad: 0 };
  for (const log of logs) {
    const r = foldTransferLog(E, balances, log);
    if (!r.ok) { state.bad += 1; continue; }
    if (r.mint) { state.mintSeen = true; state.mintSum += r.value; }
  }
  return state;
}

export function sumOf(balances) {
  let s = 0n;
  for (const v of balances.values()) s += v;
  return s;
}

export function hasNegative(balances) {
  for (const v of balances.values()) if (v < 0n) return true;
  return false;
}

/**
 * Can a holder list be claimed from this state? Only with the mint seen, every
 * log readable, no negative pocket, and the sums landing exactly on supply.
 * Each of those fails in a different way when a scan is not whole — this is
 * the one gate that keeps a partial window from becoming fake balances.
 */
export function isComplete({ balances, mintSeen, bad = 0, supply } = {}) {
  if (!balances || !mintSeen || bad > 0) return false;
  if (hasNegative(balances)) return false;
  return sumOf(balances) === BigInt(supply ?? -1);
}

// ── the visible list ─────────────────────────────────────────────────

/**
 * The holder rows, biggest first. `exclude` drops the pool itself (liquidity
 * is not a holder) and the zero address; addresses at zero net balance are not
 * holders either. `count` is the true size of the set the rows are cut from.
 */
export function holderRows(balances, supply, { limit = 50, exclude = [] } = {}) {
  const total = BigInt(supply ?? 0);
  const skip = new Set(exclude.map((a) => String(a || '').toLowerCase()));
  const rows = [];
  for (const [addr, amount] of balances) {
    if (amount <= 0n || skip.has(addr)) continue;
    rows.push({ addr, amount, pctBps: total > 0n ? Number((amount * 10000n) / total) : 0 });
  }
  rows.sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : a.addr < b.addr ? -1 : 1));
  return { rows: rows.slice(0, limit), count: rows.length };
}

/** Share of supply held by the top `top` holders, in bps (same set as above). */
export function topShareBps(balances, supply, { top = 10, exclude = [] } = {}) {
  const total = BigInt(supply ?? 0);
  if (total <= 0n) return 0;
  const { rows } = holderRows(balances, supply, { limit: top, exclude });
  let s = 0n;
  for (const r of rows) s += r.amount;
  return Number((s * 10000n) / total);
}

// ── node facts: prune detection, chunk walking ───────────────────────

/** A node that no longer keeps old ranges says so — code 4444 on public
 *  Sepolia nodes, a "pruned history" message on others. */
export function isPrunedError(e) {
  if (!e) return false;
  const info = (e.info && e.info.error) || (e.error && e.error.error) || {};
  if (Number(info.code) === 4444) return true;
  const msg = String((e.shortMessage || e.message || e) + ' ' + String(info.message || ''));
  return /pruned|history\s+(unavailable|not available)/i.test(msg);
}

/**
 * getLogs over a range a single call cannot carry: walks backward in chunks,
 * halving the chunk ONCE per failing range when a node turns out to cap
 * ranges tighter than the default (a range cap is not a prune — asking for
 * less is the fix). `stopAfter` lets sparse lookups (one factory event) quit
 * as soon as they have what they came for.
 */
export async function chunkedGetLogs({ getLogs, fromBlock, toBlock, chunk = HOLDER_CHUNK, stopAfter = 0 } = {}) {
  if (typeof getLogs !== 'function' || !(toBlock >= fromBlock)) return [];
  const out = [];
  let to = toBlock;
  let c = Math.max(1, chunk);
  while (to >= fromBlock) {
    const lo = Math.max(fromBlock, to - c);
    let logs;
    try {
      logs = await getLogs(lo, to);
    } catch (e) {
      if (c > 1000 && !isPrunedError(e)) { c = Math.max(1000, Math.floor(c / 2)); continue; }
      throw e;
    }
    if (logs && logs.length) out.push(...logs);
    if (stopAfter && out.length >= stopAfter) break;
    // The range is exhausted when the low edge reaches the floor: walking
    // again would ask for the SAME window forever (a micro-task spin that
    // never lets the event loop breathe — caught by the pool24h unit test).
    if (lo <= fromBlock) break;
    to = lo;
  }
  return out;
}

// ── per-token progress cache ─────────────────────────────────────────

export function holderCacheKey(token, chainId = DEX_CHAIN_ID) {
  return `bear.dex.holders.${chainId}.${String(token || '').toLowerCase()}`;
}

export function defaultHolderCache() {
  try {
    return typeof localStorage !== 'undefined' && localStorage ? localStorage : null;
  } catch {
    return null;
  }
}

function readCache(cache, key) {
  if (!cache || typeof cache.getItem !== 'function') return null;
  try {
    const raw = JSON.parse(cache.getItem(key) || 'null');
    if (!raw || raw.v !== 1 || typeof raw.balances !== 'object') return null;
    const balances = new Map();
    for (const [a, v] of Object.entries(raw.balances || {})) {
      try { balances.set(a, BigInt(v)); } catch { /* a torn entry is dropped, not fatal */ }
    }
    return { low: Math.max(0, Number(raw.low) || 0), mintSeen: !!raw.mintSeen, bad: Number(raw.bad) || 0, balances };
  } catch {
    return null; // a corrupt cache is no cache — the scan simply starts over
  }
}

function writeCache(cache, key, state) {
  if (!cache || typeof cache.setItem !== 'function') return;
  try {
    const balances = {};
    for (const [a, v] of state.balances) if (v !== 0n) balances[a] = v.toString();
    cache.setItem(key, JSON.stringify({ v: 1, low: state.low, mintSeen: state.mintSeen, bad: state.bad, balances }));
  } catch {
    // Quota / private mode: the scan still works for this session — it just
    // will not resume after a reload, and the numbers shown will be whatever
    // this session proved, never more.
  }
}

// ── the scan driver ──────────────────────────────────────────────────

/**
 * Walk a token's Transfer history backward until the mint that created the
 * supply is in the window, resuming from the per-token cache. `passes` bounds
 * one visit (12 chunks ≈ 108k blocks ≈ two weeks of Sepolia); a scan that is
 * still short says so and offers the next pass instead of faking a finish.
 *
 * Returns { ok, done, pruned, reason, balances, mintSeen, bad, low, chunks }.
 * `done:true` is the ONLY state allowed to render balances — it means the
 * evidence is whole, not that the scan happened to stop.
 */
export async function scanHolders({
  E, provider, token, chunk = HOLDER_CHUNK, passes = 12,
  cache = defaultHolderCache(), supply = null, shouldStop = null, onProgress = null,
} = {}) {
  const out = { ok: false, done: false, pruned: false, reason: '', balances: new Map(), mintSeen: false, bad: 0, low: 0, chunks: 0 };
  if (!E || !provider || !token) { out.reason = 'no-reader'; return out; }

  let state;
  try {
    const key = holderCacheKey(token);
    state = readCache(cache, key) || { low: 0, mintSeen: false, bad: 0, balances: new Map() };
    if (!state.low) state.low = await provider.getBlockNumber();
    const topic = transferTopic(E);
    let used = 0;
    let c = chunk;
    while (used < passes && state.low > 0 && !(state.mintSeen && state.bad === 0)) {
      if (shouldStop && shouldStop()) { out.stopped = true; break; }
      const hi = state.low;
      const lo = Math.max(0, hi - c);
      let logs;
      try {
        logs = await provider.getLogs({ address: token, fromBlock: lo, toBlock: hi, topics: [topic] });
      } catch (e) {
        if (isPrunedError(e)) { out.pruned = true; out.reason = String((e && (e.shortMessage || e.message)) || e); break; }
        if (c > 1000) { c = Math.max(1000, Math.floor(c / 2)); continue; } // range cap, not prune
        out.reason = String((e && (e.shortMessage || e.message)) || e);
        break;
      }
      const r = aggregateTransfers(E, logs, state.balances);
      if (r.bad) state.bad += r.bad;
      if (r.mintSeen) state.mintSeen = true;
      state.low = lo;
      used += 1;
      if (onProgress) onProgress({ low: lo, used, mintSeen: state.mintSeen });
      writeCache(cache, key, state);
    }
    writeCache(cache, key, state);
    out.balances = state.balances;
    out.mintSeen = state.mintSeen;
    out.bad = state.bad;
    out.low = state.low;
    out.chunks = used;
    out.ok = !out.pruned && !out.reason;
    out.done = supply != null && out.ok && isComplete({ balances: state.balances, mintSeen: state.mintSeen, bad: state.bad, supply });
    return out;
  } catch (e) {
    out.reason = String((e && (e.shortMessage || e.message)) || e);
    return out;
  }
}

// ── the last day of trades ───────────────────────────────────────────

/**
 * The pair's last-`blocks` Swap logs folded into quote volume + trade count.
 * Reads through the same chunk walker, so a node with a tighter range cap
 * still answers. `ok:false` (with reason) whenever the read failed — callers
 * must show nothing for `!ok`, because "0 trades" and "could not look" are
 * different sentences.
 */
export async function pool24h({ E, provider, pair, blocks = 7200, chunk = HOLDER_CHUNK, shouldStop = null } = {}) {
  const out = { ok: false, reason: '', volQuote: 0n, trades: 0, from: 0, to: 0 };
  if (!E || !provider || !pair) { out.reason = 'no-reader'; return out; }
  try {
    const latest = await provider.getBlockNumber();
    const from = Math.max(0, latest - blocks);
    const topic = E.id('Swap(address,bool,uint256,uint256)');
    const coder = E.AbiCoder.defaultAbiCoder();
    const logs = await chunkedGetLogs({
      getLogs: (lo, hi) => provider.getLogs({ address: pair, fromBlock: lo, toBlock: hi, topics: [topic] }),
      fromBlock: from,
      toBlock: latest,
      chunk,
    });
    // A caller that left the page must not keep painting volumes at a screen
    // that is gone — but the sums it already read are still real, so they ride.
    if (shouldStop && shouldStop()) { out.stopped = true; }
    for (const log of logs) {
      const [quoteIn, amountIn, amountOut] = coder.decode(['bool', 'uint256', 'uint256'], log.data);
      out.volQuote += BigInt(quoteIn ? amountIn : amountOut);
      out.trades += 1;
    }
    out.ok = true;
    out.from = from;
    out.to = latest;
  } catch (e) {
    out.reason = String((e && (e.shortMessage || e.message)) || e);
  }
  return out;
}
