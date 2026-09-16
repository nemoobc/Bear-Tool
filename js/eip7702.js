// ═══════════════════════════════════════════════════════════════
// Bear Tool — eip7702.js
// EIP-7702 suite: delegate/revoke (real), batch/rescue/claim
// (honest stubs — need a deployed implementation contract).
// ChainId guard: default = active chain, 0 blocked on mainnet.
// ═══════════════════════════════════════════════════════════════

import { $, toast, confirmTx, escapeHtml } from './ui.js';
import { get, addActivity, requireUnlock, emit } from './state.js';
import { runTx } from './safetx.js';
import { getNetworkById, getProvider, getDelegation, EIP7702 } from './network.js';
import * as wallet from './wallet.js';

const { ethers } = globalThis;

export function bindEip7702Events() {
  $('#btnDelegate').addEventListener('click', () => doEip7702('delegate'));
  $('#btnRevoke').addEventListener('click', () => doEip7702('revoke'));
  $('#btnBatchAdd').addEventListener('click', addBatchItem);
  $('#btnBatchExecute').addEventListener('click', executeBatch);
  $('#btnRescue').addEventListener('click', doRescue);
  $('#btnClaim').addEventListener('click', doClaim);
}

export async function loadEip7702() {
  if (!get('unlocked')) return;
  const status = $('#delegateStatus');
  const text = $('#delegateStatusText');
  try {
    const net = getNetworkById(get('networkId'));
    const provider = await getProvider(net.chainId);
    const delegate = await getDelegation(provider, get('address'));
    if (delegate) {
      status.className = 'delegate-status delegated';
      text.innerHTML = `Delegated to <span class="addr">${escapeHtml(delegate)}</span>`;
    } else {
      status.className = 'delegate-status eoa';
      text.textContent = 'Plain EOA (no delegation)';
    }
  } catch {
    text.textContent = 'Cannot check (RPC error)';
  }
}

export async function doEip7702(action) {
  if (!get('unlocked')) { requireUnlock(); return; }
  const net = getNetworkById(get('networkId'));
  const impl = action === 'delegate' ? $('#delegateAddr').value.trim() : EIP7702.ZERO_ADDRESS;

  // chainId guard: default = active chain; 0 only via explicit "any chain" choice
  let chainId;
  if (action === 'delegate') {
    const anyChain = $('#delegateAnyChain')?.checked || false;
    const inputVal = Number($('#delegateChainId').value);
    chainId = anyChain ? 0 : (inputVal > 0 ? inputVal : net.chainId);
    if (chainId === 0) {
      if (net.type === 'mainnet') {
        return toast('chainId 0 (all chains) is blocked on mainnet — replay risk', 'error');
      }
      const ok = await confirmTx({
        title: 'ALL CHAINS AUTHORIZATION!',
        rows: [
          { k: 'Chain ID', v: '0 (ALL CHAINS — replay risk!)' },
          { k: 'Network', v: net.name },
          { k: 'Warning', v: 'This signature can be replayed on ANY chain. Only proceed on testnet.' }
        ],
        confirmText: 'I understand',
        danger: true, requireType: 'SAYA PAHAM RISIKO REPLAY'
      });
      if (!ok) return;
    }
  } else {
    chainId = net.chainId;
  }

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

  await runTx('eip7702-' + action, action === 'delegate' ? $('#btnDelegate') : $('#btnRevoke'), async () => {
    const provider = get('provider');
    const signer = get('signer').connect(provider);
    const nonce = await provider.getTransactionCount(get('address'));
    // EIP-7702: self-sponsored → auth nonce = nonce + 1
    const authNonce = nonce + 1;
    const authorization = await signer.signAuthorization({
      chainId, address: impl, nonce: authNonce
    });
    const feeData = await provider.getFeeData();
    const tx = await signer.sendTransaction({
      to: get('address'),
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
    emit('refresh');
  });
}

// ── batch call ──
export function addBatchItem() {
  const batch = get('batch');
  batch.push({ target: '', data: '', value: '0' });
  renderBatch();
}

export function renderBatch() {
  const list = $('#batchList');
  const batch = get('batch');
  if (!batch.length) {
    list.innerHTML = '<p class="small text-center">No actions. Add one to batch.</p>';
    return;
  }
  list.innerHTML = batch.map((b, i) => `
    <div class="batch-item">
      <span class="idx">${i + 1}</span>
      <input class="input" data-batch="target" data-i="${i}" placeholder="Target contract 0x..." value="${escapeHtml(b.target)}">
      <input class="input" data-batch="data" data-i="${i}" placeholder="Calldata 0x..." value="${escapeHtml(b.data)}">
      <button class="btn btn-danger" data-del="${i}">✕</button>
    </div>`).join('');
  const $all = (sel) => document.querySelectorAll(sel);
  $all('[data-batch]').forEach(el => el.addEventListener('input', (e) => {
    const batch2 = get('batch');
    batch2[Number(e.target.dataset.i)][e.target.dataset.batch] = e.target.value;
  }));
  $all('[data-del]').forEach(el => el.addEventListener('click', () => {
    const batch2 = get('batch');
    batch2.splice(Number(el.dataset.del), 1);
    renderBatch();
  }));
}

export async function executeBatch() {
  if (!get('unlocked')) { requireUnlock(); return; }
  const valid = get('batch').filter(b => b.target && b.data);
  if (!valid.length) return toast('Add at least one valid action', 'error');
  const net = getNetworkById(get('networkId'));
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

// ── rescue (honest stub — needs deployed rescue contract) ──
export async function doRescue() {
  if (!get('unlocked')) { requireUnlock(); return; }
  const target = $('#rescueTarget').value.trim();
  const safe = $('#rescueSafe').value.trim();
  if (!wallet.isValidAddress(target) || !wallet.isValidAddress(safe)) return toast('Invalid addresses', 'error');
  const net = getNetworkById(get('networkId'));
  if (net.type === 'mainnet') {
    const ok = await confirmTx({
      title: 'RESCUE ON MAINNET!',
      rows: [{ k: 'Locked wallet', v: target }, { k: 'SAFE destination', v: safe }, { k: 'Network', v: net.name }],
      confirmText: 'Rescue', danger: true, requireType: 'YA'
    });
    if (!ok) return;
  }
  addActivity({ hash: 'rescue-' + Date.now(), type: 'eip7702-rescue', status: 'info', ts: Date.now(), detail: `Rescue attempt: ${target} → ${safe}` });
  toast('Rescue requires a deployed rescue contract + sponsored gas. See docs/PROMPT.md for the full flow.', 'info');
}

// ── claim (honest stub — needs 7702 implementation) ──
export async function doClaim() {
  if (!get('unlocked')) { requireUnlock(); return; }
  const token = $('#claimToken').value.trim();
  const safe = $('#claimSafe').value.trim();
  if (!wallet.isValidAddress(token) || !wallet.isValidAddress(safe)) return toast('Invalid addresses', 'error');
  const net = getNetworkById(get('networkId'));
  if (net.type === 'mainnet') {
    const ok = await confirmTx({
      title: 'CLAIM ON MAINNET!',
      rows: [{ k: 'Token', v: token }, { k: 'Forward to', v: safe }, { k: 'Network', v: net.name }],
      confirmText: 'Claim', danger: true, requireType: 'YA'
    });
    if (!ok) return;
  }
  addActivity({ hash: 'claim-' + Date.now(), type: 'claim', status: 'info', ts: Date.now(), detail: `Claim attempt: ${token} → ${safe}` });
  toast('Claim + forward requires a 7702 implementation. See docs/PROMPT.md.', 'info');
}