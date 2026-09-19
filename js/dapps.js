// ═══════════════════════════════════════════════════════════════
// Bear Tool — dapps.js
// DApps browser — opens in new tab (iframe blocked by CORS/CSP)
// ═══════════════════════════════════════════════════════════════

const POPULAR_DAPPS = [
  { name: 'Uniswap', url: 'https://app.uniswap.org', icon: '🦄', category: 'Swap' },
  { name: 'Aave', url: 'https://app.aave.com', icon: '👻', category: 'Lending' },
  { name: 'Compound', url: 'https://app.compound.finance', icon: '🏦', category: 'Lending' },
  { name: 'OpenSea', url: 'https://opensea.io', icon: '🌊', category: 'NFT' },
  { name: 'Blur', url: 'https://blur.io', icon: '🎨', category: 'NFT' },
  { name: 'Lido', url: 'https://stake.lido.fi', icon: '🏊', category: 'Staking' },
  { name: 'Rocket Pool', url: 'https://rocketpool.net', icon: '🚀', category: 'Staking' },
  { name: 'Etherscan', url: 'https://etherscan.io', icon: '🔍', category: 'Explorer' },
  { name: 'Snapshot', url: 'https://snapshot.org', icon: '📷', category: 'Governance' },
  { name: 'ENS', url: 'https://app.ens.domains', icon: '🏷️', category: 'Identity' }
];

export function renderDapps(container) {
  if (!container) return;
  container.innerHTML = `
    <div class="dapps-browser">
      <div class="dapps-bar">
        <input type="text" id="dappUrl" placeholder="Enter URL or search DApp..." class="dapp-url-input" />
        <button id="dappGo" class="btn btn-primary btn-sm">Open</button>
      </div>
      <div class="dapp-note" style="text-align:center;padding:12px;color:var(--text-secondary);font-size:13px;">
        💡 DApps open in a new tab. Connect your wallet from the DApp site.
      </div>
      <div id="dappGrid" class="dapp-grid">
        ${POPULAR_DAPPS.map(d => `
          <div class="dapp-card" data-url="${d.url}" data-name="${d.name}">
            <div class="dapp-icon">${d.icon}</div>
            <div class="dapp-name">${d.name}</div>
            <div class="dapp-category">${d.category}</div>
          </div>
        `).join('')}
      </div>
    </div>`;
  // Wire events — open in new tab
  container.querySelectorAll('.dapp-card').forEach(card => {
    card.addEventListener('click', () => {
      window.open(card.dataset.url, '_blank', 'noopener,noreferrer');
    });
  });
  const goBtn = container.querySelector('#dappGo');
  const urlInput = container.querySelector('#dappUrl');
  goBtn?.addEventListener('click', () => {
    let url = urlInput.value.trim();
    if (!url) return;
    if (!url.startsWith('http')) url = 'https://' + url;
    window.open(url, '_blank', 'noopener,noreferrer');
  });
  urlInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') goBtn?.click();
  });
}

export { POPULAR_DAPPS };
