// SETTINGS
export default function SettingsView() {
  return (
        <section className="view" id="view-settings">
          <div className="card">
            <div className="card-title"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg> <span data-i18n="nav.settings">Settings</span></div>
            {/* Five settings, and five is what this page is for.
                 Testnet mode and the custom RPC field came off it deliberately:
                 both are real capabilities, and both are now reachable from the
                 places that own them - testnets can be filtered per session
                 from the network picker itself, and a custom node belongs with
                 the node it replaces rather than in a general settings list.
                 What stays here is what a person opens Settings to change:
                 how it looks, and how long it holds an unlocked key. */}
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
                  <button className="theme-btn active" data-theme="light">☀️ <span data-i18n="set.theme.light">Light</span></button>
                  <button className="theme-btn" data-theme="dark">🌙 <span data-i18n="set.theme.dark">Dark</span></button>
                  <button className="theme-btn" data-theme="auto">💻 <span data-i18n="set.theme.auto">Auto</span></button>
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

              {/* The testnet switch lives in BOTH Settings and the network
                   picker, and they are the same switch: one function
                   (setTestnetVisible) writes the setting and both controls read
                   it back from the same place. Two controls for one setting is
                   normally a bug waiting to happen — one gets changed and the
                   other keeps lying — so the rule here is that neither control
                   owns anything. Move it, and move both.

                   Settings is where a person looks for a preference, and this is
                   the one that was reported missing from here. The picker copy
                   stays because a filter you cannot reach from the thing it
                   filters is a trap: search the list, and the switch that turns
                   the filter off is gone. */}
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

            <div className="set-group set-group-danger">
              <h4 className="set-group-h" data-i18n="set.group.data">Your data</h4>
              <div className="field">
                <p className="small dim" data-i18n="set.data.hint">Everything lives in this browser only. Deleting removes every wallet, every setting and your whole history from here. It cannot be undone, and there is no copy anywhere else.</p>
                <button className="btn btn-danger btn-block" id="btnClearAllData">🗑️ <span data-i18n="set.data.clear">Clear all data</span></button>
              </div>
            </div>
          </div>
        </section>
  );
}
