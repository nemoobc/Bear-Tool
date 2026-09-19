// ═══════════════════════════════════════════════════════════════
// Bear Tool — app.js (entry point, slim orchestrator)
// Boot, router, topbar, wallet lifecycle modals, dashboard,
// approvals, activity, settings. Feature logic lives in modules:
// send.js / swap.js / bridge.js / eip7702.js / deploy.js / nft.js.
// ═══════════════════════════════════════════════════════════════

import { POPULAR_TOKENS, ERC20_ABI,
         NETWORKS, getAllNetworks, getNetworkById, getProvider,
         addCustomNetwork, getCustomNetworks } from './network.js';
import * as wallet from './wallet.js';
import { $, $all, toast, openModal, closeModal, spinner, confirmTx, promptPassword,
         fmtAmount, fmtUsd, fmtTime, escapeHtml, animateValue } from './ui.js';
import { runIntro, initTheme } from './theme.js';
import { get, set, on, setUnlockHandler, addActivity, loadActivity } from './state.js';
import { fetchAllPrices, fetchPriceHistory, fetchOHLC } from './price.js';
import { waitForReceipt } from './safetx.js';
import { bindSendEvents, loadSendTokens } from './send.js';
import { bindSwapEvents, loadSwapTokens } from './swap.js';
import { bindBridgeEvents, loadBridgeChains } from './bridge.js';
import { bindEip7702Events, loadEip7702 } from './eip7702.js';
import { bindEip7702ToolsEvents } from './eip7702-tools.js';
import { bindDeployEvents } from './deploy.js';
import { loadNfts } from './nft.js';
import { cancelOrder, fulfillBasicOrder, getOrderStatusOnChain } from './opensea.js';
import { t, setLang, applyTranslations } from './i18n.js';
import { renderDapps, POPULAR_DAPPS } from './dapps.js';
import { checkWL, getMintEstimate, getHighestOffer, getListings, getOffers, cancelListing, listNft } from './opensea-api.js';

const { ethers } = globalThis;

// ── boot ──
window.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  setUnlockHandler(showUnlockModal);
  on('refresh', () => {
    if (!get('address')) return;
    loadDashboard();
    if ($('#view-activity').classList.contains('active')) renderActivity();
  });
  bindNav();
  bindTopbar();
  bindViews();
  initTheme();

  // A refresh must not dump the user back into the password box. The address
  // is not a secret (it is already public on-chain), so restore it and render
  // the app read-only. The password is only needed to SIGN — every signing
  // path already calls requireUnlock(). The decrypted key is never persisted.
  const restored = restoreReadOnlyAccount();
  const boot = () => {
    // Session secret survives a refresh (sessionStorage) and a tab reopen
    // (localStorage fallback, within the auto-lock window): restore the signer
    // and stay unlocked. Lock / auto-lock clears both copies.
    const sessionSecret = wallet.getSession();
    if (sessionSecret) {
      try {
        // A true refresh keeps the sessionStorage copy (always fresh). A
        // tab-reopen restore comes from localStorage — only trust it within
        // the auto-lock window, so closing the tab can't leave the wallet
        // unlocked forever. "Never" (0) falls back to a 24h cap.
        if (!wallet.hasSessionStorage()) {
          const ts = wallet.getSessionTs();
          const minutes = get('settings').autoLock;
          const maxAge = (minutes > 0 ? minutes : 24 * 60) * 60 * 1000;
          if (ts && Date.now() - ts > maxAge) {
            wallet.clearSession();
            throw new Error('Session expired');
          }
        }
        const signer = wallet.signerFromSecret(sessionSecret);
        set('signer', signer);
        set('address', signer.address);
        set('unlocked', true);
        updateTopbar();
        loadDashboard();
        startAutoLock();
        return;
      } catch { wallet.clearSession(); }
    }
    if (restored) { updateTopbar(); loadDashboard(); }
    else if (wallet.getKeystore()) showUnlockModal();
    else showWelcomeModal();
  };
  // The 5s logo intro is a first-impression flourish, not a refresh tax.
  let seen = false;
  try { seen = sessionStorage.getItem('bear.introSeen') === '1'; } catch { /* private mode */ }
  if (seen) {
    const intro = document.getElementById('intro');
    intro?.remove();
    boot();
  } else {
    try { sessionStorage.setItem('bear.introSeen', '1'); } catch { /* ignore */ }
    runIntro(boot);
  }
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

  // ── custom token add ──
  document.getElementById('btnAddCustomToken')?.addEventListener('click', () => {
    openModal(`
      <button class="modal-close" onclick="document.getElementById('modalOverlay').classList.remove('open')">✕</button>
      <h2>Add Custom Token</h2>
      <div class="field"><label for="customTokenAddr">Contract Address</label><input class="input" id="customTokenAddr" placeholder="0x..."></div>
      <div class="field"><label for="customTokenChain">Chain ID</label><input class="input" id="customTokenChain" type="number" value="${get('networkId') ? (getNetworkById(get('networkId'))?.chainId || 1) : 1}"></div>
      <button class="btn btn-primary btn-block" id="btnConfirmAddToken">Add Token</button>
    `);
    document.getElementById('btnConfirmAddToken')?.addEventListener('click', async () => {
      const addr = document.getElementById('customTokenAddr')?.value?.trim();
      const chainId = parseInt(document.getElementById('customTokenChain')?.value) || 1;
      if (!addr || !addr.startsWith('0x') || addr.length !== 42) return toast('Invalid contract address', 'error');
      const provider = get('provider');
      if (!provider) return toast('Wallet not ready', 'error');
      try {
        const ERC20 = ['function symbol() view returns (string)', 'function decimals() view returns (uint8)', 'function balanceOf(address) view returns (uint256)'];
        const contract = new ethers.Contract(addr, ERC20, provider);
        const [sym, dec, bal] = await Promise.all([contract.symbol(), contract.decimals(), contract.balanceOf(get('address') || ethers.ZeroAddress)]);
        const tokens = get('tokens') || [];
        if (tokens.some(t => t.address?.toLowerCase() === addr.toLowerCase())) return toast('Token already added', 'info');
        tokens.push({ address: addr, symbol: sym, decimals: Number(dec), balance: bal.toString(), chainId, usd: null });
        set('tokens', tokens);
        closeModal();
        toast(`✅ ${sym} added!`, 'success');
        if (window._assetTokens) renderAssets(tokens);
      } catch (e) { toast('Failed to fetch token: ' + (e?.message || 'unknown'), 'error'); }
    });
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
    if (e.target.closest('[data-opensea]')) {
      const btn = e.target.closest('[data-opensea]');
      const { contractAddress, tokenId, chainId } = btn.dataset;
      const selNet = get('networkId') || chainId || 1;
      try {
        if (btn.dataset.opensea === 'cancel') cancelOrder(btn, [window.__openSeaOrderHash || '0x' + '00'.repeat(32)], selNet);
        else if (btn.dataset.opensea === 'fulfill') fulfillBasicOrder(btn, window.__openSeaTestOrder, selNet);
        else toast('OpenSea ' + btn.dataset.opensea + ': butuh order hash (List via OpenSea API dulu)', 'info');
      } catch (err) { toast('OpenSea: ' + (err?.message || err), 'error'); }
      return;
    }

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
  // .nav-item is a <div role="button" tabindex="0"> — it must also respond
  // to Enter/Space, not just click (WCAG 2.1.1 keyboard).
  const activateNav = (item) => {
    const view = item.dataset.view;
    // Swap and Bridge share one nav button: first click opens Swap,
    // clicking the button again while already on Swap offers the choice.
    if (view === 'swap' && $('#view-swap')?.classList.contains('active')) {
      showSwapBridgeChooser();
      return;
    }
    switchView(view);
  };
  // sidebar nav
  $all('.nav-item').forEach(item => {
    item.addEventListener('click', () => activateNav(item));
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        activateNav(item);
      }
    });
  });
  // mobile bottom nav (native <button> — click only is fine)
  $all('.mobile-nav-item').forEach(item => {
    item.addEventListener('click', () => activateNav(item));
  });
  // dashboard quick actions
  $all('.quick-action-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.view) switchView(btn.dataset.view);
    });
  });
  // Receive replaced the Swap shortcut on home — the address + copy live here.
  $('#quickReceive')?.addEventListener('click', () => {
    const net = getNetworkById(get('networkId'));
    showReceiveModal(get('address'), net?.symbol || '');
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
  if (!get('address')) return;
  if (view === 'dashboard') loadDashboard();
  if (view === 'send') loadSendTokens();
  if (view === 'swap') loadSwapTokens();
  if (view === 'bridge') loadBridgeChains();
  if (view === 'eip7702') loadEip7702();
  if (view === 'activity') renderActivity();
  if (view === 'dapps') renderDapps($('#dappsContainer'));
  if (view === 'deploy') { bindOpenSeaPanel(); }
}

// ── OpenSea panel (WL check + Accept Top Offer + Coin Price) ──
function bindOpenSeaPanel() {
  if (window._osPanelBound) return;
  window._osPanelBound = true;
  const status = () => $('#openSeaStatus');
  // Check WL
  $('#btnCheckWL')?.addEventListener('click', async () => {
    const addr = get('address');
    if (!addr || !status()) return;
    status().textContent = 'Checking WL...';
    try {
      const result = await checkWL({ collection: 'boredapeyachtclub', address: addr });
      status().textContent = result.eligible ? '✅ Whitelisted! Mint available.' : '❌ Not whitelisted.';
    } catch { status().textContent = '⚠️ WL check failed.'; }
  });
  // List NFT
  $('#btnOpenSeaList')?.addEventListener('click', async () => {
    const s = status(); if (!s) return;
    const contract = $('#openSeaContract')?.value?.trim();
    const tokenId = $('#openSeaTokenId')?.value?.trim();
    const price = $('#openSeaPrice')?.value?.trim();
    if (!contract || !tokenId || !price) return s.textContent = 'Fill contract, token ID, and price.';
    s.textContent = 'Listing...';
    try {
      const net = getNetworkById(get('networkId'));
      await listNft({ contractAddress: contract, tokenId, price, chainId: net?.chainId || 1 });
      s.textContent = '✅ Listing submitted!';
    } catch (e) { s.textContent = '⚠️ ' + (e?.message || 'List failed'); }
  });
  // Cancel listing
  $('#btnOpenSeaCancel')?.addEventListener('click', async () => {
    const s = status(); if (!s) return;
    const contract = $('#openSeaContract')?.value?.trim();
    const tokenId = $('#openSeaTokenId')?.value?.trim();
    if (!contract || !tokenId) return s.textContent = 'Fill contract and token ID to cancel.';
    s.textContent = 'Cancelling...';
    try {
      const net = getNetworkById(get('networkId'));
      await cancelListing({ contractAddress: contract, tokenId, chainId: net?.chainId || 1 });
      s.textContent = '✅ Listing cancelled!';
    } catch (e) { s.textContent = '⚠️ ' + (e?.message || 'Cancel failed'); }
  });
  // Accept top offer
  $('#btnAcceptTopOffer')?.addEventListener('click', async () => {
    const s = status(); if (!s) return;
    s.textContent = 'Finding top offer...';
    try {
      const result = await getHighestOffer({ collection: 'boredapeyachtclub' });
      s.textContent = result?.price ? `Top offer: $${result.price} — ready to accept.` : 'No active offers found.';
    } catch { s.textContent = '⚠️ Could not fetch offers.'; }
  });
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
  // Prefer the wallet name the user set at create/import time; fall back to the
  // short address for legacy accounts saved before names existed.
  const addr = get('address');
  let label = '';
  if (addr) {
    let name = '';
    try {
      const accounts = wallet.getAccounts() || [];
      name = accounts[wallet.getActiveAccountIndex()]?.name || '';
    } catch { /* storage unavailable */ }
    label = name || wallet.shortAddress(addr);
    if (!get('unlocked')) label = '🔒 ' + label;
  }
  $('#accountShort').textContent = label || 'Not connected';
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
  `, { wide: true });
  const pw = $('#unlockPw');
  pw.focus();
  const doUnlock = async () => {
    try {
      const { signer, secret } = await wallet.unlockSession(pw.value);
      set('signer', signer);
      set('address', signer.address);
      set('unlocked', true);
      wallet.saveSession(secret);
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
    <h2>🐻 Create Wallet</h2>
    <div class="field">
      <label for="createName">Wallet name (optional)</label>
      <input class="input" id="createName" type="text" placeholder="Wallet" maxlength="40">
    </div>
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
  `, { wide: true });
  $('#createBtn').onclick = async () => {
    const p1 = $('#createPw').value, p2 = $('#createPw2').value;
    if (p1.length < 8) return toast('Password too short (min 8)', 'error');
    if (p1 !== p2) return toast('Passwords do not match', 'error');
    try {
      const res = await wallet.createWallet(p1, $('#createName').value);
      $('#createPw').value = ''; $('#createPw2').value = '';
      showSeedPhrase(res.mnemonic, res.address);
    } catch (e) { toast('Error: ' + e.message, 'error'); }
  };
}

function showSeedPhrase(mnemonic, address) {
  const words = mnemonic.split(' ');
  // Pick 3 random word indices for verification
  const indices = [];
  while (indices.length < 3) {
    const r = Math.floor(Math.random() * words.length);
    if (!indices.includes(r)) indices.push(r);
  }
  // One of the 3 is the "question" — user must pick the correct word
  const qIdx = indices[Math.floor(Math.random() * 3)];
  const correctWord = words[qIdx];
  const distractors = [];
  while (distractors.length < 2) {
    const w = words[Math.floor(Math.random() * words.length)];
    if (w !== correctWord && !distractors.includes(w)) distractors.push(w);
  }
  const choices = [...distractors];
  choices.splice(Math.floor(Math.random() * 3), 0, correctWord);

  openModal(`
    <button class="modal-close" onclick="document.getElementById('modalOverlay').classList.remove('open')">✕</button>
    <h2>🔑 Your Seed Phrase</h2>
    <div class="danger-box">Write these 12 words DOWN. Never share them. Never type them into any website.</div>
    <div class="card" style="box-shadow:none;background:var(--cream)">
      <div class="mono" style="font-size:1.1rem;line-height:2">${words.map((w, i) => `<b>${i + 1}.</b> ${escapeHtml(w)}`).join(' ')}</div>
    </div>
    <button class="copy-btn btn btn-ghost btn-block mt-8" data-copy="${escapeHtml(mnemonic)}">📋 Copy seed phrase</button>
    <div class="field">
      <label>Select word #${qIdx + 1} to confirm</label>
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
    wallet.saveSession(mnemonic);
    closeModal();
    toast('Wallet created! 🐻', 'success');
    updateTopbar();
    loadDashboard();
    startAutoLock();
  };
}

function showImportModal() {
  openModal(`
    <h2>📥 Import Wallet</h2>
    <div class="field">
      <label for="importName">Wallet name (optional)</label>
      <input class="input" id="importName" type="text" placeholder="Wallet" maxlength="40">
    </div>
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
  `, { wide: true });
  $('#importBtn').onclick = async () => {
    const secret = $('#importSecret').value.trim();
    const pw = $('#importPw').value;
    if (!secret) return toast('Enter seed phrase or private key', 'error');
    if (pw.length < 8) return toast('Password too short (min 8)', 'error');
    try {
      const res = await wallet.importWallet(secret, pw, $('#importName').value);
      set('signer', new ethers.Wallet(secret.startsWith('0x') ? secret : ethers.Wallet.fromPhrase(secret).privateKey));
      set('address', res.address);
      set('unlocked', true);
      wallet.saveSession(secret);
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
  const minutes = get('settings').autoLock;
  if (!(minutes > 0)) return; // 0 = Never auto-lock
  lockTimer = setTimeout(() => {
    set('unlocked', false);
    set('signer', null);
    wallet.clearSession();
    toast('Auto-locked 🔒', 'info');
    showUnlockModal();
  }, minutes * 60 * 1000);
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
    if (get('address')) loadDashboard();
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
          <div class="asset-name">${escapeHtml(a.name || `Account ${i + 1}`)} ${i === idx ? '(active)' : ''}</div>
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
        <button class="copy-btn btn btn-ghost btn-block mt-8" data-copy="${escapeHtml(secret)}">📋 Copy</button>
        <button class="btn btn-primary btn-block" onclick="document.getElementById('modalOverlay').classList.remove('open')">Close</button>
      `);
    } catch { toast('Wrong password', 'error'); }
  };
  $('#lockBtn').onclick = () => {
    set('unlocked', false); set('signer', null);
    wallet.clearSession();
    closeModal();
    toast('Locked 🔒', 'info');
    showUnlockModal();
  };
}

// ── dashboard ──
// Restore the active account address (public, non-secret) from the saved
// account list so a refresh lands on a usable read-only app instead of the
// password prompt. Returns null when there is nothing to restore.
function restoreReadOnlyAccount() {
  try {
    if (!wallet.getKeystore()) return null;
    const accounts = wallet.getAccounts();
    if (!Array.isArray(accounts) || !accounts.length) return null;
    const idx = wallet.getActiveAccountIndex();
    const addr = accounts[idx]?.address || accounts[0]?.address;
    if (!addr || !wallet.isValidAddress(addr)) return null;
    set('address', addr);
    return addr;
  } catch { return null; }
}

async function loadDashboard() {
  if (!get('address')) return;
  const net = getNetworkById(get('networkId'));
  // Network name only. The wallet address lives in the Receive modal — it is
  // not shown (or copyable) from the home screen any more.
  $('#balanceSub').textContent = net.name;

  // Wallet name above the balance hero — the home screen's "whose box is
  // this?" label. Reads the account list (non-secret) — no address shown.
  try {
    const accounts = wallet.getAccounts() || [];
    const idx = wallet.getActiveAccountIndex();
    const acct = accounts[idx] || {};
    $('#homeWalletName').textContent = (acct.name || 'Account').trim();
  } catch { /* name is cosmetic — skip */ }

  const assetList = $('#assetList');
  if (!assetList) return;
  assetList.innerHTML = spinner(64, 'Loading assets...');
  // 24h price sparkline for the native asset — CoinGecko auto-pair
  // (native → auto chain id), cached by fetchPriceHistory. Cosmetic only.
  renderHeroSpark(net).catch(() => { /* cosmetic — never blocks */ });
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
    // Auto-detect logos from CoinGecko for tokens outside the manual map,
    // then re-render once — but only if this is still the active token list
    // (a network switch may have replaced it while the fetch was in flight).
    ensureTokenLogos(tokens).then(() => {
      if (window._assetTokens === tokens) renderAssets(tokens);
    });
    // not awaited on purpose (NFT scan is slow) — but its rejection must be
    // handled here, or a null element becomes a global "Unexpected error" toast
    loadNfts().catch((e) => console.warn('[BearTool] NFT scan failed:', e?.message || e));
    // M5-HERO: coin price panel removed per user request
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

// ── CoinGecko token logos (auto-detect, cached 24h) ──
// The manual SVG map covers the popular tokens; anything else asks CoinGecko
// search once per symbol and caches the result so the list stays fast.
const LOGO_CACHE_KEY = 'bear.logoCache';
const LOGO_TTL = 24 * 60 * 60 * 1000;
const MANUAL_LOGO_SYMS = new Set(['eth', 'ether', 'usdc', 'usdt', 'dai', 'wbtc', 'link', 'uni', 'aave', 'reth', 'cbeth', 'wsteth', 'frax']);

function loadLogoCache() {
  try { return JSON.parse(localStorage.getItem(LOGO_CACHE_KEY) || '{}'); }
  catch { return {}; }
}
function saveLogoCache(cache) {
  try { localStorage.setItem(LOGO_CACHE_KEY, JSON.stringify(cache)); } catch {}
}
function getCachedLogo(sym) {
  const e = loadLogoCache()[(sym || '').toLowerCase()];
  return e && Date.now() - e.ts < LOGO_TTL ? e.url : null;
}
function cacheLogo(sym, url) {
  const c = loadLogoCache();
  c[(sym || '').toLowerCase()] = { url, ts: Date.now() };
  saveLogoCache(c);
}
async function fetchCoinGeckoLogo(sym) {
  const url = `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(sym)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const data = await res.json();
    const coins = Array.isArray(data?.coins) ? data.coins : [];
    const hit = coins.find(c => (c.symbol || '').toLowerCase() === String(sym).toLowerCase() && c.large);
    return hit?.large || null;
  } catch { return null; }
  finally { clearTimeout(timer); }
}
// Fetch + cache logos for tokens not covered by the manual SVG map.
// Never throws — logo failures just leave the default SVG in place.
async function ensureTokenLogos(tokens) {
  const missing = (tokens || []).filter(t =>
    t.symbol && !MANUAL_LOGO_SYMS.has(t.symbol.toLowerCase()) && !getCachedLogo(t.symbol)
  );
  await Promise.allSettled(missing.map(async (t) => {
    const url = await fetchCoinGeckoLogo(t.symbol);
    if (url) cacheLogo(t.symbol, url);
  }));
}

function renderAssets(tokens) {
  // M5-B: prefetch sparkline data CoinGecko 24h per kartu (non-blocking, HUKUM 12)
  const _sparkPromises = tokens.map(t => fetchPriceHistory({ address: t.address, chainId: getNetworkById(get('networkId'))?.chainId }).catch(() => []));
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
    const cached = getCachedLogo(sym);
    if (cached) return `<img class="token-logo-img" data-idx="${i}" src="${escapeHtml(cached)}" alt="" loading="lazy">`;
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
      <div class="asset-spark" id="assetSpark${i}" title="24h trend (CoinGecko)"></div>
      <div class="asset-arrow"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg></div>
    </div>`).join('');
  if (filtered.length === 0) {
    assetList.innerHTML = '<p class="small text-center">No tokens match your search.</p>';
  }
  // M5-B: sparkline CoinGecko 24h per kartu aset (non-blocking, HUKUM 12 aman)
  Promise.all((filtered.length ? filtered : tokens).map(async (t, i) => {
    const el = document.getElementById('assetSpark' + i);
    if (!el) return;
    try {
      const chainId = getNetworkById(get('networkId'))?.chainId;
      const data = await fetchPriceHistory({ address: t.address, chainId });
      if (!Array.isArray(data) || data.length < 4) { el.textContent = ''; return; }
      const min = Math.min(...data), max = Math.max(...data), r = max - min || 1;
      const w = 48, h = 16, pts = data.length;
      const poly = data.map((v, k) => `${((k / (pts - 1)) * w).toFixed(1)},${(h - ((v - min) / r) * (h - 4) - 2).toFixed(1)}`).join(' ');
      el.innerHTML = `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" style="vertical-align:middle"><polyline points="${poly}|| '${poly}'" fill="none" stroke="#10B981" stroke-width="1.5"/></svg>`;
    } catch { el.textContent = ''; }
  }));
  // CoinGecko images can 404/expire — fall back to the default SVG quietly.
  $all('.token-logo-img').forEach(img => {
    img.addEventListener('error', () => {
      const i = Number(img.dataset.idx || 0);
      img.outerHTML = tokenLogos.default(i);
    });
  });
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
      <div class="chart-timeframes" id="chartTimeframes">
        <button class="chart-tf-btn active" data-tf="5m">5m</button>
        <button class="chart-tf-btn" data-tf="1h">1h</button>
        <button class="chart-tf-btn" data-tf="24h">24h</button>
        <button class="chart-tf-btn" data-tf="7d">7d</button>
      </div>
      <canvas id="tokenPriceChart" width="340" height="160"></canvas>
      <div class="chart-price-label" id="chartPriceLabel"></div>
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
  drawMiniChart({ symbol, address, timeframe: '24h' });

  // Timeframe buttons
  document.querySelectorAll('.chart-tf-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.chart-tf-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      drawMiniChart({ symbol, address, timeframe: btn.dataset.tf });
    });
  });

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
  const addr = address || get('address');
  let qrSvg = '';
  try {
    if (typeof qrcode === 'function') {
      const qr = qrcode(0, 'M');
      qr.addData(addr);
      qr.make();
      qrSvg = qr.createSvgTag(4, 8);
    }
  } catch { /* QR unavailable — address is still shown below */ }
  openModal(`
    <button class="modal-close" onclick="document.getElementById('modalOverlay').classList.remove('open')">✕</button>
    <h2>Receive ${escapeHtml(symbol)}</h2>
    ${qrSvg ? `<div class="receive-qr text-center mb-16" role="img" aria-label="QR code for ${escapeHtml(symbol)}">${qrSvg}</div>` : ''}
    <div class="text-center mb-16">
      <div class="mono" style="font-size:0.85rem;word-break:break-all;padding:12px;background:var(--cream);border-radius:10px;border:2px solid var(--ink)">${escapeHtml(addr)}</div>
    </div>
    <button class="copy-btn btn btn-primary btn-block" data-copy="${escapeHtml(addr)}">Copy Address</button>
  `);
}

// ── Candlestick chart with timeframe support ────────────────
// Draws OHLC candles (5m, 1h, 24h, 7d) on canvas.
// Uses CoinGecko OHLC endpoint, falls back to pseudo-candles from price history.
const CHART_TF_DAYS = { '5m': 1, '1h': 1, '24h': 1, '7d': 7 };

async function drawMiniChart({ symbol, address, timeframe = '24h' }) {
  const canvas = document.getElementById('tokenPriceChart');
  if (!canvas) return;
  const w = canvas.width;
  const h = canvas.height;
  const pad = { top: 12, bottom: 20, left: 4, right: 4 };
  const chartW = w - pad.left - pad.right;
  const chartH = h - pad.top - pad.bottom;

  const paintBase = () => {
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#FFF8F0';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#E8E0D8';
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + (chartH / 4) * i;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(w - pad.right, y);
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

  paintMessage(`Loading ${timeframe} chart…`);

  const days = CHART_TF_DAYS[timeframe] || 1;
  let candles = [];
  try {
    const chainId = getNetworkById(get('networkId'))?.chainId;
    candles = await fetchOHLC({ address, chainId, days });
  } catch { candles = []; }

  if (!canvas.isConnected || document.getElementById('tokenPriceChart') !== canvas) return;

  if (!candles.length || candles.length < 2) {
    paintMessage(`No ${timeframe} data`);
    return;
  }

  // Limit candles for readability (max ~60)
  const maxCandles = 60;
  const step2 = Math.max(1, Math.floor(candles.length / maxCandles));
  const display = candles.filter((_, i) => i % step2 === 0 || i === candles.length - 1);

  const allHigh = Math.max(...display.map(c => c.high));
  const allLow = Math.min(...display.map(c => c.low));
  const range = allHigh - allLow || 1;
  const candleW = Math.max(2, (chartW / display.length) - 1);
  const gap = chartW / display.length;

  const ctx = canvas.getContext('2d');
  paintBase();

  // Price labels (high / mid / low)
  ctx.fillStyle = '#8A8178';
  ctx.font = '9px monospace';
  ctx.textAlign = 'right';
  const fmtPrice = (v) => v >= 1 ? v.toFixed(2) : v >= 0.01 ? v.toFixed(4) : v.toFixed(6);
  ctx.fillText(fmtPrice(allHigh), w - 2, pad.top + 8);
  ctx.fillText(fmtPrice(allLow), w - 2, h - pad.bottom - 2);
  ctx.fillText(fmtPrice((allHigh + allLow) / 2), w - 2, pad.top + chartH / 2 + 4);

  // Draw candles
  display.forEach((c, i) => {
    const x = pad.left + i * gap + gap / 2;
    const isUp = c.close >= c.open;
    const color = isUp ? '#22C55E' : '#EF4444';
    const wickX = Math.round(x);
    const bodyTop = pad.top + chartH - ((Math.max(c.open, c.close) - allLow) / range) * chartH;
    const bodyBot = pad.top + chartH - ((Math.min(c.open, c.close) - allLow) / range) * chartH;
    const wickTop = pad.top + chartH - ((c.high - allLow) / range) * chartH;
    const wickBot = pad.top + chartH - ((c.low - allLow) / range) * chartH;

    // Wick
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.moveTo(wickX, wickTop);
    ctx.lineTo(wickX, wickBot);
    ctx.stroke();

    // Body
    const bodyH = Math.max(1, bodyBot - bodyTop);
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(x - candleW / 2), Math.round(bodyTop), Math.round(candleW), Math.round(bodyH));
  });

  // Current price line (dashed)
  const last = display[display.length - 1];
  const lastY = pad.top + chartH - ((last.close - allLow) / range) * chartH;
  ctx.setLineDash([4, 3]);
  ctx.strokeStyle = '#FF6B35';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad.left, lastY);
  ctx.lineTo(w - pad.right, lastY);
  ctx.stroke();
  ctx.setLineDash([]);

  // Current price dot
  ctx.beginPath();
  ctx.arc(w - pad.right, lastY, 3, 0, Math.PI * 2);
  ctx.fillStyle = '#FF6B35';
  ctx.fill();
  ctx.strokeStyle = '#FFF8F0';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Price label overlay
  const label = document.getElementById('chartPriceLabel');
  if (label) {
    const pctChange = display.length >= 2 ? ((last.close - display[0].open) / display[0].open * 100) : 0;
    const sign = pctChange >= 0 ? '+' : '';
    label.textContent = `${fmtPrice(last.close)} (${sign}${pctChange.toFixed(2)}%)`;
    label.style.color = pctChange >= 0 ? '#22C55E' : '#EF4444';
  }
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
  const testnetEl = $('#setTestnet');
  if (testnetEl) testnetEl.checked = get('settings').testnet !== false;
  // Auto-lock is a dropdown now — reflect the saved value (not the HTML default)
  const autoLockEl = $('#setAutoLock');
  if (autoLockEl) autoLockEl.value = String(get('settings').autoLock ?? 5);
}

// ── approval manager ──
async function scanApprovals() {
  // Read-only: allowances are public chain data and need no signature.
  if (!get('address')) { showUnlockModal(); return; }
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
    if (!get('unlocked')) { requireUnlock(); return; }
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
  const rawAutoLock = Number($('#setAutoLock').value);
  settings.autoLock = Number.isFinite(rawAutoLock) ? rawAutoLock : 5;
  const testnetEl = $('#setTestnet');
  if (testnetEl) settings.testnet = testnetEl.checked;
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
  // testnet toggle: if the active network is a testnet and testnets are now
  // hidden, fall back to Ethereum so the app never sits on an invisible chain.
  // NOTE: look up the active chain in the UNFILTERED list — getNetworkById()
  // and getAllNetworks() already hide testnets once settings.testnet is false,
  // so they would report the active chain as Ethereum and skip the fallback.
  if (!settings.testnet) {
    const activeNet = [...NETWORKS, ...getCustomNetworks()].find(n => n.id === get('networkId'));
    if (activeNet?.type === 'testnet') {
      set('networkId', 'ethereum');
      updateTopbar();
      if (get('address')) loadDashboard();
    }
  }
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
    wallet.clearSession();
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
// Hero sparkline — 24h native price from CoinGecko, auto-paired to the
// chain's native coin id (no manual symbol→id map to maintain). Cosmetic:
// an empty canvas or a missing element must never block the dashboard.
async function renderHeroSpark(net) {
  const canvas = $('#heroSpark');
  if (!canvas || !net) return;
  const history = await fetchPriceHistory({ address: null, chainId: net.chainId });
  if (!Array.isArray(history) || history.length < 2) return;
  const w = canvas.clientWidth || 200;
  const h = 40;
  const min = Math.min(...history);
  const max = Math.max(...history);
  const range = (max - min) || 1;
  const step = w / (history.length - 1);
  const points = history.map((v, i) => {
    const x = (i * step).toFixed(1);
    const y = (h - 2 - ((v - min) / range) * (h - 6)).toFixed(1);
    return `${x},${y}`;
  }).join(' ');
  const last = history[history.length - 1];
  const first = history[0];
  const up = last >= first;
  canvas.innerHTML = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" width="100%" height="${h}" role="img" aria-label="24h price trend"><polyline points="${points}" fill="none" stroke="${up ? '#1B8F4E' : '#D64545'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
