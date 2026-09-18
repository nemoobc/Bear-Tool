// 00 — Page load sanity: shell, intro, welcome modal, zero console errors.
import { test, expect } from '@playwright/test';
import { gotoApp, skipIntro, expectWelcome, collectErrors, assertNoErrors } from './helpers.js';

test.describe('Page load', () => {
  test('loads with correct title and app shell', async ({ page }) => {
    const errors = collectErrors(page);
    await gotoApp(page);
    await expect(page).toHaveTitle(/Bear Tool/);
    await expect(page.locator('#app')).toBeVisible();
    await expect(page.locator('.sidebar')).toBeVisible();
    await expect(page.locator('#networkPill')).toBeVisible();
    await expect(page.locator('#accountPill')).toBeVisible();
    await assertNoErrors(errors);
  });

  test('intro shows on first visit and click skips it', async ({ page }) => {
    await gotoApp(page);
    await expect(page.locator('#intro')).toBeVisible();
    await skipIntro(page);
    await expect(page.locator('#intro')).toHaveClass(/hidden/);
    await expectWelcome(page);
  });

  test('welcome modal offers create and import', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await expectWelcome(page);
    await expect(page.locator('#wCreate')).toContainText('Create Wallet');
    await expect(page.locator('#wImport')).toContainText('Import Wallet');
  });

  test('offline banner is hidden when online', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await expect(page.locator('#offlineBanner')).toHaveClass(/hidden/);
  });
});