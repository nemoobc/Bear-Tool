// 02 — Wallet import flow: mnemonic, private key, validation, lock/unlock.
import { test, expect } from '@playwright/test';
import { ethers } from 'ethers';
import {
  gotoApp, skipIntro, importWallet, unlock, expectUnlocked,
  collectErrors, assertNoErrors,
} from './helpers.js';

test.describe('Wallet import', () => {
  test('import mnemonic → unlocked, address matches', async ({ page }) => {
    const w = ethers.Wallet.createRandom();
    const errors = collectErrors(page);
    await gotoApp(page);
    await skipIntro(page);
    await importWallet(page, { secret: w.mnemonic.phrase });
    await expectUnlocked(page);
    // account modal shows the full address
    await page.click('#accountPill');
    await expect(page.locator('.modal .mono').first()).toContainText(w.address.slice(0, 10));
    await assertNoErrors(errors);
  });

  test('import private key → unlocked', async ({ page }) => {
    const w = ethers.Wallet.createRandom();
    await gotoApp(page);
    await skipIntro(page);
    await importWallet(page, { secret: w.privateKey });
    await expectUnlocked(page);
  });

  test('import with short password rejected', async ({ page }) => {
    const w = ethers.Wallet.createRandom();
    await gotoApp(page);
    await skipIntro(page);
    await page.click('#wImport');
    await page.fill('#importSecret', w.mnemonic.phrase);
    await page.fill('#importPw', 'short');
    await page.click('#importBtn');
    await expect(page.locator('#toast-wrap')).toContainText(/Password too short/i);
    await expect(page.locator('#importBtn')).toBeVisible(); // modal stays open
  });

  test('import with empty secret rejected', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await page.click('#wImport');
    await page.fill('#importPw', 'password123');
    await page.click('#importBtn');
    await expect(page.locator('#toast-wrap')).toContainText(/Enter seed phrase or private key/i);
  });

  test('lock button locks → unlock modal → correct password unlocks', async ({ page }) => {
    const w = ethers.Wallet.createRandom();
    await gotoApp(page);
    await skipIntro(page);
    await importWallet(page, { secret: w.mnemonic.phrase });
    await page.click('#accountPill');
    await page.click('#lockBtn');
    await page.waitForSelector('#unlockPw', { timeout: 10_000 });
    await unlock(page, 'password123');
    await expectUnlocked(page);
  });
});