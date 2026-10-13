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
import { tradesToCandles, drawCandles } from './chart.js';
import { createHtml, bindCreate } from './create.js';
import { tokensHtml, bindTokens, rememberLaunchedToken } from './tokens.js';
import {
  DEX_PRESETS, DEX_NETWORK_ID, DEX_CHAIN_ID,
  dexChainId, dexChainOk, dexPair, provider, ethersLib, sendDexTx, isAddr,
  presetBy, fmtTok, logoHtml, needSigner, v2, poolFor, poolSinceKey,
  t, get, set, on, off, $, toast, escapeHtml, confirmTx, guardTokenLogos,
  UNISWAP_V2, V2_ROUTER_ABI, V2_PAIR_ABI, DEX_ERC20_ABI,
} from './core.js';

// The view re-exports the shared registry so its gate tests (and app.js) read
// one entry point, while the actual values live in core.js (single source of
// truth — a preset address is never written twice).
export { UNISWAP_V2, DEX_PRESETS, DEX_CHAIN_ID, DEX_NETWORK_ID,
  dexChainId, dexChainOk, dexPair };

// Feature tabs. The chart is NOT one of them: it lives inside Swap, above the
// Sell/Buy boxes, so price and trade are on one screen ("itu chartnya kok
// terpisah"). Tokens leads — it is the Dex's home screen (browse everything
// you can trade), then the four things you DO: launch, swap, fund, automate.
export const DEX_PANELS = ['tokens', 'create', 'swap', 'liquidity', 'mm'];

// The three coins make exactly three unordered pairs. Precomputed so the
// picker is a real list, not a guess — and it defaults to the first (ETH/USDT)
// so the Dex opens on a working pair instead of an empty "pick two coins" gate
// (user order: the pair is redundant, the contracts are already fixed).
export const DEX_PAIRS = (() => {
  const out = [];
  for (let i = 0; i < DEX_PRESETS.length; i++) {
    for (let j = i + 1; j < DEX_PRESETS.length; j++) {
      out.push({ base: DEX_PRESETS[i], quote: DEX_PRESETS[j] });
    }
  }
  return out;
})();
const pairKey = (base, quote) => [base, quote].map((a) => String(a).toLowerCase()).sort().join('-');
const pairIndex = (pair) => (pair
  ? DEX_PAIRS.findIndex((p) => pairKey(p.base.address, p.quote.address) === pairKey(pair.base.address, pair.quote.address))
  : -1);

// ── the view ───────────────────────────────────────────────────
let bound = false;

// The three coins make three possible pairs, so the default is not a guess:
// it is the first two presets. On the first open the pair is SET, so every
// panel is immediately live instead of two "pick a base and a quote" gates
// stacked on top of each other (user order: the pair is redundant — the
// contracts are fixed and the pair is already the liquidity list's default).
// Silent by design: the chain gate already refuses a wrong chain, and this
// never signs anything.
function ensureDefaultPair() {
  if (dexPair()) return;
  const [base, quote] = DEX_PRESETS;
  if (!base || !quote || base.address === quote.address) return;
  set('dex.pair', { base, quote });
}

// `fresh` is set only by refreshView() when the user actually OPENS the Dex.
// The networkId listener below re-renders without it, so switching chains
// while the Dex is open never re-shows the welcome screen.
export function renderDex(root, opts = {}) {
  if (!root) return;
  if (!get('dex.panel')) set('dex.panel', 'tokens');
  if (opts.fresh) ensureDefaultPair();
  if (!bound) {
    root.innerHTML = `
      <div id="dexWelcome" class="card mb-8">
        <div style="text-align:center; padding:20px 12px">
          <h2 id="dexWelcomeTitle" style="margin:0 0 14px"></h2>
          <img src="assets/bear.svg" alt="Bear Tool" id="dexWelcomeLogo"
               style="width:104px;height:104px;display:block;margin:0 auto 14px">
          <p id="dexWelcomeSub" class="small" style="max-width:46ch;margin:0 auto 18px"></p>
          <button type="button" class="btn btn-primary" id="dexStartHere"></button>
        </div>
      </div>
      <div id="dexWorkspace" hidden>
        <div id="dexGate" class="card mb-8" hidden>
          <div class="small"><strong id="dexGateTitle"></strong> <span id="dexGateHow"></span></div>
          <button type="button" class="btn btn-primary mt-8" id="dexGateGo"></button>
        </div>
        <div id="dexPairInfo" class="mt-8"></div>
        <div id="dexTabs" class="mt-8" style="display:flex; flex-wrap:wrap; gap:8px" role="group"></div>
        <div id="dexPanelHost" class="mt-8"></div>
      </div>
    `;
    paintStatic();
    bindTabs();
    bindWelcome();
    // The chain can move under the open view (Settings, dApp request): the
    // gate must follow it, not freeze at whatever it was on first paint.
    on('networkId', () => renderDex(root));
    bound = true;
  }
  if (opts.fresh) openWelcome();
  paintGate();
  paintPair();
  renderPanel();
}

// ── the welcome screen ─────────────────────────────────────────
// Order is a direct user order: the heading sits ON TOP, the bear logo sits
// BELOW it, and "Start here" sits under the logo. The workspace (gate, pair
// picker, tabs, panels) stays hidden until Start here is pressed, so the
// first thing a click on "Dex" shows is this — not a wall of buttons.
function bindWelcome() {
  $('#dexStartHere').addEventListener('click', () => {
    $('#dexWelcome').hidden = true;
    $('#dexWorkspace').hidden = false;
    // Keyboard users land on the first feature tab, not back at the top.
    $('#dexTabs')?.querySelector('button')?.focus();
  });
}

function openWelcome() {
  $('#dexWelcome').hidden = false;
  $('#dexWorkspace').hidden = true;
}

function paintStatic() {
  $('#dexWelcomeTitle').textContent = t('dex.welcome.title');
  $('#dexWelcomeSub').textContent = t('dex.welcome.sub');
  $('#dexStartHere').textContent = t('dex.welcome.start');
  $('#dexGateTitle').textContent = t('dex.gate.needSepolia');
  $('#dexGateHow').textContent = t('dex.gate.howto');
  $('#dexGateGo').textContent = t('dex.gate.go');
  $('#dexGateGo').addEventListener('click', switchToSepolia);
  const tabs = $('#dexTabs');
  // One rail, one filled cell: a segmented choice, not five loose buttons.
  tabs.className = 'dex-tabstrip mt-8';
  tabs.innerHTML = DEX_PANELS.map((k) => `
    <button type="button" class="dex-tab" data-dex-tab="${k}"
            aria-pressed="${k === get('dex.panel')}">${escapeHtml(t('dex.tab.' + k))}</button>`).join('');
}

// The coin picker is the TOKEN LIST — one control, not two. The separate
// "Pick a coin" strip duplicated the list and made the top of the Dex read as
// paperwork (user: "pick a coin itu satuin aja sama fitur daftar token").
// Tapping a native coin in the list makes it the base; the quote follows, and
// the Dex opens Swap on it. Nothing is signed here.
export function chooseCoin(address) {
  const base = presetBy(address);
  if (!base) return false;
  const quote = DEX_PRESETS.find((p) => p.address.toLowerCase() !== base.address.toLowerCase());
  if (!quote) return false;
  set('dex.pair', { base, quote });
  paintPair();
  return true;
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
}

function paintTabs() {
  for (const b of document.querySelectorAll('[data-dex-tab]')) {
    // The segmented strip styles off aria-pressed alone (one filled cell), so
    // there is no second class to keep in sync.
    b.setAttribute('aria-pressed', String(b.dataset.dexTab === get('dex.panel')));
  }
}

// The gate's own way out: one click moves the app to Sepolia. getAllNetworks()
// filters every testnet out while Settings → Testnet mode is off, so the flag
// has to come up FIRST through the same single writer Settings uses; then
// activateNetwork is the one switch every other entry point uses (it no-ops
// when the chain is already the target). app.js is imported lazily: a static
// import would close a cycle — app.js already imports this file at line 35.
async function switchToSepolia() {
  if (dexChainOk()) return;
  const app = await import('../app.js');
  const settings = get('settings') || {};
  if (settings.testnet === false) app.setTestnetVisible(true);
  app.activateNetwork(DEX_NETWORK_ID);
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
  dim('#dexTabs', !ok);
  dim('#dexPanelHost', !ok);
}

function paintPair() {
  const info = $('#dexPairInfo');
  info.className = 'dex-pairbar';
  const pair = dexPair();
  if (!pair) {
    // Defensive only: ensureDefaultPair() runs on every fresh open, so a real
    // pair is always present. If it ever is not, say so plainly.
    info.innerHTML = `<span>${escapeHtml(t('dex.pair.empty'))}</span>`;
    return;
  }
  // Just the two coins. The old line also printed "Each side is one of the Dex
  // coins" and both raw addresses — a wall of words and hex that made the top
  // of the Dex read like paperwork. The identities are already shown by the
  // picker above and inside the Swap box; this is a quiet status line.
  const side = (tok) => `<span class="dex-pairbar-coin">${logoHtml(tok, 20)}<strong>${escapeHtml(tok.symbol)}</strong></span>`;
  info.innerHTML = `${side(pair.base)}<span aria-hidden="true">↔</span>${side(pair.quote)}`
    + `<span class="dex-pairbar-note">${escapeHtml(t('dex.pair.active'))}</span>`;
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
  const kind = get('dex.panel') || 'tokens';
  const pair = dexPair();
  // Fire teardown FIRST: the Market Maker panel registers a networkId
  // listener of its own, and clearing innerHTML does not run it — a
  // listener attached to a detached node keeps the loop alive.
  host.dispatchEvent(new CustomEvent('dex:teardown', { bubbles: false }));
  host.innerHTML = '';
  host.className = 'mt-8 dex-panel';
  // Create and Tokens are pair-independent: Create BUILDS a token, and
  // Tokens LISTS them, so neither sits behind "pick a base and a quote".
  if (kind === 'create') { PANEL_RENDERERS.create(host); return; }
  if (kind === 'tokens') { PANEL_RENDERERS.tokens(host); return; }
  if (!pair) {
    // Distinct from the pair hint above: this says WHICH feature is waiting
    // and what unlocks it, instead of repeating the same sentence twice.
    host.innerHTML = `<div class="dex-empty">${escapeHtml(t('dex.panel.locked', { feat: t('dex.tab.' + kind) }))}</div>`;
    return;
  }
  PANEL_RENDERERS[kind](host, pair);
}

const PANEL_RENDERERS = {
  tokens: (host) => panelTokens(host),
  create: (host) => panelCreate(host),
  swap: (host, pair) => panelSwap(host, pair),
  liquidity: (host, pair) => panelLiquidity(host, pair),
  mm: (host, pair) => panelMM(host, pair),
};

// The live token list is the Dex's home screen. Clicking a coin opens Swap
// with that coin as the Sell side — so browsing and trading are one gesture.
// The live token list is the Dex's home screen AND its coin picker — one
// control, not a strip plus a list. Tapping a native coin makes it the base of
// the pair and opens Swap on it, so browsing and trading are one gesture.
// A launched curve token has no preset pair, so tapping it just reports that
// (it trades on its own curve, not against a V2 pair).
function panelTokens(host) {
  host.innerHTML = tokensHtml();
  bindTokens(host, (address) => {
    if (!chooseCoin(address)) {
      toast(t('dex.tokens.noPair'), 'info');
      return;
    }
    set('dex.panel', 'swap');
    paintTabs();
    renderPanel();
    const fromEl = $('#dexSwapFrom');
    if (fromEl) fromEl.value = address;
  });
}

// The launchpad builds a NEW token, so it is the one panel that does not need
// an existing pair — it must open even with no pool, because the pair is
// something the token's buyers will create. renderPanel() would otherwise gate
// it behind "pick a base and a quote", which is exactly wrong here.
export function renderCreatePanel(host) { panelCreate(host); }

function panelCreate(host) { host.innerHTML = createHtml(); bindCreate(host); }

function panelSwap(host, pair) { host.innerHTML = swapHtml(pair); bindSwap(host, pair); }
function panelLiquidity(host, pair) { host.innerHTML = liquidityHtml(pair); bindLiquidity(host, pair); }
function panelMM(host, pair) { host.innerHTML = mmHtml(pair); bindMM(host, pair); }

// ── M5: swap (token<->token on Sepolia V2, never a WETH side) ──
// The mature DEX shape (studied on Uniswap/Jupiter): you always see BOTH
// sides at once — Sell on top, Buy underneath, a flip between them, the
// amount typed inside each box and the coin chosen on the right. The old
// "From ▾ dropdown + one amount field" hid the destination entirely, which
// is exactly the "gajelas" complaint: you could not see what you were buying.
function swapHtml(pair) {
  const opt = (tok) => `<option value="${tok.address}">${escapeHtml(tok.symbol)}</option>`;
  const face = (tok) => `${logoHtml(tok, 20)}<span>${escapeHtml(tok.symbol)}</span>`;
  return `
    <div class="dex-chart-block">
      <div id="dexChartCanvas" style="height:240px"></div>
      <div id="dexChartStats" class="small"></div>
      <div id="dexChartEmpty" class="small"></div>
      <div id="dexChartBars" style="display:flex; align-items:flex-end; gap:2px; height:120px; margin-top:8px" hidden></div>
    </div>

    <div class="dex-swapbox">
      <div class="dex-swapbox-label">${escapeHtml(t('dex.swap.from'))}</div>
      <div class="dex-swapbox-row">
        <input id="dexSwapAmount" type="number" min="0" step="any" inputmode="decimal"
               placeholder="0" aria-label="${escapeHtml(t('dex.swap.amount', { sym: pair.base.symbol }))}">
        <select id="dexSwapFrom" class="dex-swapbox-token" aria-label="${escapeHtml(t('dex.swap.from'))}">${opt(pair.base)}${opt(pair.quote)}</select>
      </div>
      <div class="dex-swapbox-usd small" id="dexSwapUsd"></div>
    </div>

    <button id="dexSwapFlip" type="button" class="dex-swap-flip"
            aria-label="${escapeHtml(t('dex.swap.flip'))}">&#8645;</button>

    <div class="dex-swapbox">
      <div class="dex-swapbox-label">${escapeHtml(t('dex.swap.to'))}</div>
      <div class="dex-swapbox-row">
        <output id="dexSwapReceive" class="dex-swapbox-amount">0</output>
        <span class="dex-swapbox-token dex-swapbox-token--fixed" id="dexSwapToToken">${face(pair.quote)}</span>
      </div>
      <div class="dex-swapbox-usd small" id="dexSwapRate"></div>
    </div>

    <button id="dexSwapGo" type="button" class="btn btn-primary btn-block mt-8">${escapeHtml(t('dex.swap.go'))}</button>
    <div id="dexSwapQuote" class="small mt-8"></div>`;
}

function bindSwap(host, pair) {
  const E = ethersLib();
  const fromEl = $('#dexSwapFrom', host);
  const amountEl = $('#dexSwapAmount', host);
  const quoteEl = $('#dexSwapQuote', host);
  const receiveEl = $('#dexSwapReceive', host);
  const rateEl = $('#dexSwapRate', host);
  const usdEl = $('#dexSwapUsd', host);
  const toFaceEl = $('#dexSwapToToken', host);

  const sides = () => {
    const a = fromEl.value.toLowerCase();
    const from = a === pair.base.address.toLowerCase() ? pair.base : pair.quote;
    const to = from === pair.base ? pair.quote : pair.base;
    return { from, to };
  };

  // Both faces stay correct when the direction changes: the Buy box always
  // shows the coin you are actually buying, not whatever the select started on.
  const syncFaces = () => {
    const { from, to } = sides();
    amountEl.setAttribute('aria-label', t('dex.swap.amount', { sym: from.symbol }));
    toFaceEl.innerHTML = `${logoHtml(to, 20)}<span>${escapeHtml(to.symbol)}</span>`;
    guardTokenLogos(toFaceEl);
    receiveEl.textContent = '0';
    rateEl.textContent = '';
  };
  syncFaces();

  // The chart lives here, not in its own tab ("itu chartnya kok terpisah"):
  // price and trade share one screen, and it is LIVE — the candles grow as
  // trades land. It follows the Sell/Buy direction, so flipping or changing
  // the coin re-plots the other side (the live loop asks `sides()` each tick).
  async function mountChart() {
    for (const sel of ['#dexChartStats', '#dexChartEmpty']) {
      const el = $(sel, host);
      if (el) { el.innerHTML = ''; el.hidden = false; }
    }
    const barsEl = $('#dexChartBars', host);
    if (barsEl) { barsEl.innerHTML = ''; barsEl.hidden = true; }
    const cEl = $('#dexChartCanvas', host);
    if (cEl) cEl.innerHTML = '';
    const { from, to } = sides();
    // First mount starts the live loop; later mounts just repaint, so flipping
    // does not stack a second timer.
    if (host._dexChartTimer) await paintChart(host, { base: from, quote: to });
    else mountLiveChart(host, () => { const s = sides(); return { base: s.from, quote: s.to }; });
  }
  mountChart();

  $('#dexSwapFlip', host).addEventListener('click', () => {
    const { to } = sides();
    fromEl.value = to.address;
    syncFaces();
    quoteEl.textContent = '';
    amountEl.value = '';
    usdEl.textContent = '';
    mountChart();
  });

  const quote = async () => {
    quoteEl.textContent = '';
    receiveEl.textContent = '0';
    rateEl.textContent = '';
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
      receiveEl.textContent = fmtTok(outs[1], to.decimals);
      rateEl.textContent = t('dex.swap.rate', {
        one: '1 ' + from.symbol,
        got: fmtTok(outs[1], to.decimals, 8) + ' ' + to.symbol,
      });
      usdEl.textContent = t('dex.swap.youSell', { amt: raw + ' ' + from.symbol });
    } catch {
      // No pool for this pair yet. Saying so beats an empty box.
      quoteEl.textContent = t('dex.swap.noRoute');
    }
  };
  amountEl.addEventListener('input', quote);
  fromEl.addEventListener('change', () => { syncFaces(); quote(); mountChart(); });

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


// The chart's markup lives inside swapHtml (the chart is part of the Swap
// screen, not a tab), so there is no standalone chartHtml — paintChart() owns
// the drawing and the honest empty states. It is re-entrant on purpose: the
// live wrapper calls it again on a timer to pick up new trades.
async function paintChart(host, pair) {
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

    // Timestamps come from the chain, one per bucket's last block — the chart
    // is a view over real Swap logs, never a market feed.
    const timeCache = new Map();
    const timeForBlock = async (b) => {
      if (!timeCache.has(b)) {
        const blk = await p.getBlock(b);
        timeCache.set(b, Number(blk?.timestamp) || Math.floor(Date.now() / 1000));
      }
      return timeCache.get(b);
    };

    const candles = await tradesToCandles(trades, timeForBlock);
    const canvas = $('#dexChartCanvas', host);
    const barsEl = bars;
    // Library (TradingView lightweight-charts) when it loads; the hand-rolled
    // bars when the CDN is blocked. Either way the data is the same trades.
    const teardown = await drawCandles(canvas, candles, { height: 240 });
    if (teardown) {
      // Remembered so dex:teardown (renderPanel) can remove the chart and its
      // resize listener instead of leaking one per panel open. Replaced (not
      // appended) each repaint so a live chart does not stack charts.
      if (host._dexChartTeardown) { try { host._dexChartTeardown(); } catch { /* already gone */ } }
      host._dexChartTeardown = teardown;
      barsEl.hidden = true;
    } else {
      canvas.hidden = true;
      barsEl.hidden = false;
      const max = Math.max(...candles.map((c) => c.high), 1e-12);
      barsEl.innerHTML = candles.map((c) => `<div title="${fmtPrice(c.close * 1e18)}" style="flex:1; min-width:4px; height:${Math.max(2, Math.round((c.close / max) * 110))}px; background:${c.close >= c.open ? 'var(--mint, #1B8F4E)' : 'var(--berry, #D64545)'}; border-radius:3px 3px 0 0"></div>`).join('');
    }
  } catch (e) {
    statsEl.textContent = (e && e.message) || 'error';
  }
}

// One-shot chart for the Swap screen. Owns its teardown: a chart holds a
// canvas + a resize listener, so switching tabs must remove both, not just
// clear innerHTML (a listener on a detached node keeps running).
export function bindChart(host, pair) {
  host.addEventListener('dex:teardown', () => {
    if (host._dexChartTeardown) { try { host._dexChartTeardown(); } catch { /* already gone */ } host._dexChartTeardown = null; }
  }, { once: true });
  return paintChart(host, pair);
}

// LIVE chart: repaints on a timer so the candles grow as trades land — the
// user asked for trading to show up in real time. `getPair` is a FUNCTION, not
// a fixed pair, so flipping or changing the coin in Swap keeps the live loop
// pointed at the current pair instead of a stale one. The interval is cleared
// on teardown, so leaving the panel stops the network chatter (and the Market
// Maker stops signing once its panel closes).
const LIVE_CHART_MS = 4000;
export function mountLiveChart(host, getPair) {
  if (host._dexChartTimer) return; // already live on this host
  const paint = () => { try { paintChart(host, getPair()); } catch { /* transient */ } };
  paint();
  host._dexChartTimer = setInterval(paint, LIVE_CHART_MS);
  host.addEventListener('dex:teardown', () => {
    if (host._dexChartTimer) { clearInterval(host._dexChartTimer); host._dexChartTimer = null; }
    if (host._dexChartTeardown) { try { host._dexChartTeardown(); } catch { /* already gone */ } host._dexChartTeardown = null; }
  }, { once: true });
}

// ── M5b: liquidity — a LIST of the three possible pools ────────
// The user asked for this to be a list, not a single form
// ("add likuiditas ganti jadi likuiditas nanti ada list gitu"): the three
// coins make three pools, and each row says whether it exists and holds
// liquidity BEFORE you open it. Picking a row reveals the add form for that
// pair. One list, one place to see what exists — a lone form for one pair
// gave no idea what else was already there.
function liquidityHtml(pair) {
  const row = (p, i) => `
    <button type="button" class="dex-pool-row" data-dex-pool="${i}">
      <span class="dex-pool-pair">
        <span class="dex-pool-logos">${logoHtml(p.base, 22)}${logoHtml(p.quote, 22)}</span>
        <strong>${escapeHtml(p.base.symbol)} / ${escapeHtml(p.quote.symbol)}</strong>
      </span>
      <span class="dex-pool-state small" id="dexPoolState${i}">${escapeHtml(t('dex.liq.loading'))}</span>
    </button>`;
  return `
    <div class="field-label">${escapeHtml(t('dex.liq.title'))}</div>
    <div class="small mb-8">${escapeHtml(t('dex.liq.listHint'))}</div>
    <div id="dexLiqList">${DEX_PAIRS.map(row).join('')}</div>
    <div id="dexLiqForm" hidden></div>`;
}

// Reads every pool in the list, then wires row → form. The list is the panel:
// three rows, each reporting its real on-chain state (no pool / reserves), so
// "does this pair exist yet" is answered before any form opens.
async function bindLiquidity(host, pair) {
  const E = ethersLib();
  const p = provider();
  const formHost = $('#dexLiqForm', host);

  const probeRow = async (i, pr) => {
    const cell = $(`#dexPoolState${i}`, host);
    if (!cell) return;
    if (!p) { cell.textContent = t('dex.needWallet'); return; }
    try {
      const pool = await poolFor(pr);
      if (!pool) { cell.textContent = t('dex.liq.noPoolShort'); return; }
      const c = new E.Contract(pool, V2_PAIR_ABI, p);
      const [t0, r] = await Promise.all([c.token0(), c.getReserves()]);
      const baseIs0 = t0.toLowerCase() === pr.base.address.toLowerCase();
      cell.innerHTML = `<strong>${fmtTok(baseIs0 ? r[0] : r[1], pr.base.decimals, 4)} ${escapeHtml(pr.base.symbol)}</strong> · `
        + `${fmtTok(baseIs0 ? r[1] : r[0], pr.quote.decimals, 4)} ${escapeHtml(pr.quote.symbol)}`;
    } catch { cell.textContent = t('dex.liq.none'); }
  };
  DEX_PAIRS.forEach((pr, i) => probeRow(i, pr));

  const openForm = (i) => {
    const pr = DEX_PAIRS[i];
    if (!pr) return;
    formHost.hidden = false;
    formHost.innerHTML = `
      <div class="dex-subhead">${escapeHtml(pr.base.symbol)} / ${escapeHtml(pr.quote.symbol)}</div>
      <div id="dexLiqReserves" class="small"></div>
      <div id="dexLiqWarn" class="small mt-8">${escapeHtml(t('dex.liq.warn'))}</div>
      <label class="field-label mt-8" for="dexLiqAmountA">${escapeHtml(t('dex.liq.amountA'))} (${escapeHtml(pr.base.symbol)})</label>
      <div class="dex-amount-row">
        <input id="dexLiqAmountA" class="input" type="number" min="0" step="any" inputmode="decimal" placeholder="0">
        <button type="button" class="btn btn-secondary dex-max" id="dexLiqMaxA">${escapeHtml(t('dex.liq.max'))}</button>
      </div>
      <div class="small dex-balance" id="dexLiqBalA"></div>
      <label class="field-label mt-8" for="dexLiqAmountB">${escapeHtml(t('dex.liq.amountB'))} (${escapeHtml(pr.quote.symbol)})</label>
      <div class="dex-amount-row">
        <input id="dexLiqAmountB" class="input" type="number" min="0" step="any" inputmode="decimal" placeholder="0">
        <button type="button" class="btn btn-secondary dex-max" id="dexLiqMaxB">${escapeHtml(t('dex.liq.max'))}</button>
      </div>
      <div class="small dex-balance" id="dexLiqBalB"></div>
      <div class="dex-price-preview" id="dexLiqPrice"></div>
      <button id="dexLiqAdd" type="button" class="btn btn-primary btn-block mt-8">${escapeHtml(t('dex.liq.add'))}</button>
      <button type="button" class="btn btn-secondary btn-block mt-8" id="dexLiqClose">${escapeHtml(t('dex.liq.close'))}</button>
      <div id="dexLiqStatus" class="small mt-8"></div>`;
    guardTokenLogos(formHost);
    $('#dexLiqClose', host).addEventListener('click', () => { formHost.hidden = true; formHost.innerHTML = ''; });
    bindLiqForm(host, pr, probeRow, DEX_PAIRS.indexOf(pr));
  };
  formHost.hidden = true;

  $('#dexLiqList', host).addEventListener('click', (e) => {
    const row = e.target.closest('[data-dex-pool]');
    if (row) openForm(Number(row.dataset.dexPool));
  });
}

// The add-liquidity transaction for one pair — unchanged in substance from the
// old single form, now scoped to the row that was opened.
function bindLiqForm(host, pair, probeRow, pairIdx) {
  const E = ethersLib();
  const p = provider();
  const reservesEl = $('#dexLiqReserves', host);
  const status = $('#dexLiqStatus', host);

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

  // The button says what it will actually do: a pool that does not exist yet
  // gets CREATED by this deposit, and the ratio typed here becomes its price.
  // Saying "add liquidity" for a pool that is not there hides the one thing the
  // user has to decide (user: "pool not found … berapa yang harus ku add?").
  const addBtn = $('#dexLiqAdd', host);
  if (addBtn) {
    const setLabel = (exists) => { addBtn.textContent = exists ? t('dex.liq.add') : t('dex.liq.create'); };
    if (p) poolFor(pair).then((pool) => setLabel(!!pool)).catch(() => setLabel(false));
    else setLabel(false);
  }

  // ── "how much do I add?" answered in the form itself ──────────
  // A brand-new pool has no price: the first deposit's RATIO becomes the
  // price. So the form shows the real balance, a Max button per side, and a
  // live readout of the price the typed amounts would set — the user decides
  // the number, and can see exactly what it means in price terms.
  const aEl = $('#dexLiqAmountA', host);
  const bEl = $('#dexLiqAmountB', host);
  const priceEl = $('#dexLiqPrice', host);

  const showPrice = () => {
    if (!priceEl) return;
    const a = Number((aEl.value || '').trim());
    const b = Number((bEl.value || '').trim());
    if (!(a > 0) || !(b > 0)) { priceEl.textContent = t('dex.liq.priceHint'); return; }
    const ratio = (b / a).toLocaleString('en-US', { maximumFractionDigits: 6 });
    priceEl.textContent = t('dex.liq.priceSet', { ratio, base: pair.base.symbol, quote: pair.quote.symbol });
  };
  if (aEl && bEl) {
    aEl.addEventListener('input', showPrice);
    bEl.addEventListener('input', showPrice);
    showPrice();
  }

  const showBalance = async (tok, elId, inputId, maxId) => {
    const balEl = $(elId, host);
    const input = $(inputId, host);
    const maxBtn = $(maxId, host);
    if (!balEl) return;
    if (!p) { balEl.textContent = t('dex.needWallet'); return; }
    let bal = 0n;
    try {
      const c = new E.Contract(tok.address, DEX_ERC20_ABI, p);
      bal = await c.balanceOf(get('address'));
    } catch { balEl.textContent = t('dex.liq.balanceFail'); return; }
    balEl.textContent = t('dex.liq.balance', { amt: fmtTok(bal, tok.decimals, 4), sym: tok.symbol });
    if (maxBtn && input) {
      maxBtn.addEventListener('click', () => {
        // Leave a hair of dust: some ERC-20s reject a zero-balance transfer,
        // and the router needs the exact figure to match the reserve.
        const usable = bal > 1n ? bal - 1n : 0n;
        input.value = E.formatUnits(usable, tok.decimals).replace(/\.?0+$/, '') || '0';
        showPrice();
      });
    }
  };
  showBalance(pair.base, '#dexLiqBalA', '#dexLiqAmountA', '#dexLiqMaxA');
  showBalance(pair.quote, '#dexLiqBalB', '#dexLiqAmountB', '#dexLiqMaxB');

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
      if (typeof probeRow === 'function' && pairIdx >= 0) probeRow(pairIdx, pair);
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
    <div class="dex-mm-balances small" id="dexMmBalances"></div>
    <div class="dex-chart-block">
      <div class="small"><strong>${escapeHtml(t('dex.mm.liveChart'))}</strong></div>
      <div id="dexChartCanvas" style="height:200px"></div>
      <div id="dexChartStats" class="small"></div>
      <div id="dexChartEmpty" class="small"></div>
      <div id="dexChartBars" style="display:flex; align-items:flex-end; gap:2px; height:110px; margin-top:8px" hidden></div>
    </div>
    <label class="field-label mt-8" for="dexMmStep">${escapeHtml(t('dex.mm.step'))}</label>
    <input id="dexMmStep" class="input" type="number" min="0" step="any" value="10" inputmode="decimal">
    <label class="field-label mt-8" for="dexMmDelay">${escapeHtml(t('dex.mm.delay'))}</label>
    <input id="dexMmDelay" class="input" type="number" min="15" step="1" value="30">
    <label class="field-label mt-8" for="dexMmCap">${escapeHtml(t('dex.mm.cap'))}</label>
    <input id="dexMmCap" class="input" type="number" min="0" step="any" value="0.01" inputmode="decimal">
    <div style="display:flex; gap:8px" class="mt-8">
      <button id="dexMmStart" type="button" class="btn btn-primary" style="flex:1">${escapeHtml(t('dex.mm.fundRun'))}</button>
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
  // The bot's own trading, charted live. Same paint loop as the Swap screen,
  // so every buy/sell the bot lands shows up on the candles while it runs.
  mountLiveChart(host, () => pair);

  // "Add funds" needs a number to be honest about: show what the wallet
  // actually holds of both sides, read from chain (never a made-up figure).
  (async () => {
    const el = $('#dexMmBalances', host);
    if (!el) return;
    const p = provider();
    if (!p) { el.textContent = t('dex.needWallet'); return; }
    try {
      const bal = async (tok) => {
        const c = new E.Contract(tok.address, DEX_ERC20_ABI, p);
        return fmtTok(await c.balanceOf(get('address')), tok.decimals, 4);
      };
      el.textContent = t('dex.mm.balances', {
        a: await bal(pair.base), base: pair.base.symbol,
        b: await bal(pair.quote), quote: pair.quote.symbol,
      });
    } catch { el.textContent = t('dex.liq.balanceFail'); }
  })();

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
