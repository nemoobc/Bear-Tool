// DAPPS BROWSER
export default function DappsView() {
  return (
        <section className="view" id="view-dapps">
          <div className="card">
            <div className="card-title"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg> <span data-i18n="dapps.browser">DApps Browser</span></div>
            <div id="dappsContainer"></div>
          </div>
        </section>
  );
}
