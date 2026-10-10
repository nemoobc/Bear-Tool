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

// Console noise that is known, external, and not this app's fault.
const ALLOWED_CONSOLE = [
  /coingecko/i, /statsig/i, /amplitude/i, /attestation/i,
  /Failed to fetch/i, /net::ERR/i, /walletconnect/i, /mixpanel/i,
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
    send(method, params = {}) {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP timeout ${CDP_TIMEOUT_MS}ms: ${method}`));
        }, CDP_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timer });
        try { ws.send(JSON.stringify({ id, method, params })); }
        catch (e) { clearTimeout(timer); pending.delete(id); reject(e); }
      });
    },
    close() { try { ws.close(); } catch { /* already gone */ } },
  };
}

async function connectCDP() {
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
      const page = targets.find((x) => x.type === 'page') || targets[0];
      if (!page || !page.webSocketDebuggerUrl) throw new Error('no page target');
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
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(OUT, name + '.png');
      writeFileSync(file, Buffer.from(data, 'base64'));
      return file;
    },
  };
}

// ── journey ────────────────────────────────────────────────────────────────
async function main() {
  mkdirSync(OUT, { recursive: true });
  report = { steps: [], consoleErrors: [], exceptions: [], pass: false };
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

  // ── error verdict ────────────────────────────────────────────────────────
  step('verdict');
  for (const ev of cdp.events) {
    if (ev.method === 'Runtime.consoleAPICalled' && ev.params.type === 'error') {
      const text = (ev.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
      if (!ALLOWED_CONSOLE.some((re) => re.test(text))) report.consoleErrors.push(text.slice(0, 400));
    }
    if (ev.method === 'Runtime.exceptionThrown') {
      const d = ev.params.exceptionDetails;
      report.exceptions.push((d.exception?.description || d.text || 'unknown').slice(0, 500));
    }
  }

  writeFileSync(path.join(OUT, 'emulator-report.json'), JSON.stringify(report, null, 2));
  console.log('[e2e] report: ' + JSON.stringify({ steps: report.steps.length, consoleErrors: report.consoleErrors.length, exceptions: report.exceptions.length }));
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
    throw e;
  }
}

main().catch((e) => die(e.message));
