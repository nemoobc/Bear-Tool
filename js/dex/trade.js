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
import { sendDexTx, provider, ethersLib, dexChainOk, needSigner, fmtTok, withTxButton, ERC20_ABI, quoteBy } from './core.js';
import { PUMP_ABI } from './pump-source.js';
import { quoteBuy, quoteSell, graduationProgress, fmtEth, GRADUATION_QUOTE, VIRTUAL_QUOTE, VIRTUAL_TOKENS } from './curve.js';
import { drawCandles } from './chart.js';
import { botHtml, bindBot } from './bot.js';
import { loadHistory, historyCandles, tradesHtml } from './history.js';

function readToken(token) {
  const p = provider();
  if (!p) return null;
  const E = ethersLib();
  return new E.Contract(token.address, PUMP_ABI, p);
}

// The token detail + buy/sell screen.
// How far the curve may move against the user before the trade is refused, in
// basis points. 100 = 1%. The floor is enforced by the CONTRACT (see
// pump-source.js), so this is the real protection, not a label on it.
const SLIPPAGE_BPS = 100n;

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
        <strong style="font-size:1.15rem" id="dexTradeName">${escapeHtml(token.name)}</strong>
        <div class="small" id="dexTradeSymbol">${escapeHtml(token.symbol)} · <span class="mono">${escapeHtml(token.address)}</span></div>
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

    <div class="dex-chart-block mt-8">
      <div class="small"><strong>${escapeHtml(t('dex.trade.price'))}</strong></div>
      <div id="dexTradeChart" class="dex-chart-host" role="img"
           aria-label="${escapeHtml(t('dex.trade.chartAria'))}"></div>
      <div class="dex-loading" id="dexTradeChartLoading" hidden><span class="dex-spinner"></span><span>${escapeHtml(t('dex.chart.loading'))}</span></div>
      <div class="small mt-8" id="dexTradeCurveInfo"></div>
    </div>

    <div class="mt-8">
      <div class="small"><strong>${escapeHtml(t('dex.trades.title'))}</strong></div>
      <div id="dexTradeTape"></div>
    </div>

    <details class="dex-curve-details mt-8">
      <summary class="small">${escapeHtml(t('dex.trade.curve'))}</summary>
      <canvas id="dexTradeCurve" height="150"></canvas>
      <div class="small" id="dexTradeCurveInfo2"></div>
    </details>

    <div class="dex-swapbox mt-8">
      <div class="dex-swapbox-label">${escapeHtml(t('dex.trade.buy'))}</div>
      <div class="dex-swapbox-row">
        <input id="dexTradeBuyEth" class="dex-trade-input" type="number" min="0" step="any" inputmode="decimal" placeholder="0" aria-label="${escapeHtml(t('dex.trade.ethIn'))}">
        <span class="dex-swapbox-token" id="dexTradeQuoteToken">ETH</span>
      </div>
      <div class="dex-swapbox-usd small" id="dexTradeBuyQuote"></div>
      <!-- Percentages of what you actually hold. Without them the buy box makes
           you type an amount out of thin air, which is the single biggest
           difference from every real launchpad: you know your balance, so the
           useful answer to "how much?" is "a quarter of it". -->
      <div class="dex-pctrow" role="group" aria-label="${escapeHtml(t('dex.trade.buyPct'))}">
        <span class="small dex-pctbal" id="dexTradeQuoteBal"></span>
        ${[25, 50, 75, 100].map((pc) => `<button type="button" class="dex-pct" data-dex-pct="${pc}">${pc === 100 ? escapeHtml(t('dex.trade.max')) : pc + '%'}</button>`).join('')}
      </div>
    </div>
    <button id="dexTradeBuy" type="button" class="btn btn-primary btn-block mt-8">${escapeHtml(t('dex.trade.buy'))}</button>

    <div class="dex-swapbox mt-8">
      <div class="dex-swapbox-label">${escapeHtml(t('dex.trade.sell'))}</div>
      <div class="dex-swapbox-row">
        <input id="dexTradeSellTok" class="dex-trade-input" type="number" min="0" step="any" inputmode="decimal" placeholder="0" aria-label="${escapeHtml(t('dex.trade.tokIn'))}">
        <span class="dex-swapbox-token" id="dexTradeSellToken">${escapeHtml(token.symbol)}</span>
      </div>
      <div class="dex-swapbox-usd small" id="dexTradeSellQuote"></div>
      <div class="dex-pctrow" role="group" aria-label="${escapeHtml(t('dex.trade.sellPct'))}">
        <span class="small dex-pctbal" id="dexTradeTokenBal"></span>
        ${[25, 50, 75, 100].map((pc) => `<button type="button" class="dex-pct" data-dex-sell-pct="${pc}">${pc === 100 ? escapeHtml(t('dex.trade.max')) : pc + '%'}</button>`).join('')}
      </div>
    </div>
    <button id="dexTradeSell" type="button" class="btn btn-secondary btn-block mt-8">${escapeHtml(t('dex.trade.sell'))}</button>

    <button id="dexTradeClaim" type="button" class="btn btn-secondary btn-block mt-8" hidden>${escapeHtml(t('dex.trade.claimFees'))}</button>
    <button id="dexTradeGraduate" type="button" class="btn btn-primary btn-block mt-8" hidden>${escapeHtml(t('dex.trade.graduate'))}</button>

    ${botHtml()}

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

  // ── price chart + trade tape ──────────────────────────────────
  // Both read the SAME thing: the curve's own Bought/Sold events. One fetch
  // feeds both, so the tape can never disagree with the chart above it.
  const chartHost = $('#dexTradeChart', host);
  const chartLoading = $('#dexTradeChartLoading', host);
  const tapeHost = $('#dexTradeTape', host);
  let chartTearDown = null;

  // The chart mounts whether or not there is anything to plot. That is
  // deliberate on both counts: a coin with no trades gets an empty candlestick
  // frame with its axes, and a visitor with NO WALLET gets the same frame
  // instead of an empty div — a blank box read as "the chart is broken", which
  // is exactly the "chart ga keliatan" report this was meant to end.
  const paintChart = async (candles) => {
    if (chartTearDown) { try { chartTearDown(); } catch { /* already gone */ } chartTearDown = null; }
    if (chartHost) chartTearDown = await drawCandles(chartHost, candles, { height: 220 });
  };

  if (!p || !dexChainOk()) {
    status.textContent = t('dex.needWallet');
    if (tapeHost) tapeHost.innerHTML = tradesHtml([], token.symbol || '');
    paintChart([]);
    return;
  }
  const c = readToken(token);

  const paintHistory = async () => {
    if (chartLoading) chartLoading.hidden = false;
    const hist = await loadHistory(c, p);
    if (chartLoading) chartLoading.hidden = true;
    if (tapeHost) tapeHost.innerHTML = tradesHtml(hist.trades, state.sym || token.symbol || '');
    const candles = await historyCandles(hist.trades);
    await paintChart(candles);
  };
  host.addEventListener('dex:teardown', () => { if (chartTearDown) { try { chartTearDown(); } catch { /* already gone */ } } }, { once: true });

  // Live state from the contract. state() holds the numbers the buy/sell use
  // so the quote and the tx cannot disagree.
  const state = {
    vE: 0n, vT: 0n, reserve: 0n, graduated: false, mine: 0n, readable: false,
    sym: token.symbol || '', quoteBal: 0n, quoteAddr: '', quoteSym: '', quoteDec: 18,
  };
  const refresh = async () => {
    // balanceOf needs a real 20-byte address. '0x0' is NOT one — it made ethers
    // reject, and because the reads shared one Promise.all, a wallet-less
    // visitor lost the PRICE, the market cap and the graduation bar too, not
    // just their own balance. So a missing wallet means "no balance", never
    // "no page".
    const me = get('address');
    // NOTE: this order MUST match the Promise.all below it. It did not, once:
    // ethBal was bound to the ticker's string and the balance rendered as NaN.
    const [vE, vT, reserve, graduated, mine, quoteAddr, name, sym] = await Promise.all([
      c.virtualQuote(), c.virtualTokens(), c.realQuoteReserve(), c.graduated(),
      me ? c.balanceOf(me) : Promise.resolve(0n),
      // Which coin this curve is quoted in. Everything else — the balance, the
      // percentage buttons, the unit on every price — comes from HERE, not from
      // the chain's native token: Sepolia ETH pays gas only.
      c.quoteToken().catch(() => ''),
      // The contract, not the local index, is the authority on what this coin
      // IS. A coin discovered from the chain (another device, or before a storage
      // wipe) arrives with an empty name/symbol, and every label on the page has
      // to show what the contract says rather than a blank header.
      c.name().catch(() => ''),
      c.symbol().catch(() => ''),
    ]).catch((e) => {
      // A failed read must SAY SO. Letting it throw left the last-known price,
      // market cap and graduation bar on screen with nothing saying they were
      // stale — numbers that looked live and were not. Mark the page instead.
      state.readable = false;
      if (status) {
        status.textContent = t('dex.trade.readFailed', {
          err: (e && (e.shortMessage || e.message)) || String(e),
        });
      }
      return null;
    });
    if (!vE) return;
    state.readable = true;

    // Resolve the quote coin once: its symbol labels every price, and its
    // balance is what the percentage buttons divide. A failure here leaves the
    // price intact and the buttons inert — never a guess.
    state.quoteAddr = String(quoteAddr || '');
    if (state.quoteAddr && E) {
      const qc = new E.Contract(state.quoteAddr, ERC20_ABI, p);
      const [symRaw, decRaw, balRaw] = await Promise.all([
        qc.symbol().catch(() => ''),
        qc.decimals().catch(() => 18),
        me ? qc.balanceOf(me).catch(() => 0n) : Promise.resolve(0n),
      ]);
      state.quoteSym = String(symRaw || (quoteBy(state.quoteAddr)?.symbol || ''));
      state.quoteDec = Number(decRaw) || 18;
      state.quoteBal = balRaw || 0n;
      const label = $('#dexTradeQuoteToken', host);
      if (label) label.textContent = state.quoteSym || '';
    }

    // Prefer the on-chain identity; fall back to the local index only when the
    // contract could not be asked.
    // One ticker for the whole screen, taken from the contract. Every label and
    // every dialog below reads it, so a coin discovered from the chain (empty
    // local name/symbol) still says what it is instead of quoting an empty
    // string into the confirm box.
    state.sym = sym || token.symbol || '';
    if (name || sym) {
      const nameEl = $('#dexTradeName', host);
      const symEl = $('#dexTradeSymbol', host);
      if (nameEl && name) nameEl.textContent = name;
      if (symEl) symEl.textContent = `${state.sym} · ${token.address}`;
      const sellLabel = $('#dexTradeSellToken', host);
      if (sellLabel) sellLabel.textContent = state.sym;
    }
    state.vE = vE; state.vT = vT; state.reserve = reserve;
    state.graduated = graduated; state.mine = mine;
    // graduation bar
    const { bps } = graduationProgress(reserve, GRADUATION_QUOTE);
    const fill = $('#dexTradeGradFill', host);
    if (fill) fill.style.width = Math.min(100, Number(bps) / 100) + '%';
    const gtext = $('#dexTradeGradText', host);
    if (gtext) gtext.textContent = graduated ? t('dex.tokens.graduated') : t('dex.tokens.progress', { pct: String(Math.round(Number(bps) / 100)) });
    // price & mcap & holding — both denominated in the coin's OWN quote coin
    const priceEth = Number(vE) / Number(vT); // quote per token
    const pEl = $('#dexTradePrice', host);
    if (pEl) pEl.textContent = t('dex.trade.price', { price: priceEth.toExponential(4), sym: state.sym });
    const mEl = $('#dexTradeMcap', host);
    if (mEl) mEl.textContent = t('dex.trade.mcap', { mcap: (priceEth * Number(vT) / 1e18).toFixed(4) });
    const hEl = $('#dexTradeHold', host);
    if (hEl) hEl.textContent = t('dex.trade.hold', { amt: fmtTok(mine, 18, 4), sym: state.sym });

    // Balances, on the boxes they belong to. Without these the percentage row
    // has nothing to divide and the user is asked to type a number they cannot
    // know.
    const qb = $('#dexTradeQuoteBal', host);
    if (qb) qb.textContent = t('dex.trade.balance', { amt: fmtEth(state.quoteBal, 6) });
    const tb = $('#dexTradeTokenBal', host);
    if (tb) tb.textContent = t('dex.trade.balance', { amt: fmtTok(mine, 18, 2) });
  };

  const quoteBuyLive = () => {
    const raw = (buyEthEl.value || '').trim();
    if (!raw) { buyQuote.textContent = ''; return; }
    // Parsed with the QUOTE coin's own decimals, not a hardcoded 18: the three
    // Dex coins are probed at 18 today, but a coin that is not would otherwise
    // be bought at 1e6 times the intended size.
    let eth; try { eth = E.parseUnits(raw, state.quoteDec || 18); } catch { buyQuote.textContent = ''; return; }
    // No live read means no quote: a price computed off the last-known reserves
    // is a guess, and a guess rendered as a number is how someone gets hurt.
    if (!state.readable) { buyQuote.textContent = t('dex.trade.quoteStale'); return; }
    if (eth <= 0n || state.graduated) { buyQuote.textContent = state.graduated ? t('dex.trade.graduated') : ''; return; }
    const q = quoteBuy(state.vE, state.vT, eth);
    buyQuote.textContent = t('dex.trade.youGetTok', { amt: fmtTok(q.tokensOut, 18, 2), sym: state.sym });
  };
  const quoteSellLive = () => {
    const raw = (sellTokEl.value || '').trim();
    if (!raw) { sellQuote.textContent = ''; return; }
    let tok; try { tok = E.parseUnits(raw, 18); } catch { sellQuote.textContent = ''; return; }
    if (!state.readable) { sellQuote.textContent = t('dex.trade.quoteStale'); return; }
    if (tok <= 0n || state.graduated) { sellQuote.textContent = state.graduated ? t('dex.trade.graduated') : ''; return; }
    const q = quoteSell(state.vE, state.vT, tok);
    sellQuote.textContent = t('dex.trade.youGetEth', { amt: fmtEth(q.quoteOut, 6) });
  };
  if (buyEthEl) buyEthEl.addEventListener('input', quoteBuyLive);
  if (sellTokEl) sellTokEl.addEventListener('input', quoteSellLive);

  // ── percentage quick-fill ──────────────────────────────────────
  // Each button writes the matching slice of the balance you actually hold, then
  // re-quotes. No button acts on a balance it has not read: with nothing in the
  // wallet they leave the box alone rather than filling a number that would be
  // wrong.
  //
  // 100% is "Max", and Max subtracts nothing: the quote is a payable amount, not
  // a spendable-after-fee one, so trimming it would only make the user buy less
  // than they asked for. If gas ever comes out of the same balance, this is the
  // one line that has to change — noted rather than silently guessed.
  host.addEventListener('click', (e) => {
    const buy = e.target.closest('[data-dex-pct]');
    if (buy) {
      const pct = BigInt(buy.dataset.dexPct);
      if (state.quoteBal <= 0n) return;
      const amt = (state.quoteBal * pct) / 100n;
      buyEthEl.value = pct >= 100n
        ? E.formatUnits(state.quoteBal, state.quoteDec)
        : E.formatUnits(amt, state.quoteDec);
      quoteBuyLive();
      return;
    }
    const sell = e.target.closest('[data-dex-sell-pct]');
    if (sell) {
      const pct = BigInt(sell.dataset.dexSellPct);
      if (state.mine <= 0n) return;
      const amt = (state.mine * pct) / 100n;
      sellTokEl.value = E.formatUnits(amt, 18);
      quoteSellLive();
    }
  });

  const buyBtn = $('#dexTradeBuy', host);
  const sellBtn = $('#dexTradeSell', host);

  // Buy: spend the coin's OWN quote token, receive curve tokens.
  //
  // Two transactions, not one: the contract pulls funds with transferFrom, so it
  // needs an allowance first. The approval is granted only when it is missing or
  // too small, and only for the amount being bought — never an unlimited one,
  // which would let a compromised contract empty the wallet later.
  buyBtn.addEventListener('click', () => withTxButton(buyBtn, t('dex.trade.sending'), async () => {
    const signer = needSigner();
    if (!signer) return;
    const raw = (buyEthEl.value || '').trim();
    if (!state.readable) return toast(t('dex.trade.quoteStale'), 'error');
    if (!state.quoteAddr) return toast(t('dex.trade.quoteStale'), 'error');
    if (!raw) return toast(t('dex.trade.needEth'), 'error');
    let amount;
    try { amount = E.parseUnits(raw, state.quoteDec || 18); } catch { return toast(t('dex.trade.needEth'), 'error'); }
    if (amount <= 0n) return toast(t('dex.trade.needEth'), 'error');
    if (state.graduated) return toast(t('dex.trade.graduated'), 'error');
    if (amount > state.quoteBal) return toast(t('dex.trade.insufficient', { sym: state.quoteSym }), 'error');

    const q = quoteBuy(state.vE, state.vT, amount);
    // The floor goes ON-CHAIN, not just on screen. The contract reverts if the
    // curve moved past it, so a front-runner costs the buyer gas instead of
    // tokens. 1% tolerance means "at least 99% of the quote" — the first
    // version divided the quote by 100 and shipped a 99% tolerance under a
    // label that said 1%.
    const minOut = (q.tokensOut * (10_000n - SLIPPAGE_BPS)) / 10_000n;

    // Approve only what this trade needs, and only when the current allowance
    // is short. An existing allowance is reused rather than re-granted.
    const quote = new E.Contract(state.quoteAddr, ERC20_ABI, signer);
    const allowed = await quote.allowance(signer.getAddress?.() || get('address'), token.address).catch(() => 0n);
    if (allowed < amount) {
      const approved = await sendDexTx(
        () => quote.approve(token.address, amount),
        t('dex.trade.approving', { sym: state.quoteSym }),
      );
      if (!approved) return;
    }

    const ok = await confirmTx({
      title: t('dex.trade.buyTitle', { sym: state.sym }),
      rows: [
        { k: t('dex.trade.ethIn'), v: `${raw} ${state.quoteSym}` },
        { k: t('dex.trade.youGet'), v: fmtTok(q.tokensOut, 18, 2) + ' ' + state.sym },
        { k: t('dex.trade.worstCase'), v: fmtTok(minOut, 18, 2) + ' ' + state.sym },
        { k: t('dex.trade.gas'), v: state.quoteSym },
      ],
      confirmText: t('dex.trade.buy'),
      danger: true,
      valueWei: 0n,
    });
    if (!ok) return;
    const cs = new E.Contract(token.address, PUMP_ABI, signer);
    const rc = await sendDexTx(() => cs.buy(amount, minOut), t('dex.trade.buy'));
    if (!rc) return;
    toast(t('dex.trade.bought', { sym: state.sym }), 'success');
    buyEthEl.value = ''; quoteBuyLive();
    await refresh();
  }));

  // Creator pulls the fees accrued to this token. Shown only when the connected
  // wallet IS the creator AND there is something to take — a claim, not a
  // decoration.
  const claimBtn = $('#dexTradeClaim', host);
  if (claimBtn) {
    c.creator().then((cr) => {
      const me = String(get('address') || '').toLowerCase();
      if (String(cr).toLowerCase() !== me) { claimBtn.hidden = true; return; }
      c.totalFeesCreator().then((fees) => {
        claimBtn.hidden = fees <= 0n;
        if (fees > 0n) claimBtn.textContent = `${t('dex.trade.claimFees')} (${fmtEth(fees)} ETH)`;
      }).catch(() => { claimBtn.hidden = true; });
    }).catch(() => { claimBtn.hidden = true; });
    claimBtn.addEventListener('click', () => withTxButton(claimBtn, t('dex.trade.sending'), async () => {
      const signer = needSigner();
      if (!signer) return;
      const cs2 = new E.Contract(token.address, PUMP_ABI, signer);
      const rc = await sendDexTx(() => cs2.claimFees(), t('dex.trade.claimFees'));
      if (!rc) return;
      toast(t('dex.trade.feesClaimed'), 'success');
      await refresh();
    }));
  }

  // After graduation the curve stops; the creator moves the ETH backing on to a
  // V2 pool. Offered only once graduated, and only to the creator.
  const gradBtn = $('#dexTradeGraduate', host);
  if (gradBtn) {
    c.creator().then((cr) => {
      const me = String(get('address') || '').toLowerCase();
      if (String(cr).toLowerCase() !== me) { gradBtn.hidden = true; return; }
      c.graduated().then((g) => { gradBtn.hidden = !g; }).catch(() => { gradBtn.hidden = true; });
    }).catch(() => { gradBtn.hidden = true; });
    gradBtn.addEventListener('click', () => withTxButton(gradBtn, t('dex.trade.sending'), async () => {
      const signer = needSigner();
      if (!signer) return;
      const cs2 = new E.Contract(token.address, PUMP_ABI, signer);
      const rc = await sendDexTx(() => cs2.withdraw(), t('dex.trade.graduate'));
      if (!rc) return;
      toast(t('dex.trade.graduated'), 'success');
      await refresh();
    }));
  }

  // Sell: hand tokens back, get ETH.
  sellBtn.addEventListener('click', () => withTxButton(sellBtn, t('dex.trade.sending'), async () => {
    const signer = needSigner();
    if (!signer) return;
    const raw = (sellTokEl.value || '').trim();
    if (!state.readable) return toast(t('dex.trade.quoteStale'), 'error');
    if (!raw) return toast(t('dex.trade.needTok'), 'error');
    let tok; try { tok = E.parseUnits(raw, 18); } catch { return toast(t('dex.trade.needTok'), 'error'); }
    if (tok > state.mine) return toast(t('dex.trade.insufficient', { sym: state.sym }), 'error');
    if (tok <= 0n) return toast(t('dex.trade.needTok'), 'error');
    if (state.graduated) return toast(t('dex.trade.graduated'), 'error');
    const q = quoteSell(state.vE, state.vT, tok);
    // Same floor, mirrored: the contract reverts rather than pay less than this.
    const minOut = (q.quoteOut * (10_000n - SLIPPAGE_BPS)) / 10_000n;
    const ok = await confirmTx({
      title: t('dex.trade.sellTitle', { sym: state.sym }),
      rows: [
        { k: t('dex.trade.tokIn'), v: raw + ' ' + state.sym },
        { k: t('dex.trade.youGet'), v: fmtEth(q.quoteOut, 6) + ' ' + state.quoteSym },
        { k: t('dex.trade.worstCase'), v: fmtEth(minOut) + ' ETH' },
      ],
      confirmText: t('dex.trade.sell'),
      danger: true,
    });
    if (!ok) return;
    const cs = new E.Contract(token.address, PUMP_ABI, signer);
    const rc = await sendDexTx(() => cs.sell(tok, minOut), t('dex.trade.sell'));
    if (!rc) return;
    toast(t('dex.trade.sold', { sym: state.sym }), 'success');
    sellTokEl.value = ''; quoteSellLive();
    await refresh();
  }));

  // creator line
  c.creator().then((cr) => {
    const el = $('#dexTradeCreator', host);
    if (el) el.textContent = t('dex.trade.creator', { addr: String(cr).slice(0, 6) + '…' + String(cr).slice(-4) });
  }).catch(() => {});

  // The signature launchpad visual: the token's own bonding curve, price in
  // ETH against ETH poured in, with a marker at where the curve currently
  // sits. Same quote math the contract runs (curve.js), so the drawn shape is
  // the shape buyers will actually walk. Re-plotted on every live refresh.
  const curveCv = $('#dexTradeCurve', host);
  const curveInfo = $('#dexTradeCurveInfo', host);
  const drawCurve = () => {
    if (!curveCv || !curveCv.getContext) return;
    const ctx = curveCv.getContext('2d');
    if (!ctx) return;
    const w = curveCv.width = curveCv.clientWidth || 320;
    const h = curveCv.height = 150;
    ctx.clearRect(0, 0, w, h);
    // Walk cumulative buys from the launch reserves to the graduation line,
    // recording price (ETH per token) at each point.
    const startE = VIRTUAL_QUOTE, startT = VIRTUAL_TOKENS;
    const pts = [];
    let ve = startE, vt = startT;
    const steps = 80;
    for (let i = 0; i <= steps; i++) {
      pts.push({ eth: Number(ve), price: Number(ve) / Number(vt) });
      const q = quoteBuy(ve, vt, GRADUATION_QUOTE / BigInt(steps));
      ve = q.nextVirtualQuote; vt = q.nextVirtualTokens;
    }
    const max = Math.max(...pts.map((p) => p.price), 1e-12);
    const x = (eth) => (eth / Math.max(Number(ve), 1e-12)) * w;
    const y = (price) => h - (price / max) * (h - 8) - 4;
    // fill under the curve
    ctx.beginPath(); ctx.moveTo(0, h);
    pts.forEach((p) => ctx.lineTo(x(p.eth), y(p.price)));
    ctx.lineTo(w, h); ctx.closePath();
    ctx.fillStyle = 'rgba(232,150,60,0.18)'; ctx.fill();
    // the curve
    ctx.beginPath();
    pts.forEach((p, i) => { const px = x(p.eth), py = y(p.price); if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); });
    ctx.strokeStyle = '#E8963C'; ctx.lineWidth = 2; ctx.stroke();
    // "now" marker at the current virtual reserve
    const nowX = x(Number(ve)), nowY = y(Number(ve) / Number(vt));
    ctx.beginPath(); ctx.arc(nowX, nowY, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#1B8F4E'; ctx.fill();
    ctx.strokeStyle = '#2D2A32'; ctx.lineWidth = 2; ctx.stroke();
  };

  paintHistory();

  // The market maker. It subscribes to the runner rather than owning it, so
  // leaving this page leaves the bot trading.
  bindBot(host, token);

  refresh().then(() => { drawCurve(); return quoteBuyLive(); }).then(quoteSellLive);
  // Keep the numbers, the tape and the curve live while the panel is open. The
  // history repaint runs on its own, slower clock: it is several RPCs, and a new
  // trade only changes it once someone trades.
  const timer = setInterval(() => { refresh().then(() => { drawCurve(); quoteBuyLive(); quoteSellLive(); }); }, 5000);
  const histTimer = setInterval(paintHistory, 15_000);
  host.addEventListener('dex:teardown', () => { clearInterval(timer); clearInterval(histTimer); }, { once: true });
}
