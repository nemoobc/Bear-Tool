// 03 — Navigation: sidebar views, Swap/Bridge chooser, quick actions.
import { test, expect } from '@playwright/test';
import { gotoApp, skipIntro, createWallet } from './helpers.js';

const SIDEBAR_VIEWS = ['dashboard', 'activity', 'nft', 'eip7702', 'approval', 'deploy', 'swap', 'settings'];

test.describe('Navigation', () => {
  test('all sidebar nav items switch views', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    for (const view of SIDEBAR_VIEWS) {
      await page.click(`.nav-item[data-view="${view}"]`);
      await expect(page.locator(`#view-${view}`)).toHaveClass(/active/);
    }
  });

  test('swap second click opens chooser → Bridge reachable', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await page.click('.nav-item[data-view="swap"]');
    await expect(page.locator('#view-swap')).toHaveClass(/active/);
    await page.click('.nav-item[data-view="swap"]');
    await expect(page.locator('#chooseBridge')).toBeVisible();
    await expect(page.locator('#chooseSwap')).toBeVisible();
    await page.click('#chooseBridge');
    await expect(page.locator('#view-bridge')).toHaveClass(/active/);
  });

  test('dashboard quick action Send opens send view', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await page.click('.quick-action-btn[data-view="send"]');
    await expect(page.locator('#view-send')).toHaveClass(/active/);
  });

  test('dashboard quick action Tools opens deploy view', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await page.click('.quick-action-btn[data-view="deploy"]');
    await expect(page.locator('#view-deploy')).toHaveClass(/active/);
  });

  test('quick Receive opens receive modal with wallet address', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await page.click('#quickReceive');
    await expect(page.locator('#modalOverlay')).toContainText(/0x/);
  });
});