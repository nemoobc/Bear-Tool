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
import { fetchAllPrices } from './price.js';
import { bindSendEvents, loadSendTokens } from './send.js';
import { bindSwapEvents, loadSwapTokens } from './swap.js';
import { bindBridgeEvents, loadBridgeChains } from './bridge.js';
import { bindEip7702Events, loadEip7702 } from './eip7702.js';
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
      switchView(item.dataset.view);
    });
  });
  // mobile bottom nav
  $all('.mobile-nav-item').forEach(item => {
    item.addEventListener('click', () => {
      switchView(item.dataset.view);
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
  const sidebarItem = $(`.nav-item[data-view="${view}"]`);
  const mobileItem = $(`.mobile-nav-item[data-view="${view}"]`);
  if (sidebarItem) sidebarItem.classList.add('active');
  if (mobileItem) mobileItem.classList.add('active');
  $all('.view').forEach(v => v.classList.remove('active'));
  $('#view-' + view).classList.add('active');
  refreshView(view);
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
  $('#networkName').textContent = net?.name || '?';
  $('#accountShort').textContent = get('address') ? wallet.shortAddress(get('address')) : 'Not connected';
}

// ── welcome / unlock modals ──
function showWelcomeModal() {
  openModal(`
    <button class="modal-close" onclick="document.getElementById('modalOverlay').classList.remove('open')">✕</button>
    <div class="tx-confirm">
      <img src="assets/bear.svg" alt="Bear Tool">
      <div class="question">${escapeHtml(t('welcome.title'))}</div>
      <p class="small mb-16">${escapeHtml(t('welcome.desc'))}</p>
      <div class="flex gap-8">
        <button class="btn btn-primary" id="wCreate">${escapeHtml(t('welcome.create'))}</button>
        <button class="btn btn-secondary" id="wImport">${escapeHtml(t('welcome.import'))}</button>
      </div>
    </div>
  `);
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
    <button class="modal-close" onclick="document.getElementById('modalOverlay').classList.remove('open')">✕</button>
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
    <button class="btn btn-primary btn-block" id="createBtn">Create</button>
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
  openModal(`
    <button class="modal-close" onclick="document.getElementById('modalOverlay').classList.remove('open')">✕</button>
    <h2>🔑 Your Seed Phrase</h2>
    <div class="danger-box">Write these 12 words DOWN. Never share them. Never type them into any website.</div>
    <div class="card" style="box-shadow:none;background:var(--cream)">
      <div class="mono" style="font-size:1.1rem;line-height:2">${mnemonic.split(' ').map((w, i) => `<b>${i + 1}.</b> ${escapeHtml(w)}`).join(' ')}</div>
    </div>
    <div class="field">
      <label>Confirm: type word #1 to continue</label>
      <input class="input" id="seedConfirm" placeholder="First word">
    </div>
    <button class="btn btn-primary btn-block" id="seedDone">I saved it</button>
  `);
  const first = mnemonic.split(' ')[0];
  const btn = $('#seedDone');
  btn.disabled = true;
  $('#seedConfirm').addEventListener('input', (e) => {
    btn.disabled = e.target.value.trim().toLowerCase() !== first.toLowerCase();
  });
  btn.onclick = () => {
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
    <button class="modal-close" onclick="document.getElementById('modalOverlay').classList.remove('open')">✕</button>
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
    <button class="btn btn-primary btn-block" id="importBtn">Import</button>
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

// ── network modal ──
function showNetworkModal() {
  const nets = getAllNetworks();
  const html = `
    <button class="modal-close" onclick="document.getElementById('modalOverlay').classList.remove('open')">✕</button>
    <h2>🌐 Networks</h2>
    <div class="mb-8"><span class="badge badge-mainnet">MAINNET</span></div>
    ${nets.filter(n => n.type === 'mainnet').map(n => netRow(n)).join('')}
    <div class="mb-8 mt-16"><span class="badge badge-testnet">TESTNET</span></div>
    ${nets.filter(n => n.type === 'testnet').map(n => netRow(n)).join('')}
    <hr class="mt-16 mb-16">
    <button class="btn btn-secondary btn-block" id="addNetBtn">+ Add Custom Network</button>
  `;
  openModal(html);
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
    <div class="asset-icon" style="background:${escapeHtml(n.color)}22">${escapeHtml(n.icon)}</div>
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
  $('#balanceSub').textContent = `${net.name} · ${wallet.shortAddress(addr)}`;

  // ── wallet status ──
  const statusDot = document.querySelector('.status-dot');
  const statusText = document.querySelector('.status-text');
  const copyBtn = document.getElementById('copyAddress');
  if (statusDot) { statusDot.className = 'status-dot connected'; }
  if (statusText) { statusText.textContent = wallet.shortAddress(addr); }
  if (copyBtn) { copyBtn.dataset.copy = addr; copyBtn.style.display = ''; }

  $('#assetList').innerHTML = spinner(64, 0, 'Loading assets...');
  try {
    const provider = await getProvider(net.chainId);
    set('provider', provider);
    const balance = await provider.getBalance(get('address'));
    const native = {
      address: null, symbol: net.symbol, decimals: net.decimals,
      balance: balance.toString(), usd: null
    };
    const tokens = [native];
    const popular = POPULAR_TOKENS[net.chainId] || [];
    await Promise.allSettled(popular.map(async (t) => {
      try {
        const c = new ethers.Contract(t.address, ERC20_ABI, provider);
        const bal = await c.balanceOf(get('address'));
        if (bal > 0n) {
          tokens.push({ address: t.address, symbol: t.symbol, decimals: t.decimals, balance: bal.toString(), usd: null });
        }
      } catch {}
    }));
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
    loadNfts();
  } catch (e) {
    $('#assetList').innerHTML = `<p class="small text-center">Error: ${escapeHtml(e.message)}</p>`;
  }
}

function renderAssets(tokens) {
  const totalUsd = tokens.reduce((s, t) => s + (t.usd || 0), 0);
  animateValue($('#totalBalance'), totalUsd, { duration: 600, formatter: fmtUsd });
  if (!tokens.length) {
    $('#assetList').innerHTML = '<p class="small text-center">No assets found.</p>';
    return;
  }
  // Token icon class mapping
  const iconClass = (sym) => {
    const s = (sym || '').toLowerCase();
    if (s === 'eth' || s === 'ether') return 'eth';
    if (s === 'usdc') return 'usdc';
    if (s === 'wbtc') return 'wbtc';
    return 'default';
  };
  $('#assetList').innerHTML = tokens.map(t => `
    <div class="asset-row">
      <div class="token-icon ${iconClass(t.symbol)}">${(t.symbol || '?').slice(0, 3).toUpperCase()}</div>
      <div class="asset-info">
        <div class="asset-name">${escapeHtml(t.symbol)}</div>
        <div class="asset-symbol">${t.address ? escapeHtml(wallet.shortAddress(t.address)) : 'Native'}</div>
      </div>
      <div class="asset-balance">
        <div class="amount">${escapeHtml(fmtAmount(t.balance, t.decimals))}</div>
        <div class="usd">${t.usd ? escapeHtml(fmtUsd(t.usd)) : '—'}</div>
      </div>
    </div>`).join('');
}

// ── view wiring ──
function bindViews() {
  bindSendEvents();
  bindSwapEvents();
  bindBridgeEvents();
  bindEip7702Events();
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
  const mode = $('#approvalMode').value;
  const net = getNetworkById(get('networkId'));
  const list = $('#approvalList');
  list.innerHTML = spinner(64, 0, 'Scanning approvals...');
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
    for (const t of tokens) {
      if (!wallet.isValidAddress(t.address)) continue;
      try {
        const c = new ethers.Contract(t.address, ERC20_ABI, provider);
        const block = await provider.getBlockNumber();
        const fromBlock = Math.max(0, block - 2000);
        const events = await c.queryFilter(c.filters.Approval(get('address')), fromBlock, block);
        const seen = new Set();
        for (const ev of events.slice(-10)) {
          const spender = ev.args[1];
          if (seen.has(spender)) continue;
          seen.add(spender);
          const allowance = await c.allowance(get('address'), spender);
          approvals.push({
            token: t, spender,
            allowance: allowance.toString(),
            unlimited: allowance >= (1n << 255n)
          });
        }
      } catch {}
    }
    set('approvals', approvals);
    renderApprovals(approvals);
  } catch (e) {
    list.innerHTML = `<p class="small text-center">Error: ${escapeHtml(e.message)}</p>`;
  }
}

function renderApprovals(approvals) {
  const list = $('#approvalList');
  if (!approvals.length) {
    list.innerHTML = '<p class="small text-center">No approvals found. Clean! 🐻</p>';
    return;
  }
  list.innerHTML = approvals.map((a, i) => `
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
      await tx.wait();
      toast('Approval revoked! 🎉', 'success');
      scanApprovals();
    } catch (e) { toast('Revoke failed: ' + e.message, 'error'); }
  }));
}

// ── activity ──
function renderActivity() {
  loadActivity();
  const list = $('#activityList');
  if (!get('activity').length) {
    list.innerHTML = '<p class="small text-center">No transactions yet.</p>';
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
    <h2>🗑️ Clear all data?</h2>
    <div class="danger-box">This deletes ALL wallets, settings, and activity from this browser. Irreversible!</div>
    <div class="field"><label>Type <b>HAPUS</b> to confirm</label>
      <input class="input" id="clearConfirm" placeholder="HAPUS"></div>
    <button class="btn btn-danger btn-block" id="clearBtn" disabled>Delete everything</button>
  `);
  const btn = $('#clearBtn');
  $('#clearConfirm').addEventListener('input', (e) => {
    btn.disabled = e.target.value.trim() !== 'HAPUS';
  });
  btn.onclick = () => {
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

// init activity
loadActivity();