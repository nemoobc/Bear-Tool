// ═══════════════════════════════════════════════════════════════
// Bear Tool — dapps.js
// DApps browser — in-app iframe browser with toolbar
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

function openDappBrowser(url, name) {
  if (!url) return;
  if (!url.startsWith('http')) url = 'https://' + url;

  // Inject in-app browser modal
  let overlay = document.getElementById('dappBrowserOverlay');
  if (overlay) overlay.remove();

  overlay = document.createElement('div');
  overlay.id = 'dappBrowserOverlay';
  overlay.className = 'dapp-browser-overlay';
  overlay.innerHTML = `
    <div class="dapp-browser-shell">
      <div class="dapp-browser-toolbar">
        <button class="dapp-browser-btn" id="dappBrowserBack" title="Back">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <button class="dapp-browser-btn" id="dappBrowserReload" title="Reload">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
        </button>
        <div class="dapp-browser-title">${name || new URL(url).hostname}</div>
        <button class="dapp-browser-btn" id="dappBrowserExternal" title="Open in new tab">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        </button>
        <button class="dapp-browser-btn dapp-browser-close" id="dappBrowserClose" title="Close">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="dapp-browser-url-bar">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        <span class="dapp-browser-url-text">${url}</span>
      </div>
      <div class="dapp-browser-frame-wrap">
        <iframe id="dappBrowserFrame" class="dapp-browser-frame" src="${url}" sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-modals" allow="clipboard-write; clipboard-read" loading="lazy"></iframe>
        <div class="dapp-browser-loading" id="dappBrowserLoading">
          <div class="dapp-browser-spinner"></div>
          <span>Loading ${name || 'DApp'}…</span>
        </div>
      </div>
    </div>`;

  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));

  const iframe = document.getElementById('dappBrowserFrame');
  const loader = document.getElementById('dappBrowserLoading');

  iframe.addEventListener('load', () => {
    if (loader) loader.style.display = 'none';
  });

  // Fallback: hide loader after 8s even if load never fires (CORS blocks events)
  setTimeout(() => { if (loader) loader.style.display = 'none'; }, 8000);

  // Close
  document.getElementById('dappBrowserClose').addEventListener('click', () => {
    iframe.src = 'about:blank';
    overlay.classList.remove('open');
    setTimeout(() => overlay.remove(), 300);
  });

  // Back (close — iframe has no history)
  document.getElementById('dappBrowserBack').addEventListener('click', () => {
    iframe.src = 'about:blank';
    overlay.classList.remove('open');
    setTimeout(() => overlay.remove(), 300);
  });

  // Reload
  document.getElementById('dappBrowserReload').addEventListener('click', () => {
    loader.style.display = '';
    iframe.src = url;
  });

  // External tab fallback
  document.getElementById('dappBrowserExternal').addEventListener('click', () => {
    window.open(url, '_blank', 'noopener,noreferrer');
  });

  // Close on overlay background click
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      iframe.src = 'about:blank';
      overlay.classList.remove('open');
      setTimeout(() => overlay.remove(), 300);
    }
  });
}

export function renderDapps(container) {
  if (!container) return;
  container.innerHTML = `
    <div class="dapps-browser">
      <div class="dapps-bar">
        <input type="text" id="dappUrl" placeholder="Enter URL or search DApp..." class="dapp-url-input" />
        <button id="dappGo" class="btn btn-primary btn-sm">Open</button>
      </div>
      <div class="dapp-note" style="text-align:center;padding:8px 12px;color:var(--text-secondary);font-size:12px;">
        💡 DApps open inside Bear Tool. Some sites may require the external button ↗.
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
  // Wire events — open in-app browser
  container.querySelectorAll('.dapp-card').forEach(card => {
    card.addEventListener('click', () => {
      openDappBrowser(card.dataset.url, card.dataset.name);
    });
  });
  const goBtn = container.querySelector('#dappGo');
  const urlInput = container.querySelector('#dappUrl');
  goBtn?.addEventListener('click', () => {
    let url = urlInput.value.trim();
    if (!url) return;
    openDappBrowser(url);
  });
  urlInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') goBtn?.click();
  });
}

export { POPULAR_DAPPS };
