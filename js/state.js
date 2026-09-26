// ═══════════════════════════════════════════════════════════════
// Bear Tool — state.js
// Centralized singleton state + pub/sub. Leaf module (no imports).
// Every feature module reads/writes state here — no circular deps.
// ═══════════════════════════════════════════════════════════════

const state = {
  unlocked: false,
  signer: null,
  address: null,
  networkId: 'ethereum',
  provider: null,
  tokens: [],          // [{address, symbol, decimals, balance, usd}]
  activity: [],        // [{hash, type, status, ts, detail, ...}]
  swapQuote: null,
  bridgeQuote: null,
  batch: [],           // [{target, data, value}]
  approvals: [],
  settings: { currency: 'usd', lang: 'en', autoLock: 5, rpc: '', testnet: true }
};

const listeners = new Map();

// get('tokens') → value; get() → whole state object (reference)
export function get(key) {
  return key ? state[key] : state;
}

// set + notify subscribers
export function set(key, value) {
  state[key] = value;
  emit(key, value);
}

// merge partial into an object key (settings etc.)
export function update(key, partial) {
  const cur = state[key];
  if (cur && typeof cur === 'object' && !Array.isArray(cur)) {
    set(key, { ...cur, ...partial });
  } else {
    set(key, partial);
  }
}

// pub/sub
export function on(key, fn) {
  if (!listeners.has(key)) listeners.set(key, []);
  listeners.get(key).push(fn);
}

export function off(key, fn) {
  const arr = listeners.get(key);
  if (arr) listeners.set(key, arr.filter(f => f !== fn));
}

// notify listeners without changing state (e.g. 'refresh' after a tx)
export function emit(key, value) {
  (listeners.get(key) || []).forEach(fn => {
    try { fn(value, key); } catch (e) { console.error('[BearTool] listener error:', e); }
  });
}

// ── unlock handler (registered by app.js at boot) ──
let unlockHandler = null;
export function setUnlockHandler(fn) { unlockHandler = fn; }
export function requireUnlock() {
  if (unlockHandler) unlockHandler();
  return false;
}

// ── activity persistence (localStorage, capped at 100) ──
// A transaction is recorded twice by design: once as pending when it is sent,
// once with its final status when the receipt lands. Eight modules do this, and
// addActivity used to append both, so the history permanently disagreed with
// itself - a completed transfer showed as "pending" AND "success" for the same
// hash, and the entry count was inflated. Measured on a real wallet: 5 rows,
// 3 unique hashes, one of them stuck pending after the transfer had succeeded.
//
// So a record with a known hash is UPDATED, not duplicated. An update carries no
// detail of its own worth keeping: the pending row is the one that knows what
// was sent, and a later row that repeated the text only added a second chance
// for the two to disagree.
const TERMINAL = new Set(['success', 'failed', 'reverted']);

export function addActivity(item) {
  if (item && item.hash) {
    const at = state.activity.findIndex((a) => a.hash === item.hash);
    if (at !== -1) {
      const prev = state.activity[at];
      // Keep the original timestamp: it is when the user pressed send, which is
      // what a history is for. Overwriting it with the receipt time would make
      // every transaction look like it happened the moment it confirmed.
      const merged = {
        ...prev,
        ...item,
        ts: prev.ts || item.ts,
        // Only replace detail when the caller actually supplied one.
        detail: item.detail || prev.detail,
      };
      // A pending row that turns out to be final moves back to the top, which is
      // where the newest thing belongs.
      state.activity.splice(at, 1);
      state.activity.unshift(merged);
      persistActivity();
      return merged;
    }
  }
  state.activity.unshift(item);
  persistActivity();
  return item;
}

function persistActivity() {
  try {
    localStorage.setItem('bear.activity', JSON.stringify(state.activity.slice(0, 100)));
  } catch { /* storage full — keep in-memory only */ }
}

/** Drop a hash from the history - used when a send is replaced or retried. */
export function removeActivity(hash) {
  state.activity = state.activity.filter((a) => a.hash !== hash);
  persistActivity();
}

/** True when this hash is already recorded, whatever its status. */
export function hasActivity(hash) {
  return state.activity.some((a) => a.hash === hash);
}

export const ACTIVITY_TERMINAL = TERMINAL;

export function loadActivity() {
  try { state.activity = JSON.parse(localStorage.getItem('bear.activity') || '[]'); }
  catch { state.activity = []; }
  if (!Array.isArray(state.activity)) { state.activity = []; return; }

  // Heal history written by the old append-always addActivity. Anyone who has
  // sent a transaction has rows that disagree with each other, and leaving them
  // would mean the fix only protects people who have not used the app yet.
  // One row per hash, keeping the most advanced status — a receipt that says
  // 'success' beats the 'pending' written a second earlier for the same hash.
  const rank = { pending: 0 };
  const best = new Map();
  for (const a of state.activity) {
    if (!a || typeof a !== 'object') continue;
    if (!a.hash) { best.set('nohash:' + Math.random(), a); continue; }
    const prev = best.get(a.hash);
    if (!prev) { best.set(a.hash, a); continue; }
    const better = (rank[a.status] ?? 2) >= (rank[prev.status] ?? 2) ? a : prev;
    // Oldest timestamp, not the first one seen. The array is newest-first, so
    // the first row for a hash is the receipt and the later row is the send.
    // addActivity already keeps the send time; healing that used a different
    // rule would make a row change its date every time the app was reopened.
    // All three, not just prev and better: the oldest row can be `a` itself,
    // which is the normal case — a pending row written first, read back after
    // the success row was unshifted in front of it.
    const oldest = [prev.ts, better.ts, a.ts].filter((n) => typeof n === 'number');
    best.set(a.hash, { ...prev, ...better,
      ts: oldest.length ? Math.min(...oldest) : (better.ts ?? prev.ts),
      detail: better.detail || prev.detail });
  }
  const healed = [...best.values()].sort((x, y) => (y.ts || 0) - (x.ts || 0));
  const changed = healed.length !== state.activity.length;
  state.activity = healed;
  if (changed) {
    // Only rewrite storage when it actually changed, so a normal boot does not
    // churn localStorage on every load.
    persistActivity();
  }
}
/**
 * Settle history rows that were still 'pending' when the app last closed.
 *
 * A pending row with no terminal record is a transaction whose receipt handler
 * never ran — the tab was closed, the reload happened, the node was briefly
 * unreachable. Left alone it reads as "still sending" forever, which is the one
 * thing a history must never do: the user cannot tell a live transfer from a
 * dead one. A real wallet that shows a month-old transfer as in-flight is worse
 * than one that admits it lost track.
 *
 * The provider is injected rather than imported: this file is a leaf module by
 * design, and a node call here would make it depend on the network layer.
 *
 * @param {object} provider an ethers provider, or null to skip
 * @param {object} [opts]
 * @param {number} [opts.concurrency] how many receipts to ask for at once
 * @returns {Promise<{checked:number, settled:number, failed:number, unreachable:number}>}
 */
export async function reconcileActivity(provider, { concurrency = 4 } = {}) {
  const summary = { checked: 0, settled: 0, failed: 0, unreachable: 0 };
  if (!provider) return summary;

  const stuck = state.activity.filter((a) => a && a.hash && a.status === 'pending');
  summary.checked = stuck.length;
  if (!stuck.length) return summary;

  for (let i = 0; i < stuck.length; i += concurrency) {
    const batch = stuck.slice(i, i + concurrency);
    await Promise.all(batch.map(async (row) => {
      try {
        const receipt = await provider.getTransactionReceipt(row.hash);
        if (!receipt) {
          // No receipt. That is two different situations and they must not be
          // reported the same way:
          //   - the transaction EXISTS and has no receipt yet -> still in flight
          //   - the chain has never heard of it at all -> dropped. Replaced by
          //     another nonce, dropped from the mempool, or sent to a chain this
          //     history is not on. Leaving that as 'pending' tells the user
          //     money is moving when nothing is, which is the one answer a
          //     history must never give.
          const known = await provider.getTransaction(row.hash).catch(() => null);
          if (known) return;                        // genuinely still in flight
          addActivity({ hash: row.hash, status: 'failed', ts: row.ts,
            detail: (row.detail || '') + ' · not found on this network' });
          summary.failed++;
          return;
        }
        // A transaction that was mined but reverted is 'failed', not 'success'.
        const status = receipt.status === 1 ? 'success' : 'failed';
        addActivity({ hash: row.hash, status, ts: row.ts, detail: row.detail });
        if (status === 'success') summary.settled++; else summary.failed++;
      } catch {
        // The node could not tell us. Saying 'failed' would be a guess, and a
        // wrong guess about someone's money is worse than an honest 'unknown'.
        summary.unreachable++;
      }
    }));
  }
  return summary;
}
