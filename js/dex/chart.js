// Bear Tool — js/dex/chart.js
//
// TradingView candlesticks over the SAME on-chain Swap logs the Dex already
// reads. Nothing here invents a price and nothing here comes off a market
// feed: the series is a VIEW over trades decoded from the pool's own events.
// (A TradingView widget iframe would draw the token's real-market chart — a
// different market entirely — so the library is used, not the widget.)

// Pinned, not floating: a chart that silently upgrades under you is a chart
// you can no longer reason about. SRI computed from the file itself.
export const LWC_VERSION = '5.2.1';
export const LWC_URL = 'https://cdn.jsdelivr.net/npm/lightweight-charts@5.2.1/dist/lightweight-charts.standalone.production.js';
export const LWC_SRI = 'sha384-KkYqTZlM13Zya6fVUF3IGCBOQ1ehFeJVVgxaVvD/0MebineF9EI8Jkd3NnWNChqN';

// Prices arrive scaled by 1e18 so the BigInt division in dex.js keeps its
// precision; every number that leaves this module is a plain JS number.
export const PRICE_SCALE = 1e18;

const MAX_CANDLES = 60;

/**
 * Bucket decoded trades into OHLC candles.
 *
 * @param {Array<{price:number, volQuote:bigint, block:number}>} trades in
 *   ascending block order; `price` is quote-per-base scaled by PRICE_SCALE
 * @param {(row:object, index:number)=>Promise<number>} timeFor real timestamp
 *   (seconds) for a candle, given the LAST trade in the bucket and its index in
 *   the bucket list. Injected so this stays pure — and so the caller can batch
 *   it. It receives the whole ROW, not just the block: two trades can share a
 *   block, so a block number is not enough to tell them apart and produced
 *   duplicate timestamps the library rejects.
 * @param {number} [max]
 * @returns {Promise<Array<{time:number, open:number, high:number, low:number,
 *   close:number, volume:number, blocks:number[]}>>} ascending by time
 *
 * One trade can be a whole candle; the last trade of a bucket is the close,
 * never the highest price. A bucket with a single trade is flat (O=H=L=C),
 * which is what actually happened.
 */
export async function tradesToCandles(trades, timeFor, max = MAX_CANDLES) {
  if (!Array.isArray(trades) || !trades.length) return [];
  const n = Math.max(1, Math.min(max, trades.length));
  const per = Math.ceil(trades.length / n);

  const out = [];
  for (let i = 0; i < trades.length; i += per) {
    const chunk = trades.slice(i, i + per);
    const prices = chunk.map((x) => x.price / PRICE_SCALE);
    let vol = 0n;
    for (const x of chunk) vol += x.volQuote || 0n;
    const last = chunk.length - 1;
    const time = await timeFor(chunk[last], i + last);
    out.push({
      time,
      open: prices[0],
      high: Math.max(...prices),
      low: Math.min(...prices),
      close: prices[prices.length - 1],
      // The volume axis is quote units; bigint is too big for the library and
      // too small to lose to float error here — 18 decimals is plenty.
      volume: Number(vol) / PRICE_SCALE,
      blocks: chunk.map((x) => x.block),
    });
  }
  return out.sort((a, b) => a.time - b.time);
}

/**
 * Bucket trades into candles by TIME — the R8 timeframes (1m/5m/1h/1d) are
 * the same decoded rows re-cut against the clock instead of against the trade
 * count. Pure and sync: the caller already holds the trades, so switching a
 * timeframe costs zero extra reads.
 *
 * @param {Array<{time:number, price:number, volQuote:bigint}>} rows `price`
 *   scaled by PRICE_SCALE, `time` in seconds — the same row contract as
 *   tradesToCandles. Rows may arrive in any order; they are sorted by time.
 * @param {number} intervalSec bucket width in seconds (60/300/3600/86400)
 * @param {number} [max]
 * @returns {Array<{time:number, open:number, high:number, low:number,
 *   close:number, volume:number}>} ascending by bucket start
 *
 * A bucket exists ONLY where a trade landed: a quiet hour draws no candle, so
 * a gap is a fact ("no trade then"), not a bar invented to hide it. Each
 * bucket's time is its start (floor) — distinct and ascending by
 * construction, so the library's strictly-increasing rule holds without the
 * per-row nudge the count path needs. A row whose timestamp never got read
 * (time 0) is skipped: 1970 is not where the trade happened, and a wrong
 * candle is worse than a missing one.
 */
export function timeCandles(rows, intervalSec, max = MAX_CANDLES) {
  if (!Array.isArray(rows) || !rows.length) return [];
  const sec = Math.floor(Number(intervalSec));
  if (!Number.isFinite(sec) || sec <= 0) return [];
  const sorted = rows
    .filter((r) => r && Number.isFinite(r.time) && r.time > 0 && Number.isFinite(r.price))
    .sort((a, b) => a.time - b.time);
  if (!sorted.length) return [];

  const out = [];
  let cur = null;
  for (const r of sorted) {
    const bucket = Math.floor(r.time / sec) * sec;
    const price = r.price / PRICE_SCALE;
    if (!cur || bucket !== cur.time) {
      cur = { time: bucket, open: price, high: price, low: price, close: price, vol: 0n };
      out.push(cur);
    } else {
      cur.high = Math.max(cur.high, price);
      cur.low = Math.min(cur.low, price);
      cur.close = price;
    }
    cur.vol += r.volQuote || 0n;
  }

  const cap = Number.isFinite(max) && max >= 1 ? Math.floor(max) : MAX_CANDLES;
  const kept = out.length > cap ? out.slice(out.length - cap) : out;
  return kept.map((c) => ({
    time: c.time,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    // Same volume contract as the count path: quote units, bigint → float.
    volume: Number(c.vol) / PRICE_SCALE,
  }));
}

/** Is the pinned library already on the page? */
export function chartEngine(win = globalThis) {
  return (win && win.LightweightCharts) || null;
}

/** Does the pinned build's SRI match the bytes we were served? */
export async function verifyEngineIntegrity(win = globalThis) {
  const subtle = win && win.crypto && win.crypto.subtle;
  if (!subtle || !win.__LWC_BYTES__) return 'unknown';
  try {
    const digest = await subtle.digest('sha384', win.__LWC_BYTES__);
    const b64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
    return `sha384-${b64}` === LWC_SRI ? 'ok' : 'mismatch';
  } catch {
    return 'unknown';
  }
}

/**
 * Load the pinned build once. Returns the global, or null when the CDN is
 * unreachable — drawCandles falls back to the hand-rolled bars, and still
 * refuses to lie about data.
 *
 * The attempt is CACHED (module-scoped per-window): when the CDN is blocked,
 * chartEngine(win) never becomes truthy, so without this cache the 15s history
 * repaint re-appended a fresh <script> on every tick — a pile of dead script
 * tags and a repeated network hit for a CDN that is never going to answer.
 * Now a blocked CDN is tried exactly once and every later call returns the
 * cached null (bars fallback) immediately.
 */
let loadAttempt = null;

export function loadChartEngine(doc = globalThis.document, win = globalThis) {
  const engine = chartEngine(win);
  if (engine) return Promise.resolve(engine);
  if (loadAttempt) return loadAttempt;
  loadAttempt = new Promise((resolve) => {
    const s = doc.createElement('script');
    s.src = LWC_URL;
    s.integrity = LWC_SRI;
    s.crossOrigin = 'anonymous';
    s.async = true;
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    s.onload = () => finish(chartEngine(win));
    s.onerror = () => finish(null);
    // A CDN that hangs must not hang the panel with it.
    setTimeout(() => finish(chartEngine(win)), 8000);
    (doc.head || doc.documentElement).appendChild(s);
  });
}

// One palette per theme, in ONE place now that two renderers draw from it: the
// library path below and the SVG bars fallback. A colour fixed here is a colour
// fixed in both, which is the whole point of a palette map.
const PALETTES = {
  dark: { text: '#848e9c', grid: 'rgba(132,142,156,0.10)', border: 'rgba(30,35,41,1)',
          up: '#0ecb81', down: '#f6465d', volUp: 'rgba(14,203,129,0.32)', volDown: 'rgba(246,70,93,0.32)' },
  light: { text: '#2D2A32', grid: 'rgba(45,42,50,0.08)', border: 'rgba(45,42,50,0.2)',
           up: '#1B8F4E', down: '#D64545', volUp: 'rgba(27,143,78,0.5)', volDown: 'rgba(214,69,69,0.5)' },
};
const palette = (theme) => (theme === 'dark' ? PALETTES.dark : PALETTES.light);

const XML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const xmlEsc = (s) => String(s).replace(/[&<>"']/g, (c) => XML_ESC[c]);

/**
 * The hand-rolled fallback the comment above always promised: candlesticks as
 * plain SVG, same palette, no dependency. It exists for exactly the states
 * loadChartEngine can end in — offline, blocked CDN, strict CSP — where the
 * panel must still answer "what did this trade at" instead of going blank.
 *
 * Pure string builder: no DOM, no globals, so a test can read the markup.
 * `opts`: width/height, theme ('dark'|'light'), `fmt` (number → label), and
 * `empty` (the label a zero-trade chart shows — "no trades yet", never the
 * blank box that once read as "the chart is broken").
 */
export function barsSvg(candles, opts = {}) {
  const w = Math.max(80, Math.round(Number(opts.width) || 320));
  const h = Math.max(60, Math.round(Number(opts.height) || 220));
  const theme = palette(opts.theme);
  const fmt = typeof opts.fmt === 'function' ? opts.fmt : (v) => String(v);
  const pad = { t: 16, r: 6, b: 16, l: 6 };
  const iw = w - pad.l - pad.r;
  const ih = h - pad.t - pad.b;

  const parts = [];
  // The frame first — even an empty chart is a chart, not a blank box.
  for (const f of [0, 0.5, 1]) {
    const y = pad.t + ih * f;
    parts.push(`<line x1="${pad.l}" y1="${y}" x2="${w - pad.r}" y2="${y}" stroke="${theme.grid}" stroke-width="1"/>`);
  }
  parts.push(`<rect x="${pad.l}" y="${pad.t}" width="${iw}" height="${ih}" fill="none" stroke="${theme.border}" stroke-width="1"/>`);

  // Candles whose OHLC is not all finite would map to NaN coordinates and take
  // the whole chart down with them — they are skipped, the same "drop the row,
  // never paint NaN" rule the tape follows.
  const rows = (Array.isArray(candles) ? candles : []).filter((c) => c
    && Number.isFinite(c.open) && Number.isFinite(c.close));
  const highOf = (c) => (Number.isFinite(c.high) ? c.high : Math.max(c.open, c.close));
  const lowOf = (c) => (Number.isFinite(c.low) ? c.low : Math.min(c.open, c.close));

  if (!rows.length) {
    if (opts.empty) {
      parts.push(`<text x="${w / 2}" y="${h / 2 + 4}" text-anchor="middle" fill="${theme.text}" font-size="12" font-family="sans-serif">${xmlEsc(opts.empty)}</text>`);
    }
  } else {
    let hi = -Infinity;
    let lo = Infinity;
    for (const c of rows) { hi = Math.max(hi, highOf(c)); lo = Math.min(lo, lowOf(c)); }
    // A flat series has no range to scale against: give it a hairline one, so
    // the candle draws as a line at mid-height instead of dividing by zero.
    if (hi === lo) { const bump = Math.abs(hi) * 0.01 || 1; hi += bump; lo -= bump; }
    const yOf = (p) => pad.t + ih * (1 - (p - lo) / (hi - lo));
    const slot = iw / rows.length;
    const bw = Math.max(1, Math.min(14, slot * 0.66));
    rows.forEach((c, i) => {
      const x = pad.l + slot * i + slot / 2;
      const up = c.close >= c.open;
      const col = up ? theme.up : theme.down;
      parts.push(`<line x1="${x}" y1="${yOf(highOf(c))}" x2="${x}" y2="${yOf(lowOf(c))}" stroke="${col}" stroke-width="1"/>`);
      const yO = yOf(c.open);
      const yC = yOf(c.close);
      parts.push(`<rect data-bar data-dir="${up ? 'up' : 'down'}" x="${(x - bw / 2).toFixed(1)}" y="${Math.min(yO, yC).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, Math.abs(yC - yO)).toFixed(1)}" fill="${col}"/>`);
    });
    // The price range, formatted by the caller's own formatter — the same
    // digits the stat line above uses, never a second rounding.
    parts.push(`<text x="${w - pad.r}" y="${h - pad.b + 12}" text-anchor="end" fill="${theme.text}" font-size="10" font-family="sans-serif">${xmlEsc(fmt(lo))}</text>`);
    parts.push(`<text x="${w - pad.r}" y="${pad.t - 5}" text-anchor="end" fill="${theme.text}" font-size="10" font-family="sans-serif">${xmlEsc(fmt(hi))}</text>`);
  }

  const aria = opts.label ? ` role="img" aria-label="${xmlEsc(opts.label)}"` : ' aria-hidden="true"';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none"${aria}>${parts.join('')}</svg>`;
}

/**
 * barsSvg into a live host, plus the same teardown contract drawCandles
 * returns — so a caller swaps renderers without knowing which one it got.
 */
export function paintBars(host, candles, opts = {}) {
  if (!host) return () => {};
  host.innerHTML = barsSvg(candles, { ...opts, width: host.clientWidth || opts.width });
  return () => { try { host.innerHTML = ''; } catch { /* already gone */ } };
}

/**
 * Draw candles into `host`. Returns a teardown function.
 *
 * Falls back to the hand-rolled SVG bars (barsSvg) when the library is
 * absent, so the panel keeps working offline / behind a strict CSP — an
 * honest "here are the trades" beats a blank box.
 */
export async function drawCandles(host, candles, opts = {}) {
  const win = opts.win || globalThis;
  const LWC = await loadChartEngine(opts.document || globalThis.document, win);
  // Only a missing library falls back to bars, and the fallback keeps the same
  // promise: an EMPTY data set still gets a real chart — a framed grid that
  // says "no trades yet" — because a blank box read as "the chart is broken"
  // (user: "chart ga keliatan"), whereas an empty chart clearly says "no
  // trades yet" while still being a chart.
  if (!LWC) return paintBars(host, candles, opts);

  // Two themes, one palette per theme in ONE place — the PALETTES map above,
  // shared with the bars fallback so a colour can never be fixed in one
  // renderer and missed in the other. The coin page moved onto a near-black
  // exchange surface (css/exchange.css) and the old hardcoded #2D2A32 axes
  // were drawn in the cartoon ink colour: near-black on near-black, i.e. an
  // empty-looking chart on the Dex's central screen. `theme: 'dark'` is the
  // same chart with the exchange palette; nothing about the data or the
  // series changes.
  const theme = palette(opts.theme);

  const chart = LWC.createChart(host, {
    width: host.clientWidth || 320,
    height: opts.height || 220,
    layout: {
      background: { color: 'transparent' },
      textColor: opts.textColor || theme.text,
    },
    grid: {
      vertLines: { color: theme.grid },
      horzLines: { color: theme.grid },
    },
    rightPriceScale: { borderColor: theme.border },
    timeScale: { borderColor: theme.border },
    autoSize: true,
  });

  // v5 API: addSeries(CandlestickSeries, opts) — v4's addCandlestickSeries is
  // gone. Pinned by a test so an upstream rename cannot land silently.
  const candleSeries = chart.addSeries(LWC.CandlestickSeries, {
    upColor: theme.up,
    downColor: theme.down,
    borderVisible: false,
    wickUpColor: theme.up,
    wickDownColor: theme.down,
  });
  candleSeries.setData(candles.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));

  if (opts.volume !== false) {
    const volSeries = chart.addSeries(LWC.HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: '',
    });
    volSeries.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    volSeries.setData(candles.map(({ time, volume, close, open }) => ({
      time, value: volume, color: close >= open ? theme.volUp : theme.volDown,
    })));
  }

  chart.timeScale().fitContent();

  const onResize = () => chart.applyOptions({ width: host.clientWidth || 320 });
  win.addEventListener?.('resize', onResize);

  return () => {
    win.removeEventListener?.('resize', onResize);
    try { chart.remove(); } catch { /* already gone */ }
  };
}
