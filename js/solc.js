// ═══════════════════════════════════════════════════════════════
// Bear Tool — solc.js
// Real in-browser Solidity compiler. No server, no simulation.
//
// BUG IT FIXES: `solc@0.8.28/solc.js` on the CDN is the Node CLI wrapper
// (it starts with `#!/usr/bin/env node` and calls `require(...)`), so loading
// it with a browser <script> tag left `globalThis.solc` undefined and every
// deploy threw "Cannot read properties of undefined (reading 'compile')".
// The browser build is `soljson.js` (wasm, ~9 MB): it publishes a global
// `Module`, whose exported `solidity_compile` we drive through `Module.cwrap`.
// ═══════════════════════════════════════════════════════════════

export const SOLC_VERSION = '0.8.28';
export const SOLC_URL = `https://cdn.jsdelivr.net/npm/solc@${SOLC_VERSION}/soljson.js`;
// SHA-384 of soljson.js 0.8.28 (verified 2026-09-20 from the jsdelivr mirror).
// Both mirrors serve the identical npm artifact, so one integrity covers both.
export const SOLC_INTEGRITY = 'sha384-KPNN359HSsJb+rJUYqYP9AKB4mS6MrE1akNLfiSAD3+3RwoAqohTYlzIQ24esQUb';
// Mirrors tried in order when the primary CDN fails (all allow-listed by the CSP).
export const SOLC_FALLBACK_URLS = [
  `https://unpkg.com/solc@${SOLC_VERSION}/soljson.js`
];
const LOAD_TIMEOUT_MS = 120000;
const READY_POLL_MS = 100;

let compilerPromise = null;

// Drop the cached compiler so a failed/partial load can be retried.
export function resetCompiler() { compilerPromise = null; }

// Test seam: run compileContract() against a plain { compile } object.
export function injectCompiler(solc) { compilerPromise = Promise.resolve(solc); }

function waitForRuntime(deadline) {
  return new Promise((resolve, reject) => {
    const check = () => {
      const M = globalThis.Module;
      if (M && typeof M.cwrap === 'function') return resolve(M);
      if (Date.now() > deadline) {
        return reject(new Error(`Solidity compiler did not finish starting up (timeout ${LOAD_TIMEOUT_MS}ms)`));
      }
      setTimeout(check, READY_POLL_MS);
    };
    check();
  });
}

function loadScript(url, integrity) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = url;
    if (integrity) { script.integrity = integrity; script.crossOrigin = 'anonymous'; }
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to download the Solidity compiler from ' + url));
    document.head.appendChild(script);
  });
}

// ── worker path ─────────────────────────────────────────────────────────
// Chrome refuses SYNCHRONOUS WebAssembly compilation of buffers >8MB on the
// MAIN thread — loading soljson.js (9MB) in the page threw
// "WebAssembly.Compile is disallowed on the main thread" and every Deploy on
// the user's phone died before compiling (live report, Android Chrome/150).
// Workers are exempt, so load + compile run in js/solc-worker.js and this
// side only shuttles messages. No Worker (old browsers, Node tests) → the
// main-thread loader below runs exactly as before.
function openWorker(urls, { onStatus } = {}) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(new URL('./solc-worker.js', import.meta.url));
    } catch (e) {
      reject(e);                       // CSP/policy → caller falls back
      return;
    }
    let pending = null;                // in-flight compile { resolve, reject }
    let workerDead = null;             // sticky: construction-time script error
    const settle = (err, value) => {
      const p = pending;
      pending = null;
      if (!p) return;
      if (err) p.reject(err); else p.resolve(value);
    };
    worker.onmessage = (ev) => {
      const m = ev.data || {};
      if (m.stage === 'status') { onStatus?.(m.message); return; }
      if (m.stage === 'result') { settle(null, m.output); return; }
      if (m.stage === 'load-error') {
        // Download/runtime text is the final message — pass it through.
        settle(Object.assign(new Error(m.message || 'Failed to load the Solidity compiler'), { bearNoWrap: true }));
        return;
      }
      if (m.stage === 'compile-error') {
        settle(Object.assign(new Error('Solidity compiler crashed: ' + (m.message || 'unknown error')), { bearNoWrap: true }));
      }
    };
    worker.onerror = (e) => {
      workerDead = Object.assign(
        new Error('Compiler worker failed: ' + ((e && e.message) || 'script error')),
        { bearNoWrap: true },
      );
      settle(workerDead);
    };
    resolve({
      compile: (json) => new Promise((res, rej) => {
        if (workerDead) { rej(workerDead); return; }
        if (pending) { rej(new Error('Solidity compiler is busy — one compile at a time')); return; }
        const timer = setTimeout(() => {
          pending = null;
          rej(Object.assign(
            new Error(`Solidity compiler did not finish starting up (timeout ${LOAD_TIMEOUT_MS}ms)`),
            { bearNoWrap: true },
          ));
        }, LOAD_TIMEOUT_MS);
        pending = {
          resolve: (v) => { clearTimeout(timer); res(v); },
          reject: (e) => { clearTimeout(timer); rej(e); },
        };
        worker.postMessage({ urls, input: json });
      }),
      version: () => SOLC_VERSION,
    });
  });
}

// Load + start the wasm compiler. Cached for the session; a rejection clears
// the cache so the user can simply tap Deploy again. Tries the primary CDN
// first, then each mirror — a blocked/slow CDN must not look like a compile error.
export function loadCompiler({ onStatus } = {}) {
  if (compilerPromise) return compilerPromise;
  compilerPromise = (async () => {
    // Some bundlers/tests provide a ready solc-js object.
    if (typeof globalThis.solc?.compile === 'function') return globalThis.solc;
    const urls = [SOLC_URL, ...SOLC_FALLBACK_URLS];
    // 1) worker — off-thread compile, immune to the main-thread wasm block.
    if (typeof Worker !== 'undefined') {
      try {
        return await openWorker(urls, { onStatus });
      } catch {
        onStatus?.('Compiler worker unavailable — loading in the page instead…');
        // fall through: legacy loader keeps old browsers and tests working
      }
    }
    // 2) main-thread loader (legacy path).
    if (typeof document === 'undefined') throw new Error('Cannot load the Solidity compiler without a DOM');
    let lastErr = null;
    for (const url of urls) {
      try {
        onStatus?.(`Loading Solidity compiler ${SOLC_VERSION} (~9 MB, first run only)…`);
        await loadScript(url, SOLC_INTEGRITY);
        const M = await waitForRuntime(Date.now() + LOAD_TIMEOUT_MS);
        const compile = M.cwrap('solidity_compile', 'string', ['string', 'number']);
        if (typeof compile !== 'function') throw new Error('Solidity compiler loaded but exposed no solidity_compile()');
        onStatus?.('Solidity compiler ready.');
        return { compile: (json) => compile(json, 1), version: () => SOLC_VERSION };
      } catch (e) {
        lastErr = e;
        onStatus?.(`Compiler download failed — trying a mirror…`);
      }
    }
    throw lastErr || new Error('Failed to load the Solidity compiler');
  })();
  compilerPromise.catch(() => { compilerPromise = null; });
  return compilerPromise;
}

// Compile one self-contained source → { abi, bytecode, warnings }.
// `contractName` must match a contract declared in `source`.
export async function compileContract(source, contractName, opts = {}) {
  const { optimizer = true, runs = 200, onStatus } = opts;
  if (!source || !contractName) throw new Error('compileContract needs a source and a contract name');
  const fileName = `${contractName}.sol`;
  const solc = await loadCompiler({ onStatus });
  const input = {
    language: 'Solidity',
    sources: { [fileName]: { content: source } },
    settings: {
      optimizer: { enabled: !!optimizer, runs },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } }
    }
  };
  let output;
  try {
    // await: worker path returns a Promise, legacy seam/injected compilers
    // return a string — both work.
    const rawOut = await solc.compile(JSON.stringify(input));
    output = JSON.parse(typeof rawOut === 'string' ? rawOut : String(rawOut));
  } catch (e) {
    // bearNoWrap = the message is already final (worker download/runtime text
    // or a pre-wrapped compile crash) — re-wrapping would stutter it.
    if (e && e.bearNoWrap) throw e;
    throw new Error('Solidity compiler crashed: ' + (e?.message || String(e)));
  }
  const errors = (output.errors || []).filter(e => e.severity === 'error');
  if (errors.length) {
    throw new Error('Compile error: ' + (errors[0].formattedMessage || errors[0].message || 'unknown error'));
  }
  const contract = output.contracts?.[fileName]?.[contractName];
  if (!contract?.evm?.bytecode?.object) throw new Error('Compiler returned no bytecode for ' + contractName);
  return {
    abi: contract.abi,
    bytecode: '0x' + contract.evm.bytecode.object,
    warnings: (output.errors || []).filter(e => e.severity !== 'error').map(e => e.formattedMessage || e.message)
  };
}
