// Bear Tool — debug collector (nol-UI, auto-report).
//
// Why: the reported failure ("tx never runs, fundex fine on the same phone")
// has no artifact to debug — mobile Chrome has no console the user can read,
// and copying error text by hand never happened. This collector captures the
// three shapes that matter and SHIPS them automatically to the local relay
// (tools/debug-relay.mjs, 127.0.0.1:$BEAR_DEBUG_PORT — default 7331, the same
// knob the relay itself reads) the moment they occur:
//
//   1. window error / unhandled rejection   → message + stack
//   2. request that never answers            → net-fail (URL + error)
//   3. request that answers with an error    → http-fail / rpc-error
//
// Deliberate limits:
//   - REQUEST BODIES ARE NEVER SENT (a signed raw tx, a keystore, a seed must
//     not leave the page; URL + status + error text only).
//   - Fire-and-forget: relay down (Pages origin, no listener) → silent drop.
//     The buffer stays in memory; nothing throws, nothing blocks the app.
//   - The relay call itself bypasses the fetch hook (no self-report loop).
//   - Reports carry ring context (last 10 entries), page URL and UA — enough
//     to tell "my network", "wrong chain" and "app bug" apart.

// The relay's port is ONE knob shared by both ends: the same
// `BEAR_DEBUG_PORT || 7331` fallback tools/debug-relay.mjs reads. It used to
// be a literal 7331 here, so moving the relay disconnected the collector
// silently — and the loop bypass watched `:7331` too, so the one request that
// must never be recorded was keyed to a port nothing was listening on.
// `typeof process` guards the page build: this file is plain ESM served to the
// browser, where there is no process at all.
const PORT = (typeof process !== 'undefined' && process && process.env && process.env.BEAR_DEBUG_PORT)
  ? String(process.env.BEAR_DEBUG_PORT)
  : '7331';
const RELAY_ORIGIN = `127.0.0.1:${PORT}`;
const RELAY = `http://${RELAY_ORIGIN}/report`;
const MAX = 50;
const ring = [];
let seq = 0;

function record(kind, detail) {
  const entry = {
    t: new Date().toISOString(),
    seq: ++seq,
    kind,
    detail,
    href: (typeof location !== 'undefined' && location) ? location.href : undefined,
    ua: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
  };
  ring.push(entry);
  if (ring.length > MAX) ring.shift();
  try { console.warn('[bear-debug]', kind, detail); } catch { /* noop */ }
  ship(entry);
}

function ship(entry) {
  try {
    // keepalive: still delivered if the page unloads right after the failure.
    fetch(RELAY, {
      method: 'POST',
      mode: 'cors',
      keepalive: true,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...entry, ring: ring.slice(-10) }),
    }).catch(() => { /* relay down = silent */ });
  } catch { /* noop */ }
}

// The EIP-7702 support scan reports one rpc-error per endpoint — a full sweep
// fills the ring (and the relay file) in seconds. Settings' "Delete logs"
// button calls this: drop the in-memory ring so the NEXT report no longer
// carries the old entries, and ask the relay to truncate its file. Relay down
// (Pages origin, no listener) = silent drop, same contract as ship().
export function clearLogs() {
  ring.length = 0;
  try {
    fetch(RELAY.replace('/report', '/clear'), {
      method: 'POST',
      mode: 'cors',
      keepalive: true,
    }).catch(() => { /* relay down = silent */ });
  } catch { /* noop */ }
}

const trim = (x, n = 400) => String(x ?? '').slice(0, n);

// 1. synchronous errors + unhandled rejections.
// Guarded: this module is also imported under Node (tests pull in app.js),
// where a bare addEventListener() at load time is a ReferenceError that kills
// the whole importing test file — dapps-view-render caught exactly that.
if (typeof addEventListener === 'function') {
  addEventListener('error', (e) => {
    record('error', {
      msg: trim(e && e.message, 600),
      file: trim(e && e.filename, 200),
      line: e && e.lineno,
      col: e && e.colno,
    });
  });
  addEventListener('unhandledrejection', (e) => {
    const r = e && e.reason;
    record('rejection', {
      msg: trim(r && r.message ? r.message : r, 600),
      stack: trim(r && r.stack, 600),
    });
  });
}

// 2/3. every fetch: network death, HTTP failure, JSON-RPC error payload.
const origFetch = typeof fetch === 'function' ? fetch.bind(globalThis) : null;
if (origFetch) {
  globalThis.fetch = async (...args) => {
    let url;
    try { url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url); } catch { url = '?'; }
    const u = trim(url, 200);
    if (u.includes(RELAY_ORIGIN)) return origFetch(...args); // relay itself: no loop
    // RPC method name ONLY — params are never recorded (a signed raw tx lives
    // in params; the string "eth_sendRawTransaction" does not). Knowing which
    // call failed is what turns a bare "execution reverted" report into
    // debuggable evidence.
    let rpcMethod = null;
    try {
      const body = args[1] && typeof args[1].body === 'string' ? args[1].body : null;
      if (body) rpcMethod = JSON.parse(body)?.method || null;
    } catch { /* not JSON-RPC — leave null */ }
    let res;
    try {
      res = await origFetch(...args);
    } catch (err) {
      record('net-fail', { url: u, method: rpcMethod, msg: trim(err && err.message ? err.message : err, 300) });
      throw err;
    }
    if (res && res.ok === false) {
      record('http-fail', { url: u, method: rpcMethod, status: res.status });
    } else if (res && typeof res.clone === 'function') {
      // JSON-RPC errors arrive with HTTP 200 — the shape that killed sends.
      try {
        const ct = res.headers && res.headers.get ? (res.headers.get('content-type') || '') : '';
        if (ct.includes('application/json')) {
          res.clone().json().then((j) => {
            if (j && j.error) {
              record('rpc-error', {
                url: u,
                method: rpcMethod,
                code: j.error.code,
                message: trim(j.error.message, 400),
              });
            }
          }).catch(() => { /* body not JSON — ignore */ });
        }
      } catch { /* headers unreadable — ignore */ }
    }
    return res;
  };
}
