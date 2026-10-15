#!/usr/bin/env node
// Bear Tool — tools/emulator-e2e.mjs
// Android runtime E2E: drive the app's WebView over the Chrome DevTools
// Protocol and walk the whole first-run journey with screenshots.
//
//   boot → welcome → create wallet → seed confirmation (3 questions) →
//   dashboard → every bottom-nav view, collecting every console error and
//   JS exception on the way.
//
// Why CDP and not uiautomator: the app is ONE native WebView — uiautomator
// sees a single "WebView" node and nothing inside it. The DOM inside the
// WebView is reachable through the devtools socket the debug WebView exposes
// (`webview_devtools_remote_<pid>`), which is also where the JS console lives
// — so the driver, the assertions and the error capture share one channel.
//
// HARDENING (run 38006299499, 2026-10-10) — every line below exists because
// a previous run lost the evidence it was supposed to collect:
//   1. `console.error(...); process.exit(1)` in a `catch` LOSSES the message:
//      stderr to a pipe is async, exit() truncates the queued write. That run
//      showed "[e2e] create wallet" and then NOTHING — no FATAL, no report —
//      and the true failure died with the buffer. All fatal paths now write
//      the report with writeFileSync FIRST (a file has no flush race), then
//      flush stderr via process.stderr.write callback before exit.
//   2. Every step appends to steps.log synchronously (appendFileSync), so a
//      SIGKILL still leaves the last executed step on disk.
//   3. CDP send() carries a 15s timeout; the socket carries error/close
//      listeners that reject all pending calls. A dead WebView must produce
//      a loud, named error — never a silent hang (run 38006299499 hung 36
//      minutes this way, until the job's own 40m timeout fired).
//   4. On ANY failure the driver takes a best-effort screenshot: the stuck
//      screen is the diagnosis.
//
// Usage (CI, after `adb shell am start`):
//   node tools/emulator-e2e.mjs
// Env:
//   ADB=adb            adb binary
//   EMULATOR_SERIAL=   optional `-s` serial
//   E2E_OUT=dir        artifacts dir (shots + report)
//   E2E_SKIP_VIEWS=1   first-run only (no nav walk)
//
// Safety: the wallet created here is throwaway (random mnemonic, password
// "e2e-bear-123"), never printed, only the ADDRESS goes into the report.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

const ADB = process.env.ADB || 'adb';
const SERIAL = process.env.EMULATOR_SERIAL || '';
const OUT = process.env.E2E_OUT || 'emulator-artifacts';
// Throwaway password typed into the wallet this script creates on the test
// emulator — a fixture, not a credential.
const WALLET_PW = 'e2e-bear-123';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const adb = (...args) =>
  execFileSync(ADB, SERIAL ? ['-s', SERIAL, ...args] : args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 60_000 });

const adbBin = (...args) =>
  execFileSync(ADB, SERIAL ? ['-s', SERIAL, ...args] : args, { maxBuffer: 32 * 1024 * 1024, timeout: 60_000 });

// Whole-screen capture: a CDP shot sees only ONE WebView — the native dapp
// overlay and its toolbar live outside any page target, and the modal-behind
// question ("is the confirm actually reachable?") is answered by what the
// SCREEN shows, not what the DOM holds.
async function shotScreen(name) {
  try {
    const buf = adbBin('exec-out', 'screencap', '-p');
    if (buf && buf.length > 1000) {
      writeFileSync(path.join(OUT, name + '.png'), buf);
      return true;
    }
  } catch { /* device gone — the verdict carries the reason */ }
  return false;
}

// uiautomator dump, hardened against a CRASHED dumper. The platform tool walks
// the whole accessibility tree and can die mid-walk on this app — run 38127365427
// captured a NullPointerException inside AccessibilityNodeInfoDumper.childNafCheck
// (SIG 9, then "Bad file descriptor" while reporting the crash). A crashed dump
// leaves the PREVIOUS /sdcard/uidump.xml sitting on the device, so the old code
// happily searched a stale file and "could not find" a button that was plainly on
// screen — then blamed the button. Delete first, and accept ONLY a fresh, complete
// hierarchy, so a crash reads as "retry" instead of "not there".
function dumpUi() {
  try { adb('shell', 'rm', '-f', '/sdcard/uidump.xml'); } catch { /* nothing to delete yet */ }
  try {
    adb('shell', 'uiautomator', 'dump', '/sdcard/uidump.xml');
    const xml = String(adb('shell', 'cat', '/sdcard/uidump.xml'));
    return xml.includes('<hierarchy') ? xml : '';
  } catch { return ''; }
}

// Tap a native control by accessibility label: uiautomator is the only eye
// that sees OUTSIDE the WebView (the plugin's toolbar buttons on top of the
// dApp), and a real tap is the only honest click a native overlay admits.
async function tapNativeButton(desc) {
  for (let i = 0; i < 12; i++) {
    const xml = dumpUi();
    if (xml) {
      const node = xml.match(new RegExp('content-desc="' + desc + '"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"'));
      if (node) {
        const x1 = +node[1], y1 = +node[2], x2 = +node[3], y2 = +node[4];
        adb('shell', 'input', 'tap', String((x1 + x2) >> 1), String((y1 + y2) >> 1));
        return true;
      }
    }
    await sleep(1000);
  }
  return false;
}

// Wait for a native control (by accessibility label) to EXIST — the confirm
// sheet's buttons appear asynchronously after the RPC lands.
async function waitNativeButton(desc, tries = 20) {
  for (let i = 0; i < tries; i++) {
    const xml = dumpUi();
    if (xml && xml.includes('content-desc="' + desc + '"')) return true;
    await sleep(1000);
  }
  return false;
}

// Press the confirm button by the rect the APP ITSELF reported (log tag
// BearToolE2E, written in showNativeConfirm once the sheet is laid out). This is
// the fallback for the one thing the driver cannot do from outside: read a
// native button when the platform dumper keeps dying on this screen. It is the
// same button the label path presses — the app is reporting where IT drew it,
// not the driver inventing a hitbox. Used only AFTER the label path failed, and
// never as proof that the sheet appeared (a log line is not a screen).
function tapReportedRect(tag) {
  try {
    const out = String(adb('shell', 'logcat', '-d', '-s', 'BearToolE2E:I'));
    const m = [...out.matchAll(new RegExp(tag + ' (-?\\d+),(-?\\d+),(\\d+),(\\d+)', 'g'))].pop();
    if (!m) return false;
    const w = +m[3], h = +m[4];
    const x = +m[1] + (w >> 1), y = +m[2] + (h >> 1);
    if (w <= 0 || h <= 0 || x <= 0 || y <= 0) return false;
    adb('shell', 'input', 'tap', String(x), String(y));
    return true;
  } catch { return false; }
}

// All TEXT the native layer currently shows (uiautomator dump). The confirm
// sheet is native — its rows exist here, not in any WebView DOM — so this is
// the only place the E2E can cross-check what the user sees.
async function readSheetTexts() {
  // UIAutomator's dump is famously unable to reach every dialog on every
  // run: while the sheet IS visible (the BearToolE2E rect log confirms so),
  // dumpUi() can still return an empty/partial hierarchy, which used to make
  // "has no Connect title" the fatal even though the title was on screen
  // (logcat: "Connect \"http://10.0.2.2:8080\" to Bear Tool?"). Harvest
  // every text surface we can (text="" AND content-desc="", which is the
  // attribute an item's node-carrier actually carries), dedup, and KEEP
  // empties transparent: the caller treats an empty list as a dump failure
  // (fail safe — no phantom pass) but does not assert on emptiness alone.
  const xml = dumpUi();
  if (!xml) return [];
  const fromText = (xml.match(/(?:^|\s)text="([^"]*)"/g) || [])
    .map((m) => m.replace(/^.*text="/, '').replace(/"$/, ''));
  const fromDesc = (xml.match(/content-desc="([^"]*)"/g) || [])
    .map((m) => m.slice('content-desc="'.length, -1));
  const out = new Set();
  for (const v of [...fromText, ...fromDesc]) if (v && v.trim()) out.add(v.trim());
  return [...out];
}

// Console noise that is known, external, and not this app's fault. The price
// hosts (Binance/DexScreener/DefiLlama/GeckoTerminal) may be rate-limited or
// CORS-blocked on the emulator's network — a block logs an ERR_FAILED that is
// NOT a product failure, exactly like the CoinGecko era this list was born for.
const ALLOWED_CONSOLE = [
  /binance/i, /dexscreener/i, /coins\.llama/i, /geckoterminal/i,
  /coingecko/i, /statsig/i, /amplitude/i, /attestation/i,
  /Failed to fetch/i, /net::ERR/i, /walletconnect/i, /mixpanel/i,
  // Upstream Capacitor v8.5.2, NOT this app: SystemBars.java injects its
  // safe-area CSS into a documentElement that does not exist yet at boot
  // (node_modules/@capacitor/android/capacitor/src/main/java/.../SystemBars.java;
  // seen as 3x "Error injecting safe area CSS ... reading 'style'" in run
  // 38012047691). Harmless on notch-less devices, unfixable from JS — the
  // gate stays on for OUR errors and lets this one through deliberately.
  /Error injecting safe area CSS/i,
  // The scheme-guard TEST throws on purpose (run 38073969421): every refused
  // scheme logs "[dApp] open failed: unsupported scheme \"…\"" — the proof,
  // not a defect. Without this the four refusals would fail the run as
  // "unfiltered console errors".
  /\[dApp\] open failed: unsupported scheme/i,
];

// Every step is appended here synchronously the moment it starts — the one
// record that survives a kill (see hardening note 2).
const steplog = path.join(OUT, 'steps.log');
function markStep(name) {
  try { appendFileSync(steplog, `${new Date().toISOString()} ${name}\n`); } catch { /* dir not ready yet */ }
  console.log('[e2e] ' + name);
}

// Write the report synchronously, then flush stderr, then exit. Never
// `console.error` + `process.exit` — that pair is what swallowed the last
// run's FATAL line (hardening note 1).
let report = null;
function die(msg) {
  // Say WHERE and WITH WHAT, not just that something timed out. Every failure
  // this driver has produced so far read like "timeout waiting for #x", which
  // points at a selector instead of a cause; the three lines below turn it into
  // a diagnosis: the step in flight, the console/network evidence gathered while
  // it ran, and the most recent dropped requests.
  let diagnosis = '';
  try {
    if (report) {
      if (report.lastStep) diagnosis += `\n  step in flight: ${report.lastStep}`;
      const ev = (report.stepCtx || []).slice(-6);
      if (ev.length) diagnosis += '\n  evidence while it ran:\n    ' + ev.join('\n    ');
      const nf = (report.netFailures || []).slice(-5);
      if (nf.length) diagnosis += '\n  dropped requests (last 5):\n    ' + nf.join('\n    ');
    }
  } catch { /* report half-built — the plain message below still has to print */ }
  try {
    if (report) {
      // The FIRST fatal is the real one. `die` used to overwrite report.fatal
      // on every call, so a report could carry the LAST symptom instead of the
      // cause: run 38613712299 recorded "Dex: tab Hidden tidak ada" while the
      // same report's own dexView field said "no-host" — that run's actual
      // failure, hidden behind a later check that never had a chance to be true.
      if (!report.fatal) report.fatal = msg + diagnosis;
      report.pass = false;
      writeFileSync(path.join(OUT, 'emulator-report.json'), JSON.stringify(report, null, 2));
    }
  } catch { /* report dir gone — stderr below still matters */ }
  process.stderr.write('[e2e] FATAL: ' + msg + diagnosis + '\n', () => process.exit(1));
  // Fallback if the write callback never fires (stderr itself wedged):
  setTimeout(() => process.exit(1), 2000).unref();
}

// ── minimal CDP client ─────────────────────────────────────────────────────
const CDP_TIMEOUT_MS = 15_000;

function cdpClient(ws) {
  let seq = 0;
  const pending = new Map();
  const events = [];
  const failAll = (why) => {
    for (const [, { reject, timer }] of pending) {
      clearTimeout(timer);
      reject(new Error(why));
    }
    pending.clear();
  };
  ws.on('message', (buf) => {
    let msg;
    try { msg = JSON.parse(String(buf)); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject, timer } = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(timer);
      if (msg.error) reject(new Error(`CDP ${msg.method}: ${msg.error.message}`));
      else resolve(msg.result);
    } else if (msg.method) {
      events.push({ method: msg.method, params: msg.params, at: Date.now() });
    }
  });
  ws.on('close', (code, reason) => failAll(`CDP socket closed (${code}) ${String(reason || '')}`));
  ws.on('error', (err) => failAll(`CDP socket error: ${err.message}`));
  return {
    events,
    send(method, params = {}, timeoutMs = CDP_TIMEOUT_MS) {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP timeout ${timeoutMs}ms: ${method}`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try { ws.send(JSON.stringify({ id, method, params })); }
        catch (e) { clearTimeout(timer); pending.delete(id); reject(e); }
      });
    },
    close() { try { ws.close(); } catch { /* already gone */ } },
  };
}

async function connectCDP(urlMatch = null) {
  let lastErr;
  // Wait for the APP to be alive before probing for its WebView socket. A run
  // that raced the boot (device registered, app not yet spawned) burned the
  // whole retry window on "no webview_devtools_remote socket yet" and died at
  // steps=0 — which reads like "the app broke" when it had not launched. Bounded
  // and skip-safe: a device that never spawns the app just times out.
  for (let i = 0; i < 60; i++) {
    try { if (adb('shell', 'pidof com.nemoobc.beartool').trim()) break; } catch { /* not yet */ }
    await sleep(2000);
  }
  // The WebView debug socket appears AFTER the app process, and adb itself can
  // hiccup mid-boot (a run died with "Command failed: adb shell cat
  // /proc/net/unix" for a straight 60s). 90 tries × 3s = 270s of patience: a
  // slow fleet box gets its run, a dead one costs a few minutes, and neither
  // outcome is mistaken for an app failure.
  for (let i = 0; i < 90; i++) {
    try {
      const unix = adb('shell', 'cat /proc/net/unix');
      const socks = [...new Set(unix.match(/webview_devtools_remote_\d+/g) || [])];
      if (!socks.length) throw new Error('no webview_devtools_remote socket yet');
      adb('forward', 'tcp:9333', `localabstract:${socks[0]}`);
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      const targets = await (await fetch('http://127.0.0.1:9333/json', { signal: ctrl.signal })).json();
      clearTimeout(t);
      const page = targets.find((x) => x.type === 'page' && (!urlMatch || String(x.url || '').includes(urlMatch)))
        || (urlMatch ? null : targets.find((x) => x.type === 'page')) || targets[0];
      if (!page || !page.webSocketDebuggerUrl) throw new Error(urlMatch ? `no page target matching ${urlMatch}` : 'no page target');
      const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
      await new Promise((resolve, reject) => {
        const to = setTimeout(() => reject(new Error('ws open timeout')), 5000);
        ws.once('open', () => { clearTimeout(to); resolve(); });
        ws.once('error', (e) => { clearTimeout(to); reject(e); });
      });
      return cdpClient(ws);
    } catch (e) { lastErr = e; await sleep(3000); }
  }
  throw new Error('CDP connect failed: ' + lastErr.message);
}

// List every page target the device exposes (their URLs). Used by the tabs
// test: two independent WebViews must show up as two targets, and closing a
// tab must remove its target — CDP is the only eye that sees both.
async function cdpTargetUrls() {
  try {
    const unix = adb('shell', 'cat /proc/net/unix');
    const socks = [...new Set(unix.match(/webview_devtools_remote_\d+/g) || [])];
    if (!socks.length) return [];
    adb('forward', 'tcp:9333', `localabstract:${socks[0]}`);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const targets = await (await fetch('http://127.0.0.1:9333/json', { signal: ctrl.signal })).json();
    clearTimeout(t);
    return (targets || []).filter((x) => x.type === 'page').map((x) => String(x.url || ''));
  } catch { return []; }
}

// ── page helpers ───────────────────────────────────────────────────────────
function makePage(cdp) {
  const evaluate = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      throw new Error('evaluate failed: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result?.value;
  };
  return {
    evaluate,
    async wait(sel, timeout = 20000) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) {
        if (await evaluate(`!!document.querySelector(${JSON.stringify(sel)})`)) return true;
        await sleep(250);
      }
      throw new Error(`timeout waiting for ${sel} (${timeout}ms)`);
    },
    async click(sel) {
      const ok = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);
      if (!ok) throw new Error('click target missing: ' + sel);
    },
    // A REAL key event. A synthetic KeyboardEvent dispatched from evaluate()
    // works only if the handler happens to listen where the event was thrown,
    // and the app listens on document/window — so Escape would "pass" without
    // ever reaching the modal. CDP Input is what a finger on the keyboard sends.
    async press(key) {
      const KEYS = {
        Escape: { code: 'Escape', vk: 27 },
        Enter: { code: 'Enter', vk: 13 },
        Backspace: { code: 'Backspace', vk: 8 },
      };
      const k = KEYS[key] || { code: key, vk: 0 };
      const base = { key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk };
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      return true;
    },
    async type(sel, value) {
      const ok = await evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(sel)});
        if (!el) return false;
        el.focus();
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      if (!ok) throw new Error('type target missing: ' + sel);
    },
    async shot(name) {
      // 25s, not the 15s default: run 38062223439's seed screenshot stalled
      // >15s under boot churn (MediaProvider scan + Gralloc contention) with
      // app and renderer both alive — a readback stall rides out, a wedged
      // compositor still fails loud via the wrapper's classification.
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, 25000);
      const file = path.join(OUT, name + '.png');
      writeFileSync(file, Buffer.from(data, 'base64'));
      return file;
    },
  };
}

// ── journey ────────────────────────────────────────────────────────────────
// requestId → URL, populated from Network.requestWillBeSent, consumed by
// Network.loadingFailed so a failure line can name the request that died.
// Module-scoped (not per-call) because requestWillBeSent and loadingFailed
// arrive in different collectConsole() drains.
let reqUrl = null;

// Drain accumulated CDP events into the report. Splice = idempotent, so BOTH
// paths may call it: the verdict (success) and the fatal catch — the failure
// report of run 38034404898 carried a consoleTrail of ZERO because the fatal
// path never ran this transfer, and the external-source CORS errors sitting
// on the wire were only visible from logcat.
function collectConsole(cdp) {
  for (const ev of cdp.events.splice(0)) {
    if (ev.method === 'Runtime.consoleAPICalled') {
      const text = (ev.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
      // The whole console trail (all levels, capped) rides along in the
      // report — readable from the artifact alone, never depending on how
      // Android routes console levels.
      if (report.consoleTrail.length < 200) report.consoleTrail.push(ev.params.type + ': ' + text.slice(0, 300));
      if (ev.params.type === 'error' && !ALLOWED_CONSOLE.some((re) => re.test(text))) {
        report.consoleErrors.push(text.slice(0, 400));
      }
    }
    // Evidence for the step that is running RIGHT NOW — this is what a failing
    // run quotes, so "step X timed out" arrives with what the app logged while
    // it was timing out instead of only the selector name.
    if (ev.method === 'Runtime.consoleAPICalled') {
      const t = (ev.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
      if (ev.params.type === 'error' && report.stepCtx.length < 12) report.stepCtx.push('console: ' + t.slice(0, 200));
    }
    // Network failures are only actionable WITH the URL that failed: an
    // ERR_FAILED with no target is a lead you cannot follow. requestWillBeSent
    // carries requestId → request.url; loadingFailed carries requestId →
    // errorText — join them so every failure names its own request.
    if (ev.method === 'Network.requestWillBeSent') {
      const id = ev.params.requestId;
      if (id && ev.params.request?.url) {
        if (!reqUrl) reqUrl = new Map();
        if (reqUrl.size < 400) reqUrl.set(id, ev.params.request.url);
      }
    }
    if (ev.method === 'Network.loadingFailed') {
      const err = ev.params.errorText || ('failed ' + ev.params.type);
      const url = (reqUrl && reqUrl.get(ev.params.requestId)) || '';
      const line = 'request-failed: ' + err + (url ? ' url=' + url : ' (url unknown — requestId ' + ev.params.requestId + ')');
      if (report.netFailures.length < 60) report.netFailures.push(line);
      if (report.stepCtx.length < 12) report.stepCtx.push(line);
    }
    if (ev.method === 'Runtime.exceptionThrown') {
      const d = ev.params.exceptionDetails;
      report.exceptions.push((d.exception?.description || d.text || 'unknown').slice(0, 500));
    }
  }
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  // Root-cause plumbing (2026-12). A bare "timeout waiting for #foo" names a
  // selector, not a cause: the run that found it could not say whether the app
  // was busy, crashed silently, or waiting on a network call that never came
  // back. Three additions make a failure explain itself:
  //   netFailures — every request the WebView gave up on (Network.loadingFailed),
  //   stepCtx     — the console errors and dropped requests seen SINCE the last
  //                 step marker, so the failing step arrives with its own
  //                 evidence attached instead of the whole run's noise,
  //   lastStep    — the step that was in flight, which the fatal path quotes.
  report = { dexView: null, steps: [], consoleErrors: [], consoleTrail: [], exceptions: [], netFailures: [], stepCtx: [], lastStep: '', native: null, dapp: null, pass: false };
  const step = (name) => {
    report.steps.push(name);
    report.lastStep = name;
    // Close the PREVIOUS step's evidence window before starting a new one, so
    // whatever a step reports belongs to that step and not to the one after it.
    if (report.stepCtx.length) report.stepLog.push({ step: report.lastClosedStep, evidence: report.stepCtx.splice(0) });
    report.lastClosedStep = name;
    markStep(name);
  };
  report.stepLog = [];

  const cdp = await connectCDP();
  markStep('cdp connected');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  // Without this the Network domain stays off and `Network.loadingFailed` is
  // never emitted — so a run whose real problem was a dropped RPC looks exactly
  // like a run whose problem was a hung selector. That is the whole difference
  // between knowing and guessing, so it is on by default, not per-step.
  await cdp.send('Network.enable').catch(() => {});

  const page = makePage(cdp);

  // A REAL key first, then the synthetic route. CDP input goes to whatever target
  // the session is attached to; after a view switch the WebView target can have
  // moved on and a key sent to a stale target reaches nothing (run 38283749329:
  // "Escape did not close the Receive modal" on a modal that IS dismissible). The
  // app's handler is `document.addEventListener('keydown')`, so a KeyboardEvent
  // dispatched on document reaches it deterministically. The assertion stays strict
  // either way — this only makes sure the press ARRIVES.
  const pressEscape = async () => {
    await page.press('Escape').catch(() => {});
    const stillOpen = await page.evaluate(`(() => {
      const o = document.querySelector('#modalOverlay');
      return !!(o && o.classList.contains('open'));
    })()`).catch(() => true);
    if (!stillOpen) return 'cdp';
    await page.evaluate(`(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));
      return true;
    })()`).catch(() => {});
    return 'synthetic';
  };

  // Can the user SEE the wallet chrome, or does the native browser own the
  // screen? No page target can answer that — the overlay is a sibling native
  // view. Measured 2026-10-11 (run 38161736957): the dApp page keeps reporting
  // document.visibilityState === 'visible' even with its overlay GONE, so a
  // gate built on that can never fail (a fake gate). The plugin's viewState()
  // reports stack.getVisibility() — the view tree itself. Returns null-ish on
  // a build without the probe; callers decide how hard to insist.
  const browserState = () => page.evaluate(`(async () => {
    const p = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BearDappBrowser;
    if (!p || typeof p.viewState !== 'function') return { unsupported: true };
    return await p.viewState({});
  })()`).catch((e) => ({ probeFailed: String(e.message) }));

  try {
  step('boot: welcome screen');
  // 60s, not 30: a busy fleet boots slowly and #wCreate lagged past 30s on
  // runs 38072294759 / 38074354011 (bridge registered, app alive — just a
  // slow first paint). The journey still demands EVERY step after this.
  await page.wait('#wCreate', 60000);
  await sleep(600);
  await page.shot('01-welcome');

  step('create wallet');
  await page.click('#wCreate');
  step('create form');
  await page.wait('#createPw');
  await page.type('#createName', 'CI Bear');
  await page.type('#createPw', WALLET_PW);
  await page.type('#createPw2', WALLET_PW);
  step('submit create');
  await page.click('#createBtn');
  await page.wait('.seed-word');
  step('seed phrase visible');
  await page.shot('02-seed-phrase');

  // Measured, not assumed. Two rounds of this run were spent on a seed word
  // that broke across lines ("tornad" / "o") and then on three that came out as
  // "prese…", "incre…", "convi…" after the no-break fix — each was caught here in
  // the source, and neither could be settled there: whether a word FITS depends
  // on the real card width of a real phone, which no stylesheet arithmetic in a
  // unit test knows. scrollWidth > clientWidth is exactly "the box is clipping
  // its own content", and on this screen that means a word the user is being
  // told to write down exists only partly.
  const seedFit = await page.evaluate(`(() => {
    const out = { clipped: [], cells: 0, tightest: { text: '', slack: 1e9 }, widest: null, fontPx: 0 };
    for (const cell of document.querySelectorAll('.seed-word > span')) {
      const text = cell.textContent.trim();
      const client = Math.round(cell.clientWidth);
      const scroll = Math.round(cell.scrollWidth);
      const fs = parseFloat(getComputedStyle(cell).fontSize) || 0;
      out.cells++;
      out.fontPx = fs;
      const slack = client - scroll;
      if (slack < out.tightest.slack) out.tightest = { text, client, scroll, slack };
      if (!out.widest || text.length > out.widest.len) {
        out.widest = { text, len: text.length, client, scroll, slack, fs };
      }
      if (slack < -1) out.clipped.push(text + ' (' + scroll + '>' + client + ')');
    }
    // Worst case, not this run's luck. A seed is random: this one may not contain
    // an 8-letter word at all, and a layout that only fits "exist" and "wasp" is
    // not a layout that fits a seed phrase. So put the longest word BIP-39 has
    // ("absolute", 8 letters) into a real cell, measure that, and put the original
    // back — the DOM is restored before anything reads it.
    const probe = document.querySelector('.seed-word > span');
    if (probe) {
      const keep = probe.textContent;
      probe.textContent = 'absolute';
      out.worst = {
        text: 'absolute', client: Math.round(probe.clientWidth), scroll: Math.round(probe.scrollWidth),
        fits: probe.scrollWidth <= probe.clientWidth + 1,
      };
      probe.textContent = keep;
    }
    return out;
  })()`);
  if (!seedFit.cells) throw new Error('seed words not found to measure');
  if (seedFit.clipped.length) {
    throw new Error('seed words are truncated on this screen: ' + JSON.stringify(seedFit.clipped)
      + ' — the screen asks the user to write these down');
  }
  if (seedFit.worst && !seedFit.worst.fits) {
    throw new Error('the longest BIP-39 word does not fit a seed cell: "absolute" needs '
      + seedFit.worst.scroll + 'px of ' + seedFit.worst.client + 'px — this seed happened not to '
      + 'contain one, which is exactly why it has to be measured on purpose');
  }
  console.log('[gate] seed-text cells=' + seedFit.cells + ' font=' + seedFit.fontPx
    + 'px longest="' + seedFit.widest.text + '"(' + seedFit.widest.len + ' letters)'
    + ' box=' + seedFit.widest.client + 'px text=' + seedFit.widest.scroll
    + 'px slack=' + seedFit.widest.slack + 'px worst="absolute" '
    + (seedFit.worst ? seedFit.worst.scroll + '/' + seedFit.worst.client + 'px fits=' + seedFit.worst.fits : 'n/a'));
  report.seedFit = { cells: seedFit.cells, fontPx: seedFit.fontPx, longest: seedFit.widest };

  step('seed confirmation (3 positions, read the app’s own question)');
  for (let i = 0; i < 3; i++) {
    const label = await page.evaluate(`document.querySelector('#seedQLabel').textContent`);
    const n = Number((label.match(/#(\d+)/) || [])[1]);
    if (!n) throw new Error('cannot parse seed question: ' + label);
    const word = await page.evaluate(`document.querySelectorAll('.seed-word')[${n - 1}].querySelector('span').textContent`);
    await page.click(`.seed-choice-btn[data-word="${word}"]`);
    await sleep(700); // app reshuffles after each answer
  }
  await page.wait('#seedDone:not([disabled])', 8000);
  step('seed confirmed');
  await page.shot('03-seed-confirmed');
  await page.click('#seedDone');

  step('dashboard');
  await page.wait('#view-dashboard.active, .balance-card, #totalBalance', 25000);
  await sleep(1500); // numbers settle
  report.address = await page.evaluate(`(window.localStorage.getItem('bear.activeAccount') || '')`).catch(() => '');
  await page.shot('04-dashboard');

  if (process.env.E2E_SKIP_VIEWS !== '1') {
    step('walk the bottom nav (UI/UX pass)');
    // The bottom bar is FIVE FIXED SLOTS (js/app.js MOBILE_PRIMARY) and 'dex'
    // is not one of them, so `.mobile-nav-item[data-view="dex"]` can never exist
    // on a phone. The first version of this pass clicked that selector inside a
    // .catch(()=>{}), which swallowed the miss: the walk reported success, the
    // launchpad was never opened, and the Dex assertion right below blamed the
    // APP for the driver's own broken selector (run 38613712299:
    // "Dex: tab Hidden tidak ada", report.dexView = "no-host" — no host because
    // the view never opened). Views outside the five slots are reached through
    // the dashboard quick action, which is exactly what openView() below tries;
    // the Dex is walked there, not here.
    for (const view of ['activity', 'swap', 'dapps', 'settings', 'dashboard']) {
      await page.click(`.mobile-nav-item[data-view="${view}"]`).catch(() => {});
      await sleep(1400);
      await page.shot(`05-view-${view}`);
      // dApps list must carry a real logo per card (js/ui.js dappLogo → an
      // <img> layered on the tile-mark). Structural, works offline: the img is
      // in the DOM whatever the remote icon answers — after both sources fail
      // it is HIDDEN (display:none), never removed, so this count is stable.
      if (view === 'dapps') {
        await page.wait('#dappGrid .dapp-card', 10000).catch(() => {});
        const counts = await page.evaluate(
          `document.querySelectorAll('#dappGrid .dapp-card').length + '/' + document.querySelectorAll('#dappGrid .dapp-card .dapp-logo-img').length`
        ).catch(() => '0/0');
        report.dappLogos = counts;
        const [cardsN, imgsN] = String(counts).split('/').map(Number);
        if (!cardsN || imgsN !== cardsN) die('dapp logos: tiap kartu harus punya <img> logo — kartu/img = ' + counts);
      }
    }
  }

  // ── the native dApp browser, end to end ──────────────────────────────────
  // The chain every previous run could only read in source: fixture page
  // (served from the CI host, http://10.0.2.2:8080 — https://localhost would
  // face Capacitor's local-server certificate in a second WebView) opens in
  // the BearDappBrowser → provider injected → eth_chainId → the user's connect
  // (the wallet asks — flash-to-wallet, the setVisible fix; a CDP click would
  // work even behind the overlay, so the MODAL SCREENSHOT is the reachability
  // evidence, and the account row is cross-checked against the fixture's
  // answer) → eth_accounts. Answers are read from the fixture's OWN CDP
  // target; the wallet page only ever sees the confirm modal.
  const hasHook = await page.evaluate('typeof window.__bearE2EOpenDapp === "function"').catch(() => false);
  if (hasHook) {
    step('dapp browser: open fixture in the native WebView');
    report.dapp = { hook: true };
    await page.evaluate(
      "window.__bearE2EOpenDapp('http://10.0.2.2:8080/dapp-rpc-fixture.html')"
      + ".catch((e) => { throw new Error('openNativeDapp failed: ' + e.message); })"
    );

    step('dapp browser: attach the fixture page over its own CDP target');
    const dapp = await connectCDP('10.0.2.2:8080');
    const dpage = makePage(dapp);
    await dapp.send('Runtime.enable').catch(() => {});

    // Ground truth BEFORE the wallet answers: poll #out over CDP — the DOM,
    // not the paint (a screenshot only ever shows the last composited frame;
    // run 38040858378 showed a 20s-old frame while the provider reported
    // 'resolved'). The fixture's own deadlines turn "never settled" into a
    // loud error= line, and every uncaught exception in the dapp page lands
    // in dappEvents below — the dapp view has no other voice (no
    // WebChromeClient, no logcat mirror).
    const pollOut = async (re, timeoutMs) => {
      let t = '';
      const s = Date.now();
      while (Date.now() - s < timeoutMs) {
        t = await dpage.evaluate('document.getElementById("out") ? document.getElementById("out").textContent : ""').catch(() => '');
        if (re.test(String(t))) return String(t);
        await sleep(500);
      }
      return String(t);
    };
    const dappEvents = [];
    const drainDapp = () => {
      for (const ev of (dapp.events || []).splice(0)) {
        if (ev.method === 'Runtime.consoleAPICalled') {
          dappEvents.push('console ' + ev.params.type + ': '
            + (ev.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200));
        }
        if (ev.method === 'Runtime.exceptionThrown') {
          dappEvents.push('exception: ' + ((ev.params.exceptionDetails && ev.params.exceptionDetails.exception && ev.params.exceptionDetails.exception.description) || (ev.params.exceptionDetails && ev.params.exceptionDetails.text) || '?').slice(0, 300));
        }
      }
    };
    // The attach can BEAT the navigation commit (bare image = fast local
    // parse): the target still reads about:blank, href records a lie, and
    // the probe dies with "Execution context was destroyed" — run
    // 38061409481 passed but its report carried href=about:blank + probeFailed,
    // forensics a future reader cannot trust. Stabilize first: poll
    // location.href until it leaves about:blank, retrying across context
    // destruction — a document swap mid-poll rejects that attempt, not the
    // journey.
    for (let i = 0; i < 3; i++) {
      const seen = await dpage.evaluate(`(async () => {
        const t0 = Date.now();
        while ((location.href || 'about:blank') === 'about:blank' && Date.now() - t0 < 8000)
          await new Promise((r) => setTimeout(r, 50));
        return location.href;
      })()`).catch((e) => ({ destroyed: /destroyed/i.test(String(e && e.message)) }));
      if (typeof seen === 'string') break;          // stable document reached
      if (!seen || seen.destroyed !== true) break;  // genuine eval failure: don't spin
      await new Promise((r) => setTimeout(r, 300)); // swap in flight — retry
    }
    report.dapp.href = await dpage.evaluate('location.href').catch((e) => 'eval-failed: ' + e.message);

    // Truth probes before judgment: sameFn/type = did Java's 'resolved' come
    // from the instance THIS page registered in; selfSettle = can a promise
    // the page registered settle at all when the PAGE itself resolves it
    // (machinery) — separating a broken then-chain from a broken native hop.
    // Waits for __id1 (set by the fixture's main()) so the probe registers
    // after the chain has started — but seq ORDER is unknowable from here
    // (a racing dapp issues its own requests while this evaluate is in
    // flight: run 38063650949's hardcoded resolve(2) landed on
    // eth_requestAccounts' pending entry), so the probe settles by the
    // request's OWN __bearId, never a guessed number.
    report.dapp.probe = await dpage.evaluate(`(async () => {
      const t0 = Date.now();
      while (!window.__id1 && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 50));
      if (!window.__bearE2EProbe) return { missing: true };
      var head = window.__bearE2EProbe();
      return window.__probeSelf.then(function (t) {
        return { sameFn: head.sameFn, type: head.type, selfSettle: t };
      });
    })()`).catch((e) => ({ probeFailed: e.message }));

    step('dapp browser: eth_chainId lands in the fixture (or its deadline screams)');
    let text = await pollOut(/chainId=|error=|done=/, 40000);
    drainDapp();
    report.dapp.chainStage = String(text).slice(0, 300);
    report.dapp.console = dappEvents.slice(0, 20);
    if (!/chainId=/.test(text)) {
      // Definitive end-state of the LAST open link: did the tracked id-1
      // promise settle (outer promise followed), and did the provider's
      // chainId field get written by request()'s own .then? inner-settled +
      // outer-pending would localize the break to the .then chain itself.
      report.dapp.final = await dpage.evaluate(
        '({ id1: window.__id1 || null, ethChainId: (window.ethereum && window.ethereum.chainId) || null })'
      ).catch((e) => ({ readFailed: e.message }));
      throw new Error('fixture never saw eth_chainId. #out=' + JSON.stringify(String(text))
        + ' href=' + report.dapp.href + ' final=' + JSON.stringify(report.dapp.final)
        + ' dappConsole=' + JSON.stringify(report.dapp.console));
    }

    step('dapp browser: connect prompt — native sheet above the LIVE dApp');
    if (!(await waitNativeButton('dapp-confirm-ok', 25))) throw new Error('native connect sheet never appeared');
    // The dApp must STILL be visible: the sheet renders natively above the
    // page, exactly like OKX — no flash-to-wallet (user report "pas connect
    // langsung keluar"). The witness is the native view tree; the page's own
    // visibilityState is recorded as a cross-read only (it does NOT flip when
    // the overlay is hidden — see browserState).
    report.dapp.sheetVisibility = await dpage.evaluate('document.visibilityState').catch(() => '?');
    report.dapp.sheetView = await browserState();
    report.dapp.sheetTexts = await readSheetTexts();
    if (!report.dapp.sheetView || report.dapp.sheetView.visible !== true) {
      throw new Error('dApp was hidden under the connect sheet: ' + JSON.stringify(report.dapp.sheetView)
        + ' (page visibilityState=' + report.dapp.sheetVisibility + ')');
    }
    // The title check is only meaningful when dumps actually contained text: a
    // dump failure, or a sheet whose atom is carried in content-desc rather
    // than text, must NOT masquerade as a missing title (the logcat line
    // "Connect \"...\" to Bear Tool?" is the ground truth, and it passed
    // whenever confirm-ok-rect was seen at all). recordConnectedTitle() below
    // still has the logcat to fall back on.
    if (report.dapp.sheetTexts.length && !report.dapp.sheetTexts.some((t) => /Connect/.test(t))) {
      throw new Error('native sheet has no Connect title: ' + JSON.stringify(report.dapp.sheetTexts));
    }
    if (!report.dapp.sheetTexts.length) {
      console.warn('readSheetTexts() returned empty — UIAutomator did not expose sheet text; continuing on connect-ok-rect proof');
    }
    // Whole screen, not the DOM: the bottom sheet + the fixture page behind it
    // (the proof the browser did NOT vanish).
    await shotScreen('06-dapp-connect-sheet');
    if (!(await tapNativeButton('dapp-confirm-ok')) && !tapReportedRect('confirm-ok-rect')) throw new Error('dapp-confirm-ok did not tap');

    step('dapp browser: fixture reads accounts over its own CDP target');
    text = await pollOut(/done=/, 60000);
    drainDapp();
    report.dapp.log = String(text).slice(0, 500);
    report.dapp.console = dappEvents.slice(0, 20);
    // `hasProvider` is sampled the instant the fixture's own parser runs, which a
    // local page beats on its way to every queued evaluateJavascript — so a
    // healthy late wallet legitimately records `hasProvider=false` and then
    // `providerLate=50` (the fixture waits up to 3s and RECORDS the lateness,
    // see public/dapp-rpc-fixture.html). Demanding the literal `hasProvider=true`
    // failed a run where the connect worked perfectly — account0 and done=ok
    // were both there. The provider is present if it was seen at any point; the
    // load-bearing proof that connect really worked stays `account0` + `done=ok`.
    const log = String(text);
    const providerSeen = /hasProvider=true/.test(log) || /providerLate=\d+/.test(log);
    if (!providerSeen) throw new Error(`fixture never saw a provider at all:\n${log}`);
    for (const key of ['chainId=0x', 'account0=0x', 'accountsAgain=0x', 'done=ok']) {
      if (!log.includes(key)) throw new Error(`fixture log missing ${key}:\n${log}`);
    }
    // The account the fixture received must be the account the native sheet
    // showed (shortAddr 0x1234…abcd — read from the uiautomator dump, the only
    // eye into the native layer).
    const acc = (String(text).match(/account0=(0x[0-9a-fA-F]{40})/) || [])[1] || '';
    if (acc) {
      // Take the value of the sheet's own "Account" row, NOT the first 0x… on
      // screen. The accessibility dump spans the whole window, so the wallet
      // dashboard behind the modal contributes dozens of token addresses
      // (0xdAC1…1ec7 for USDT, 0xA0b8…eB48 for USDC, …) and "first 0x match"
      // picked a TOKEN, not the account being connected — run 38135917949
      // failed a perfectly correct connect on exactly that.
      const texts = report.dapp.sheetTexts || [];
      const rowAt = texts.indexOf('Account');
      const short = (rowAt >= 0 ? texts[rowAt + 1] : '')
        || texts.find((t) => t.startsWith('0x') && t.includes('…')) || '';
      if (!short) throw new Error(`native sheet has no Account row to cross-check ${acc} against: ${JSON.stringify(texts)}`);
      const head = short.slice(0, 6), tail = short.slice(-4);
      if (!acc.toLowerCase().startsWith(head.toLowerCase().replace('…', '')) || !acc.toLowerCase().endsWith(tail.toLowerCase())) {
        throw new Error(`sheet account ${short} does not match fixture account ${acc}`);
      }
      report.dapp.accountMatchesModal = true;
    }
    await dpage.shot('07-dapp-fixture').catch(() => {});
    await shotScreen('07-dapp-screen'); // whole screen incl the native toolbar

    // ── scheme guard: everything that is NOT http/https is refused ─────────
    // The wallet-side hook runs openNativeDapp() → its JS scheme guard (and,
    // past it, the Java gate) — a javascript:/data:/file:/wc: URL must never
    // reach loadUrl. Verify all four shapes are refused with the guard's own
    // message, then confirm the browser still works (fixture #2 next step).
    step('dapp browser: dangerous schemes are refused at the gate');
    report.dapp.schemes = {};
    for (const bad of ['javascript:alert(1)', 'data:text/html,<b>injected</b>', 'file:///system/build.prop', 'wc:deadbeef@1?relay-protocol=irn']) {
      const res = await page.evaluate(
        `window.__bearE2EOpenDapp(${JSON.stringify(bad)})
          .then(() => 'opened')
          .catch((e) => 'refused: ' + (e && e.message ? e.message : String(e)))`
      ).catch((e) => 'throw: ' + e.message);
      report.dapp.schemes[bad.split(':')[0]] = String(res);
      if (!String(res).startsWith('refused:') || !/http\/https/.test(String(res))) {
        throw new Error(`open() accepted a dangerous scheme: ${bad} -> ${res}`);
      }
    }

    // ── second URL: sign + read surface, proof "any URL in-app" ────────────
    // Same WebView, same CDP target — openNavigates loadUrl() on the existing
    // view, so the driver REUSES dpage (its document just swaps). Fixture #2
    // goes further than connect: it asks for two signatures (wallet flashes
    // its modal twice) and two read calls (answered from the wallet's own
    // provider — the MetaMask-parity read forwarding).
    step('dapp browser: second URL opens in-app — personal_sign + typed data + read RPC');
    await page.evaluate(`window.__bearE2EOpenDapp('http://10.0.2.2:8080/dapp-sign-fixture.html')`)
      .catch((e) => { throw new Error('open fixture#2 failed: ' + e.message); });
    for (let i = 0; i < 3; i++) {
      const seen = await dpage.evaluate(`(async () => {
        const t0 = Date.now();
        while (!(location.href || '').includes('dapp-sign-fixture') && Date.now() - t0 < 8000)
          await new Promise((r) => setTimeout(r, 50));
        return location.href;
      })()`).catch((e) => ({ destroyed: /destroyed/i.test(String(e && e.message)) }));
      if (typeof seen === 'string' && String(seen).includes('dapp-sign-fixture')) break;
      if (!seen || seen.destroyed !== true) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    report.dapp.href2 = await dpage.evaluate('location.href').catch((e) => 'eval-failed: ' + e.message);
    if (!String(report.dapp.href2).includes('dapp-sign-fixture')) {
      throw new Error('fixture #2 never committed: href=' + String(report.dapp.href2));
    }
    // ChainId first (proves the provider re-injected into the NEW document);
    // the native sheet for personal_sign arrives right after the fixture asks.
    if (!(await waitNativeButton('dapp-confirm-ok', 25))) throw new Error('sign sheet never appeared');
    report.dapp.signVisibility = await dpage.evaluate('document.visibilityState').catch(() => '?');
    report.dapp.signView = await browserState();
    if (!report.dapp.signView || report.dapp.signView.visible !== true) {
      throw new Error('dApp was hidden under the sign sheet: ' + JSON.stringify(report.dapp.signView));
    }
    await shotScreen('09-sign-sheet');
    if (!(await tapNativeButton('dapp-confirm-ok')) && !tapReportedRect('confirm-ok-rect')) throw new Error('sign confirm did not tap');
    text = await pollOut(/personalSign=0x|error=|done=/, 60000);
    if (!/personalSign=0x[0-9a-fA-F]{130}/.test(String(text))) throw new Error(`personal_sign failed:\n${text}`);
    report.dapp.personalSign = true;
    // Second sheet: eth_signTypedData_v4.
    if (!(await waitNativeButton('dapp-confirm-ok', 25))) throw new Error('typed-data sheet never appeared');
    await shotScreen('10-typeddata-sheet');
    if (!(await tapNativeButton('dapp-confirm-ok')) && !tapReportedRect('confirm-ok-rect')) throw new Error('typed-data confirm did not tap');
    text = await pollOut(/typedSign=0x|error=|done=/, 60000);
    if (!/typedSign=0x[0-9a-fA-F]{130}/.test(String(text))) throw new Error(`typed-data sign failed:\n${text}`);
    report.dapp.typedSign = true;
    // Read forwarding: blockNumber + balance need NO modal — they must arrive
    // from the wallet's provider as-is (parity with MetaMask).
    text = await pollOut(/blockNumber=0x|error=/, 30000);
    if (!/blockNumber=0x[0-9a-fA-F]+/.test(String(text))) throw new Error(`read forwarding (eth_blockNumber) failed:\n${text}`);
    text = await pollOut(/done=/, 30000);
    report.dapp.signLog = String(text).slice(0, 600);
    const signLog = String(text);
    const signProviderSeen = /hasProvider=true/.test(signLog) || /providerLate=\d+/.test(signLog);
    if (!signProviderSeen) throw new Error(`sign fixture never saw a provider:\n${signLog}`);
    for (const key of ['chainId=0x', 'blockNumber=0x', 'done=ok']) {
      if (!signLog.includes(key)) throw new Error(`sign fixture log missing ${key}:\n${signLog}`);
    }
    await dpage.shot('11-sign-done').catch(() => {});
    await shotScreen('11-sign-done-screen');

    // ── a REAL external https site opens in-app, provider + RPC live ───────
    // The strongest version of "any URL": not our own fixture — a public site
    // on the internet, loaded inside the same native WebView (never an
    // external browser), with the provider injected and a read RPC answered.
    step('dapp browser: real external https site loads in-app with live RPC');
    await page.evaluate(`window.__bearE2EOpenDapp('https://example.com')`)
      .catch((e) => { throw new Error('open example.com failed: ' + e.message); });
    const extWait = Date.now();
    let ext = null;
    while (Date.now() - extWait < 45000) {
      ext = await dpage.evaluate(`({ h: location.href, t: document.title, b: !!(window.ethereum && window.ethereum.isBear) })`)
        .catch(() => null);
      // BREAK ONLY WHEN BOTH LAND. Run 38073423764: inject@commit/finish
      // logged ->"true" for example.com while the driver's first poll saw
      // b:false — the poll broke on href alone right before the native
      // commit-inject executed (the same pre-commit race the Java side
      // race-closes for the PAGE; the driver must retry instead of trusting
      // the first committed read).
      if (ext && String(ext.h).includes('example.com') && ext.b) break;
      await sleep(1000);
    }
    report.dapp.external = ext || { h: null };
    if (!ext || !String(ext.h).includes('example.com')) {
      throw new Error('real https site never loaded in-app: ' + JSON.stringify(report.dapp.external));
    }
    if (!ext.b) throw new Error('provider not injected on the external site: ' + JSON.stringify(report.dapp.external));
    report.dapp.externalTitle = String(ext.t || '');
    // Live RPC on the real page: eth_chainId (wallet answers) + a read call
    // forwarded to the node (proves the whole bridge works on external sites).
    const extRpc = await dpage.evaluate(`(async () => {
      var out = {};
      try {
        out.chainId = await Promise.race([
          window.ethereum.request({ method: 'eth_chainId' }),
          new Promise(function (_, rej) { setTimeout(function () { rej(new Error('chainId timeout')); }, 20000); }),
        ]);
      } catch (e) { out.chainId = 'ERR:' + (e && e.message ? e.message : String(e)); }
      try {
        out.block = await Promise.race([
          window.ethereum.request({ method: 'eth_blockNumber' }),
          new Promise(function (_, rej) { setTimeout(function () { rej(new Error('block timeout')); }, 20000); }),
        ]);
      } catch (e) { out.block = 'ERR:' + (e && e.message ? e.message : String(e)); }
      return out;
    })()`).catch((e) => ({ rpcFailed: e.message }));
    report.dapp.externalRpc = extRpc;
    if (!/^0x[0-9a-fA-F]+$/.test(String(extRpc && extRpc.chainId))) {
      throw new Error('external eth_chainId failed: ' + JSON.stringify(extRpc));
    }
    if (!/^0x[0-9a-fA-F]+$/.test(String(extRpc && extRpc.block))) {
      throw new Error('external read RPC failed: ' + JSON.stringify(extRpc));
    }
    await dpage.shot('12-external-site').catch(() => {});
    await shotScreen('12-external-site-screen');

    step('dapp browser: native back (real taps) walks the history to the wallet');
    report.dapp.backTaps = 0;
    report.dapp.backToWallet = false;
    for (let i = 0; i < 5; i++) {
      const tapped = await tapNativeButton('dapp-back').catch(() => false);
      if (!tapped) { report.dapp.backTapped = i === 0; break; }
      report.dapp.backTapped = true;
      report.dapp.backTaps += 1;
      await sleep(1500);
      await page.wait('#view-dashboard.active, .balance-card, #totalBalance', 15000).catch(() => {});
      report.dapp.backToWallet = await page.evaluate(`!!document.querySelector('#view-dashboard.active, .balance-card')`).catch(() => false);
      if (report.dapp.backToWallet) break;
    }
    if (!report.dapp.backToWallet) throw new Error('native back did not return the wallet to view (taps=' + report.dapp.backTaps + ')');
    await shotScreen('13-back-to-wallet');

    // ── tabs: open / switch / close on a multi-WebView toolbar ─────────────
    // The back loop hid the browser; reopen and approve the fresh connect
    // prompt (eth_requestAccounts always asks) so the tab + network checks run
    // against an open, connected dApp.
    step('dapp browser: reopen for the tabs + network matrix');
    await page.evaluate(`window.__bearE2EOpenDapp('http://10.0.2.2:8080/dapp-rpc-fixture.html')`)
      .catch((e) => { throw new Error('reopen fixture for tabs failed: ' + e.message); });
    for (let i = 0; i < 3; i++) {
      const seen = await dpage.evaluate(`(async () => {
        const t0 = Date.now();
        while (!(location.href || '').includes('dapp-rpc-fixture') && Date.now() - t0 < 8000)
          await new Promise((r) => setTimeout(r, 50));
        return location.href;
      })()`).catch((e) => ({ destroyed: /destroyed/i.test(String(e && e.message)) }));
      if (typeof seen === 'string' && String(seen).includes('dapp-rpc-fixture')) break;
      if (!seen || seen.destroyed !== true) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    report.dapp.tabsReopen = await dpage.evaluate('location.href').catch((e) => 'eval-failed: ' + e.message);
    if (!String(report.dapp.tabsReopen).includes('dapp-rpc-fixture')) {
      throw new Error('fixture never reopened for the tabs test: ' + String(report.dapp.tabsReopen));
    }
    if (!(await waitNativeButton('dapp-confirm-ok', 25))) throw new Error('reopen connect sheet never appeared');
    if (!(await tapNativeButton('dapp-confirm-ok')) && !tapReportedRect('confirm-ok-rect')) throw new Error('reopen connect confirm did not tap');
    text = await pollOut(/done=/, 60000);
    if (!String(text).includes('done=ok')) throw new Error('reopened fixture never finished:\n' + text);

    step('dapp browser: tabs — a new tab owns its own WebView');
    if (!(await tapNativeButton('dapp-tabs'))) throw new Error('dapp-tabs chip did not tap');
    await sleep(800);
    if (!(await tapNativeButton('dapp-tab-new'))) throw new Error('dapp-tab-new did not tap');
    await sleep(1500);
    // Give the fresh tab a real URL so its CDP target is identifiable.
    await page.evaluate(`window.__bearE2EOpenDapp('https://example.com')`)
      .catch((e) => { throw new Error('open in the new tab failed: ' + e.message); });
    await sleep(3000);
    let urls = await cdpTargetUrls();
    report.dapp.tabs = {
      urls,
      hasFixture: urls.some((u) => u.includes('dapp-rpc-fixture')),
      hasExample: urls.some((u) => u.includes('example.com')),
    };
    if (!(report.dapp.tabs.hasFixture && report.dapp.tabs.hasExample)) {
      throw new Error('new tab did not create a second independent WebView: ' + JSON.stringify(report.dapp.tabs));
    }
    await shotScreen('14-tabs-two');

    step('dapp browser: closing a tab releases its WebView');
    if (!(await tapNativeButton('dapp-tabs'))) throw new Error('dapp-tabs chip (2nd) did not tap');
    await sleep(800);
    if (!(await tapNativeButton('dapp-tab-close-1'))) throw new Error('dapp-tab-close-1 did not tap');
    let gone = false;
    for (let i = 0; i < 8; i++) {
      await sleep(800);
      urls = await cdpTargetUrls();
      if (!urls.some((u) => u.includes('example.com'))) { gone = true; break; }
    }
    report.dapp.tabsAfterClose = urls;
    if (!gone) throw new Error('closing the tab did not release its WebView: ' + JSON.stringify(urls));

    // ── change network: ◆ → wallet picker → chainChanged into the dApp ─────
    step('dapp browser: ◆ opens the wallet network picker and pushes chainChanged to the dApp');
    if (!(await tapNativeButton('dapp-network'))) throw new Error('dapp-network chip did not tap');
    // The wallet's Networks modal renders in the WALLET webview (the dApp is
    // flashed away while it is open) — its search field is the marker.
    await page.wait('#netSearchInput', 15000);
    report.dapp.netModal = true;
    await shotScreen('15-network-picker');
    // A DIFFERENT known mainnet (Polygon) — a real switch, never a no-op.
    const clicked = await page.evaluate(
      `(function () { var el = document.querySelector('[data-net="polygon"]'); if (el) el.click(); return !!el; })()`
    ).catch(() => false);
    if (!clicked) throw new Error('polygon row not found in the network modal');
    await sleep(3000);
    report.dapp.netAfter = await page.evaluate(`window.localStorage.getItem('bear.networkId')`).catch(() => '');
    if (String(report.dapp.netAfter) !== 'polygon') {
      throw new Error('network did not switch to polygon: ' + String(report.dapp.netAfter));
    }
    // The open tab must have heard EIP-1193 chainChanged 0x89 (Polygon 137).
    // Careful: the fixture records EVERY chainChanged its provider emits, and
    // that provider announces the chain the dApp connected ON (0x1) before the
    // picker's switch — so the dump reads `chainChanged=0x1` FIRST and
    // `chainChanged=0x89` LAST. Reading the first match demanded 0x1 and failed
    // a switch that plainly worked (localStorage=polygon and 0x89 both present;
    // run 38156823295). Wait for the LAST recorded value to become 0x89.
    let chgText = '';
    let chgLast = '';
    const chgDeadline = Date.now() + 20000;
    for (;;) {
      chgText = await dpage.evaluate(
        'document.getElementById("out") ? document.getElementById("out").textContent : ""'
      ).catch(() => chgText);
      const all = String(chgText).match(/chainChanged=(0x[0-9a-fA-F]+)/g) || [];
      chgLast = all.length ? all[all.length - 1].replace(/^chainChanged=/, '') : '';
      if (chgLast === '0x89' || Date.now() > chgDeadline) break;
      await sleep(500);
    }
    report.dapp.chainChanged = chgLast;
    if (chgLast !== '0x89') {
      throw new Error('chainChanged never reached the dApp (want 0x89): ' + JSON.stringify(String(chgText)));
    }
    await shotScreen('16-network-switched');

    // ── the wallet's own "Tabs" door (user: "diluar daaps ga ada tabs") ─────
    // Hide the browser with ✕ (the session SURVIVES a hide — no about:blank
    // wipe), reopen the wallet's DApps view, and walk back in through the new
    // Browser entry.
    step('dapp browser: the wallet DApps page can reopen a hidden browser');
    if (!(await tapNativeButton('dapp-close'))) throw new Error('dapp-close did not tap');
    await sleep(1500);
    await page.click('.mobile-nav-item[data-view="dapps"]').catch(() => { throw new Error('dapps nav missing'); });
    await sleep(1600);
    const entry = await page.evaluate(
      `(function () { var b = document.getElementById('dappTabsBtn'); return b ? b.textContent.replace(/\\s+/g, ' ').trim() : ''; })()`
    ).catch(() => '');
    report.dapp.walletTabsEntry = String(entry);
    if (!/Browser/.test(entry)) throw new Error('wallet DApps page has no Browser tabs entry: ' + JSON.stringify(String(entry)));
    // The fixture target still alive with its URL PROVES the session survived
    // the hide — a tabs entry without live tabs would be a lie.
    if (!(await cdpTargetUrls()).some((u) => u.includes('dapp-rpc-fixture'))) {
      throw new Error('hiding the browser killed the tab session (Browser entry with no live tabs)');
    }
    await page.click('#dappTabsBtn').catch(() => { throw new Error('dappTabsBtn not clickable'); });
    await sleep(1200);
    const rowsN = await page.evaluate(`document.querySelectorAll('.dapp-tabs-row').length`).catch(() => 0);
    report.dapp.walletTabsRows = rowsN;
    if (!rowsN) throw new Error('wallet tabs chooser listed no rows');
    await shotScreen('17-wallet-tabs');
    await page.click('.dapp-tabs-row').catch(() => { throw new Error('no tabs row to click'); });
    await sleep(2500);
    // Back on the dApp: the browser overlay is up again, same live session.
    report.dapp.walletTabsReopened = (await cdpTargetUrls()).some((u) => u.includes('dapp-rpc-fixture'));
    if (!report.dapp.walletTabsReopened) throw new Error('reopening from the wallet did not show the browser');
    await shotScreen('18-wallet-tabs-reopened');
    try { dapp.close(); } catch { /* target may die with the view */ }

    // ── WalletConnect deep link: the OS must hand a bare wc: URI to Bear Tool ─
    // The listing hands users a link that ends as a plain `wc:…` URI
    // (docs/WC-REGISTRY-LISTING.md, mobile.universal → /wc) and the manifest's
    // intent-filter is what turns that click into "the wallet opens with the
    // pairing URI already filled". No browser is installed on this AOSP image,
    // so the redirect HALF is covered elsewhere (the live /wc page + tests/
    // wc-registry-listing.test.js); the OS→app half is only provable here, and
    // `am start` deliberately carries NO -n: the resolution must be the
    // manifest's job, or a listing could dead-end on "no app found".
    //
    // The browser is UP at this point (the step above reopened it), which is
    // the state that used to swallow the sheet: a modal renders in the WALLET's
    // webview while the native overlay covers the screen.
    step('walletconnect: a bare wc: URI resolves to Bear Tool and fills the pair sheet');
    const wcUri = 'wc:' + 'ab12cd34'.repeat(8) + '@2?relay-protocol=irn&symKey=' + 'ef56ab78'.repeat(8);
    report.wcDeepLink = { uri: wcUri.slice(0, 24) + '…' };
    // The device shell parses the -d value: single-quote it (the URI carries
    // ? and &, and an unquoted & would split the command on the device side).
    const started = adb('shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', `'${wcUri}'`).trim();
    report.wcDeepLink.amStart = started.slice(0, 240);
    if (/unable to resolve|Error:/i.test(started)) throw new Error('no app resolved a wc: URI: ' + started);

    // The sheet is a WEB modal in the wallet page — poll the DOM (presence
    // only; visibility is settled below) and demand the URI is ALREADY filled:
    // that hand-off is the whole point of the deep link (no clipboard trip).
    let wcSheet = null;
    for (let i = 0; i < 30 && !(wcSheet && wcSheet.present); i++) {
      wcSheet = await page.evaluate(`(function () {
        var i = document.getElementById('wcPairUri');
        var g = document.getElementById('wcPairGo');
        var ov = document.querySelector('#modalOverlay.open');
        return { present: !!(i && g && ov), open: !!ov, value: i ? String(i.value) : '' };
      })()`).catch(() => null);
      if (!(wcSheet && wcSheet.present)) await sleep(500);
    }
    report.wcDeepLink.sheet = wcSheet;
    // present = the sheet is IN the DOM *and* the overlay is OPEN: closeModal
    // leaves the markup behind, so presence alone could be a leftover.
    if (!wcSheet || !wcSheet.present) throw new Error('a wc: deep link opened no pair sheet: ' + JSON.stringify(wcSheet));
    if (wcSheet.value !== wcUri) {
      throw new Error('the pair sheet opened without the URI: ' + JSON.stringify(String(wcSheet.value).slice(0, 60)));
    }
    await shotScreen('19-wc-deeplink-sheet');

    // PRESENT vs SEEN: the sheet exists in the wallet's DOM, but the native
    // browser owned the screen. The view hierarchy is the only witness — ask
    // the plugin (viewState) and cross-read the dApp page's own
    // document.visibilityState as a second, independent signal.
    step('walletconnect: the native browser steps aside for the sheet — and comes back');
    const readBrowser = async () => {
      // Diagnostic cross-read only — the page does NOT flip to 'hidden' when
      // the overlay is GONE (measured 2026-10-11), so it is evidence, not a gate.
      let dappVisibility = 'target-gone';
      try {
        if ((await cdpTargetUrls()).some((u) => u.includes('dapp-rpc-fixture'))) {
          const c = await connectCDP('dapp-rpc-fixture');
          try { dappVisibility = String(await makePage(c).evaluate('document.visibilityState')); }
          finally { try { c.close(); } catch { /* already gone */ } }
        }
      } catch (e) { dappVisibility = 'probe-failed: ' + e.message; }
      return { native: await browserState(), dappVisibility };
    };
    const withSheet = await readBrowser();
    report.wcDeepLink.withSheet = withSheet;
    if (!withSheet.native || withSheet.native.visible !== false) {
      throw new Error('the sheet is UNDER the native browser — the user cannot see it: '
        + JSON.stringify(report.wcDeepLink.withSheet));
    }
    // Cancel: the sheet closes, the browser must come straight back (a lost
    // restore would leave a wallet with no browser and no way to reopen it).
    await page.click('#modalBox [data-close-modal]').catch(() => { throw new Error('pair sheet has no cancel'); });
    await sleep(1500);
    const afterCancel = await readBrowser();
    report.wcDeepLink.afterCancel = {
      sheetGone: await page.evaluate('!document.getElementById(\'wcPairUri\')').catch(() => null),
      ...afterCancel,
    };
    if (!afterCancel.native || afterCancel.native.visible !== true) {
      throw new Error('the browser never came back after the sheet closed: '
        + JSON.stringify(report.wcDeepLink.afterCancel));
    }

    // ── A closed browser must STAY closed ─────────────────────────────────
    // The session survives a hide (proved above), so the dismissal needs its
    // own bit. Without it the wallet's next sheet-restore (setVisible(true))
    // resurrected the browser: the user closed it, opened another feature, and
    // landed back inside the dApp at the page they left (report 2026-10-11:
    // "keluar nyoba fitur lain keluar malah langsung balik di dalam web daapsnya
    // dalamnya"). This drives the exact wallet-side call that caused it, then
    // proves the real door still reopens.
    step('dapp browser: a closed browser does not resurrect on a wallet restore call');
    if (!(await tapNativeButton('dapp-close'))) throw new Error('dapp-close did not tap');
    await sleep(1300);
    const closedState = await browserState();
    report.dapp.closedState = closedState;
    if (!closedState || closedState.visible !== false || closedState.closed !== true) {
      throw new Error('closing the browser did not record the dismissal: ' + JSON.stringify(closedState));
    }
    const resurrectAttempt = await page.evaluate(`(async () => {
      const p = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BearDappBrowser;
      if (!p) return { unsupported: true };
      await p.setVisible({ visible: true });
      return await p.viewState({});
    })()`).catch((e) => ({ probeFailed: String(e.message) }));
    report.dapp.resurrectAttempt = resurrectAttempt;
    if (!resurrectAttempt || resurrectAttempt.visible !== false) {
      throw new Error('a closed browser CAME BACK on the wallet restore call: ' + JSON.stringify(resurrectAttempt));
    }
    await shotScreen('19b-closed-no-resurrect');
    // And the guard must not brick reopening: the wallet's own Tabs door.
    await page.click('.mobile-nav-item[data-view="dapps"]').catch(() => { throw new Error('dapps nav missing after close'); });
    await sleep(1500);
    await page.click('#dappTabsBtn').catch(() => { throw new Error('dappTabsBtn missing after close'); });
    await sleep(1100);
    await page.click('.dapp-tabs-row').catch(() => { throw new Error('no tabs row to reopen after close'); });
    await sleep(2400);
    const reopened = await browserState();
    report.dapp.reopenedAfterGuard = reopened;
    if (!reopened || reopened.visible !== true) {
      throw new Error('the wallet could not reopen a closed browser: ' + JSON.stringify(reopened));
    }
    await shotScreen('19c-reopened-after-guard');
  }

  // ── feature sweep: every view + the paths the journey never touched ──────
  // The journey above proves first-run, the bottom nav, the native dApp
  // browser and WalletConnect. Every OTHER view — Send, Bridge, Deploy, NFT,
  // Discord, and the modals behind Receive / Settings / the network pill —
  // was never opened, so a view that threw on render, or a button that opened
  // onto nothing, could still ship green. This sweep opens each one and drives
  // the parts that need no funds. Money paths that DO need funds stay in the
  // Playwright suite, which funds the wallet from an anvil fork; here the
  // wallet is empty by design, so the send step proves the guard rails ANSWER
  // (a confirm sheet, or a named refusal) instead of going silent.
  //
  // Nothing is ever broadcast: the EVM flow stops at #confirmNo, the non-EVM
  // panel is filled and read but never submitted.
  const jsClick = (sel) => page.evaluate(
    `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`,
  ).catch(() => false);

  const viewActive = (view) => page.evaluate(
    `document.querySelector('#view-${view}')?.classList.contains('active') === true`,
  ).catch(() => false);

  // Whichever affordance this viewport exposes. The bottom bar is the only nav
  // on a phone (the sidebar is display:none), but both live in the DOM and a
  // JS .click() works on a hidden node — so try the bar, then the sidebar, then
  // the dashboard quick action.
  // Is a sheet covering the screen? Used before every navigation: a JS .click()
  // works perfectly well on a node hidden behind an overlay, so a step can "pass"
  // while the user is looking at something else entirely. That is not hypothetical
  // — the network picker was left open and every screenshot after it, through the
  // settings toggles and the Security Center, was the same unclosed picker wearing
  // a different filename.
  const overlayOpen = () => page.evaluate(
    `!!document.querySelector('#modalOverlay.open') || !!document.querySelector('.dapp-browser-overlay.open')`
  ).catch(() => false);

  const openView = async (view) => {
    if (await viewActive(view)) return true;
    if (await overlayOpen()) {
      throw new Error('cannot open "' + view + '": a modal is covering the screen. '
        + 'A step left a sheet open; close it before navigating, or this step proves nothing.');
    }
    for (const sel of [
      `#mobileNav .mobile-nav-item[data-view="${view}"]`,
      `.sidebar .nav-item[data-view="${view}"]`,
      `.quick-action-btn[data-view="${view}"]`,
    ]) {
      if (!(await jsClick(sel))) continue;
      for (let i = 0; i < 25; i++) {
        if (await viewActive(view)) { await sleep(500); return true; }
        await sleep(250);
      }
    }
    return false;
  };

  const closeModal = async () => {
    if (await jsClick('#modalBox .modal-close')) { await sleep(400); return; }
    await jsClick('#modalOverlay');
    await sleep(400);
  };

  const sweep = {};
  report.sweep = sweep;

  step('feature sweep: every view opens');
  for (const view of ['dashboard', 'activity', 'swap', 'send', 'dapps', 'deploy', 'nft', 'discord', 'settings']) {
    if (!(await openView(view))) throw new Error(`feature sweep: view "${view}" did not open`);
    await sleep(800);
    await page.shot(`30-view-${view}`);
  }

  // ── the Dex, end to end, on the device ────────────────────────────────────
  // The launchpad is NOT one of the bottom bar's five fixed slots, so a phone
  // reaches it only through the dashboard quick action — the last selector
  // openView() tries. Reaching it at all is therefore a real assertion, and the
  // one the previous run silently skipped: the old code clicked the bottom-bar
  // selector inside a .catch(()=>{}) and reported the app broken when its own
  // selector could never match.
  // ── anvil (opt-in chain, read-only proof) ────────────────────────────────
  // On CI the host can start `anvil`, reachable inside the emulator as
  // 10.0.2.2:8607 — flagged by mgh-run workflows; here we merely PROBE the
  // host (no teardown, no flakes): if anvil answers an RPC probe we flip the
  // app onto a Sepolia-shaped chain purely by rewriting bear.rpcOverrides /
  // bear.networkId, reloading, and unlocking (password from the wallet step).
  // This is the real piece missing for "Dex end-to-end" — the app can now read
  // a non-mainnet chain and its Dex shell still mounts. A real create/buy/
  // sell is a higher-value add (funds on anvil account) and lands next;
  // this stage ships only the read/align proof so one flaky deploy cannot
  // burn a whole runner run.
  let anvilReachable = false;
  try {
    const probe = await fetch('http://127.0.0.1:8607', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
      signal: AbortSignal.timeout(5000),
    });
    const j = await probe.json();
    anvilReachable = typeof j.result === 'string';
  } catch (e) { anvilReachable = false; }
  // PROBE ONLY — never mutate the app from here. An earlier version of this
  // stage wrote bear.rpcOverrides/bear.networkId and called location.reload();
  // the reload orphaned the CDP session this driver is attached to, so every
  // later evaluate (including the Dex step's own openView) failed and the run
  // died at "Dex: tidak terjangkau" — a DRIVER bug, not an app bug (run
  // 38631206692). The deep on-chain Dex journey (import anvil #0 via the UI,
  // add the custom RPC through Settings, switch network via the picker) is the
  // correct way to exercise it and is deliberately NOT done inline here: it
  // needs its own re-attach-safe harness. Until then this stage only records
  // whether a host chain was up, and the run stays green.
  if (anvilReachable) {
    report.anvilStage = { reachable: true, note: 'probe only — deep on-chain Dex journey is a separate, re-attach-safe stage' };
    console.log('[anvil] host chain reachable (probe only, no app mutation)');
  } else {
    report.anvilStage = { reachable: false, note: 'no anvil on host — stage skipped' };
  }

  step('dex: the launchpad is reachable and paints its shell');
  if (!(await openView('dex'))) {
    die('Dex: tidak terjangkau dari HP — tidak ada slot bar bawah maupun quick action yang membukanya');
    throw new Error('dex unreachable from the phone');
  }
  await page.wait('#dexRoot', 12000).catch(() => {});
  await sleep(600);
  const shellInfo = await page.evaluate(`(() => {
    const root = document.querySelector('#dexRoot');
    return JSON.stringify({
      hasRoot: !!root,
      rootLen: root ? (root.innerText || '').trim().length : -1,
      welcome: !!document.querySelector('#dexWelcome:not([hidden])'),
      startBtn: !!document.querySelector('#dexStartHere'),
      host: !!document.querySelector('#dexPanelHost'),
      gate: !!document.querySelector('#dexGate:not([hidden])'),
    });
  })()`).catch(() => 'evaluate-failed');
  report.dexShell = shellInfo;
  if (String(shellInfo) === 'evaluate-failed') die('Dex: tidak bisa membaca #dexRoot');
  if (String(shellInfo).includes('"hasRoot":false')) die('Dex: #dexRoot tidak ada — shell view tidak dirender');
  if (String(shellInfo).includes('"rootLen":0')) die('Dex: #dexRoot kosong — renderDex() tidak melukis apa pun');
  await page.shot('31-dex-welcome');

  // First visit shows the welcome card and nothing else (deliberate: the
  // workspace is hidden until the user says they are ready). Pass it the way a
  // user does, then the feed chrome must be there.
  step('dex: the welcome gate opens the workspace, and the feed has its tabs');
  if (String(shellInfo).includes('"startBtn":true')) {
    await jsClick('#dexStartHere');
    await sleep(800);
  }
  const welcomeGone = await page.evaluate(
    `!document.querySelector('#dexWelcome') || document.querySelector('#dexWelcome').hidden === true`
  ).catch(() => false);
  if (!welcomeGone) die('Dex: tombol "Start here" tidak menutup kartu sambutan — workspace tak pernah terbuka');

  // The Sepolia gate dims the whole panel AND sets pointer-events:none on it, so
  // a JS .click() below would fire a handler that a finger could not reach —
  // a false pass of exactly the kind this driver keeps getting bitten by. The
  // gate ships its own way out (#dexGateGo → setTestnetVisible + activateNetwork),
  // so take it, and RECORD whether it landed instead of pretending it did.
  const gateUp = String(shellInfo).includes('"gate":true');
  let gateCleared = !gateUp;
  if (gateUp) {
    await jsClick('#dexGateGo');
    for (let i = 0; i < 32; i++) {
      gateCleared = await page.evaluate(
        `!document.querySelector('#dexGate') || document.querySelector('#dexGate').hidden === true`
      ).catch(() => false);
      if (gateCleared) break;
      await sleep(250);
    }
    report.dexGate = { gateUp: true, cleared: gateCleared };
    await page.shot('31b-dex-gate');
  }

  // Wait for the panel, then for the scope tabs. The feed paints the tabs on
  // its first synchronous pass, so a missing tab after this wait is a real
  // structural failure rather than a race.
  await page.wait('#dexPanelHost', 12000).catch(() => {});
  let tabs = 0;
  let hiddenTab = false;
  let scopes = [];
  let coinCards = 0;
  for (let i = 0; i < 40; i++) {
    const snap = await page.evaluate(`JSON.stringify({
      tabs: document.querySelectorAll('#dexPanelHost [data-dex-scope]').length,
      hidden: !!document.querySelector('#dexPanelHost [data-dex-scope="hidden"]'),
      scopes: Array.from(document.querySelectorAll('#dexPanelHost [data-dex-scope]')).map((b) => b.dataset.dexScope),
      cards: document.querySelectorAll('#dexPanelHost [data-dex-token]').length,
      text: (document.querySelector('#dexPanelHost') || {}).innerText ? (document.querySelector('#dexPanelHost').innerText || '').trim().length : 0,
    })`).catch(() => '{}');
    const o = JSON.parse(snap || '{}');
    tabs = o.tabs || 0; hiddenTab = !!o.hidden; scopes = o.scopes || []; coinCards = o.cards || 0;
    if (tabs > 0) break;
    await sleep(250);
  }
  report.dex = { shell: shellInfo, tabs, hiddenTab, scopes, coinCards, gateUp, gateCleared };
  await page.shot('32-dex-feed');
  if (!tabs) die('Dex: #dexPanelHost tidak punya satu pun scope tab — feed tidak ter-render');
  // The delisting UX changed on user order ("bener² hapus coin bukan hide coin",
  // APK 2026-10-15): delete is real — the coin leaves the feed for good
  // (tombstone, no restore path) and the Hidden tab is GONE by design. The old
  // check demanded that tab, so it failed against the design it had asked for.
  // What must hold now: the two live scopes render, and no Hidden scope crept
  // back — its return would mean hidden-coin delisting came back with it.
  if (hiddenTab) die('Dex: tab Hidden muncul lagi — hapus coin harus nyata (tombstone), bukan delisting tersembunyi');
  if (!scopes.includes('all') || !scopes.includes('mine')) {
    die('Dex: scope feed tidak lengkap — butuh "all" + "mine", dapat: ' + JSON.stringify(scopes));
  }

  // The launch form is a second screen of the same view. It must open from the
  // feed and paint its own fields — a control that exists in source but cannot
  // be reached is not a feature.
  step('dex: the launch form opens from the feed');
  const createOpened = await jsClick('#dexGoCreate');
  if (!createOpened) die('Dex: tombol "+ Create Token" tidak ada di feed');
  await sleep(900);
  const createInfo = await page.evaluate(`JSON.stringify({
    host: (document.querySelector('#dexPanelHost') || {}).innerText ? (document.querySelector('#dexPanelHost').innerText || '').trim().length : 0,
    fields: document.querySelectorAll('#dexPanelHost input, #dexPanelHost textarea, #dexPanelHost select').length,
    back: !!document.querySelector('#dexPanelHost [data-dex-back], #dexPanelHost .dex-back'),
  })`).catch(() => '{}');
  report.dexCreate = createInfo;
  // Say out loud when this tap could not have been a finger: the gate dims the
  // panel and disables pointer events, so the click below proves the FORM is
  // wired, not that a user could have reached it.
  report.dexCreateSynthetic = !gateCleared;
  await page.shot('33-dex-create');
  if (!String(createInfo).includes('"fields"') || JSON.parse(createInfo || '{}').fields === 0) {
    die('Dex: form launch terbuka tanpa satu pun input — tidak ada yang bisa diterbitkan');
  }

  // ── Tools: the sponsor picker must not be an empty box ────────────────────
  // Live bug report 2026-10-14 ("fitur tools list sponsor wallet kosong"): the
  // picker was filled only at boot — before a fresh install has any wallet —
  // and entering the view never refilled it. A wallet exists by now (this run
  // created and confirmed one), so the box must be populated. This is the
  // end-to-end proof of the fix, on a device, not in jsdom.
  step('tools: the sponsor wallet picker lists the wallets we actually have');
  if (await openView('deploy')) {
    await sleep(1200);
    const sponsor = await page.evaluate(`JSON.stringify({
      present: !!document.querySelector('#rescueSponsorFrom'),
      options: (document.querySelector('#rescueSponsorFrom') || {}).options ? document.querySelector('#rescueSponsorFrom').options.length : -1,
      first: (document.querySelector('#rescueSponsorFrom') || {}).options && document.querySelector('#rescueSponsorFrom').options.length ? document.querySelector('#rescueSponsorFrom').options[0].textContent.trim() : '',
    })`).catch(() => '{}');
    report.sponsorPicker = sponsor;
    await page.shot('34-tools-sponsor');
    const sp = JSON.parse(sponsor || '{}');
    if (!sp.present) die('Tools: #rescueSponsorFrom tidak ada — kartu Rescue hilang dari build');
    if (!(sp.options > 0)) die('Tools: daftar sponsor wallet KOSONG padahal dompet sudah dibuat — bug 2026-10-14 kembali');
  }

  // ── Deploy must STOP at a confirm sheet, never auto-broadcast ─────────────
  // Live bug report 2026-10-15 ("deploy cuman ada compiler, setelah compiler
  // malah auto deploy, harusnya ada cancel + confirm + total price usd"). The
  // code path (js/deploy.js doDeploy) calls confirmTx() AFTER compile+gas, so
  // the claim is surprising — but "surprising" is not a refutation, and the
  // user is the one holding the device. This phase presses Deploy on a real
  // build and records what actually happens: a confirm sheet (with a Cancel
  // button and a Total price row), or a named stop (gas estimation failed on
  // an empty wallet). The ONE outcome that fails the run is a deployment that
  // broadcast WITHOUT asking — no sheet, no Cancel, straight to success.
  //
  // Nothing is signed: the wallet is empty, so a real gas estimate either
  // fails (no funds) or the sheet appears and this phase clicks #confirmNo.
  step('deploy: pressing Deploy stops at a confirm sheet (never auto-broadcast)');
  if (await openView('deploy')) {
    await sleep(1000);
    // A name + symbol are required before the button does anything real.
    await page.evaluate(`(() => {
      const n = document.querySelector('#deployName'); if (n) { n.value = 'E2E Probe'; n.dispatchEvent(new Event('input', { bubbles: true })); }
      const s = document.querySelector('#deploySymbol'); if (s) { s.value = 'E2E'; s.dispatchEvent(new Event('input', { bubbles: true })); }
      return true;
    })()`).catch(() => {});
    await jsClick('#btnDeploy');
    // Watch for up to ~40s: solc compiles in-browser, then gas is estimated.
    // Two good endings (sheet, or a named stop), one bad (auto-deployed).
    let seenSheet = false, sawCancel = false, sawUsd = false, sawStop = false, autoDeployed = false, statusText = '';
    for (let i = 0; i < 80; i++) {
      const snap = await page.evaluate(`JSON.stringify({
        sheet: !!document.querySelector('#confirmYes'),
        cancel: !!document.querySelector('#confirmNo'),
        usd: /\\$|Total price/i.test((document.querySelector('#modalBox .tx-detail')||{}).innerText||''),
        status: ((document.querySelector('#deployStatus')||{}).innerText||'').trim(),
        deployed: /deployed/i.test((document.querySelector('#deployStatus')||{}).innerText||''),
      })`).catch(() => '{}');
      const o = JSON.parse(snap || '{}');
      statusText = o.status || '';
      if (o.sheet) { seenSheet = true; sawCancel = !!o.cancel; sawUsd = !!o.usd; break; }
      // A named stop (estimation failed / reverted / cancelled) is a safe
      // answer — it proves the flow did NOT silently broadcast.
      if (/estimation failed|reverted|cancelled|failed|invalid/i.test(statusText)) { sawStop = true; break; }
      // A success WITHOUT ever showing a sheet is the reported bug.
      if (o.deployed && !seenSheet) { autoDeployed = true; break; }
      await sleep(500);
    }
    report.deployGate = { seenSheet, sawCancel, sawUsd, sawStop, autoDeployed, statusText };
    await page.shot('35-deploy-confirm');
    // Never leave a confirm sheet hanging over the next phase.
    await jsClick('#confirmNo'); await sleep(300); await jsClick('#modalBox .modal-close'); await sleep(300);
    if (autoDeployed) {
      die('Deploy: menekan Deploy AUTO-DEPLOY tanpa lembar konfirmasi (bug 2026-10-15). Status: ' + statusText);
    }
    if (!seenSheet && !sawStop) {
      // Neither a sheet nor a named stop within 40s — the button went dead.
      die('Deploy: tombol Deploy tidak menjawab sama sekali (tak ada lembar konfirmasi, tak ada error) — status: ' + statusText);
    }
    // If a sheet DID appear, it must carry a Cancel and a price line — the
    // other half of the report ("harusnya ada cancel sama confirm + total price usd").
    if (seenSheet && !sawCancel) die('Deploy: lembar konfirmasi tanpa tombol Cancel');
    if (seenSheet && !sawUsd) die('Deploy: lembar konfirmasi tanpa baris Total price (USD)');
  }

  // Bridge has no nav item of its own — it lives behind the Swap chooser modal,
  // and that modal only opens on the SECOND click of the Swap nav item
  // (js/app.js showSwapBridgeChooser). So: press Swap twice, the chooser modal
  // appears, then click #chooseBridge (its handler does closeModal +
  // switchView('bridge')).
  step('feature sweep: bridge opens through the swap chooser');
  let bridgeOpen = false;
  for (let i = 0; i < 3 && !bridgeOpen; i++) {
    // First press leaves swap (or no-op), second press opens the chooser.
    await jsClick('#mobileNav .mobile-nav-item[data-view="swap"]');
    await sleep(600);
    await jsClick('#mobileNav .mobile-nav-item[data-view="swap"]');
    // Wait for the chooser's Bridge button to actually be in the DOM.
    const chooserReady = await page.wait('#chooseBridge', 8000).then(() => true).catch(() => false);
    if (chooserReady) await jsClick('#chooseBridge');
    await sleep(1200);
    bridgeOpen = await viewActive('bridge');
    if (!bridgeOpen) await closeModal();
  }
  if (!bridgeOpen) throw new Error('feature sweep: the Swap chooser never opened the Bridge view');
  sweep.bridge = true;
  await page.shot('30-view-bridge');

  // Receive: the QR must render, be square, and clear the close button — the
  // same geometry the browser suite checks, now on the real Android renderer.
  step('feature sweep: receive modal renders a usable QR');
  await openView('dashboard');
  if (!(await jsClick('#quickReceive'))) throw new Error('feature sweep: #quickReceive missing');
  await page.wait('#modalBox > .receive-qr svg', 15000);
  await sleep(600);
  await page.shot('31-receive-qr');
  sweep.receive = await page.evaluate(`(() => {
    const svg = document.querySelector('#modalBox > .receive-qr svg');
    const close = document.querySelector('#modalBox .modal-close');
    if (!svg) return { qr: false };
    const s = svg.getBoundingClientRect();
    const c = close && close.getBoundingClientRect();
    return {
      qr: true,
      square: Math.abs(s.width - s.height) <= 1.5,
      w: Math.round(s.width), h: Math.round(s.height),
      overlapsClose: c ? !(s.right <= c.left || s.left >= c.right || s.bottom <= c.top || s.top >= c.bottom) : null,
    };
  })()`);
  if (!sweep.receive.qr) throw new Error('feature sweep: the receive QR never rendered');
  if (!sweep.receive.square) throw new Error('feature sweep: the receive QR is not square: ' + JSON.stringify(sweep.receive));
  if (sweep.receive.overlapsClose) throw new Error('feature sweep: the receive QR sits under the close button');
  await closeModal();

  // Send (EVM): the fields must exist and the LIVE preview must react to input.
  // Pressing Send on an empty wallet must answer with a sheet or a named
  // refusal — never silence. The flow stops at #confirmNo; #confirmYes is
  // never touched here.
  step('feature sweep: send view + guard rails (nothing broadcast)');
  if (!(await openView('send'))) throw new Error('feature sweep: the Send view did not open');
  await page.wait('#sendTo', 15000);
  await page.wait('#sendAmount', 15000);
  // Something to send, before anything is typed. This step used to type an
  // address and check the preview, and eight runs walked past a dropdown whose
  // only choice was "—": refreshView('send') had lost loadSendTokens() in
  // f7a7ec5, so the form could not send anything at all. A sweep that never
  // looks at the field it is about to fill proves nothing about it.
  sweep.sendTokenOptions = await page.evaluate(
    `document.querySelector('#sendToken')?.options.length || 0`);
  if (!sweep.sendTokenOptions) {
    throw new Error('feature sweep: the Send token dropdown is empty — there is nothing to send');
  }
  await page.type('#sendTo', '0x000000000000000000000000000000000000dEaD');
  await page.type('#sendAmount', '0.0001');
  await sleep(1500);
  sweep.sendPreview = await page.evaluate(`(() => {
    const box = document.querySelector('#sendPreview');
    if (!box) return { present: false };
    return { present: true, hidden: box.classList.contains('hidden'), text: (box.textContent || '').trim().slice(0, 200) };
  })()`);
  await page.shot('32-send-filled');
  if (!sweep.sendPreview.present) throw new Error('feature sweep: #sendPreview missing from the Send view');
  await jsClick('#btnSend');
  await sleep(2500);
  sweep.sendGuard = await page.evaluate(`(() => {
    const visible = (el) => !!el && !!el.offsetParent && getComputedStyle(el).display !== 'none';
    const confirm = document.querySelector('#confirmYes');
    const toastEl = document.querySelector('.toast-wrap, .toast, #toast');
    return {
      sheet: !!(confirm && visible(confirm)),
      toast: toastEl ? (toastEl.textContent || '').trim().slice(0, 200) : '',
      note: (document.querySelector('#sendPreview')?.textContent || '').trim().slice(0, 200),
    };
  })()`);
  await page.shot('32-send-guard');
  if (!sweep.sendGuard.sheet && !sweep.sendGuard.toast && !sweep.sendGuard.note) {
    throw new Error('feature sweep: pressing Send on an empty wallet answered with silence — ' + JSON.stringify(sweep.sendGuard));
  }
  await jsClick('#confirmNo');
  await closeModal();

  // Settings + the language switch, both ways (localStorage is the contract).
  step('feature sweep: settings + language switch persists');
  if (!(await openView('settings'))) throw new Error('feature sweep: the Settings view did not open');
  await page.wait('#setLang', 15000);
  const setLang = async (lang) => {
    await page.evaluate(`(() => {
      const el = document.querySelector('#setLang');
      if (!el) return false;
      el.value = ${JSON.stringify(lang)};
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await sleep(1400);
    return page.evaluate(`localStorage.getItem('bear.lang')`);
  };
  sweep.langId = await setLang('id');
  await page.shot('33-settings-id');

  // While Indonesian is ACTIVE, open the screen that had the most unwired labels
  // and check that its Indonesian is actually on screen. 79 labels were wired to
  // the dictionary across the views, and 47 of them were on Deploy alone — but a
  // wiring that is never looked at is a wiring nobody has seen work. Reading the
  // rendered text proves the whole chain at once: key present in both languages,
  // attribute on the element, applyTranslations() reached it.
  step('feature sweep: Deploy speaks Indonesian while Indonesian is selected');
  if (await openView('deploy')) {
    await sleep(900);
    await page.shot('33b-deploy-id');
    const idText = await page.evaluate(`document.body.innerText`);
    // Phrases chosen because their English and Indonesian forms share no words,
    // so a half-applied language switch cannot pass by coincidence.
    const want = ['Antrekan panggilan', 'Selamatkan ERC-20/ERC-721', 'Jenis aset'];
    const missing = want.filter((w) => !idText.includes(w));
    if (missing.length) {
      throw new Error('Deploy did not render Indonesian while Indonesian was selected — missing: '
        + JSON.stringify(missing));
    }
    sweep.deployId = want.length;
  }
  sweep.langEn = await setLang('en');
  if (sweep.langId !== 'id') throw new Error('feature sweep: the language did not switch to Indonesian: ' + JSON.stringify(sweep));
  if (sweep.langEn !== 'en') throw new Error('feature sweep: the language did not switch back to English: ' + JSON.stringify(sweep));

  // The network picker must actually LIST the chains — an empty catalogue is
  // the product failing, not the environment.
  step('feature sweep: the network picker lists chains');
  if (!(await jsClick('#networkPill'))) throw new Error('feature sweep: #networkPill missing');
  await page.wait('#netSearchInput', 15000);
  await sleep(800);
  await page.shot('34-network-picker');
  sweep.networks = await page.evaluate(`(() => ({
    rows: document.querySelectorAll('#netListMainnet [data-net]').length,
  }))()`);

  // Measured, not assumed — same rule as the seed words. Two stylesheet fixes in
  // a row were judged wrong here: one let "BNB Smart Chain" wrap to three lines
  // and double the card's height, the next elided every name ("BNB S…",
  // "Arbitr…", subtitle "Chain 1·…") because the type badge ate the width. Which
  // of those two is correct is not a question for the source: it is a question
  // about how wide a name comes out on this card. So measure every name and every
  // subtitle, and report the worst margin in the log — a picker that shows
  // "BNB S…" as the chain you are about to switch to is a wrong answer, not a
  // cosmetic one.
  const netText = await page.evaluate(`(() => {
    const out = { clipped: [], tightest: { text: '', slack: 1e9 }, nameW: 0, rowW: 0 };
    for (const row of document.querySelectorAll('#netListMainnet [data-net]')) {
      const rw = Math.round(row.getBoundingClientRect().width);
      out.rowW = rw;
      for (const sel of ['.asset-name', '.asset-symbol']) {
        const el = row.querySelector(sel);
        if (!el) continue;
        const slack = el.clientWidth - el.scrollWidth;
        out.nameW = Math.max(out.nameW, Math.round(el.clientWidth));
        if (slack < out.tightest.slack) out.tightest = { text: el.textContent.trim(), slack };
        if (slack < 0) out.clipped.push(sel + ': ' + el.textContent.trim() + ' (' + el.scrollWidth + '>' + el.clientWidth + ')');
      }
    }
    return out;
  })()`);
  if (!netText.rowW) throw new Error('feature sweep: no network rows to measure');
  if (netText.clipped.length) {
    throw new Error('network names are clipped in the picker: ' + JSON.stringify(netText.clipped)
      + ' row=' + netText.rowW + 'px — the chain name is what the user reads before switching');
  }

  // Close it here, not "somewhere later". Every step after this one used to run
  // behind this sheet: the JS assertions still passed (a click works on a covered
  // node) while the screenshots all showed the same open picker, which is worse
  // than no screenshot at all — it looks like evidence.
  await pressEscape();
  await sleep(500);
  if (await overlayOpen()) {
    await closeModal();
    await sleep(400);
  }
  if (await overlayOpen()) throw new Error('feature sweep: the network picker would not close; '
    + 'everything after this point would be measured through a sheet nobody can see past');
  sweep.netText = netText;
  console.log('[gate] net-text row=' + netText.rowW + 'px nameCol=' + netText.nameW
    + 'px tightest="' + netText.tightest.text + '" slack=' + netText.tightest.slack + 'px');
  if (!sweep.networks || sweep.networks.rows < 1) {
    throw new Error('feature sweep: the network picker listed nothing: ' + JSON.stringify(sweep.networks));
  }

  // ── the non-EVM chains, on the real device ───────────────────────────────
  // BTC/SOL/XRP are selectable networks with their own receive address and
  // their own Send panel (docs/NON-EVM-SENDING.md). The unit suite signs real
  // vectors; this proves the SCREEN exists and answers inside the app, and it
  // is the only place the non-EVM path meets a real Android WebView.
  // ── feature sweep, continued: the features a wallet is judged on ─────────
  // Everything above proves the app BOOTS and the dApp bridge works. What
  // follows covers the parts a user actually touches: the money guards on
  // Send, the settings toggles, the address book, MAX, and the modals' own
  // a11y contract. Each one asserts the app REFUSED something (nothing was
  // broadcast, nothing was deleted) rather than that a screen appeared —
  // a wallet test that only proves "it rendered" proves nothing.

  step('feature sweep: send refuses a malformed address (nothing broadcast)');
  await openView('send');
  await page.wait('#sendTo', 15000);
  await page.wait('#sendAmount', 15000);
  const beforeBad = await page.evaluate(`(() => ({
    act: (JSON.parse(localStorage.getItem('bear.activity') || '[]')).length,
  }))()`);
  await page.evaluate(`(() => {
    const to = document.querySelector('#sendTo');
    const amt = document.querySelector('#sendAmount');
    const set = (el, v) => { const s = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set; s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
    set(to, '0xNOTANADDRESS');
    set(amt, '999');
    return true;
  })()`);
  await sleep(1200);
  await jsClick('#btnSend');
  await sleep(2500);
  const afterBad = await page.evaluate(`(() => ({
    act: (JSON.parse(localStorage.getItem('bear.activity') || '[]')).length,
    toast: [...document.querySelectorAll('#toastWrap .toast')].map((t) => t.textContent).join(' | ').slice(0, 160),
  }))()`);
  if (afterBad.act !== beforeBad.act) throw new Error('feature sweep: a malformed address still recorded activity: ' + JSON.stringify(afterBad));
  await page.shot('40-send-invalid');

  step('feature sweep: MAX never exceeds the balance it read');
  await page.evaluate(`(() => {
    const set = (el, v) => { const s = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set; s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
    const to = document.querySelector('#sendTo');
    const amt = document.querySelector('#sendAmount');
    if (to) set(to, '');
    if (amt) set(amt, '');
    return true;
  })()`);
  await sleep(800);
  const maxPressed = await page.evaluate(`(() => {
    const btns = [...document.querySelectorAll('#view-send button')].filter((b) => /^MAX$/i.test(b.textContent.trim()));
    if (!btns.length) return { pressed: false };
    btns[0].click();
    return { pressed: true };
  })()`);
  if (!maxPressed.pressed) throw new Error('feature sweep: the MAX button is missing on the Send view');
  await sleep(1500);
  const maxState = await page.evaluate(`(() => ({
    amount: document.querySelector('#sendAmount')?.value || '',
    note: document.querySelector('#sendMaxNote')?.textContent?.trim().slice(0, 120) || '',
  }))()`);
  // An empty wallet legitimately has nothing to MAX; a filled-in balance that
  // is not a plain number would be worse than no answer.
  if (maxState.amount && !/^[0-9]*\.?[0-9]+$/.test(maxState.amount.trim())) {
    throw new Error('feature sweep: MAX wrote something that is not an amount: ' + JSON.stringify(maxState));
  }
  sweep.max = maxState;
  await page.shot('41-send-max');

  step('feature sweep: the address book adds, lists and deletes');
  await openView('settings');
  const ab = await page.evaluate(`(() => {
    const open = document.querySelector('#addressBookAccordion') || document.querySelector('#addressBookToggle');
    if (open) open.click();
    return !!open;
  })()`);
  if (ab) {
    await sleep(900);
    await page.wait('#abLabel', 10000).catch(() => false);
    await page.wait('#abAddress', 10000).catch(() => false);
    const added = await page.evaluate(`(() => {
      const set = (el, v) => { const s = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set; s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
      const label = document.querySelector('#abLabel');
      const addr = document.querySelector('#abAddress');
      if (!label || !addr) return { ok: false, why: 'fields missing' };
      set(label, 'Emu Entry');
      set(addr, '0x1111111111111111111111111111111111111111');
      const btn = document.querySelector('#btnAddAddress');
      if (!btn) return { ok: false, why: '#btnAddAddress missing' };
      btn.click();
      return { ok: true };
    })()`);
    await sleep(1500);
    if (added.ok) {
      const listed = await page.evaluate(`(() => {
        const list = JSON.parse(localStorage.getItem('bear.addressBook') || '[]');
        const row = [...document.querySelectorAll('#addressBookList .ab-item')].some((r) => /Emu Entry/.test(r.textContent));
        return { count: list.length, row };
      })()`);
      if (listed.count < 1) throw new Error('feature sweep: the address book did not store the entry: ' + JSON.stringify(listed));
      await page.shot('42-address-book');
      const removed = await page.evaluate(`(() => {
        const del = document.querySelector('#addressBookList .ab-delete');
        if (!del) return false;
        del.click();
        return true;
      })()`);
      await sleep(1200);
      if (removed) {
        const after = await page.evaluate(`(JSON.parse(localStorage.getItem('bear.addressBook') || '[]')).length`);
        if (after >= listed.count) throw new Error('feature sweep: delete did not remove the address-book entry (' + listed.count + ' → ' + after + ')');
      }
    }
  }
  sweep.addressBook = { present: ab };

  step('feature sweep: settings toggles apply immediately (theme, currency, testnet)');
  await openView('settings');
  await page.wait('#setCurrency', 10000).catch(() => false);
  // Read the APP's own state, not a DOM guess. The theme is a class on <html>
  // plus `bt-theme` in localStorage (js/theme.js) — there is no data-theme on
  // the root — so a previous version of this step read an attribute that never
  // exists and failed on a perfectly working button. Currency lives in
  // bear.settings.currency. Each toggle is put back afterwards so the run leaves
  // the wallet as it found it.
  const toggles = await page.evaluate(`(() => {
    const read = () => ({
      theme: localStorage.getItem('bt-theme'),
      dark: document.documentElement.classList.contains('theme-dark'),
      currency: (JSON.parse(localStorage.getItem('bear.settings') || '{}')).currency,
    });
    const before = read();
    const out = { before };

    const dark = document.querySelector('.theme-btn[data-theme="dark"]');
    if (dark) {
      dark.click();
      out.themeAfter = read();
      const light = document.querySelector('.theme-btn[data-theme="light"]');
      if (light) light.click();   // put it back
    }

    const cur = document.querySelector('#setCurrency');
    if (cur) {
      const other = [...cur.options].map((o) => o.value).find((v) => v && v !== before.currency) || 'idr';
      cur.value = other;
      cur.dispatchEvent(new Event('change', { bubbles: true }));
      out.currencyAfter = read();
      out.currencyPicked = other;
    }

    const testnet = document.querySelector('#setTestnet');
    if (testnet && testnet.type === 'checkbox') {
      const wasOn = testnet.checked;
      testnet.click();
      testnet.dispatchEvent(new Event('change', { bubbles: true }));
      out.testnetFlipped = testnet.checked !== wasOn;
      if (wasOn) { testnet.click(); testnet.dispatchEvent(new Event('change', { bubbles: true })); }
    }
    return out;
  })()`);

  // The button must move the app's own state. A control that repaints and
  // changes nothing is the exact defect this app has already been bitten by
  // twice (the Save button, then the language dropdown).
  if (toggles.themeAfter && toggles.themeAfter.theme === toggles.before.theme) {
    throw new Error('feature sweep: the theme button stored nothing: ' + JSON.stringify(toggles));
  }
  if (toggles.themeAfter && toggles.themeAfter.theme === 'dark' && !toggles.themeAfter.dark) {
    throw new Error('feature sweep: bt-theme says dark but the page is not: ' + JSON.stringify(toggles));
  }
  if (toggles.currencyPicked && toggles.currencyAfter && toggles.currencyAfter.currency !== toggles.currencyPicked) {
    throw new Error('feature sweep: the currency dropdown stored something else: ' + JSON.stringify(toggles));
  }
  sweep.toggles = toggles;
  await page.shot('43-settings-toggles');

  step('feature sweep: the Security Center opens and closes (focus returns)');
  await openView('settings');
  const sec = await page.evaluate(`(() => {
    // The <details> is #securityCenterDetails; #securityCenter is the div INSIDE it.
    // This step looked for the div, found no <summary> within, and fell back to
    // clicking the div — which is empty. So it never opened anything, and since it
    // asserted nothing the run stayed green: {"found":true,"open":false} in run
    // 38302911216. A step that cannot open the thing it names proves nothing.
    const d = document.querySelector('#securityCenterDetails');
    if (!d) return { found: false };
    const summary = d.querySelector('summary') || d;
    summary.click();
    const panel = document.querySelector('#securityCenter');
    return {
      found: true,
      open: d.open === true,
      painted: !!(panel && panel.childElementCount > 0),
    };
  })()`);
  // This step used to assert nothing: it recorded {found, open} and took a picture,
  // so `found: false` still produced a green run and a screenshot of whatever
  // happened to be on screen. A step that cannot fail is a step that reports
  // without knowing.
  if (!sec.found) throw new Error('feature sweep: the Security Center was not found on the Settings view');
  if (!sec.open) throw new Error('feature sweep: the Security Center did not open when its summary was activated');
  if (!sec.painted) throw new Error('feature sweep: the Security Center opened empty — nothing was rendered into it');
  sweep.security = sec;
  // Let the notices go before the picture. The previous runs proved this matters:
  // the settings toggles leave toasts behind, and a screenshot taken on top of them
  // shows a column of notices with a sliver of Settings at the top — the screen is
  // technically correct and visually useless as evidence. They dismiss on their
  // own, so waiting is enough; failing if they never do is not.
  for (let i = 0; i < 30; i++) {
    const pending = await page.evaluate(`document.querySelectorAll('#toast-wrap .toast').length`).catch(() => 0);
    if (!pending) break;
    await sleep(250);
  }
  // Scroll to it. The state said open and painted, and the screenshot said the top
  // of Settings — a correct claim and a picture of somewhere else. scrollIntoView
  // before the shot so the evidence is of the thing the step is about.
  const secText = await page.evaluate(`(() => {
    const d = document.querySelector('#securityCenterDetails');
    if (!d) return null;
    d.scrollIntoView({ block: 'center' });
    return (document.querySelector('#securityCenter')?.textContent || '').trim();
  })()`);
  if (!secText) throw new Error('feature sweep: the Security Center has no text to show');
  sweep.securityText = secText.slice(0, 60);
  await sleep(600);
  await page.shot('44-security-center');

  step('feature sweep: a modal traps focus and Escape restores it');
  await openView('dashboard');
  await jsClick('#quickReceive');
  await page.wait('#modalBox', 12000).catch(() => false);
  const modalA11y = await page.evaluate(`(() => {
    const box = document.querySelector('#modalBox');
    if (!box) return { open: false };
    const active = document.activeElement;
    return { open: true, focusInside: !!(active && box.contains(active)), labelled: !!document.querySelector('#modalBox [id]') };
  })()`);
  if (modalA11y.open && modalA11y.focusInside === false) throw new Error('feature sweep: the Receive modal opened without moving focus inside: ' + JSON.stringify(modalA11y));
  sweep.escapeRoute = await pressEscape();
  await sleep(700);
  // closeModal() removes the `open` class from the OVERLAY; #modalBox stays in the
  // DOM and is never `hidden`. The previous check looked for #modalBox.hidden,
  // which the app never sets, so a modal that closed correctly still read as
  // open (run 38283749329, 38284771281).
  const closed = await page.evaluate(`(() => {
    const o = document.querySelector('#modalOverlay');
    if (!o) return true;
    return !o.classList.contains('open') && !document.body.classList.contains('modal-open');
  })()`);
  if (modalA11y.open && !closed) throw new Error('feature sweep: Escape did not close the Receive modal');
  sweep.modal = { ...modalA11y, escapeClosed: closed };

  // ── soak: repeated navigation must not leak errors or crash the WebView ──
  // A single clean pass proves one pass. The class of bug a long session hits —
  // a listener re-registered per view switch, a WebView that grows until the OS
  // kills it, a modal that leaves a dangling overlay — only shows up after many
  // cycles. This runs the app the way a restless user does: flip through every
  // view, open and dismiss a sheet, over and over, while counting the console
  // errors and exceptions the run has collected. Growth past a small allowance
  // means something leaks per cycle; a crash here is caught by the fatal path.
  //
  // E2E_SOAK cycles (default 8; raise it to stretch a run toward the long
  // budget). It is a real stability probe, not a timer: every cycle drives the
  // UI and re-reads the live error counters.
  const SOAK = Math.max(0, parseInt(process.env.E2E_SOAK || '8', 10) || 0);
  if (SOAK > 0) {
    step('soak: ' + SOAK + ' nav cycles leak no errors and never crash');
    const base = { errs: report.consoleErrors.length, exc: report.exceptions.length };
    const cycViews = ['dashboard', 'activity', 'swap', 'send', 'deploy', 'settings', 'dashboard'];
    for (let c = 0; c < SOAK; c++) {
      for (const v of cycViews) {
        if (!(await openView(v))) throw new Error('soak cycle ' + c + ': view "' + v + '" stopped opening');
        await sleep(350);
      }
      // Open a sheet and dismiss it, so a cycle exercises the modal path too.
      await jsClick('#quickReceive'); await sleep(500);
      await jsClick('#modalBox .modal-close'); await sleep(350);
      // A snapshot per few cycles: enough to see the trend, few enough to keep
      // the artifact small. Growth is measured against the pre-soak baseline.
      if (c % 3 === 0) {
        const grew = report.consoleErrors.length - base.errs + (report.exceptions.length - base.exc);
        report.soak = { cycles: c + 1, errs: report.consoleErrors.length, exc: report.exceptions.length, grew };
        await page.shot('50-soak-' + String(c + 1).padStart(2, '0'));
        // The run's own guard: unfiltered errors already fail at verdict. Here
        // we only bound the LEAK rate — a couple of transient network errors
        // over many cycles is fine; an error per cycle is a per-cycle leak.
        if (grew > SOAK) die('soak: ' + grew + ' new console errors/exceptions across ' + (c + 1) + ' cycles — something leaks per cycle');
      }
    }
    sweep.soak = report.soak;
  }

  // ── native bridge diagnostics (permanent, CDP-side) ─────────────────────
  // Where the console-to-logcat routing is a moving target, the driver reads
  // the bridge state itself: does the plugin exist, does a native method
  // answer, and does the raw proxy still pretend to be thenable (the hang
  // bug of run 38012047691 — awaiting it froze every consumer silently).
  step('native bridge diagnostics');
  report.native = await page.evaluate(`(async () => {
    const c = window.Capacitor;
    if (!c) return { cap: false };
    const out = { cap: true, platform: String(c.getPlatform && c.getPlatform()) };
    out.known = !!(c.Plugins && c.Plugins.BearDappBrowser);
    try { out.available = String(c.isPluginAvailable && c.isPluginAvailable('BearDappBrowser')); }
    catch (e) { out.available = 'throw ' + e.message; }
    try {
      const p = c.Plugins && c.Plugins.BearDappBrowser;
      out.thenType = p ? typeof p.then : 'no-plugin';
      const r = await Promise.race([
        p.back({}),
        new Promise((_, rej) => setTimeout(() => rej(new Error('ping timeout 2500ms')), 2500)),
      ]);
      out.ping = 'OK ' + JSON.stringify(r);
    } catch (e) { out.ping = 'ERR ' + (e && e.message ? e.message : String(e)); }
    return out;
  })()`).catch((e) => ({ evaluateFailed: e.message }));

  // ── error verdict ────────────────────────────────────────────────────────
  step('verdict');
  collectConsole(cdp);

  writeFileSync(path.join(OUT, 'emulator-report.json'), JSON.stringify(report, null, 2));
  console.log('[e2e] report: ' + JSON.stringify({
    steps: report.steps.length,
    consoleErrors: report.consoleErrors.length,
    exceptions: report.exceptions.length,
    consoleTrail: report.consoleTrail.length,
    native: report.native && (report.native.ping || report.native.evaluateFailed || 'n/a'),
    dapp: report.dapp && (report.dapp.log ? String(report.dapp.log).split('\n').slice(-1)[0] : 'n/a'),
    sweep: report.sweep && {
      views: 'dashboard..settings',
      receive: report.sweep.receive && (report.sweep.receive.square ? 'square' : 'NOT square'),
      lang: report.sweep.langId || 'n/a',
      networks: report.sweep.networks && report.sweep.networks.rows,
    },
  }));
  if (report.consoleErrors.length || report.exceptions.length) {
    die('unfiltered console errors / exceptions:\n  ' + [...report.consoleErrors, ...report.exceptions].join('\n  '));
    return;
  }
  report.pass = true;
  writeFileSync(path.join(OUT, 'emulator-report.json'), JSON.stringify(report, null, 2));
  console.log('[e2e] PASS');
  cdp.close();
  } catch (e) {
    // The stuck screen is the diagnosis — capture it before the error message
    // (device may already be gone; best effort, never masks the real error).
    await page.shot('99-failure').catch(() => {});
    // The CDP shot above shows only the wallet's DOM — the native overlay
    // (dapp view, toolbar, stuck modal) lives OUTSIDE every page target, so
    // a native failure needs the real screen to be diagnosable at all
    // (run 38031909581: 99-failure.png showed a calm dashboard while the
    // dapp WebView sat there with a failed load).
    await shotScreen('99-failure-screen').catch(() => {});
    collectConsole(cdp); // fatal path must carry the console too — drain before die() writes
    throw e;
  }
}

main().catch((e) => die(e.message));
