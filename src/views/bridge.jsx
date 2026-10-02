// BRIDGE
export default function BridgeView() {
  return (
        <section className="view" id="view-bridge">
          <div className="card">
            <div className="card-title"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/>
<line x1="4" y1="22" x2="4" y2="15"/></svg> <span data-i18n="bridge.title">Bridge</span></div>
            <div className="bridge-card">
              <div className="bridge-chains">
                <div className="bridge-chain-field">
                  <label htmlFor="bridgeFromChain">From</label>
                  <div className="token-picker" data-picker="bridgeFromChain"><select className="select bridge-chain-select token-picker-native" id="bridgeFromChain" aria-label="source chain"></select><button type="button" className="token-picker-trigger" id="bridgeFromChainBtn" aria-haspopup="listbox" aria-expanded="false" aria-label="Choose source chain"><span className="token-picker-logo" data-logo="" aria-hidden="true"></span><span className="token-picker-symbol" data-symbol="">—</span><span className="token-picker-caret" aria-hidden="true">▾</span></button><div className="token-picker-panel" id="bridgeFromChainPanel" role="listbox" hidden></div></div>
                </div>
                <div className="bridge-chain-arrow">→</div>
                <div className="bridge-chain-field">
                  <label htmlFor="bridgeToChain">To</label>
                  <div className="token-picker" data-picker="bridgeToChain"><select className="select bridge-chain-select token-picker-native" id="bridgeToChain" aria-label="destination chain"></select><button type="button" className="token-picker-trigger" id="bridgeToChainBtn" aria-haspopup="listbox" aria-expanded="false" aria-label="Choose destination chain"><span className="token-picker-logo" data-logo="" aria-hidden="true"></span><span className="token-picker-symbol" data-symbol="">—</span><span className="token-picker-caret" aria-hidden="true">▾</span></button><div className="token-picker-panel" id="bridgeToChainPanel" role="listbox" hidden></div></div>
                </div>
              </div>
              <div className="field">
                <label htmlFor="bridgeToken">Token</label>
                <div className="token-picker" data-picker="bridgeToken"><select className="select token-picker-native" id="bridgeToken" aria-label="token"></select><button type="button" className="token-picker-trigger" id="bridgeTokenBtn" aria-haspopup="listbox" aria-expanded="false" aria-label="Choose token"><span className="token-picker-logo" data-logo="" aria-hidden="true"></span><span className="token-picker-symbol" data-symbol="">—</span><span className="token-picker-caret" aria-hidden="true">▾</span></button><div className="token-picker-panel" id="bridgeTokenPanel" role="listbox" hidden></div></div>
              </div>
              <div className="field">
                <label htmlFor="bridgeAmount">Amount</label>
                <div className="amount-row">
                  <input className="input" id="bridgeAmount" type="number" placeholder="0.0" min="0" step="any" />
                </div>
                <div className="send-pct-btns bridge-pct-btns" id="bridgePctBtns" role="group" aria-label="Amount shortcuts">
                  <button className="pct-btn" type="button" data-bridge-pct="20">20%</button>
                  <button className="pct-btn" type="button" data-bridge-pct="50">50%</button>
                  <button className="pct-btn" type="button" data-bridge-pct="70">70%</button>
                  {/* Labelled MAX, not 100%. Beside 20/50/70, "100%" reads as
                       "send my whole balance" — and it is not: MAX sends the
                       whole balance MINUS the fee, because a transfer that
                       spends the last wei cannot pay for itself. */}
                  <button className="pct-btn pct-max" type="button" data-bridge-pct="100"
                          title="Use the largest amount that can actually be sent"
                          aria-label="MAX: use the largest amount that can actually be sent">MAX</button>
                </div>
                <p className="max-note" id="bridgeMaxNote" role="status" aria-live="polite"></p>
              </div>
              <div className="field mb-8">
                <label htmlFor="bridgeRouterSelect">Bridge Router</label>
                <div className="token-picker" data-picker="bridgeRouterSelect"><select className="select token-picker-native" id="bridgeRouterSelect" aria-label="bridge provider"><option value="auto">Auto (Best Route)</option><option value="lifi">LI.FI</option><option value="socket">Socket</option><option value="stargate">Stargate</option><option value="across">Across</option><option value="hop">Hop</option><option value="wormhole">Wormhole</option><option value="bungee">Bungee</option><option value="synapse">Synapse</option></select><button type="button" className="token-picker-trigger" id="bridgeRouterSelectBtn" aria-haspopup="listbox" aria-expanded="false" aria-label="Choose bridge provider"><span className="token-picker-logo" data-logo="" aria-hidden="true"></span><span className="token-picker-symbol" data-symbol="">—</span><span className="token-picker-caret" aria-hidden="true">▾</span></button><div className="token-picker-panel" id="bridgeRouterSelectPanel" role="listbox" hidden></div></div>
              </div>
              <div id="bridgeRoute" className="bridge-route hidden"></div>
              <button type="button" className="btn btn-success btn-block btn-lg hidden" id="btnBridgeExec">Execute Bridge</button>
              <div id="bridgeQuote" className="quote-box hidden"></div>
              <div id="bridgeStatus" className="bridge-status hidden">
                <div className="bridge-progress"><div className="bridge-progress-fill" id="bridgeProgressFill"></div></div>
                <div className="bridge-steps" id="bridgeSteps"></div>
              </div>
            </div>
          </div>
        </section>
  );
}
