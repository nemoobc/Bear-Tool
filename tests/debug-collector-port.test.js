// Bear Tool — tests/debug-collector-port.test.js
//
// The relay's port is one knob (BEAR_DEBUG_PORT, fallback 7331) that BOTH ends
// must read. It used to be a literal 7331 inside js/debug-collector.js, so
// moving the relay disconnected the collector silently: reports were posted to
// a port nothing listened on, and the anti-loop bypass watched `:7331` too —
// the one request that must never be recorded was keyed to a dead port.
//
// This file runs in its own process (node --test = one process per file) so it
// can set the env var BEFORE the module is imported, which is the only moment
// the collector reads it.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const PORT = '17399';
process.env.BEAR_DEBUG_PORT = PORT;

const listeners = {};
globalThis.addEventListener = (ev, fn) => { (listeners[ev] ||= []).push(fn); };
globalThis.location = { href: 'http://127.0.0.1:8080/' };
Object.defineProperty(globalThis, 'navigator', {
  value: { userAgent: 'port-test' }, configurable: true, writable: true,
});

let mode = 'ok';
const calls = [];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  calls.push({ url: u, body: opts?.body });
  if (mode === 'throw') throw new Error('relay-down');
  return {
    ok: true, status: 200,
    headers: { get: () => 'application/json' },
    clone: () => ({ json: async () => ({}) }),
  };
};

await import('../js/debug-collector.js?portcase=1');
const tick = () => new Promise((r) => setImmediate(r));
const reports = () => calls.filter((c) => c.url.endsWith('/report'));

test('collector mengirim ke port hasil BEAR_DEBUG_PORT, bukan 7331 tetap', () => {
  for (const fn of listeners.error || []) fn({ message: 'port-marker' });
  assert.equal(reports().length, 1, 'satu ship per error');
  assert.equal(reports()[0].url, `http://127.0.0.1:${PORT}/report`,
    'alamat relay harus dibangun dari port env');
  assert.ok(!reports()[0].url.includes('7331'),
    'literal 7331 lama masih terpakai — memindahkan relay memutus kolektor');
  assert.match(reports()[0].body, /port-marker/);
});

test('guard anti-loop mengawasi port hasil env, bukan 7331', async () => {
  // Kalau guard salah port, POST ini dianggap kegagalan jaringan biasa dan
  // DICATAT (lalu di-ship lagi) — panggilan fetch jadi n+2, bukan n+1.
  mode = 'throw';
  const n = calls.length;
  await assert.rejects(
    () => globalThis.fetch(`http://127.0.0.1:${PORT}/report`, { method: 'POST' }),
    /relay-down/,
    'fetch asli tetap melempar ke pemanggil');
  assert.equal(calls.length, n + 1,
    'panggilan ke relay harus dilewatkan TANPA catatan baru — guard kemungkinan mengawasi port yang salah');
  mode = 'ok';
});

test('clearLogs ikut memakai port yang sama', async () => {
  calls.length = 0;
  const m = await import('../js/debug-collector.js?portcase=2');
  m.clearLogs();
  await tick();
  assert.equal(calls.length, 1, 'satu POST /clear');
  assert.equal(calls[0].url, `http://127.0.0.1:${PORT}/clear`);
});
