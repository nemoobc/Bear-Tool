// Bear Tool — solc-worker.test.js
//
// The worker path exists because Chrome refuses synchronous WebAssembly
// compilation >8MB on the MAIN thread (live: Android Chrome/150, every Deploy
// died with "WebAssembly.Compile is disallowed on the main thread"). These
// tests pin the message protocol with a FAKE Worker: URL, payload, status
// forwarding, error pass-through vs wrapping, and the no-Worker fallback.
// The real wasm compile on a device is exercised by the user's live retry —
// this file proves the plumbing around it.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const FAKE_OUTPUT = JSON.stringify({
  contracts: {
    'C.sol': {
      C: {
        abi: [{ type: 'constructor', inputs: [] }],
        evm: { bytecode: { object: '60806040' } },
      },
    },
  },
});

class FakeWorker {
  static instances = [];
  static mode = 'ok'; // 'ok' | 'load-error' | 'compile-error'
  constructor(url) {
    this.url = String(url);
    this.onmessage = null;
    this.onerror = null;
    this.sent = [];
    this.terminated = false;
    FakeWorker.instances.push(this);
  }
  postMessage(msg) {
    this.sent.push(msg);
    queueMicrotask(() => {
      this.onmessage?.({ data: { stage: 'status', message: 'Loading Solidity compiler…' } });
      if (FakeWorker.mode === 'load-error') {
        this.onmessage?.({ data: { stage: 'load-error', message: 'Failed to download the Solidity compiler from https://x' } });
        return;
      }
      if (FakeWorker.mode === 'compile-error') {
        this.onmessage?.({ data: { stage: 'compile-error', message: 'boom' } });
        return;
      }
      this.onmessage?.({ data: { stage: 'result', output: FAKE_OUTPUT } });
    });
  }
  terminate() { this.terminated = true; }
}

globalThis.Worker = FakeWorker;
const solc = await import('../js/solc.js');

test('compileContract lewat worker: URL worker, payload, hasil, status UI', async () => {
  solc.resetCompiler();
  FakeWorker.instances.length = 0;
  FakeWorker.mode = 'ok';
  const statuses = [];
  const out = await solc.compileContract('contract C {}', 'C', { onStatus: (m) => statuses.push(m) });
  assert.equal(out.bytecode, '0x60806040');
  assert.equal(out.abi.length, 1);
  const w = FakeWorker.instances[0];
  assert.ok(w, 'worker dibuat');
  assert.ok(w.url.includes('solc-worker.js'), 'url worker mengarah ke js/solc-worker.js, dapat: ' + w.url);
  assert.equal(w.sent.length, 1, 'persis satu pesan compile');
  assert.ok(Array.isArray(w.sent[0].urls) && w.sent[0].urls.length >= 1,
    'daftar mirror CDN ikut dikirim ke worker');
  assert.match(w.sent[0].input, /"C\.sol"/, 'input standard-JSON terkirim utuh');
  assert.ok(statuses.some((s) => /Loading Solidity compiler/.test(s)),
    'status worker diteruskan ke onStatus UI');
});

test('load-error diteruskan apa adanya — TANPA bungkus "crashed"', async () => {
  solc.resetCompiler();
  FakeWorker.mode = 'load-error';
  await assert.rejects(
    () => solc.compileContract('contract C {}', 'C'),
    (err) => {
      assert.match(err.message, /Failed to download/,
        'pesan unduhan harus sampai utuh: ' + err.message);
      assert.ok(!/crashed/.test(err.message), 'jangan dibungkus ulang');
      return true;
    },
  );
  FakeWorker.mode = 'ok';
  solc.resetCompiler();
});

test('compile-error dibungkus jadi "Solidity compiler crashed: …"', async () => {
  solc.resetCompiler();
  FakeWorker.mode = 'compile-error';
  await assert.rejects(
    () => solc.compileContract('contract C {}', 'C'),
    /Solidity compiler crashed: boom/,
  );
  FakeWorker.mode = 'ok';
  solc.resetCompiler();
});

test('tanpa Worker → jatuh ke jalur lama (guard DOM), bukan crash aneh', async () => {
  solc.resetCompiler();
  const W = globalThis.Worker;
  delete globalThis.Worker;
  try {
    await assert.rejects(() => solc.loadCompiler(), /without a DOM/,
      'tanpa Worker dan tanpa document = guard lama yang harus muncul');
  } finally {
    globalThis.Worker = W;
    solc.resetCompiler();
  }
});
