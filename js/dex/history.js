// Bear Tool — js/dex/history.js
// A coin's real trading history, read from the chain.
//
// The PumpToken contract emits `Bought`, `Sold` and `Graduated` for every trade.
// Nothing here is stored, sampled or invented: every row is a log the chain
// produced, with its block number and timestamp, so the price on the chart is
// the price that actually traded.
//
// This is also what feeds the chart. A pure launchpad has no Uniswap V2 Swap
// logs to read (there is no pool), so the curve's own events ARE the tape.
// Turning them into OHLC candles is what makes the price history real.

import { t } from '../i18n.js';
import { escapeHtml } from '../ui.js';
import { tradesToCandles, PRICE_SCALE } from './chart.js';
import { PUMP_ABI } from './pump-source.js';
import { fmtEth, fmtTokens } from './curve.js';

// The three events the tape reads, taken from the ABI that ships with the
// bytecode they belong to — a second copy of an event name would be a second
// place for it to drift. PUMP_ABI is human-readable (plain strings), so the
// names are parsed out of each signature rather than read from an object.
export const HISTORY_EVENTS = PUMP_ABI
  .filter((f) => /^event (Bought|Sold|Graduated)\b/.test(String(f)))
  .map((f) => String(f).match(/^event (\w+)/)[1]);

// How far back to read. A fresh chain answers instantly; an old one is capped
// so opening a coin can never hang on a node that is still indexing.
const LOOKBACK_BLOCKS = 40_000;

// A block's timestamp never changes, so it is read once per chain and kept.
// Without this a busy coin cost up to 60 getBlock RPCs on EVERY repaint — the
// panel refreshes on a timer, so that is a rate-limit problem waiting to
// happen, not a one-off cost.
const stampCache = new Map();
const STAMP_CACHE_MAX = 4000;

// Resolves a real timestamp for each block, reading only what is missing and
// only what fits the budget.
//
// Over budget the unfetched blocks are INTERPOLATED from the ones we do have,
// not dropped and not replaced by their block number. Dropping loses real fills;
// using the block number as a timestamp is worse — it put ancient blocks at 1..80
// beside real ones at ~1.7e9 and broke the chart's ascending time axis. Linear
// interpolation between two known anchors is monotonic by construction and, at
// Sepolia's ~12s blocks, accurate to seconds.
async function blockStamps(provider, numbers) {
  const asc = [...new Set(numbers)].filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  const missing = asc.filter((n) => !stampCache.has(n));

  if (missing.length) {
    const budget = Math.min(missing.length, Math.max(0, MAX_STAMP_READS));
    if (budget) {
      // Fetch the NEWEST budget: the tape shows the latest fills, and an ancient
      // block's exact second is worth less than not hammering the node.
      const pick = missing.slice(-budget);
      const blocks = await Promise.all(pick.map((n) => provider.getBlock(n).catch(() => null)));
      for (const b of blocks) if (b) stampCache.set(Number(b.number), Number(b.timestamp));
      if (stampCache.size > STAMP_CACHE_MAX) {
        for (const k of [...stampCache.keys()].slice(0, stampCache.size - STAMP_CACHE_MAX)) stampCache.delete(k);
      }
    }
  }

  // Anchors are the blocks whose real second we hold.
  const anchors = asc.filter((n) => stampCache.has(n));
  const secondsPerBlock = (() => {
    if (anchors.length < 2) return DEFAULT_SECONDS_PER_BLOCK;
    const first = anchors[0];
    const last = anchors[anchors.length - 1];
    const span = last - first;
    if (span <= 0) return DEFAULT_SECONDS_PER_BLOCK;
    const secs = (stampCache.get(last) - stampCache.get(first)) / span;
    // A node that answered with a nonsense span must not poison the axis.
    return secs > 0 && Number.isFinite(secs) ? secs : DEFAULT_SECONDS_PER_BLOCK;
  })();

  const out = new Map();
  for (const n of asc) {
    if (stampCache.has(n)) { out.set(n, stampCache.get(n)); continue; }
    // Interpolate from the nearest anchor at or above this block; if there is
    // none, extrapolate downward from the lowest one at the chain's own pace.
    const above = anchors.find((a) => a >= n);
    const base = above ?? anchors[anchors.length - 1];
    out.set(n, base === undefined
      ? n                                        // nothing known at all: monotonic by block
      : Math.round(stampCache.get(base) + (n - base) * secondsPerBlock));
  }
  return out;
}

// Sepolia mines roughly every 12 seconds; used only to extrapolate below the
// oldest anchor we hold.
const DEFAULT_SECONDS_PER_BLOCK = 12;

// Hard ceiling on timestamp RPCs per read. A coin with more distinct blocks than
// this in view gets the newest ones exactly and the rest approximated.
const MAX_STAMP_READS = 40;

// Test seam: drops the memo so a test never inherits another test's stamps.
export function _clearStampCache() { stampCache.clear(); }

// Reads the contract's trade logs and returns them newest-first.
//
// Returns { trades, graduated } where each trade is
//   { kind:'buy'|'sell', who, eth, tokens, block, time, price }
// `price` is ETH per token at that moment, derived from the pool reserves at
// that block — so a sell shows the price it got, not today's price.
export async function loadHistory(contract, provider, { limit = 60 } = {}) {
  const empty = { trades: [], graduated: false, ok: false };
  if (!contract || !provider) return empty;

  try {
    const latest = await provider.getBlockNumber();
    const fromBlock = latest > LOOKBACK_BLOCKS ? latest - LOOKBACK_BLOCKS : 0;

    const [buyLogs, sellLogs, gradLogs] = await Promise.all([
      contract.queryFilter(contract.filters.Bought(), fromBlock, latest),
      contract.queryFilter(contract.filters.Sold(), fromBlock, latest),
      contract.queryFilter(contract.filters.Graduated(), fromBlock, latest),
    ]);

    // Blocks are only needed for rows that survive the limit. getBlock takes
    // ONE BlockTag, not a list (passing an array is what silently broke this
    // read before), so the distinct blocks go out in parallel and are capped by
    // the row limit — never an unbounded scan.
    const raw = [
      ...buyLogs.map((l) => ({ kind: 'buy', l })),
      ...sellLogs.map((l) => ({ kind: 'sell', l })),
    ].sort((a, b) => (b.l.blockNumber - a.l.blockNumber));

    const rows = raw.slice(0, limit);
    const stamps = await blockStamps(provider, rows.map((r) => Number(r.l.blockNumber)));

    const trades = rows.map(({ kind, l }) => {   // eslint-disable-line
      // The ABI is the only source of these names: quoteIn / quoteOut. They were
      // read as ethIn / ethOut — the names from before the curve was quoted in
      // an ERC-20 — so both were undefined on every trade, the price was NaN, and
      // the tape and the entire candle series rendered "NaN".
      //
      // There is deliberately no fallback to the old names. Nothing was ever
      // deployed with them, so a fallback is not compatibility — it is the same
      // mistake with an extra step, and it is exactly what a reader (or a gate)
      // can no longer distinguish from correct code.
      const args = kind === 'buy'
        ? { who: l.args.buyer, eth: l.args.quoteIn, tokens: l.args.tokensOut }
        : { who: l.args.seller, eth: l.args.quoteOut, tokens: l.args.tokensIn };
      // The event's ETH/token IS the execution price — the average the trade
      // got after fees. No need to reconstruct reserves: cheaper and exact.
      if (args.eth === undefined || args.tokens === undefined) return null;   // filtered below
      const price = args.tokens > 0n ? Number(args.eth) / Number(args.tokens) : 0;
      if (!Number.isFinite(price)) return null;
      return {
        kind,
        who: String(args.who || '0x0000000000000000000000000000000000000000'),
        eth: args.eth,
        tokens: args.tokens,
        block: Number(l.blockNumber),
        time: stamps.get(Number(l.blockNumber)) || 0,
        price,
      };
    });

    return {
      // Rows this file could not read are dropped, not rendered. A tape entry
      // saying "NaN" is worse than a tape with one fewer row: it looks like a
      // real price the curve never had.
      trades: trades.filter(Boolean),
      graduated: gradLogs.length > 0,
      ok: true,
    };
  } catch (e) {
    // A node that cannot serve old logs must not take the coin page down with
    // it: say "no history" and let the price/buy/sell half keep working. The
    // reason rides along, though — a silent catch turned a wrong RPC call into
    // a coin that "has never traded", which is a lie the user cannot audit.
    return { ...empty, reason: (e && (e.shortMessage || e.message)) || String(e) };
  }
}

// Trades → OHLC candles for the TradingView renderer.
//
// chart.js already consumes this exact shape from V2 Swap logs, so the chart
// code is untouched: the launchpad just feeds it the curve's own tape instead
// of a pool's.
//
// Three things the renderer requires and the raw rows do not carry:
//  • ASCENDING block order — the newest-first rows we display must be flipped
//    or every candle opens backwards.
//  • price scaled by PRICE_SCALE, because the BigInt division that produced it
//    keeps full precision and the library wants a plain number.
//  • STRICTLY INCREASING timestamps. Two trades mined in the same second share a
//    time, and the library silently drops or mis-stacks duplicates — so ties
//    are nudged forward here rather than losing a trade off the chart.
export function historyCandles(trades) {
  if (!trades.length) return Promise.resolve([]);
  const asc = [...trades].sort((a, b) => a.block - b.block);
  const rows = asc.map((x) => ({
    block: x.block,
    time: x.time,
    price: x.price * PRICE_SCALE,
    volQuote: x.eth,   // volume axis is quote units — ETH paid or received
  }));
  // Strictly increasing, per ROW. Two fills can land in the same block — a bot,
  // two accounts — and the library rejects duplicate timestamps outright, so a
  // tie is nudged a second forward here rather than losing a candle.
  let last = 0;
  for (const r of rows) {
    r.fixed = r.time > last ? r.time : last + 1;
    last = r.fixed;
  }
  // The callback gets the row itself, so the per-row time survives grouping:
  // keying by block would collapse same-block fills onto one timestamp again.
  return tradesToCandles(rows, async (row) => row.fixed);
}

// The "recent trades" tape under the chart. Newest first, like every exchange:
// the most recent fill is the row your eye lands on.
//
// Each row reads the way a fill actually happened — someone spent X ETH and got
// Y tokens at Z per token — so a sell shows the price it GOT, not today's.
export function tradesHtml(trades, symbol = '') {
  if (!trades.length) return `<div class="dex-empty small">${escapeHtml(t('dex.trades.none'))}</div>`;
  const sym = escapeHtml(symbol);
  // A LIST, not a pile of divs: a screen reader should hear "list, 5 items" and
  // get one item per fill, which is what the tape actually is.
  const rows = trades.map((x) => `
    <li class="dex-trade-row ${x.kind}">
      <span class="dex-trade-side">${escapeHtml(x.kind === 'buy' ? t('dex.trades.buy') : t('dex.trades.sell'))}</span>
      <span class="dex-trade-eth mono">${escapeHtml(fmtEth(x.eth))} ETH</span>
      <span class="dex-trade-tok mono">${escapeHtml(fmtTokens(x.tokens))} ${sym}</span>
      <span class="dex-trade-price mono">${escapeHtml(x.price.toExponential(3))} ETH</span>
      <span class="dex-trade-when">${escapeHtml(ago(x.time))}</span>
    </li>`).join('');
  return `<ul class="dex-trades" aria-label="${escapeHtml(t('dex.trades.title'))}">${rows}</ul>`;
}

// "12s ago" / "4m ago" / "3h ago". Relative, because on a launchpad recency is
// the whole point of a trade tape — an absolute date hides the action.
function ago(sec) {
  if (!sec) return '';
  const d = Math.max(0, Math.floor(Date.now() / 1000) - sec);
  if (d < 60) return t('dex.trades.sec', { n: String(d) });
  if (d < 3600) return t('dex.trades.min', { n: String(Math.floor(d / 60)) });
  if (d < 86400) return t('dex.trades.hour', { n: String(Math.floor(d / 3600)) });
  return t('dex.trades.day', { n: String(Math.floor(d / 86400)) });
}

