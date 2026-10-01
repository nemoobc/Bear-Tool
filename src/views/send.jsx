// RECEIVE 
        // SEND
export default function SendView() {
  return (
        <section className="view" id="view-send">
          <div className="card">
            <div className="card-title"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> <span data-i18n="nav.send">Send</span></div>
            <details className="address-book-accordion" id="addressBookAccordion">
              <summary className="address-book-toggle"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg> Address Book</summary>
              <div className="address-book" id="addressBook">
                <div className="address-book-list" id="addressBookList">
                  <p className="small text-center">No saved addresses yet.</p>
                </div>
                <div className="address-book-add mt-8">
                  <input className="input" id="abLabel" placeholder="Label (e.g. My Safe)" />
                  <input className="input mt-4" id="abAddress" placeholder="0x..." />
                  <button className="btn btn-primary btn-block mt-8" id="btnAddAddress">Add Address</button>
                </div>
              </div>
            </details>
            <div className="send-card">
              <div className="field">
                <label htmlFor="sendTo">To address</label>
                <div className="send-address-wrap">
                  <input className="input" id="sendTo" placeholder="0x... or ENS name" autoComplete="off" spellCheck="false" />
                  <button className="btn btn-ghost btn-sm" id="btnSendPaste" title="Paste">📋</button>
                </div>
                <div className="send-ens-status hidden" id="sendEnsStatus"></div>
              </div>
              <div className="field">
                <label htmlFor="sendToken">Token</label>
                <div className="send-token-wrap">
                  <select className="select" id="sendToken"></select>
                  <span className="send-token-balance" id="sendTokenBalance"></span>
                </div>
              </div>
              <div className="field">
                <label htmlFor="sendAmount">Amount</label>
                <input className="input" id="sendAmount" type="number" placeholder="0.0" min="0" step="any" />
                <div className="send-pct-btns" id="sendPctBtns" role="group" aria-label="Amount shortcuts">
                  <button className="pct-btn" data-pct="25">25%</button>
                  <button className="pct-btn" data-pct="50">50%</button>
                  <button className="pct-btn" data-pct="75">75%</button>
                  {/* Labelled MAX, not 100%. Beside 25/50/75, "100%" reads as
                       "send my whole balance" - and it is not: it sends the whole
                       balance MINUS the fee, because a transfer that spends the
                       last wei cannot pay for itself. MAX says what the button
                       does; the amount field shows the number either way. */}
                  <button className="pct-btn pct-max" data-pct="100"
                          title="Send everything spendable — the balance minus the fee"
                          aria-label="MAX: send everything spendable, the balance minus the fee">MAX</button>
                </div>
                {/* The note closes the button row above it, then becomes a
                     sibling. Left inside .send-pct-btns it became the fifth
                     flex child of the row: the four buttons got squeezed to
                     23px-wide slabs and the note rendered as a 23x36px box
                     beside them instead of as a sentence underneath. */}
                <p className="max-note" id="sendMaxNote" role="status" aria-live="polite"></p>
              </div>
              <div className="field">
                <label>Gas speed</label>
                <div className="gas-btns" id="sendGas">
                  <button className="gas-btn" data-speed="slow">🐢 Slow</button>
                  <button className="gas-btn active" data-speed="normal">🚶 Normal</button>
                  <button className="gas-btn" data-speed="fast">🏃 Fast</button>
                  <button className="gas-btn" data-speed="auto">🤖 Auto</button>
                </div>
              </div>
              <div id="sendPreview" className="quote-box hidden"></div>
              <div className="gas-estimate" id="sendGasEstimate">
                <span className="gas-est-label">Est. gas:</span>
                <span className="gas-est-value" id="gasEstValue">—</span>
                <span className="gas-est-usd" id="gasEstUsd"></span>
              </div>
              <button className="btn btn-primary btn-block btn-lg" id="btnSend">Send</button>
            </div>
          </div>
        </section>
  );
}
