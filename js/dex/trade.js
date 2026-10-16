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
import { quoteBuy, quoteSell, graduationProgress, fmtEth, fmtPrice, GRADUATION_QUOTE, VIRTUAL_QUOTE, VIRTUAL_TOKENS } from './curve.js';
import { drawCandles } from './chart.js';
import { botHtml, bindBot } from './bot.js';
import { liquidityHtml, bindLiquidity } from './liquidity.js';
import { deleteCoin } from './list.js';
import { forgetLaunchedToken } from './tokens.js';
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

    <!-- The market header sticks: on a phone the price, the ticker and the
         graduation progress are the three things the user scrolls back up to
         check, and pinning them under the topbar is what an exchange does. -->
    <div class="dex-mkt">
      <div class="dex-mkt-row">
        <span class="dex-token-face" id="dexTradeFace" style="width:64px;height:64px;flex:0 0 64px">
          ${token.image ? `<img src="${escapeHtml(token.image)}" alt="">` : ''}
        </span>
        <div class="dex-mkt-id">
          <strong class="dex-mkt-name" id="dexTradeName">${escapeHtml(token.name)}</strong>
          <div class="small dex-mkt-sym" id="dexTradeSymbol">${escapeHtml(token.symbol)} · <span class="mono">${escapeHtml(token.address)}</span></div>
          <div class="small" id="dexTradeCreator"></div>
        </div>
      </div>

      <div class="dex-trade-stats" role="group" aria-label="${escapeHtml(t('dex.trade.statsAria'))}">
        <div id="dexTradePrice"></div>
        <div id="dexTradeMcap"></div>
        <div id="dexTradeHold"></div>
      </div>

      <div class="dex-grad">
        <div class="small" id="dexTradeGradText"></div>
        <div class="dex-grad-bar"><div class="dex-grad-fill" id="dexTradeGradFill"></div></div>
      </div>
    </div>

    <p class="small dex-mkt-desc" id="dexTradeDesc"${token.description ? '' : ' hidden'}>${escapeHtml(token.description || '')}</p>

    <div class="dex-chart-block mt-8">
      <div class="dex-block-head"><strong>${escapeHtml(t('dex.trade.chartTitle'))}</strong></div>
      <div id="dexTradeChart" class="dex-chart-host" role="img"
           aria-label="${escapeHtml(t('dex.trade.chartAria'))}"></div>
      <div class="dex-loading" id="dexTradeChartLoading" hidden><span class="dex-spinner"></span><span>${escapeHtml(t('dex.chart.loading'))}</span></div>
      <div class="small mt-8" id="dexTradeCurveInfo"></div>
    </div>

    <div class="mt-8">
      <div class="dex-block-head"><strong>${escapeHtml(t('dex.trades.title'))}</strong></div>
      <div id="dexTradeTape"></div>
    </div>

    <div class="dex-orderbox mt-8" role="group" aria-label="${escapeHtml(t('dex.trade.ticket'))}">
      <div class="dex-order dex-order-buy">
        <div class="dex-order-head">
          <span class="dex-order-side">${escapeHtml(t('dex.trade.buy'))}</span>
        </div>
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

      <div class="dex-order dex-order-sell">
        <div class="dex-order-head">
          <span class="dex-order-side">${escapeHtml(t('dex.trade.sell'))}</span>
        </div>
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
    </div>

    <details class="dex-curve-details mt-8">
      <summary class="small">${escapeHtml(t('dex.trade.curve'))}</summary>
      <canvas id="dexTradeCurve" height="150"></canvas>
      <div class="small" id="dexTradeCurveInfo2"></div>
    </details>

    <button id="dexTradeClaim" type="button" class="btn btn-secondary btn-block mt-8" hidden>${escapeHtml(t('dex.trade.claimFees'))}</button>
    <button id="dexTradeGraduate" type="button" class="btn btn-primary btn-block mt-8" hidden>${escapeHtml(t('dex.trade.graduate'))}</button>

    ${botHtml()}

    <button id="dexTradeDelete" type="button" class="btn btn-danger btn-block mt-8">${escapeHtml(t('dex.list.delete'))}</button>
    <div class="small" id="dexTradeDeleteNote">${escapeHtml(t('dex.list.deleteNote'))}</div>

    ${liquidityHtml()}

    <div class="dex-loading" id="dexTradeLoading" hidden><span class="dex-spinner"></span><span>${escapeHtml(t('dex.chart.loading'))}</span></div>
    <div id="dexTradeStatus" class="small mt-8"></div>
    <div id="dexTradeLog" class="small"></div>

    <!-- The action bar is the LAST element on purpose: a sticky-bottom bar only
         stays pinned while its natural position sits below the fold, so one
         placed mid-page scrolls away exactly when the user needs it. At the end
         it reads the way the exchange apps do — Buy and Sell permanently under
         the thumb, the market panels above. -->
    <div class="dex-actionbar" role="group" aria-label="${escapeHtml(t('dex.trade.actions'))}">
      <button id="dexTradeBuy" type="button" class="btn btn-primary btn-block" data-dex-cell="buy">${escapeHtml(t('dex.trade.buy'))}</button>
      <button id="dexTradeSell" type="button" class="btn btn-sell btn-block" data-dex-cell="sell">${escapeHtml(t('dex.trade.sell'))}</button>
    </div>`;
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
    if (chartHost) chartTearDown = await drawCandles(chartHost, candles, { height: 220, theme: 'dark' });
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
    if (tapeHost) {
      tapeHost.innerHTML = tradesHtml(hist.trades, state.sym || token.symbol || '', state.quoteSym)
        + (hist.partial ? `<div class="small">${escapeHtml(t('dex.trades.partial'))}</div>` : '');
    }
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
  // One market stat cell: label above value. A ticker row of three figures has
  // to be scannable, so the label stays small/dim and the value carries the
  // weight. Both halves are escaped — values include user-set names.
  const stat = (id, label, value) => {
    const el = $(id, host);
    if (!el) return;
    el.innerHTML = `<span class="dex-stat-lb">${escapeHtml(label)}</span><span class="dex-stat-v">${escapeHtml(value)}</span>`;
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
    // Bound FIRST as one value, destructured only after it is known to be an
    // array. The old one-liner destructured the `.catch()` result directly —
    // and that result is `null` on failure, so `const [vE, …] = null` threw
    // TypeError BEFORE the `if (!vE) return` guard below could ever run: the
    // graceful "read failed" path was itself a crash, leaving the every-5s
    // refresh ticking unhandled rejections instead of a marked-stale page.
    const read = await Promise.all([
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
      // The picture and the blurb live on the contract too. Left out, a coin
      // found from the chain opened to an empty square and no description.
      c.image().catch(() => ''),
      c.description().catch(() => ''),
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
    if (!read) return;   // the catch above already marked the page unreadable
    const [vE, vT, reserve, graduated, mine, quoteAddr, name, sym, img, desc] = read;
    if (!vE) return;      // a contract whose virtualQuote() reads 0 is not a quote we can render
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
    // The face and the blurb are read from the contract for the same reason the
    // name and symbol are: a coin launched on another device, or found again
    // after a storage wipe, has an empty local record — and the contract had
    // both the whole time.
    const faceEl = $('#dexTradeFace', host);
    if (faceEl && img) faceEl.innerHTML = `<img src="${escapeHtml(img)}" alt="">`;
    const descEl = $('#dexTradeDesc', host);
    if (descEl) {
      const d = desc || token.description || '';
      descEl.textContent = d;
      descEl.hidden = !d;
    }
    if (name || sym) {
      const nameEl = $('#dexTradeName', host);
      const symEl = $('#dexTradeSymbol', host);
      if (nameEl && name) nameEl.textContent = name;
      if (symEl) symEl.textContent = `${state.sym} · ${token.address}`;
      const sellLabel = $('#dexTradeSellToken', host);
      if (sellLabel) sellLabel.textContent = state.sym;
    }
    // A successful read clears the failure line. Nothing else wrote to that node
    // when things went well, so one dropped RPC left a permanent red "could not
    // read" sitting under live, updating numbers — both true, neither
    // believable.
    if (status) status.textContent = '';
    state.readable = true;

    state.vE = vE; state.vT = vT; state.reserve = reserve;
    state.graduated = graduated; state.mine = mine;
    // graduation bar
    const { bps } = graduationProgress(reserve, GRADUATION_QUOTE);
    const fill = $('#dexTradeGradFill', host);
    if (fill) fill.style.width = Math.min(100, Number(bps) / 100) + '%';
    const gtext = $('#dexTradeGradText', host);
    if (gtext) gtext.textContent = graduated ? t('dex.tokens.graduated') : t('dex.tokens.progress', { pct: String(Math.round(Number(bps) / 100)) });
    // price & fully-diluted value & holding — all denominated in the coin's OWN
    // quote coin
    //
    // The price is quote per token (vE/vT — the same ratio quoteBuy walks), and
    // on a fresh curve it is TINY: about 1e-13. `toExponential(4)` rendered it
    // "1.2345e-13", which is developer notation on a ticker; fmtPrice keeps
    // significant digits instead, so the number shown is the number traded.
    const priceQ = Number(vE) / Number(vT); // quote per token
    stat('#dexTradePrice', t('dex.trade.stat.price'), t('dex.trade.price', { price: fmtPrice(priceQ), q: state.quoteSym || 'ETH' }));
    // Fully-diluted value: the price times the whole supply the curve was born
    // with. What stood here multiplied the price by the CURRENT virtual token
    // reserve, which is a constant — so every coin at every price printed the
    // same figure, under a label that said "market cap". A wrong number under a
    // confident label is worse than no number, so the figure is now derived from
    // the one thing that makes it an FDV.
    const fdv = priceQ * Number(VIRTUAL_TOKENS) / 1e18;
    stat('#dexTradeMcap', t('dex.trade.stat.fdv'), t('dex.trade.fdv', { mcap: fmtPrice(fdv, 4), q: state.quoteSym || 'ETH' }));
    stat('#dexTradeHold', t('dex.trade.stat.hold'), t('dex.trade.hold', { amt: fmtTok(mine, 18, 4), sym: state.sym }));

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
    if (eth <= 0n || state.graduated) { buyQuote.textContent = state.graduated ? t('dex.trade.graduatedWhy') : ''; return; }
    const q = quoteBuy(state.vE, state.vT, eth);
    buyQuote.textContent = t('dex.trade.youGetTok', { amt: fmtTok(q.tokensOut, 18, 2), sym: state.sym });
  };
  const quoteSellLive = () => {
    const raw = (sellTokEl.value || '').trim();
    if (!raw) { sellQuote.textContent = ''; return; }
    let tok; try { tok = E.parseUnits(raw, 18); } catch { sellQuote.textContent = ''; return; }
    if (!state.readable) { sellQuote.textContent = t('dex.trade.quoteStale'); return; }
    if (tok <= 0n || state.graduated) { sellQuote.textContent = state.graduated ? t('dex.trade.graduatedWhy') : ''; return; }
    const q = quoteSell(state.vE, state.vT, tok);
    sellQuote.textContent = t('dex.trade.youGetEth', { amt: fmtEth(q.quoteOut, 6), q: state.quoteSym || 'ETH' });
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
  // `host` is the persistent #dexPanelHost; renderPanel() clears innerHTML but
  // does NOT detach host-level listeners, so attaching these per-render stacked
  // a new click + focusin on every visit to a coin page (leak + duplicated
  // work). Named handlers, attached once, removed on dex:teardown.
  const onPctClick = (e) => {
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
  };
  host.addEventListener('click', onPctClick);
  host.addEventListener('dex:teardown', () => host.removeEventListener('click', onPctClick), { once: true });

  const buyBtn = $('#dexTradeBuy', host);
  const sellBtn = $('#dexTradeSell', host);

  // ── the action bar reads as a Buy/Sell SEGMENTED control ───────
  // Two cells in one rail, which is how every exchange app puts the two sides
  // of a market under the thumb. Which side you are on is shown by lighting
  // that cell — driven by focusin, the one gesture a touch screen and a
  // keyboard both produce. It is emphasis on a real <button>, never a second
  // control: no ARIA role is invented for it, and both cells stay reachable.
  const cells = host.querySelectorAll('[data-dex-cell]');
  const markSide = (side) => {
    cells.forEach((el) => el.classList.toggle('is-on', el.dataset.dexCell === side));
  };
  const onCellFocus = (e) => {
    const cell = e.target && e.target.closest ? e.target.closest('[data-dex-cell]') : null;
    if (cell) markSide(cell.dataset.dexCell);
  };
  host.addEventListener('focusin', onCellFocus);
  host.addEventListener('dex:teardown', () => host.removeEventListener('focusin', onCellFocus), { once: true });

  // The page-level "back to top" button sits exactly where the Sell cell is,
  // so on a coin page it is hidden by CSS. A floating circle on top of a
  // trading control is a mis-tap waiting to happen, and the panel has its own
  // header to scroll back to. The class comes OFF on teardown so no other view
  // loses its button.
  const doc = globalThis.document;
  if (doc && doc.body) doc.body.classList.add('dex-coin-page');
  host.addEventListener('dex:teardown', () => {
    if (doc && doc.body) doc.body.classList.remove('dex-coin-page');
  }, { once: true });

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
    if (state.graduated) return toast(t('dex.trade.graduatedWhy'), 'error');
    if (amount > state.quoteBal) return toast(t('dex.trade.insufficient', { sym: state.quoteSym }), 'error');

    const q = quoteBuy(state.vE, state.vT, amount);
    // The floor goes ON-CHAIN, not just on screen. The contract reverts if the
    // curve moved past it, so a front-runner costs the buyer gas instead of
    // tokens. 1% tolerance means "at least 99% of the quote" — the first
    // version divided the quote by 100 and shipped a 99% tolerance under a
    // label that said 1%.
    const minOut = (q.tokensOut * (10_000n - SLIPPAGE_BPS)) / 10_000n;

    // Confirm INTENT first. The sheet states what you get and the worst case,
    // and the buyer commits to the purchase BEFORE anything is granted or
    // signed. The approval used to fire first, so a wallet prompt asking to
    // let the contract spend your quote tokens popped while the buyer had not
    // yet confirmed they wanted to buy at all — cancelling the sheet then left
    // a pointless allowance behind. Now the order is confirm → approve → buy:
    // one decision, then only the transactions that decision implies.
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

    // Approve only what this trade needs, and only when the current allowance
    // is short. An existing allowance is reused rather than re-granted.
    const quote = new E.Contract(state.quoteAddr, ERC20_ABI, signer);
    // `await` on getAddress(), not around it. On an ethers.Wallet getAddress()
    // returns a Promise, so the Promise OBJECT was being passed as the address
    // argument; ethers rejects the encoding, the .catch below turned that into
    // 0n, and the result was an approve transaction before EVERY buy.
    const me = get('address') || (signer.getAddress ? await signer.getAddress() : '');
    const allowed = me ? await quote.allowance(me, token.address).catch(() => 0n) : 0n;
    if (allowed < amount) {
      const approved = await sendDexTx(
        () => quote.approve(token.address, amount),
        t('dex.trade.approving', { sym: state.quoteSym }),
      );
      if (!approved) return;
    }

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
        if (fees > 0n) claimBtn.textContent = `${t('dex.trade.claimFees')} (${fmtEth(fees)} ${state.quoteSym || 'ETH'})`;
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
    if (state.graduated) return toast(t('dex.trade.graduatedWhy'), 'error');
    const q = quoteSell(state.vE, state.vT, tok);
    // Same floor, mirrored: the contract reverts rather than pay less than this.
    const minOut = (q.quoteOut * (10_000n - SLIPPAGE_BPS)) / 10_000n;
    const ok = await confirmTx({
      title: t('dex.trade.sellTitle', { sym: state.sym }),
      rows: [
        { k: t('dex.trade.tokIn'), v: raw + ' ' + state.sym },
        { k: t('dex.trade.youGet'), v: fmtEth(q.quoteOut, 6) + ' ' + state.quoteSym },
        { k: t('dex.trade.worstCase'), v: fmtEth(minOut) + ' ' + state.quoteSym },
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
    // "now" marker at the coin's ACTUAL position: state.vE/state.vT are the
    // live reserves (re-read every 5s), falling back to the launch reserves
    // before the first read. The loop variables CANNOT be used — the walk above
    // runs all the way to the graduation line, so they hold the POST-graduation
    // reserves, and the marker sat pinned at the curve's far right on every
    // coin: a brand-new, untraded token showed it at graduation, flatly
    // contradicting the live price and the graduation bar right above it.
    const nowE = state.vE || startE;
    const nowT = state.vT || startT;
    const nowX = x(Number(nowE)), nowY = y(Number(nowE) / Number(nowT));
    ctx.beginPath(); ctx.arc(nowX, nowY, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#1B8F4E'; ctx.fill();
    ctx.strokeStyle = '#2D2A32'; ctx.lineWidth = 2; ctx.stroke();
  };

  paintHistory();

  // The market maker. It subscribes to the runner rather than owning it, so
  // leaving this page leaves the bot trading.
  bindBot(host, token);

  // Delete — for real, and only after asking. This wallet's feed forgets the
  // coin: it leaves the launched index (tokens.js) and a tombstone (list.js)
  // keeps the creator-scoped chain scan from resurrecting it on the next
  // refresh. The contract stays on the chain — nobody can undo that — which is
  // exactly why the button says "delete from MY feed" and the note never
  // pretends the coin itself is gone.
  const delBtn = $('#dexTradeDelete', host);
  delBtn?.addEventListener('click', async () => {
    const ok = await confirmTx({
      title: t('dex.list.deleteConfirmTitle'),
      rows: [{ k: t('dex.list.deleteRowCoin'), v: `${token.symbol || token.name} · ${token.address.slice(0, 6)}…${token.address.slice(-4)}` }],
      confirmText: t('dex.list.deleteConfirmCta'),
      danger: true,
    });
    if (!ok) return;
    forgetLaunchedToken(token.address);
    deleteCoin(token.address);
    toast(t('dex.list.deletedToast'), 'success');
    // The feed is the coin's only home now that it is out of it — go back.
    if (typeof onBack === 'function') onBack();
  });

  // The pool. Its contract functions shipped a commit before this call existed,
  // so for a while the app had no way to reach them at all.

  // One refresh at a time. refresh() fans out ~10 RPCs before it writes, so on a
  // slow node two overlapping passes finish out of order and the older snapshot
  // paints last. The mount path below called refresh() a SECOND time as well,
  // doubling the fan-out on every coin open.
  let inFlight = false;
  const once = async () => {
    if (inFlight) return;
    inFlight = true;
    try { await refresh(); } finally { inFlight = false; }
  };

  const liq = bindLiquidity(host, token);
  once().then(() => liq.refresh()).catch(() => { /* an unreadable pool says so when opened */ });

  once().then(() => { drawCurve(); return quoteBuyLive(); }).then(quoteSellLive);
  // Keep the numbers, the tape and the curve live while the panel is open. The
  // history repaint runs on its own, slower clock: it is several RPCs, and a new
  // trade only changes it once someone trades.
  const timer = setInterval(() => { once().then(() => { drawCurve(); quoteBuyLive(); quoteSellLive(); }); }, 5000);
  const histTimer = setInterval(paintHistory, 15_000);
  host.addEventListener('dex:teardown', () => { clearInterval(timer); clearInterval(histTimer); }, { once: true });
}
