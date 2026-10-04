// ═══════════════════════════════════════════════════════════════
// Bear Tool — solc worker.
//
// WHY THIS EXISTS (live bug, Android Chrome/150, 2026-10-03): Chrome refuses
// SYNCHRONOUS WebAssembly compilation of buffers >8MB on the MAIN thread —
// loading soljson.js (solc 0.8.28, ~9MB) in the page threw
//   RangeError: WebAssembly.Compile is disallowed on the main thread, if the
//   buffer size is larger than 8MB.
// The runtime never came up, so every Deploy/EIP-7702 compile on the user's
// phone died before it started. Workers are exempt from that restriction:
// the identical sync init runs fine off the main thread. The page keeps only
// a message channel (js/solc.js).
//
// PROTOCOL (postMessage both ways):
//   in : { urls: string[], input: string }   // solc standard-JSON input; urls tried in order
//   out: { stage, ... }
//     'status'        { message }            // progress, forwarded to the UI
//     'result'        { output }             // solc standard-JSON output (string)
//     'load-error'    { message }            // download/runtime failure — raw text
//     'compile-error' { message }            // solidity_compile threw
//
// TRUST: importScripts() cannot verify an integrity hash, so the CDN pin is
// the CSP host allowlist in index.html (script-src … unpkg, cdn.jsdelivr.net)
// — the same hosts the main-thread loader already trusts.
// ═══════════════════════════════════════════════════════════════

const LOAD_TIMEOUT_MS = 120000;
const READY_POLL_MS = 100;

let runtime = null; // { compile } — set once soljson.js is up in THIS worker

function post(msg) { self.postMessage(msg); }
function say(message) { post({ stage: 'status', message }); }

async function waitForRuntime() {
  const deadline = Date.now() + LOAD_TIMEOUT_MS;
  for (;;) {
    const M = self.Module;
    if (M && typeof M.cwrap === 'function') return M;
    if (Date.now() > deadline) {
      throw new Error(`Solidity compiler did not finish starting up (timeout ${LOAD_TIMEOUT_MS}ms)`);
    }
    await new Promise((r) => { setTimeout(r, READY_POLL_MS); });
  }
}

async function ensureRuntime(urls) {
  if (runtime) return runtime;
  let lastErr = null;
  for (const url of urls || []) {
    try {
      say('Loading Solidity compiler…');
      importScripts(url);
      const M = await waitForRuntime();
      const compile = M.cwrap('solidity_compile', 'string', ['string', 'number']);
      if (typeof compile !== 'function') {
        throw new Error('Solidity compiler loaded but exposed no solidity_compile()');
      }
      runtime = { compile };
      say('Solidity compiler ready.');
      return runtime;
    } catch (e) {
      lastErr = e;
      say('Compiler download failed — trying a mirror…');
    }
  }
  throw lastErr || new Error('Failed to load the Solidity compiler');
}

self.onmessage = async (ev) => {
  const data = ev.data || {};
  let compile;
  try {
    compile = (await ensureRuntime(data.urls)).compile;
  } catch (e) {
    post({ stage: 'load-error', message: (e && e.message) || String(e) });
    return;
  }
  try {
    post({ stage: 'result', output: compile(data.input, 1) });
  } catch (e) {
    post({ stage: 'compile-error', message: (e && e.message) || String(e) });
  }
};
