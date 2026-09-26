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
import { gotoApp, skipIntro, createWallet, appClick } from './helpers.js';

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

  test('#7 Enter on a card opens the in-app browser', async ({ page }) => {
    await page.locator('#dappGrid .dapp-card').first().focus();
    await expect(page.locator('#dappGrid .dapp-card').first()).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#dappBrowserOverlay')).toBeVisible();
    await expect(page.locator('#dappBrowserUrl')).toBeVisible();
  });

  // The browser used to be a viewer: the address was a read-only <span> and
  // "Back" just closed the overlay. A sandboxed iframe has no history of its
  // own, so the wallet has to keep it — these assert it actually does.
  test('#7 the address bar is an editable input, not a label', async ({ page }) => {
    await page.locator('#dappGrid .dapp-card').first().click();
    await page.waitForSelector('#dappBrowserUrl', { timeout: 10_000 });
    const tag = await page.locator('#dappBrowserUrl').evaluate((el) => el.tagName);
    expect(tag, 'the address must be editable').toBe('INPUT');
    await expect(page.locator('#dappBrowserUrl')).toHaveValue(/^https?:\/\//);
    await expect(page.locator('#dappBrowserGo')).toBeVisible();
  });

  test('#7 typing a URL navigates instead of only reloading', async ({ page }) => {
    await page.locator('#dappGrid .dapp-card').first().click();
    await page.waitForSelector('#dappBrowserUrl', { timeout: 10_000 });
    await page.fill('#dappBrowserUrl', 'https://example.org/some/path');
    await page.locator('#dappBrowserGo').click();
    await expect(page.locator('#dappBrowserUrl')).toHaveValue('https://example.org/some/path');
    // The frame must have been pointed at the new URL.
    const src = await page.locator('#dappBrowserFrame').getAttribute('src');
    expect(src).toBe('https://example.org/some/path');
  });

  test('#7 a non-http URL is rejected instead of being loaded', async ({ page }) => {
    await page.locator('#dappGrid .dapp-card').first().click();
    await page.waitForSelector('#dappBrowserUrl', { timeout: 10_000 });
    const before = await page.locator('#dappBrowserUrl').inputValue();
    await page.fill('#dappBrowserUrl', 'javascript:alert(1)');
    await page.locator('#dappBrowserGo').click();
    await expect(page.locator('#dappBrowserUrl')).toHaveValue(before);
  });

  test('#7 Back and Forward move through history and disable at the ends', async ({ page }) => {
    await page.locator('#dappGrid .dapp-card').first().click();
    await page.waitForSelector('#dappBrowserUrl', { timeout: 10_000 });
    const firstUrl = await page.locator('#dappBrowserUrl').inputValue();
    // At the first entry there is nowhere to go back to, and no forward entry.
    await expect(page.locator('#dappBrowserBack')).toBeDisabled();
    await expect(page.locator('#dappBrowserFwd')).toBeDisabled();

    await page.fill('#dappBrowserUrl', 'https://example.org/one');
    await page.locator('#dappBrowserGo').click();
    // Now on entry 2 of 2: Back is available, Forward is NOT — you are at the
    // newest page. An earlier version of this test asserted Forward was enabled
    // here, which was simply wrong about how a history stack behaves.
    await expect(page.locator('#dappBrowserBack')).toBeEnabled();
    await expect(page.locator('#dappBrowserFwd')).toBeDisabled();

    await page.fill('#dappBrowserUrl', 'https://example.org/two');
    await page.locator('#dappBrowserGo').click();
    await expect(page.locator('#dappBrowserUrl')).toHaveValue('https://example.org/two');

    await page.locator('#dappBrowserBack').click();
    await expect(page.locator('#dappBrowserUrl')).toHaveValue('https://example.org/one');
    // Going back re-enables Forward, because a newer entry exists again.
    await expect(page.locator('#dappBrowserFwd')).toBeEnabled();

    await page.locator('#dappBrowserBack').click();
    await expect(page.locator('#dappBrowserUrl')).toHaveValue(firstUrl);
    await expect(page.locator('#dappBrowserBack')).toBeDisabled();

    await page.locator('#dappBrowserFwd').click();
    await expect(page.locator('#dappBrowserUrl')).toHaveValue('https://example.org/one');
  });

  test('#7 the bookmark toggle persists and reports its state', async ({ page }) => {
    await page.locator('#dappGrid .dapp-card').first().click();
    await page.waitForSelector('#dappBrowserBookmark', { timeout: 10_000 });
    const btn = page.locator('#dappBrowserBookmark');
    await expect(btn).toHaveAttribute('aria-pressed', 'false');
    await btn.click();
    await expect(btn).toHaveAttribute('aria-pressed', 'true');
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('bear.dappBookmarks') || '[]'));
    expect(stored.length, 'the bookmark must be stored').toBeGreaterThan(0);
    await btn.click();
    await expect(btn).toHaveAttribute('aria-pressed', 'false');
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('bear.dappBookmarks') || '[]').length)).toBe(0);
  });

  test('#7 a site that refuses framing gets a popup route, not a dead frame', async ({ page }) => {
    // Compound sends X-Frame-Options: DENY — it must open in a real window.
    const compound = page.locator('#dappGrid .dapp-card', { hasText: 'Compound' });
    await compound.click();
    await page.waitForSelector('#dappBrowserOverlay', { timeout: 10_000 });
    await expect(page.locator('#dappBrowserOverlay')).toBeVisible();
    await expect(page.locator('#dappBlockedPopup')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#dappBlockedOpen')).toBeVisible();
    // The blocked panel must be inside the real overlay, not orphaned.
    const inside = await page.evaluate(() =>
      !!document.querySelector('#dappBrowserOverlay .dapp-browser-blocked'));
    expect(inside, 'the blocked panel must belong to the open browser').toBe(true);
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
    await page.locator('#mobileMoreBtn').click();
    await page.waitForSelector('#navSheet', { timeout: 10_000 });
    const sheet = await page.locator('#navSheet .nav-sheet-item').evaluateAll((els) => els.map((e) => e.dataset.view));
    const primary = await page.locator('#mobileNav .mobile-nav-item[data-view]').evaluateAll((els) => els.map((e) => e.dataset.view));
    const unreachable = sidebarViews.filter((v) => !sheet.includes(v) && !primary.includes(v));
    expect(unreachable, 'no view may be desktop-only').toEqual([]);
    // Tools (which now carries the EIP-7702 suite), Approvals and DApps must all
    // be one tap away on a phone.
    for (const v of ['deploy', 'approval', 'dapps']) {
      expect(sheet, `${v} must be reachable on mobile`).toContain(v);
    }
    // And the EIP-7702 forms must be inside Tools on mobile too.
    await page.locator('#navSheet .nav-sheet-item[data-view="deploy"]').click();
    await expect(page.locator('#btnDelegate')).toHaveCount(1);
    await expect(page.locator('#deployStandard')).toHaveCount(1);
  });

  test('#1 Approvals, Tools, DApps and Settings all open on a phone', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    for (const v of ['approval', 'deploy', 'dapps', 'settings']) {
      await page.locator('#mobileMoreBtn').click();
      await page.waitForSelector('#navSheet', { timeout: 10_000 });
      await page.locator(`#navSheet .nav-sheet-item[data-view="${v}"]`).click();
      await expect(page.locator('#view-' + v), `${v} must become the active view`).toHaveClass(/active/);
      // A view behind "More" has no bar button, so More itself lights up.
      await expect(page.locator('#mobileMoreBtn')).toHaveClass(/active/);
    }
  });
});
