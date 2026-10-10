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

// Tap a native control by accessibility label: uiautomator is the only eye
// that sees OUTSIDE the WebView (the plugin's toolbar buttons on top of the
// dApp), and a real tap is the only honest click a native overlay admits.
async function tapNativeButton(desc) {
  for (let i = 0; i < 12; i++) {
    try {
      adb('shell', 'uiautomator', 'dump', '/sdcard/uidump.xml');
      const xml = adb('shell', 'cat', '/sdcard/uidump.xml');
      const node = xml.match(new RegExp('content-desc="' + desc + '"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"'));
      if (node) {
        const x1 = +node[1], y1 = +node[2], x2 = +node[3], y2 = +node[4];
        adb('shell', 'input', 'tap', String((x1 + x2) >> 1), String((y1 + y2) >> 1));
        return true;
      }
    } catch { /* dump races the UI — retry */ }
    await sleep(1000);
  }
  return false;
}

// Console noise that is known, external, and not this app's fault.
const ALLOWED_CONSOLE = [
  /coingecko/i, /statsig/i, /amplitude/i, /attestation/i,
  /Failed to fetch/i, /net::ERR/i, /walletconnect/i, /mixpanel/i,
  // Upstream Capacitor v8.5.2, NOT this app: SystemBars.java injects its
  // safe-area CSS into a documentElement that does not exist yet at boot
  // (node_modules/@capacitor/android/capacitor/src/main/java/.../SystemBars.java;
  // seen as 3x "Error injecting safe area CSS ... reading 'style'" in run
  // 38012047691). Harmless on notch-less devices, unfixable from JS — the
  // gate stays on for OUR errors and lets this one through deliberately.
  /Error injecting safe area CSS/i,
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
// path never ran this transfer, and the coingecko CORS errors sitting on the
// wire were only visible from logcat.
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
  await page.wait('#wCreate', 30000);
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

    step('dapp browser: connect prompt — flashed to the wallet');
    await page.wait('#confirmYes', 20000);
    report.dapp.askTitle = await page.evaluate(
      'document.querySelector(".question") ? document.querySelector(".question").textContent : ""'
    ).catch(() => '');
    report.dapp.askRows = await page.evaluate(
      `Array.from(document.querySelectorAll('.tx-detail .row')).map((r) => (r.querySelector('.k') ? r.querySelector('.k').textContent : '') + '=' + (r.querySelector('.v') ? r.querySelector('.v').textContent : ''))`
    ).catch(() => []);
    // Whole screen, not the DOM: if flash-to-wallet works, this shot shows the
    // wallet's modal — not the fixture page still open underneath it.
    await shotScreen('06-dapp-connect-modal');
    await page.click('#confirmYes');

    step('dapp browser: fixture reads accounts over its own CDP target');
    text = await pollOut(/done=/, 60000);
    drainDapp();
    report.dapp.log = String(text).slice(0, 500);
    report.dapp.console = dappEvents.slice(0, 20);
    for (const key of ['hasProvider=true', 'chainId=0x', 'account0=0x', 'accountsAgain=0x', 'done=ok']) {
      if (!String(text).includes(key)) throw new Error(`fixture log missing ${key}:\n${text}`);
    }
    // The account the fixture received must be the account the modal named.
    const acc = (String(text).match(/account0=(0x[0-9a-fA-F]{40})/) || [])[1] || '';
    const shown = (report.dapp.askRows || []).find((r) => r.startsWith('Account=')) || '';
    if (acc && !shown) throw new Error(`modal has no Account row to cross-check ${acc} against: ${JSON.stringify(report.dapp.askRows)}`);
    if (acc && shown) {
      const short = shown.slice('Account='.length); // shortAddr: 0x1234…abcd
      const head = short.slice(0, 6), tail = short.slice(-4);
      if (!acc.toLowerCase().startsWith(head.toLowerCase().replace('…', '')) || !acc.toLowerCase().endsWith(tail.toLowerCase())) {
        throw new Error(`modal account ${short} does not match fixture account ${acc}`);
      }
      report.dapp.accountMatchesModal = true;
    }
    await dpage.shot('07-dapp-fixture').catch(() => {});
    await shotScreen('07-dapp-screen'); // whole screen incl the native toolbar

    step('dapp browser: native back (real tap) returns to the wallet');
    report.dapp.backTapped = await tapNativeButton('dapp-back');
    if (!report.dapp.backTapped) throw new Error('uiautomator never found the dapp-back toolbar button');
    await sleep(1500);
    await page.wait('#view-dashboard.active, .balance-card, #totalBalance', 15000).catch(() => {});
    report.dapp.backToWallet = await page.evaluate(`!!document.querySelector('#view-dashboard.active, .balance-card')`).catch(() => false);
    if (!report.dapp.backToWallet) throw new Error('native back did not return the wallet to view');
    await shotScreen('08-back-to-wallet');
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
