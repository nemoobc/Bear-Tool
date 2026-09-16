// ═══════════════════════════════════════════════════════════════
// Bear Tool — safetx.js
// Transaction safety core: double-submit lock, error boundary,
// safe sendTransaction wrapper with button loading state.
// ═══════════════════════════════════════════════════════════════

import { toast, setBtnLoading } from './ui.js';

const pending = new Set();

export function isTxPending(key) {
  return pending.has(key);
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

// combined: lock + button loading + error boundary — the one to use for tx buttons
export async function runTx(key, btn, fn, { loadingLabel = 'Processing...' } = {}) {
  if (pending.has(key)) {
    toast('Transaction already in progress...', 'info');
    return null;
  }
  pending.add(key);
  if (btn) setBtnLoading(btn, true, loadingLabel);
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