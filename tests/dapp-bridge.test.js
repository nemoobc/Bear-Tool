// ═══════════════════════════════════════════════════════════════
// Bear Tool — tests/dapp-bridge.test.js
// The injected provider. These tests are about refusals, because that is what
// a security boundary is made of.
// ═══════════════════════════════════════════════════════════════
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// The session store touches localStorage; give it one.
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
};
globalThis.window = globalThis;

const { createProvider } = await import('../js/dapp-bridge.js');
const { addSite, clearSites, hasPermission } = await import('../js/dapp-sessions.js');

const ADDR = '0x' + 'ab'.repeat(20);
const ORIGIN = 'http://localhost:8081';

function build({ unlocked = true, consent = true, permission = true, calls = [] } = {}) {
  const p = createProvider({
    origin: ORIGIN,
    getAddress: () => ADDR,
    isUnlocked: () => unlocked,
    getChainId: () => 1,
    onRequest: async (req) => {
      calls.push(req);
      if (req.kind === 'consent') return consent;
      if (req.kind === 'permission') return permission;
      return '0xresult';
    },
  });
  return { p, calls };
}

beforeEach(() => { mem.clear(); clearSites(); });

// ── it must not lie about who it is ──────────────────────────────────────
test('the provider does not impersonate another wallet', () => {
  const { p } = build();
  assert.equal(p.isBearTool, true);
  assert.equal(p.isMetaMask, false, 'claiming to be MetaMask would make pages branch on a lie');
  assert.equal(p.isCoinbaseWallet, false);
  assert.equal(p.isRabby, false);
});

// ── the allow-list is not negotiable ─────────────────────────────────────
test('an unlisted method is refused without even a prompt', async () => {
  const { p, calls } = build();
  await assert.rejects(() => p.request({ method: 'eth_sign' }), /does not expose/);
  await assert.rejects(() => p.request({ method: 'debug_traceCall' }), /does not expose/);
  await assert.rejects(() => p.request({ method: 'personal_decrypt' }), /does not expose/);
  assert.equal(calls.length, 0, 'a refused method must not reach the confirmation layer');
});

test('a garbage request is refused rather than throwing something odd', async () => {
  const { p } = build();
  await assert.rejects(() => p.request(), /does not expose/);
  await assert.rejects(() => p.request({ method: '' }), /does not expose/);
});

// ── a locked wallet answers nothing ──────────────────────────────────────
test('a locked wallet answers nothing at all, not even the chain id', async () => {
  const { p } = build({ unlocked: false });
  await assert.rejects(() => p.request({ method: 'eth_chainId' }), /locked/);
  await assert.rejects(() => p.request({ method: 'eth_requestAccounts' }), /locked/);
  await assert.rejects(() => p.request({ method: 'eth_getBalance', params: [ADDR, 'latest'] }), /locked/);
});

// ── consent is per origin, and a refusal is final ────────────────────────
test('eth_requestAccounts asks first and returns the address once granted', async () => {
  const { p, calls } = build();
  const accounts = await p.request({ method: 'eth_requestAccounts' });
  assert.deepEqual(accounts, [ADDR]);
  assert.equal(calls[0].kind, 'consent');
  assert.equal(calls[0].origin, ORIGIN);
});

test('a refused consent grants nothing and leaves no session behind', async () => {
  const { p } = build({ consent: false });
  await assert.rejects(() => p.request({ method: 'eth_requestAccounts' }), /rejected/);
  // The page must not be able to just try again and get in.
  assert.deepEqual(await p.request({ method: 'eth_accounts' }), [], 'no account is exposed');
  await assert.rejects(() => p.request({ method: 'eth_call' }), /not connected/);
});

test('an unconnected origin is told it has no accounts, and gets nothing else', async () => {
  const { p } = build();
  // EIP-1193: eth_accounts answers with an empty array so a page can decide to
  // show a Connect button. Throwing here breaks that pattern.
  assert.deepEqual(await p.request({ method: 'eth_accounts' }), []);
  // Everything that matters is refused outright.
  await assert.rejects(() => p.request({ method: 'eth_call' }), /not connected/);
  await assert.rejects(() => p.request({ method: 'personal_sign' }), /not connected/);
});

test('a connected origin gets the account list without being asked again', async () => {
  addSite(ORIGIN);
  const { p, calls } = build();
  assert.deepEqual(await p.request({ method: 'eth_accounts' }), [ADDR]);
  assert.equal(calls.length, 0, 'an existing grant must not re-prompt');
});

// ── connected is not the same as may spend ──────────────────────────────
test('signing needs a per-method grant on top of the site grant', async () => {
  addSite(ORIGIN);
  const { p, calls } = build({ permission: false });
  await assert.rejects(() => p.request({ method: 'personal_sign', params: [ADDR, '0xdead'] }), /refused/);
  assert.ok(calls.some((c) => c.kind === 'permission'), 'the refusal must be a real user decision');
  assert.equal(hasPermission(ORIGIN, 'personal_sign'), false, 'a refused grant is not stored');
});

test('a granted signature method is remembered per origin', async () => {
  addSite(ORIGIN);
  const { p } = build();
  await p.request({ method: 'personal_sign', params: [ADDR, '0xdead'] });
  assert.equal(hasPermission(ORIGIN, 'personal_sign'), true);
  // And the grant is for that method only.
  assert.equal(hasPermission(ORIGIN, 'eth_sendTransaction'), false);
});

test('a read call needs no extra grant once connected', async () => {
  addSite(ORIGIN);
  const { p, calls } = build();
  await p.request({ method: 'eth_getBalance', params: [ADDR, 'latest'] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, 'call', 'a read goes straight through, no prompt');
});

// ── events ───────────────────────────────────────────────────────────────
test('listeners fire and can be removed', async () => {
  addSite(ORIGIN);
  const { p } = build();
  const seen = [];
  const off = p.on('accountsChanged', (a) => seen.push(a));
  p._emit('accountsChanged', [ADDR]);
  assert.deepEqual(seen, [[ADDR]]);
  off();
  p._emit('accountsChanged', []);
  assert.equal(seen.length, 1, 'a removed listener must stop firing');
});

test('a listener that throws does not break the emit loop', async () => {
  addSite(ORIGIN);
  const { p } = build();
  p.on('accountsChanged', () => { throw new Error('bad listener'); });
  const seen = [];
  p.on('accountsChanged', (a) => seen.push(a));
  p._emit('accountsChanged', [ADDR]);
  assert.deepEqual(seen, [[ADDR]]);
});

// ── legacy alias goes through the same gate ─────────────────────────────
test('sendAsync is not a way around the allow-list', async () => {
  const { p } = build();
  await new Promise((res) => {
    p.sendAsync({ id: 1, method: 'eth_sign' }, (err) => { assert.ok(err); res(); });
  });
});
