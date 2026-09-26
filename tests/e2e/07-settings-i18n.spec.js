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
    // key, and the delete. The testnet filter and the custom RPC field are not
    // here any more - the filter lives in the network picker beside the list it
    // filters, and a node belongs with the network it points at.
    await expect(page.locator('#setLang')).toBeVisible();
    await expect(page.locator('#setCurrency')).toBeVisible();
    await expect(page.locator('.theme-btn')).toHaveCount(3);
    await expect(page.locator('#setAutoLock')).toBeVisible();
    await expect(page.locator('#btnClearAllData')).toBeVisible();
    await expect(page.locator('#setTestnet')).toHaveCount(0);
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
    // Turn testnets off from the picker, where the filter lives. It applies on
    // the click - there is no Save step, which is what made the old Settings
    // switch look like it worked while the setting stayed true.
    await appClick(page, '#netShowTestnet');
    await expect(page.locator('#networkName')).toHaveText(/Ethereum/i);
    await expect(page.locator('#netListTestnet [data-net="sepolia"]')).toHaveCount(0);
  });

  test('the testnet filter stays reachable while testnets are hidden', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await appClick(page, '#networkPill');
    await appClick(page, '#netShowTestnet');           // OFF
    await expect(page.locator('#netListTestnet [data-net]')).toHaveCount(0);
    // The control itself must still be there, or a filter you cannot reach is a
    // filter you cannot undo. This is the bug the placement was chosen to avoid.
    await expect(page.locator('#netShowTestnet')).toBeVisible();
    await appClick(page, '#netShowTestnet');           // back ON
    await expect(page.locator('#netListTestnet [data-net="sepolia"]')).toHaveCount(1);
    await appClick(page, '#netListTestnet [data-net="sepolia"]');
    await expect(page.locator('#networkName')).toHaveText(/Sepolia/i);
  });

  test('the testnet filter survives a reload', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await appClick(page, '#networkPill');
    await appClick(page, '#netShowTestnet');           // OFF
    await page.reload({ waitUntil: 'domcontentloaded' });
    await appClick(page, '#networkPill');
    await expect(page.locator('#netShowTestnet')).not.toBeChecked();
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