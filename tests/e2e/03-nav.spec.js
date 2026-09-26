// 03 — Navigation: sidebar views, Swap/Bridge chooser, quick actions.
import { test, expect } from '@playwright/test';
import { gotoApp, skipIntro, createWallet , appClick} from './helpers.js';

test.describe('Navigation', () => {
  test('all sidebar nav items switch views', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    // Read the navigation from the page instead of keeping a copy of it here.
    // The hardcoded list went stale the moment EIP-7702 was merged into Tools:
    // it still asked for .nav-item[data-view="eip7702"], which does not exist,
    // so the suite failed on a view that had been correctly removed - and it had
    // quietly stopped covering dapps and send, which the copy also omitted. A
    // duplicate of the thing under test is the same drift the mobile bar had.
    const views = await page.locator('.sidebar .nav-item').evaluateAll(
      (els) => [...new Set(els.map((e) => e.dataset.view).filter(Boolean))]);
    expect(views.length, 'the sidebar must list its views').toBeGreaterThanOrEqual(8);
    expect(views).not.toContain('eip7702');
    for (const view of views) {
      await appClick(page, `.nav-item[data-view="${view}"]`);
      await expect(page.locator(`#view-${view}`), `${view} must become the active view`).toHaveClass(/active/);
    }
  });

  test('swap second click opens chooser → Bridge reachable', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await appClick(page, '.nav-item[data-view="swap"]');
    await expect(page.locator('#view-swap')).toHaveClass(/active/);
    await appClick(page, '.nav-item[data-view="swap"]');
    await expect(page.locator('#chooseBridge')).toBeVisible();
    await expect(page.locator('#chooseSwap')).toBeVisible();
    await appClick(page, '#chooseBridge');
    await expect(page.locator('#view-bridge')).toHaveClass(/active/);
  });

  test('dashboard quick action Send opens send view', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await appClick(page, '.quick-action-btn[data-view="send"]');
    await expect(page.locator('#view-send')).toHaveClass(/active/);
  });

  test('dashboard quick action Tools opens deploy view', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await appClick(page, '.quick-action-btn[data-view="deploy"]');
    await expect(page.locator('#view-deploy')).toHaveClass(/active/);
  });

  test('quick Receive opens receive modal with wallet address', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await appClick(page, '#quickReceive');
    await expect(page.locator('#modalOverlay')).toContainText(/0x/);
  });
});