// Dex v2 shell — thin React mount point, rebuilt from zero (2026-10-17, on the
// user order to delete the dex and rebuild it until mature). The static chrome
// lives here; everything live is painted by js/dex/index.js (renderDex) into
// #dexRoot — the same split send/swap/bridge use, and the same #view-dex /
// #dexRoot ids app.js has always routed to. Nothing else: a view that adds
// markup renderDex will overwrite is duplicate surface waiting to drift.
export default function DexView() {
  return (
    <section className="view" id="view-dex">
      <div className="card" id="dexCard">
        <div className="card-title">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="4 20 4 14" /><polyline points="10 20 10 8" /><polyline points="16 20 16 12" /><polyline points="22 20 22 4" /></svg>
          <span data-i18n="nav.dex">Dex</span>
        </div>
        <div id="dexRoot"></div>
      </div>
    </section>
  );
}
