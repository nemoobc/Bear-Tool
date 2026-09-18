// Bear Tool — shared helpers for the Playwright E2E suite.
import { expect } from '@playwright/test';

// Known benign console message: a <meta http-equiv="X-Frame-Options"> is
// ignored by browsers (must be an HTTP header). Reported as a finding, not a
// test failure — it does not break the app.
export const ALLOWED_CONSOLE = [
  'X-Frame-Options may only be set via an HTTP header',
];

export async function gotoApp(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
}

// The intro is a 2.5s animation; clicking anywhere on it skips it.
export async function skipIntro(page) {
  const intro = page.locator('#intro');
  if (await intro.count()) {
    await intro.click({ position: { x: 20, y: 20 } }).catch(() => {});
    await page.waitForSelector('#intro.hidden', { timeout: 5000 }).catch(() => {});
  }
}

export async function expectWelcome(page) {
  await page.waitForSelector('#wCreate', { timeout: 10_000 });
  await expect(page.locator('#wImport')).toBeVisible();
}

// Full create-wallet flow: welcome → create modal → seed phrase modal →
// pick correct word #1 → "I saved it". Returns the 12 seed words.
export async function createWallet(page, { name = 'Test Wallet', password = 'password123' } = {}) {
  await page.click('#wCreate');
  await page.fill('#createName', name);
  await page.fill('#createPw', password);
  await page.fill('#createPw2', password);
  await page.click('#createBtn');
  await page.waitForSelector('.seed-choice-btn', { timeout: 10_000 });
  const seedText = await page.locator('#modalBox .mono').textContent();
  const words = [...seedText.matchAll(/(\d+)\.\s*(\w+)/g)].map((m) => m[2]);
  expect(words).toHaveLength(12);
  await page.click(`.seed-choice-btn[data-word="${words[0]}"]`);
  await page.click('#seedDone');
  await page.waitForSelector('#seedDone', { state: 'hidden', timeout: 10_000 });
  return { words };
}

// Open the Send view and make sure the token dropdown is populated.
// loadDashboard() fills state.tokens asynchronously; if the test clicks Send
// before that finishes, loadSendTokens() renders an empty dropdown and doSend()
// bails with "Token not found" before any destination warning can show.
export async function openSendView(page) {
  await page.click('.quick-action-btn[data-view="send"]');
  const ready = await page.waitForFunction(
    () => document.querySelector('#sendToken')?.options.length > 0,
    null, { timeout: 10_000 }
  ).then(() => true).catch(() => false);
  if (ready) return;
  // Race hit: go back to the dashboard, wait for assets to load, re-enter Send.
  await page.click('.nav-item[data-view="dashboard"]');
  await page.waitForSelector('#assetList .asset-row', { timeout: 20_000 });
  await page.click('.quick-action-btn[data-view="send"]');
  await page.waitForFunction(
    () => document.querySelector('#sendToken')?.options.length > 0,
    null, { timeout: 10_000 }
  );
}

// Import flow: welcome → import modal → submit secret + password.
export async function importWallet(page, { secret, password = 'password123', name = 'Imported' } = {}) {
  await page.click('#wImport');
  await page.fill('#importName', name);
  await page.fill('#importSecret', secret);
  await page.fill('#importPw', password);
  await page.click('#importBtn');
  await page.waitForSelector('#importBtn', { state: 'hidden', timeout: 10_000 });
}

// Unlock modal (keystore exists, session expired/cleared).
export async function unlock(page, password = 'password123') {
  await page.fill('#unlockPw', password);
  await page.click('#unlockBtn');
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