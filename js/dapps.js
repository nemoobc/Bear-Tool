// ═══════════════════════════════════════════════════════════════
// Bear Tool — dapps.js
// DApps Web3 browser — iframe-based with injected provider
// ═══════════════════════════════════════════════════════════════

const POPULAR_DAPPS = [
  { name: 'Uniswap', url: 'https://app.uniswap.org', icon: '🦄', category: 'Swap' },
  { name: 'Aave', url: 'https://app.aave.com', icon: '👻', category: 'Lending' },
  { name: 'Compound', url: 'https://app.compound.finance', icon: '🏦', category: 'Lending' },
  { name: 'OpenSea', url: 'https://opensea.io', icon: '🌊', category: 'NFT' },
  { name: 'Blur', url: 'https://blur.io', icon: '🎨', category: 'NFT' },
  { name: 'Lido', url: 'https://stake.lido.fi', icon: '🏊', category: 'Staking' },
  { name: 'Rocket Pool', url: 'https://.rocketpool.net', icon: '🚀', category: 'Staking' },
  { name: 'Etherscan', url: 'https://etherscan.io', icon: '🔍', category: 'Explorer' },
  { name: 'Snapshot', url: 'https://snapshot.org', icon: '📷', category: 'Governance' },
  { name: 'ENS', url: 'https://app.ens.domains', icon: '🏷️', category: 'Identity' }
];

let currentDapp = null;
let dappFrame = null;

export function renderDapps(container) {
  if (!container) return;
  container.innerHTML = `
    <div class="dapps-browser">
      <div class="dapps-bar">
        <input type="text" id="dappUrl" placeholder="Enter URL or search DApp..." class="dapp-url-input" />
        <button id="dappGo" class="btn btn-primary btn-sm">Go</button>
        <button id="dappBack" class="btn btn-sm" style="display:none">← Back</button>
        <button id="dappClose" class="btn btn-sm btn-danger" style="display:none">✕</button>
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
      <div id="dappFrame" class="dapp-frame" style="display:none">
        <iframe id="dappIframe" sandbox="allow-scripts allow-same-origin allow-forms allow-popups" loading="lazy"></iframe>
      </div>
    </div>`;
  // Wire events
  container.querySelectorAll('.dapp-card').forEach(card => {
    card.addEventListener('click', () => openDapp(card.dataset.url, card.dataset.name));
  });
  const goBtn = container.querySelector('#dappGo');
  const urlInput = container.querySelector('#dappUrl');
  const backBtn = container.querySelector('#dappBack');
  const closeBtn = container.querySelector('#dappClose');
  goBtn?.addEventListener('click', () => {
    const url = urlInput.value.trim();
    if (url) openDapp(url.startsWith('http') ? url : 'https://' + url, url);
  });
  urlInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') goBtn?.click();
  });
  backBtn?.addEventListener('click', () => closeDapp());
  closeBtn?.addEventListener('click', () => closeDapp());
}

function openDapp(url, name) {
  currentDapp = { url, name };
  const grid = document.getElementById('dappGrid');
  const frame = document.getElementById('dappFrame');
  const bar = document.querySelector('.dapps-bar');
  const urlInput = document.getElementById('dappUrl');
  const backBtn = document.getElementById('dappBack');
  const closeBtn = document.getElementById('dappClose');
  if (grid) grid.style.display = 'none';
  if (frame) frame.style.display = 'block';
  if (urlInput) urlInput.value = url;
  if (backBtn) backBtn.style.display = '';
  if (closeBtn) closeBtn.style.display = '';
  const iframe = document.getElementById('dappIframe');
  if (iframe) iframe.src = url;
}

function closeDapp() {
  currentDapp = null;
  const grid = document.getElementById('dappGrid');
  const frame = document.getElementById('dappFrame');
  const backBtn = document.getElementById('dappBack');
  const closeBtn = document.getElementById('dappClose');
  if (grid) grid.style.display = '';
  if (frame) { frame.style.display = 'none'; const iframe = document.getElementById('dappIframe'); if (iframe) iframe.src = ''; }
  if (backBtn) backBtn.style.display = 'none';
  if (closeBtn) closeBtn.style.display = 'none';
}

export { POPULAR_DAPPS };
