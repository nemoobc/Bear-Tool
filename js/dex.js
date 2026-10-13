// ═══════════════════════════════════════════════════════════════
// Bear Tool — js/dex.js
// The Dex view: Sepolia-only AMM over three ERC-20s that already
// exist on chain (user orders: "custom coin native hapus, pake ini
// aja [tiga alamat]", "3 contract itu buat dex coin native, eth
// sepolia buat gas fee aja", "logo sesuaikan").
//
// Rules that shape every line here:
//  - Sepolia ONLY. Any other chain → the view says so and every
//    action refuses; nothing silently runs somewhere else.
//  - The three DEX_PRESETS are the ONLY pair sides. There is no
//    minting and no bonding curve: those panels are gone with the
//    contracts they would have deployed.
//  - Sepolia ETH is GAS ONLY. It is never a pair side, never in a
//    quote, never in reserves. Every number on screen that is not
//    gas is one of the three preset tokens.
//  - Everything is a real transaction. No simulation anywhere: a
//    missing pool or an empty chart says so instead of faking it.
// ═══════════════════════════════════════════════════════════════
import { t } from './i18n.js';
import { get, set, on, off } from './state.js';
import { getNetworkById } from './network.js';
import { $, toast, escapeHtml, confirmTx } from './ui.js';
import { withTimeout, waitForReceipt, receiptVerdict } from './safetx.js';
import { tokenLogoHTML, guardTokenLogos } from './token-logo.js';
import {
  UNISWAP_V2, V2_ROUTER_ABI, V2_FACTORY_ABI, V2_PAIR_ABI, DEX_ERC20_ABI,
} from './dex-contract.js';

// Re-exported so the gate (tests/dex-view.test.js) reads one registry
// from this module — the Dex view's own entry point — instead of
// reaching into the ABI file.
export { UNISWAP_V2 };

export const DEX_NETWORK_ID = 'sepolia';
export const DEX_CHAIN_ID = 11155111;

// ── the Dex's coins ────────────────────────────────────────────
// Probed on-chain 2026-10-13 through the Tenderly Sepolia gateway, all
// three by the same call shape (getCode + symbol/name/decimals/
// totalSupply, selectors computed with ethers, never recalled):
//   0x8847…fE9  symbol "ETH"   name "Native ETH"  18 dec  1e8 supply
//   0x8719…5d3  symbol "USDT"  name "USDT"        18 dec  1e9 supply
//   0x4669…deef symbol "USDC"  name "USDC"        18 dec  1e9 supply
// Each answered balanceOf() for owner 0x5618…BD12 and each REVERTED on
// tokenReserve()/ethReserve() — plain ERC-20s, no curve, which is why
// the Create and Curve panels are gone rather than rewritten.
//
// The first one is called "ETH" by its own contract. Sepolia's NATIVE
// ETH is a different thing and stays gas only; every row below prints
// the full address so the two can never be confused on screen.
export const DEX_PRESETS = [
  { address: '0x8847346f20aCe5bd4619B7fbF3467D001E269fE9', symbol: 'ETH', name: 'Native ETH', decimals: 18 },
  { address: '0x8719D774726b11497FAddCFdf7bc369C56F6B5d3', symbol: 'USDT', name: 'USDT', decimals: 18 },
  { address: '0x4669689d94991bb4ab6A6e071f9af9CC42d9deef', symbol: 'USDC', name: 'USDC', decimals: 18 },
];

export const DEX_PANELS = ['swap', 'chart', 'liquidity', 'mm'];

export function dexChainId() { return getNetworkById(get('networkId'))?.chainId || 0; }
export function dexChainOk() { return dexChainId() === DEX_CHAIN_ID; }
export function dexPair() { return get('dex.pair') || null; }
function provider() { return get('provider'); }
function ethersLib() { return globalThis.ethers; }
const BROADCAST_TIMEOUT_MS = 15000; // same bound send.js uses

// One path out of the Dex: broadcast with a bound, then wait with a bound.
// A bare tx.wait() hangs forever on a dropped tx, which is exactly what
// send-resilience pins against — and the market maker calls this on every
// step, so a single dropped tx must end the run, not spin it.
// Returns the receipt, or null when the tx did not confirm in time (the
// caller must treat null as "stop", never as success).
async function sendDexTx(promiseFactory, label) {
  let tx;
  try {
    tx = await withTimeout(promiseFactory(), BROADCAST_TIMEOUT_MS, `${label} broadcast`);
  } catch (e) {
    toast((e && (e.shortMessage || e.message)) || String(e), 'error');
    return null;
  }
  const v = receiptVerdict(await waitForReceipt(tx, { label }));
  if (v.kind !== 'success') {
    // 'pending' = sent but not confirmed in time: honest, not a failure to
    // hide. 'failed' = the chain rejected it.
    toast(v.kind === 'failed'
      ? t('dex.tx.failed')
      : t('dex.tx.pending', { hash: String(v.hash || '').slice(0, 10) }), v.kind === 'failed' ? 'error' : 'info');
    return null;
  }
  return v.receipt;
}
function isAddr(v) { return /^0x[0-9a-fA-F]{40}$/.test(String(v || '')); }
function presetBy(addr) {
  const a = String(addr || '').toLowerCase();
  return DEX_PRESETS.find((p) => p.address.toLowerCase() === a) || null;
}

function fmtTok(units, dec = 18, digits = 6) {
  const n = Number(units) / 10 ** dec;
  if (!Number.isFinite(n)) return '0';
  return n.toLocaleString('en-US', { maximumFractionDigits: digits });
}

function logoHtml(tok, size = 32) {
  // bundled: the presets ARE the Dex's own curated registry (same
  // construction as POPULAR_TOKENS): the addresses are hardcoded here, so
  // no user-supplied contract can wear these marks by matching a ticker.
  // The row still prints the full address — identity is the address, the
  // mark is only decoration.
  return tokenLogoHTML(tok.symbol, size, { address: tok.address, bundled: true });
}

// ── the view ───────────────────────────────────────────────────
let bound = false;

export function renderDex(root) {
  if (!root) return;
  if (!get('dex.panel')) set('dex.panel', 'swap');
  if (!bound) {
    root.innerHTML = `
      <div id="dexGate" class="card mb-8" hidden>
        <div class="small"><strong id="dexGateTitle"></strong> <span id="dexGateHow"></span></div>
      </div>
      <div class="field-label" id="dexPairLabel"></div>
      <div id="dexPresets" style="display:flex; flex-direction:column; gap:8px"></div>
      <div id="dexPairInfo" class="small mt-8"></div>
      <div id="dexTabs" class="mt-8" style="display:flex; flex-wrap:wrap; gap:8px" role="group"></div>
      <div id="dexPanelHost" class="mt-8"></div>
    `;
    paintStatic();
    bindTabs();
    // The chain can move under the open view (Settings, dApp request): the
    // gate must follow it, not freeze at whatever it was on first paint.
    on('networkId', () => renderDex(root));
    bound = true;
  }
  paintGate();
  paintPair();
  renderPanel();
}

function paintStatic() {
  $('#dexPairLabel').textContent = t('dex.pair.label');
  $('#dexGateTitle').textContent = t('dex.gate.needSepolia');
  $('#dexGateHow').textContent = t('dex.gate.howto');
  paintPresets();
  const tabs = $('#dexTabs');
  tabs.innerHTML = DEX_PANELS.map((k) => `
    <button type="button" class="btn ${k === get('dex.panel') ? 'btn-primary' : 'btn-secondary'}"
            data-dex-tab="${k}" aria-pressed="${k === get('dex.panel')}">${escapeHtml(t('dex.tab.' + k))}</button>`).join('');
}

// Two rows of preset chips (base / quote). No free-text address box: the
// only pair sides that exist are these three contracts, so a box that
// accepted anything else would promise something the Dex does not do.
function paintPresets() {
  const box = $('#dexPresets');
  const pair = dexPair();
  const row = (role, chosenAddr) => `
    <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap">
      <span class="small" style="min-width:56px">${escapeHtml(t('dex.pair.' + role))}</span>
      ${DEX_PRESETS.map((p) => {
        const on_ = p.address.toLowerCase() === String(chosenAddr || '').toLowerCase();
        return `<button type="button" class="btn ${on_ ? 'btn-primary' : 'btn-secondary'}"
                  data-dex-role="${role}" data-dex-addr="${p.address}"
                  aria-pressed="${on_}" style="display:flex; align-items:center; gap:6px">
                  ${logoHtml(p, 20)}<span>${escapeHtml(p.symbol)}</span></button>`;
      }).join('')}
    </div>`;
  box.innerHTML = row('base', pair && pair.base.address) + row('quote', pair && pair.quote.address);
  guardTokenLogos(box);
}

function bindTabs() {
  $('#dexTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-dex-tab]');
    if (!btn) return;
    // Leaving the Market Maker panel stops the loop: a bot that keeps
    // signing while nobody is watching it is the bug this switch prevents.
    if (get('dex.panel') === 'mm' && btn.dataset.dexTab !== 'mm') stopMM('panel');
    set('dex.panel', btn.dataset.dexTab);
    paintTabs();
    renderPanel();
  });
  $('#dexPresets').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-dex-addr]');
    if (!btn) return;
    const role = btn.dataset.dexRole;
    const other = role === 'base' ? 'quote' : 'base';
    const pair = dexPair();
    loadPair(
      role === 'base' ? btn.dataset.dexAddr : (pair && pair.base.address),
      other === 'quote' ? btn.dataset.dexAddr : (pair && pair.quote.address),
    );
  });
}

function paintTabs() {
  for (const b of document.querySelectorAll('[data-dex-tab]')) {
    const on_ = b.dataset.dexTab === get('dex.panel');
    b.classList.toggle('btn-primary', on_);
    b.classList.toggle('btn-secondary', !on_);
    b.setAttribute('aria-pressed', String(on_));
  }
}

function paintGate() {
  const ok = dexChainOk();
  $('#dexGate').hidden = ok;
  // Every control behind the gate is dimmed AND inert: a button that still
  // clicks on the wrong chain just fails later, with a worse message.
  const dim = (sel, on) => {
    const el = $(sel);
    if (!el) return;
    el.style.opacity = on ? '0.5' : '';
    el.style.pointerEvents = on ? 'none' : '';
    el.setAttribute('aria-disabled', String(on));
  };
  dim('#dexPresets', !ok);
  dim('#dexTabs', !ok);
  dim('#dexPanelHost', !ok);
}

function paintPair() {
  const info = $('#dexPairInfo');
  const pair = dexPair();
  if (!pair) { info.textContent = t('dex.pair.empty'); return; }
  const side = (tok) => `<span style="display:inline-flex; align-items:center; gap:6px">
      ${logoHtml(tok, 20)}<strong>${escapeHtml(tok.symbol)}</strong></span>`;
  info.innerHTML = `${side(pair.base)} <span aria-hidden="true">↔</span> ${side(pair.quote)}
    · ${escapeHtml(t('dex.pair.hint'))}
    <br><span class="mono small">${escapeHtml(pair.base.address)} · ${escapeHtml(pair.quote.address)}</span>`;
  guardTokenLogos(info);
}

// ── pair loading ───────────────────────────────────────────────
// The ONLY writer of dex.pair. Both addresses are checked for the
// 0x+40hex shape before anything else happens — and the metadata comes
// from the preset table, not from an optimistic copy of whatever the
// chips say, so a mistyped address can never reach the chain.
export function loadPair(baseAddr, quoteAddr) {
  if (!dexChainOk()) return toast(t('dex.gate.needSepolia'), 'error');
  const addr = String(baseAddr || '').trim();
  const addr2 = String(quoteAddr || '').trim();
  if (!isAddr(addr) || !isAddr(addr2)) return toast(t('dex.pair.badAddress'), 'error');
  const base = presetBy(addr);
  const quote = presetBy(addr2);
  if (!base || !quote) return toast(t('dex.pair.notPreset'), 'error');
  if (base.address === quote.address) return toast(t('dex.pair.same'), 'error');
  set('dex.pair', { base, quote });
  paintPresets();
  paintPair();
  renderPanel();
}

// ── panels ─────────────────────────────────────────────────────
export function renderPanel() {
  const host = $('#dexPanelHost');
  if (!host) return;
  const kind = get('dex.panel') || 'swap';
  const pair = dexPair();
  // Fire teardown FIRST: the Market Maker panel registers a networkId
  // listener of its own, and clearing innerHTML does not run it — a
  // listener attached to a detached node keeps the loop alive.
  host.dispatchEvent(new CustomEvent('dex:teardown', { bubbles: false }));
  host.innerHTML = '';
  if (!pair) {
    host.innerHTML = `<div class="small">${escapeHtml(t('dex.pair.empty'))}</div>`;
    return;
  }
  PANEL_RENDERERS[kind](host, pair);
}

const PANEL_RENDERERS = {
  swap: (host, pair) => panelSwap(host, pair),
  chart: (host, pair) => panelChart(host, pair),
  liquidity: (host, pair) => panelLiquidity(host, pair),
  mm: (host, pair) => panelMM(host, pair),
};

function panelSwap(host, pair) { host.innerHTML = swapHtml(pair); bindSwap(host, pair); }
function panelChart(host, pair) { host.innerHTML = chartHtml(pair); bindChart(host, pair); }
function panelLiquidity(host, pair) { host.innerHTML = liquidityHtml(pair); bindLiquidity(host, pair); }
function panelMM(host, pair) { host.innerHTML = mmHtml(pair); bindMM(host, pair); }

// Every Dex panel signs through this: the wallet must be connected and
// unlocked, or the panel says which of the two is missing instead of
// throwing on a null signer.
function needSigner() {
  const p = provider();
  const s = get('signer');
  if (!p) { toast(t('dex.needWallet'), 'error'); return null; }
  if (!s || !get('unlocked')) { toast(t('dex.needWallet'), 'error'); return null; }
  return s.connect(p);
}

function v2() { return UNISWAP_V2[DEX_CHAIN_ID]; }

async function poolFor(pair) {
  const E = ethersLib();
  const p = provider();
  if (!p) return null;
  try {
    const f = new E.Contract(v2().factory, V2_FACTORY_ABI, p);
    const addr = await f.getPair(pair.base.address, pair.quote.address);
    if (!addr || /^0x0{40}$/.test(addr)) return null;
    return addr;
  } catch { return null; }
}

// ── M5: swap (token<->token on Sepolia V2, never a WETH side) ──
function swapHtml(pair) {
  const opt = (tok) => `<option value="${tok.address}">${escapeHtml(tok.symbol)}</option>`;
  return `
    <label class="field-label" for="dexSwapFrom">${escapeHtml(t('dex.swap.from'))}</label>
    <div style="display:flex; gap:8px">
      <select id="dexSwapFrom" style="flex:1">${opt(pair.base)}${opt(pair.quote)}</select>
      <button id="dexSwapFlip" type="button" class="btn btn-secondary">${escapeHtml(t('dex.swap.flip'))}</button>
    </div>
    <label class="field-label mt-8" for="dexSwapAmount">${escapeHtml(t('dex.swap.amount'))}</label>
    <div style="display:flex; gap:8px">
      <input id="dexSwapAmount" type="number" min="0" step="any" style="flex:1" inputmode="decimal">
      <button id="dexSwapGo" type="button" class="btn btn-primary">${escapeHtml(t('dex.swap.go'))}</button>
    </div>
    <div id="dexSwapQuote" class="small mt-8"></div>`;
}

function bindSwap(host, pair) {
  const E = ethersLib();
  const fromEl = $('#dexSwapFrom', host);
  const amountEl = $('#dexSwapAmount', host);
  const quoteEl = $('#dexSwapQuote', host);

  const sides = () => {
    const a = fromEl.value.toLowerCase();
    const from = a === pair.base.address.toLowerCase() ? pair.base : pair.quote;
    const to = from === pair.base ? pair.quote : pair.base;
    return { from, to };
  };

  $('#dexSwapFlip', host).addEventListener('click', () => {
    const { to } = sides();
    fromEl.value = to.address;
    quoteEl.textContent = '';
    amountEl.value = '';
  });

  const quote = async () => {
    quoteEl.textContent = '';
    const raw = amountEl.value.trim();
    if (!raw) return;
    const p = provider();
    if (!p) return;
    try {
      const { from, to } = sides();
      const amount = E.parseUnits(raw, from.decimals);
      if (amount <= 0n) return;
      const router = new E.Contract(v2().router, V2_ROUTER_ABI, p);
      const outs = await router.getAmountsOut(amount, [from.address, to.address]);
      quoteEl.textContent = t('dex.swap.quote', { amt: fmtTok(outs[1], to.decimals) + ' ' + to.symbol });
    } catch {
      // No pool for this pair yet. Saying so beats an empty box.
      quoteEl.textContent = t('dex.swap.noRoute');
    }
  };
  amountEl.addEventListener('input', quote);
  fromEl.addEventListener('change', quote);

  $('#dexSwapGo', host).addEventListener('click', async () => {
    const signer = needSigner();
    if (!signer) return;
    const raw = amountEl.value.trim();
    if (!raw) return toast(t('dex.swap.needAmount'), 'error');
    const { from, to } = sides();
    let amount;
    try { amount = E.parseUnits(raw, from.decimals); } catch { return toast(t('dex.swap.needAmount'), 'error'); }
    if (amount <= 0n) return toast(t('dex.swap.needAmount'), 'error');
    try {
      const router = new E.Contract(v2().router, V2_ROUTER_ABI, signer);
      const outs = await router.getAmountsOut(amount, [from.address, to.address]);
      const minOut = outs[1] * 99n / 100n; // 1% slippage, stated in the sheet
      const me = get('address');
      const tok = new E.Contract(from.address, DEX_ERC20_ABI, signer);
      const allowance = await tok.allowance(me, v2().router);

      let approveText = '';
      if (allowance < amount) {
        const okA = await confirmTx({
          title: t('dex.swap.approve'),
          rows: [
            { k: t('dex.pair.label'), v: from.symbol },
            { k: t('dex.swap.amount'), v: raw + ' ' + from.symbol },
            { k: t('dex.swap.to'), v: v2().router },
          ],
          confirmText: t('cf.confirm.send'),
        });
        if (!okA) return;
        const rcA = await sendDexTx(() => tok.approve(v2().router, amount), t('dex.swap.approve'));
        if (!rcA) return;
        toast(t('dex.swap.approved'), 'success');
        approveText = t('dex.swap.approved');
      }

      const okS = await confirmTx({
        title: t('dex.swap.confirmTitle'),
        rows: [
          { k: t('dex.swap.from'), v: raw + ' ' + from.symbol },
          { k: t('dex.swap.to'), v: t('dex.swap.quote', { amt: fmtTok(outs[1], to.decimals) + ' ' + to.symbol }) },
          ...(approveText ? [{ k: t('dex.swap.approve'), v: approveText }] : []),
        ],
        confirmText: t('cf.confirm.send'),
      });
      if (!okS) return;
      const deadline = Math.floor(Date.now() / 1000) + 1200;
      const rcS = await sendDexTx(
        () => router.swapExactTokensForTokens(amount, minOut, [from.address, to.address], me, deadline),
        t('dex.swap.confirmTitle'),
      );
      if (!rcS) return; // not confirmed in time — say so, do not claim success
      toast(t('dex.swap.done'), 'success');
      amountEl.value = '';
      quoteEl.textContent = '';
    } catch (e) { toast((e && (e.shortMessage || e.message)) || String(e), 'error'); }
  });
}

// ── M4: chart (real Swap logs from the pair contract) ──────────
// The chart's window is anchored at the block where this Dex added the
// pool's first liquidity (recorded below). A pool the Dex never touched
// has no anchor, so the window falls back to a fixed lookback and SAYS
// which window it scanned — a chart that quietly showed "all trades"
// while only reading 5000 blocks would be a lie.
const CHART_LOOKBACK = 5000;

function poolSinceKey(pair) {
  return 'dex.poolSince.' + [pair.base.address, pair.quote.address].map((a) => a.toLowerCase()).sort().join('-');
}

function chartHtml(pair) {
  return `
    <div class="field-label">${escapeHtml(t('dex.chart.title'))}</div>
    <div id="dexChartStats" class="small"></div>
    <div id="dexChartBars" style="display:flex; align-items:flex-end; gap:2px; height:120px; margin-top:8px"></div>
    <div id="dexChartEmpty" class="small"></div>`;
}

async function bindChart(host, pair) {
  const E = ethersLib();
  const p = provider();
  const statsEl = $('#dexChartStats', host);
  const bars = $('#dexChartBars', host);
  const emptyEl = $('#dexChartEmpty', host);
  if (!p) { emptyEl.textContent = t('dex.needWallet'); return; }

  const pool = await poolFor(pair);
  if (!pool) { emptyEl.textContent = t('dex.chart.noPool'); return; }

  try {
    const latest = await p.getBlockNumber();
    const since = Number(get(poolSinceKey(pair)) || 0);
    const fromBlock = since > 0 ? since : Math.max(1, latest - CHART_LOOKBACK);

    const iface = new E.Interface(V2_PAIR_ABI);
    const topic = iface.getEvent('Swap').topicHash;
    const logs = await p.getLogs({
      address: pool, fromBlock, toBlock: latest, topics: [topic],
    });

    if (!logs.length) {
      emptyEl.textContent = since > 0 ? t('dex.chart.none') : t('dex.chart.noTrades');
      if (since === 0) statsEl.textContent = t('dex.chart.scanned', { n: String(CHART_LOOKBACK) });
      return;
    }

    const baseIs0 = (await new E.Contract(pool, V2_PAIR_ABI, p).token0()).toLowerCase()
      === pair.base.address.toLowerCase();
    const trades = [];
    for (const l of logs) {
      let args;
      try { args = iface.parseLog({ topics: l.topics, data: l.data }).args; } catch { continue; }
      const a0i = BigInt(args.amount0In), a1i = BigInt(args.amount1In);
      const a0o = BigInt(args.amount0Out), a1o = BigInt(args.amount1Out);
      // price = quote units per 1 base unit, scaled by 1e18 for the bar math
      let price = null, volQuote = 0n;
      if (baseIs0) {
        if (a0i > 0n && a1o > 0n) { price = Number(a1o * 10n ** 18n / a0i); volQuote = a1o; }
        else if (a1i > 0n && a0o > 0n) { price = Number(a1i * 10n ** 18n / a0o); volQuote = a1i; }
      } else {
        if (a1i > 0n && a0o > 0n) { price = Number(a0o * 10n ** 18n / a1i); volQuote = a0o; }
        else if (a0i > 0n && a1o > 0n) { price = Number(a1i * 10n ** 18n / a1o); volQuote = a1i; }
      }
      if (price == null || !Number.isFinite(price) || price <= 0) continue;
      trades.push({ price, volQuote, block: l.blockNumber });
    }
    if (!trades.length) { emptyEl.textContent = t('dex.chart.none'); return; }
    emptyEl.textContent = '';

    const vol = trades.reduce((s, x) => s + x.volQuote, 0n);
    const fmtPrice = (p18) => (p18 / 1e18).toPrecision(6);
    statsEl.textContent = t('dex.chart.stats', {
      n: String(trades.length),
      vol: fmtTok(vol, pair.quote.decimals, 4) + ' ' + pair.quote.symbol,
      first: fmtPrice(trades[0].price),
    }) + (since > 0 ? '' : ' · ' + t('dex.chart.scanned', { n: String(CHART_LOOKBACK) }));

    const buckets = 24;
    const per = Math.max(1, Math.ceil(trades.length / buckets));
    const series = [];
    for (let i = 0; i < trades.length; i += per) series.push(trades[i]);
    const max = Math.max(...series.map((x) => x.price), 1e-12);
    bars.innerHTML = series.map((x) => `<div title="#${x.block} · ${fmtPrice(x.price)}" style="flex:1; min-width:4px; height:${Math.max(2, Math.round((x.price / max) * 110))}px; background:var(--accent, #E8963C); border-radius:3px 3px 0 0"></div>`).join('');
  } catch (e) {
    statsEl.textContent = (e && e.message) || 'error';
  }
}

// ── M5b: liquidity (token<->token pool, created if missing) ────
function liquidityHtml(pair) {
  return `
    <div class="field-label">${escapeHtml(t('dex.liq.title'))}</div>
    <div id="dexLiqReserves" class="small"></div>
    <div id="dexLiqWarn" class="small mt-8"></div>
    <label class="field-label mt-8" for="dexLiqAmountA">${escapeHtml(t('dex.liq.amountA'))} (${escapeHtml(pair.base.symbol)})</label>
    <input id="dexLiqAmountA" type="number" min="0" step="any" inputmode="decimal">
    <label class="field-label mt-8" for="dexLiqAmountB">${escapeHtml(t('dex.liq.amountB'))} (${escapeHtml(pair.quote.symbol)})</label>
    <input id="dexLiqAmountB" type="number" min="0" step="any" inputmode="decimal">
    <button id="dexLiqAdd" type="button" class="btn btn-primary btn-block mt-8">${escapeHtml(t('dex.liq.add'))}</button>
    <div id="dexLiqStatus" class="small mt-8"></div>`;
}

async function bindLiquidity(host, pair) {
  const E = ethersLib();
  const p = provider();
  const reservesEl = $('#dexLiqReserves', host);
  const status = $('#dexLiqStatus', host);
  $('#dexLiqWarn', host).textContent = t('dex.liq.warn');

  const showReserves = async () => {
    if (!p) { reservesEl.textContent = t('dex.needWallet'); return; }
    const pool = await poolFor(pair);
    if (!pool) { reservesEl.textContent = t('dex.liq.none'); return; }
    try {
      const c = new E.Contract(pool, V2_PAIR_ABI, p);
      const [t0, r] = await Promise.all([c.token0(), c.getReserves()]);
      const baseIs0 = t0.toLowerCase() === pair.base.address.toLowerCase();
      reservesEl.innerHTML = `${escapeHtml(t('dex.liq.reserves'))}: `
        + `<strong>${fmtTok(baseIs0 ? r[0] : r[1], pair.base.decimals)} ${escapeHtml(pair.base.symbol)}</strong> · `
        + `<strong>${fmtTok(baseIs0 ? r[1] : r[0], pair.quote.decimals)} ${escapeHtml(pair.quote.symbol)}</strong>`;
    } catch { reservesEl.textContent = t('dex.liq.none'); }
  };
  showReserves();

  $('#dexLiqAdd', host).addEventListener('click', async () => {
    const signer = needSigner();
    if (!signer) return;
    const aRaw = $('#dexLiqAmountA', host).value.trim();
    const bRaw = $('#dexLiqAmountB', host).value.trim();
    if (!aRaw || !bRaw) return toast(t('dex.liq.needAmount'), 'error');
    let amountA, amountB;
    try {
      amountA = E.parseUnits(aRaw, pair.base.decimals);
      amountB = E.parseUnits(bRaw, pair.quote.decimals);
    } catch { return toast(t('dex.liq.needAmount'), 'error'); }
    if (amountA <= 0n || amountB <= 0n) return toast(t('dex.liq.needAmount'), 'error');

    try {
      const me = get('address');
      const existing = await poolFor(pair);
      // Approve both sides — neither token is native, so both are ERC-20s.
      const needs = [];
      for (const [tok, amt] of [[pair.base, amountA], [pair.quote, amountB]]) {
        const c = new E.Contract(tok.address, DEX_ERC20_ABI, signer);
        const allow = await c.allowance(me, v2().router);
        if (allow < amt) needs.push([tok, amt, c]);
      }

      const rows = [
        { k: t('dex.liq.amountA'), v: aRaw + ' ' + pair.base.symbol },
        { k: t('dex.liq.amountB'), v: bRaw + ' ' + pair.quote.symbol },
        ...(existing ? [] : [{ k: t('dex.liq.newPool'), v: t('dex.liq.newPoolYes') }]),
      ];
      const ok = await confirmTx({
        title: existing ? t('dex.liq.confirmTitle') : t('dex.liq.confirmCreate'),
        rows: [...rows, ...(needs.length ? [{ k: t('dex.swap.approve'), v: needs.map((n) => n[0].symbol).join(', ') }] : [])],
        confirmText: t('cf.confirm.send'),
        danger: !existing,
      });
      if (!ok) return;
      for (const [tok, amt, c] of needs) {
        const rcA = await sendDexTx(() => c.approve(v2().router, amt), `${t('dex.swap.approve')} (${tok.symbol})`);
        if (!rcA) return; // a missing approval means the deposit would revert
      }

      const deadline = Math.floor(Date.now() / 1000) + 1200;
      const router = new E.Contract(v2().router, V2_ROUTER_ABI, signer);
      const [aDesired, bDesired, aMin, bMin] = existing
        ? [amountA, amountB, amountA * 99n / 100n, amountB * 99n / 100n]
        : [amountA, amountB, 0n, 0n]; // first deposit sets the ratio: nothing to protect against yet
      const rc = await sendDexTx(() => router.addLiquidity(
        pair.base.address, pair.quote.address, aDesired, bDesired, aMin, bMin, me, deadline,
        { value: 0n }, // never sends native ETH: both sides are tokens
      ), t('dex.liq.add'));
      if (!rc) return;
      // Anchor the chart where this pool actually started for the Dex.
      if (!existing) set(poolSinceKey(pair), Number(rc.blockNumber || 0));
      toast(t('dex.liq.done'), 'success');
      status.textContent = t('dex.liq.done');
      showReserves();
    } catch (e) { status.textContent = (e && (e.shortMessage || e.message)) || String(e); }
  });
}

// ── M6: market maker (real swaps on a timer, gas-capped) ───────
// The bot alternates buy and sell on the selected pair. Its ceiling is
// GAS, measured from the receipts themselves (ethers v6 TransactionReceipt
// exposes gasUsed and gasPrice as bigint — verified in
// node_modules/ethers/lib.commonjs/providers/provider.d.ts:609,629), not a
// guess about what a transaction might cost.
const MM = { timer: null, gasSpent: 0n, steps: 0, running: false, cfg: null, approvals: null };

function mmHtml(pair) {
  return `
    <div class="field-label">${escapeHtml(t('dex.mm.title'))} — ${escapeHtml(pair.base.symbol)} / ${escapeHtml(pair.quote.symbol)}</div>
    <div class="small mb-8">${escapeHtml(t('dex.mm.hint'))}</div>
    <label class="field-label" for="dexMmStep">${escapeHtml(t('dex.mm.step'))}</label>
    <input id="dexMmStep" type="number" min="0" step="any" value="10" inputmode="decimal">
    <label class="field-label mt-8" for="dexMmDelay">${escapeHtml(t('dex.mm.delay'))}</label>
    <input id="dexMmDelay" type="number" min="15" step="1" value="30">
    <label class="field-label mt-8" for="dexMmCap">${escapeHtml(t('dex.mm.cap'))}</label>
    <input id="dexMmCap" type="number" min="0" step="any" value="0.01" inputmode="decimal">
    <div style="display:flex; gap:8px" class="mt-8">
      <button id="dexMmStart" type="button" class="btn btn-primary" style="flex:1">${escapeHtml(t('dex.mm.start'))}</button>
      <button id="dexMmStop" type="button" class="btn btn-danger" style="flex:1">${escapeHtml(t('dex.mm.stop'))}</button>
    </div>
    <div id="dexMmStatus" class="small mt-8"></div>
    <div id="dexMmLog" class="small"></div>`;
}

function stopMM(reason) {
  if (MM.timer) clearTimeout(MM.timer);
  MM.timer = null;
  MM.running = false;
  const st = $('#dexMmStatus');
  if (st) st.textContent = reason === 'panel' ? t('dex.mm.stopped') : (reason || t('dex.mm.stopped'));
}

function bindMM(host, pair) {
  const E = ethersLib();
  const status = $('#dexMmStatus', host);
  const log = $('#dexMmLog', host);

  const onNetwork = () => stopMM(t('dex.mm.stoppedNet'));
  on('networkId', onNetwork);
  // The panel is replaced in place, so a detached host means the user left:
  // the loop must die with it, not keep signing into a DOM nobody sees.
  host.addEventListener('dex:teardown', () => { off('networkId', onNetwork); stopMM(t('dex.mm.stopped')); }, { once: true });

  const step = async () => {
    if (!MM.running) return;
    if (!host.isConnected) { off('networkId', onNetwork); return stopMM(t('dex.mm.stopped')); }
    if (!dexChainOk() || !get('unlocked') || !get('signer') || !provider()) {
      return stopMM(t('dex.mm.stopped'));
    }
    const cfg = MM.cfg;
    const signer = get('signer').connect(provider());
    const buy = MM.steps % 2 === 0;
    const from = buy ? pair.base : pair.quote;
    const to = buy ? pair.quote : pair.base;
    try {
      const amount = E.parseUnits(cfg.stepRaw, from.decimals);
      if (amount <= 0n) return stopMM(t('dex.mm.badSpend'));
      const me = get('address');
      const router = new E.Contract(v2().router, V2_ROUTER_ABI, signer);
      const outs = await router.getAmountsOut(amount, [from.address, to.address]);
      const minOut = outs[1] * 99n / 100n;

      const tok = new E.Contract(from.address, DEX_ERC20_ABI, signer);
      const allow = await tok.allowance(me, v2().router);
      if (allow < amount) {
        // Bounded approval, not unlimited: enough for the configured run.
        const bounded = amount * 1000n;
        const rcA = await sendDexTx(() => tok.approve(v2().router, bounded), t('dex.swap.approve'));
        if (!rcA) return stopMM(t('dex.mm.stopped'));
        MM.gasSpent += BigInt(rcA.gasUsed) * BigInt(rcA.gasPrice);
      }

      const deadline = Math.floor(Date.now() / 1000) + 1200;
      const rc = await sendDexTx(
        () => router.swapExactTokensForTokens(amount, minOut, [from.address, to.address], me, deadline),
        t('dex.swap.confirmTitle'),
      );
      // Unconfirmed or rejected: the run stops here. A market maker that
      // keeps firing after a tx vanishes is how a spend cap gets breached.
      if (!rc) return stopMM(t('dex.mm.stopped'));
      MM.gasSpent += BigInt(rc.gasUsed) * BigInt(rc.gasPrice);
      MM.steps += 1;

      log.innerHTML = `<div>#${MM.steps} ${escapeHtml(t(buy ? 'dex.mm.buy' : 'dex.mm.sell'))} `
        + `${escapeHtml(fmtTok(amount, from.decimals))} ${escapeHtml(from.symbol)} → ${escapeHtml(fmtTok(outs[1], to.decimals))} ${escapeHtml(to.symbol)}`
        + ` · gas ${escapeHtml(E.formatEther(MM.gasSpent))} ETH`
        + ` · <span class="mono">${escapeHtml(String(rc.hash || '').slice(0, 18))}…</span></div>` + log.innerHTML;

      if (MM.gasSpent >= cfg.capWei) return stopMM(t('dex.mm.stoppedCap'));
      status.textContent = t('dex.mm.running', {
        n: String(MM.steps), spent: E.formatEther(MM.gasSpent),
      });
      MM.timer = setTimeout(step, cfg.delayMs);
    } catch (e) {
      const msg = (e && (e.shortMessage || e.message)) || String(e);
      // Out of token on one side is a stop, not a retry loop.
      stopMM(msg);
    }
  };

  $('#dexMmStart', host).addEventListener('click', async () => {
    if (MM.running) return;
    const signer = needSigner();
    if (!signer) return;
    const stepRaw = $('#dexMmStep', host).value.trim() || '0';
    const delayRaw = Number($('#dexMmDelay', host).value.trim() || '0');
    const capRaw = $('#dexMmCap', host).value.trim() || '0';
    if (delayRaw < 15) return toast(t('dex.mm.badDelay'), 'error');
    let capWei, stepDec;
    try {
      capWei = E.parseEther(capRaw);
      stepDec = E.parseUnits(stepRaw, pair.base.decimals);
    } catch { return toast(t('dex.mm.badSpend'), 'error'); }
    if (capWei <= 0n) return toast(t('dex.mm.badSpend'), 'error');
    if (stepDec <= 0n) return toast(t('dex.mm.badSpend'), 'error');

    // The first step buys with pair.base, so the cap must at least cover
    // the gas of one swap plus one approval.
    const okC = await confirmTx({
      title: t('dex.mm.confirmTitle'),
      rows: [
        { k: t('dex.pair.label'), v: pair.base.symbol + ' / ' + pair.quote.symbol },
        { k: t('dex.mm.step'), v: stepRaw + ' (' + t('dex.mm.perStep') + ')' },
        { k: t('dex.mm.delay'), v: delayRaw + 's' },
        { k: t('dex.mm.cap'), v: capRaw + ' ETH' },
        { k: t('dex.swap.approve'), v: t('dex.mm.bounded') },
      ],
      confirmText: t('cf.confirm.send'),
      danger: true,
    });
    if (!okC) return;

    MM.gasSpent = 0n; MM.steps = 0;
    MM.cfg = { stepRaw, capWei, delayMs: delayRaw * 1000 };
    MM.running = true;
    status.textContent = t('dex.mm.running', { n: '0', spent: '0' });
    step();
  });

  $('#dexMmStop', host).addEventListener('click', () => stopMM(t('dex.mm.stopped')));
}
