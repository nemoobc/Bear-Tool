// ═══════════════════════════════════════════════════════════════
// Bear Tool — app.js (entry point, slim orchestrator)
// Boot, router, topbar, wallet lifecycle modals, dashboard,
// approvals, activity, settings. Feature logic lives in modules:
// send.js / swap.js / bridge.js / eip7702.js / deploy.js / nft.js.
// ═══════════════════════════════════════════════════════════════

import { POPULAR_TOKENS, ERC20_ABI,
         getAllNetworks, getNetworkById, getProvider,
         addCustomNetwork } from './network.js';
import * as wallet from './wallet.js';
import { $, $all, toast, openModal, closeModal, spinner, confirmTx, promptPassword,
         fmtAmount, fmtUsd, fmtTime, escapeHtml, animateValue } from './ui.js';
import { runIntro, initTheme } from './theme.js';
import { get, set, on, setUnlockHandler, addActivity, loadActivity } from './state.js';
import { fetchAllPrices, fetchPriceHistory } from './price.js';
import { waitForReceipt } from './safetx.js';
import { bindSendEvents, loadSendTokens } from './send.js';
import { bindSwapEvents, loadSwapTokens } from './swap.js';
import { bindBridgeEvents, loadBridgeChains } from './bridge.js';
import { bindEip7702Events, loadEip7702 } from './eip7702.js';
import { bindEip7702ToolsEvents } from './eip7702-tools.js';
import { bindDeployEvents } from './deploy.js';
import { loadNfts } from './nft.js';
import { t, setLang, applyTranslations } from './i18n.js';

const { ethers } = globalThis;

// ── boot ──
window.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  setUnlockHandler(showUnlockModal);
  on('refresh', () => {
    if (!get('unlocked')) return;
    loadDashboard();
    if ($('#view-activity').classList.contains('active')) renderActivity();
  });
  bindNav();
  bindTopbar();
  bindViews();
  initTheme();
  runIntro(() => {
    if (wallet.getKeystore()) showUnlockModal();
    else showWelcomeModal();
  });
  window.addEventListener('unhandledrejection', (e) => {
    console.error('[BearTool] unhandled rejection:', e.reason);
    toast('Unexpected error: ' + (e.reason?.message || 'unknown'), 'error');
  });
  window.addEventListener('error', (e) => {
    console.error('[BearTool] uncaught error:', e.message, e.filename, e.lineno);
    toast('Unexpected error: ' + e.message, 'error');
  });

  // ── token search ──
  document.getElementById('tokenSearchInput')?.addEventListener('input', () => {
    if (window._assetTokens) renderAssets(window._assetTokens);
  });

  // ── offline detection ──
  const offlineBanner = document.getElementById('offlineBanner');
  const updateOnline = () => {
    if (navigator.onLine) {
      offlineBanner?.classList.add('hidden');
    } else {
      offlineBanner?.classList.remove('hidden');
    }
  };
  window.addEventListener('online', updateOnline);
  window.addEventListener('offline', updateOnline);
  updateOnline();

  // ── copy-to-clipboard ──
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.copy-btn');
    if (!btn) return;
    const text = btn.dataset.copy;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      btn.classList.add('copied');
      toast('Copied!', 'success');
      setTimeout(() => btn.classList.remove('copied'), 1500);
    } catch {
      toast('Copy failed', 'error');
    }
  });
});

// ── settings ──
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('bear.settings') || '{}');
    set('settings', { ...get('settings'), ...s });
  } catch {}
  setLang(get('settings').lang || 'en');
  applyTranslations();
}
function saveSettings() {
  localStorage.setItem('bear.settings', JSON.stringify(get('settings')));
}

// ── nav ──
function bindNav() {
  // sidebar nav
  $all('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      const view = item.dataset.view;
      // Swap and Bridge share one nav button: first click opens Swap,
      // clicking the button again while already on Swap offers the choice.
      if (view === 'swap' && $('#view-swap')?.classList.contains('active')) {
        showSwapBridgeChooser();
        return;
      }
      switchView(view);
    });
  });
  // mobile bottom nav
  $all('.mobile-nav-item').forEach(item => {
    item.addEventListener('click', () => {
      const view = item.dataset.view;
      // same one-button Swap/Bridge pattern — Bridge is otherwise unreachable
      if (view === 'swap' && $('#view-swap')?.classList.contains('active')) {
        showSwapBridgeChooser();
        return;
      }
      switchView(view);
    });
  });
  // dashboard quick actions
  $all('.quick-action-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.view) switchView(btn.dataset.view);
    });
  });
}

function switchView(view) {
  $all('.nav-item').forEach(i => i.classList.remove('active'));
  $all('.mobile-nav-item').forEach(i => i.classList.remove('active'));
  // Bridge lives behind the Swap nav button, so Swap stays highlighted there.
  const navView = view === 'bridge' ? 'swap' : view;
  const sidebarItem = $(`.nav-item[data-view="${navView}"]`);
  const mobileItem = $(`.mobile-nav-item[data-view="${navView}"]`);
  if (sidebarItem) sidebarItem.classList.add('active');
  if (mobileItem) mobileItem.classList.add('active');
  $all('.view').forEach(v => v.classList.remove('active'));
  $('#view-' + view).classList.add('active');
  refreshView(view);
}

// Second click on the Swap nav item — pick between same-chain swap and bridge.
function showSwapBridgeChooser() {
  openModal(`
    <button class="modal-close" onclick="document.getElementById('modalOverlay').classList.remove('open')">✕</button>
    <div class="tx-confirm">
      <img src="assets/bear.svg" alt="Bear Tool">
      <div class="question">Swap or Bridge?</div>
    </div>
    <div class="quick-actions" style="grid-template-columns:1fr 1fr">
      <button class="quick-action-btn" id="chooseSwap">
        <span class="qa-icon"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg></span>
        <span class="qa-label">Swap</span>
      </button>
      <button class="quick-action-btn" id="chooseBridge">
        <span class="qa-icon"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg></span>
        <span class="qa-label">Bridge</span>
      </button>
    </div>
  `);
  $('#chooseSwap').onclick = () => { closeModal(); switchView('swap'); };
  $('#chooseBridge').onclick = () => { closeModal(); switchView('bridge'); };
}

function refreshView(view) {
  if (!get('unlocked')) return;
  if (view === 'dashboard') loadDashboard();
  if (view === 'send') loadSendTokens();
  if (view === 'swap') loadSwapTokens();
  if (view === 'bridge') loadBridgeChains();
  if (view === 'eip7702') loadEip7702();
  if (view === 'activity') renderActivity();
}

// ── topbar ──
function bindTopbar() {
  $('#btnHome').addEventListener('click', () => {
    switchView('dashboard');
  });
  $('#networkPill').addEventListener('click', showNetworkModal);
  $('#accountPill').addEventListener('click', showAccountModal);
}

function updateTopbar() {
  const net = getNetworkById(get('networkId'));
  const pill = $('#networkPill');
  pill.className = 'network-pill ' + (net?.type || 'mainnet');
  const netLogoEl = pill.querySelector('.net-logo');
  if (netLogoEl) netLogoEl.innerHTML = getNetworkLogo(net?.name, 18);
  else {
    const logoWrap = document.createElement('span');
    logoWrap.className = 'net-logo';
    logoWrap.innerHTML = getNetworkLogo(net?.name, 18);
    pill.prepend(logoWrap);
  }
  // Remove the old .dot span if present
  const oldDot = pill.querySelector('.dot');
  if (oldDot) oldDot.remove();
  $('#networkName').textContent = net?.name || '?';
  $('#accountShort').textContent = get('address') ? wallet.shortAddress(get('address')) : 'Not connected';
}

// ── welcome / unlock modals ──
function showWelcomeModal() {
  openModal(`
    <div class="welcome-full">
      <div class="welcome-logo">
        <img src="assets/bear.svg" alt="Bear Tool" style="width:80px;height:80px">
      </div>
      <h1 class="welcome-title">Bear Tool</h1>
      <p class="welcome-sub">Self-custody wallet</p>
      <div class="welcome-actions">
        <button class="btn btn-primary btn-lg btn-block" id="wCreate">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Create Wallet
        </button>
        <button class="btn btn-secondary btn-lg btn-block" id="wImport">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Import Wallet
        </button>
      </div>
    </div>
  `, { fullscreen: true });
  $('#wCreate').onclick = () => { closeModal(); showCreateModal(); };
  $('#wImport').onclick = () => { closeModal(); showImportModal(); };
}

function showUnlockModal() {
  openModal(`
    <button class="modal-close" onclick="document.getElementById('modalOverlay').classList.remove('open')">✕</button>
    <div class="tx-confirm">
      <img src="assets/bear.svg" alt="Bear Tool">
      <div class="question">${escapeHtml(t('unlock.title'))}</div>
      <div class="field">
        <label for="unlockPw">Password</label>
        <input class="input" id="unlockPw" type="password" placeholder="••••••••">
      </div>
      <button class="btn btn-primary btn-block" id="unlockBtn">${escapeHtml(t('unlock.button'))}</button>
    </div>
  `);
  const pw = $('#unlockPw');
  pw.focus();
  const doUnlock = async () => {
    try {
      const signer = await wallet.unlockWallet(pw.value);
      set('signer', signer);
      set('address', signer.address);
      set('unlocked', true);
      pw.value = '';
      closeModal();
      toast('Wallet unlocked! 🐻', 'success');
      updateTopbar();
      loadDashboard();
      startAutoLock();
    } catch (e) {
      toast('Wrong password: ' + e.message, 'error');
    }
  };
  $('#unlockBtn').onclick = doUnlock;
  pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') doUnlock(); });
}

function showCreateModal() {
  openModal(`
    <div class="modal-full">
      <h2>🐻 Create Wallet</h2>
      <div class="field">
        <label for="createPw">Password (min 8 chars)</label>
        <input class="input" id="createPw" type="password" placeholder="••••••••">
      </div>
      <div class="field">
        <label for="createPw2">Repeat password</label>
        <input class="input" id="createPw2" type="password" placeholder="••••••••">
      </div>
      <div class="danger-box">⚠️ You will see your seed phrase ONCE. Write it down. Anyone with it controls your funds.</div>
      <button class="btn btn-primary btn-block btn-lg" id="createBtn">Create</button>
    </div>
  `);
  $('#createBtn').onclick = async () => {
    const p1 = $('#createPw').value, p2 = $('#createPw2').value;
    if (p1.length < 8) return toast('Password too short (min 8)', 'error');
    if (p1 !== p2) return toast('Passwords do not match', 'error');
    try {
      const res = await wallet.createWallet(p1);
      $('#createPw').value = ''; $('#createPw2').value = '';
      showSeedPhrase(res.mnemonic, res.address);
    } catch (e) { toast('Error: ' + e.message, 'error'); }
  };
}

function showSeedPhrase(mnemonic, address) {
  const words = mnemonic.split(' ');
  // Pick 3 random words for verification, one is correct
  const correctIdx = Math.floor(Math.random() * 3);
  const correctWord = words[0]; // Always verify word #1
  const distractors = [];
  const allWords = [...words];
  while (distractors.length < 2) {
    const w = allWords[Math.floor(Math.random() * allWords.length)];
    if (w !== correctWord && !distractors.includes(w)) distractors.push(w);
  }
  // Build choices array
  const choices = [...distractors];
  choices.splice(correctIdx, 0, correctWord);

  openModal(`
    <button class="modal-close" onclick="document.getElementById('modalOverlay').classList.remove('open')">✕</button>
    <h2>🔑 Your Seed Phrase</h2>
    <div class="danger-box">Write these 12 words DOWN. Never share them. Never type them into any website.</div>
    <div class="card" style="box-shadow:none;background:var(--cream)">
      <div class="mono" style="font-size:1.1rem;line-height:2">${words.map((w, i) => `<b>${i + 1}.</b> ${escapeHtml(w)}`).join(' ')}</div>
    </div>
    <div class="field">
      <label>Select word #1 to confirm</label>
      <div class="seed-choices" id="seedChoices">
        ${choices.map((w, i) => `<button class="btn btn-ghost seed-choice-btn" data-word="${escapeHtml(w)}" data-idx="${i}">${escapeHtml(w)}</button>`).join('')}
      </div>
    </div>
    <button class="btn btn-primary btn-block" id="seedDone" disabled>I saved it</button>
  `);

  let verified = false;
  $all('.seed-choice-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $all('.seed-choice-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      if (btn.dataset.word.toLowerCase() === correctWord.toLowerCase()) {
        verified = true;
        btn.style.background = 'var(--mint)';
        btn.style.color = 'var(--white)';
        $('#seedDone').disabled = false;
      } else {
        verified = false;
        btn.style.background = 'var(--danger)';
        btn.style.color = 'var(--white)';
        toast('Wrong word! Try again.', 'error');
        $('#seedDone').disabled = true;
      }
    });
  });

  $('#seedDone').onclick = () => {
    if (!verified) return;
    set('signer', ethers.Wallet.fromPhrase(mnemonic));
    set('address', address);
    set('unlocked', true);
    closeModal();
    toast('Wallet created! 🐻', 'success');
    updateTopbar();
    loadDashboard();
    startAutoLock();
  };
}

function showImportModal() {
  openModal(`
    <div class="modal-full">
      <h2>📥 Import Wallet</h2>
      <div class="field">
        <label for="importSecret">Seed phrase (12/24 words) or private key</label>
        <textarea class="textarea" id="importSecret" placeholder="word1 word2 ..."></textarea>
      </div>
      <div class="field">
        <label for="importPw">New password</label>
        <input class="input" id="importPw" type="password" placeholder="••••••••">
      </div>
      <div class="danger-box">⚠️ Never import a seed phrase on a website you don't trust. This tool is 100% client-side.</div>
      <button class="btn btn-primary btn-block btn-lg" id="importBtn">Import</button>
    </div>
  `);
  $('#importBtn').onclick = async () => {
    const secret = $('#importSecret').value.trim();
    const pw = $('#importPw').value;
    if (!secret) return toast('Enter seed phrase or private key', 'error');
    if (pw.length < 8) return toast('Password too short (min 8)', 'error');
    try {
      const res = await wallet.importWallet(secret, pw);
      set('signer', new ethers.Wallet(secret.startsWith('0x') ? secret : ethers.Wallet.fromPhrase(secret).privateKey));
      set('address', res.address);
      set('unlocked', true);
      $('#importSecret').value = ''; $('#importPw').value = '';
      closeModal();
      toast('Wallet imported! 🐻', 'success');
      updateTopbar();
      loadDashboard();
      startAutoLock();
    } catch (e) { toast('Import failed: ' + e.message, 'error'); }
  };
}

// ── auto-lock ──
let lockTimer = null;
function startAutoLock() {
  clearTimeout(lockTimer);
  lockTimer = setTimeout(() => {
    set('unlocked', false);
    set('signer', null);
    toast('Auto-locked 🔒', 'info');
    showUnlockModal();
  }, get('settings').autoLock * 60 * 1000);
}
function resetLock() {
  if (get('unlocked')) startAutoLock();
}
['click', 'keydown', 'mousemove'].forEach(ev =>
  window.addEventListener(ev, resetLock, { passive: true })
);

// ── network SVG logos ──
function getNetworkLogo(name, size = 24) {
  const n = (name || '').toLowerCase();
  // Ethereum — blue diamond
  if (n === 'ethereum' || n === 'eth') {
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}"><path d="M12 2L5 12l7 10 7-10z" fill="#627EEA"/><path d="M12 2L5 12l7 10" fill="#8B9FE8" opacity="0.7"/></svg>`;
  }
  // Sepolia — blue diamond with S
  if (n === 'sepolia') {
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}"><path d="M12 2L5 12l7 10 7-10z" fill="#627EEA"/><path d="M12 2L5 12l7 10" fill="#8B9FE8" opacity="0.7"/><text x="12" y="15" text-anchor="middle" fill="white" font-size="8" font-weight="800" font-family="Arial">S</text></svg>`;
  }
  // Arbitrum — blue circle with A chevron
  if (n.includes('arbitrum')) {
    const isTest = n.includes('sepolia');
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}"><circle cx="12" cy="12" r="11" fill="#28A0F0"/><path d="M8 16l4-10 4 10" fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M9.5 13h5" fill="none" stroke="white" stroke-width="1.8" stroke-linecap="round"/>${isTest ? '<circle cx="19" cy="5" r="3.5" fill="#06D6A0" stroke="white" stroke-width="1.5"/><text x="19" y="6.5" text-anchor="middle" fill="white" font-size="5" font-weight="800" font-family="Arial">T</text>' : ''}</svg>`;
  }
  // Optimism — red circle with OP
  if (n.includes('optimism') || n === 'op mainnet' || n === 'op sepolia') {
    const isTest = n.includes('sepolia');
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}"><circle cx="12" cy="12" r="11" fill="#FF0420"/><text x="12" y="16" text-anchor="middle" fill="white" font-size="8" font-weight="800" font-family="Arial">OP</text>${isTest ? '<circle cx="19" cy="5" r="3.5" fill="#06D6A0" stroke="white" stroke-width="1.5"/><text x="19" y="6.5" text-anchor="middle" fill="white" font-size="5" font-weight="800" font-family="Arial">T</text>' : ''}</svg>`;
  }
  // Base — blue circle with B
  if (n === 'base' || n === 'base sepolia') {
    const isTest = n.includes('sepolia');
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}"><circle cx="12" cy="12" r="11" fill="#0052FF"/><text x="12" y="16" text-anchor="middle" fill="white" font-size="9" font-weight="800" font-family="Arial">B</text>${isTest ? '<circle cx="19" cy="5" r="3.5" fill="#06D6A0" stroke="white" stroke-width="1.5"/><text x="19" y="6.5" text-anchor="middle" fill="white" font-size="5" font-weight="800" font-family="Arial">T</text>' : ''}</svg>`;
  }
  // Polygon — purple hexagon
  if (n.includes('polygon') || n === 'amoy') {
    const isTest = n.includes('amoy');
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}"><polygon points="12,1 21,6.5 21,17.5 12,23 3,17.5 3,6.5" fill="#8247E5"/><text x="12" y="16" text-anchor="middle" fill="white" font-size="7" font-weight="800" font-family="Arial">POL</text>${isTest ? '<circle cx="19" cy="5" r="3.5" fill="#06D6A0" stroke="white" stroke-width="1.5"/><text x="19" y="6.5" text-anchor="middle" fill="white" font-size="5" font-weight="800" font-family="Arial">T</text>' : ''}</svg>`;
  }
  // BSC — yellow diamond
  if (n.includes('bnb') || n.includes('bsc')) {
    const isTest = n.includes('testnet');
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}"><path d="M12 2L2 12l10 10 10-10z" fill="#F0B90B"/><path d="M8 9h8l-4 6z" fill="#2D2A32"/><path d="M8 9l4-4 4 4" fill="none" stroke="#2D2A32" stroke-width="1.5" stroke-linejoin="round"/><path d="M8 15l4 4 4-4" fill="none" stroke="#2D2A32" stroke-width="1.5" stroke-linejoin="round"/>${isTest ? '<circle cx="19" cy="5" r="3.5" fill="#06D6A0" stroke="white" stroke-width="1.5"/><text x="19" y="6.5" text-anchor="middle" fill="white" font-size="5" font-weight="800" font-family="Arial">T</text>' : ''}</svg>`;
  }
  // Avalanche — red triangle
  if (n.includes('avalanche')) {
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}"><polygon points="12,2 2,22 22,22" fill="#E84142"/><text x="12" y="18" text-anchor="middle" fill="white" font-size="7" font-weight="800" font-family="Arial">AVAX</text></svg>`;
  }
  // Custom / unknown — satellite icon
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}"><circle cx="12" cy="12" r="10" fill="#9B5DE5"/><circle cx="12" cy="12" r="4" fill="white"/><line x1="12" y1="2" x2="12" y2="6" stroke="white" stroke-width="2" stroke-linecap="round"/><line x1="12" y1="18" x2="12" y2="22" stroke="white" stroke-width="2" stroke-linecap="round"/><line x1="2" y1="12" x2="6" y2="12" stroke="white" stroke-width="2" stroke-linecap="round"/><line x1="18" y1="12" x2="22" y2="12" stroke="white" stroke-width="2" stroke-linecap="round"/></svg>`;
}

// ── network modal ──
function showNetworkModal() {
  const nets = getAllNetworks();
  const html = `
    <button class="modal-close" onclick="document.getElementById('modalOverlay').classList.remove('open')">✕</button>
    <h2>🌐 Networks</h2>
    <div class="field" style="margin-bottom:12px">
      <input class="input" id="netSearchInput" type="text" placeholder="🔍 Search networks..." style="width:100%">
    </div>
    <div id="netListMainnet">
      <div class="mb-8"><span class="badge badge-mainnet">MAINNET</span></div>
      ${nets.filter(n => n.type === 'mainnet').map(n => netRow(n)).join('')}
    </div>
    <div id="netListTestnet">
      <div class="mb-8 mt-16"><span class="badge badge-testnet">TESTNET</span></div>
      ${nets.filter(n => n.type === 'testnet').map(n => netRow(n)).join('')}
    </div>
    <hr class="mt-16 mb-16">
    <button class="btn btn-secondary btn-block" id="addNetBtn">+ Add Custom Network</button>
  `;
  openModal(html);
  // network search
  const searchInput = $('#netSearchInput');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      const q = searchInput.value.toLowerCase().trim();
      $all('[data-net]').forEach(el => {
        const name = (el.querySelector('.asset-name')?.textContent || '').toLowerCase();
        const chainId = (el.querySelector('.asset-symbol')?.textContent || '').toLowerCase();
        el.style.display = (!q || name.includes(q) || chainId.includes(q)) ? '' : 'none';
      });
      // hide section headers if all rows hidden
      const mainnetRows = document.querySelectorAll('#netListMainnet [data-net]');
      const testnetRows = document.querySelectorAll('#netListTestnet [data-net]');
      const mainnetVisible = [...mainnetRows].some(r => r.style.display !== 'none');
      const testnetVisible = [...testnetRows].some(r => r.style.display !== 'none');
      document.querySelector('#netListMainnet .mb-8').style.display = mainnetVisible ? '' : 'none';
      document.querySelector('#netListTestnet .mb-8').style.display = testnetVisible ? '' : 'none';
    });
    searchInput.focus();
  }
  $('#addNetBtn').onclick = showAddNetworkModal;
  $all('[data-net]').forEach(el => el.addEventListener('click', () => {
    set('networkId', el.dataset.net);
    closeModal();
    toast('Network switched', 'success');
    updateTopbar();
    if (get('unlocked')) loadDashboard();
  }));
}

function netRow(n) {
  const active = n.id === get('networkId') ? 'style="border-left:8px solid var(--mint)"' : '';
  return `<div class="asset-row" data-net="${escapeHtml(n.id)}" ${active}>
    <div class="net-logo">${getNetworkLogo(n.name, 32)}</div>
    <div class="asset-info"><div class="asset-name">${escapeHtml(n.name)}</div>
      <div class="asset-symbol">Chain ${escapeHtml(String(n.chainId))} · ${escapeHtml(n.symbol)}</div></div>
    <span class="badge ${n.type === 'mainnet' ? 'badge-mainnet' : 'badge-testnet'}">${escapeHtml(n.type)}</span>
  </div>`;
}

function showAddNetworkModal() {
  openModal(`
    <button class="modal-close" onclick="document.getElementById('modalOverlay').classList.remove('open')">✕</button>
    <h2>➕ Custom Network</h2>
    <div class="field"><label>Name</label><input class="input" id="cnName" placeholder="My Chain"></div>
    <div class="field"><label>Chain ID</label><input class="input" id="cnChainId" type="number" placeholder="12345"></div>
    <div class="field"><label>RPC URL</label><input class="input" id="cnRpc" placeholder="https://..."></div>
    <div class="field"><label>Symbol</label><input class="input" id="cnSymbol" placeholder="MYC"></div>
    <div class="field"><label>Explorer URL</label><input class="input" id="cnExplorer" placeholder="https://..."></div>
    <div class="field"><label>Type</label>
      <select class="select" id="cnType"><option value="mainnet">Mainnet</option><option value="testnet">Testnet</option></select>
    </div>
    <div class="danger-box">⚠️ Custom RPC = you trust this provider with your address and balance data.</div>
    <button class="btn btn-primary btn-block" id="cnSave">Save Network</button>
  `);
  $('#cnSave').onclick = () => {
    const rpc = $('#cnRpc').value.trim();
    if (!/^https:\/\//.test(rpc)) return toast('RPC must be an https:// URL', 'error');
    const net = {
      name: $('#cnName').value.trim(),
      chainId: Number($('#cnChainId').value),
      rpc: [rpc],
      symbol: $('#cnSymbol').value.trim() || 'ETH',
      decimals: 18,
      explorer: $('#cnExplorer').value.trim(),
      type: $('#cnType').value,
      icon: '🛰️', color: '#9B5DE5'
    };
    if (!net.name || !net.chainId || !net.rpc[0]) return toast('Fill name, chainId, RPC', 'error');
    addCustomNetwork(net);
    closeModal();
    toast('Network added!', 'success');
    showNetworkModal();
  };
}

// ── account modal ──
function showAccountModal() {
  if (!get('unlocked')) return showUnlockModal();
  const accounts = wallet.getAccounts();
  const idx = wallet.getActiveAccountIndex();
  openModal(`
    <button class="modal-close" onclick="document.getElementById('modalOverlay').classList.remove('open')">✕</button>
    <h2>🐻 Accounts</h2>
    ${accounts.map((a, i) => `
      <div class="asset-row ${i === idx ? 'active' : ''}" data-acc="${i}">
        <div class="asset-icon">🐻</div>
        <div class="asset-info">
          <div class="asset-name">Account ${i + 1} ${i === idx ? '(active)' : ''}</div>
          <div class="mono">${escapeHtml(a.address)}</div>
        </div>
      </div>`).join('')}
    <button class="btn btn-secondary btn-block mt-8" id="addAccBtn">+ Add Account</button>
    <button class="btn btn-ghost btn-block mt-8" id="exportBtn">📤 Export Secret</button>
    <button class="btn btn-danger btn-block mt-8" id="lockBtn">🔒 Lock</button>
  `);
  $all('[data-acc]').forEach(el => el.addEventListener('click', async () => {
    const i = Number(el.dataset.acc);
    wallet.setActiveAccount(i);
    const pw = await promptPassword('Unlock to switch account');
    if (!pw) return;
    try {
      const signer = await wallet.unlockWallet(pw);
      set('signer', signer);
      set('address', signer.address);
      closeModal();
      toast('Switched account', 'success');
      updateTopbar();
      loadDashboard();
    } catch { toast('Wrong password', 'error'); }
  }));
  $('#addAccBtn').onclick = async () => {
    const pw = await promptPassword('Enter password to derive new account');
    if (!pw) return;
    try {
      const addr = await wallet.deriveNextAccount(pw);
      toast('Account added: ' + wallet.shortAddress(addr), 'success');
      showAccountModal();
    } catch { toast('Wrong password', 'error'); }
  };
  $('#exportBtn').onclick = async () => {
    const pw = await promptPassword('Enter password to export');
    if (!pw) return;
    try {
      const secret = await wallet.exportSecret(pw);
      openModal(`
        <button class="modal-close" onclick="document.getElementById('modalOverlay').classList.remove('open')">✕</button>
        <h2>📤 Your Secret</h2>
        <div class="danger-box">Never share this. Anyone with it controls your funds.</div>
        <div class="card" style="box-shadow:none"><div class="mono">${escapeHtml(secret)}</div></div>
        <button class="btn btn-primary btn-block" onclick="document.getElementById('modalOverlay').classList.remove('open')">Close</button>
      `);
    } catch { toast('Wrong password', 'error'); }
  };
  $('#lockBtn').onclick = () => {
    set('unlocked', false); set('signer', null);
    closeModal();
    toast('Locked 🔒', 'info');
    showUnlockModal();
  };
}

// ── dashboard ──
async function loadDashboard() {
  if (!get('unlocked')) return;
  const net = getNetworkById(get('networkId'));
  const addr = get('address');
  // Network name only — the wallet address is shown once, in the
  // walletStatus row below (next to its copy button). Showing it in both
  // places was a visible duplicate.
  $('#balanceSub').textContent = net.name;

  // ── wallet status ──
  const statusDot = document.querySelector('.status-dot');
  const statusText = document.querySelector('.status-text');
  const copyBtn = document.getElementById('copyAddress');
  if (statusDot) { statusDot.className = 'status-dot connected'; }
  if (statusText) { statusText.textContent = wallet.shortAddress(addr); }
  if (copyBtn) { copyBtn.dataset.copy = addr; copyBtn.style.display = ''; }

  const assetList = $('#assetList');
  if (!assetList) return;
  assetList.innerHTML = spinner(64, 'Loading assets...');
  try {
    const provider = await getProvider(net.chainId);
    set('provider', provider);
    const balance = await provider.getBalance(get('address'));
    const native = {
      address: null, symbol: net.symbol, decimals: net.decimals,
      balance: balance.toString(), usd: null
    };
    const tokens = [native];
    // List every popular token for the chain — including ones the user holds
    // 0 of — so the dashboard is a usable coin list, not an empty screen for
    // a fresh wallet. Balance is filled from the chain; failures fall back to 0.
    const popular = POPULAR_TOKENS[net.chainId] || [];
    const results = await Promise.allSettled(popular.map(async (t) => {
      const c = new ethers.Contract(t.address, ERC20_ABI, provider);
      const bal = await c.balanceOf(get('address'));
      return { address: t.address, symbol: t.symbol, decimals: t.decimals, balance: bal.toString(), usd: null };
    }));
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') tokens.push(r.value);
      else tokens.push({
        address: popular[i].address, symbol: popular[i].symbol,
        decimals: popular[i].decimals, balance: '0', usd: null
      });
    });
    set('tokens', tokens);
    // USD prices (CoinGecko → DexScreener → cache)
    try {
      const prices = await fetchAllPrices(tokens, net.chainId);
      tokens.forEach(t => {
        const p = prices.get(t.address || 'native');
        if (p !== undefined && p !== null) t.usd = p;
      });
    } catch {}
    renderAssets(tokens);
    // not awaited on purpose (NFT scan is slow) — but its rejection must be
    // handled here, or a null element becomes a global "Unexpected error" toast
    loadNfts().catch((e) => console.warn('[BearTool] NFT scan failed:', e?.message || e));
  } catch (e) {
    assetList.innerHTML = `<p class="small text-center">Error: ${escapeHtml(e.message)}</p>`;
  }
}

// USD value of what the user actually holds (amount × unit price).
// The home total and each asset row must show this, NOT the token's unit
// price — summing unit prices made the portfolio total nonsense ($0.99 for
// 1 ETH) and made the rows read like a price ticker.
function holdingUsd(t) {
  if (t.usd === null || t.usd === undefined) return 0;
  let amt = 0;
  try { amt = Number(ethers.formatUnits(t.balance || '0', t.decimals ?? 18)); }
  catch { amt = 0; }
  if (!Number.isFinite(amt)) amt = 0;
  return amt * t.usd;
}

function renderAssets(tokens) {
  const assetList = $('#assetList');
  if (!assetList) return;
  const totalUsd = tokens.reduce((s, t) => s + holdingUsd(t), 0);
  animateValue($('#totalBalance'), totalUsd, { duration: 600, formatter: fmtUsd });
  if (!tokens.length) {
    assetList.innerHTML = '<p class="small text-center">No assets found.</p>';
    $('#assetSearch').style.display = 'none';
    return;
  }
  // Show search if > 3 tokens
  $('#assetSearch').style.display = tokens.length > 3 ? '' : 'none';
  // Token SVG logos — unique IDs per symbol to avoid gradient clash
  const tokenLogos = {
    eth: (i) => `<svg viewBox="0 0 32 32" width="32" height="32"><defs><linearGradient id="ethG${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#627EEA"/><stop offset="100%" stop-color="#8B9FE8"/></linearGradient></defs><circle cx="16" cy="16" r="16" fill="url(#ethG${i})"/><text x="16" y="21" text-anchor="middle" fill="white" font-size="14" font-weight="800" font-family="Arial">Ξ</text></svg>`,
    usdc: (i) => `<svg viewBox="0 0 32 32" width="32" height="32"><defs><linearGradient id="usdcG${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#2775CA"/><stop offset="100%" stop-color="#4A9AE8"/></linearGradient></defs><circle cx="16" cy="16" r="16" fill="url(#usdcG${i})"/><text x="16" y="21" text-anchor="middle" fill="white" font-size="11" font-weight="800" font-family="Arial">$</text></svg>`,
    usdt: (i) => `<svg viewBox="0 0 32 32" width="32" height="32"><defs><linearGradient id="usdtG${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#26A17B"/><stop offset="100%" stop-color="#3DD68C"/></linearGradient></defs><circle cx="16" cy="16" r="16" fill="url(#usdtG${i})"/><text x="16" y="21" text-anchor="middle" fill="white" font-size="12" font-weight="800" font-family="Arial">₮</text></svg>`,
    dai: (i) => `<svg viewBox="0 0 32 32" width="32" height="32"><defs><linearGradient id="daiG${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#F5AC37"/><stop offset="100%" stop-color="#F8C967"/></linearGradient></defs><circle cx="16" cy="16" r="16" fill="url(#daiG${i})"/><text x="16" y="21" text-anchor="middle" fill="white" font-size="12" font-weight="800" font-family="Arial">D</text></svg>`,
    wbtc: (i) => `<svg viewBox="0 0 32 32" width="32" height="32"><defs><linearGradient id="wbtcG${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#F7931A"/><stop offset="100%" stop-color="#F8B34A"/></linearGradient></defs><circle cx="16" cy="16" r="16" fill="url(#wbtcG${i})"/><text x="16" y="21" text-anchor="middle" fill="white" font-size="12" font-weight="800" font-family="Arial">B</text></svg>`,
    link: (i) => `<svg viewBox="0 0 32 32" width="32" height="32"><defs><linearGradient id="linkG${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#2A5ADA"/><stop offset="100%" stop-color="#5B8DEF"/></linearGradient></defs><circle cx="16" cy="16" r="16" fill="url(#linkG${i})"/><text x="16" y="21" text-anchor="middle" fill="white" font-size="13" font-weight="800" font-family="Arial">⬡</text></svg>`,
    uni: (i) => `<svg viewBox="0 0 32 32" width="32" height="32"><defs><linearGradient id="uniG${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#FF007A"/><stop offset="100%" stop-color="#FF4DA6"/></linearGradient></defs><circle cx="16" cy="16" r="16" fill="url(#uniG${i})"/><text x="16" y="21" text-anchor="middle" fill="white" font-size="13" font-weight="800" font-family="Arial">U</text></svg>`,
    aave: (i) => `<svg viewBox="0 0 32 32" width="32" height="32"><defs><linearGradient id="aaveG${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#B6509E"/><stop offset="100%" stop-color="#2EBAC6"/></linearGradient></defs><circle cx="16" cy="16" r="16" fill="url(#aaveG${i})"/><text x="16" y="21" text-anchor="middle" fill="white" font-size="12" font-weight="800" font-family="Arial">AA</text></svg>`,
    reth: (i) => `<svg viewBox="0 0 32 32" width="32" height="32"><defs><linearGradient id="rethG${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#E84142"/><stop offset="100%" stop-color="#FF6B6B"/></linearGradient></defs><circle cx="16" cy="16" r="16" fill="url(#rethG${i})"/><text x="16" y="21" text-anchor="middle" fill="white" font-size="11" font-weight="800" font-family="Arial">rΞ</text></svg>`,
    cbeth: (i) => `<svg viewBox="0 0 32 32" width="32" height="32"><defs><linearGradient id="cbethG${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#0052FF"/><stop offset="100%" stop-color="#4D8BFF"/></linearGradient></defs><circle cx="16" cy="16" r="16" fill="url(#cbethG${i})"/><text x="16" y="21" text-anchor="middle" fill="white" font-size="11" font-weight="800" font-family="Arial">cb</text></svg>`,
    wsteth: (i) => `<svg viewBox="0 0 32 32" width="32" height="32"><defs><linearGradient id="wstG${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#00A3FF"/><stop offset="100%" stop-color="#66C2FF"/></linearGradient></defs><circle cx="16" cy="16" r="16" fill="url(#wstG${i})"/><text x="16" y="21" text-anchor="middle" fill="white" font-size="10" font-weight="800" font-family="Arial">wΞ</text></svg>`,
    frax: (i) => `<svg viewBox="0 0 32 32" width="32" height="32"><defs><linearGradient id="fraxG${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#000"/><stop offset="100%" stop-color="#333"/></linearGradient></defs><circle cx="16" cy="16" r="16" fill="url(#fraxG${i})"/><text x="16" y="21" text-anchor="middle" fill="white" font-size="11" font-weight="800" font-family="Arial">FX</text></svg>`,
    default: (i) => `<svg viewBox="0 0 32 32" width="32" height="32"><circle cx="16" cy="16" r="16" fill="#FFD9C0"/><text x="16" y="21" text-anchor="middle" fill="#2D2A32" font-size="11" font-weight="800" font-family="Arial">?</text></svg>`
  };
  const getLogo = (sym, idx) => {
    const s = (sym || '').toLowerCase();
    const i = idx ?? 0;
    if (s === 'eth' || s === 'ether') return tokenLogos.eth(i);
    if (s === 'usdc') return tokenLogos.usdc(i);
    if (s === 'usdt') return tokenLogos.usdt(i);
    if (s === 'dai') return tokenLogos.dai(i);
    if (s === 'wbtc') return tokenLogos.wbtc(i);
    if (s === 'link') return tokenLogos.link(i);
    if (s === 'uni') return tokenLogos.uni(i);
    if (s === 'aave') return tokenLogos.aave(i);
    if (s === 'reth') return tokenLogos.reth(i);
    if (s === 'cbeth') return tokenLogos.cbeth(i);
    if (s === 'wsteth') return tokenLogos.wsteth(i);
    if (s === 'frax') return tokenLogos.frax(i);
    return tokenLogos.default(i);
  };
  // Store tokens for filtering
  window._assetTokens = tokens;
  const filter = ($('#tokenSearchInput')?.value || '').toLowerCase();
  const filtered = filter ? tokens.filter(t => (t.symbol || '').toLowerCase().includes(filter)) : tokens;
  assetList.innerHTML = filtered.map((t, i) => `
    <div class="asset-row asset-clickable" data-token-idx="${i}" data-symbol="${escapeHtml(t.symbol || '')}" data-address="${escapeHtml(t.address || '')}" data-decimals="${t.decimals || 18}" data-balance="${escapeHtml(t.balance || '0')}" data-usd="${t.usd || 0}">
      <div class="token-icon-svg">${getLogo(t.symbol, i)}</div>
      <div class="asset-info">
        <div class="asset-name">${escapeHtml(t.symbol)}</div>
        <div class="asset-symbol">${t.address ? escapeHtml(wallet.shortAddress(t.address)) : 'Native'}</div>
      </div>
      <div class="asset-balance">
        <div class="amount">${escapeHtml(fmtAmount(t.balance, t.decimals))}</div>
        <div class="usd">${t.usd ? escapeHtml(fmtUsd(holdingUsd(t))) : '—'}</div>
      </div>
      <div class="asset-arrow"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg></div>
    </div>`).join('');
  if (filtered.length === 0) {
    assetList.innerHTML = '<p class="small text-center">No tokens match your search.</p>';
  }
  // Click handlers
  $all('.asset-clickable').forEach(el => {
    el.addEventListener('click', () => showTokenActions(el));
  });
}

function showTokenActions(el) {
  const symbol = el.dataset.symbol;
  const address = el.dataset.address;
  const decimals = parseInt(el.dataset.decimals) || 18;
  const balance = el.dataset.balance;
  const usd = parseFloat(el.dataset.usd) || 0;
  const net = getNetworkById(get('networkId'));
  // Holding value (what the user owns) vs unit price (price of 1 token)
  let holding = 0;
  try { holding = Number(ethers.formatUnits(balance || '0', decimals)) * usd; } catch { holding = 0; }
  if (!Number.isFinite(holding)) holding = 0;

  openModal(`
    <button class="modal-close" onclick="document.getElementById('modalOverlay').classList.remove('open')">✕</button>
    <div class="token-modal-header">
      <div class="token-modal-icon">${getLogoSVG(symbol)}</div>
      <div class="token-modal-info">
        <div class="token-modal-symbol">${escapeHtml(symbol)}</div>
        <div class="token-modal-balance">${escapeHtml(fmtAmount(balance, decimals))} ${escapeHtml(symbol)}</div>
        <div class="token-modal-usd">${usd ? escapeHtml(fmtUsd(holding)) : '—'}</div>
        ${usd ? `<div class="small" style="opacity:0.7">@ ${escapeHtml(fmtUsd(usd))} / ${escapeHtml(symbol)}</div>` : ''}
      </div>
    </div>
    <div class="token-modal-chart" id="tokenChart">
      <canvas id="tokenPriceChart" width="300" height="100"></canvas>
    </div>
    <div class="token-modal-actions">
      <button class="token-action-btn" id="tokenSend">
        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
        Send
      </button>
      <button class="token-action-btn" id="tokenReceive">
        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>
        Receive
      </button>
      <button class="token-action-btn" id="tokenSwap">
        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
        Swap
      </button>
      <button class="token-action-btn" id="tokenHistory">
        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        History
      </button>
    </div>
    <div class="token-modal-footer">
      <button class="btn btn-ghost btn-block" onclick="document.getElementById('modalOverlay').classList.remove('open')">Close</button>
    </div>
  `);

  // Store for action handlers
  window._tokenModalSymbol = symbol;
  window._tokenModalAddress = address;

  // Draw mini chart from real 24h history
  drawMiniChart({ symbol, address });

  // Action handlers
  $('#tokenSend').onclick = () => { closeModal(); switchView('send'); };
  $('#tokenReceive').onclick = () => { const s = window._tokenModalSymbol; closeModal(); showReceiveModal(get('address'), s); };
  $('#tokenSwap').onclick = () => { closeModal(); switchView('swap'); };
  $('#tokenHistory').onclick = () => { closeModal(); switchView('activity'); };
}

function getLogoSVG(sym) {
  const s = (sym || '').toLowerCase();
  // Use 'm' suffix to avoid collision with getLogo's indexed suffixes
  const logos = {
    eth:    `<svg viewBox="0 0 48 48" width="48" height="48"><defs><linearGradient id="ethGm" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#627EEA"/><stop offset="100%" stop-color="#8B9FE8"/></linearGradient></defs><circle cx="24" cy="24" r="24" fill="url(#ethGm)"/><text x="24" y="32" text-anchor="middle" fill="white" font-size="22" font-weight="800" font-family="Arial">Ξ</text></svg>`,
    usdc:   `<svg viewBox="0 0 48 48" width="48" height="48"><defs><linearGradient id="usdcGm" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#2775CA"/><stop offset="100%" stop-color="#4A9AE8"/></linearGradient></defs><circle cx="24" cy="24" r="24" fill="url(#usdcGm)"/><text x="24" y="32" text-anchor="middle" fill="white" font-size="18" font-weight="800" font-family="Arial">$</text></svg>`,
    usdt:   `<svg viewBox="0 0 48 48" width="48" height="48"><defs><linearGradient id="usdtGm" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#26A17B"/><stop offset="100%" stop-color="#3DD68C"/></linearGradient></defs><circle cx="24" cy="24" r="24" fill="url(#usdtGm)"/><text x="24" y="32" text-anchor="middle" fill="white" font-size="18" font-weight="800" font-family="Arial">₮</text></svg>`,
    dai:    `<svg viewBox="0 0 48 48" width="48" height="48"><defs><linearGradient id="daiGm" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#F5AC37"/><stop offset="100%" stop-color="#F8C967"/></linearGradient></defs><circle cx="24" cy="24" r="24" fill="url(#daiGm)"/><text x="24" y="32" text-anchor="middle" fill="white" font-size="18" font-weight="800" font-family="Arial">D</text></svg>`,
    wbtc:   `<svg viewBox="0 0 48 48" width="48" height="48"><defs><linearGradient id="wbtcGm" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#F7931A"/><stop offset="100%" stop-color="#F8B34A"/></linearGradient></defs><circle cx="24" cy="24" r="24" fill="url(#wbtcGm)"/><text x="24" y="32" text-anchor="middle" fill="white" font-size="18" font-weight="800" font-family="Arial">B</text></svg>`,
    link:   `<svg viewBox="0 0 48 48" width="48" height="48"><defs><linearGradient id="linkGm" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#2A5ADA"/><stop offset="100%" stop-color="#5B8DEF"/></linearGradient></defs><circle cx="24" cy="24" r="24" fill="url(#linkGm)"/><text x="24" y="32" text-anchor="middle" fill="white" font-size="20" font-weight="800" font-family="Arial">⬡</text></svg>`,
    uni:    `<svg viewBox="0 0 48 48" width="48" height="48"><defs><linearGradient id="uniGm" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#FF007A"/><stop offset="100%" stop-color="#FF4DA6"/></linearGradient></defs><circle cx="24" cy="24" r="24" fill="url(#uniGm)"/><text x="24" y="32" text-anchor="middle" fill="white" font-size="20" font-weight="800" font-family="Arial">U</text></svg>`,
    aave:   `<svg viewBox="0 0 48 48" width="48" height="48"><defs><linearGradient id="aaveGm" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#B6509E"/><stop offset="100%" stop-color="#2EBAC6"/></linearGradient></defs><circle cx="24" cy="24" r="24" fill="url(#aaveGm)"/><text x="24" y="32" text-anchor="middle" fill="white" font-size="16" font-weight="800" font-family="Arial">AA</text></svg>`,
    reth:   `<svg viewBox="0 0 48 48" width="48" height="48"><defs><linearGradient id="rethGm" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#E84142"/><stop offset="100%" stop-color="#FF6B6B"/></linearGradient></defs><circle cx="24" cy="24" r="24" fill="url(#rethGm)"/><text x="24" y="32" text-anchor="middle" fill="white" font-size="16" font-weight="800" font-family="Arial">rΞ</text></svg>`,
    cbeth:  `<svg viewBox="0 0 48 48" width="48" height="48"><defs><linearGradient id="cbethGm" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#0052FF"/><stop offset="100%" stop-color="#4D8BFF"/></linearGradient></defs><circle cx="24" cy="24" r="24" fill="url(#cbethGm)"/><text x="24" y="32" text-anchor="middle" fill="white" font-size="16" font-weight="800" font-family="Arial">cb</text></svg>`,
    wsteth: `<svg viewBox="0 0 48 48" width="48" height="48"><defs><linearGradient id="wstGm" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#00A3FF"/><stop offset="100%" stop-color="#66C2FF"/></linearGradient></defs><circle cx="24" cy="24" r="24" fill="url(#wstGm)"/><text x="24" y="32" text-anchor="middle" fill="white" font-size="14" font-weight="800" font-family="Arial">wΞ</text></svg>`,
    frax:   `<svg viewBox="0 0 48 48" width="48" height="48"><defs><linearGradient id="fraxGm" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#000"/><stop offset="100%" stop-color="#333"/></linearGradient></defs><circle cx="24" cy="24" r="24" fill="url(#fraxGm)"/><text x="24" y="32" text-anchor="middle" fill="white" font-size="16" font-weight="800" font-family="Arial">FX</text></svg>`
  };
  if (s === 'eth' || s === 'ether') return logos.eth;
  if (s === 'usdc') return logos.usdc;
  if (s === 'usdt') return logos.usdt;
  if (s === 'dai') return logos.dai;
  if (s === 'wbtc') return logos.wbtc;
  if (s === 'link') return logos.link;
  if (s === 'uni') return logos.uni;
  if (s === 'aave') return logos.aave;
  if (s === 'reth') return logos.reth;
  if (s === 'cbeth') return logos.cbeth;
  if (s === 'wsteth') return logos.wsteth;
  if (s === 'frax') return logos.frax;
  return `<svg viewBox="0 0 48 48" width="48" height="48"><circle cx="24" cy="24" r="24" fill="#FFD9C0"/><text x="24" y="32" text-anchor="middle" fill="#2D2A32" font-size="16" font-weight="800" font-family="Arial">${(sym || '?').slice(0, 1).toUpperCase()}</text></svg>`;
}

function showReceiveModal(address, symbol) {
  openModal(`
    <button class="modal-close" onclick="document.getElementById('modalOverlay').classList.remove('open')">✕</button>
    <h2>Receive ${escapeHtml(symbol)}</h2>
    <div class="text-center mb-16">
      <div class="mono" style="font-size:0.85rem;word-break:break-all;padding:12px;background:var(--cream);border-radius:10px;border:2px solid var(--ink)">${escapeHtml(address || get('address'))}</div>
    </div>
    <button class="copy-btn btn btn-primary btn-block" data-copy="${escapeHtml(address || get('address'))}">Copy Address</button>
  `);
}

// Real 24h price history (CoinGecko keyless, 5-min cache).
// The previous version generated a fresh random walk on every open, so the
// chart was different each time and never matched the displayed price.
async function drawMiniChart({ symbol, address }) {
  const canvas = document.getElementById('tokenPriceChart');
  if (!canvas) return;
  const w = canvas.width;
  const h = canvas.height;
  const paintBase = () => {
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#FFF8F0';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#E8E0D8';
    ctx.lineWidth = 0.5;
    for (let i = 0; i < 4; i++) {
      const y = (h / 4) * i + 10;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
  };
  const paintMessage = (msg) => {
    const ctx = canvas.getContext('2d');
    paintBase();
    ctx.fillStyle = '#8A8178';
    ctx.font = '12px Arial';
    ctx.textAlign = 'center';
    ctx.fillText(msg, w / 2, h / 2);
  };

  paintMessage('Loading 24h chart…');

  let data = [];
  try {
    const chainId = getNetworkById(get('networkId'))?.chainId;
    data = await fetchPriceHistory({ address, chainId });
  } catch { data = []; }

  // modal may have been closed/reopened while we awaited
  if (!canvas.isConnected || document.getElementById('tokenPriceChart') !== canvas) return;

  if (!Array.isArray(data) || data.length < 2) {
    paintMessage('No 24h chart data');
    return;
  }

  const points = data.length;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const step = w / (points - 1);
  const ctx = canvas.getContext('2d');

  paintBase();

  // Line
  const gradient = ctx.createLinearGradient(0, 0, 0, h);
  gradient.addColorStop(0, '#FF6B35');
  gradient.addColorStop(1, '#FF8A3D');

  ctx.beginPath();
  ctx.strokeStyle = gradient;
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  data.forEach((val, i) => {
    const x = i * step;
    const y = h - ((val - min) / range) * (h - 20) - 10;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Fill under line
  const lastX = (points - 1) * step;
  const lastY = h - ((data[data.length - 1] - min) / range) * (h - 20) - 10;
  ctx.lineTo(lastX, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  const fillGrad = ctx.createLinearGradient(0, 0, 0, h);
  fillGrad.addColorStop(0, 'rgba(255,107,53,0.3)');
  fillGrad.addColorStop(1, 'rgba(255,107,53,0.02)');
  ctx.fillStyle = fillGrad;
  ctx.fill();

  // Current price dot
  ctx.beginPath();
  ctx.arc(lastX, lastY, 4, 0, Math.PI * 2);
  ctx.fillStyle = '#FF6B35';
  ctx.fill();
  ctx.strokeStyle = '#FFF8F0';
  ctx.lineWidth = 2;
  ctx.stroke();
}

// ── view wiring ──
function bindViews() {
  bindSendEvents();
  bindSwapEvents();
  bindBridgeEvents();
  bindEip7702Events();
  bindEip7702ToolsEvents();
  bindDeployEvents();

  $('#approvalMode').addEventListener('change', () => {
    $('#approvalCustomWrap').classList.toggle('hidden', $('#approvalMode').value !== 'custom');
  });
  $('#btnApprovalScan').addEventListener('click', scanApprovals);

  $('#btnSaveSettings').addEventListener('click', saveSettingsHandler);
  $('#btnClearData').addEventListener('click', clearAllData);
}

// ── approval manager ──
async function scanApprovals() {
  if (!get('unlocked')) { showUnlockModal(); return; }
  const mode = $('#approvalMode')?.value;
  const net = getNetworkById(get('networkId'));
  const list = $('#approvalList');
  if (!list) return;
  list.innerHTML = spinner(64, 'Scanning approvals...');
  try {
    const provider = get('provider');
    const tokens = mode === 'popular'
      ? (POPULAR_TOKENS[net.chainId] || [])
      : [{ address: $('#approvalCustom').value.trim(), symbol: 'CUSTOM', decimals: 18 }];
    if (!tokens.length) {
      list.innerHTML = '<p class="small text-center">No popular tokens on this network. Use custom mode.</p>';
      return;
    }
    const approvals = [];
    let scannedFrom = null;
    for (const t of tokens) {
      if (!wallet.isValidAddress(t.address)) continue;
      try {
        const c = new ethers.Contract(t.address, ERC20_ABI, provider);
        const block = await provider.getBlockNumber();
        // Wide window (~2 weeks on mainnet). If the provider rejects the
        // range, fall back to a smaller window so the scan still works.
        // The actual window is reported in the UI — "Clean! 🐻" must never
        // hide the fact that old approvals are out of scope.
        let fromBlock = Math.max(0, block - 100000);
        let events;
        try {
          events = await c.queryFilter(c.filters.Approval(get('address')), fromBlock, block);
        } catch {
          fromBlock = Math.max(0, block - 2000);
          events = await c.queryFilter(c.filters.Approval(get('address')), fromBlock, block);
        }
        scannedFrom = scannedFrom === null ? fromBlock : Math.min(scannedFrom, fromBlock);
        // Dedupe by spender across ALL events (no arbitrary 10-event cap)
        const seen = new Set();
        for (const ev of events) {
          const spender = ev.args[1];
          if (spender) seen.add(spender);
        }
        // Check the CURRENT allowance for each unique spender; skip
        // spenders whose approval was already revoked (allowance = 0).
        for (const spender of seen) {
          const allowance = await c.allowance(get('address'), spender);
          if (allowance <= 0n) continue;
          approvals.push({
            token: t, spender,
            allowance: allowance.toString(),
            unlimited: allowance >= (1n << 255n)
          });
        }
      } catch {}
    }
    set('approvals', approvals);
    renderApprovals(approvals, scannedFrom);
  } catch (e) {
    list.innerHTML = `<p class="small text-center">Error: ${escapeHtml(e.message)}</p>`;
  }
}

function renderApprovals(approvals, scannedFrom = null) {
  const list = $('#approvalList');
  if (!list) return;
  if (!approvals.length) {
    const note = scannedFrom !== null
      ? `<p class="small text-center">No active approvals found in the scan window (from block ${scannedFrom.toLocaleString()}). Older approvals are not shown — use a block explorer to verify.</p>`
      : '';
    list.innerHTML = note + '<p class="small text-center">No active approvals found. Clean! 🐻</p>';
    return;
  }
  const windowNote = scannedFrom !== null
    ? `<p class="small text-center">Scan window: from block ${scannedFrom.toLocaleString()} — approvals older than this are not shown.</p>`
    : '';
  list.innerHTML = windowNote + approvals.map((a, i) => `
    <div class="asset-row">
      <div class="asset-icon">🔐</div>
      <div class="asset-info">
        <div class="asset-name">${escapeHtml(a.token.symbol)} ${a.unlimited ? '<span class="badge badge-warn">UNLIMITED</span>' : ''}</div>
        <div class="mono">Spender: ${escapeHtml(a.spender)}</div>
        <div class="asset-symbol">Allowance: ${escapeHtml(fmtAmount(a.allowance, a.token.decimals))}</div>
      </div>
      <button class="btn btn-danger" data-revoke="${i}">Revoke</button>
    </div>`).join('');
  $all('[data-revoke]').forEach(el => el.addEventListener('click', async () => {
    const a = approvals[Number(el.dataset.revoke)];
    const ok = await confirmTx({
      title: 'Revoke approval?',
      rows: [{ k: 'Token', v: a.token.symbol }, { k: 'Spender', v: wallet.shortAddress(a.spender) }],
      confirmText: 'Revoke', danger: true
    });
    if (!ok) return;
    try {
      const signer = get('signer').connect(get('provider'));
      const c = new ethers.Contract(a.token.address, ERC20_ABI, signer);
      const tx = await c.approve(a.spender, 0);
      toast('Revoke tx sent!', 'info');
      const { timedOut } = await waitForReceipt(tx);
      if (timedOut) {
        toast(`Tx ${String(tx.hash).slice(0, 10)}… sent but still unconfirmed. Track it on the explorer.`, 'info');
        return;
      }
      toast('Approval revoked! 🎉', 'success');
      scanApprovals();
    } catch (e) { toast('Revoke failed: ' + e.message, 'error'); }
  }));
}

// ── activity ──
function renderActivity() {
  loadActivity();
  const list = $('#activityList');
  if (!list) return;
  if (!get('activity').length) {
    list.innerHTML = `<div class="empty-state">
      <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
      <p>No transactions yet</p>
      <p class="sub">Send, swap, bridge or deploy to see activity here</p>
    </div>`;
    return;
  }
  const net = getNetworkById(get('networkId'));
  // Activity icon mapping
  const actIcon = (type) => {
    const t = (type || '').toLowerCase();
    if (t.includes('send')) return 'send';
    if (t.includes('receive')) return 'receive';
    if (t.includes('swap')) return 'swap';
    if (t.includes('bridge')) return 'bridge';
    if (t.includes('approve')) return 'approve';
    return 'send';
  };
  const actSvg = (type) => {
    const cls = actIcon(type);
    const svgs = {
      send: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>',
      receive: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>',
      swap: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
      bridge: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 17h20"/><path d="M4 12V7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v5"/><circle cx="12" cy="17" r="3"/></svg>',
      approve: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>'
    };
    return `<div class="activity-icon ${cls}">${svgs[cls] || svgs.send}</div>`;
  };
  list.innerHTML = get('activity').map(a => `
    <div class="activity-item">
      ${actSvg(a.type)}
      <div class="activity-details">
        <div class="activity-action">${escapeHtml(a.type)} — ${escapeHtml(a.status)}</div>
        <div class="activity-meta">${escapeHtml(a.detail)} · ${escapeHtml(fmtTime(a.ts))}</div>
      </div>
      ${a.hash && a.hash.startsWith('0x') ? `<a class="btn btn-ghost btn-sm" href="${escapeHtml(net.explorer)}/tx/${escapeHtml(a.hash)}" target="_blank" rel="noopener">View</a>` : ''}
    </div>`).join('');
}

// ── settings ──
function saveSettingsHandler() {
  const settings = get('settings');
  settings.currency = $('#setCurrency').value;
  settings.lang = $('#setLang').value;
  settings.autoLock = Number($('#setAutoLock').value) || 5;
  const rpc = $('#setRpc').value.trim();
  if (rpc) {
    if (!/^https:\/\//.test(rpc)) return toast('Custom RPC must be an https:// URL', 'error');
    const net = getNetworkById(get('networkId'));
    if (net) {
      net.rpc.unshift(rpc);
      toast('Custom RPC added for ' + net.name, 'success');
    }
  }
  set('settings', { ...settings });
  saveSettings();
  setLang(settings.lang);
  toast('Settings saved! 🐻', 'success');
  startAutoLock();
}

function clearAllData() {
  openModal(`
    <button class="modal-close" onclick="document.getElementById('modalOverlay').classList.remove('open')">✕</button>
    <h2>🗑️ Delete Wallet?</h2>
    <div class="danger-box">This deletes ALL wallets, settings, and activity from this browser. Irreversible!</div>
    <div class="flex gap-8" style="justify-content:center">
      <button class="btn btn-danger btn-lg" id="clearBtn">Delete Wallet</button>
      <button class="btn btn-ghost btn-lg" onclick="document.getElementById('modalOverlay').classList.remove('open')">No</button>
    </div>
  `);
  $('#clearBtn').onclick = () => {
    wallet.clearKeystore();
    localStorage.removeItem('bear.settings');
    localStorage.removeItem('bear.activity');
    localStorage.removeItem('bear.customNetworks');
    localStorage.removeItem('bear.lang');
    localStorage.removeItem('bear.priceCache');
    set('unlocked', false); set('signer', null); set('address', null);
    closeModal();
    toast('All data cleared.', 'info');
    showWelcomeModal();
  };
}

// ── address book ──
function loadAddressBook() {
  try {
    return JSON.parse(localStorage.getItem('bear.addressBook') || '[]');
  } catch { return []; }
}
function saveAddressBook(list) {
  localStorage.setItem('bear.addressBook', JSON.stringify(list));
}
function renderAddressBook() {
  const list = loadAddressBook();
  const el = $('#addressBookList');
  if (!el) return;
  if (!list.length) {
    el.innerHTML = '<p class="small text-center">No saved addresses yet.</p>';
    return;
  }
  el.innerHTML = list.map((item, i) => `
    <div class="ab-item">
      <div class="token-icon default">${(item.label || '?').slice(0, 2).toUpperCase()}</div>
      <div class="ab-item-info">
        <div class="ab-item-label">${escapeHtml(item.label)}</div>
        <div class="ab-item-address">${escapeHtml(wallet.shortAddress(item.address))}</div>
      </div>
      <div class="ab-item-actions">
        <button class="copy-btn" data-copy="${escapeHtml(item.address)}" title="Copy"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
        <button class="copy-btn ab-delete" data-idx="${i}" title="Delete"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
    </div>`).join('');
  // Delete handlers
  el.querySelectorAll('.ab-delete').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx);
      const ab = loadAddressBook();
      ab.splice(idx, 1);
      saveAddressBook(ab);
      renderAddressBook();
      toast('Address removed', 'info');
    });
  });
}
function initAddressBook() {
  renderAddressBook();
  $('#btnAddAddress')?.addEventListener('click', () => {
    const label = $('#abLabel').value.trim();
    const address = $('#abAddress').value.trim();
    if (!label || !address) return toast('Label and address required', 'error');
    if (!wallet.isValidAddress(address)) return toast('Invalid address', 'error');
    const ab = loadAddressBook();
    ab.push({ label, address });
    saveAddressBook(ab);
    $('#abLabel').value = '';
    $('#abAddress').value = '';
    renderAddressBook();
    toast('Address saved', 'success');
  });
}

// init activity
loadActivity();
initAddressBook();