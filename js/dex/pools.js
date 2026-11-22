// ═══════════════════════════════════════════════════════════════
// Bear Tool — js/dex/pools.js (Dex v2) — discovery + liquidity math.
//
// Milestone 4: pool discovery through the factory's Launched events (the
// chain is the registry — the UI never invents a pool) and the liquidity
// math the UI shows BEFORE a tx commits. The previews mirror BearPair's own
// rules statement for statement (the seeded exit uses the contract's
// iterative sqrt; ratio entries take the MIN of the two floor divisions —
// an uneven deposit can never mint value, only donate).
//
// Pure data: no DOM here, no renders — the pool card lives in index.js, the
// tests call everything in this file directly with stub providers.
// ═══════════════════════════════════════════════════════════════

const { ethers } = globalThis;

import { BEAR_FACTORY_ABI } from './abi.js';
import { BEAR_PAIR_ABI, isAddress, tokenContract, pairContract } from './swap.js';

const FACTORY_I = new ethers.Interface(BEAR_FACTORY_ABI);
const PAIR_I = new ethers.Interface(BEAR_PAIR_ABI);

/** The factory contract bound for reads (provider-like). */
export function factoryContract(factoryAddress, providerLike) {
  if (!isAddress(factoryAddress)) {
    const e = new Error('dex/pools: not-an-address'); e.why = 'bad'; throw e;
  }
  return new ethers.Contract(factoryAddress, BEAR_FACTORY_ABI, providerLike);
}

/** One Launched log → plain row. Shared by the scanner and the launch receipt. */
export function decodeLaunched(log) {
  if (!Array.isArray(log?.topics) || !log.topics.length) return null;
  const desc = FACTORY_I.parseLog({ topics: log.topics, data: log.data });
  if (!desc) return null;
  const ev = desc.args;
  return {
    token: String(ev.token).toLowerCase(),
    pair: String(ev.pair).toLowerCase(),
    launcher: String(ev.launcher).toLowerCase(),
    creatorFeeBps: Number(ev.creatorFeeBps),
    // 0 = no lock. uint64 fits Number until year 356T; this row is a date.
    lockUntil: Number(ev.lpLockUntil),
    lpShares: BigInt(ev.lpShares),
  };
}

/**
 * One scanned pool row straight out of the Launched event: the addresses are
 * event data, everything else (reserves, symbols, my shares) is read live
 * right before it is shown.
 */
// A scan from genesis is the slowest thing the DEX card does: the pool list
// asked the RPC for every Launched log since block 0 on every open, and a
// public RPC answers that in seconds — or stalls. The scan remembers where it
// stopped per chain+factory, so the second open only asks for the new blocks.
const SCAN_CACHE_PREFIX = 'bear.dex.scan.';
const REORG_OVERLAP = 12; // a shallow reorg re-reads the tail instead of trusting it

export function scanCacheKey(chainId, factoryAddress) {
  return `${SCAN_CACHE_PREFIX}${chainId}.${String(factoryAddress).toLowerCase()}`;
}

/** Old rows first, new rows win per token: an overlap block is not a dupe. */
export function mergeScanRows(oldRows, newRows) {
  const byToken = new Map();
  for (const row of [...(oldRows || []), ...(newRows || [])]) {
    if (row?.token) byToken.set(String(row.token).toLowerCase(), row);
  }
  return [...byToken.values()];
}

function readScanCache(key) {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (!Number.isFinite(saved?.block) || !Array.isArray(saved?.pools)) return null;
    return {
      block: saved.block,
      pools: saved.pools.map((r) => ({ ...r, lpShares: BigInt(r.lpShares ?? 0) })),
    };
  } catch { return null; }
}

function writeScanCache(key, block, pools) {
  try {
    // lpShares is a BigInt; JSON has no BigInt. The row travels as a string
    // and comes back as one, the same flattening launch memory already uses.
    globalThis.localStorage?.setItem(key, JSON.stringify({
      block,
      pools: pools.map((r) => ({ ...r, lpShares: String(r.lpShares ?? 0n) })),
    }));
  } catch { /* private mode / quota — the scan still answers, just slower */ }
}

/** The chain decides the cache key; a provider without getNetwork gets none. */
async function scanChainId(providerLike) {
  try {
    const net = await providerLike?.getNetwork?.();
    const id = Number(net?.chainId);
    return Number.isFinite(id) ? id : null;
  } catch { return null; }
}

export async function scanFactory(providerLike, factoryAddress) {
  const factory = factoryContract(factoryAddress, providerLike);
  // An address without code would play factory by throwing at the first
  // read; say it plainly instead (the user pasted the wrong box).
  const code = providerLike.getCode ? await providerLike.getCode(factoryAddress) : undefined;
  if (typeof code === 'string' && code.replace(/^0x/, '') === '') {
    const e = new Error('dex/pools: not-a-contract'); e.why = 'contract'; throw e;
  }
  const chainId = await scanChainId(providerLike);
  const cacheKey = chainId == null ? '' : scanCacheKey(chainId, factoryAddress);
  const cached = cacheKey ? readScanCache(cacheKey) : null;
  let latest = null;
  try { latest = await providerLike.getBlockNumber?.(); } catch { latest = null; }
  if (!Number.isFinite(latest)) latest = null;

  // A cached height ABOVE the chain (fork restarted, RPC swapped) describes
  // pools this chain never had: drop it and scan honestly from zero.
  const usable = cached && latest != null && cached.block <= latest;
  const fromBlock = usable ? Math.max(0, cached.block - REORG_OVERLAP) : 0;
  const oldRows = usable ? cached.pools : [];

  const [quote, logs] = await Promise.all([
    factory.quote(),
    factory.queryFilter(factory.filters.Launched(), fromBlock, 'latest'),
  ]);
  const pools = mergeScanRows(oldRows, logs.map(decodeLaunched).filter(Boolean));
  if (cacheKey && latest != null) writeScanCache(cacheKey, latest, pools);
  return {
    factory: factoryAddress.toLowerCase(),
    quote: String(quote).toLowerCase(),
    pools,
  };
}

/**
 * The live mirror of one pool row: names, decimals, reserves, my shares.
 * `quoteAddress` comes from the scan (one factory = one quote, forever).
 */
export async function poolState(providerLike, row, quoteAddress, me) {
  const token = tokenContract(row.token, providerLike);
  const [tokSym, tokDec] = await Promise.all([token.symbol(), token.decimals()]);
  const quote = tokenContract(quoteAddress, providerLike);
  const [qSym, qDec] = await Promise.all([quote.symbol(), quote.decimals()]);
  const pairC = pairContract(row.pair, providerLike);
  const [[rQ, rT], sup, sharesBal, locked, bps] = await Promise.all([
    pairC.reserves(),
    pairC.totalSupply(),
    me ? pairC.balanceOf(me) : Promise.resolve(0n),
    me ? pairC.lockOf(me) : Promise.resolve(0n),
    pairC.creatorFeeBps(),
  ]);
  return {
    ...row,
    token: { address: row.token, symbol: tokSym, decimals: Number(tokDec) },
    quote: { address: String(quoteAddress).toLowerCase(), symbol: qSym, decimals: Number(qDec) },
    reserves: [BigInt(rQ), BigInt(rT)],
    totalSupply: BigInt(sup),
    myShares: BigInt(sharesBal),
    lockUntil: Number(locked),
    creatorBps: Number(bps),
  };
}

// ── the math, mirror of BearPair ────────────────────────────────────────

/**
 * BearPair's own sqrt (iterative Newton) — copied loop for loop so a seeded
 * preview never shows one wei the contract would not mint.
 */
export function sqrt(x) {
  if (x < 0n) throw new Error('dex/pools: sqrt-neg');
  if (x === 0n) return 0n;
  let r = x;
  let z = (x + 1n) / 2n;
  while (z < r) {
    r = z;
    z = (x / z + z) / 2n;
  }
  return r;
}

/**
 * Shares the pair would mint for (quoteAmt, tokenAmt) on pool state st
 * ({reserves:[rQ,rT], totalSupply}), contract line for line:
 * - seeded pool (supply 0): made = sqrt((rQ0+quoteAmt) * (rT0+tokenAmt));
 * - after that: MIN of the two half-ratio floors — a lopsided deposit only
 *   donates to the pool, never mints value out of it.
 * `lopsided` is true only when the slack leg sits more than 0.01% above the
 * mint (a real donation), so a 1-wei floor cut never cries wolf.
 */
export function lpPreviewAdd(st, quoteAmt, tokenAmt) {
  if (quoteAmt <= 0n || tokenAmt <= 0n) return { made: 0n, lopsided: false, why: 'zero' };
  const [rQ, rT] = st.reserves;
  const sup = st.totalSupply;
  let made;
  let lopsided = false;
  if (sup === 0n) {
    made = sqrt((rQ + quoteAmt) * (rT + tokenAmt));
  } else {
    const mQ = quoteAmt * sup / rQ;
    const mT = tokenAmt * sup / rT;
    made = mQ < mT ? mQ : mT;
    const hi = mQ > mT ? mQ : mT;
    lopsided = hi > (made * 10001n) / 10000n;
  }
  return { made, lopsided, why: made === 0n ? 'zero' : 'ok' };
}

/**
 * Quote and token out for burning `shares` — proportional floors, always.
 * shares > totalSupply reverts on-chain (BEAR/SHARES); the caller keeps the
 * button from lying about it.
 */
export function lpPreviewRemove(st, shares) {
  if (shares <= 0n) return { outQuote: 0n, outToken: 0n, why: 'zero' };
  const [rQ, rT] = st.reserves;
  const sup = st.totalSupply;
  return { outQuote: rQ * shares / sup, outToken: rT * shares / sup, why: 'ok' };
}

/** Calldata for addLiquidity — minShares is the user's floor, never ours. */
export function addLiqData(quoteAmt, tokenAmt, minShares) {
  return PAIR_I.encodeFunctionData('addLiquidity', [quoteAmt, tokenAmt, minShares]);
}

/** Calldata for removeLiquidity — the mins are the user's floor, never ours. */
export function removeLiqData(shares, minQuote, minToken) {
  return PAIR_I.encodeFunctionData('removeLiquidity', [shares, minQuote, minToken]);
}

// ── the factory the launcher remembers ──────────────────────────────────

// One key per engine chain (sepolia today): scanning is a user action, but
// forgetting the factory between visits would make M4 a paste-ritual.
const KEY = (chainId) => `dexFactory.${Number(chainId) & 0xffffffff}`;

/** Remember this factory for a chain id (localStorage, engine law). */
export function factoryRemember(chainId, factoryAddress) {
  try { localStorage.setItem(KEY(chainId), String(factoryAddress).toLowerCase()); } catch { /* private mode */ }
}

/** The remembered factory, or '' — never a guess, never a prefill. */
export function factoryRecall(chainId) {
  try { return localStorage.getItem(KEY(chainId)) || ''; } catch { return ''; }
}

/** Forget — the explicit "wrong factory" door. */
export function factoryForget(chainId) {
  try { localStorage.removeItem(KEY(chainId)); } catch { /* private mode */ }
}
