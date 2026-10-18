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

/**
 * One scanned pool row straight out of the Launched event: the addresses are
 * event data, everything else (reserves, symbols, my shares) is read live
 * right before it is shown.
 */
export async function scanFactory(providerLike, factoryAddress) {
  const factory = factoryContract(factoryAddress, providerLike);
  // An address without code would play factory by throwing at the first
  // read; say it plainly instead (the user pasted the wrong box).
  const code = providerLike.getCode ? await providerLike.getCode(factoryAddress) : undefined;
  if (typeof code === 'string' && code.replace(/^0x/, '') === '') {
    const e = new Error('dex/pools: not-a-contract'); e.why = 'contract'; throw e;
  }
  const [quote, pools] = await Promise.all([
    factory.quote(),
    factory.queryFilter(factory.filters.Launched(), 0, 'latest'),
  ]);
  return {
    factory: factoryAddress.toLowerCase(),
    quote: String(quote).toLowerCase(),
    pools: pools.map((log) => {
      const desc = FACTORY_I.parseLog(log.topics
        ? { topics: log.topics, data: log.data }
        : { topics: [], data: '0x' });
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
    }).filter(Boolean),
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
