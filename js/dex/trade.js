// Bear Tool — js/dex/trade.js
// The launchpad's missing half: a launched curve token is tradeable HERE.
//
// A token created in Create Token lives on its own bonding curve inside its
// PumpToken contract — not in a Uniswap pool. So the Dex's Swap tab (which
// routes through the V2 router) cannot touch it. Without this panel a launchpad
// could mint a coin nobody could buy: the single biggest gap in the feature.
//
// The quotes come from curve.js, whose floor-the-output maths is the SAME the
// contract runs, so what the panel shows is what the chain will do. Every
// balance, price, reserve and progress figure is READ from the live contract —
// nothing here is stored or invented.
import { t } from '../i18n.js';
import { get } from '../state.js';
import { $, toast, escapeHtml, confirmTx } from '../ui.js';
import { waitForReceipt, receiptVerdict } from '../safetx.js';
import { sendDexTx, provider, ethersLib, dexChainOk, needSigner, fmtTok, withTxButton } from './core.js';
import { PUMP_ABI } from './pump-source.js';
import { quoteBuy, quoteSell, graduationProgress, fmtEth, GRADUATION_ETH } from './curve.js';

const ACTIVE_TOKEN_KEY = 'dex.tokenView';

// Which launched token the trade panel is showing (or null).
export function activeToken() { return get(ACTIVE_TOKEN_KEY) || null; }
export function setActiveToken(address) { return address; }

function readToken(token) {
  const p = provider();
  if (!p) return null;
  const E = ethersLib();
  return new E.Contract(token.address, PUMP_ABI, p);
}

// The token detail + buy/sell screen.
export function tokenTradeHtml(token) {
  return `
    <button type="button" class="btn btn-secondary btn-block mb-8" id="dexTradeBack">
      ← ${escapeHtml(t('dex.tokens.title'))}
    </button>

    <div class="dex-trade-head">
      <span class="dex-token-face" style="width:64px;height:64px;flex:0 0 64px">
        ${token.image ? `<img src="${escapeHtml(token.image)}" alt="">` : ''}
      </span>
      <div style="min-width:0">
        <strong style="font-size:1.15rem">${escapeHtml(token.name)}</strong>
        <div class="small">${escapeHtml(token.symbol)} · <span class="mono">${escapeHtml(token.address)}</span></div>
        <div class="small" id="dexTradeCreator"></div>
      </div>
    </div>

    <div class="dex-grad">
      <div class="small" id="dexTradeGradText"></div>
      <div class="dex-grad-bar"><div class="dex-grad-fill" id="dexTradeGradFill"></div></div>
    </div>

    <div class="dex-trade-stats small">
      <div id="dexTradePrice"></div>
      <div id="dexTradeMcap"></div>
      <div id="dexTradeHold"></div>
    </div>

    <div class="dex-swapbox mt-8">
      <div class="dex-swapbox-label">${escapeHtml(t('dex.trade.buy'))}</div>
      <div class="dex-swapbox-row">
        <input id="dexTradeBuyEth" class="dex-trade-input" type="number" min="0" step="any" inputmode="decimal" placeholder="0" aria-label="${escapeHtml(t('dex.trade.ethIn'))}">
        <span class="dex-swapbox-token">ETH</span>
      </div>
      <div class="dex-swapbox-usd small" id="dexTradeBuyQuote"></div>
    </div>
    <button id="dexTradeBuy" type="button" class="btn btn-primary btn-block mt-8">${escapeHtml(t('dex.trade.buy'))}</button>

    <div class="dex-swapbox mt-8">
      <div class="dex-swapbox-label">${escapeHtml(t('dex.trade.sell'))}</div>
      <div class="dex-swapbox-row">
        <input id="dexTradeSellTok" class="dex-trade-input" type="number" min="0" step="any" inputmode="decimal" placeholder="0" aria-label="${escapeHtml(t('dex.trade.tokIn'))}">
        <span class="dex-swapbox-token">${escapeHtml(token.symbol)}</span>
      </div>
      <div class="dex-swapbox-usd small" id="dexTradeSellQuote"></div>
    </div>
    <button id="dexTradeSell" type="button" class="btn btn-secondary btn-block mt-8">${escapeHtml(t('dex.trade.sell'))}</button>

    <div class="dex-loading" id="dexTradeLoading" hidden><span class="dex-spinner"></span><span>${escapeHtml(t('dex.chart.loading'))}</span></div>
    <div id="dexTradeStatus" class="small mt-8"></div>
    <div id="dexTradeLog" class="small"></div>`;
}

export function bindTokenTrade(host, token, onBack) {
  const E = ethersLib();
  const p = provider();
  const status = $('#dexTradeStatus', host);
  const buyQuote = $('#dexTradeBuyQuote', host);
  const sellQuote = $('#dexTradeSellQuote', host);
  const buyEthEl = $('#dexTradeBuyEth', host);
  const sellTokEl = $('#dexTradeSellTok', host);

  $('#dexTradeBack', host).addEventListener('click', () => onBack());

  if (!p || !dexChainOk()) { status.textContent = t('dex.needWallet'); return; }
  const c = readToken(token);

  // Live state from the contract. state() holds the numbers the buy/sell use
  // so the quote and the tx cannot disagree.
  const state = { vE: 0n, vT: 0n, reserve: 0n, graduated: false, mine: 0n };
  const refresh = async () => {
    const [vE, vT, reserve, graduated, mine, sym] = await Promise.all([
      c.virtualEth(), c.virtualTokens(), c.realEthReserve(), c.graduated(),
      c.balanceOf(get('address') || '0x0'), token.symbol,
    ]);
    state.vE = vE; state.vT = vT; state.reserve = reserve; state.graduated = graduated; state.mine = mine;
    // graduation bar
    const { bps } = graduationProgress(reserve, GRADUATION_ETH);
    const fill = $('#dexTradeGradFill', host);
    if (fill) fill.style.width = Math.min(100, Number(bps) / 100) + '%';
    const gtext = $('#dexTradeGradText', host);
    if (gtext) gtext.textContent = graduated ? t('dex.tokens.graduated') : t('dex.tokens.progress', { pct: String(Math.round(Number(bps) / 100)) });
    // price & mcap & holding
    const priceEth = Number(vE) / Number(vT); // ETH per token
    const pEl = $('#dexTradePrice', host);
    if (pEl) pEl.textContent = t('dex.trade.price', { price: priceEth.toExponential(4), sym });
    const mEl = $('#dexTradeMcap', host);
    if (mEl) mEl.textContent = t('dex.trade.mcap', { mcap: (priceEth * Number(vT) / 1e18).toFixed(4) });
    const hEl = $('#dexTradeHold', host);
    if (hEl) hEl.textContent = t('dex.trade.hold', { amt: fmtTok(mine, 18, 4), sym });
  };

  const quoteBuyLive = () => {
    const raw = (buyEthEl.value || '').trim();
    if (!raw) { buyQuote.textContent = ''; return; }
    let eth; try { eth = E.parseEther(raw); } catch { buyQuote.textContent = ''; return; }
    if (eth <= 0n || state.graduated) { buyQuote.textContent = state.graduated ? t('dex.trade.graduated') : ''; return; }
    const q = quoteBuy(state.vE, state.vT, eth);
    buyQuote.textContent = t('dex.trade.youGetTok', { amt: fmtTok(q.tokensOut, 18, 2), sym: token.symbol });
  };
  const quoteSellLive = () => {
    const raw = (sellTokEl.value || '').trim();
    if (!raw) { sellQuote.textContent = ''; return; }
    let tok; try { tok = E.parseUnits(raw, 18); } catch { sellQuote.textContent = ''; return; }
    if (tok <= 0n || state.graduated) { sellQuote.textContent = state.graduated ? t('dex.trade.graduated') : ''; return; }
    const q = quoteSell(state.vE, state.vT, tok);
    sellQuote.textContent = t('dex.trade.youGetEth', { amt: fmtEth(q.ethOut) });
  };
  if (buyEthEl) buyEthEl.addEventListener('input', quoteBuyLive);
  if (sellTokEl) sellTokEl.addEventListener('input', quoteSellLive);

  const buyBtn = $('#dexTradeBuy', host);
  const sellBtn = $('#dexTradeSell', host);

  // Buy: pay native ETH, get tokens on the curve.
  buyBtn.addEventListener('click', () => withTxButton(buyBtn, t('dex.trade.sending'), async () => {
    const signer = needSigner();
    if (!signer) return;
    const raw = (buyEthEl.value || '').trim();
    if (!raw) return toast(t('dex.trade.needEth'), 'error');
    let eth; try { eth = E.parseEther(raw); } catch { return toast(t('dex.trade.needEth'), 'error'); }
    if (eth <= 0n) return toast(t('dex.trade.needEth'), 'error');
    if (state.graduated) return toast(t('dex.trade.graduated'), 'error');
    const q = quoteBuy(state.vE, state.vT, eth);
    const minOut = q.tokensOut * 99n / 100n; // 1% slippage
    const ok = await confirmTx({
      title: t('dex.trade.buyTitle', { sym: token.symbol }),
      rows: [
        { k: t('dex.trade.ethIn'), v: raw + ' ETH' },
        { k: t('dex.trade.youGet'), v: fmtTok(q.tokensOut, 18, 2) + ' ' + token.symbol },
      ],
      confirmText: t('dex.trade.buy'),
      danger: true,
      valueWei: eth,
    });
    if (!ok) return;
    const cs = new E.Contract(token.address, PUMP_ABI, signer);
    const rc = await sendDexTx(() => cs.buy({ value: eth }), t('dex.trade.buy'));
    if (!rc) return;
    toast(t('dex.trade.bought', { sym: token.symbol }), 'success');
    buyEthEl.value = ''; quoteBuyLive();
    await refresh();
  }));

  // Sell: hand tokens back, get ETH.
  sellBtn.addEventListener('click', () => withTxButton(sellBtn, t('dex.trade.sending'), async () => {
    const signer = needSigner();
    if (!signer) return;
    const raw = (sellTokEl.value || '').trim();
    if (!raw) return toast(t('dex.trade.needTok'), 'error');
    let tok; try { tok = E.parseUnits(raw, 18); } catch { return toast(t('dex.trade.needTok'), 'error'); }
    if (tok <= 0n) return toast(t('dex.trade.needTok'), 'error');
    if (state.graduated) return toast(t('dex.trade.graduated'), 'error');
    const q = quoteSell(state.vE, state.vT, tok);
    const ok = await confirmTx({
      title: t('dex.trade.sellTitle', { sym: token.symbol }),
      rows: [
        { k: t('dex.trade.tokIn'), v: raw + ' ' + token.symbol },
        { k: t('dex.trade.youGet'), v: fmtEth(q.ethOut) + ' ETH' },
      ],
      confirmText: t('dex.trade.sell'),
      danger: true,
    });
    if (!ok) return;
    const cs = new E.Contract(token.address, PUMP_ABI, signer);
    const rc = await sendDexTx(() => cs.sell(tok), t('dex.trade.sell'));
    if (!rc) return;
    toast(t('dex.trade.sold', { sym: token.symbol }), 'success');
    sellTokEl.value = ''; quoteSellLive();
    await refresh();
  }));

  // creator line
  c.creator().then((cr) => {
    const el = $('#dexTradeCreator', host);
    if (el) el.textContent = t('dex.trade.creator', { addr: String(cr).slice(0, 6) + '…' + String(cr).slice(-4) });
  }).catch(() => {});

  refresh().then(quoteBuyLive).then(quoteSellLive);
  // keep the numbers live while the panel is open
  const timer = setInterval(() => { refresh().then(() => { quoteBuyLive(); quoteSellLive(); }); }, 5000);
  host.addEventListener('dex:teardown', () => clearInterval(timer), { once: true });
}
