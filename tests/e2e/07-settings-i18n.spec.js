// 07 — Settings & i18n: language switch, testnet toggle, persistence.
import { test, expect } from '@playwright/test';
import { gotoApp, skipIntro, createWallet , appClick} from './helpers.js';

test.describe('Settings & i18n', () => {
  test('settings view renders all controls', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await appClick(page, '.nav-item[data-view="settings"]');
    await expect(page.locator('#setLang')).toBeVisible();
    await expect(page.locator('#setCurrency')).toBeVisible();
    await expect(page.locator('#setAutoLock')).toBeVisible();
    await expect(page.locator('.switch')).toBeVisible(); // #setTestnet is a visually-hidden checkbox
    await expect(page.locator('#setRpc')).toBeVisible();
    await expect(page.locator('#btnSaveSettings')).toBeVisible();
  });

  test('language switch EN → ID changes nav labels and persists', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await appClick(page, '.nav-item[data-view="settings"]');
    await page.selectOption('#setLang', 'id');
    await appClick(page, '#btnSaveSettings');
    await expect(page.locator('.nav-item[data-view="dashboard"]')).toContainText('Dasbor');
    await expect(page.locator('.nav-item[data-view="activity"]')).toContainText('Aktivitas');
    const lang = await page.evaluate(() => localStorage.getItem('bear.lang'));
    expect(lang).toBe('id');
  });

  test('language persists across reload', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await appClick(page, '.nav-item[data-view="settings"]');
    await page.selectOption('#setLang', 'id');
    await appClick(page, '#btnSaveSettings');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('.nav-item[data-view="dashboard"]')).toContainText('Dasbor');
  });

  test('testnet toggle off falls back to mainnet when active chain is testnet', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    // switch to Sepolia first
    await appClick(page, '#networkPill');
    await appClick(page, '#netListTestnet [data-net="sepolia"]');
    await expect(page.locator('#networkName')).toHaveText(/Sepolia/i);
    // turn testnets off → active chain must fall back to Ethereum
    await appClick(page, '.nav-item[data-view="settings"]');
    await appClick(page, '.switch'); // toggle testnets OFF (checkbox is visually hidden)
    await expect(page.locator('#setTestnet')).not.toBeChecked();
    await appClick(page, '#btnSaveSettings');
    await expect(page.locator('#networkName')).toHaveText(/Ethereum/i);
  });

  test('testnet toggle on makes testnets selectable again', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await appClick(page, '#networkPill');
    await appClick(page, '#netListTestnet [data-net="sepolia"]');
    await expect(page.locator('#networkName')).toHaveText(/Sepolia/i);
    // OFF → falls back to Ethereum (testnet hidden)
    await appClick(page, '.nav-item[data-view="settings"]');
    await appClick(page, '.switch');
    await expect(page.locator('#setTestnet')).not.toBeChecked();
    await appClick(page, '#btnSaveSettings');
    await expect(page.locator('#networkName')).toHaveText(/Ethereum/i);
    // ON again → Sepolia is selectable from the network list
    await appClick(page, '.nav-item[data-view="settings"]');
    await appClick(page, '.switch');
    await expect(page.locator('#setTestnet')).toBeChecked();
    await appClick(page, '#btnSaveSettings');
    await appClick(page, '#networkPill');
    await appClick(page, '#netListTestnet [data-net="sepolia"]');
    await expect(page.locator('#networkName')).toHaveText(/Sepolia/i);
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