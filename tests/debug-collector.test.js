// Bear Tool — debug collector: error/rejection/net-fail/rpc-error → relay.
// Shim DOM + fetch spy SEBELUM import; import ber-query = instance segar.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const listeners = {};
globalThis.addEventListener = (ev, fn) => { (listeners[ev] ||= []).push(fn); };
globalThis.location = { href: 'http://127.0.0.1:8080/' };
// node ≥21 punya global navigator berbentuk getter-only → define, bukan assign.
Object.defineProperty(globalThis, 'navigator', {
  value: { userAgent: 'unit-test' }, configurable: true, writable: true,
});

// Mode-switchable spy: collector mengikat globalThis.fetch SAAT import,
// jadi sifat spy di sini = sifat origFetch di dalam collector.
let mode = 'ok';
const calls = [];
const spyFetch = async (url, opts) => {
  const u = String(url);
  calls.push({ url: u, body: opts?.body });
  if (mode === 'throw') throw new Error('offline');
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    clone: () => ({
      json: async () => (mode === 'rpc'
        ? { jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'Batch JSON-RPC is disabled by policy' } }
        : {}),
    }),
  };
};
globalThis.fetch = spyFetch;

let n = 0;
const dcMod = await import(`../js/debug-collector.js?case=${++n}`);

const relayCalls = () => calls.filter((c) => c.url.includes(':7331/report'));
const lastRelay = () => JSON.parse(relayCalls()[relayCalls().length - 1].body);
const tick = () => new Promise((r) => setImmediate(r));

test('window error → tercatat + dikirim ke relay, ring dibawa', () => {
  for (const fn of listeners.error || []) fn({ message: 'boom', filename: 'app.js', lineno: 3, colno: 4 });
  assert.equal(relayCalls().length, 1, 'persis satu ship per error');
  const body = lastRelay();
  assert.equal(body.kind, 'error');
  assert.equal(body.detail.msg, 'boom');
  assert.equal(body.href, 'http://127.0.0.1:8080/');
  assert.ok(Array.isArray(body.ring) && body.ring.length >= 1, 'ring ikut terkirim');
});

test('unhandledrejection → tercatat dengan pesan error', () => {
  for (const fn of listeners.unhandledrejection || []) fn({ reason: new Error('nope') });
  const body = lastRelay();
  assert.equal(body.kind, 'rejection');
  assert.equal(body.detail.msg, 'nope');
});

test('fetch gagal jaringan → net-fail tercatat, error tetap melempar ke pemanggil', async () => {
  mode = 'throw';
  await assert.rejects(() => globalThis.fetch('https://rpc.example/x'), /offline/,
    'collector boleh mencatat tapi tidak boleh menelan error');
  const body = lastRelay();
  assert.equal(body.kind, 'net-fail');
  assert.equal(body.detail.url, 'https://rpc.example/x');
  mode = 'ok';
  dcMod.resetRelayState(); // relay tadi menolak — uji berikut butuh percobaan segar
});

test('balasan JSON-RPC ber-error (HTTP 200) → rpc-error tercatat', async () => {
  mode = 'rpc';
  const res = await globalThis.fetch('http://127.0.0.1:8545/', { method: 'POST' });
  assert.equal(res.ok, true, 'respon asli tetap dilewat utuh');
  await tick(); // clone().json() asinkron
  const body = lastRelay();
  assert.equal(body.kind, 'rpc-error');
  assert.equal(body.detail.code, -32600);
  assert.match(body.detail.message, /Batch JSON-RPC/);
  mode = 'ok';
});

test('POST ke relay TIDAK memicu catatan baru (loop protection)', async () => {
  const before = relayCalls().length;
  const ringBefore = lastRelay().ring.length;
  // memicu ship manual lewat error ke-3 → isinya relay-POST di-spam;
  // yang dicek: panggilan :7331 tidak pernah masuk sebagai entry kind baru
  for (const fn of listeners.error || []) fn({ message: 'again' });
  assert.equal(relayCalls().length, before + 1, 'ship berikutnya = 1, bukan berlipat');
  assert.equal(lastRelay().ring.length, Math.min(ringBefore + 1, 10), 'ring naik satu, tak meledak');
});

test('clearLogs: export ada, POST /clear ke relay, ring instance dikosongkan', async () => {
  const m = await import(`../js/debug-collector.js?case=${++n}`);
  assert.equal(typeof m.clearLogs, 'function', 'clearLogs harus di-export dari debug-collector');
  // isi ring instance ini dulu
  for (const fn of listeners.error || []) fn({ message: 'pre-clear-marker' });
  calls.length = 0;
  m.clearLogs();
  const clearCall = calls.find((c) => c.url.includes(':7331/clear'));
  assert.ok(clearCall, 'clearLogs harus mengirim POST /clear ke relay');
  // error baru sesudah clear: entry lama tak boleh ikut terbawa di ring
  for (const fn of listeners.error || []) fn({ message: 'post-clear-error' });
  const report = [...calls].reverse()
    .find((c) => c.url.endsWith('/report') && JSON.parse(c.body)?.detail?.msg === 'post-clear-error');
  assert.ok(report, 'error baru tetap tercatat setelah clear');
  const ring = JSON.stringify(report.ring || []);
  assert.ok(!ring.includes('pre-clear-marker'),
    `entry pra-clear harus hilang dari ring: ${ring}`);
  mode = 'ok';
});
