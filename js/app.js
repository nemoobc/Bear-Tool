// ═══════════════════════════════════════════════════════════════
// Bear Tool — app.js (entry point)
// Router + all view logic. Original implementation — no copying.
// ═══════════════════════════════════════════════════════════════

import { NETWORKS, POPULAR_TOKENS, ERC20_ABI, ERC721_ABI, ERC1155_ABI, EIP7702,
         getAllNetworks, getNetwork, getNetworkById, getProvider, getDelegation,
         addCustomNetwork, removeCustomNetwork } from './network.js';
import * as wallet from './wallet.js';
import { $, $all, toast, openModal, closeModal, spinnerBear, confirmTx, promptPassword,
         fmtAmount, fmtUsd, fmtTime } from './ui.js';
import { runIntro } from './theme.js';

// ── global state ──
const state = {
  unlocked: false,
  signer: null,
  address: null,
  networkId: 'ethereum',
  provider: null,
  tokens: [],          // [{address, symbol, decimals, balance, usd}]
  activity: [],        // [{hash, type, status, ts, ...}]
  swapQuote: null,
  bridgeQuote: null,
  batch: [],           // [{target, data, value}]
  approvals: [],
  settings: { currency: 'usd', lang: 'en', autoLock: 5, rpc: '' }
};

// ── boot ──
window.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  bindNav();
  bindTopbar();
  bindViews();
  runIntro(() => {
    if (wallet.getKeystore()) {
      // wallet exists → prompt unlock
      showUnlockModal();
    } else {
      showWelcomeModal();
    }
  });
});

// ── settings ──
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('bear.settings') || '{}');
    state.settings = { ...state.settings, ...s };
  } catch {}
}
function saveSettings() {
  localStorage.setItem('bear.settings', JSON.stringify(state.settings));
}

// ── nav ──
function bindNav() {
  $all('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      $all('.nav-item').forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      $all('.view').forEach(v => v.classList.remove('active'));
      $('#view-' + item.dataset.view).classList.add('active');
      refreshView(item.dataset.view);
    });
  });
}

function refreshView(view) {
  if (!state.unlocked) return;
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
    $all('.nav-item').forEach(i => i.classList.remove('active'));
    $('.nav-item[data-view="dashboard"]').classList.add('active');
    $all('.view').forEach(v => v.classList.remove('active'));
    $('#view-dashboard').classList.add('active');
    refreshView('dashboard');
  });
  $('#networkPill').addEventListener('click', showNetworkModal);
  $('#accountPill').addEventListener('click', showAccountModal);
}

function updateTopbar() {
  const net = getNetworkById(state.networkId);
  const pill = $('#networkPill');
  pill.className = 'network-pill ' + (net?.type || 'mainnet');
  $('#networkName').textContent = net?.name || '?';
  $('#accountShort').textContent = state.address ? wallet.shortAddress(state.address) : 'Not connected';
}

// ── welcome / unlock modals ──
function showWelcomeModal() {
  openModal(`
    <button class="modal-close" onclick="document.getElementById('modalOverlay').classList.remove('open')">✕</button>
    <div class="tx-confirm">
      <img src="assets/bear.svg" alt="Bear Tool">
      <div class="question">Welcome to Bear Tool! 🍯</div>
      <p class="small mb-16">Self-custody wallet. Your keys never leave this browser.</p>
      <div class="flex gap-8">
        <button class="btn btn-primary" id="wCreate">🐻 Create Wallet</button>
        <button class="btn btn-secondary" id="wImport">📥 Import</button>
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
      <div class="question">Welcome back! 🐻</div>
      <div class="field">
        <label for="unlockPw">Password</label>
        <input class="input" id="unlockPw" type="password" placeholder="••••••••">
      </div>
      <button class="btn btn-primary btn-block" id="unlockBtn">Unlock</button>
    </div>
  `);
  const pw = $('#unlockPw');
  pw.focus();
  const doUnlock = async () => {
    try {
      state.signer = await wallet.unlockWallet(pw.value);
      state.address = state.signer.address;
      state.unlocked = true;
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
      <div class="mono" style="font-size:1.1rem;line-height:2">${mnemonic.split(' ').map((w,i)=>`<b>${i+1}.</b> ${w}`).join(' ')}</div>
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
    state.signer = new ethers.Wallet.fromPhrase(mnemonic);
    state.address = address;
    state.unlocked = true;
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
      state.signer = new ethers.Wallet(secret.startsWith('0x') ? secret : ethers.Wallet.fromPhrase(secret).privateKey);
      state.address = res.address;
      state.unlocked = true;
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
    state.unlocked = false;
    state.signer = null;
    toast('Auto-locked 🔒', 'info');
    showUnlockModal();
  }, state.settings.autoLock * 60 * 1000);
}
function resetLock() {
  if (state.unlocked) startAutoLock();
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
}

function netRow(n) {
  const active = n.id === state.networkId ? 'style="border-left:8px solid var(--mint)"' : '';
  return `<div class="asset-row" data-net="${n.id}" ${active}>
    <div class="asset-icon" style="background:${n.color}22">${n.icon}</div>
    <div class="asset-info"><div class="asset-name">${n.name}</div>
      <div class="asset-symbol">Chain ${n.chainId} · ${n.symbol}</div></div>
    <span class="badge ${n.type === 'mainnet' ? 'badge-mainnet' : 'badge-testnet'}">${n.type}</span>
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
    <button class="btn btn-primary btn-block" id="cnSave">Save Network</button>
  `);
  $('#cnSave').onclick = () => {
    const net = {
      name: $('#cnName').value.trim(),
      chainId: Number($('#cnChainId').value),
      rpc: [$('#cnRpc').value.trim()],
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
  if (!state.unlocked) return showUnlockModal();
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
          <div class="mono">${a.address}</div>
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
      state.signer = await wallet.unlockWallet(pw);
      state.address = state.signer.address;
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
        <div class="card" style="box-shadow:none"><div class="mono">${secret}</div></div>
        <button class="btn btn-primary btn-block" onclick="document.getElementById('modalOverlay').classList.remove('open')">Close</button>
      `);
    } catch { toast('Wrong password', 'error'); }
  };
  $('#lockBtn').onclick = () => {
    state.unlocked = false; state.signer = null;
    closeModal();
    toast('Locked 🔒', 'info');
    showUnlockModal();
  };
}

// ── dashboard ──
async function loadDashboard() {
  if (!state.unlocked) return;
  const net = getNetworkById(state.networkId);
  $('#balanceSub').textContent = `${net.name} · ${wallet.shortAddress(state.address)}`;
  $('#assetList').innerHTML = spinnerBear();
  try {
    state.provider = await getProvider(net.chainId);
    const balance = await state.provider.getBalance(state.address);
    const native = {
      address: null, symbol: net.symbol, decimals: net.decimals,
      balance: balance.toString(), usd: null
    };
    // fetch ERC-20 balances
    const tokens = [native];
    const popular = POPULAR_TOKENS[net.chainId] || [];
    for (const t of popular) {
      try {
        const c = new ethers.Contract(t.address, ERC20_ABI, state.provider);
        const bal = await c.balanceOf(state.address);
        if (bal > 0n) {
          tokens.push({ address: t.address, symbol: t.symbol, decimals: t.decimals, balance: bal.toString(), usd: null });
        }
      } catch {}
    }
    state.tokens = tokens;
    renderAssets(tokens);
    loadNfts();
  } catch (e) {
    $('#assetList').innerHTML = `<p class="small text-center">Error: ${e.message}</p>`;
  }
}

function renderAssets(tokens) {
  const totalUsd = tokens.reduce((s, t) => s + (t.usd || 0), 0);
  $('#totalBalance').textContent = fmtUsd(totalUsd);
  if (!tokens.length) {
    $('#assetList').innerHTML = '<p class="small text-center">No assets found.</p>';
    return;
  }
  $('#assetList').innerHTML = tokens.map(t => `
    <div class="asset-row">
      <div class="asset-icon">${t.address ? '🪙' : '⬡'}</div>
      <div class="asset-info">
        <div class="asset-name">${t.symbol}</div>
        <div class="asset-symbol">${t.address ? wallet.shortAddress(t.address) : 'Native'}</div>
      </div>
      <div class="asset-balance">
        <div class="amount">${fmtAmount(t.balance, t.decimals)}</div>
        <div class="usd">${t.usd ? fmtUsd(t.usd) : '—'}</div>
      </div>
    </div>`).join('');
}

async function loadNfts() {
  const net = getNetworkById(state.networkId);
  const grid = $('#nftGrid');
  try {
    // ERC-721 balance + tokens (best effort)
    const provider = state.provider;
    const balance = await provider.getBalance(state.address);
    // We can't enumerate all NFTs without an indexer; show native balance note
    grid.innerHTML = `<p class="small text-center">NFT gallery: connect an indexer (Alchemy/QuickNode) to list NFTs. Native balance: ${fmtAmount(balance, net.decimals)} ${net.symbol}</p>`;
  } catch {
    grid.innerHTML = '<p class="small text-center">NFT gallery unavailable on this network.</p>';
  }
}

// ── send ──
function loadSendTokens() {
  const sel = $('#sendToken');
  sel.innerHTML = state.tokens.map(t =>
    `<option value="${t.address || 'native'}">${t.symbol} (${fmtAmount(t.balance, t.decimals)})</option>`
  ).join('');
}

function bindViews() {
  $('#btnSend').addEventListener('click', doSend);
  $('#btnSendMax').addEventListener('click', () => {
    const sel = $('#sendToken');
    const t = state.tokens.find(x => (x.address || 'native') === sel.value);
    if (t) $('#sendAmount').value = fmtAmount(t.balance, t.decimals);
  });
  $('#sendAmount').addEventListener('input', updateSendPreview);
  $('#sendTo').addEventListener('input', updateSendPreview);

  $('#btnSwap').addEventListener('click', doSwap);
  $('#btnSwapFlip').addEventListener('click', flipSwap);
  $('#swapFromAmount').addEventListener('input', debounce(getSwapQuote, 600));

  $('#btnBridge').addEventListener('click', doBridge);

  $('#btnDelegate').addEventListener('click', () => doEip7702('delegate'));
  $('#btnRevoke').addEventListener('click', () => doEip7702('revoke'));
  $('#btnBatchAdd').addEventListener('click', addBatchItem);
  $('#btnBatchExecute').addEventListener('click', executeBatch);
  $('#btnRescue').addEventListener('click', doRescue);
  $('#btnClaim').addEventListener('click', doClaim);

  $('#approvalMode').addEventListener('change', () => {
    $('#approvalCustomWrap').classList.toggle('hidden', $('#approvalMode').value !== 'custom');
  });
  $('#btnApprovalScan').addEventListener('click', scanApprovals);

  $('#deployStandard').addEventListener('change', renderDeployExtra);
  $('#btnDeploy').addEventListener('click', doDeploy);

  $('#btnSaveSettings').addEventListener('click', saveSettingsHandler);
  $('#btnClearData').addEventListener('click', clearAllData);
}

function updateSendPreview() {
  const to = $('#sendTo').value.trim();
  const amt = $('#sendAmount').value;
  const preview = $('#sendPreview');
  if (!to || !amt) { preview.classList.add('hidden'); return; }
  if (!wallet.isValidAddress(to)) {
    preview.innerHTML = '⚠️ Invalid address';
    preview.classList.remove('hidden');
    return;
  }
  preview.innerHTML = `Sending <b>${amt}</b> to <span class="mono">${wallet.shortAddress(to)}</span>`;
  preview.classList.remove('hidden');
}

async function doSend() {
  if (!state.unlocked) return showUnlockModal();
  const to = $('#sendTo').value.trim();
  const amt = $('#sendAmount').value;
  const tokenSel = $('#sendToken').value;
  const gasSpeed = $('#sendGas').value;
  if (!wallet.isValidAddress(to)) return toast('Invalid destination address', 'error');
  if (!amt || parseFloat(amt) <= 0) return toast('Enter a valid amount', 'error');

  const net = getNetworkById(state.networkId);
  const t = state.tokens.find(x => (x.address || 'native') === tokenSel);
  if (!t) return toast('Token not found', 'error');

  // mainnet safety
  if (net.type === 'mainnet') {
    const ok = await confirmTx({
      title: 'MAINNET TRANSACTION!',
      rows: [{ k: 'Network', v: net.name }, { k: 'To', v: wallet.shortAddress(to) }, { k: 'Amount', v: `${amt} ${t.symbol}` }],
      confirmText: 'I understand, send',
      danger: true, requireType: 'YA'
    });
    if (!ok) return;
  }

  try {
    const provider = state.provider;
    const signer = state.signer.connect(provider);
    const feeData = await provider.getFeeData();
    const gasPrice = gasSpeed === 'slow' ? feeData.gasPrice * 90n / 100n
      : gasSpeed === 'fast' ? feeData.gasPrice * 120n / 100n
      : feeData.gasPrice;

    let tx;
    if (tokenSel === 'native') {
      tx = await signer.sendTransaction({
        to, value: ethers.parseEther(amt),
        maxFeePerGas: feeData.maxFeePerGas || gasPrice,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas || gasPrice
      });
    } else {
      const c = new ethers.Contract(t.address, ERC20_ABI, signer);
      tx = await c.transfer(to, ethers.parseUnits(amt, t.decimals));
    }
    toast('Transaction sent! ⏳', 'info');
    addActivity({ hash: tx.hash, type: 'send', status: 'pending', ts: Date.now(), detail: `${amt} ${t.symbol} → ${wallet.shortAddress(to)}` });
    const receipt = await tx.wait();
    addActivity({ hash: tx.hash, type: 'send', status: receipt.status === 1 ? 'success' : 'failed', ts: Date.now(), detail: `${amt} ${t.symbol} → ${wallet.shortAddress(to)}` });
    toast(receipt.status === 1 ? 'Transaction confirmed! 🎉' : 'Transaction failed!', receipt.status === 1 ? 'success' : 'error');
    loadDashboard();
  } catch (e) {
    toast('Send failed: ' + e.message, 'error');
  }
}

// ── swap ──
function loadSwapTokens() {
  const from = $('#swapFrom'), to = $('#swapTo');
  const opts = state.tokens.map(t => `<option value="${t.address || 'native'}">${t.symbol}</option>`).join('');
  from.innerHTML = opts;
  to.innerHTML = opts;
  if (from.options.length > 1) to.selectedIndex = 1;
}

function flipSwap() {
  const from = $('#swapFrom'), to = $('#swapTo');
  const tmp = from.value; from.value = to.value; to.value = tmp;
  $('#swapFromAmount').value = '';
  $('#swapToAmount').value = '';
  $('#swapQuote').classList.add('hidden');
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

async function getSwapQuote() {
  const amt = $('#swapFromAmount').value;
  if (!amt || parseFloat(amt) <= 0) return;
  const from = $('#swapFrom').value, to = $('#swapTo').value;
  const net = getNetworkById(state.networkId);
  const quoteBox = $('#swapQuote');
  quoteBox.innerHTML = spinnerDots();
  quoteBox.classList.remove('hidden');
  try {
    // 0x API quote (best effort) — fallback to simulated quote
    const buyToken = to === 'native' ? net.symbol : to;
    const sellToken = from === 'native' ? net.symbol : from;
    const url = `https://api.0x.org/swap/v1/quote?buyToken=${buyToken}&sellToken=${sellToken}&sellAmount=${ethers.parseEther(amt)}&chainId=${net.chainId}`;
    const res = await fetch(url);
    if (res.ok) {
      const q = await res.json();
      state.swapQuote = q;
      $('#swapToAmount').value = ethers.formatEther(q.buyAmount);
      quoteBox.innerHTML = `Rate: 1 ${sellToken} ≈ ${(parseFloat(ethers.formatEther(q.buyAmount)) / parseFloat(amt)).toFixed(6)} ${buyToken}<br>
        Est. gas: ${fmtUsd(parseFloat(q.estimatedGas) * 1e-9)} · Slippage: ${q.slippagePercentage || '0.5'}%`;
    } else {
      // simulated quote (offline fallback)
      const rate = 1 + (Math.random() - 0.5) * 0.02;
      const out = parseFloat(amt) * rate;
      $('#swapToAmount').value = out.toFixed(6);
      state.swapQuote = { simulated: true, rate, out, sellToken, buyToken };
      quoteBox.innerHTML = `Simulated quote (offline): 1 ${sellToken} ≈ ${rate.toFixed(6)} ${buyToken}`;
    }
  } catch {
    const out = parseFloat(amt);
    $('#swapToAmount').value = out.toFixed(6);
    state.swapQuote = { simulated: true, rate: 1, out, sellToken: from, buyToken: to };
    quoteBox.innerHTML = 'Simulated quote (offline): 1:1';
  }
}

async function doSwap() {
  if (!state.unlocked) return showUnlockModal();
  const amt = $('#swapFromAmount').value;
  if (!amt || parseFloat(amt) <= 0) return toast('Enter amount to swap', 'error');
  const from = $('#swapFrom').value, to = $('#swapTo').value;
  const net = getNetworkById(state.networkId);
  if (net.type === 'mainnet') {
    const ok = await confirmTx({
      title: 'MAINNET SWAP!',
      rows: [{ k: 'From', v: `${amt} ${from}` }, { k: 'To', v: to }, { k: 'Network', v: net.name }],
      confirmText: 'Swap', danger: true, requireType: 'YA'
    });
    if (!ok) return;
  }
  toast('Swap requires a relayer/aggregator. In production, connect 0x API with your API key. (Simulated mode)', 'info');
}

// ── bridge ──
function loadBridgeChains() {
  const from = $('#bridgeFromChain'), to = $('#bridgeToChain');
  const opts = getAllNetworks().map(n => `<option value="${n.id}">${n.name} (${n.type})</option>`).join('');
  from.innerHTML = opts;
  to.innerHTML = opts;
  if (from.options.length > 1) to.selectedIndex = 1;
  const tok = $('#bridgeToken');
  tok.innerHTML = state.tokens.map(t => `<option value="${t.address || 'native'}">${t.symbol}</option>`).join('');
}

async function doBridge() {
  if (!state.unlocked) return showUnlockModal();
  const fromNet = getNetworkById($('#bridgeFromChain').value);
  const toNet = getNetworkById($('#bridgeToChain').value);
  const amt = $('#bridgeAmount').value;
  if (!amt || parseFloat(amt) <= 0) return toast('Enter amount to bridge', 'error');
  const box = $('#bridgeQuote');
  box.innerHTML = spinnerDots();
  box.classList.remove('hidden');
  try {
    // LI.FI quote (best effort) — fallback simulated
    const url = `https://li.quest/v1/quote?fromChain=${fromNet.chainId}&toChain=${toNet.chainId}&fromToken=0x0000000000000000000000000000000000000000&toToken=0x0000000000000000000000000000000000000000&fromAmount=${ethers.parseEther(amt)}`;
    const res = await fetch(url);
    if (res.ok) {
      const q = await res.json();
      state.bridgeQuote = q;
      box.innerHTML = `Route: ${q.routes?.[0]?.steps?.length || '?'} steps · Est. time: ${q.routes?.[0]?.estimate?.executionDuration || '?'}s<br>
        Fee: ${fmtUsd(parseFloat(q.routes?.[0]?.estimate?.feeCosts?.[0]?.amountUSD || 0))}`;
    } else {
      state.bridgeQuote = { simulated: true };
      box.innerHTML = `Simulated route: ${fromNet.name} → ${toNet.name} (${amt} tokens). Connect LI.FI API for real quotes.`;
    }
  } catch {
    state.bridgeQuote = { simulated: true };
    box.innerHTML = `Simulated route: ${fromNet.name} → ${toNet.name}. Connect LI.FI API for real quotes.`;
  }
}

// ── EIP-7702 ──
async function loadEip7702() {
  if (!state.unlocked) return;
  const status = $('#delegateStatus');
  const text = $('#delegateStatusText');
  try {
    const net = getNetworkById(state.networkId);
    const provider = await getProvider(net.chainId);
    const delegate = await getDelegation(provider, state.address);
    if (delegate) {
      status.className = 'delegate-status delegated';
      text.innerHTML = `Delegated to <span class="addr">${delegate}</span>`;
    } else {
      status.className = 'delegate-status eoa';
      text.textContent = 'Plain EOA (no delegation)';
    }
  } catch {
    text.textContent = 'Cannot check (RPC error)';
  }
}

async function doEip7702(action) {
  if (!state.unlocked) return showUnlockModal();
  const net = getNetworkById(state.networkId);
  const impl = action === 'delegate' ? $('#delegateAddr').value.trim() : EIP7702.ZERO_ADDRESS;
  const chainId = action === 'delegate' ? Number($('#delegateChainId').value || 0) : net.chainId;

  if (action === 'delegate' && !wallet.isValidAddress(impl)) return toast('Invalid implementation address', 'error');
  if (action === 'delegate' && net.type === 'mainnet') {
    const ok = await confirmTx({
      title: 'DELEGATE ON MAINNET!',
      rows: [
        { k: 'Implementation', v: impl },
        { k: 'Chain ID', v: chainId === 0 ? '0 (ALL CHAINS — replay risk!)' : String(chainId) },
        { k: 'Network', v: net.name }
      ],
      confirmText: 'Delegate', danger: true, requireType: 'DELEGATE'
    });
    if (!ok) return;
  }

  try {
    const provider = state.provider;
    const signer = state.signer.connect(provider);
    const nonce = await provider.getTransactionCount(state.address);
    // EIP-7702: self-sponsored → auth nonce = nonce + 1
    const authNonce = nonce + 1;
    const authorization = await signer.signAuthorization({
      chainId, address: impl, nonce: authNonce
    });
    const feeData = await provider.getFeeData();
    const tx = await signer.sendTransaction({
      to: state.address,
      authorizationList: [authorization],
      maxFeePerGas: feeData.maxFeePerGas,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas
    });
    toast(action === 'delegate' ? 'Delegation tx sent! ⚡' : 'Revoke tx sent! ⚡', 'info');
    addActivity({ hash: tx.hash, type: 'eip7702-' + action, status: 'pending', ts: Date.now(), detail: impl });
    const receipt = await tx.wait();
    addActivity({ hash: tx.hash, type: 'eip7702-' + action, status: receipt.status === 1 ? 'success' : 'failed', ts: Date.now(), detail: impl });
    toast(receipt.status === 1 ? 'Done! 🎉' : 'Failed!', receipt.status === 1 ? 'success' : 'error');
    loadEip7702();
  } catch (e) {
    toast('EIP-7702 failed: ' + e.message, 'error');
  }
}

// batch call
function addBatchItem() {
  state.batch.push({ target: '', data: '', value: '0' });
  renderBatch();
}
function renderBatch() {
  const list = $('#batchList');
  if (!state.batch.length) {
    list.innerHTML = '<p class="small text-center">No actions. Add one to batch.</p>';
    return;
  }
  list.innerHTML = state.batch.map((b, i) => `
    <div class="batch-item">
      <span class="idx">${i + 1}</span>
      <input class="input" data-batch="target" data-i="${i}" placeholder="Target contract 0x..." value="${b.target}">
      <input class="input" data-batch="data" data-i="${i}" placeholder="Calldata 0x..." value="${b.data}">
      <button class="btn btn-danger" data-del="${i}">✕</button>
    </div>`).join('');
  $all('[data-batch]').forEach(el => el.addEventListener('input', (e) => {
    state.batch[Number(e.target.dataset.i)][e.target.dataset.batch] = e.target.value;
  }));
  $all('[data-del]').forEach(el => el.addEventListener('click', () => {
    state.batch.splice(Number(el.dataset.del), 1);
    renderBatch();
  }));
}

async function executeBatch() {
  if (!state.unlocked) return showUnlockModal();
  const valid = state.batch.filter(b => b.target && b.data);
  if (!valid.length) return toast('Add at least one valid action', 'error');
  const net = getNetworkById(state.networkId);
  if (net.type === 'mainnet') {
    const ok = await confirmTx({
      title: 'BATCH ON MAINNET!',
      rows: [{ k: 'Actions', v: String(valid.length) }, { k: 'Network', v: net.name }],
      confirmText: 'Execute', danger: true, requireType: 'YA'
    });
    if (!ok) return;
  }
  toast('Batch execution requires a 7702-compatible implementation contract. Connect one to execute atomically.', 'info');
}

// rescue
async function doRescue() {
  if (!state.unlocked) return showUnlockModal();
  const target = $('#rescueTarget').value.trim();
  const safe = $('#rescueSafe').value.trim();
  if (!wallet.isValidAddress(target) || !wallet.isValidAddress(safe)) return toast('Invalid addresses', 'error');
  toast('Rescue requires a deployed rescue contract + sponsored gas. See docs/PROMPT.md for the full flow.', 'info');
}

// claim
async function doClaim() {
  if (!state.unlocked) return showUnlockModal();
  const token = $('#claimToken').value.trim();
  const safe = $('#claimSafe').value.trim();
  if (!wallet.isValidAddress(token) || !wallet.isValidAddress(safe)) return toast('Invalid addresses', 'error');
  toast('Claim + forward requires a 7702 implementation. See docs/PROMPT.md.', 'info');
}

// ── approval manager ──
async function scanApprovals() {
  if (!state.unlocked) return showUnlockModal();
  const mode = $('#approvalMode').value;
  const net = getNetworkById(state.networkId);
  const list = $('#approvalList');
  list.innerHTML = spinnerBear();
  try {
    const provider = state.provider;
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
        // scan recent Transfer/Approval events (best effort, last 2000 blocks)
        const block = await provider.getBlockNumber();
        const fromBlock = Math.max(0, block - 2000);
        const events = await c.queryFilter(c.filters.Approval(state.address), fromBlock, block);
        const seen = new Set();
        for (const ev of events.slice(-10)) {
          const spender = ev.args[1];
          if (seen.has(spender)) continue;
          seen.add(spender);
          const allowance = await c.allowance(state.address, spender);
          approvals.push({
            token: t, spender,
            allowance: allowance.toString(),
            unlimited: allowance >= (1n << 255n)
          });
        }
      } catch {}
    }
    state.approvals = approvals;
    renderApprovals(approvals);
  } catch (e) {
    list.innerHTML = `<p class="small text-center">Error: ${e.message}</p>`;
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
        <div class="asset-name">${a.token.symbol} ${a.unlimited ? '<span class="badge badge-warn">UNLIMITED</span>' : ''}</div>
        <div class="mono">Spender: ${a.spender}</div>
        <div class="asset-symbol">Allowance: ${fmtAmount(a.allowance, a.token.decimals)}</div>
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
      const signer = state.signer.connect(state.provider);
      const c = new ethers.Contract(a.token.address, ERC20_ABI, signer);
      const tx = await c.approve(a.spender, 0);
      toast('Revoke tx sent!', 'info');
      await tx.wait();
      toast('Approval revoked! 🎉', 'success');
      scanApprovals();
    } catch (e) { toast('Revoke failed: ' + e.message, 'error'); }
  }));
}

// ── deploy wizard ──
function renderDeployExtra() {
  const std = $('#deployStandard').value;
  const extra = $('#deployExtra');
  if (std === 'erc20') {
    extra.innerHTML = `
      <div class="field"><label>Initial supply</label><input class="input" id="deploySupply" type="number" placeholder="1000000"></div>
      <div class="field"><label>Decimals</label><input class="input" id="deployDecimals" type="number" value="18"></div>`;
  } else if (std === 'erc721') {
    extra.innerHTML = `
      <div class="field"><label>Base URI</label><input class="input" id="deployBaseUri" placeholder="https://.../"></div>`;
  } else {
    extra.innerHTML = `
      <div class="field"><label>Base URI</label><input class="input" id="deployBaseUri" placeholder="https://.../"></div>`;
  }
}

async function doDeploy() {
  if (!state.unlocked) return showUnlockModal();
  const std = $('#deployStandard').value;
  const name = $('#deployName').value.trim();
  const symbol = $('#deploySymbol').value.trim();
  if (!name || !symbol) return toast('Enter name and symbol', 'error');
  const net = getNetworkById(state.networkId);
  if (net.type === 'mainnet') {
    const ok = await confirmTx({
      title: 'DEPLOY ON MAINNET!',
      rows: [{ k: 'Standard', v: std.toUpperCase() }, { k: 'Name', v: name }, { k: 'Symbol', v: symbol }],
      confirmText: 'Deploy', danger: true, requireType: 'YA'
    });
    if (!ok) return;
  }
  toast('Deploy wizard needs contract templates (Solidity bytecode). See docs/PROMPT.md for full wizard spec.', 'info');
}

// ── activity ──
function addActivity(item) {
  state.activity.unshift(item);
  localStorage.setItem('bear.activity', JSON.stringify(state.activity.slice(0, 100)));
}
function loadActivity() {
  try { state.activity = JSON.parse(localStorage.getItem('bear.activity') || '[]'); } catch { state.activity = []; }
}
function renderActivity() {
  loadActivity();
  const list = $('#activityList');
  if (!state.activity.length) {
    list.innerHTML = '<p class="small text-center">No transactions yet.</p>';
    return;
  }
  const net = getNetworkById(state.networkId);
  list.innerHTML = state.activity.map(a => `
    <div class="asset-row">
      <div class="asset-icon">${a.status === 'success' ? '✅' : a.status === 'failed' ? '❌' : '⏳'}</div>
      <div class="asset-info">
        <div class="asset-name">${a.type} ${a.status}</div>
        <div class="asset-symbol">${a.detail}</div>
        <div class="asset-symbol">${fmtTime(a.ts)}</div>
      </div>
      <a class="btn btn-ghost" href="${net.explorer}/tx/${a.hash}" target="_blank" rel="noopener">View</a>
    </div>`).join('');
}

// ── settings ──
function saveSettingsHandler() {
  state.settings.currency = $('#setCurrency').value;
  state.settings.lang = $('#setLang').value;
  state.settings.autoLock = Number($('#setAutoLock').value) || 5;
  const rpc = $('#setRpc').value.trim();
  if (rpc) {
    const net = getNetworkById(state.networkId);
    if (net) {
      net.rpc.unshift(rpc);
      toast('Custom RPC added for ' + net.name, 'success');
    }
  }
  saveSettings();
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
    state.unlocked = false; state.signer = null; state.address = null;
    closeModal();
    toast('All data cleared.', 'info');
    showWelcomeModal();
  };
}

// init activity
loadActivity();