// 18 — The in-app dApp browser: tabs, history, and the pre-load gate.
//
// The gate is the point of this file. Everything a dApp browser does is
// navigation, and navigation is where a wallet gets drained, so these tests
// assert refusals rather than happy paths wherever a refusal is possible.
import { test, expect } from '@playwright/test';
import { gotoApp, skipIntro, createWallet, appClick } from './helpers.js';

test.describe('dApp browser', () => {
  test.beforeEach(async ({ page }) => {
    // The shared onboarding (intro → createWallet) is the slow part on this
    // device — a body-level setTimeout never reaches the hook, so the hook
    // died at the 45s default while the app was still mid-wizard. Give it
    // its own budget here; CI's runner finishes well inside it.
    test.setTimeout(120_000);
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await appClick(page, '.nav-item[data-view="dapps"]');
    await page.waitForSelector('#dappsContainer .dapps-browser', { timeout: 10_000 });
  });

  async function openBrowser(page) {
    // The first NON-frameable card: it opens the browser without navigating
    // (it refuses framing), so the frame is still the hardened markup — the
    // exact state 'the frame is hardened, not a bare iframe' asserts. M6's
    // section order puts a frameable card first now, and clicking that one
    // navigates, which correctly grants allow-same-origin to the dApp's OWN
    // origin (sandboxFor; unit-tested in dapp-browser-imports.test.js).
    await page.locator('.dapp-card[data-frameable="0"]').first().click();
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
    // 2026-10-07 (G1): exactly ONE permission is delegated — clipboard-write,
    // so a cross-origin dApp can copy its wc: pairing URI (W3C Permissions
    // Policy §4.8 default 'self'; Chromium #40128045). Microphone, camera,
    // geolocation and payment are never granted; their default excludes
    // cross-origin frames already.
    expect(attrs.allow).toBe('clipboard-write');
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
    // The toolbar star is gone (2026-10-07): the toggle lives in the ⋯ menu.
    await appClick(page, '#dbrMenu');
    await appClick(page, '#dbrMenuPop [data-mi="bm"]');
    await page.waitForTimeout(300);
    const bms = await page.evaluate(() => JSON.parse(localStorage.getItem('bear.dappBookmarks') || '[]'));
    expect(bms.some((b) => b.url.includes('aave.com'))).toBe(true);

    await appClick(page, '#dbrMenu');
    await appClick(page, '#dbrMenuPop [data-mi="bm"]');
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
    // LOAD_PHASE_MS.timeout is 20s; 25s leaves margin over a slow CI worker.
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

    // ── 2026-10-07 rombak: no star, address dead-center, tab counter right ──
    // The toolbar star is gone for good — bookmarking lives in the ⋯ menu.
    expect(await page.locator('#dbrBm').count(), 'no bookmark star in the toolbar').toBe(0);
    // The address pill sits at the visual center of the bar ±3px, measured
    // against real boxes — a claim about pixels must be checked in pixels.
    const topBox = await page.locator('.dbr-top').boundingBox();
    const urlBox = await page.locator('.dbr-urlwrap').boundingBox();
    expect(Math.abs((urlBox.x + urlBox.width / 2) - (topBox.x + topBox.width / 2)),
      'the address pill is dead-center').toBeLessThanOrEqual(3);
    // The tab counter closes the RIGHT edge, past the pill; the ✕ is left of it.
    const tabsBox = await page.locator('#dbrTabsBtn').boundingBox();
    expect(tabsBox.x, 'the tab counter sits right of the address pill')
      .toBeGreaterThan(urlBox.x + urlBox.width - 1);
    const closeBox = await page.locator('#dbrClose').boundingBox();
    expect(closeBox.x + closeBox.width, '✕ sits left of the address pill')
      .toBeLessThan(urlBox.x + 1);

    // The ⋯ menu is an OKX-style floating bubble: above the control bar,
    // overlapping the stage, not a dropdown pinned under the top bar.
    await appClick(page, '#dbrMenu');
    await expect(page.locator('#dbrMenuPop')).toBeVisible();
    const menuBox = await page.locator('#dbrMenuPop').boundingBox();
    const barBox = await page.locator('#dbrBar').boundingBox();
    expect(menuBox.y + menuBox.height, 'the bubble floats clear above the control bar')
      .toBeLessThanOrEqual(barBox.y + 1);
    expect(menuBox.y, 'the bubble overlays the stage, not the top bar').toBeGreaterThan(topBox.height + 1);
    await expect(page.locator('#dbrMenuPop [data-mi="bm"]'), 'bookmark row lives in the menu')
      .toContainText(/bookmark/i);
    await page.keyboard.press('Escape');
    await expect(page.locator('#dbrMenuPop')).toBeHidden();

    // The chain badge ends the icon row — the corner OKX puts the network
    // logo in. The tabs counter (#dbrTabsBtn, the tab batch of 2026-10-05)
    // is newer and closes the bar after it, so the badge is the LAST control
    // before that counter, not the DOM-absolute last child.
    expect(await page.evaluate(() => {
      const ids = [...document.querySelectorAll('.dbr-top > *')].map((e) => e.id);
      return ids[ids.length - 2];
    }),
    'the chain badge sits at the right end, ahead of the tabs counter').toBe('dbrNet');
    expect(await page.evaluate(() =>
      [...document.querySelectorAll('.dbr-top > *')].pop()?.id),
    'the tabs counter closes the top bar').toBe('dbrTabsBtn');
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

    // The verdict and the address share one pill. On the home page the pill is
    // structurally present but the verdict span is empty BY DESIGN — paint()
    // clears it when there is no page (dapp-browser.js, onHome branch) — so an
    // empty span has no box and toBeVisible() can never pass there. Assert the
    // shared pill structurally, then load a real site and assert the verdict
    // becomes visible: that is the claim, in the state where a verdict exists.
    expect(await page.evaluate(() =>
      document.querySelector('#dbrSecure')?.closest('.dbr-urlwrap')
        ?.contains(document.querySelector('#dbrUrl')) ?? false),
    'verdict and address share one pill').toBe(true);
    await expect(page.locator('.dbr-urlwrap #dbrUrl')).toBeVisible();
    const urlBar = page.locator('#dbrUrl');
    await urlBar.fill('https://app.aave.com/');
    await urlBar.press('Enter');
    await page.waitForSelector('#dbrSecure:not(:empty)', { timeout: 15_000 });
    await expect(page.locator('.dbr-urlwrap #dbrSecure')).toBeVisible();

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
    // beforeEach already booted the app, created the wallet and opened the
    // dapps view. A second createWallet here waits for #wCreate on a dashboard
    // that never shows it — the welcome screen only appears when no keystore
    // exists — which is exactly the 45s appClick timeout CI reported.
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

  test('the ↗ escape hatch opens a real browser tab from both doors', async ({ page }) => {
    // Two real popups and a real example.com load on top of the shared
    // create-wallet beforeEach — generous budget so the assertions, not the
    // device's speed, decide the outcome.
    test.setTimeout(120_000);
    // Measured 2026-10-07: Chromium fires a normal "load" for its X-Frame-Options
    // error page, so a frame that refuses to render cannot be detected from in
    // here — the way out has to be a button that is simply always available.
    await openBrowser(page);
    // Home stage, no URL yet — the ↗ stays out of the way.
    await expect(page.locator('#dbrExt')).toBeHidden();

    // Door one: the caution sheet for a URL outside the catalogue offers ↗
    // NEXT TO "Open anyway", so nobody is forced through the frame first.
    await page.fill('#dbrUrl', 'https://example.com/');
    await page.press('#dbrUrl', 'Enter');
    const sheet = page.locator('#dbrBlocked');
    await expect(sheet.locator('[data-act="ext"]')).toContainText(/open in a new tab/i);
    const [popup1] = await Promise.all([
      page.waitForEvent('popup', { timeout: 10_000 }),
      sheet.locator('[data-act="ext"]').click(),
    ]);
    expect(popup1.url()).toContain('example.com');
    await popup1.close();

    // Door two: after "Open anyway" the frame takes the stage and the toolbar
    // ↗ appears — the exit that does not depend on any detection.
    await sheet.locator('[data-act="proceed"]').click();
    await expect(page.locator('#dbrExt')).toBeVisible({ timeout: 10_000 });
    const [popup2] = await Promise.all([
      page.waitForEvent('popup', { timeout: 10_000 }),
      page.locator('#dbrExt').click(),
    ]);
    expect(popup2.url()).toContain('example.com');
    await popup2.close();
  });

  test('the WalletConnect hint shows once, pairs, and stays dismissed', async ({ page }) => {
    // Shared create-wallet beforeEach plus two real page loads on a slow
    // device — the assertions, not the clock, must decide the outcome.
    test.setTimeout(120_000);
    const hint = page.locator('#dbrWcHint');
    // Fresh profile: nothing dismissed yet. The hint only belongs to a page
    // that actually LOADED in the frame (a refused/blocked page has its own
    // wc: door in the sheet), so take the browser through a real load first.
    await openBrowser(page);
    await page.fill('#dbrUrl', 'https://example.com/');
    await page.press('#dbrUrl', 'Enter');
    const sheet = page.locator('#dbrBlocked');
    await sheet.locator('[data-act="proceed"]').click();
    await expect(hint).toBeVisible({ timeout: 30_000 });
    await expect(hint).toContainText('WalletConnect');

    // The 🔗 really opens the pairing sheet (wc: paste route), not a dead end.
    await page.locator('#dbrWcPair').click();
    await expect(page.locator('#wcPairUri')).toBeVisible();
    await page.locator('#modalOverlay .modal-close, #modalOverlay [data-close-modal]').first().click();
    await expect(page.locator('#modalOverlay')).not.toHaveClass(/open/);

    // ✕ dismisses it for good: hidden now AND persisted, so the next page
    // load inside the browser does not nag again.
    await page.locator('#dbrWcHintX').click();
    await expect(hint).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem('bear.dapp.wcHint'))).toBe('"dismissed"');

    // Re-open the browser on the same card — a fresh session starts on the
    // home stage, so send it through a real load again: the load handler is
    // what re-reads the persisted flag, and the strip must stay down.
    await page.locator('#dbrClose').click();
    await expect(page.locator('#dappBrowserOverlay')).not.toHaveClass(/open/);
    await openBrowser(page);
    await page.fill('#dbrUrl', 'https://example.com/');
    await page.press('#dbrUrl', 'Enter');
    // The caution sheet is remembered per session; if it is still up, proceed.
    await page.locator('#dbrBlocked [data-act="proceed"]').click({ timeout: 5_000 }).catch(() => {});
    await expect(page.locator('#dbrFrame')).toBeVisible({ timeout: 30_000 });
    await expect(hint).toBeHidden();
  });

  test('the pair sheet picks a copied wc: link straight out of the clipboard', async ({ page }) => {
    test.setTimeout(120_000);
    // Clipboard permission is granted PER ORIGIN. A hardcoded localhost:8080
    // worked locally and died in CI (2026-10-07: "Write permission denied" —
    // the runner's page origin differs), so take it from the page itself:
    // the origin we are actually about to write from.
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'],
      { origin: new URL(page.url()).origin });
    const WC_URI = 'wc:pair-topic-123@1?relay-protocol=irn&symKey=deadbeef';
    await page.evaluate((uri) => navigator.clipboard.writeText(uri), WC_URI);

    await openBrowser(page);
    await page.fill('#dbrUrl', 'https://example.com/');
    await page.press('#dbrUrl', 'Enter');
    await page.locator('#dbrBlocked [data-act="proceed"]').click({ timeout: 5_000 }).catch(() => {});
    await expect(page.locator('#dbrWcHint')).toBeVisible({ timeout: 30_000 });
    await page.locator('#dbrWcPair').click();
    // The copied link lands in the field — no manual Paste step.
    await expect(page.locator('#wcPairUri')).toHaveValue(WC_URI, { timeout: 5_000 });

    // And a non-wc: clipboard is ignored, not pasted into the pairing field.
    await page.keyboard.press('Escape');
    await page.evaluate(() => navigator.clipboard.writeText('just some text'));
    await page.locator('#dbrWcPair').click();
    await expect(page.locator('#wcPairUri')).toHaveValue('');
  });

  // ── the injected provider, end-to-end ─────────────────────────────────
  // Regression pins for everything the live research run proved broken
  // (2026-10-08, publicnode.com): eth_chainId → "0xNaN", personal_sign and
  // eth_sendTransaction → node -32601/-32602 AFTER the user approved,
  // wallet_switchEthereumChain → node -32601 with no chainChanged event.

  async function fire(page, req) {
    await page.evaluate((r) => {
      window.__done = false;
      window.__r = undefined;
      window.__e = null;
      window.ethereum.request(r).then(
        (v) => { window.__r = v; window.__done = true; },
        (e) => { window.__e = { code: e.code, msg: String(e.message).slice(0, 400) }; window.__done = true; },
      );
    }, req);
  }

  async function settled(page) {
    await page.waitForFunction(() => window.__done === true, null, { timeout: 20_000 });
    return page.evaluate(() => ({ r: window.__r, e: window.__e }));
  }

  // Click "yes" on the confirm dialog whose question matches, so a sequence
  // of prompts (consent → grant → sign) never clicks the wrong one. The
  // question text distinguishes them: the grant says "Authorise …", the
  // per-call sign does not.
  async function answerWhen(page, match, exclude) {
    await page.waitForFunction(({ m, x }) => {
      const el = document.querySelector('.tx-confirm .question');
      if (!el) return false;
      const txt = el.textContent || '';
      return txt.includes(m) && (!x || !txt.includes(x));
    }, { m: match, x: exclude }, { timeout: 20_000 });
    await page.click('#confirmYes');
  }

  test('eth_chainId answers a real chain id (regression: 0xNaN)', async ({ page }) => {
    const chain = await page.evaluate(() => window.ethereum.request({ method: 'eth_chainId' }));
    expect(chain).toBe('0x1');
    const net = await page.evaluate(() => window.ethereum.request({ method: 'net_version' }));
    expect(net).toBe('1');
  });

  test('refusals stay honest: 4200 allow-list, 4100 gate, permissions as []', async ({ page }) => {
    const bad = await page.evaluate(() => window.ethereum.request({ method: 'eth_sign' })
      .then(() => null, (e) => ({ code: e.code })));
    expect(bad.code).toBe(4200);

    // Unconnected: empty answers where the spec wants empties, refusal where
    // it wants one — and never a node error (was: -32601 Method not found).
    const empty = await page.evaluate(() => Promise.all([
      window.ethereum.request({ method: 'eth_accounts' }),
      window.ethereum.request({ method: 'wallet_getPermissions' }),
    ]));
    expect(empty[0]).toEqual([]);
    expect(empty[1]).toEqual([]);

    const denied = await page.evaluate(() => window.ethereum.request({
      method: 'personal_sign',
      params: ['0x68656c6c6f', '0x' + 'ab'.repeat(20)],
    }).then(() => null, (e) => ({ code: e.code })));
    expect(denied.code).toBe(4100);
  });

  test('connect → wallet_getPermissions → personal_sign signs locally (regression: node -32601)', async ({ page }) => {
    test.setTimeout(120_000);
    await fire(page, { method: 'eth_requestAccounts' });
    await answerWhen(page, 'Connect this site');
    const conn = await settled(page);
    expect(conn.e).toBeNull();
    expect(conn.r[0]).toMatch(/^0x[0-9a-fA-F]{40}$/);

    const perms = await page.evaluate(() => window.ethereum.request({ method: 'wallet_getPermissions' }));
    expect(perms).toHaveLength(1);
    expect(perms[0].parentCapability).toBe('eth_accounts');

    await fire(page, { method: 'personal_sign', params: ['0x68656c6c6f', conn.r[0]] });
    await answerWhen(page, 'Authorise personal_sign');
    await answerWhen(page, 'personal_sign', 'Authorise');
    const signed = await settled(page);
    expect(signed.e).toBeNull();
    expect(signed.r).toMatch(/^0x[0-9a-f]{130}$/, 'a real 65-byte signature, not a node error');
  });

  test('wallet_switchEthereumChain: null + chainChanged + chain moved (regression: -32601, silent)', async ({ page }) => {
    test.setTimeout(120_000);
    await fire(page, { method: 'eth_requestAccounts' });
    await answerWhen(page, 'Connect this site');
    expect((await settled(page)).e).toBeNull();

    await page.evaluate(() => {
      window.__cc = [];
      window.ethereum.on('chainChanged', (id) => window.__cc.push(id));
    });
    expect(await page.evaluate(() => window.ethereum.request({ method: 'eth_chainId' }))).toBe('0x1');

    await fire(page, { method: 'wallet_switchEthereumChain', params: [{ chainId: '0x89' }] });
    await answerWhen(page, 'Authorise wallet_switchEthereumChain');
    const sw = await settled(page);
    expect(sw.e).toBeNull();
    expect(sw.r).toBeNull(); // EIP-3326: null on success

    const cc = await page.evaluate(() => window.__cc);
    expect(cc).toEqual(['0x89']); // the event that never fired before
    expect(await page.evaluate(() => window.ethereum.request({ method: 'eth_chainId' }))).toBe('0x89');
  });

  test('wallet_watchAsset: one confirm with the token details, then it is stored', async ({ page }) => {
    test.setTimeout(120_000);
    await fire(page, { method: 'eth_requestAccounts' });
    await answerWhen(page, 'Connect this site');
    expect((await settled(page)).e).toBeNull();

    await fire(page, {
      method: 'wallet_watchAsset',
      params: [{ type: 'ERC20', options: { address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', symbol: 'DAI', decimals: 18 } }],
    });
    await answerWhen(page, 'Watch DAI');
    const res = await settled(page);
    expect(res.e).toBeNull();
    expect(res.r).toBe(true);

    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('bear.customTokens') || '[]'));
    expect(stored.some((t) => t.symbol === 'DAI' && t.chainId === 1)).toBe(true);
  });
});
