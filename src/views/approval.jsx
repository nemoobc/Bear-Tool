// APPROVAL
export default function ApprovalView() {
  return (
        <section className="view" id="view-approval">
          <div className="card">
            <div className="card-title"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg> <span data-i18n="approval.title">Approval Manager</span></div>
            <p className="small mb-8">Scan token approvals and revoke dangerous allowances. Unlimited approvals = risk.</p>
            <div className="approval-controls">
              <div className="field">
                <label htmlFor="approvalMode">Scan mode</label>
                <select className="select" id="approvalMode">
                  <option value="popular">Popular tokens (19 built-in)</option>
                  <option value="custom">Custom token address</option>
                </select>
              </div>
              <div className="field hidden" id="approvalCustomWrap">
                <label htmlFor="approvalCustom">Token address</label>
                <input className="input" id="approvalCustom" placeholder="0x..." />
              </div>
            </div>
            <button className="btn btn-primary btn-block" id="btnApprovalScan">Scan Approvals</button>
            <div id="approvalList" className="mt-16"></div>
          </div>

          {/* The Security Center lives here, not in Settings.
               Settings is five things — how it looks, how long it holds a key,
               and the delete — and it ends at the delete button. The Security
               Center is six more sections of reference material, and having it
               there meant the page was 2500px long, the delete was buried in the
               middle of it, and nothing about the page said where it ended.

               Approvals is where it belongs on a phone anyway: this is the view
               a phone used to reach through Settings, and every part of the
               Center is about what a dApp or a token can do to you. Nothing is
               lost by moving it; it is just where you would look for it. */}
          <div className="card mt-16">
            <div className="card-title"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg> <span data-i18n="sec.title">Security Center</span></div>
            <div id="securityCenter"></div>
          </div>
        </section>
  );
}
