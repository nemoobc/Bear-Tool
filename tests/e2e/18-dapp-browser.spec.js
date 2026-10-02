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

  // The other half of the Escape rule, and the half with no coverage at all.
  //
  // Escape in the address bar means "undo what I was typing" — the field goes back to
  // the page you are on and blurs. Escape in an address bar nobody has touched must
  // instead close the browser, because opening the browser focuses that field: a
  // blanket "address bar eats Escape" rule turns the keyboard shortcut into a no-op
  // the moment the overlay appears. The two are told apart by whether the field still
  // holds what the page it is on does.
  test('Escape in the address bar cancels an edit instead of closing the browser', async ({ page }) => {
    await openBrowser(page);
    const url = page.locator('#dbrUrl');
    // Land somewhere real first, so there is a current page for the edit to be
    // undone back to. It has to be a CATALOGUE address: the app vets what it opens,
    // and an arbitrary host never becomes the tab's URL, which leaves nothing to undo
    // back to — the first version of this test used example.com and watched the
    // field come back empty. app.aave.com is what the parity spec uses for the same
    // reason.
    //
    // go()/FRAMABLE live in that other file, not this one: an earlier version of
    // this test called them here and reported a bare ReferenceError, which says
    // nothing at all about the browser.
    await url.fill('https://app.aave.com/');
    await url.press('Enter');
    await page.waitForTimeout(1200);
    const landed = await url.inputValue();
    expect(landed, 'the page must actually have loaded, or there is nothing to undo back to')
      .toBe('https://app.aave.com/');
    await url.click();
    await url.fill('https://somewhere-else.example');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await expect(url, 'the edit must be undone').toHaveValue(landed);
    await expect(page.locator('#dappBrowserOverlay'),
      'a cancelled edit must not also throw away the tab').toBeVisible();
  });

  test('Escape closes the browser', async ({ page }) => {
    await openBrowser(page);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    await expect(page.locator('#dappBrowserOverlay')).toBeHidden();
  });

  // The eternal-spinner bug: a hardened frame whose navigation neither fires
  // load nor error (a dApp that hangs in the sandbox) left an opaque Loading
  // sheet over the stage forever with nothing to press. Every child-frame
  // document below never arrives, so neither event fires — exactly that shape,
  // with no external network involved.
  test('a frame that never finishes loading offers a way out, not an eternal spinner', async ({ page }) => {
    await page.route('**/*', async (route) => {
      const req = route.request();
      if (req.resourceType() === 'document' && req.frame() !== page.mainFrame()) {
        return new Promise(() => {}); // the request hangs forever: no load, no error
      }
      await route.continue();
    });
    // The first card is Uniswap (frameable:false), which opens the notice
    // instead of the frame; a frameable card is the one that actually navigates.
    await page.locator('.dapp-card[data-frameable="1"]:visible').first().click();
    await page.waitForSelector('#dappBrowserOverlay.open', { timeout: 10_000 });
    // The curated gate may ask before the first load; either way the frame is
    // about to try, and that attempt is the one that will hang.
    const proceed = page.locator('[data-act="proceed"]');
    if (await proceed.isVisible().catch(() => false)) await proceed.click();

    await expect(page.locator('#dbrLoading')).toBeVisible();
    await expect(page.locator('#dbrLoading .dbr-progress')).toBeVisible();
    // LOAD_PHASE_MS.timeout is 15s; 25s leaves margin over a slow CI worker.
    // ONE assertion for both facts — the sheet must APPEAR WITH its text. The
    // earlier two-step (visible, then text) raced: #dbrBlocked is also the host
    // of the pre-load gate, so a transient gate state satisfied the visibility
    // step while the text step then polled a different moment. On failure the
    // page state is printed, so the next red wave is legible without a trace.
    try {
      await expect(page.locator('#dbrBlocked')).toContainText('did not load', { timeout: 25_000 });
    } catch (e) {
      const diag = await page.evaluate(() => ({
        overlays: document.querySelectorAll('#dappBrowserOverlay').length,
        blockedCount: document.querySelectorAll('#dbrBlocked').length,
        blockedHidden: document.querySelector('#dbrBlocked')?.hidden,
        blockedHtml: (document.querySelector('#dbrBlocked')?.innerHTML || '').slice(0, 300),
        loadingHidden: document.querySelector('#dbrLoading')?.hidden,
        loadingTxt: document.querySelector('#dbrLoadingTxt')?.textContent,
        frameSrc: document.querySelector('#dbrFrame')?.src,
        frameHidden: document.querySelector('#dbrFrame')?.hidden,
        proceed: !!document.querySelector('[data-act="proceed"]'),
        homeShown: !document.querySelector('#dbrHomePage')?.hidden,
      }));
      console.log('DAPP-DIAG ' + JSON.stringify(diag));
      throw e;
    }
    await expect(page.locator('#dbrBlocked [data-act="popup"]')).toBeVisible();
    await expect(page.locator('#dbrBlocked [data-act="copy"]')).toBeVisible();
    await page.locator('#dbrBlocked [data-act="back"]').click();
    await expect(page.locator('#dbrBlocked')).toBeHidden();
    // The toolbar still works after the timeout — a way out stays a way out.
    await expect(page.locator('#dbrUrl')).toBeVisible();
  });

  // The chrome is laid out the way OKX Wallet lays it out, from three
  // screenshots of the real app: ✕ top-left, the chain badge top-right, and
  // five thumb-sized controls along the bottom. The ids are the pre-existing
  // ones — they moved, they were not renamed — and this test is what keeps the
  // claim honest.
  test('the chrome is the OKX layout: ✕ top-left, chain badge top-right, five below', async ({ page }) => {
    await openBrowser(page);

    // ✕ leads the top bar.
    await expect(page.locator('#dbrClose')).toBeVisible();
    expect(await page.evaluate(() => document.querySelector('.dbr-top > *')?.id),
      '✕ is the first control in the top bar').toBe('dbrClose');

    // The chain badge ends it — the corner OKX puts the network logo in.
    expect(await page.evaluate(() =>
      [...document.querySelectorAll('.dbr-top > *')].pop()?.id),
    'the chain badge closes the top bar').toBe('dbrNet');
    await expect(page.locator('#dbrNet')).toBeVisible();

    // …and it says which network it is showing.
    await expect(page.locator('#dbrNet')).toHaveAttribute('aria-label', /network/i);
    const icon = (await page.locator('#dbrNetIc').textContent())?.trim();
    expect(icon, 'the badge renders an icon, not an empty circle').toBeTruthy();

    // Navigation left the top bar and is now five slots underneath.
    expect(await page.evaluate(() =>
      document.querySelectorAll('.dbr-top #dbrBack').length),
    'back is no longer crowded into the top').toBe(0);
    await expect(page.locator('#dbrBar .dbr-bbtn')).toHaveCount(5);
    for (const id of ['dbrBack', 'dbrFwd', 'dbrReload', 'dbrHome', 'dbrMenu']) {
      await expect(page.locator(`#dbrBar #${id}`), `${id} lives in the bottom bar`).toBeVisible();
    }

    // The verdict and the address share one pill.
    await expect(page.locator('.dbr-urlwrap #dbrSecure')).toBeVisible();
    await expect(page.locator('.dbr-urlwrap #dbrUrl')).toBeVisible();

    // And ✕ actually closes the browser — the whole point of a close button.
    await appClick(page, '#dbrClose');
    await expect(page.locator('#dappBrowserOverlay')).toBeHidden();
  });

  // Reaching a site that refuses framing used to end on three buttons, one of
  // which called window.open — a no-op inside the Capacitor WebView, because
  // nothing in @capacitor/android overrides WebChromeClient.onCreateWindow. The
  // call returned null and the click did nothing, which is how "cannot browse"
  // looked: 14 of the 18 catalog entries land on that sheet, and the only
  // forward button on it never fired. The sheet now offers a route the WebView
  // really honours plus the pairing route the Project ID was given for.
  test('a site that refuses framing offers working routes, not a dead button', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await appClick(page, '.nav-item[data-view="dapps"]');
    await page.waitForSelector('#dappsContainer .dapps-browser', { timeout: 10_000 });

    // 14 of 18 entries are marked frameable:false — pick one.
    const card = page.locator('.dapp-card[data-frameable="0"]').first();
    await expect(card, 'the catalog still carries non-frameable entries').toBeVisible();
    await card.click();

    const sheet = page.locator('#dbrHomePage');
    await expect(sheet).toBeVisible();
    // Route one: straight out to the system browser, through openExternal —
    // an anchor with target=_blank, which the WebView forwards to ACTION_VIEW.
    await expect(sheet.locator('[data-act="popup"]')).toContainText(/open in a browser tab/i);
    // Route two: stay in the wallet and pair over the relay.
    await expect(sheet.locator('[data-act="wc"]')).toContainText(/walletconnect/i);
    // Neither route is an escape from the gate: blocked stays blocked.
    await expect(sheet.locator('[data-act="block"]')).toContainText(/block this site/i);
    // Route three: back to the grid, always available.
    await expect(sheet.locator('[data-act="home"]')).toContainText(/back to dapps/i);
    // Which escape hatch is wired is proved at source level in
    // tests/dapp-chrome.test.js — no live window.open, one openExternal.
  });
});
