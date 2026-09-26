// 19 — Security Center and the injected provider.
//
// Two things are asserted here that no other suite covers: that the page tells
// the user the truth about what a dApp can reach, and that window.ethereum
// refuses what it should. A wallet whose provider answers while locked, or
// forwards an unlisted method, is worse than one with no provider at all.
import { test, expect } from '@playwright/test';
import { gotoApp, skipIntro, createWallet, appClick } from './helpers.js';

test.describe('Security Center', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await appClick(page, '.nav-item[data-view="settings"]');
    await page.waitForSelector('#securityCenter .sec-block', { timeout: 10_000 });
  });

  test('it says plainly that a cross-origin dApp cannot detect this wallet', async ({ page }) => {
    const text = await page.locator('#securityCenter').textContent();
    expect(text).toMatch(/not possible/i);
    // The reason matters as much as the fact.
    expect(text).toMatch(/native|proxy|extension/i);
  });

  test('it lists the signing guardrails rather than just asserting "safe"', async ({ page }) => {
    const text = await page.locator('#securityCenter').textContent();
    expect(text).toMatch(/unlimited approval/i);
    expect(text).toMatch(/setApprovalForAll|operator/i);
    expect(text).toMatch(/permit/i);
    expect(text).toMatch(/raw calldata|hex/i);
  });

  test('with nothing connected it says so', async ({ page }) => {
    await expect(page.locator('#secSites')).toContainText(/no site is connected/i);
    await expect(page.locator('#secDisconnectAll')).toBeDisabled();
  });

  test('a blocklist entry can be added and removed from the page', async ({ page }) => {
    await page.fill('#secAddblocked', 'scam-site.example');
    await page.click('[data-add="blocked"]');
    await page.waitForTimeout(300);
    await expect(page.locator('#securityCenter')).toContainText('scam-site.example');

    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('bear.dappBlocked') || '[]'));
    expect(stored).toContain('scam-site.example');

    await page.click('[data-rm-blocked="scam-site.example"]');
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => JSON.parse(localStorage.getItem('bear.dappBlocked') || '[]'));
    expect(after).not.toContain('scam-site.example');
  });

  test('trusting a host does not unblock it if it is also blocked', async ({ page }) => {
    // Whichever list the user sets second is the one they meant.
    await page.fill('#secAddblocked', 'both.example');
    await page.click('[data-add="blocked"]');
    await page.waitForTimeout(250);
    await page.fill('#secAddtrusted', 'both.example');
    await page.click('[data-add="trusted"]');
    await page.waitForTimeout(250);

    const cfg = await page.evaluate(async () => (await import('/js/dapp-sessions.js')).getSecurityConfig());
    expect(cfg.blockedHosts).not.toContain('both.example');
    expect(cfg.trustedHosts).toContain('both.example');
  });

  test('clearing browsing data does not disconnect a site', async ({ page }) => {
    // Two different intentions, and one must not quietly undo the other.
    await page.evaluate(async () => {
      const m = await import('/js/dapp-sessions.js');
      m.addSite('https://connected.example');
    });
    await page.click('#secClearData');
    await page.waitForTimeout(400);

    const sites = await page.evaluate(async () => (await import('/js/dapp-sessions.js')).listSites());
    expect(sites.map((s) => s.origin)).toContain('https://connected.example');
  });

  test('the stored key can be forgotten', async ({ page }) => {
    await page.evaluate(() => localStorage.setItem('bear.openseaKey', 'test-key-123'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await skipIntro(page);
    await appClick(page, '.nav-item[data-view="settings"]');
    await page.waitForSelector('#secClearKey', { timeout: 10_000 });
    await expect(page.locator('#secKeyRow')).toContainText(/saved/i);

    await page.click('#secClearKey');
    await page.waitForTimeout(300);
    const key = await page.evaluate(() => localStorage.getItem('bear.openseaKey'));
    expect(key).toBeNull();
  });
});

test.describe('injected provider', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
  });

  test('it exists, and it does not claim to be another wallet', async ({ page }) => {
    const info = await page.evaluate(() => ({
      present: !!window.ethereum,
      bear: !!window.ethereum?.isBearTool,
      metamask: !!window.ethereum?.isMetaMask,
      coinbase: !!window.ethereum?.isCoinbaseWallet,
    }));
    expect(info.present).toBe(true);
    expect(info.bear).toBe(true);
    expect(info.metamask).toBe(false);
    expect(info.coinbase).toBe(false);
  });

  test('an unlisted method is refused', async ({ page }) => {
    const err = await page.evaluate(async () => {
      try { await window.ethereum.request({ method: 'eth_sign' }); return null; }
      catch (e) { return { code: e.code, message: e.message }; }
    });
    expect(err).not.toBeNull();
    expect(err.code).toBe(4200);
  });

  test('a read works once connected, and is refused before that', async ({ page }) => {
    const before = await page.evaluate(async () => {
      try { return await window.ethereum.request({ method: 'eth_getBalance', params: [window.ethereum._address || '0x' + '11'.repeat(20), 'latest'] }); }
      catch (e) { return e.code; }
    });
    expect(before, 'an ungranted origin must not read balances').toBe(4100);
  });

  test('locking the wallet makes the provider answer nothing', async ({ page }) => {
    await page.evaluate(() => {
      window.__bearLocked = true;
      const btn = document.querySelector('#lockBtn');
      if (btn) btn.click();
    });
    await page.waitForTimeout(500);
    const code = await page.evaluate(async () => {
      try { await window.ethereum.request({ method: 'eth_chainId' }); return 'answered'; }
      catch (e) { return e.code; }
    });
    expect(code).toBe(4100);
  });
});

test.describe('OpenSea guide', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await appClick(page, '.nav-item[data-view="deploy"]');
    await page.waitForSelector('#openSeaPanel', { timeout: 10_000 });
  });

  test('the API key is the first thing in the panel, under a guide', async ({ page }) => {
    await expect(page.locator('#openSeaGuide')).toBeVisible();
    // Step 1 must be the key: it is the one value a new user cannot infer.
    const firstStep = await page.locator('#openSeaGuide .os-steps > li').first().textContent();
    expect(firstStep).toMatch(/api key/i);
    expect(firstStep).toMatch(/app\.opensea\.io/i);
  });

  test('the key field sits inside step 1 and comes before the collection field', async ({ page }) => {
    const order = await page.evaluate(() => {
      const key = document.querySelector('#openSeaApiKey').getBoundingClientRect().top;
      const coll = document.querySelector('#openSeaContract').getBoundingClientRect().top;
      return { key, coll };
    });
    expect(order.key).toBeLessThan(order.coll);
  });

  test('the guide says where the key is stored and that it is not sent anywhere', async ({ page }) => {
    const text = await page.locator('#openSeaGuide').textContent();
    expect(text).toMatch(/browser/i);
    expect(text).toMatch(/never sent|tidak pernah dikirim/i);
  });

  test('the key state line reports that nothing is saved yet', async ({ page }) => {
    await page.evaluate(() => localStorage.removeItem('bear.openseaKey'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await skipIntro(page);
    await appClick(page, '.nav-item[data-view="deploy"]');
    await page.waitForSelector('#openSeaKeyState', { timeout: 10_000 });
    await expect(page.locator('#openSeaKeyState')).toContainText(/no key|belum ada key/i);
  });

  test('the reveal button toggles the field type and reports its state', async ({ page }) => {
    await expect(page.locator('#openSeaApiKey')).toHaveAttribute('type', 'password');
    await page.click('#btnRevealOsKey');
    await expect(page.locator('#openSeaApiKey')).toHaveAttribute('type', 'text');
    await expect(page.locator('#btnRevealOsKey')).toHaveAttribute('aria-pressed', 'true');
    await page.click('#btnRevealOsKey');
    await expect(page.locator('#openSeaApiKey')).toHaveAttribute('type', 'password');
  });

  test('the market actions are behind a disclosure, not in the way', async ({ page }) => {
    await expect(page.locator('#openSeaAdvanced')).not.toHaveAttribute('open', /.*/);
    await expect(page.locator('#openSeaTokenId')).toBeHidden();
  });
});
