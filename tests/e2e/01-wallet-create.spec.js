// 01 — Wallet create flow: full happy path, seed verification, validation,
// session persistence, tab-close lock.
import { test, expect } from '@playwright/test';
import {
  gotoApp, skipIntro, createWallet, unlock, expectUnlocked,
  collectErrors, assertNoErrors, expireSession,
} from './helpers.js';

test.describe('Wallet create', () => {
  test('full flow: create → seed phrase → verify word #1 → unlocked dashboard', async ({ page }) => {
    const errors = collectErrors(page);
    await gotoApp(page);
    await skipIntro(page);
    const { words } = await createWallet(page);
    expect(words).toHaveLength(12);
    await expectUnlocked(page);
    await expect(page.locator('#networkName')).toHaveText(/Ethereum/i);
    await expect(page.locator('#totalBalance')).toBeVisible();
    await assertNoErrors(errors);
  });

  test('wrong seed word keeps "I saved it" disabled and toasts', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await page.click('#wCreate');
    await page.fill('#createPw', 'password123');
    await page.fill('#createPw2', 'password123');
    await page.click('#createBtn');
    await page.waitForSelector('.seed-choice-btn');
    const seedText = await page.locator('#modalBox .mono').textContent();
    const words = [...seedText.matchAll(/(\d+)\.\s*(\w+)/g)].map((m) => m[2]);
    // pick a WRONG word that is actually among the 3 choices
    const choices = await page.locator('.seed-choice-btn').evaluateAll((els) =>
      els.map((el) => el.dataset.word)
    );
    const wrong = choices.find((w) => w !== words[0]);
    expect(wrong).toBeTruthy();
    await page.click(`.seed-choice-btn[data-word="${wrong}"]`);
    await expect(page.locator('#seedDone')).toBeDisabled();
    await expect(page.locator('#toast-wrap')).toContainText(/Wrong word/i);
  });

  test('password mismatch rejected', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await page.click('#wCreate');
    await page.fill('#createPw', 'password123');
    await page.fill('#createPw2', 'different123');
    await page.click('#createBtn');
    await expect(page.locator('#toast-wrap')).toContainText(/Passwords do not match/i);
    await expect(page.locator('.seed-choice-btn')).toHaveCount(0);
  });

  test('short password rejected', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await page.click('#wCreate');
    await page.fill('#createPw', 'short');
    await page.fill('#createPw2', 'short');
    await page.click('#createBtn');
    await expect(page.locator('#toast-wrap')).toContainText(/Password too short/i);
    await expect(page.locator('.seed-choice-btn')).toHaveCount(0);
  });

  test('session persists across reload (stays unlocked)', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    // intro already seen (sessionStorage) → straight to boot; session restored
    await expectUnlocked(page);
  });

  test('tab close + expired session → read-only → unlock modal → wrong then right password', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await expireSession(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await skipIntro(page);
    // expired session → read-only dashboard (address restored, wallet locked)
    await expect(page.locator('#accountShort')).toContainText('🔒');
    // account modal requires unlock → unlock modal appears
    await page.click('#accountPill');
    await page.waitForSelector('#unlockPw', { timeout: 10_000 });
    await page.fill('#unlockPw', 'wrongpass');
    await page.click('#unlockBtn');
    await expect(page.locator('#toast-wrap')).toContainText(/Wrong password/i);
    await unlock(page, 'password123');
    await expectUnlocked(page);
  });
});