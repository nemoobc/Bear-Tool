// 10 — Mobile viewport: bottom nav replaces sidebar, views switch.
import { test, expect } from '@playwright/test';
import { gotoApp, skipIntro, createWallet } from './helpers.js';

test.use({ viewport: { width: 390, height: 844 } });

test.describe('Mobile', () => {
  test('mobile nav visible, sidebar hidden', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await expect(page.locator('#mobileNav')).toBeVisible();
    await expect(page.locator('.sidebar')).toBeHidden();
  });

  test('mobile nav switches views', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await page.click('.mobile-nav-item[data-view="activity"]');
    await expect(page.locator('#view-activity')).toHaveClass(/active/);
    await page.click('.mobile-nav-item[data-view="swap"]');
    await expect(page.locator('#view-swap')).toHaveClass(/active/);
    await page.click('.mobile-nav-item[data-view="settings"]');
    await expect(page.locator('#view-settings')).toHaveClass(/active/);
  });

  test('mobile swap second tap opens chooser → bridge', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await page.click('.mobile-nav-item[data-view="swap"]');
    await page.click('.mobile-nav-item[data-view="swap"]');
    await expect(page.locator('#chooseBridge')).toBeVisible();
    await page.click('#chooseBridge');
    await expect(page.locator('#view-bridge')).toHaveClass(/active/);
  });

  test('mobile quick actions work', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await page.click('.quick-action-btn[data-view="send"]');
    await expect(page.locator('#view-send')).toHaveClass(/active/);
  });
});