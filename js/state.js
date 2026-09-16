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
  settings: { currency: 'usd', lang: 'en', autoLock: 5, rpc: '' }
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
export function addActivity(item) {
  state.activity.unshift(item);
  try {
    localStorage.setItem('bear.activity', JSON.stringify(state.activity.slice(0, 100)));
  } catch { /* storage full — keep in-memory only */ }
}

export function loadActivity() {
  try { state.activity = JSON.parse(localStorage.getItem('bear.activity') || '[]'); }
  catch { state.activity = []; }
}