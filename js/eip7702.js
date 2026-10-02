// ═══════════════════════════════════════════════════════════════
// Bear Tool — eip7702.js
// EIP-7702 suite: delegate/revoke. Batch/rescue/claim live in
// eip7702-tools.js — exactly one binding per button (M4 removed the stubs).
// ChainId guard: default = active chain, 0 blocked on mainnet.
// ═══════════════════════════════════════════════════════════════

const BROADCAST_TIMEOUT_MS = 15000; // same bound send.js uses

import { $, toast, confirmTx, escapeHtml } from './ui.js';
import { get, addActivity, requireUnlock, emit } from './state.js';
import { runTx, waitForReceipt, withTimeout } from './safetx.js';
import { getNetworkById, getProvider, getDelegation, EIP7702 } from './network.js';
import * as wallet from './wallet.js';
import { renderDeployedRegistry, revokeDelegation } from './eip7702-tools.js';

const { ethers } = globalThis;

export function bindEip7702Events() {
  $('#btnDelegate').addEventListener('click', () => doEip7702('delegate'));
  // Revoke goes through revokeDelegation(): it honours #revokeTarget/#revokeKey
  // so you can revoke an address that is NOT the unlocked wallet. doEip7702's
  // revoke branch always acted on get('address') and ignored those fields, so
  // it revoked the wrong account while reporting success.
  $('#btnRevoke').addEventListener('click', () => revokeDelegation());
  // M4: #btnBatchAdd/#btnBatchExecute/#btnRescue/#btnClaim bind ONLY in
  // eip7702-tools.js. Binding them here too fired the stub listener first:
  // a fake "Rescue requires…" toast plus a bogus activity row in front of
  // the real flow (last-writer-wins hid it on batch, not on rescue).
}

export async function loadEip7702() {
  if (!get('unlocked')) return;
  renderDeployedRegistry();
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
        danger: true
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
      confirmText: 'Delegate', danger: true
    });
    if (!ok) return;
  }

  await runTx('eip7702-' + action, action === 'delegate' ? $('#btnDelegate') : $('#btnRevoke'), async () => {
    const provider = get('provider');
    const signer = get('signer').connect(provider);
    const nonce = await provider.getTransactionCount(get('address'));
    // EIP-7702: self-sponsored → auth nonce = nonce + 1
    const authNonce = nonce + 1;
    const authorization = signer.authorizeSync({
      chainId, address: impl, nonce: authNonce
    });
    const feeData = await provider.getFeeData();
    // withTimeout bounds the WAIT only — it cannot change the authorization, the
    // nonce, the implementation address or the fee fields. Without it a node
    // that never answers leaves the button spinning and the flow dead.
    const tx = await withTimeout(signer.sendTransaction({
      // MUST be explicit — without it ethers v6 infers an EIP-1559 type-2 tx
      // from the fee fields and silently drops the authorizationList, so the
      // delegation never takes effect while the tx still reports success.
      type: 4,
      to: get('address'),
      authorizationList: [authorization],
      maxFeePerGas: feeData.maxFeePerGas,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas
    }), BROADCAST_TIMEOUT_MS, 'delegate broadcast');
    toast(action === 'delegate' ? 'Delegation tx sent! ⚡' : 'Revoke tx sent! ⚡', 'info');
    addActivity({ hash: tx.hash, type: 'eip7702-' + action, status: 'pending', ts: Date.now(), detail: impl });
    const { receipt, timedOut } = await waitForReceipt(tx);
    if (timedOut) {
      // Sent but not confirmed in time. The pending activity entry is left as
      // "pending" (honest) and the button is released — never spin forever.
      toast(`Tx ${String(tx.hash).slice(0, 10)}… sent but still unconfirmed. Track it on the explorer.`, 'info');
      return;
    }
    addActivity({ hash: tx.hash, type: 'eip7702-' + action, status: receipt.status === 1 ? 'success' : 'failed', ts: Date.now(), detail: impl });
    toast(receipt.status === 1 ? 'Done! 🎉' : 'Failed!', receipt.status === 1 ? 'success' : 'error');
    loadEip7702();
    emit('refresh');
  });
}
