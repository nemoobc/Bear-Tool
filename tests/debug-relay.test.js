// Bear Tool — debug relay: terima report collector, tulis JSONL, CORS+PNA.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { trimLog } from '../tools/debug-relay.mjs';

const relaySrc = readFileSync(new URL('../tools/debug-relay.mjs', import.meta.url), 'utf8');
const collectorSrc = readFileSync(new URL('../js/debug-collector.js', import.meta.url), 'utf8');

const PORT = 17331;
const FILE = path.join(os.tmpdir(), `bear-relay-test-${process.pid}.ndjson`);
const URL_ = `http://127.0.0.1:${PORT}/report`;
let child;

before(async () => {
  child = spawn(process.execPath, [path.join(process.cwd(), 'tools', 'debug-relay.mjs')], {
    env: { ...process.env, BEAR_DEBUG_PORT: String(PORT), BEAR_DEBUG_FILE: FILE },
    stdio: 'ignore',
  });
  // 15s, not 5s: this hook spawns a Node child while the suite runs 8 test
  // files in parallel on Termux, where a cold node startup occasionally takes
  // >5s under load — that budget turned into an intermittent red for ALL
  // eight tests in this file (observed 2 of 5 full runs; standalone green).
  // A slow box must not read as a broken relay.
  for (let i = 0; i < 150; i++) {
    try {
      const r = await fetch(URL_, { method: 'OPTIONS' });
      if (r.status === 204) return;
    } catch { /* belum siap */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('relay tidak menyala dalam 15s');
});

after(() => {
  try { child?.kill(); } catch { /* noop */ }
  try { rmSync(FILE); } catch { /* noop */ }
});

test('POST /report → 200 + JSONL tersimpan + header CORS & PNA', async () => {
  const pre = await fetch(URL_, { method: 'OPTIONS' });
  assert.equal(pre.status, 204, 'preflight harus dijawab');
  assert.equal(pre.headers.get('access-control-allow-origin'), '*');
  assert.equal(pre.headers.get('access-control-allow-private-network'), 'true',
    'Chrome PNA butuh header ini untuk public-origin → loopback');

  const res = await fetch(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ seq: 1, kind: 'error', detail: { msg: 'boom' } }),
  });
  assert.equal(res.status, 200);

  const lines = readFileSync(FILE, 'utf8').trim().split('\n');
  assert.ok(lines.length >= 1, 'minimal satu baris JSONL');
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.kind, 'error');
  assert.equal(last.detail.msg, 'boom');
});

test('body rusak → tetap tercatat sebagai malformed, relay tak crash', async () => {
  const res = await fetch(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{nope',
  });
  assert.equal(res.status, 200);
  const lines = readFileSync(FILE, 'utf8').trim().split('\n');
  assert.equal(JSON.parse(lines[lines.length - 1]).kind, 'malformed');
});

test('POST /clear → file JSONL di-truncate (delete logs dari UI)', async () => {
  // isi dulu supaya ada yang dihapus
  await fetch(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ seq: 99, kind: 'error', detail: { msg: 'akan-dihapus' } }),
  });
  assert.ok(readFileSync(FILE, 'utf8').trim().length > 0, 'pra-kondisi: file berisi');
  const res = await fetch(`http://127.0.0.1:${PORT}/clear`, { method: 'POST' });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.equal(readFileSync(FILE, 'utf8').trim(), '', 'file harus kosong setelah /clear');
});

test('path tak dikenal (bukan /report, bukan /clear) → 404 (relay bukan open proxy)', async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/x`, { method: 'POST', body: '{}' });
  assert.equal(res.status, 404);
});

// ── port: satu knop untuk kedua ujung ──────────────────────────────────────
// Relay dan collector dulu menyimpan portnya masing-masing: merelai pindah ke
// BEAR_DEBUG_PORT lain, kolektor tetap menulis ke 7331 — laporan hilang
// senyap, dan guard anti-loop-nya juga mengawasi port yang salah.
test('relay + collector: keduanya membaca BEAR_DEBUG_PORT dengan fallback 7331', () => {
  assert.match(relaySrc, /BEAR_DEBUG_PORT \|\| 7331/,
    'relay harus punya knop port + fallback 7331');
  assert.match(collectorSrc, /process\.env\.BEAR_DEBUG_PORT/,
    'collector harus membaca knop port yang sama');
  assert.match(collectorSrc, /: '7331'/,
    'fallback collector harus 7331 — sama dengan relay');
  assert.match(collectorSrc, /const RELAY = `http:\/\/\$\{RELAY_ORIGIN\}\/report`/,
    'alamat relay disusun dari port hasil env, bukan literal');
  assert.match(collectorSrc, /if \(u\.includes\(RELAY_ORIGIN\)\) return origFetch/,
    'guard anti-loop harus memakai port hasil env, bukan 7331 tetap');
});

// ── trim: pertumbuhan dibatasi 512KB → 256KB terakhir ──────────────────────
test('trimLog: file > 512KB dipangkas ke 256KB terakhir, utuh per baris', () => {
  const f = path.join(os.tmpdir(), `bear-trim-${process.pid}.ndjson`);
  const line = (i) => JSON.stringify({ seq: i, kind: 'error', detail: { msg: 'x'.repeat(200) } }) + '\n';
  let buf = '';
  for (let i = 0; i < 4000; i++) buf += line(i);
  writeFileSync(f, buf);
  assert.ok(statSync(f).size > 512 * 1024, 'pra-kondisi: file melewati 512KB');

  assert.equal(trimLog(f), true, 'file di atas ambang harus dipangkas');
  const size = statSync(f).size;
  assert.ok(size <= 256 * 1024, `ukuran ${size} harus <= 256KB`);
  assert.ok(size > 200 * 1024, 'yang disimpan 256KB TERAKHIR, bukan file hampir kosong');

  const lines = readFileSync(f, 'utf8').trim().split('\n');
  for (const l of lines) JSON.parse(l); // tak ada potongan baris di kepala
  assert.equal(JSON.parse(lines[lines.length - 1]).seq, 3999,
    'laporan terbaru harus selamat');
  assert.equal(JSON.parse(lines[0]).seq > 0, true, 'baris pertama adalah JSON utuh');

  // file kecil tak disentuh
  writeFileSync(f, line(1));
  assert.equal(trimLog(f), false, 'di bawah ambang tidak boleh dipangkas');
  assert.equal(statSync(f).size, Buffer.byteLength(line(1)));
  rmSync(f);
});

test('trimLog benar-benar dipanggil SETELAH tiap laporan ditulis', () => {
  // Fungsi yang ada tapi tak pernah dipanggil = langit-langit palsu.
  const write = relaySrc.indexOf('appendFileSync(FILE,');
  const call = relaySrc.indexOf('trimLog(FILE);');
  assert.ok(write > -1, 'jalur tulis /report harus ada');
  assert.ok(call > write, 'trimLog harus dipanggil SETELAH append, di jalur yang sama');
  assert.match(relaySrc, /export function trimLog\(/,
    'trimLog di-export supaya bisa diuji langsung');
});

test('server nyata: laporan masuk → file >512KB ikut dipangkas (jalur tulis hidup)', async () => {
  const filler = JSON.stringify({ seq: 1, kind: 'rpc-error', detail: { msg: 'y'.repeat(300) } }) + '\n';
  writeFileSync(FILE, filler.repeat(3000)); // ~1MB, jauh di atas ambang
  assert.ok(statSync(FILE).size > 512 * 1024, 'pra-kondisi');
  const res = await fetch(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ seq: 4242, kind: 'error', detail: { msg: 'sesudah-trim' } }),
  });
  assert.equal(res.status, 200);
  const size = statSync(FILE).size;
  assert.ok(size <= 256 * 1024 + 1024,
    `ukuran sesudah laporan = ${size} byte — jalur tulis tidak memangkas`);
  const lines = readFileSync(FILE, 'utf8').trim().split('\n');
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.detail.msg, 'sesudah-trim', 'laporan terbaru tetap utuh di kepala');
  rmSync(FILE, { force: true });
});
