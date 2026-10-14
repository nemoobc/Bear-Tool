// DEX — the Sepolia launchpad. Shell only: every paint and listener lives in
// js/dex/index.js (renderDex), the same split send/swap/bridge/discord use.
// A coin trades on its OWN bonding curve, so there is no pair to pick and no
// pool to manage — which is the whole point of the pure-launchpad rebuild
// (user: "ambigu fitur dexnya, rombak ulang semuanya" → "opsi 1").
export default function DexView() {
  return (
    <section className="view" id="view-dex">
      <div className="card">
        <div className="card-title">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="4 20 4 14" /><polyline points="10 20 10 8" /><polyline points="16 20 16 12" /><polyline points="22 20 22 4" /></svg>
          <span data-i18n="nav.dex">Dex</span>
        </div>
        <p className="small mb-8" data-i18n="dex.hint">A launchpad: every coin trades on its own bonding curve against ETH,
        and reads its own chart and trade tape straight from that curve's
        on-chain events — all Sepolia, all real transactions.</p>
        {/* #dexRoot is painted by renderDex() in js/dex.js — the chain gate and
            the pair form render with no wallet open, so a locked wallet still
            sees WHY nothing works instead of an empty card. */}
        <div id="dexRoot"></div>
      </div>
    </section>
  );
}
