// Bear Tool — js/dex/token.js
// M5b: the token page's DATA layer. What a launched coin owns on-chain:
// its face (launch.js tokenFace — the coin's own public strings), and a
// trail of the pair's own Swap events that becomes the tape and the
// candles. This module never touches the DOM; sheet assembly and wiring
// live in index.js so this file stays testable without a document.
//
// Swap semantics come from the pair itself (js/dex/contracts.js:252,274):
//   swapQuoteForToken → emit Swap(who, to, amountIn=QUOTE, amountOut=TOKEN, quoteIn=true)
//   swapTokenForQuote → emit Swap(who, to, amountIn=TOKEN, amountOut=QUOTE, quoteIn=false)
// so a quote-per-token price is ALWAYS: quoteIn ? in/out : out/in. The 0.3%
// LP cut and the creator carve live inside the reserves math, never here —
// the tape shows what MOVED, prices stay one formula.

import { BEAR_PAIR_ABI } from './abi.js';
import { isAddress, pairContract } from './swap.js';

/** Query depth in blocks and row cap. 640 blocks ≈ a few minutes on most
 *  chains and plenty for a fresh launch; the RPC will answer with whatever
 *  happened inside the window (an empty window means an honest empty page). */
export const TAPE_DEPTH = 640;
export const TAPE_LIMIT = 24;

/** quote-per-token price of one swap, as a Number (9 decimals of headroom).
 *  Numbers only — the candles draw with canvas paths. null = not drawable. */
export function rowPrice(amountIn, amountOut, quoteIn) {
  const a = BigInt(amountIn || 0);
  const b = BigInt(amountOut || 0);
  if (b === 0n || a === 0n) return null;
  const q = quoteIn ? a : b;   // the quote side of the trade
  const t = quoteIn ? b : a;   // the token side
  if (t === 0n) return null;
  // scale 1e12 keeps 4+ significant quotes inside Number without rounding
  // the price into a stair — candle math only needs relative shape.
  return Number((q * 10n ** 12n) / t) / 10 ** 12;
}

/** The pair's own Swap trail, newest first (block desc, log index desc).
 *  Real ethers V6 quirk inside: decodeEventLog wants topics AND data handed
 *  to it EXPLICITLY (the abstraction will not split it for you silently).
 *  provider.getBlock falling through → ts stays undefined, the tape still
 *  renders (block number is truthier than no row at all). */
export async function swapTape(providerLike, pairAddress, opts = {}) {
  const depth = opts.depth ?? TAPE_DEPTH;
  const limit = opts.limit ?? TAPE_LIMIT;
  if (!isAddress(pairAddress)) {
    const e = new Error('dex/token: pair'); e.why = 'bad'; throw e;
  }
  const pair = pairContract(pairAddress, providerLike);
  let latest = Number(await providerLike.getBlockNumber());
  const from = Math.max(0, latest - depth);
  const raw = await pair.queryFilter('Swap', from, 'latest');
  if (!Array.isArray(raw) || raw.length === 0) {
    return { rows: [], from, to: latest };
  }
  const iface = new globalThis.ethers.Interface(BEAR_PAIR_ABI);
  const rows = [];
  for (let i = raw.length - 1; i >= 0 && rows.length < limit; i--) {
    const log = raw[i];
    const ev = iface.decodeEventLog('Swap', log.data, log.topics);
    const block = Number(log.blockNumber ?? log.blockHash ?? 0);
    rows.push({
      who: String(ev.who), to: String(ev.to),
      amountIn: BigInt(ev.amountIn), amountOut: BigInt(ev.amountOut),
      quoteIn: Boolean(ev.quoteIn), price: null,
      block, ts: null,
    });
  }
  // blocks are the newest-first anchors; timestamps fill in where the node
  // answers fast enough (getBlock on ancient blocks can be slow on a fresh
  // fork and an honest hole beats a hung request).
  await Promise.all(rows.map(async (r) => {
    r.price = rowPrice(r.amountIn, r.amountOut, r.quoteIn);
    try { const b = await providerLike.getBlock(r.block); r.ts = b?.timestamp ?? null; } catch { /* hole */ }
  }));
  return { rows, from, to: latest };
}

/** The ribbon: roll swap rows asc-by-block into ≤n candles. Buckets are
 *  INDEX-bands over the block range (a fork has no minute-hour rhythm), so
 *  a one-row tape is an honest single candle, never a fake zigzag.
 *  Numbers-only output: JSON.stringify will never see a BigInt. */
export function candlesOf(rows, n = 12) {
  const withPrice = (rows || [])
    .filter((r) => r.price != null)
    .slice().reverse();            // asc by block for the path
  if (withPrice.length === 0) return [];
  if (n < 1) n = 1;
  const bands = Math.min(n, withPrice.length);
  const width = Math.ceil(withPrice.length / bands);
  const out = [];
  for (let b = 0; b < bands; b++) {
    const band = withPrice.slice(b * width, (b + 1) * width);
    if (!band.length) continue;
    const ps = band.map((r) => r.price);
    out.push({ o: ps[0], h: Math.max(...ps), l: Math.min(...ps), c: ps[ps.length - 1] });
  }
  return out;
}

/** Only the strings a public profile may ship as links. Non-http(s),
 *  empty, or protocol-smuggling values are simply not rendered — the
 *  face's own words never become a javascript: jump. */
export function socialUrl(v) {
  const s = String(v || '').trim();
  return /^https:\/\//i.test(s) ? s : '';
}

// Flat integer window sugars for the caller (a fresh launch has no history
// beyond the genesis of its own pair — the empty case is a FEATURE).
export const EMPTY_TRAIL = { rows: [], from: 0, to: 0 };
