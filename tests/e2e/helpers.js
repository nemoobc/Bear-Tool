// Bear Tool — shared helpers for the Playwright E2E suite.
import { expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// M2 moved the view markup out of index.html into src/views/*.jsx (React
// renders it into the shell at boot), so the served DOM = shell + views.
// Static specs must read BOTH or every id that moved reads as absent — CI
// 36930970112 failed tools-merge ×2, sidebar-order ×1, picker-casing ×1 on
// indexOf/toMatch against the shell alone. Composition order follows the
// render order in src/App.jsx (extracted, not hardcoded): assertions slice
// between sections (e.g. view-deploy → view-activity) and DOM order is
// real order. Same composition as tests/full-audit.test.mjs, one source.
export const staticHtml = (() => {
  const root = new URL('../../', import.meta.url);
  let src = readFileSync(new URL('index.html', root), 'utf8');
  const app = readFileSync(new URL('src/App.jsx', root), 'utf8');
  const renderOrder = [...app.matchAll(/from '\.\/views\/([\w-]+)\.jsx'/g)].map((m) => m[1]);
  const files = readdirSync(new URL('src/views/', root)).filter((f) => f.endsWith('.jsx'));
  const known = new Set(renderOrder);
  const ordered = [
    ...renderOrder.map((n) => `${n}.jsx`),
    // A view not yet wired into App.jsx still exists on disk — keep it
    // visible at the end rather than silently dropping it.
    ...files.filter((f) => !known.has(f.replace(/\.jsx$/, ''))),
  ];
  for (const f of ordered) {
    src += `\n<!-- view: ${f} -->\n` + readFileSync(new URL(`src/views/${f}`, root), 'utf8');
  }
  return src;
})();

// Known benign console message: a <meta http-equiv="X-Frame-Options"> is
// ignored by browsers (must be an HTTP header). Reported as a finding, not a
// test failure — it does not break the app.
export const ALLOWED_CONSOLE = [
  'X-Frame-Options may only be set via an HTTP header',
];

// ---------------------------------------------------------------------------
// Fork plumbing — shared by every spec that needs a REAL chain behind the app
// (11-onchain-fork sends on it; 17-max-amount measures MAX against it).
// ---------------------------------------------------------------------------

// fileURLToPath, not URL.pathname: the pathname of a file: URL is a
// percent-encoded POSIX string, and on Windows it comes back as "/C:/Users/…",
// which cwd then resolves to "C:\C:\Users\…". run-fork-web.sh is a bash
// script and never ran on Windows, so the bug was invisible — but the path is
// still wrong on any host where the checkout has a space or a non-ASCII
// character in it, because the percent-encoding is not decoded.
const REPO = fileURLToPath(new URL('../../', import.meta.url));

// Restart THIS network's fork and fail loudly if the script cannot.
//
// stdio:'pipe' hides the script's own diagnosis: execFileSync's error message
// is just "Command failed: bash run-fork-web.sh restart-one X", and CI
// 36955492385 produced nine such failures with no cause anywhere in the log —
// no DOWN line, no retry count, no anvil stderr. Re-throw with the captured
// output so the NEXT red names itself. Budget 180s: the script's own worst
// case (4 attempts × health-gate retry) is ≈150s, so it always gets to print
// its diagnosis before the caller kills it blind.
export function freshFork(netId, timeout = 180_000) {
  try {
    execFileSync('bash', ['run-fork-web.sh', 'restart-one', netId], {
      cwd: REPO, stdio: 'pipe', timeout,
    });
  } catch (e) {
    const parts = [['stdout', e.stdout], ['stderr', e.stderr]]
      .filter(([, s]) => s && String(s).trim())
      .map(([k, s]) => `${k}:\n${String(s).trim()}`);
    throw new Error(
      `run-fork-web.sh restart-one ${netId} failed (status=${e.status}, signal=${e.signal || 'none'}):\n`
      + (parts.join('\n---\n') || '(no output captured)'),
    );
  }
}

// Anvil forks pin to the block they started at. Some upstream nodes (BSC,
// Polygon, Arbitrum…) prune state after ~128 blocks, so a fork that has been
// up for more than a few minutes on a fast chain serves BROKEN state
// ("missing trie node", estimateGas reverts) even though eth_getBalance still
// answers. Spec files that need a fresh fork call freshFork() before their
// flows; ports never overlap between sequential single-worker tests.

// Without foundry on PATH each fork test used to burn its full timeout and
// then fail — 12 networks is about an hour of red on any machine that simply
// has no anvil installed. Probe once and skip, so a plain `npm run test:e2e`
// reports "skipped: needs anvil" instead. CI installs foundry first, so there
// these run for real.
export const HAS_ANVIL = (process.env.PATH || '').split(':')
  .some((d) => d && existsSync(join(d, 'anvil')))
  || existsSync(join(process.env.HOME || '', '.foundry/bin/anvil'));

// networkId → { port, type, hosts } — hosts mirror the first RPCs in
// js/network.js for that network (the app tries them in order).
export const FORKS = {
  ethereum:          { port: 18545, type: 'mainnet', hosts: ['ethereum-rpc.publicnode.com', 'eth.drpc.org'] },
  bsc:               { port: 18546, type: 'mainnet', hosts: ['bsc-dataseed.binance.org', 'bsc-rpc.publicnode.com'] },
  polygon:           { port: 18547, type: 'mainnet', hosts: ['polygon-bor-rpc.publicnode.com', 'polygon.drpc.org'] },
  arbitrum:          { port: 18548, type: 'mainnet', hosts: ['arb1.arbitrum.io', 'arbitrum-one-rpc.publicnode.com'] },
  optimism:          { port: 18549, type: 'mainnet', hosts: ['mainnet.optimism.io', 'optimism-rpc.publicnode.com'] },
  base:              { port: 18550, type: 'mainnet', hosts: ['mainnet.base.org', 'base-rpc.publicnode.com'] },
  sepolia:           { port: 18551, type: 'testnet', hosts: ['sepolia.gateway.tenderly.co', 'ethereum-sepolia-rpc.publicnode.com'] },
  amoy:              { port: 18552, type: 'testnet', hosts: ['polygon-amoy.drpc.org', 'polygon-amoy-bor-rpc.publicnode.com'] },
  'arbitrum-sepolia': { port: 18553, type: 'testnet', hosts: ['sepolia-rollup.arbitrum.io', 'arbitrum-sepolia-rpc.publicnode.com'] },
  'op-sepolia':       { port: 18554, type: 'testnet', hosts: ['sepolia.optimism.io', 'optimism-sepolia-rpc.publicnode.com'] },
  'base-sepolia':     { port: 18555, type: 'testnet', hosts: ['sepolia.base.org', 'base-sepolia-rpc.publicnode.com'] },
  'bsc-testnet':      { port: 18556, type: 'testnet', hosts: ['data-seed-prebsc-1-s1.bnbchain.org:8545', 'bsc-testnet-rpc.publicnode.com'] },
};

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Intercept only the app's RPC hosts and proxy each request to the fork.
// Everything else (ethers CDN, price API) continues normally.
export async function proxyRpc(page, fork) {
  const re = new RegExp('^https://(' + fork.hosts.map(escapeRe).join('|') + ')(:|/|$)');
  await page.route(re, async (route) => {
    const req = route.request();
    // The browser sends a CORS preflight before a JSON POST — answer it so
    // the app's cross-origin fetch is allowed through our local proxy.
    if (req.method() === 'OPTIONS') {
      await route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'POST, OPTIONS',
          'access-control-allow-headers': 'content-type',
        },
        body: '',
      });
      return;
    }
    if (req.method() !== 'POST') { await route.continue(); return; }
    const body = req.postData();
    const resp = await fetch(`http://127.0.0.1:${fork.port}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }).catch(() => null);
    if (!resp) { await route.fulfill({ status: 502, body: 'fork proxy unavailable' }); return; }
    await route.fulfill({
      status: resp.status,
      headers: {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
      },
      body: await resp.text(),
    });
  });
}

export async function gotoApp(page) {
  // CoinGecko is frequently rate-limited / CORS-blocked from CI — the app is
  // designed to keep working with prices missing, but the blocked fetch logs
  // a console error that the strict e2e error assertion treats as a failure.
  // Mock the price API so e2e runs are deterministic (no app code is touched).
  await page.route('**api.coingecko.com**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
  );
  // DexScreener is mocked for the same reason, and it was missed because it only
  // starts being called once the wallet actually holds something. The API does
  // allow CORS — measured: `access-control-allow-origin: *` from both a GitHub
  // Pages origin and 127.0.0.1 — so what a run sees is rate limiting after a few
  // suites in a row, which arrives without the CORS header and lands in the
  // browser as a CORS error. A third party's rate limit is not a product failure
  // and must not decide whether this suite passes.
  await page.route('**api.dexscreener.com**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  );
  await page.goto('/', { waitUntil: 'domcontentloaded' });
}

// The intro is a 1.5s animation with an ABSOLUTE SAFETY auto-hide at ~2s.
// Only click it while it is actually visible — clicking a hidden intro would
// make Playwright wait (actionability) until the test timeout.
export async function skipIntro(page) {
  const intro = page.locator('#intro');
  const visible = await intro.isVisible().catch(() => false);
  if (!visible) return; // already auto-hidden by the safety timer
  await intro.click({ position: { x: 20, y: 20 }, timeout: 3000 }).catch(() => {});
  await page.waitForSelector('#intro.hidden', { timeout: 5000 }).catch(() => {});
}

// headless-shell bug: locator.click() can hang on "stable"/"receives events"
// after the intro is hidden even though the element is static and hit-testable.
// Fall back to a raw mouse click at the element centre — the browser then
// routes it exactly like a real user click.
export async function appClick(page, selector, opts = {}) {
  try {
    await page.click(selector, { timeout: 3000, ...opts });
  } catch {
    const box = await page.locator(selector).boundingBox();
    if (!box) throw new Error(`appClick: no boundingBox for ${selector}`);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  }
}

export async function expectWelcome(page) {
  await page.waitForSelector('#wCreate', { timeout: 10_000 });
  await expect(page.locator('#wImport')).toBeVisible();
}

// Full create-wallet flow: welcome → create modal → seed phrase modal →
// answer the three confirmations the app asks for → "I saved it".
// Returns the 12 seed words.
//
// This helper was wrong in three ways, and every one of them looked like a hang.
//
//   1. It read the seed from `#modalBox .mono`. No such element has ever existed.
//      The words render into `.seed-words`. A missing locator is not a fast
//      failure: textContent() on it waits for the full test timeout, so the
//      symptom was a 45-second stall rather than "element not found".
//   2. It read the requested index from `#modalBox label`. The app uses
//      <p id="seedQLabel">. Same failure mode, same silence.
//   3. It answered ONE confirmation. The app requires three before
//      `#seedDone` is enabled, so the final click did nothing and the modal never
//      closed.
//
// All three are now read from hooks the app provides on purpose — the copy
// button's data-copy carries the exact mnemonic, and seedQLabel is the element
// the app itself writes the question into — rather than from class names, which
// change with styling and say nothing about meaning.
export async function createWallet(page, { name = 'Test Wallet', password = 'password123' } = {}) {
  await appClick(page, '#wCreate');
  await page.fill('#createName', name);
  await page.fill('#createPw', password);
  await page.fill('#createPw2', password);
  await appClick(page, '#createBtn');

  // Wait for the seed modal, and read the mnemonic from data-copy: it is the
  // same string the app hands the clipboard, so there is nothing to parse and
  // nothing to infer from markup.
  await page.waitForSelector('.seed-choice-btn', { timeout: 10_000 });
  const mnemonic = await page.locator('[data-copy]').first().getAttribute('data-copy');
  expect(mnemonic, 'tombol salin tidak membawa seed phrase').toBeTruthy();
  const words = mnemonic.trim().split(/\s+/);
  expect(words, 'seed phrase harus 12 kata').toHaveLength(12);

  // Three confirmations, each reading the index fresh: the app re-rolls the
  // choices and advances the question after every answer, so a single read would
  // answer the same question three times and stall on the second.
  for (let i = 0; i < 3; i++) {
    const ask = await page.locator('#seedQLabel').textContent();
    const n = Number((ask.match(/#(\d+)/) || [])[1]);
    expect(Number.isFinite(n), `tidak bisa baca kata ke-${i + 1} dari: "${ask}"`).toBe(true);
    await appClick(page, `.seed-choice-btn[data-word="${words[n - 1]}"]`);
    // The app disables the button briefly between questions.
    await page.waitForTimeout(600);
  }

  await expect(page.locator('#seedDone')).toBeEnabled();
  await appClick(page, '#seedDone');
  await page.waitForSelector('#seedDone', { state: 'hidden', timeout: 15_000 });
  return { words };
}

// Open the Send view and make sure the token dropdown is populated.
// loadDashboard() fills state.tokens asynchronously; if the test clicks Send
// before that finishes, loadSendTokens() renders an empty dropdown and doSend()
// bails with "Token not found" before any destination warning can show.
export async function openSendView(page) {
  // Idempotent, and it has to be.
  //
  // It used to click the dashboard's quick-action unconditionally. That button lives
  // in the dashboard section, and .view is display:none unless active — so the SECOND
  // call, made while the app was already sitting in the Send view, had no box to
  // click and threw "appClick: no boundingBox for .quick-action-btn[data-view=send]".
  // Every MAX test opens Send to seed balances and then opens it again, so all seven
  // failed on a view that was already open, with an error pointing at the dashboard
  // instead of at the double call.
  if (await page.locator('#view-send.active').count().then((n) => n > 0).catch(() => false)) return;
    await appClick(page, '.quick-action-btn[data-view="send"]');
  const ready = await page.waitForFunction(
    () => document.querySelector('#sendToken')?.options.length > 0,
    null, { timeout: 10_000 }
  ).then(() => true).catch(() => false);
  if (ready) return;
  // Race hit: go back to the dashboard, wait for assets to load, re-enter Send.
  await appClick(page, '.nav-item[data-view="dashboard"]');
  await page.waitForSelector('#assetList .asset-row', { timeout: 20_000 });
  await appClick(page, '.quick-action-btn[data-view="send"]');
  await page.waitForFunction(
    () => document.querySelector('#sendToken')?.options.length > 0,
    null, { timeout: 10_000 }
  );
}

// Import flow: welcome → import modal → submit secret + password.
export async function importWallet(page, { secret, password = 'password123', name = 'Imported' } = {}) {
  await appClick(page, '#wImport');
  await page.fill('#importName', name);
  await page.fill('#importSecret', secret);
  await page.fill('#importPw', password);
  await appClick(page, '#importBtn');
  await page.waitForSelector('#importBtn', { state: 'hidden', timeout: 10_000 });
}

// Anvil's first account. Its key is public and worthless by design, and it is the
// only funded address available without touching a real one. Test-only on
// purpose: nothing in src/ may ever contain a key.
export const ANVIL_ACCOUNT_0 = {
  privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  address: '0xf39Fd6e51aad88F6F4ce6aB8827279CffFb92266',
};

/**
 * A wallet that actually holds something.
 *
 * createWallet() makes a fresh random wallet, which on a chain holds nothing, so
 * the token list comes back empty and every spec waiting for it times out at the
 * 45s mark. That failure is indistinguishable from a real bug: the untouched
 * HEAD produced more of them than the patched tree did. Importing the chain's
 * own funded account is what makes the on-chain specs measurable at all.
 */
export async function fundedWallet(page, { password = 'password123', name = 'Fork Wallet' } = {}) {
  await importWallet(page, { secret: ANVIL_ACCOUNT_0.privateKey, password, name });
  await expectUnlocked(page);
  return ANVIL_ACCOUNT_0.address;
}

// Unlock modal (keystore exists, session expired/cleared).
export async function unlock(page, password = 'password123') {
  await page.fill('#unlockPw', password);
  await appClick(page, '#unlockBtn');
  await page.waitForSelector('#unlockBtn', { state: 'hidden', timeout: 10_000 });
}

export async function expectUnlocked(page) {
  await page.waitForSelector('#accountShort', { timeout: 10_000 });
  const label = await page.locator('#accountShort').textContent();
  expect(label).not.toBe('Not connected');
}

// Attach console/page error collectors BEFORE goto. Returns an array.
export function collectErrors(page) {
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !ALLOWED_CONSOLE.some((a) => m.text().includes(a))) {
      // The failing URL is not part of the message text — CI 36930970112
      // logged five bare 'Failed to load resource … 404' lines with no way to
      // tell WHICH asset was missing. Keep the text identical, append the
      // location when the console reports one.
      const url = m.location()?.url;
      errors.push('console: ' + m.text() + (url ? ` @ ${url}` : ''));
    }
  });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  return errors;
}

export async function assertNoErrors(errors) {
  expect(errors, 'console/page errors').toEqual([]);
}

// Simulate a tab close: wipe sessionStorage (keystore stays in localStorage).
export async function simulateTabClose(page) {
  await page.evaluate(() => sessionStorage.clear());
}

// Simulate a session that expired past the auto-lock window: clear the
// sessionStorage copy and age the localStorage copy beyond the default 5 min.
export async function expireSession(page) {
  await page.evaluate(() => {
    sessionStorage.clear();
    const ls = JSON.parse(localStorage.getItem('bear.session.ls') || 'null');
    if (ls) {
      ls.ts = Date.now() - 10 * 60 * 1000; // 10 min old > 5 min window
      localStorage.setItem('bear.session.ls', JSON.stringify(ls));
    }
  });
}

export async function openView(page, view) {
    // Whichever nav affordance this viewport actually has. The sidebar is hidden on
    // a phone and the bottom bar is display:none on a desktop, so a helper that
    // insists on one of them fails on the other — which is why the responsive sweep
    // failed on exactly the two desktop sizes and passed on every phone.
    //
    // Everything goes through appClick, which is 3s plus a mouse fallback. A bare
    // locator.click() would use Playwright's 30s default, and the earlier version of
    // this function used one: ten views at 30s apiece blew the 240s budget, and the
    // second Swap press left the bridge chooser modal open over the rest of the run.
    const press = async (v) => {
      const sel = `.sidebar .nav-item[data-view="${v}"]`;
      if (await page.locator(sel).isVisible().catch(() => false)) {
        await appClick(page, sel);
        return true;
      }
      const bar = `#mobileNav .mobile-nav-item[data-view="${v}"]`;
      if (await page.locator(bar).isVisible().catch(() => false)) {
        await appClick(page, bar);
        return true;
      }
      return false;
    };

    if (await press(view)) return;

    // Bridge shares the Swap entry: press it, press it again, then choose.
if (view === 'bridge') {
  // Bridge shares the Swap entry, and the chooser opens on a press while Swap is
  // ALREADY showing. Pressing a fixed number of times can therefore open it and
  // immediately close it again. That is what happened: #chooseBridge sat in the
  // DOM but hidden, and every bridge test — the responsive sweep at all five
  // viewports, and its picker-reachability half — waited out its 10s for something
  // that was never going to appear.
  //
  // Press until it is actually there, up to three times.
  const chooser = page.locator('#chooseBridge');
  for (let i = 0; i < 3; i++) {
    if (await chooser.isVisible().catch(() => false)) return appClick(page, '#chooseBridge');
    await press('swap');
  }
  await page.waitForSelector('#chooseBridge', { timeout: 10_000 });
  return appClick(page, '#chooseBridge');
}

    // Send: from the dashboard's quick actions.
    await press('dashboard');
    return appClick(page, `.quick-action-btn[data-view="${view}"]`);
}
