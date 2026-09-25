// ═══════════════════════════════════════════════════════════════
// Bear Tool — dapps.js
// DApps browser — in-app iframe browser with toolbar
// ═══════════════════════════════════════════════════════════════

import { escapeHtml, toast } from './ui.js';

// frameable:false → the site ships clickjacking protection (X-Frame-Options or
// frame-ancestors), so NO in-app browser can embed it. Verified against live
// response headers, 2026-09:
//   uniswap   X-Frame-Options: SAMEORIGIN
//   opensea   X-Frame-Options: DENY
//   blur      X-Frame-Options: DENY
//   lido      frame-ancestors *
//   rocketpool/etherscan  X-Frame-Options: SAMEORIGIN
//   ens       frame-ancestors 'self' https://app.safe.global
// Only Aave, Compound and Snapshot allow cross-origin framing. For the rest we
// open a new tab instead of showing a blank frame + a console violation.
const POPULAR_DAPPS = [
  { name: 'Uniswap', url: 'https://app.uniswap.org', icon: '🦄', category: 'Swap', frameable: false },
  { name: 'Aave', url: 'https://app.aave.com', icon: '👻', category: 'Lending', frameable: true },
  { name: 'Compound', url: 'https://app.compound.finance', icon: '🏦', category: 'Lending', frameable: true },
  { name: 'OpenSea', url: 'https://opensea.io', icon: '🌊', category: 'NFT', frameable: false },
  { name: 'Blur', url: 'https://blur.io', icon: '🎨', category: 'NFT', frameable: false },
  { name: 'Lido', url: 'https://stake.lido.fi', icon: '🏊', category: 'Staking', frameable: false },
  { name: 'Rocket Pool', url: 'https://rocketpool.net', icon: '🚀', category: 'Staking', frameable: false },
  { name: 'Etherscan', url: 'https://etherscan.io', icon: '🔍', category: 'Explorer', frameable: false },
  { name: 'Snapshot', url: 'https://snapshot.org', icon: '📷', category: 'Governance', frameable: true },
  { name: 'ENS', url: 'https://app.ens.domains', icon: '🏷️', category: 'Identity', frameable: false }
];

function openDappBrowser(url, name, frameable = true) {
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  // Only http(s) targets may load in the in-app browser.
  let parsed;
  try { parsed = new URL(url); } catch { toast('Invalid URL', 'error'); return; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') { toast('Invalid URL', 'error'); return; }
  const safeUrl = parsed.href;

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
        <div class="dapp-browser-title">${escapeHtml(name || parsed.hostname)}</div>
        <button class="dapp-browser-btn" id="dappBrowserExternal" title="Open in new tab">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        </button>
        <button class="dapp-browser-btn dapp-browser-close" id="dappBrowserClose" title="Close">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="dapp-browser-url-bar">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        <span class="dapp-browser-url-text">${escapeHtml(safeUrl)}</span>
      </div>
      <div class="dapp-browser-frame-wrap">
        <iframe id="dappBrowserFrame" class="dapp-browser-frame" src="${frameable ? escapeHtml(safeUrl) : 'about:blank'}" sandbox="allow-scripts allow-popups allow-forms allow-modals" allow="clipboard-write; clipboard-read" loading="lazy"></iframe>
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
  const wrap = document.querySelector('.dapp-browser-frame-wrap');

  let loaded = false;
  iframe.addEventListener('load', () => {
    loaded = true;
    if (loader) loader.style.display = 'none';
    // A site that sends X-Frame-Options / frame-ancestors still fires `load`
    // for the blocked frame, so check whether anything actually rendered.
    try {
      const doc = iframe.contentDocument;
      if (doc && doc.body && doc.body.childElementCount === 0) showBlocked();
    } catch { /* opaque origin (sandbox) — cannot inspect, assume fine */ }
  });

  // Many major dapps ship clickjacking protection (X-Frame-Options: DENY or
  // frame-ancestors 'self'), so they can NEVER be embedded by any wallet —
  // Uniswap allows only itself and Safe Global. The frame stays blank and only
  // the console shows a violation, which reads as a broken app. Say so, and
  // offer the one route that does work.
  function showBlocked() {
    if (!wrap || wrap.querySelector('.dapp-browser-blocked')) return;
    const n = document.createElement('div');
    n.className = 'dapp-browser-blocked';
    n.innerHTML = `<div class="dapp-browser-spinner"></div>
      <p><strong>${escapeHtml(name || 'This DApp')} can’t be embedded here.</strong></p>
      <p class="dim">It sends <code>X-Frame-Options</code> / <code>frame-ancestors</code>
      to block clickjacking, so no in-app browser can display it. Open it in a
      new tab instead — your wallet stays untouched.</p>
      <button class="btn btn-primary" id="dappBlockedOpen">↗ Open in new tab</button>`;
    wrap.appendChild(n);
    n.querySelector('#dappBlockedOpen').addEventListener('click', () => {
      window.open(safeUrl, '_blank', 'noopener,noreferrer');
    });
    if (loader) loader.style.display = 'none';
  }

  // Known-unframeable: show the explanation immediately instead of pointing an
  // iframe at a site that will refuse it (blank frame + console violation only).
  // No early return — the close/back/external handlers below must still bind.
  if (!frameable) {
    loaded = true;
    showBlocked();
  } else {
    // Only a heuristic for sites we have no verified header data for (custom
    // URL). Generous: heavy web3 apps routinely take >10s, and firing early
    // would show a false "can't be embedded" on a perfectly frameable site.
    setTimeout(() => { if (!loaded) showBlocked(); }, 15000);
  }
  setTimeout(() => { if (loader) loader.style.display = 'none'; }, 9000);

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
    iframe.src = safeUrl;
  });

  // External tab fallback
  document.getElementById('dappBrowserExternal').addEventListener('click', () => {
    window.open(safeUrl, '_blank', 'noopener,noreferrer');
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
          <div class="dapp-card" data-url="${escapeHtml(d.url)}" data-name="${escapeHtml(d.name)}" data-frameable="${d.frameable ? '1' : '0'}">
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
      openDappBrowser(card.dataset.url, card.dataset.name, card.dataset.frameable === '1');
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
