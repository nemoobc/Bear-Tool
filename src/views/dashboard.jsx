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
            <button className="quick-action-btn" data-view="send"><span className="qa-icon"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></span><span className="qa-label">Send</span></button>
            <button className="quick-action-btn" id="quickReceive"><span className="qa-icon"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="3" x2="12" y2="15"/><polyline points="7 10 12 15 17 10"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg></span><span className="qa-label">Receive</span></button>
            <button className="quick-action-btn" data-view="nft"><span className="qa-icon"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg></span><span className="qa-label">NFT</span></button>
            <button className="quick-action-btn" data-view="deploy"><span className="qa-icon"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg></span><span className="qa-label">Tools</span></button>
            {/* Approvals has no bottom-bar slot. It used to reach a phone through
                 Settings, but the Security Center that held the link now lives in
                 this very view, and Settings is meant to be five things and end at
                 the delete. So the route is here, beside the other things a user
                 chooses to go and do on purpose. */}
            <button className="quick-action-btn" data-view="approval"><span className="qa-icon"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></span><span className="qa-label">Approvals</span></button>
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
              <button className="btn btn-secondary btn-block" id="btnAddCustomToken" title="Add a custom token by contract address">+ Add Token</button>
            </div>
          </div>
        </section>
  );
}
