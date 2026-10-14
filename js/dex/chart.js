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
 * unreachable — the caller falls back to bars, it does not lie about data.
 */
export function loadChartEngine(doc = globalThis.document, win = globalThis) {
  if (chartEngine(win)) return Promise.resolve(chartEngine(win));
  return new Promise((resolve) => {
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

/**
 * Draw candles into `host`. Returns a teardown function.
 *
 * Falls back to the hand-rolled bars when the library is absent, so the
 * panel keeps working offline / behind a strict CSP — an honest "here are the
 * trades" beats a blank box.
 */
export async function drawCandles(host, candles, opts = {}) {
  const win = opts.win || globalThis;
  const LWC = await loadChartEngine(opts.document || globalThis.document, win);
  // Only a missing library falls back to bars. An EMPTY data set still gets a
  // real chart — an empty grid with price/time axes — because a blank box read
  // as "the chart is broken" (user: "chart ga keliatan"), whereas an empty chart
  // clearly says "no trades yet" while still being a chart.
  if (!LWC) return null;

  const chart = LWC.createChart(host, {
    width: host.clientWidth || 320,
    height: opts.height || 220,
    layout: {
      background: { color: 'transparent' },
      textColor: opts.textColor || '#2D2A32',
    },
    grid: {
      vertLines: { color: 'rgba(45,42,50,0.08)' },
      horzLines: { color: 'rgba(45,42,50,0.08)' },
    },
    rightPriceScale: { borderColor: 'rgba(45,42,50,0.2)' },
    timeScale: { borderColor: 'rgba(45,42,50,0.2)' },
    autoSize: true,
  });

  // v5 API: addSeries(CandlestickSeries, opts) — v4's addCandlestickSeries is
  // gone. Pinned by a test so an upstream rename cannot land silently.
  const candleSeries = chart.addSeries(LWC.CandlestickSeries, {
    upColor: '#1B8F4E',
    downColor: '#D64545',
    borderVisible: false,
    wickUpColor: '#1B8F4E',
    wickDownColor: '#D64545',
  });
  candleSeries.setData(candles.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));

  if (opts.volume !== false) {
    const volSeries = chart.addSeries(LWC.HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: '',
    });
    volSeries.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    volSeries.setData(candles.map(({ time, volume, close, open }) => ({
      time, value: volume, color: close >= open ? 'rgba(27,143,78,0.5)' : 'rgba(214,69,69,0.5)',
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
