// DASHBOARD
export default function DashboardView() {
  return (
        <section className="view active" id="view-dashboard">
          <div className="balance-hero" id="balanceHeroWrap">
        <div className="hero-sparkline" id="heroSparkWrap"><canvas id="heroSpark" width="140" height="28" aria-hidden="true"></canvas></div>
            <div className="wallet-name" id="homeWalletName"></div>
            <div className="total" id="totalBalance">$0.00</div>
            <div className="sub" id="balanceSub">Not connected</div>
          </div>
          <div className="quick-actions" id="quickActions">
            <button type="button" className="quick-action-btn" data-view="send"><span className="qa-icon"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></span><span className="qa-label">Send</span></button>
            <button type="button" className="quick-action-btn" id="quickReceive"><span className="qa-icon"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="3" x2="12" y2="15"/><polyline points="7 10 12 15 17 10"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg></span><span className="qa-label">Receive</span></button>
            <button type="button" className="quick-action-btn" data-view="nft"><span className="qa-icon"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg></span><span className="qa-label">NFT</span></button>
            <button type="button" className="quick-action-btn" data-view="deploy"><span className="qa-icon"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg></span><span className="qa-label">Tools</span></button>
            {/* Discord has no bottom-bar slot (five fixed slots). The phone
                 route is this quick action, beside the other things a user
                 chooses to go and do on purpose — the same slot Approvals
                 held before it was removed (M3). */}
            <button type="button" className="quick-action-btn" data-view="discord"><span className="qa-icon"><svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor" stroke="none" aria-hidden="true"><path d="M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.865-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.1 18.058a.082.082 0 0 0 .031.056 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.1 13.1 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .078-.011c3.928 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .079.01c.12.099.246.198.373.292a.077.077 0 0 1-.007.128 12.3 12.3 0 0 1-1.873.891.077.077 0 0 0-.04.107c.36.698.772 1.363 1.225 1.993a.076.076 0 0 0 .084.029 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.055c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.029zM8.02 15.331c-1.183 0-2.157-1.086-2.157-2.419s.956-2.419 2.157-2.419c1.211 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.086-2.157-2.419s.955-2.419 2.157-2.419c1.21 0 2.176 1.095 2.156 2.42 0 1.333-.946 2.418-2.156 2.418z"/></svg></span><span className="qa-label">Discord</span></button>
          </div>
          <div className="card">
            <div className="card-title"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg> <span data-i18n="dashboard.assets">My Assets</span></div>
            <div className="asset-search" id="assetSearch" style={{ display: 'none' }}>
              <input type="text" className="input" id="tokenSearchInput" placeholder="Search tokens..." autoComplete="off" />
            </div>
            <div className="asset-grid" id="assetList">
              {/* skeleton loading */}
              <div className="skeleton-card" id="assetSkeleton">
                <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                  <div className="skeleton skeleton-circle"></div>
                  <div style={{ flex: '1' }}>
                    <div className="skeleton skeleton-line skeleton-line-short"></div>
                    <div className="skeleton skeleton-line skeleton-line-long"></div>
                  </div>
                </div>
              </div>
              <div className="skeleton-card">
                <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                  <div className="skeleton skeleton-circle"></div>
                  <div style={{ flex: '1' }}>
                    <div className="skeleton skeleton-line skeleton-line-short"></div>
                    <div className="skeleton skeleton-line skeleton-line-long"></div>
                  </div>
                </div>
              </div>
              <div className="skeleton-card">
                <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                  <div className="skeleton skeleton-circle"></div>
                  <div style={{ flex: '1' }}>
                    <div className="skeleton skeleton-line skeleton-line-short"></div>
                    <div className="skeleton skeleton-line skeleton-line-long"></div>
                  </div>
                </div>
              </div>
            </div>
            <div className="asset-addtoken">
              <button type="button" className="btn btn-secondary btn-block" id="btnAddCustomToken" title="Add a custom token by contract address">+ Add Token</button>
            </div>
          </div>
        </section>
  );
}
