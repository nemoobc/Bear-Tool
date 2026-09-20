// 05 — Swap & Bridge views: render, flip, chooser, chain selects.
import { test, expect } from '@playwright/test';
import { gotoApp, skipIntro, createWallet , appClick} from './helpers.js';

test.describe('Swap & Bridge', () => {
  test('swap view renders and flip swaps tokens', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await appClick(page, '.nav-item[data-view="swap"]');
    await expect(page.locator('#swapFrom')).toBeVisible();
    await expect(page.locator('#swapTo')).toBeVisible();
    await expect(page.locator('#swapSlippage')).toBeVisible();
    const fromBefore = await page.locator('#swapFrom').inputValue();
    await appClick(page, '#btnSwapFlip');
    const fromAfter = await page.locator('#swapFrom').inputValue();
    expect(fromAfter).not.toBe(fromBefore);
  });

  test('swap amount input triggers auto-route quote area', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await appClick(page, '.nav-item[data-view="swap"]');
    await page.fill('#swapFromAmount', '0.5');
    // quote area exists (real quote depends on external API — not asserted)
    await expect(page.locator('#swapQuote')).toBeVisible();
  });

  test('bridge view renders via chooser', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await appClick(page, '.nav-item[data-view="swap"]');
    await appClick(page, '.nav-item[data-view="swap"]');
    await appClick(page, '#chooseBridge');
    await expect(page.locator('#view-bridge')).toHaveClass(/active/);
    await expect(page.locator('#bridgeFromChain')).toBeVisible();
    await expect(page.locator('#bridgeToChain')).toBeVisible();
    await expect(page.locator('#bridgeAmount')).toBeVisible();
  });

  test('bridge chain selects have options', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await appClick(page, '.nav-item[data-view="swap"]');
    await appClick(page, '.nav-item[data-view="swap"]');
    await appClick(page, '#chooseBridge');
    const fromOptions = await page.locator('#bridgeFromChain option').count();
    const toOptions = await page.locator('#bridgeToChain option').count();
    expect(fromOptions).toBeGreaterThan(1);
    expect(toOptions).toBeGreaterThan(1);
  });
});