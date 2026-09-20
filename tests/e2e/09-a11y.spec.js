// 09 — Accessibility: skip link, keyboard nav, accessible button names.
import { test, expect } from '@playwright/test';
import { gotoApp, skipIntro, createWallet , appClick} from './helpers.js';

test.describe('Accessibility', () => {
  test('skip link is present and first focusable', async ({ page }) => {
    await gotoApp(page);
    await expect(page.locator('#skipLink')).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(page.locator('#skipLink')).toBeFocused();
  });

  test('nav items are keyboard operable (focus + Enter)', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await page.locator('.nav-item[data-view="activity"]').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#view-activity')).toHaveClass(/active/);
    await page.locator('.nav-item[data-view="settings"]').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#view-settings')).toHaveClass(/active/);
  });

  test('all buttons have accessible names', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    const unnamed = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')];
      return btns
        .filter((b) => !(b.textContent.trim() || b.getAttribute('aria-label') || b.title))
        .map((b) => b.id || b.className || b.outerHTML.slice(0, 80));
    });
    expect(unnamed, 'buttons without accessible name').toEqual([]);
  });

  test('modal overlay closes via close button', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await appClick(page, '#networkPill');
    await expect(page.locator('#modalOverlay')).toHaveClass(/open/);
    await appClick(page, '#modalOverlay .modal-close');
    await expect(page.locator('#modalOverlay')).not.toHaveClass(/open/);
  });
});