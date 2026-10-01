// NFT GALLERY
export default function NftView() {
  return (
        <section className="view" id="view-nft">
          <div className="card">
            <div className="card-title"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg> <span data-i18n="nft.title">NFT Gallery</span></div>

            {/* A neutral loading state, and nothing more. It used to claim
                 "No NFTs found" AND "Connect wallet to view your NFTs" at the
                 same time, which is two different situations said at once — and
                 it was what a visitor actually saw, because nothing ever
                 replaced it: refreshView had no nft branch, so loadNfts() was
                 imported and never called. The outcome is nft.js's to state. */}
            <div id="nftList" className="nft-grid">
              <div className="nft-empty" role="status">
                <div className="nft-empty-title">Loading your NFTs…</div>
                <div className="nft-empty-hint">Reading the collection list for this wallet on the current network.</div>
              </div>
            </div>
          </div>
        
        </section>
  );
}
