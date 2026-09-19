// ═══════════════════════════════════════════════════════════════
// Bear Tool — safetx.js
// Transaction safety core: double-submit lock, error boundary,
// safe sendTransaction wrapper with button loading state.
// ═══════════════════════════════════════════════════════════════

import { toast, setBtnLoading, setBtnDots } from './ui.js';

const pending = new Set();

export function isTxPending(key) {
  return pending.has(key);
}

// ── timeouts ──
// Nothing in a wallet should spin forever. A black-holed RPC socket or a
// dropped/replaced transaction used to leave the button spinning with no
// error and no way out — the "send cuma muter-muter" report.
export const RPC_TIMEOUT_MS = 8000;
export const CONFIRM_TIMEOUT_MS = 120000;

export function withTimeout(promise, ms, label = 'operation') {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`${label} timed out after ${Math.round(ms / 1000)}s`);
        err.code = 'BEAR_TIMEOUT';
        reject(err);
      }, ms);
    })
  ]);
}

// Wait for a receipt, but never forever. Callers get an explicit "timedOut"
// signal so they can tell the user to track the hash instead of hanging.
export async function waitForReceipt(tx, { timeoutMs = CONFIRM_TIMEOUT_MS, label = 'confirmation' } = {}) {
  const hash = tx?.hash;
  try {
    const receipt = await withTimeout(tx.wait(), timeoutMs, label);
    return { receipt, hash, timedOut: false };
  } catch (e) {
    if (e?.code === 'BEAR_TIMEOUT') return { receipt: null, hash, timedOut: true };
    throw e;
  }
}

// double-submit guard: blocks re-entry while a tx with the same key runs
export async function safeSend(key, fn) {
  if (pending.has(key)) {
    toast('Transaction already in progress...', 'info');
    return null;
  }
  pending.add(key);
  try {
    return await fn();
  } finally {
    pending.delete(key);
  }
}

// error boundary: never let an unhandled rejection escape a feature action
export function withErrorBoundary(fn, context = 'operation') {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      console.error(`[BearTool] ${context} failed:`, e);
      toast(`${context} failed: ${e.message}`, 'error');
      return null;
    }
  };
}

// combined: lock + button loading (dots) + error boundary — the one to use for tx buttons
export async function runTx(key, btn, fn, { loadingLabel = 'Processing...', dots = true } = {}) {
  if (pending.has(key)) {
    toast('Transaction already in progress...', 'info');
    return null;
  }
  pending.add(key);
  if (btn) {
    if (dots) setBtnDots(btn, true, loadingLabel);
    else setBtnLoading(btn, true, loadingLabel);
  }
  try {
    return await fn();
  } catch (e) {
    console.error(`[BearTool] ${key} failed:`, e);
    toast(`${key} failed: ${e.message}`, 'error');
    return null;
  } finally {
    pending.delete(key);
    if (btn) setBtnLoading(btn, false);
  }
}