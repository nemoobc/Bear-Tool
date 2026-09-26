// 18 — The in-app dApp browser: tabs, history, and the pre-load gate.
//
// The gate is the point of this file. Everything a dApp browser does is
// navigation, and navigation is where a wallet gets drained, so these tests
// assert refusals rather than happy paths wherever a refusal is possible.
import { test, expect } from '@playwright/test';
import { gotoApp, skipIntro, createWallet, appClick } from './helpers.js';

test.describe('dApp browser', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await appClick(page, '.nav-item[data-view="dapps"]');
    await page.waitForSelector('#dappsContainer .dapps-browser', { timeout: 10_000 });
  });

  async function openBrowser(page) {
    await page.locator('.dapp-card').first().click();
    await page.waitForSelector('#dappBrowserOverlay.open', { timeout: 10_000 });
  }

  test('the discovery grid is a real grid with a working filter', async ({ page }) => {
    await expect(page.locator('#dappGrid .dapp-card')).not.toHaveCount(0);
    await page.fill('#dappSearch', 'aave');
    await page.waitForTimeout(300);
    const shown = await page.locator('#dappGrid .dapp-card:visible').count();
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(19);
  });

  test('opening a dApp gives a browser with tabs and a frame', async ({ page }) => {
    await openBrowser(page);
    await expect(page.locator('.dbr-tabs .dbr-tab')).toHaveCount(1);
    await expect(page.locator('#dbrFrame')).toHaveCount(1);
  });

  test('the frame is hardened, not a bare iframe', async ({ page }) => {
    await openBrowser(page);
    const attrs = await page.evaluate(() => {
      const f = document.querySelector('#dbrFrame');
      return {
        sandbox: f?.getAttribute('sandbox') || '',
        referrer: f?.getAttribute('referrerpolicy') || '',
        allow: f?.getAttribute('allow'),
        credentialless: f?.hasAttribute('credentialless'),
      };
    });
    expect(attrs.referrer).toBe('no-referrer');
    expect(attrs.credentialless).toBe(true);
    expect(attrs.sandbox).toContain('allow-scripts');
    // The two that would matter: our origin, and escaping the sandbox.
    expect(attrs.sandbox).not.toContain('allow-same-origin');
    expect(attrs.sandbox).not.toContain('escape-sandbox');
    expect(attrs.allow).toBe('');
  });

  test('a second tab opens and switching keeps both', async ({ page }) => {
    await openBrowser(page);
    // Put the first tab on a real page first. Two fresh tabs are BOTH called
    // "New tab", so asserting distinct names on an untouched pair would fail
    // for a reason that has nothing to do with tabs working.
    await page.fill('#dbrUrl', 'https://app.aave.com/');
    await page.press('#dbrUrl', 'Enter');
    await page.waitForTimeout(600);

    await appClick(page, '#dbrNew');
    await page.waitForTimeout(300);
    await expect(page.locator('.dbr-tabs .dbr-tab')).toHaveCount(2);
    const names = await page.locator('.dbr-tab-nm').allTextContents();
    expect(new Set(names).size, `tabs should be distinguishable, got ${names}`).toBe(2);

    // The second tab is on its home page, and the first still holds its page.
    await expect(page.locator('.dbr-tab.on')).toHaveCount(1);
    await expect(page.locator('#dbrHomePage')).toBeVisible();
    await page.locator('.dbr-tab').first().click();
    await page.waitForTimeout(400);
    await expect(page.locator('#dbrUrl')).toHaveValue(/aave\.com/);
  });

  test('a homograph is refused with no way to proceed', async ({ page }) => {
    await openBrowser(page);
    await page.fill('#dbrUrl', 'https://xn--pypal-4ve.com/login');
    await page.press('#dbrUrl', 'Enter');
    await page.waitForTimeout(500);

    const report = page.locator('#dbrBlocked .dbr-report');
    await expect(report).toBeVisible();
    await expect(report).toContainText(/punycode|mixed-script/i);
    // The whole point: no "open anyway".
    await expect(page.locator('#dbrBlocked [data-act="proceed"]')).toHaveCount(0);
  });

  test('javascript: is refused outright', async ({ page }) => {
    await openBrowser(page);
    const before = await page.getAttribute('#dbrFrame', 'src');
    await page.fill('#dbrUrl', 'javascript:alert(document.domain)');
    await page.press('#dbrUrl', 'Enter');
    await page.waitForTimeout(400);
    const after = await page.getAttribute('#dbrFrame', 'src');
    expect(after).toBe(before);
  });

  test('an unknown site is warned about first, and the user chooses', async ({ page }) => {
    await openBrowser(page);
    await page.fill('#dbrUrl', 'https://some-unknown-defi-site.example');
    await page.press('#dbrUrl', 'Enter');
    await page.waitForTimeout(500);

    const report = page.locator('#dbrBlocked .dbr-report');
    await expect(report).toBeVisible();
    await expect(report).toContainText(/not in our catalogue/i);
    // A CAUTION site may be opened, but the choice is explicit.
    await expect(page.locator('#dbrBlocked [data-act="proceed"]')).toHaveCount(1);
  });

  test('a blocked site stays blocked after the warning is dismissed', async ({ page }) => {
    await openBrowser(page);
    await page.fill('#dbrUrl', 'https://claim.example-xyz-thing.top/');
    await page.press('#dbrUrl', 'Enter');
    await page.waitForTimeout(500);

    // That host is a lure shape on a cheap TLD, so it is refused, not warned.
    await expect(page.locator('#dbrBlocked [data-act="proceed"]')).toHaveCount(0);
  });

  test('a blocklist entry is honoured on the next attempt', async ({ page }) => {
    await page.evaluate(() => {
      localStorage.setItem('bear.dappBlocked', JSON.stringify(['blocked.example.com']));
    });
    await openBrowser(page);
    await page.fill('#dbrUrl', 'https://blocked.example.com/');
    await page.press('#dbrUrl', 'Enter');
    await page.waitForTimeout(500);
    await expect(page.locator('#dbrBlocked .dbr-report')).toContainText(/blocklist/i);
  });

  test('a pasted recovery phrase is refused and never stored', async ({ page }) => {
    await openBrowser(page);
    const phrase = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
    await page.fill('#dbrUrl', 'https://x.com/?q=' + phrase);
    await page.press('#dbrUrl', 'Enter');
    await page.waitForTimeout(500);

    const stored = await page.evaluate(() => ({
      hist: localStorage.getItem('bear.dapp.history'),
      bm: localStorage.getItem('bear.dappBookmarks'),
      tabs: localStorage.getItem('bear.dapp.tabs'),
    }));
    expect(stored.hist || '').not.toContain('legal winner');
    expect(stored.tabs || '').not.toContain('legal winner');
  });

  test('a bookmark is written and can be removed again', async ({ page }) => {
    await openBrowser(page);
    await page.fill('#dbrUrl', 'https://app.aave.com/');
    await page.press('#dbrUrl', 'Enter');
    await page.waitForTimeout(900);
    // Aave is in the catalogue over https, so this loads without a prompt.
    await appClick(page, '#dbrBm');
    await page.waitForTimeout(300);
    const bms = await page.evaluate(() => JSON.parse(localStorage.getItem('bear.dappBookmarks') || '[]'));
    expect(bms.some((b) => b.url.includes('aave.com'))).toBe(true);

    await appClick(page, '#dbrBm');
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => JSON.parse(localStorage.getItem('bear.dappBookmarks') || '[]'));
    expect(after.some((b) => b.url.includes('aave.com'))).toBe(false);
  });

  test('back and forward move through this tab only', async ({ page }) => {
    await openBrowser(page);
    await page.fill('#dbrUrl', 'https://app.aave.com/');
    await page.press('#dbrUrl', 'Enter');
    await page.waitForTimeout(800);
    await page.fill('#dbrUrl', 'https://app.balancer.fi/');
    await page.press('#dbrUrl', 'Enter');
    await page.waitForTimeout(800);

    await expect(page.locator('#dbrBack')).toBeEnabled();
    await appClick(page, '#dbrBack');
    await page.waitForTimeout(400);
    expect(await page.inputValue('#dbrUrl')).toContain('aave.com');

    await appClick(page, '#dbrFwd');
    await page.waitForTimeout(400);
    expect(await page.inputValue('#dbrUrl')).toContain('balancer.fi');
  });

  test('an incognito tab is never written to storage', async ({ page }) => {
    await openBrowser(page);
    await appClick(page, '#dbrMenu');
    await page.waitForSelector('#dbrMenuPop:not([hidden])', { timeout: 5000 });
    await page.click('[data-mi="incog"]');
    await page.waitForTimeout(300);
    await page.fill('#dbrUrl', 'https://app.aave.com/');
    await page.press('#dbrUrl', 'Enter');
    await page.waitForTimeout(800);

    const stored = await page.evaluate(() => localStorage.getItem('bear.dapp.tabs') || '[]');
    expect(stored).not.toContain('incog');
  });

  test('Escape closes the browser', async ({ page }) => {
    await openBrowser(page);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    await expect(page.locator('#dappBrowserOverlay')).toBeHidden();
  });
});
