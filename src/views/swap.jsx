// SWAP
export default function SwapView() {
  return (
        <section className="view" id="view-swap">
          <div className="card">
            <div className="card-title"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/><line x1="8" y1="12" x2="16" y2="12"/></svg> <span data-i18n="nav.swap">Swap</span></div>
            <div className="swap-card">
              <div className="swap-field">
                {/* Balance rides the LABEL row (label left, balance right):
                     one tidy line beside the token it describes, instead of a
                     stray line under the pct buttons where it read as part of
                     the amount controls. Id kept — E2E contract. */}
                <div className="swap-field-head">
                  <label htmlFor="swapFrom">From</label>
                  <span className="swap-balance" id="swapFromBalance">Balance: —</span>
                </div>
                <div className="swap-input-row">
                                    <div className="token-picker" data-picker="swapFrom">
                    <select className="select swap-token-select token-picker-native" id="swapFrom" aria-label="from token"></select>
                    <button type="button" className="token-picker-trigger" id="swapFromBtn" aria-haspopup="listbox" aria-expanded="false" aria-label="Choose from token">
                      <span className="token-picker-logo" data-logo="" aria-hidden="true"></span>
                      <span className="token-picker-symbol" data-symbol="">—</span>
                      <span className="token-picker-caret" aria-hidden="true">▾</span>
                    </button>
                    <div className="token-picker-panel" id="swapFromPanel" role="listbox" hidden></div>
                  </div>
                  <div className="swap-amount-wrap">
                    <input className="input" id="swapFromAmount" type="number" placeholder="0.0" min="0" step="any" />
                  </div>
                  <div className="send-pct-btns swap-pct-btns" id="swapPctBtns" role="group" aria-label="Amount shortcuts">
                    <button className="pct-btn" type="button" data-swap-pct="20">20%</button>
                    <button className="pct-btn" type="button" data-swap-pct="50">50%</button>
                    <button className="pct-btn" type="button" data-swap-pct="70">70%</button>
                    {/* MAX, not 100%: beside 20/50/70 "100%" reads as "my
                         whole balance", and it is not — it is the balance minus
                         the fee, since a transfer spending the last wei cannot
                         pay for itself. */}
                    <button className="pct-btn pct-max" type="button" data-swap-pct="100"
                            title="Largest amount that can actually be sent"
                            aria-label="MAX: the largest amount that can actually be sent">MAX</button>
                  </div>
                  {/* Was inside the Bridge heading's inline SVG, where a paragraph gets no
                       layout box at all: it rendered at 0x0, so the app computed a
                       careful explanation of exactly what MAX reserved and then put
                       it where nobody could read it - in the wrong view besides.
                       It lives here instead, under the control that produces it.
                       The </div> above closes .swap-input-row: inside that flex row
                       the note was squeezed to 23px wide at every breakpoint, and
                       the pct buttons beside it were squeezed too. Tags are spelled
                       out in words on purpose: a literal tag name in a comment
                       makes every grep-and-count over this file miscount, which is
                       how a real imbalance got hidden here. */}
                  </div>
                  <p className="max-note" id="swapMaxNote" role="status" aria-live="polite"></p>
              </div>
              <div className="swap-flip-wrap">
                {/* Two stacked arrows as a stroke SVG — the raw ⇅ text glyph
                    rendered at the mercy of the platform font and carried no
                    accessible name beyond "⇅". Same icon grammar as the rest
                    of the app (24-grid, stroke 2, round caps). */}
                <button className="btn btn-ghost swap-flip-btn" id="btnSwapFlip" type="button" title="Flip tokens" aria-label="Flip from and to tokens">
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7 20V4"/><path d="m3 16 4 4 4-4"/><path d="M17 4v16"/><path d="m21 8-4-4-4 4"/></svg>
                </button>
              </div>
              <div className="swap-field">
                <div className="swap-field-head">
                  <label htmlFor="swapTo">To</label>
                  <span className="swap-balance" id="swapToBalance">Balance: —</span>
                </div>
                <div className="swap-input-row">
                                    <div className="token-picker" data-picker="swapTo">
                    <select className="select swap-token-select token-picker-native" id="swapTo" aria-label="to token"></select>
                    <button type="button" className="token-picker-trigger" id="swapToBtn" aria-haspopup="listbox" aria-expanded="false" aria-label="Choose to token">
                      <span className="token-picker-logo" data-logo="" aria-hidden="true"></span>
                      <span className="token-picker-symbol" data-symbol="">—</span>
                      <span className="token-picker-caret" aria-hidden="true">▾</span>
                    </button>
                    <div className="token-picker-panel" id="swapToPanel" role="listbox" hidden></div>
                  </div>
                  <input className="input" id="swapToAmount" type="number" placeholder="0.0" readOnly />
                </div>
              </div>
              <div className="field mb-8">
                <label htmlFor="swapRouterSelect">Router</label>
                <select className="select" id="swapRouterSelect"><option value="auto">Auto (Best Price)</option><option value="kyberswap">KyberSwap</option><option value="1inch">1inch</option><option value="paraswap">ParaSwap</option><option value="sushiswap">SushiSwap</option><option value="uniswap_v3">Uniswap V3</option><option value="uniswap_v2">Uniswap V2</option></select>
              </div>
              <div className="swap-extras">
                <div className="field">
                  <label htmlFor="swapSlippage">Slippage</label>
                  <div className="slippage-btns" id="swapSlippage">
                    <button type="button" className="slippage-btn" data-val="0.1">0.1%</button>
                    <button type="button" className="slippage-btn active" data-val="0.5">0.5%</button>
                    <button type="button" className="slippage-btn" data-val="1">1%</button>
                    <button type="button" className="slippage-btn" data-val="3">3%</button>
                    <button type="button" className="slippage-btn" data-val="5">5%</button>
                  </div>
                </div>
              </div>
              <div id="swapQuote" className="quote-box hidden"></div>
              <div className="swap-route hidden" id="swapRoute">
                <div className="route-label">Route:</div>
                <div className="route-info" id="routeInfo"></div>
              </div>
              <div className="swap-impact hidden" id="swapImpact"></div>
              <button type="button" className="btn btn-primary btn-block btn-lg" id="btnSwap">Swap</button>
            </div>
            <div id="swapPending" className="swap-pending hidden">
              <div className="spinner-wrap"><div className="spinner-bear-wrap"><div className="ring"></div><span className="spinner-bear">🐻</span></div></div>
              <div className="spinner-info"><span className="spinner-label">Swapping tokens…</span></div>
            </div>
          </div>
        </section>
  );
}
