// Bear Tool — js/dex/chart.js
// M8: the candlestick CHART, drawn by Bear Tool itself.
//
// The earlier ribbon (token.js candlesOf) is a 12-bar sparkline. This module
// is the full chart the token page deserves: candles + a volume pane,
// SMA/EMA overlays, an RSI pane, a Bollinger option, a live crosshair with
// an OHLC legend, wheel-drag zoom, touch-pan, interval rebucketing —
// every pixel painted on OUR canvas. No third-party chart is imported
// (the destroy-on-export rule): the wheel mapping, the nice-price grid and
// the legend are ours, sized for a phone screen.
//
// The math half is pure — exported, unit-tested, chain-free. The renderer
// half is one draw function over an rAF loop that redraws only when the
// viewport/pointer changed. Nothing here touches the network.

// ── pure math (tested) ────────────────────────────────────────────────

/** Roll raw swap rows (newest-first, { ts, ... }) into OHLCV candles of
 *  `ms` width. A gap is drawn as a missing bar — never a fake flat. The
 *  FIRST row seeds the open; rows outside the newest bucket keep their own
 *  buckets, so short histories are honest, not padded. */
export function bucketCandles(rows, ms, maxBars = 400) {
  const rs = (rows || []).filter((r) => r && Number.isFinite(r.ts) && Number.isFinite(r.price) && r.price > 0);
  if (rs.length === 0 || !(ms > 0)) return [];
  const newest = rs[0].ts;
  const startFloor = Math.floor(newest / ms) * ms;
  const out = [];
  for (const r of rs) {
    const b = Math.floor(r.ts / ms) * ms;
    if (b < startFloor - (maxBars - 1) * ms) break; // far history: stop reading
    let c = out[out.length - 1];
    if (!c || c.t !== b) {
      c = { t: b, o: r.price, h: r.price, l: r.price, c: r.price, v: Number(r.amount) || 0 };
      out.push(c);
      continue;
    }
    c.h = Math.max(c.h, r.price); c.l = Math.min(c.l, r.price);
    c.c = r.price; c.v += Number(r.amount) || 0;
  }
  out.reverse(); // oldest-left for the renderer
  return out.length > maxBars ? out.slice(-maxBars) : out;
}

/** Simple moving average. Output[i] = mean of values[i-n+1..i]; window not
 *  yet full → null (charts skip a point, they must not lie). */
export function sma(values, n) {
  const out = new Array(values.length).fill(null);
  if (!(n > 0)) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

/** Exponential moving average: seeds with the first value, k = 2/(1+n). */
export function ema(values, n) {
  const out = new Array(values.length).fill(null);
  if (!(n > 0) || values.length === 0) return out;
  const k = 2 / (1 + n);
  let acc = values[0];
  for (let i = 0; i < values.length; i++) {
    acc = i === 0 ? values[0] : (values[i] - acc) * k + acc;
    out[i] = i >= n - 1 ? acc : null; // warm-up window stays hidden
  }
  return out;
}

/** Wilder RSI: one seed pass, then the smoothed deltas. Flat runs keep the
 *  previous RSI (50-return is a convention, not evidence). */
export function rsi(closes, n = 14) {
  const out = new Array(closes.length).fill(null);
  if (!(n > 0) || closes.length <= n) return out;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= n; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= n; avgLoss /= n;
  const put = (i, g, l) => {
    out[i] = l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l);
  };
  put(n, avgGain, avgLoss);
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (n - 1) + (d > 0 ? d : 0)) / n;
    avgLoss = (avgLoss * (n - 1) + (d < 0 ? -d : 0)) / n;
    put(i, avgGain, avgLoss);
  }
  return out;
}

/** Bollinger: SMA(n) ± k·stdev over the same window. */
export function bollinger(values, n, k = 2) {
  const mid = sma(values, n);
  const up = mid.slice(), lo = mid.slice();
  for (let i = 0; i < values.length; i++) {
    if (mid[i] == null) continue;
    let acc = 0;
    for (let j = i - n + 1; j <= i; j++) acc += (values[j] - mid[i]) ** 2;
    const sd = Math.sqrt(acc / n);
    up[i] = mid[i] + k * sd;
    lo[i] = mid[i] - k * sd;
  }
  return { mid, up, lo };
}

/** "Nice" axis price: a step so the right-most label is round-ish. */
export function niceStep(span, targetLines = 5) {
  if (!(span > 0) || !Number.isFinite(span)) return 1;
  const raw = span / Math.max(1, targetLines);
  const exp = Math.floor(Math.log10(raw));
  const base = 10 ** exp;
  for (const m of [1, 2, 5, 10]) if (m * base >= raw) return m * base;
  return 10 * base;
}

const last = (arr) => (arr.length ? arr[arr.length - 1] : null);

/** Everything the RENDERER needs decided up-front, pure: visible slice,
 *  y-scale (padded 6%, band RSI 30/70), and the live candle update note. */
export function viewport(candles, barsVisible, endIndex) {
  if (!candles.length) return null;
  const end = Math.min(candles.length, Math.max(barsVisible, Math.min(endIndex, candles.length)));
  const begin = Math.max(0, end - barsVisible);
  const slice = candles.slice(begin, end);
  let lo = Infinity, hi = -Infinity;
  for (const c of slice) { if (c.l < lo) lo = c.l; if (c.h > hi) hi = c.h; }
  const pad = (hi - lo) * 0.06 || lo * 0.02 || 1;
  return { begin, end, slice, yLo: lo - pad, yHi: hi + pad };
}

// ── renderer ──────────────────────────────────────────────────────────
const pad2 = (x) => `${x}`.padStart(2, '0');
const fmtT = (ms, dayBars) => {
  const d = new Date(ms);
  if (dayBars) return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const fmtPriceShort = (p) => {
  if (!Number.isFinite(p)) return '—';
  if (p >= 1000) return p.toFixed(1);
  if (p >= 1) return String(Math.round(p * 100) / 100);
  if (p >= 0.001) return p.toFixed(4);
  return p.toPrecision(3);
};

/**
 * Chart component. One instance per canvas; survives re-renders via
 * `setData`. OPTS (all optional):
 *   intervals: [{ ms, label }] chips to show (default the six)
 *   overlays : sma/ema/flags config — default SMA7 SMA25 EMA7
 *   rsi      : Boolean — draw the RSI pane
 *   bollinger: Boolean support
 *   height   : css px (default 240)
 * `mount(canvas, opts)` returns `{ destroy, setData, setIntervals }`.
 */
export function mountChart(canvas, opts = {}) {
  const win = canvas.ownerDocument.defaultView || globalThis;
  const ctx = canvas.getContext('2d');
  const CSS_H = opts.height ?? 240;
  const intervals = opts.intervals ?? [
    { ms: 60_000, label: '1m' }, { ms: 300_000, label: '5m' },
    { ms: 900_000, label: '15m' }, { ms: 3_600_000, label: '1h' },
    { ms: 14_400_000, label: '4h' }, { ms: 86_400_000, label: '1D' },
  ];
  const st = {
    candles: null, interval: 300_000,
    legSma:[7,25], legEma:[7], legsOn:{ 'sma7':true,'sma25':true,'ema7':false, bb:false, rsi: !!opts.rsi, vol:true },
    bars: 60, endIdx: Infinity, cross: null, // {x, y} css px
    drag: null, pinch: null, raf: 0, dirty: true,
    theme: null,
  };
  if (opts.bollinger !== undefined) st.legsOn.bb = !!opts.bollinger;

  const colors = () => ({
    bg: 'rgba(0,0,0,0)',
    grid: 'rgba(128,128,128,.18)',
    axis: 'rgba(128,128,128,.52)',
    ink: 'rgba(240,240,240,.94)',
    soft: 'rgba(160,160,160,.6)',
    up: '#22a06b', dn: '#d4553f',
    sma7: '#7aa2f7', sma25: '#f0a202', ema7: '#c58fdc', bb: 'rgba(122,162,247,.5)',
    rsi: '#c5a3fd', rsiBand: 'rgba(128,128,128,.16)',
    volUp: 'rgba(34,160,107,.42)', volDn: 'rgba(212,85,63,.42)',
    cross: 'rgba(240,240,240,.4)', legendBg: 'rgba(0,0,0,.55)',
  });

  const resize = () => {
    const dpr = Math.max(1, Math.min(2.5, win.devicePixelRatio || 1));
    const w = Math.max(60, canvas.clientWidth || canvas.parentElement?.clientWidth || 320);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(CSS_H * dpr);
    canvas.style.height = `${CSS_H}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    st.dirty = true;
  };

  /** Bar layout from the current zoom window. */
  const layout = (W, H) => {
    const RSI_H = st.legsOn.rsi ? Math.round(H * 0.24) : 0;
    const axisH = 16, volH = st.legsOn.vol ? Math.round((H - axisH - RSI_H) * 0.22) : 0;
    const priceH = H - axisH - RSI_H - volH;
    const bars = Math.max(8, Math.min(st.bars, 400));
    const end = Math.min(st.candles.length, Math.min(st.endIdx, st.candles.length));
    const begin = Math.max(0, end - bars);
    const slice = st.candles.slice(begin, end);
    let lo = Infinity, hi = -Infinity;
    for (const c of slice) { if (c.l < lo) lo = c.l; if (c.h > hi) hi = c.h; }
    if (!Number.isFinite(lo)) return null;
    const pad = (hi - lo) * 0.06 || lo * 0.02 || 1;
    const bw = W / slice.length;
    return { begin, end, slice, yLo: lo - pad, yHi: hi + pad,
      yPriceTop: 0, yPriceH: priceH, yVolTop: priceH, yVolH: volH,
      yRsiTop: priceH + volH, yRsiH: RSI_H, axisH, bw, W, H };
  };

  const yAt = (L, v) => L.yPriceTop + (L.yHi - v) * L.yPriceH / Math.max(1e-12, L.yHi - L.yLo);
  const xAt = (L, i) => (i - L.begin + 0.5) * L.bw;

  const paintOver = (L, get, color, label) => {
    let started = false;
    ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = 1.4;
    for (let i = 0; i < L.slice.length; i++) {
      const s = L.begin + i;
      const v = get(st.candles, s);
      if (v == null) { started = false; continue; }
      const x = xAt(L, s), y = yAt(L, v);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke(); void label;
  };

  const paint = () => {
    if (!st.candles) return;
    const W = canvas.width / Math.min(2.5, Math.max(1, win.devicePixelRatio || 1));
    const H = CSS_H;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const cs = colors();
    const L = layout(W, H);
    if (!L) {
      ctx.fillStyle = cs.soft; ctx.font = `12px system-ui, sans-serif`;
      ctx.fillText('—', 12, 18);
      return;
    }

    // grid + right axis labels: a step the eye can read out loud
    ctx.strokeStyle = cs.grid; ctx.lineWidth = 1; ctx.fillStyle = cs.axis;
    ctx.font = '10px system-ui, sans-serif';
    const step = niceStep(L.yHi - L.yLo, 5);
    for (let p = Math.ceil(L.yLo / step) * step; p < L.yHi; p += step) {
      const y = yAt(L, p);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(L.W, y); ctx.stroke();
      ctx.textAlign = 'right';
      ctx.fillText(fmtPriceShort(p), L.W - 2, y - 3);
    }

    // volume pane (behind price); quiet buckets stay quiet, they exist
    let maxVol = 0;
    for (const c of L.slice) maxVol = Math.max(maxVol, c.v);
    for (let i = 0; i < L.slice.length; i++) {
      const c = L.slice[i];
      if (c.v <= 0) continue;
      const vh = (c.v / Math.max(1e-12, maxVol)) * L.yVolH;
      ctx.fillStyle = c.c >= c.o ? cs.volUp : cs.volDn;
      ctx.fillRect(xAt(L, L.begin + i) - L.bw * 0.32, L.yVolTop + L.yVolH - vh, Math.max(1, L.bw * 0.64), vh);
    }

    // candles: body + wick in one pass
    for (let i = 0; i < L.slice.length; i++) {
      const c = L.slice[i];
      const x = xAt(L, L.begin + i);
      const up = c.c >= c.o;
      ctx.strokeStyle = up ? cs.up : cs.dn;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, yAt(L, c.h)); ctx.lineTo(x, yAt(L, c.l));
      ctx.stroke();
      const yo = yAt(L, c.o), yc = yAt(L, c.c);
      const bh = Math.max(1, Math.abs(yc - yo));
      ctx.fillStyle = up ? cs.up : cs.dn;
      ctx.fillRect(x - Math.max(1, L.bw * 0.32), Math.min(yo, yc), Math.max(2, L.bw * 0.64), bh);
    }

    // overlays
    if (st.legsOn.bb) {
      const closes = st.candles.map((c) => c.c);
      const bb = bollinger(closes, 20, 2);
      paintOver(L, (a, s) => bb.up[s], cs.bb);
      paintOver(L, (a, s) => bb.lo[s], cs.bb);
      paintOver(L, (a, s) => bb.mid[s], cs.bb);
    }
    for (const nn of st.legSma) if (st.legsOn[`sma${nn}`]) paintOver(L, (a, s) => sma(st.candles.map((c) => c.c), nn)[s], cs[`sma${nn}`]);
    for (const nn of st.legEma) if (st.legsOn[`ema${nn}`]) paintOver(L, (a, s) => ema(st.candles.map((c) => c.c), nn)[s], cs[`ema${nn}`]);

    // last price tag (right edge, on the axis)
    const lastC = st.candles[st.candles.length - 1];
    if (lastC && L.end === st.candles.length) {
      const y = yAt(L, lastC.c);
      ctx.fillStyle = lastC.c >= lastC.o ? cs.up : cs.dn;
      ctx.fillRect(L.W - 46, y - 8, 48, 16);
      ctx.fillStyle = '#fff'; ctx.textAlign = 'right';
      ctx.fillText(fmtPriceShort(lastC.c), L.W - 2, y + 4);
    }

    // RSI pane
    if (st.legsOn.rsi) {
      const closes = st.candles.map((c) => c.c);
      const r = rsi(closes, 14);
      const yR = (v) => L.yRsiTop + L.yRsiH - (v - 0) * L.yRsiH / 100;
      ctx.strokeStyle = cs.rsiBand; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
      for (const b of [30, 70]) { ctx.beginPath(); ctx.moveTo(0, yR(b)); ctx.lineTo(L.W, yR(b)); ctx.stroke(); }
      ctx.setLineDash([]);
      let started = false;
      ctx.beginPath(); ctx.strokeStyle = cs.rsi; ctx.lineWidth = 1.2;
      for (let i = 0; i < L.slice.length; i++) {
        const s = L.begin + i, v = r[s];
        if (v == null) { started = false; continue; }
        const x = xAt(L, s), y = yR(v);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // x axis (time), every ~80px a label
    ctx.fillStyle = cs.axis; ctx.textAlign = 'center';
    const day = st.interval >= 86_400_000;
    const showEvery = Math.max(1, Math.round(80 / L.bw));
    for (let i = 0; i < L.slice.length; i += showEvery) {
      ctx.fillText(fmtT(L.slice[i].t, day), xAt(L, L.begin + i), H - 4);
    }

    // crosshair + the legend with the hovered candle's true OHLC
    if (st.cross) {
      const { x, y } = st.cross;
      ctx.strokeStyle = cs.cross; ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(L.W, y); ctx.stroke();
      ctx.setLineDash([]);
      const barIdx = L.begin + Math.floor(x / L.bw);
      const c = st.candles[barIdx];
      if (c && barIdx >= L.begin && barIdx < L.end) {
        const day = st.interval >= 86_400_000;
        const line = `${fmtT(c.t, day)}  O ${fmtPriceShort(c.o)}  H ${fmtPriceShort(c.h)}  L ${fmtPriceShort(c.l)}  C ${fmtPriceShort(c.c)}  V ${c.v >= 1000 ? c.v.toFixed(0) : c.v}`;
        ctx.fillStyle = cs.legendBg;
        const wl = Math.min(L.W, ctx.measureText(line).width + 12);
        ctx.fillRect(0, 0, wl, 18);
        ctx.fillStyle = cs.ink; ctx.textAlign = 'left'; ctx.font = `10px system-ui, sans-serif`;
        ctx.fillText(line, 6, 12);
      }
    }
    st.dirty = false;
  };

  const loop = () => {
    if (st.dirty) paint();
    st.raf = win.requestAnimationFrame(loop);
  };
  st.raf = win.requestAnimationFrame(loop);

  // ── interaction: wheel zoom, drag pan, crosshair, touch pinch ─────────
  const xy = (ev) => {
    const r = canvas.getBoundingClientRect();
    return { x: (ev.clientX - r.left), y: (ev.clientY - r.top) };
  };
  const onMove = (ev) => {
    if (!st.candles) return;
    st.cross = xy(ev);
    st.dirty = true;
  };
  const onLeave = () => { st.cross = null; st.dirty = true; };
  const onDown = (ev) => { st.drag = xy(ev); };
  const onUp = () => { st.drag = null; };
  const onDragMove = (ev) => {
    if (!st.drag || !st.candles) return;
    const p = xy(ev);
    const dx = p.x - st.drag.x;
    if (Math.abs(dx) < 3) return;
    st.drag = p;
    const bars = Math.max(8, Math.min(st.bars, 400));
    st.endIdx = Math.min(st.candles.length, Math.max(bars,
      Math.round(st.endIdx === Infinity || !Number.isFinite(st.endIdx) ? st.candles.length : st.endIdx - dx / (canvas.clientWidth / bars))));
    st.dirty = true;
  };
  const onWheel = (ev) => {
    if (!st.candles) return;
    ev.preventDefault();
    const dir = ev.deltaY > 0 ? 1.18 : 1 / 1.18;
    const nz = Math.max(8, Math.min(400, Math.round(st.bars * dir)));
    if (nz === st.bars) return;
    st.bars = nz;
    st.dirty = true;
  };
  const onTouchStart = (ev) => {
    if (ev.touches.length === 1) st.drag = { x: ev.touches[0].clientX, y: ev.touches[0].clientY };
    if (ev.touches.length === 2) {
      st.pinch = Math.abs(ev.touches[0].clientX - ev.touches[1].clientX);
    }
  };
  const onTouchMove = (ev) => {
    if (ev.touches.length === 2 && st.pinch) {
      const d = Math.abs(ev.touches[0].clientX - ev.touches[1].clientX);
      const dir = d > st.pinch ? 1 / 1.12 : 1.12;
      st.bars = Math.max(8, Math.min(400, Math.round(st.bars * dir)));
      st.pinch = d;
      st.dirty = true;
      ev.preventDefault();
      return;
    }
    if (ev.touches.length === 1 && st.drag) {
      const dx = ev.touches[0].clientX - st.drag.x;
      if (Math.abs(dx) < 4) return;
      st.drag.x = ev.touches[0].clientX;
      const bars = Math.max(8, st.bars);
      st.endIdx = Math.min(st.candles.length, Math.max(bars,
        Number.isFinite(st.endIdx) ? st.endIdx - Math.round(dx / (canvas.clientWidth / st.bars)) : st.candles.length));
      st.dirty = true;
      ev.preventDefault();
    }
  };
  const onTouchEnd = () => { st.drag = null; st.pinch = null; };

  canvas.addEventListener('mousemove', onMove);
  canvas.addEventListener('mouseleave', onLeave);
  canvas.addEventListener('mousedown', onDown);
  canvas.addEventListener('mouseup', onUp);
  canvas.addEventListener('mousemove', onDragMove);
  canvas.addEventListener('touchstart', onTouchStart, { passive: true });
  canvas.addEventListener('touchmove', onTouchMove, { passive: false });
  canvas.addEventListener('touchend', onTouchEnd);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  const onResize = () => resize();
  win.addEventListener('resize', onResize);
  resize();

  return {
    destroy() {
      win.cancelAnimationFrame(st.raf);
      canvas.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('mouseleave', onLeave);
      canvas.removeEventListener('mousedown', onDown);
      canvas.removeEventListener('mouseup', onUp);
      canvas.removeEventListener('mousemove', onDragMove);
      canvas.removeEventListener('touchstart', onTouchStart);
      canvas.removeEventListener('touchmove', onTouchMove);
      canvas.removeEventListener('touchend', onTouchEnd);
      canvas.removeEventListener('wheel', onWheel);
      win.removeEventListener('resize', onResize);
    },
    setData(candles) {
      st.candles = candles || [];
      st.endIdx = st.candles.length; // fresh data → the newest bars first
      st.dirty = true;
    },
    setInterval(ms) { st.interval = ms; },
    interval() { return st.interval; },
    legs: st,
    toggle(leg, on) { st.legsOn[leg] = on; st.dirty = true; },
    repaint() { st.dirty = true; },
    canvas,
  };
}

// The interval chips choose an EVENT bucket, and the whole candle set is
// re-rolled from the same raw rows — one data source, six views. (The
// bucket call lives with the page that owns the raw trail.)
export const INTERVALS = [
  { ms: 60_000, label: '1m' }, { ms: 300_000, label: '5m' },
  { ms: 900_000, label: '15m' }, { ms: 3_600_000, label: '1h' },
  { ms: 14_400_000, label: '4h' }, { ms: 86_400_000, label: '1D' },
];
export { last as lastOf };
