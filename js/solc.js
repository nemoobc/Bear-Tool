// ═══════════════════════════════════════════════════════════════
// Bear Tool — solc.js
// Real in-browser Solidity compiler. No server, no simulation.
//
// BUG IT FIXES: the CDN's `solc.js` is the Node CLI wrapper (it starts with
// `#!/usr/bin/env node` and calls `require(...)`), so loading it with a
// browser <script> tag left `globalThis.solc` undefined and every deploy
// threw "Cannot read properties of undefined (reading 'compile')".
// The browser build is `soljson.js` (wasm, ~9 MB): it publishes a global
// `Module`, whose exported `solidity_compile` we drive through `Module.cwrap`.
// ═══════════════════════════════════════════════════════════════

// 0.8.37 (upgrade from 0.8.28, 2026-10-04): the wizard's EVM-version picker
// needs `osaka`, which solc only accepts from 0.8.32 on (0.8.28 tops out at
// `prague` and hard-errors on anything newer).
export const SOLC_VERSION = '0.8.37';
// Commit hash the runtime itself reports (`0.8.37+commit.f401782d.Emscripten.clang`,
// observed when M6 loaded the real soljson). Both verifiers want the FULL id
// string, and each wants it spelled differently — see SOLC_ID_* below.
export const SOLC_COMMIT = 'f401782d';
export const SOLC_LONG = `${SOLC_VERSION}+commit.${SOLC_COMMIT}`;
// Sourcify takes the bare `0.8.37+commit.f401782d`; Etherscan's API documents
// the leading `v` (docs.etherscan.io/api-reference/endpoint/verifysourcecode,
// 2026-10-04). One source of truth, two spellings — not two sources of truth.
export const SOLC_ID_SOURCIFY = SOLC_LONG;
export const SOLC_ID_ETHERSCAN = `v${SOLC_LONG}`;
export const SOLC_URL = `https://cdn.jsdelivr.net/npm/solc@${SOLC_VERSION}/soljson.js`;
// SHA-384 of soljson.js 0.8.37 (verified 2026-10-04; byte-identical from BOTH
// mirrors — jsdelivr and unpkg hashed to the same sha384 — so one integrity
// covers both. Runtime reports `0.8.37+commit.f401782d.Emscripten.clang`.)
export const SOLC_INTEGRITY = 'sha384-Q/PQcFjuBNF8rqPraGnYlnNVV0Tbq/R/oYmS7enwnItWJNVQxKdC7kbbVfZ0GNkO';
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

// The ONE standard-JSON-input builder. compileContract() sends exactly this to
// solc, and verify.js publishes exactly this to Sourcify/Etherscan — so what
// gets verified is what got compiled, by construction rather than by discipline.
// A verifier that rebuilds the input by hand is how a "verified" contract ends
// up differing from the one that was deployed.
export function buildStandardJsonInput(source, contractName, opts = {}) {
  const { optimizer = true, runs = 200, language = 'Solidity', evmVersion } = opts;
  if (!source || !contractName) throw new Error('buildStandardJsonInput needs a source and a contract name');
  const fileName = `${contractName}.sol`;
  const settings = {
    optimizer: { enabled: !!optimizer, runs },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } }
  };
  if (evmVersion) settings.evmVersion = evmVersion;
  return {
    language,
    sources: { [fileName]: { content: source } },
    settings
  };
}

// Compile one self-contained source → { abi, bytecode, warnings }.
// `contractName` must match a contract declared in `source`.
// Wizard compiler-config passthrough: `language` (Solidity default) and
// `evmVersion` (omitted from settings entirely when absent → the compiler's
// own default wins, so the flag-off path behaves exactly as before).
export async function compileContract(source, contractName, opts = {}) {
  const { onStatus } = opts;
  const input = buildStandardJsonInput(source, contractName, opts);
  const fileName = `${contractName}.sol`;
  const solc = await loadCompiler({ onStatus });
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
  // Every deployable contract in the file, not just the requested one: M9's
  // upgradeable build compiles the token AND ERC1967Proxy in one pass, and the
  // deploy needs the proxy's ABI + creation code from the same compilation
  // (two compilations of one source could disagree after a knob change).
  // Interfaces/libraries carry no creation code and are skipped.
  const contracts = {};
  for (const [name, c] of Object.entries(output.contracts?.[fileName] || {})) {
    if (c?.evm?.bytecode?.object) contracts[name] = { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
  }
  return {
    abi: contract.abi,
    bytecode: '0x' + contract.evm.bytecode.object,
    contracts,
    warnings: (output.errors || []).filter(e => e.severity !== 'error').map(e => e.formattedMessage || e.message)
  };
}
