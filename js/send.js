// ═══════════════════════════════════════════════════════════════
// Bear Tool — send.js
// Send view: token select, MAX, live preview with gas estimate,
// doSend with address-poisoning + dangerous-destination warnings.
// ═══════════════════════════════════════════════════════════════

import { $, toast, confirmTx, fmtAmount, escapeHtml } from './ui.js';
import { get, addActivity, requireUnlock, emit } from './state.js';
import { runTx, waitForReceipt, withTimeout, RPC_TIMEOUT_MS } from './safetx.js';
import { getNetworkById, getGasPrice, ERC20_ABI, POPULAR_TOKENS } from './network.js';
import * as wallet from './wallet.js';

const { ethers } = globalThis;
const BROADCAST_TIMEOUT_MS = 15000; // 15s for broadcast

export function bindSendEvents() {
  $('#btnSend').addEventListener('click', doSend);
  // percentage buttons
  document.querySelectorAll('.pct-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const pct = parseInt(btn.dataset.pct);
      const sel = $('#sendToken');
      const t = get('tokens').find(x => (x.address || 'native') === sel.value);
      if (!t) return;
      const bal = parseFloat(fmtAmount(t.balance, t.decimals));
      $('#sendAmount').value = (bal * pct / 100).toFixed(6);
      document.querySelectorAll('.pct-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      updateSendPreview();
    });
  });
  // gas speed buttons
  document.querySelectorAll('.gas-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.gas-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      updateSendPreview();
    });
  });
  $('#sendAmount').addEventListener('input', updateSendPreview);
  $('#sendTo').addEventListener('input', updateSendPreview);
  $('#sendToken')?.addEventListener('change', () => { updateSendTokenBalance(); updateSendPreview(); });
  // The paste button was in the markup from the start but never wired —
  // tapping it did nothing at all.
  $('#btnSendPaste')?.addEventListener('click', async () => {
    try {
      const text = (await navigator.clipboard.readText() || '').trim();
      if (!text) return toast('Clipboard is empty', 'info');
      $('#sendTo').value = text;
      updateSendPreview();
    } catch {
      // Clipboard read needs permission + a secure context (works on the
      // https Pages deploy). Fall back to a manual paste.
      $('#sendTo').focus();
      toast('Clipboard blocked — press and hold to paste', 'info');
    }
  });
}

// balance of the currently selected token, shown next to the dropdown
function updateSendTokenBalance() {
  const el = $('#sendTokenBalance');
  if (!el) return;
  const sel = $('#sendToken')?.value;
  const t = (get('tokens') || []).find(x => (x.address || 'native') === sel);
  el.textContent = t ? fmtAmount(t.balance, t.decimals) : '';
}

export function loadSendTokens() {
  const sel = $('#sendToken');
  if (!sel) return;
  sel.innerHTML = get('tokens').map(t =>
    `<option value="${escapeHtml(t.address || 'native')}">${escapeHtml(t.symbol)} (${escapeHtml(fmtAmount(t.balance, t.decimals))})</option>`
  ).join('');
  updateSendTokenBalance();
}

// live preview + gas estimate (best effort)
export async function updateSendPreview() {
  const to = $('#sendTo')?.value?.trim() || '';
  const amt = $('#sendAmount')?.value || '';
  const preview = $('#sendPreview');
  if (!preview) return;
  const gasValue = $('#gasEstValue'), gasUsd = $('#gasEstUsd');
  if (!to || !amt || !wallet.isValidAddress(to)) {
    preview.classList.add('hidden');
    if (gasValue) gasValue.textContent = '—';
    if (gasUsd) gasUsd.textContent = '';
    if (to && amt && !wallet.isValidAddress(to)) {
      preview.innerHTML = '⚠️ Invalid address';
      preview.classList.remove('hidden');
    }
    return;
  }
  const tokenSel = $('#sendToken').value;
  let gasLine = '';
  try {
    const provider = get('provider');
    if (provider) {
      const gasPrice = await getGasPrice(provider);
      const gasLimit = tokenSel === 'native' ? 21000n : 65000n;
      const gasEth = ethers.formatEther(gasLimit * gasPrice);
      const nativeUsd = get('tokens').find(x => !x.address)?.usd || 0;
      const usdText = nativeUsd ? ` ($${(parseFloat(gasEth) * nativeUsd).toFixed(2)})` : '';
      const net = getNetworkById(get('networkId'));
      gasLine = `<div class="small">Gas: ~${escapeHtml(gasEth)} ${escapeHtml(net?.symbol || '')}${escapeHtml(usdText)}</div>`;
      // The "Est. gas" row exists in the markup but was never written to, so
      // it sat on "—" forever and made the Send screen look stuck.
      if (gasValue) gasValue.textContent = `${gasEth} ${net?.symbol || ''}`.trim();
      if (gasUsd) gasUsd.textContent = nativeUsd ? `$${(parseFloat(gasEth) * nativeUsd).toFixed(2)}` : '';
    }
  } catch { /* gas preview is optional */ }
  preview.innerHTML = `Sending <b>${escapeHtml(amt)}</b> to <span class="mono">${escapeHtml(wallet.shortAddress(to))}</span>${gasLine}`;
  preview.classList.remove('hidden');
}

// ── destination safety checks ──
// returns false if the user cancelled, true otherwise
async function warnSuspiciousDestination(to, net) {
  const activity = get('activity') || [];
  const similar = [];

  // 1. address poisoning: same prefix+suffix as a previous recipient
  for (const prev of activity) {
    if (prev.type !== 'send') continue;
    const prevTo = prev.to;
    if (prevTo && wallet.isSuspiciousSimilar(prevTo, to)) {
      similar.push(prevTo);
    } else if (!prevTo && prev.detail) {
      // legacy entries store only the short form "0x1234…5678"
      const m = String(prev.detail).match(/(0x[0-9a-fA-F]{4})…([0-9a-fA-F]{4})/);
      if (m && to.toLowerCase().startsWith(m[1].toLowerCase()) && to.toLowerCase().endsWith(m[2].toLowerCase())) {
        similar.push(prev.detail);
      }
    }
  }
  if (similar.length) {
    const ok = await confirmTx({
      title: '⚠️ ADDRESS POISONING WARNING!',
      rows: [
        { k: 'Warning', v: 'This address looks similar to a previous recipient. Common scam — double-check every character.' },
        { k: 'Target', v: wallet.shortAddress(to) },
        { k: 'Similar to', v: similar[0] }
      ],
      confirmText: 'I understand the risk',
      danger: true, requireType: 'UNDERSTAND'
    });
    if (!ok) return false;
  }

  // 2. sending to a known token contract = funds burned
  const tokenContract = (POPULAR_TOKENS[net.chainId] || [])
    .find(t => t.address.toLowerCase() === to.toLowerCase());
  if (tokenContract) {
    const ok = await confirmTx({
      title: '⚠️ TOKEN CONTRACT DESTINATION!',
      rows: [
        { k: 'Warning', v: `This address is the ${tokenContract.symbol} token contract. Sending tokens here burns them.` },
        { k: 'Target', v: wallet.shortAddress(to) }
      ],
      confirmText: 'I understand the risk',
      danger: true, requireType: 'BURNS'
    });
    if (!ok) return false;
  }

  // 3. anti-rescue/claim: destination was a locked-wallet rescue target or claim token
  for (const prev of activity) {
    if (prev.type !== 'eip7702-rescue' && prev.type !== 'claim') continue;
    const m = String(prev.detail || '').match(/0x[a-fA-F0-9]{40}/);
    if (m && m[0].toLowerCase() === to.toLowerCase()) {
      const ok = await confirmTx({
        title: '⚠️ LOCKED / RESCUE ADDRESS!',
        rows: [
          { k: 'Warning', v: 'This address was previously used as a rescue target or claim token. Funds sent here may be unrecoverable.' },
          { k: 'Target', v: wallet.shortAddress(to) }
        ],
        confirmText: 'I understand the risk',
        danger: true, requireType: 'RISIKO'
      });
      if (!ok) return false;
    }
  }

  return true;
}

export async function doSend() {
  if (!get('unlocked')) { requireUnlock(); return; }
  const to = $('#sendTo').value.trim();
  const amt = $('#sendAmount').value;
  const tokenSel = $('#sendToken').value;
  const gasBtn = document.querySelector('.gas-btn.active');
  const gasSpeed = gasBtn ? gasBtn.dataset.speed : 'normal';
  if (!wallet.isValidAddress(to)) return toast('Invalid destination address', 'error');
  if (!amt || parseFloat(amt) <= 0) return toast('Enter a valid amount', 'error');

  const net = getNetworkById(get('networkId'));
  const t = get('tokens').find(x => (x.address || 'native') === tokenSel);
  if (!t) return toast('Token not found', 'error');

  // safety warnings before anything is signed
  const safe = await warnSuspiciousDestination(to, net);
  if (!safe) return;

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

  // sign confirmation — show full tx details before signing
  const signOk = await confirmTx({
    title: '✍️ SIGN TRANSACTION',
    rows: [
      { k: 'Network', v: net.name },
      { k: 'Token', v: t.symbol },
      { k: 'Amount', v: `${amt} ${t.symbol}` },
      { k: 'To', v: wallet.shortAddress(to) },
      { k: 'Gas speed', v: gasSpeed }
    ],
    confirmText: 'Sign & Send',
    cancelText: 'Cancel Sign',
    danger: false
  });
  if (!signOk) return toast('Transaction cancelled', 'info');

  await runTx('send', $('#btnSend'), async () => {
    const provider = get('provider');
    const signer = get('signer');
    if (!provider || !signer) return toast('Wallet not ready', 'error');
    const feeData = await provider.getFeeData();
    const gasPrice = gasSpeed === 'slow' ? feeData.gasPrice * 90n / 100n
      : gasSpeed === 'fast' ? feeData.gasPrice * 120n / 100n
      : feeData.gasPrice;

    let tx;
    if (tokenSel === 'native') {
      tx = await withTimeout(signer.sendTransaction({
        to, value: ethers.parseEther(amt),
        maxFeePerGas: feeData.maxFeePerGas || gasPrice,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas || gasPrice
      }), BROADCAST_TIMEOUT_MS, 'broadcast');
    } else {
      const c = new ethers.Contract(t.address, ERC20_ABI, signer);
      tx = await withTimeout(c.transfer(to, ethers.parseUnits(amt, t.decimals)), BROADCAST_TIMEOUT_MS, 'broadcast');
    }
    // A broadcast that times out must NOT leave the button spinning forever:
    // the hash may still land — track it on the explorer. Button released,
    // pending activity left "pending" (honest), never a false "confirmed".
    if (!tx?.hash) {
      toast('Broadcast unconfirmed — check the explorer or try again.', 'info');
      return;
    }
    toast('Transaction sent! ⏳', 'info');
    addActivity({ hash: tx.hash, type: 'send', status: 'pending', ts: Date.now(), detail: `${amt} ${t.symbol} → ${wallet.shortAddress(to)}`, to });
    const { receipt, timedOut } = await waitForReceipt(tx);
    if (timedOut) {
      // Sent but not confirmed in time. The pending activity entry is left as
      // "pending" (honest) and the button is released — never spin forever.
      toast(`Tx ${String(tx.hash).slice(0, 10)}… sent but still unconfirmed. Track it on the explorer.`, 'info');
      return;
    }
    addActivity({ hash: tx.hash, type: 'send', status: receipt.status === 1 ? 'success' : 'failed', ts: Date.now(), detail: `${amt} ${t.symbol} → ${wallet.shortAddress(to)}`, to });
    toast(receipt.status === 1 ? 'Transaction confirmed! 🎉' : 'Transaction failed!', receipt.status === 1 ? 'success' : 'error');
    emit('refresh');
  });
}