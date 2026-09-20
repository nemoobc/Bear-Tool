// Bear Tool — shared helpers for the Playwright E2E suite.
import { expect } from '@playwright/test';

// Known benign console message: a <meta http-equiv="X-Frame-Options"> is
// ignored by browsers (must be an HTTP header). Reported as a finding, not a
// test failure — it does not break the app.
export const ALLOWED_CONSOLE = [
  'X-Frame-Options may only be set via an HTTP header',
];

export async function gotoApp(page) {
  // CoinGecko is frequently rate-limited / CORS-blocked from CI — the app is
  // designed to keep working with prices missing, but the blocked fetch logs
  // a console error that the strict e2e error assertion treats as a failure.
  // Mock the price API so e2e runs are deterministic (no app code is touched).
  await page.route('**api.coingecko.com**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
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
// choose the word the app asks for (random index, "Select word #N") →
// "I saved it". Returns the 12 seed words.
export async function createWallet(page, { name = 'Test Wallet', password = 'password123' } = {}) {
  await appClick(page, '#wCreate');
  await page.fill('#createName', name);
  await page.fill('#createPw', password);
  await page.fill('#createPw2', password);
  await appClick(page, '#createBtn');
  await page.waitForSelector('.seed-choice-btn', { timeout: 10_000 });
  const seedText = await page.locator('#modalBox .mono').textContent();
  const words = [...seedText.matchAll(/(\d+)\.\s*(\w+)/g)].map((m) => m[2]);
  expect(words).toHaveLength(12);
  // The app asks to confirm a random index: "Select word #N to confirm".
  const ask = await page.locator('#modalBox label').textContent();
  const n = Number((ask.match(/#(\d+)/) || [])[1]);
  const correctIdx = Number.isFinite(n) ? n - 1 : 0;
  await appClick(page, `.seed-choice-btn[data-word="${words[correctIdx]}"]`);
  await appClick(page, '#seedDone');
  await page.waitForSelector('#seedDone', { state: 'hidden', timeout: 10_000 });
  return { words };
}

// Open the Send view and make sure the token dropdown is populated.
// loadDashboard() fills state.tokens asynchronously; if the test clicks Send
// before that finishes, loadSendTokens() renders an empty dropdown and doSend()
// bails with "Token not found" before any destination warning can show.
export async function openSendView(page) {
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
      errors.push('console: ' + m.text());
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