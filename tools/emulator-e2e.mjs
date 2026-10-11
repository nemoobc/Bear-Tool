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
const PASSWORD = 'e2e-bear-123';

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
  const xml = dumpUi();
  if (!xml) return [];
  return (xml.match(/text="([^"]*)"/g) || []).map((m) => m.slice(6, -1)).filter((t) => t.trim());
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
  try {
    if (report) {
      report.fatal = msg;
      report.pass = false;
      writeFileSync(path.join(OUT, 'emulator-report.json'), JSON.stringify(report, null, 2));
    }
  } catch { /* report dir gone — stderr below still matters */ }
  process.stderr.write('[e2e] FATAL: ' + msg + '\n', () => process.exit(1));
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
  for (let i = 0; i < 30; i++) { // the WebView socket appears after app boot
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
    } catch (e) { lastErr = e; await sleep(2000); }
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
    if (ev.method === 'Runtime.exceptionThrown') {
      const d = ev.params.exceptionDetails;
      report.exceptions.push((d.exception?.description || d.text || 'unknown').slice(0, 500));
    }
  }
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  report = { steps: [], consoleErrors: [], consoleTrail: [], exceptions: [], native: null, dapp: null, pass: false };
  const step = (name) => { report.steps.push(name); markStep(name); };

  const cdp = await connectCDP();
  markStep('cdp connected');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  const page = makePage(cdp);

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
  await page.type('#createPw', PASSWORD);
  await page.type('#createPw2', PASSWORD);
  step('submit create');
  await page.click('#createBtn');
  await page.wait('.seed-word');
  step('seed phrase visible');
  await page.shot('02-seed-phrase');

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
    // langsung keluar").
    report.dapp.sheetVisibility = await dpage.evaluate('document.visibilityState').catch(() => '?');
    report.dapp.sheetTexts = await readSheetTexts();
    if (report.dapp.sheetVisibility !== 'visible') {
      throw new Error('dApp was hidden under the connect sheet: ' + report.dapp.sheetVisibility);
    }
    if (!report.dapp.sheetTexts.some((t) => /Connect/.test(t))) {
      throw new Error('native sheet has no Connect title: ' + JSON.stringify(report.dapp.sheetTexts));
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
