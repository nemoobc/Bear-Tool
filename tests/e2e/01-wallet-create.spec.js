// 01 — Wallet create flow: full happy path, seed verification, validation,
// session persistence, tab-close lock.
import { test, expect } from '@playwright/test';
import {
  gotoApp, skipIntro, createWallet, unlock, expectUnlocked,
  collectErrors, assertNoErrors, expireSession, appClick,
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
    await appClick(page, '#wCreate');
    await page.fill('#createPw', 'password123');
    await page.fill('#createPw2', 'password123');
    await appClick(page, '#createBtn');
    await page.waitForSelector('.seed-choice-btn');
      // The same three stale selectors the shared helper had: #modalBox .mono and
      // #modalBox label never existed (the words render into .seed-words, the
      // question into <p id="seedQLabel">), and a missing locator does not fail
      // fast — textContent() waits out the whole 45s timeout. This test kept its
      // own copy of the flow instead of calling createWallet(), so fixing the
      // helper did nothing for it.
      const mnemonic = await page.locator('[data-copy]').first().getAttribute('data-copy');
      const words = mnemonic.trim().split(/\s+/);
      expect(words, 'the copy button must carry the seed phrase').toHaveLength(12);
      // The app asks to confirm a random index N — the correct word is words[N-1].
      const ask = await page.locator('#seedQLabel').textContent();
      const n = Number((ask.match(/#(\d+)/) || [])[1]);
      const correctIdx = Number.isFinite(n) ? n - 1 : 0;
    // pick a WRONG word that is actually among the 3 choices
    const choices = await page.locator('.seed-choice-btn').evaluateAll((els) =>
      els.map((el) => el.dataset.word)
    );
    const wrong = choices.find((w) => w !== words[correctIdx]);
    expect(wrong).toBeTruthy();
    await appClick(page, `.seed-choice-btn[data-word="${wrong}"]`);
    await expect(page.locator('#seedDone')).toBeDisabled();
    await expect(page.locator('#toast-wrap')).toContainText(/Wrong word/i);
  });

  test('password mismatch rejected', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await appClick(page, '#wCreate');
    await page.fill('#createPw', 'password123');
    await page.fill('#createPw2', 'different123');
    await appClick(page, '#createBtn');
    await expect(page.locator('#toast-wrap')).toContainText(/Passwords do not match/i);
    await expect(page.locator('.seed-choice-btn')).toHaveCount(0);
  });

  test('short password rejected', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await appClick(page, '#wCreate');
    await page.fill('#createPw', 'short');
    await page.fill('#createPw2', 'short');
    await appClick(page, '#createBtn');
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
    await appClick(page, '#accountPill');
    await page.waitForSelector('#unlockPw', { timeout: 10_000 });
    await page.fill('#unlockPw', 'wrongpass');
    await appClick(page, '#unlockBtn');
      // Not the wording. errors.js rewrites "Wrong password" into a sentence a
      // person can act on — "That password did not unlock this wallet. Check it and
      // try again." — so pinning the raw phrase here tested the copy rather than the
      // behaviour, and failed the moment the translator improved. An error toast is
      // the claim being made.
      await expect(page.locator('.toast.error').last()).toBeVisible({ timeout: 15_000 });
    await unlock(page, 'password123');
    await expectUnlocked(page);
  });
});