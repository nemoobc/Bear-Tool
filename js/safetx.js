// ═══════════════════════════════════════════════════════════════
// Bear Tool — safetx.js
// Transaction safety core: double-submit lock, error boundary,
// safe sendTransaction wrapper with button loading state.
// ═══════════════════════════════════════════════════════════════

import { toast, setBtnLoading, setBtnDots } from './ui.js';
import { explainError } from './errors.js';

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
  const p = Promise.resolve(promise).finally(() => clearTimeout(timer));
  // The race LOSER must not surface later as an unhandled rejection. When the
  // timer wins, this promise keeps running and can still reject — CI
  // 37027145392 bsc's dump carried the same receipt-403 twice: once inside
  // waitForReceipt's retry (handled, correct) and once from this orphan
  // (window.onunhandledrejection). Harmless to the flow, poison to any
  // zero-noise reading of a dump. The race itself is unchanged: p rejecting
  // first still rejects it.
  p.catch(() => {});
  return Promise.race([
    p,
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
//
// ethers v6 THROWS on a reverted transaction (CALL_EXCEPTION, receipt attached)
// rather than returning it with status 0. Letting that escape did two harmful
// things: every `receipt.status === 1 ? 'success' : 'failed'` branch in
// send/swap/bridge/eip7702 became unreachable dead code, and the hash was thrown
// away — a revert left the user with nothing to look up and a "pending" row in
// their history that nothing ever corrected. A revert is an ON-CHAIN OUTCOME,
// not a failure to broadcast, so it is reported as one.
export async function waitForReceipt(tx, { timeoutMs = CONFIRM_TIMEOUT_MS, label = 'confirmation', retryMs = 2000 } = {}) {
  const hash = tx?.hash;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { receipt: null, hash, timedOut: true };
    try {
      const receipt = await withTimeout(tx.wait(), remaining, label);
      return { receipt, hash, timedOut: false, reverted: receipt?.status === 0 };
    } catch (e) {
      if (e?.code === 'BEAR_TIMEOUT') return { receipt: null, hash, timedOut: true };
      // Reverted on chain: broadcast happened, the receipt exists, and the user
      // needs its hash. `timedOut:false` because it did not time out.
      if (e?.code === 'CALL_EXCEPTION' && e.receipt) {
        return { receipt: e.receipt, hash: hash || e.transactionHash, timedOut: false, reverted: true };
      }
      // Replaced (speed-up, drop-and-replace, underpriced retry) also arrives as
      // an error. Surface both hashes — the dropped one and the one that took its
      // place — so the history can point at the truth.
      if (e?.code === 'TRANSACTION_REPLACED') {
        return {
          receipt: null, hash, timedOut: false, reverted: false, replaced: true,
          replacement: e.replacement?.hash || null,
        };
      }
      // Transient receipt-poll failure: the broadcast is DONE and the hash is
      // real, so keep polling until the deadline instead of dying. ethers
      // rejects the WHOLE wait() when one getTransactionReceipt call errors,
      // and CI 36997713895 showed what rethrowing costs: four mainnets sent
      // fine (receipt status=1 on the local fork) while anvil forwarded the
      // app's receipt query to an upstream that answered 403 "Archive requests
      // require a personal token" — one hiccup, and every row was stranded as
      // "pending" forever with the confirmation sitting right there on chain.
      // A node error is not an answer (same policy as the fork tests' backoff
      // 2000). Only the deadline ends the wait — as an honest timedOut, with
      // the hash preserved for the explorer.
      if (deadline - Date.now() <= retryMs) return { receipt: null, hash, timedOut: true };
      await new Promise((r) => setTimeout(r, retryMs));
    }
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
      toast(explainError(e, context), 'error');
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
    toast(explainError(e, key), 'error');
    return null;
  } finally {
    pending.delete(key);
    if (btn) setBtnLoading(btn, false);
  }
}