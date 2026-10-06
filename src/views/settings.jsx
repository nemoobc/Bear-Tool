// SETTINGS
export default function SettingsView() {
  return (
        <section className="view" id="view-settings">
          <div className="card">
            <div className="card-title"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg> <span data-i18n="nav.settings">Settings</span></div>
            {/* Settings is preferences, and it ends at the delete button. Two
                 things were added after this comment was written and both were
                 asked for by name: the EIP-7702 capability check (an answer
                 about the chains, not a preference) sits with the rest of the
                 network material, and the Security Center — back from Approvals
                 (M3 removed that view), collapsed inside <details> so an open
                 Center can never bury the delete again.

                 The old line here claimed "five settings, and five is what this
                 page is for." It is now six. A count in a comment rots the moment
                 anything is added — so the rule is no longer a number, it is this:
                 what belongs here is what a person opens Settings to find out or
                 change, and nothing else gets to move in. */}
            <div className="set-group">
              <h4 className="set-group-h" data-i18n="set.group.look">Appearance</h4>

              <div className="field">
                <label htmlFor="setLang" data-i18n="settings.language">Language</label>
                <select className="select" id="setLang">
                  <option value="en">English</option>
                  <option value="id">Bahasa Indonesia</option>
                </select>
              </div>

              <div className="field">
                <label htmlFor="setCurrency" data-i18n="settings.currency">Currency</label>
                <select className="select" id="setCurrency">
                  <option value="usd">USD $</option>
                  <option value="eur">EUR €</option>
                  <option value="idr">IDR Rp</option>
                  <option value="cny">CNY ¥</option>
                </select>
              </div>

              <div className="field">
                <label data-i18n="set.theme">Theme</label>
                <div className="theme-toggle">
                  <button type="button" className="theme-btn active" data-theme="light">☀️ <span data-i18n="set.theme.light">Light</span></button>
                  <button type="button" className="theme-btn" data-theme="dark">🌙 <span data-i18n="set.theme.dark">Dark</span></button>
                  <button type="button" className="theme-btn" data-theme="auto">💻 <span data-i18n="set.theme.auto">Auto</span></button>
                </div>
              </div>
            </div>

            <div className="set-group">
              <h4 className="set-group-h" data-i18n="set.group.safe">Safety</h4>

              <div className="field">
                <label htmlFor="setAutoLock" data-i18n="settings.auto_lock">Auto-lock</label>
                {/* defaultValue di <select>, bukan selected di <option>: React
                    memperingat untuk yang terakhir. defaultValue membuat React
                    menyetel defaultSelected pada opsi — atribut selected="" di
                    DOM, sama persis dengan markup HTML aslinya. */}
                <select className="select" id="setAutoLock" defaultValue="5">
                  <option value="1">1 minute</option>
                  <option value="5">5 minutes</option>
                  <option value="10">10 minutes</option>
                  <option value="15">15 minutes</option>
                  <option value="30">30 minutes</option>
                  <option value="60">1 hour</option>
                  <option value="0">Never</option>
                </select>
              </div>

              {/* The testnet switch lives ONLY in Settings (the picker copy was
                   removed 2026-10-04: it duplicated this on/off — one toggle
                   per setting). setTestnetVisible remains the single writer and
                   this control reads back from it. The picker list follows the
                   stored setting on every open. */}
              <div className="field">
                <div className="field-row">
                  <div>
                    <label htmlFor="setTestnet" data-i18n="set.testnet">Testnet mode</label>
                    <p className="small dim" data-i18n="set.testnet.hint">Show test networks in the network list. Hiding them while you are on one moves you to Ethereum first.</p>
                  </div>
                  {/* The whole row is the label, so the hit area is the row and
                       not the 26px switch alone. */}
                  <label className="switch" htmlFor="setTestnet">
                    <input type="checkbox" id="setTestnet" />
                    <span className="slider" aria-hidden="true"></span>
                  </label>
                </div>
              </div>
            </div>

            {/* NFT auto-detect keys — BYO. The gallery could only scan a
                 curated list of contracts, so "every NFT I own" and floor
                 price were unreachable without an indexer (research
                 research-nft-detect.md, 2026-10-04: owner-wide on-chain
                 enumeration ≈ 2.4M RPC calls on Ethereum, and Seaport has
                 no listing event, so floor cannot be read from chain state
                 at all). Both providers below are free tier with CORS
                 proven from this page; a key stays in this browser's
                 storage and only travels with the requests it authorises.
                 Empty = nothing changes: the on-chain scan keeps running
                 exactly as before. */}
            <div className="set-group">
              <h4 className="set-group-h" data-i18n="set.group.nftkeys">NFT auto-detect</h4>
              <div className="field">
                <label htmlFor="setNftKeyOpenSea" data-i18n="set.nftkey.opensea">OpenSea API key (optional)</label>
                <p className="small dim" data-i18n="set.nftkey.opensea.hint">Owner-wide NFT list + floor price on Ethereum, Polygon, Arbitrum, Optimism and Base. Free tier: 600 reads/hour (instant key, valid 7 days). BNB Chain is not covered by OpenSea.</p>
                <input type="password" className="input" id="setNftKeyOpenSea" placeholder="os_…" autoComplete="off" spellCheck={false} />
              </div>
              <div className="field">
                <label htmlFor="setNftKeyAlchemy" data-i18n="set.nftkey.alchemy">Alchemy API key (optional)</label>
                <p className="small dim" data-i18n="set.nftkey.alchemy.hint">Fallback when OpenSea refuses or hits its limit: 30M compute units/month free. Floor price included on Ethereum and Polygon. BNB Chain is not covered.</p>
                <input type="password" className="input" id="setNftKeyAlchemy" placeholder="alch_…" autoComplete="off" spellCheck={false} />
              </div>
            </div>

            {/* EIP-7702 is a capability question, not a preference: you cannot
                 set it, you can only find out. The check talks to every RPC in
                 the network table with an estimate that can never execute, so it
                 costs nothing and signs nothing — see js/eip7702-support.js for
                 the method and for the two detection approaches that were
                 measured and discarded. */}
            <div className="set-group">
              <h4 className="set-group-h">EIP-7702 support</h4>
              <div className="field">
                <p className="small dim">Ask every network we ship whether it accepts EIP-7702 set-code transactions, and show which RPC endpoint answered. Read-only: no signature, no broadcast, no cost.</p>
                <button type="button" className="btn btn-primary btn-block" id="btn7702Check">Check all networks</button>
                <div id="eip7702Results" className="mt-16"></div>
                {/* This deletes the check's OUTPUT — the rows left on screen
                     after a sweep — not the debug log: the collector ring and
                     the relay file are dev tooling and stay put. It stays
                     hidden until the scan finishes — app.js reveals it in the
                     success path so a failed run never offers to "delete
                     output" that was never produced. */}
                <button type="button" className="btn btn-ghost btn-block mt-8" id="btnClearEipResults" hidden>🗑 Delete results</button>
              </div>
            </div>

            {/* Security Center: home again, collapsed. Closed it is one row —
                the page keeps its length and the delete below stays where the
                order test puts it. Opened, it is the same six sections Approvals
                carried (renderSecurityCenter paints #securityCenter when this
                view opens — app.js refreshView). */}
            <div className="set-group">
              <h4 className="set-group-h" data-i18n="set.group.security">Security Center</h4>
              <details className="sec-details" id="securityCenterDetails">
                <summary data-i18n="sec.open">Show what sites and tokens can reach</summary>
                <div id="securityCenter" className="mt-8"></div>
              </details>
            </div>

            <div className="set-group set-group-danger">
              <h4 className="set-group-h" data-i18n="set.group.data">Your data</h4>
              <div className="field">
                <p className="small dim" data-i18n="set.data.hint">Everything lives in this browser only. Deleting removes every wallet, every setting and your whole history from here. It cannot be undone, and there is no copy anywhere else.</p>
                <button type="button" className="btn btn-danger btn-block" id="btnClearAllData">🗑️ <span data-i18n="set.data.clear">Clear all data</span></button>
              </div>
            </div>
          </div>
        </section>
  );
}
