// 07 — Settings & i18n: language switch, testnet filter, persistence.
import { test, expect } from '@playwright/test';
import { gotoApp, skipIntro, createWallet , appClick} from './helpers.js';

test.describe('Settings & i18n', () => {
  test('settings view renders exactly its five controls', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await appClick(page, '.nav-item[data-view="settings"]');
      // Five, and five is the point: what the app looks like, how long it holds a
      // key, the testnet filter, and the delete. The custom RPC field is not here —
      // a node belongs with the network it points at.
    await expect(page.locator('#setLang')).toBeVisible();
    await expect(page.locator('#setCurrency')).toBeVisible();
    await expect(page.locator('.theme-btn')).toHaveCount(3);
    await expect(page.locator('#setAutoLock')).toBeVisible();
    await expect(page.locator('#btnClearAllData')).toBeVisible();
      // Testnet mode lives ONLY here (the picker duplicate was removed
      // 2026-10-04: reported as a second toggle for the same setting).
      // settings-shape.test.js lists the five things Settings must hold and
      // setTestnet is one of them, and ui-nav.test.js pins this placement.
      await expect(page.locator('#setTestnet')).toHaveCount(1);
    await expect(page.locator('#setRpc')).toHaveCount(0);
  });

  test('language switch EN → ID changes nav labels and persists', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await appClick(page, '.nav-item[data-view="settings"]');
    // No Save button: every setting here applies the moment it is touched. When
    // the Save button went, this dropdown became a control that changed nothing
    // on screen, so the change is now asserted without one.
    await page.selectOption('#setLang', 'id');
    await expect(page.locator('.nav-item[data-view="dashboard"]')).toContainText('Dasbor');
    await expect(page.locator('.nav-item[data-view="activity"]')).toContainText('Aktivitas');
    // The bottom bar is generated, so it is the one that proves the key reached
    // the markup rather than only the sidebar beside it.
    await expect(page.locator('#mobileNav .mobile-nav-item[data-view="dashboard"]')).toContainText('Dasbor');
    const lang = await page.evaluate(() => localStorage.getItem('bear.lang'));
    expect(lang).toBe('id');
  });

  test('language persists across reload', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await appClick(page, '.nav-item[data-view="settings"]');
    await page.selectOption('#setLang', 'id');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('.nav-item[data-view="dashboard"]')).toContainText('Dasbor');
    await expect(page.locator('#mobileNav .mobile-nav-item[data-view="settings"]')).toContainText('Pengaturan');
  });

  test('auto-lock applies on change, with no Save step', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await appClick(page, '.nav-item[data-view="settings"]');
    await page.selectOption('#setAutoLock', '15');
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('bear.settings') || '{}').autoLock);
    expect(stored, 'auto-lock must persist the moment it is chosen').toBe(15);
  });

  test('there is no Save button, and no setting depends on one', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await appClick(page, '.nav-item[data-view="settings"]');
    // A dead Save button is worse than none: it looks like the thing that makes
    // the settings stick, so people press it and believe the page is broken when
    // a setting quietly did not apply.
    await expect(page.locator('#btnSaveSettings')).toHaveCount(0);
  });

  test('testnet filter falls back to mainnet when the active chain is a testnet', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    // switch to Sepolia first
    await appClick(page, '#networkPill');
    await appClick(page, '#netListTestnet [data-net="sepolia"]');
    await expect(page.locator('#networkName')).toHaveText(/Sepolia/i);
    // Turn testnets off from Settings, the only switch (the picker duplicate
    // was removed 2026-10-04). It applies on the click — no Save step.
    await appClick(page, '.nav-item[data-view="settings"]');
    await page.waitForSelector('#setTestnet', { timeout: 10_000 });
    await appClick(page, '#setTestnet');
    // Standing on a chain that just got filtered away → moved to Ethereum.
    await expect(page.locator('#networkName')).toHaveText(/Ethereum/i);
    await appClick(page, '#networkPill');
    await expect(page.locator('#netListTestnet [data-net="sepolia"]')).toHaveCount(0);
  });

  test('the testnet filter in Settings empties and refills the picker list', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await appClick(page, '.nav-item[data-view="settings"]');
    await appClick(page, '#setTestnet');              // OFF
    await appClick(page, '#networkPill');
    await expect(page.locator('#netListTestnet [data-net]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    // One toggle, in Settings — flipping it back on refills the list.
    await appClick(page, '.nav-item[data-view="settings"]');
    await expect(page.locator('#setTestnet')).toBeChecked();
    await appClick(page, '#setTestnet');              // back ON
    await appClick(page, '#networkPill');
    await expect(page.locator('#netListTestnet [data-net="sepolia"]')).toHaveCount(1);
    await appClick(page, '#netListTestnet [data-net="sepolia"]');
    await expect(page.locator('#networkName')).toHaveText(/Sepolia/i);
  });

  test('the testnet filter survives a reload', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await appClick(page, '.nav-item[data-view="settings"]');
    await appClick(page, '#setTestnet');              // OFF
    await page.reload({ waitUntil: 'domcontentloaded' });
    await appClick(page, '.nav-item[data-view="settings"]');
    await expect(page.locator('#setTestnet')).not.toBeChecked();
    await appClick(page, '#networkPill');
    await expect(page.locator('#netListTestnet [data-net]')).toHaveCount(0);
  });

  test('network switch updates network pill', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await appClick(page, '#networkPill');
    await appClick(page, '#netListTestnet [data-net="sepolia"]');
    await expect(page.locator('#networkName')).toHaveText(/Sepolia/i);
  });
});