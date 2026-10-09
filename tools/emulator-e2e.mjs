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
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

const ADB = process.env.ADB || 'adb';
const SERIAL = process.env.EMULATOR_SERIAL || '';
const OUT = process.env.E2E_OUT || 'emulator-artifacts';
const PASSWORD = 'e2e-bear-123';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const adb = (...args) =>
  execFileSync(ADB, SERIAL ? ['-s', SERIAL, ...args] : args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

// Console noise that is known, external, and not this app's fault.
const ALLOWED_CONSOLE = [
  /coingecko/i, /statsig/i, /amplitude/i, /attestation/i,
  /Failed to fetch/i, /net::ERR/i, /walletconnect/i, /mixpanel/i,
];

// ── minimal CDP client ─────────────────────────────────────────────────────
function cdpClient(ws) {
  let seq = 0;
  const pending = new Map();
  const events = [];
  ws.on('message', (buf) => {
    const msg = JSON.parse(String(buf));
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    } else if (msg.method) {
      events.push({ method: msg.method, params: msg.params, at: Date.now() });
    }
  });
  return {
    events,
    send(method, params = {}) {
      const id = ++seq;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
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
      const targets = await (await fetch('http://127.0.0.1:9333/json')).json();
      const page = targets.find((t) => t.type === 'page') || targets[0];
      if (!page || !page.webSocketDebuggerUrl) throw new Error('no page target');
      const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
      await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
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
      throw new Error(`timeout waiting for ${sel}`);
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
  const report = { steps: [], consoleErrors: [], exceptions: [], pass: false };
  const step = (name) => { report.steps.push(name); console.log('[e2e] ' + name); };

  const cdp = await connectCDP();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  const page = makePage(cdp);

  step('boot: welcome screen');
  await page.wait('#wCreate', 30000);
  await sleep(600);
  await page.shot('01-welcome');

  step('create wallet');
  await page.click('#wCreate');
  await page.wait('#createPw');
  await page.type('#createName', 'CI Bear');
  await page.type('#createPw', PASSWORD);
  await page.type('#createPw2', PASSWORD);
  await page.click('#createBtn');
  await page.wait('.seed-word');
  await page.shot('02-seed-phrase');

  step('seed confirmation (3 positions, read the app\u2019s own question)');
  for (let i = 0; i < 3; i++) {
    const label = await page.evaluate(`document.querySelector('#seedQLabel').textContent`);
    const n = Number((label.match(/#(\d+)/) || [])[1]);
    if (!n) throw new Error('cannot parse seed question: ' + label);
    const word = await page.evaluate(`document.querySelectorAll('.seed-word')[${n - 1}].querySelector('span').textContent`);
    await page.click(`.seed-choice-btn[data-word="${word}"]`);
    await sleep(700); // app reshuffles after each answer
  }
  await page.wait('#seedDone:not([disabled])', 8000);
  await page.shot('03-seed-confirmed');
  await page.click('#seedDone');

  step('dashboard');
  await page.wait('#view-dashboard.active, .balance-card, #totalBalance', 25000);
  await sleep(1500); // numbers settle
  const address = await page.evaluate(`(window.localStorage.getItem('bear.activeAccount') || '')`).catch(() => '');
  report.address = address;
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
  const all = cdp.events;
  for (const ev of all) {
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
    console.error('[e2e] FAIL — unfiltered console errors / exceptions:');
    for (const e of [...report.consoleErrors, ...report.exceptions]) console.error('  ' + e);
    process.exit(1);
  }
  report.pass = true;
  writeFileSync(path.join(OUT, 'emulator-report.json'), JSON.stringify(report, null, 2));
  console.log('[e2e] PASS');
}

main().catch((e) => { console.error('[e2e] FATAL: ' + e.message); process.exit(1); });
