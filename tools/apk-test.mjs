#!/usr/bin/env node
// Bear Tool — tools/apk-test.mjs
//
// Smoke-tests the built APK on a REAL Android device in the BrowserStack
// App Automate cloud, straight from the terminal:
//
//   1. open a WebDriver session (the uploaded bs:// app, Galaxy S23/13.0)
//   2. wait out the 1.2s splash and let the web bundle boot
//   3. read the available contexts — a Capacitor app is a WebView, so the
//      DOM is reachable ONLY when webContentsDebuggingEnabled is on; when it
//      is off the context list comes back NATIVE_APP only and the honest
//      assertion is "the package I built is what is running"
//   4. take a screenshot (the evidence that survives either path)
//   5. close the session — never leave a paid device spinning
//
// Written against raw W3C WebDriver REST (global fetch, Node >= 18) instead of
// a client library: the protocol is four endpoints, a dependency would be
// heavier than the thing it wraps, and every response this prints is the
// response the cloud actually gave.
//
// Usage:
//   node tools/apk-test.mjs                 # upload apk/app-debug.apk if needed, then test
//   node tools/apk-test.mjs bs://<id>       # test an already-uploaded app
//   BROWSERSTACK_USERNAME / BROWSERSTACK_ACCESS_KEY come from .env (gitignored)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const API = 'https://api-cloud.browserstack.com';
const HUB = 'https://hub-cloud.browserstack.com/wd/hub'; // App Automate endpoint
const APP = 'apk/app-debug.apk';
const PKG = 'com.nemoobc.beartool';
const DEVICE = { deviceName: 'Samsung Galaxy S23', platformVersion: '13.0' };

// .env first (gitignored credentials), then the process environment.
try { process.loadEnvFile('.env'); } catch { /* fall back to exported env */ }
const USER = process.env.BROWSERSTACK_USERNAME;
const KEY = process.env.BROWSERSTACK_ACCESS_KEY;
if (!USER || !KEY) {
  console.error('apk-test: BROWSERSTACK_USERNAME / BROWSERSTACK_ACCESS_KEY kosong (isi .env)');
  process.exit(2);
}
const auth = 'Basic ' + Buffer.from(`${USER}:${KEY}`).toString('base64');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** fetch with its own timeout — a cloud session can take minutes to schedule. */
async function req(url, { method = 'GET', body, timeout = 240_000, raw = false } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        authorization: auth,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (raw) return { status: res.status, text };
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 400) }; }
    return { status: res.status, json };
  } finally {
    clearTimeout(t);
  }
}

/** W3C session id lives at value.sessionId (or legacy sessionId). */
const sidOf = (j) => j?.value?.sessionId || j?.sessionId;

async function uploadApp() {
  const form = new FormData();
  form.append('file', new Blob([readFileSync(APP)], { type: 'application/vnd.android.package-archive' }), 'app-debug.apk');
  form.append('custom_id', 'BearTool-dev');
  const res = await fetch(`${API}/app-automate/upload`, {
    method: 'POST', headers: { authorization: auth }, body: form,
  });
  const j = await res.json().catch(() => ({}));
  if (res.status !== 200 || !j.app_url) throw new Error(`upload gagal: ${res.status} ${JSON.stringify(j)}`);
  return j.app_url;
}

async function main() {
  const appUrl = process.argv[2] || (existsSync(APP) ? await uploadApp() : null);
  if (!appUrl) throw new Error(`tidak ada app: jalankan dengan argumen bs://… atau taruh ${APP}`);
  console.log('app      ', appUrl);

  // ── 1. session ────────────────────────────────────────────────────────────
  console.log('session  ', 'membuka di cloud… (antrian device)');
  const s = await req(`${HUB}/session`, {
    method: 'POST',
    body: {
      capabilities: {
        alwaysMatch: {
          platformName: 'Android',
          'appium:automationName': 'UiAutomator2',
          'appium:app': appUrl,
          'appium:deviceName': DEVICE.deviceName,
          'appium:platformVersion': DEVICE.platformVersion,
          // No appPackage/appActivity on purpose: R8 minified the launch
          // activity, and spelling it by hand failed twice — once with the
          // original name, once with the shortened "c" the cloud itself
          // reported as supported. Resolving the launcher intent from the
          // manifest reads the APK as it is, not as we guess it.
          'bstack:options': {
            userName: USER,
            accessKey: KEY,
            projectName: 'Bear Tool',
            buildName: 'apk-smoke',
            debug: true,
            networkLogs: true,
          },
        },
      },
    },
    timeout: 300_000,
  });
  const sid = sidOf(s.json);
  if (!sid) throw new Error(`session gagal: ${s.status} ${JSON.stringify(s.json).slice(0, 500)}`);
  console.log('session  ', sid);

  const step = { sessionId: sid, app: appUrl, device: `${DEVICE.deviceName} / ${DEVICE.platformVersion}` };
  try {
    // ── 2. splash (1200ms) + bundle boot ────────────────────────────────────
    await sleep(8_000);

    // ── 3. contexts: WEBVIEW available? ─────────────────────────────────────
    const c = await req(`${HUB}/session/${sid}/contexts`);
    step.contexts = c.json?.value ?? c.json;
    const webview = Array.isArray(step.contexts) && step.contexts.find((x) => /WEBVIEW/i.test(String(x)));
    step.contextSelected = webview || 'NATIVE_APP';

    if (webview) {
      await req(`${HUB}/session/${sid}/context`, { method: 'POST', body: { name: webview } });
      const el = await req(`${HUB}/session/${sid}/element`, {
        method: 'POST',
        body: { using: 'css selector', value: '#wCreate' },
      });
      const found = !!el.json?.value && (typeof el.json.value === 'object' ? el.json.value['element-6066-11e4-a52e-4f735466cecf'] : el.json.value);
      step.dom = found ? 'CREATE-WALLET TERELEKUT' : `tidak ketemu (${el.status})`;
      step.verdict = !!found;
    } else {
      // WebView debugging is off (capacitor.config.json) — the only honest
      // DOM-free assertion: the installed package is the one that was built.
      const src = await req(`${HUB}/session/${sid}/source`);
      const xml = src.json?.value || '';
      step.nativeSourceHasPackage = String(xml).includes(PKG);
      step.nativeSourceBytes = String(xml).length;
      step.dom = 'WEBVIEW tak tersedia (webContentsDebuggingEnabled:false) — assert native source';
      step.verdict = step.nativeSourceHasPackage;
    }

    // ── 4. screenshot = evidence ────────────────────────────────────────────
    const shot = await req(`${HUB}/session/${sid}/screenshot`);
    if (shot.json?.value) {
      mkdirSync('artifacts', { recursive: true });
      const file = `artifacts/apk-smoke-${Date.now()}.png`;
      writeFileSync(file, Buffer.from(shot.json.value, 'base64'));
      step.screenshot = file;
    }

    console.log('contexts ', JSON.stringify(step.contexts));
    console.log('dom      ', step.dom);
    console.log('shot     ', step.screenshot || '(tidak ada)');
    console.log(step.verdict ? 'VERDICT  OK ✓' : 'VERDICT  GAGAL ✗');
    if (!step.verdict) process.exitCode = 1;
  } finally {
    // ── 5. quit — a device left running costs minutes of a trial quota ──────
    await req(`${HUB}/session/${sid}`, { method: 'DELETE', timeout: 60_000 }).catch(() => {});
    console.log('closed   ', sid);
  }
}

main().catch((e) => { console.error('apk-test:', e.message); process.exit(1); });
