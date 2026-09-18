// ═══════════════════════════════════════════════════════════════
// Bear Tool — deploy.js
// Deploy wizard: pick a standard → compile it in-browser with solc →
// estimate gas → confirm → deploy → record the address.
// (This file used to be a STUB that only showed a toast — nothing was
// ever deployed, which is what "deploy gabisa" was.)
// ═══════════════════════════════════════════════════════════════

import { $, toast, confirmTx, escapeHtml } from './ui.js';
import { get, requireUnlock, addActivity, emit } from './state.js';
import { getNetworkById, getProvider, getGasPrice } from './network.js';
import { waitForReceipt } from './safetx.js';
import { compileContract } from './solc.js';
import { getStandard, extraFieldsHtml, buildDeployPlan } from './contracts.js';
import { saveDeployed } from './registry.js';

const { ethers } = globalThis;

export function bindDeployEvents() {
  const sel = $('#deployStandard');
  if (sel && !sel.dataset.bound) {
    sel.dataset.bound = '1';
    sel.addEventListener('change', () => { renderDeployExtra(); renderDeployPreview(); });
  }
  const btn = $('#btnDeploy');
  if (btn && !btn.dataset.bound) {
    btn.dataset.bound = '1';
    btn.addEventListener('click', doDeploy);
  }
  renderDeployExtra();
  renderDeployPreview();
}

// Extra (per-standard) fields — name/symbol live in index.html.
export function renderDeployExtra() {
  const extra = $('#deployExtra');
  if (!extra) return;
  extra.innerHTML = extraFieldsHtml($('#deployStandard')?.value);
}

// Card shown above the Deploy button.
export function renderDeployPreview() {
  const box = $('#deployPreview');
  if (!box) return;
  const std = getStandard($('#deployStandard')?.value);
  box.innerHTML = `<div class="deploy-preview-card">
      <span class="deploy-preview-icon">${std.icon}</span>
      <span class="deploy-preview-text">${escapeHtml(std.preview)}</span>
    </div>`;
}

function setDeployStatus(html, kind = '') {
  const el = $('#deployStatus');
  if (!el) return;
  el.className = 'deploy-status' + (kind ? ' ' + kind : '');
  el.innerHTML = html;
  el.classList.remove('hidden');
}

function explorerTxLink(net, hash) {
  if (!net?.explorer) return '';
  return `${String(net.explorer).replace(/\/$/, '')}/tx/${hash}`;
}

export async function doDeploy() {
  if (!get('unlocked')) { requireUnlock(); return; }
  const std = getStandard($('#deployStandard')?.value);
  const btn = $('#btnDeploy');

  let plan;
  try {
    plan = buildDeployPlan({
      standard: std.id,
      name: $('#deployName')?.value,
      symbol: $('#deploySymbol')?.value,
      supply: $('#deploySupply')?.value,
      decimals: $('#deployDecimals')?.value,
      baseUri: $('#deployBaseUri')?.value
    });
  } catch (e) {
    return toast(e.message, 'error');
  }

  const net = getNetworkById(get('networkId'));
  if (btn) { btn.disabled = true; btn.textContent = 'Compiling…'; }
  setDeployStatus(`Compiling ${std.contract} with solc… (first run downloads ~9 MB)`);

  try {
    const t0 = Date.now();
    const compiled = await compileContract(std.source, std.contract, {
      onStatus: (msg) => setDeployStatus(escapeHtml(msg))
    });
    const seconds = ((Date.now() - t0) / 1000).toFixed(1);
    const sizeKb = ((compiled.bytecode.length - 2) / 2 / 1024).toFixed(1);
    setDeployStatus(`Compiled ${std.contract} in ${seconds}s · bytecode ${sizeKb} KB`, 'ok');
    for (const w of compiled.warnings.slice(0, 3)) console.warn('[BearTool deploy] solc warning:', w);

    if (btn) btn.textContent = 'Estimating gas…';
    const provider = await getProvider(net.chainId);
    const signer = get('signer');
    if (!signer) { requireUnlock(); return; }
    const factory = new ethers.ContractFactory(compiled.abi, compiled.bytecode, signer);
    const deployTx = await factory.getDeployTransaction(...plan.args);

    let gasEstimate;
    try {
      gasEstimate = await provider.estimateGas({ ...deployTx, from: get('address') });
    } catch (e) {
      throw new Error('Gas estimation failed: ' + (e?.shortMessage || e?.message || String(e)));
    }
    const gasPrice = await getGasPrice(provider);
    const cost = gasEstimate * gasPrice;
    const costLabel = gasPrice > 0n
      ? `${ethers.formatEther(cost)} ${net.symbol} (${gasEstimate.toString()} gas @ ${ethers.formatUnits(gasPrice, 'gwei')} gwei)`
      : 'unknown';

    const ok = await confirmTx({
      title: net.type === 'mainnet' ? 'DEPLOY ON MAINNET!' : `Deploy ${std.contract} on ${net.name}?`,
      rows: [...plan.summary, { k: 'Network', v: net.name }, { k: 'Est. cost', v: costLabel }],
      confirmText: 'Deploy',
      danger: net.type === 'mainnet',
      requireType: net.type === 'mainnet' ? 'YA' : null
    });
    if (!ok) { setDeployStatus('Deploy cancelled.'); return; }

    if (btn) btn.textContent = 'Deploying…';
    const contract = await factory.deploy(...plan.args);
    const tx = contract.deploymentTransaction();
    addActivity({
      hash: tx?.hash, type: 'deploy', status: 'pending', ts: Date.now(),
      detail: `${std.contract} ${plan.name} (${plan.symbol})`
    });
    const { receipt, timedOut } = await waitForReceipt(tx);
    const address = await contract.getAddress();

    saveDeployed('token', address, {
      chainId: net.chainId, standard: std.id, name: plan.name, symbol: plan.symbol,
      deployer: get('address'), txHash: tx?.hash
    });

    if (timedOut && !receipt) {
      setDeployStatus(`TX ${escapeHtml(String(tx?.hash || '').slice(0, 12))}… sent but still unconfirmed. Contract address: <strong>${escapeHtml(address)}</strong>`, 'warn');
      toast('Deploy sent — still confirming', 'info');
      return;
    }
    const status = receipt?.status === 1 ? 'success' : 'failed';
    addActivity({
      hash: tx?.hash, type: 'deploy', status, ts: Date.now(),
      detail: `${std.contract} ${plan.name} (${plan.symbol}) → ${address}`
    });
    if (status !== 'success') {
      setDeployStatus('Deploy transaction reverted.', 'error');
      return toast('Deploy failed (tx reverted)', 'error');
    }

    const link = explorerTxLink(net, tx?.hash);
    setDeployStatus(`<strong>${escapeHtml(plan.name)} deployed</strong><br>
      <span class="mono">${escapeHtml(address)}</span><br>
      <span class="small">${escapeHtml(net.name)} · ${plan.summary.map(r => escapeHtml(r.v)).join(' · ')}</span>` +
      (link ? ` <a href="${escapeHtml(link)}" target="_blank" rel="noopener">View tx ↗</a>` : ''), 'ok');
    toast(`${plan.symbol} deployed! 🎉`, 'success');
    emit('refresh');
  } catch (e) {
    const msg = e?.message || String(e);
    setDeployStatus(escapeHtml(msg), 'error');
    toast(msg, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Deploy Contract'; }
  }
}
