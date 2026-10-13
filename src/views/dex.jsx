// DEX — the Sepolia-only AMM over the three preset coins (user orders:
// "Dex sepolia only", then "custom coin native hapus, pake ini aja [tiga
// alamat]"). Shell only: every paint and listener lives in js/dex.js
// (renderDex), the same split send/swap/bridge/discord use. Sepolia ETH is
// gas ONLY — it never appears as a pair side; each side is one of the three
// preset ERC-20s.
export default function DexView() {
  return (
    <section className="view" id="view-dex">
      <div className="card">
        <div className="card-title">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="4 20 4 14" /><polyline points="10 20 10 8" /><polyline points="16 20 16 12" /><polyline points="22 20 22 4" /></svg>
          <span data-i18n="nav.dex">Dex</span>
        </div>
        <p className="small mb-8" data-i18n="dex.hint">Three coins, one pool each side, one chain: pick a base and a
        quote, add liquidity, then swap, read the chart or let a market maker trade — all Sepolia, all real
        transactions. Sepolia ETH pays gas only; it is never a pair side.</p>
        {/* #dexRoot is painted by renderDex() in js/dex.js — the chain gate and
            the pair form render with no wallet open, so a locked wallet still
            sees WHY nothing works instead of an empty card. */}
        <div id="dexRoot"></div>
      </div>
    </section>
  );
}
