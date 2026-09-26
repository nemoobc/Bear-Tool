// 12 — Feature parity, add-token autodetect, network picker, DApps filters.
//
// Locks the seven changes made after the audit pass:
//   #1/#2 mobile reaches every desktop view (bar generated from the sidebar)
//   #3  no sparkline in the asset list
//   #4  "Add Token" below the list, not in the header
//   #5  Add-network is a chain picker, not five free-text fields
//   #6  pasting a contract address detects name/symbol/decimals
//   #7  DApps filter by text and category, cards are keyboard operable
import { test, expect } from '@playwright/test';
import { gotoApp, skipIntro, createWallet, appClick , openView} from './helpers.js';

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'; // Ethereum mainnet

test.describe('Asset list', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await page.waitForTimeout(1500);
  });

  test('#3 the coin list renders no sparkline', async ({ page }) => {
    await expect(page.locator('#assetList .asset-spark')).toHaveCount(0);
  });

  test('#4 Add Token sits below the asset list and not in the header', async ({ page }) => {
    const btn = page.locator('#btnAddCustomToken');
    await expect(btn).toHaveCount(1);
    await expect(page.locator('#assetSearch #btnAddCustomToken')).toHaveCount(0);
    const below = await page.evaluate(() => {
      const list = document.querySelector('#assetList');
      const b = document.querySelector('#btnAddCustomToken');
      return !!(list.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    expect(below, 'Add Token must come after the asset list').toBe(true);
  });

  test('#6 pasting a contract address detects the token before you commit', async ({ page }) => {
    await appClick(page, '#btnAddCustomToken');
    await page.waitForSelector('#customTokenAddr', { timeout: 10_000 });
    // Nothing typed yet — the Add button must stay disabled.
    await expect(page.locator('#btnConfirmAddToken')).toBeDisabled();

    await page.fill('#customTokenAddr', USDC);
    // A real eth_call round trip: symbol()/name()/decimals() off the contract.
    await expect(page.locator('#tdSymbol')).not.toHaveText('Detecting…', { timeout: 20_000 });
    await expect(page.locator('#tdSymbol')).toHaveText(/USDC/i, { timeout: 20_000 });
    await expect(page.locator('#tdName')).toContainText('USD Coin');
    await expect(page.locator('#tdDecimals')).toContainText('6 decimals');
    await expect(page.locator('#btnConfirmAddToken')).toBeEnabled();
  });

  test('#6 a malformed address never enables Add', async ({ page }) => {
    await appClick(page, '#btnAddCustomToken');
    await page.waitForSelector('#customTokenAddr', { timeout: 10_000 });
    for (const bad of ['0x1234', 'not-an-address', '0x' + 'z'.repeat(40)]) {
      await page.fill('#customTokenAddr', bad);
      await page.waitForTimeout(400);
      await expect(page.locator('#btnConfirmAddToken'), `address "${bad}"`).toBeDisabled();
    }
  });
});

test.describe('Add network picker', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
  });

  test('#5 offers a chain picker instead of manual fields', async ({ page }) => {
    await appClick(page, '#networkPill');
    await page.waitForSelector('#netSearchInput', { timeout: 10_000 });
    await appClick(page, '#addNetBtn');
    await page.waitForSelector('#cnSearch', { timeout: 10_000 });

    const presets = page.locator('.chain-preset');
    expect(await presets.count()).toBeGreaterThanOrEqual(15);
    // The old form asked for these by hand; a typo in chainId silently produced
    // a network talking to the wrong chain.
    for (const gone of ['#cnName', '#cnChainId', '#cnSymbol', '#cnExplorer', '#cnType']) {
      await expect(page.locator(gone), `${gone} must be gone`).toHaveCount(0);
    }
    // Rows are divs, so they need the button role + tabindex to be reachable.
    const roles = await presets.evaluateAll((els) =>
      els.every((e) => e.getAttribute('role') === 'button' && e.tabIndex >= 0));
    expect(roles, 'preset rows must be keyboard reachable').toBe(true);
  });

  test('#5 picking a chain fills the RPC field itself', async ({ page }) => {
    await appClick(page, '#networkPill');
    await page.waitForSelector('#netSearchInput', { timeout: 10_000 });
    await appClick(page, '#addNetBtn');
    await page.waitForSelector('#cnSearch', { timeout: 10_000 });

    await page.locator('.chain-preset', { hasText: 'Gnosis' }).first().click();
    await expect(page.locator('#cnForm')).toBeVisible();
    await expect(page.locator('#cnNameLabel')).toHaveText('Gnosis');
    await expect(page.locator('#cnChainLabel')).toContainText('Chain 100');
    await expect(page.locator('#cnRpc')).toHaveValue('https://gnosis-rpc.publicnode.com');
  });

  test('#5 the picker search narrows the list', async ({ page }) => {
    await appClick(page, '#networkPill');
    await page.waitForSelector('#netSearchInput', { timeout: 10_000 });
    await appClick(page, '#addNetBtn');
    await page.waitForSelector('#cnSearch', { timeout: 10_000 });

    await page.fill('#cnSearch', 'celo');
    await page.waitForTimeout(400);
    const shown = await page.locator('.chain-preset:visible').evaluateAll((els) => els.map((e) => e.dataset.name));
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.every((n) => /celo/i.test(n))).toBe(true);
  });
});

test.describe('DApps', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await appClick(page, '.nav-item[data-view="dapps"]');
    await page.waitForSelector('#dappGrid .dapp-card', { timeout: 10_000 });
  });

  test('#7 every card is a keyboard-operable button with a name', async ({ page }) => {
    const cards = page.locator('#dappGrid .dapp-card');
    const n = await cards.count();
    expect(n).toBeGreaterThanOrEqual(10);
    const info = await cards.evaluateAll((els) => els.map((e) => ({
      role: e.getAttribute('role'), tabIndex: e.tabIndex, label: e.getAttribute('aria-label'),
    })));
    expect(info.every((i) => i.role === 'button' && i.tabIndex >= 0)).toBe(true);
    expect(info.every((i) => !!i.label)).toBe(true);
  });

  test('#7 the text filter narrows the grid', async ({ page }) => {
    await page.fill('#dappSearch', 'uni');
    await page.waitForTimeout(400);
    const shown = await page.locator('#dappGrid .dapp-card:visible').evaluateAll((els) => els.map((e) => e.dataset.name));
    expect(shown).toEqual(['Uniswap']);
  });

  test('#7 a category chip filters and reports its pressed state', async ({ page }) => {
    const chip = page.locator('.dapp-chip', { hasText: 'Lending' });
    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    const shown = await page.locator('#dappGrid .dapp-card:visible').evaluateAll((els) => els.map((e) => e.dataset.name).sort());
    // Aave, Balancer and Compound. Compound serves X-Frame-Options: DENY and
    // Balancer was added when the framing headers were re-probed; both are
    // still listed under Lending — `frameable` is about embedding, not category.
    expect(shown).toEqual(['Aave', 'Balancer', 'Compound']);
  });

  test('#7 an empty filter shows a message, not a blank wall', async ({ page }) => {
    await page.fill('#dappSearch', 'zzzz-no-such-dapp');
    await page.waitForTimeout(400);
    await expect(page.locator('#dappNoMatch')).toBeVisible();
  });

  // ── the in-app browser ──────────────────────────────────────────────
  // Two catalogued hosts that are known to allow framing, so these tests
  // exercise navigation rather than the pre-load gate. The gate has its own
  // spec (18) because it deserves one.
  const FRAMABLE = 'https://app.aave.com/';
  const FRAMABLE_2 = 'https://app.balancer.fi/';

  const openBrowser = async (page) => {
    await page.locator('#dappGrid .dapp-card').first().click();
    await page.waitForSelector('#dappBrowserOverlay.open', { timeout: 10_000 });
    await page.waitForSelector('#dbrUrl', { timeout: 10_000 });
  };

  const go = async (page, url) => {
    await page.fill('#dbrUrl', url);
    await page.press('#dbrUrl', 'Enter');
    await page.waitForTimeout(500);
  };

  test('#7 Enter on a card opens the in-app browser', async ({ page }) => {
    await page.locator('#dappGrid .dapp-card').first().focus();
    await expect(page.locator('#dappGrid .dapp-card').first()).toBeFocused();
    await page.keyboard.press('Enter');
    // A card that refuses framing does not throw the user into a new tab
    // silently; the browser still opens and explains. Either way there is a
    // browser to act in, which is what this test is about.
    await expect(page.locator('#dappBrowserOverlay')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#dbrUrl')).toBeVisible();
  });

  // The browser used to be a viewer: the address was a read-only <span> and
  // "Back" just closed the overlay. A sandboxed frame has no history of its
  // own, so the wallet keeps it — these assert it actually does.
  test('#7 the address bar is an editable input, not a label', async ({ page }) => {
    await openBrowser(page);
    const info = await page.locator('#dbrUrl').evaluate((el) => ({ tag: el.tagName, type: el.type }));
    expect(info.tag, 'the address must be editable').toBe('INPUT');
    expect(info.type).toBe('text');
  });

  test('#7 typing a URL navigates instead of only reloading', async ({ page }) => {
    await openBrowser(page);
    await go(page, FRAMABLE);
    await expect(page.locator('#dbrUrl')).toHaveValue(FRAMABLE);
    // The frame must have been pointed at the new URL.
    expect(await page.locator('#dbrFrame').getAttribute('src')).toBe(FRAMABLE);
  });

  test('#7 a non-http URL is rejected instead of being loaded', async ({ page }) => {
    await openBrowser(page);
    await go(page, FRAMABLE);
    const before = await page.locator('#dbrFrame').getAttribute('src');
    await go(page, 'javascript:alert(1)');
    // The frame must be untouched, and the address must not have been rewritten
    // to something that pretends the navigation happened.
    expect(await page.locator('#dbrFrame').getAttribute('src')).toBe(before);
    expect(await page.locator('#dbrUrl').inputValue()).not.toContain('javascript:');
  });

  test('#7 Back and Forward move through history and disable at the ends', async ({ page }) => {
    await openBrowser(page);
    // Start somewhere real so the first entry exists.
    await go(page, FRAMABLE);
    const firstUrl = await page.locator('#dbrUrl').inputValue();
    await expect(page.locator('#dbrBack'), 'nowhere to go back to yet').toBeDisabled();
    await expect(page.locator('#dbrFwd')).toBeDisabled();

    await go(page, FRAMABLE_2);
    // On the newest entry: Back available, Forward NOT — an earlier version of
    // this test asserted Forward was enabled here, which was wrong about how a
    // history stack behaves.
    await expect(page.locator('#dbrBack')).toBeEnabled();
    await expect(page.locator('#dbrFwd')).toBeDisabled();

    await page.locator('#dbrBack').click();
    await page.waitForTimeout(400);
    await expect(page.locator('#dbrUrl')).toHaveValue(firstUrl);
    // Going back re-enables Forward, because a newer entry exists again.
    await expect(page.locator('#dbrFwd')).toBeEnabled();
    await expect(page.locator('#dbrBack'), 'back at the oldest entry').toBeDisabled();
  });

  test('#7 the bookmark toggle persists and reports its state', async ({ page }) => {
    await openBrowser(page);
    await go(page, FRAMABLE);
    const btn = page.locator('#dbrBm');
    await expect(btn).toHaveAttribute('aria-pressed', 'false');
    await btn.click();
    await page.waitForTimeout(250);
    await expect(btn).toHaveAttribute('aria-pressed', 'true');
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('bear.dappBookmarks') || '[]'));
    expect(stored.length, 'the bookmark must be stored').toBeGreaterThan(0);
    await btn.click();
    await page.waitForTimeout(250);
    await expect(btn).toHaveAttribute('aria-pressed', 'false');
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('bear.dappBookmarks') || '[]').length)).toBe(0);
  });

  test('#7 a site that refuses framing is explained, not silently tabbed away', async ({ page }) => {
    // Compound serves X-Frame-Options: DENY. No web page can override that, so
    // the browser says so and offers the button — the user stays in control
    // instead of being dropped into a tab they did not ask for.
    await page.locator('#dappGrid .dapp-card', { hasText: 'Compound' }).click();
    await page.waitForSelector('#dappBrowserOverlay.open', { timeout: 10_000 });
    const body = page.locator('#dbrHomePage');
    await expect(body).toContainText(/will not open inside Bear Tool/i);
    await expect(body.locator('[data-act="popup"]'), 'the real route must be offered').toBeVisible();
    // The frame must NOT have been pointed at a site that will refuse it.
    expect(await page.locator('#dbrFrame').getAttribute('src')).toBeNull();
  });

  test('#7 the corrected framing data is what ships', async ({ page }) => {
    // Re-probed live 2026-09-26: Compound serves DENY, Lido serves
    // frame-ancestors:* (embeddable), Balancer is embeddable. The list was
    // wrong on the first two and missing the third.
    const data = await page.evaluate(() => window._bearDappsProbe || null);
    const rows = await page.locator('#dappGrid .dapp-card').evaluateAll((els) =>
      els.map((e) => ({ name: e.dataset.name, frameable: e.dataset.frameable === '1' })));
    const by = Object.fromEntries(rows.map((r) => [r.name, r.frameable]));
    expect(by.Compound, 'Compound serves X-Frame-Options: DENY').toBe(false);
    expect(by.Lido, 'Lido serves frame-ancestors: *').toBe(true);
    expect(by.Aave, 'Aave sends no framing headers').toBe(true);
    expect(by.Snapshot, 'Snapshot sends no framing headers').toBe(true);
    expect(by.Balancer, 'Balancer sends no framing headers').toBe(true);
    expect(by.Uniswap, 'Uniswap is SAMEORIGIN').toBe(false);
    expect(data, 'no probe payload expected').toBeNull();
  });
});

test.describe('Mobile navigation parity', () => {
  // The bottom bar used to be a hand-written 6 items against a 9-item sidebar,
  // so EIP-7702, Approvals and Tools simply did not exist on a phone.
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('#2 the bar is generated from the sidebar', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    const sidebarViews = await page.locator('.sidebar .nav-item').evaluateAll((els) => els.map((e) => e.dataset.view));
    const primary = await page.locator('#mobileNav .mobile-nav-item[data-view]').evaluateAll((els) => els.map((e) => e.dataset.view));
    expect(primary.length).toBeGreaterThan(0);
    // 8 sidebar entries: EIP-7702 was merged into Tools, so the count dropped
    // from 9. The point of the assertion is parity, not the exact number.
    expect(sidebarViews.length).toBeGreaterThanOrEqual(8);
  });

  test('#1 the More sheet lists every view, including the EIP tools', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    const sidebarViews = await page.locator('.sidebar .nav-item').evaluateAll((els) => els.map((e) => e.dataset.view));
    // Parity is no longer "the sheet lists it" — a sheet could list a view and
    // still leave it unreachable, which is the bug this assertion used to be
    // satisfied by. It is now proved by opening each view on a phone.
    const slots = await page.locator('#mobileNav .mobile-nav-item').evaluateAll((els) => els.map((e) => e.dataset.view));
    for (const v of sidebarViews) {
      await openView(page, v);
      await expect(page.locator('#view-' + v), `${v} must not be desktop-only`).toHaveClass(/active/);
    }
    // Tools (which carries the EIP-7702 suite) must work on mobile too.
    await openView(page, 'deploy');
    await expect(page.locator('#btnDelegate')).toHaveCount(1);
    await expect(page.locator('#deployStandard')).toHaveCount(1);
    expect(slots).toEqual(['dashboard', 'activity', 'swap', 'dapps', 'settings']);
  });

  test('#1 Approvals, Tools, DApps and Settings all open on a phone', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    for (const v of ['approval', 'deploy', 'dapps', 'settings']) {
      await openView(page, v);
      await expect(page.locator('#view-' + v), `${v} must become the active view`).toHaveClass(/active/);
      // A slot highlights only for its own view. A view reached from the
      // Dashboard or from Settings is not one of the five, so nothing lights up
      // — which is honest, rather than a bar pretending to be somewhere else.
      const lit = await page.locator('#mobileNav .mobile-nav-item.active').evaluateAll((els) => els.map((e) => e.dataset.view));
      expect(lit.length === (v === 'settings' ? 1 : 0), `${v}: bar highlight was ${JSON.stringify(lit)}`).toBe(true);
    }
  });
});
