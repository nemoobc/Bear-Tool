// 08 — Approvals, Deploy wizard, Activity views.
import { test, expect } from '@playwright/test';
import { gotoApp, skipIntro, createWallet } from './helpers.js';

test.describe('Approvals / Deploy / Activity', () => {
  test('approval view renders scan controls', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await page.click('.nav-item[data-view="approval"]');
    await expect(page.locator('#btnApprovalScan')).toBeVisible();
    await expect(page.locator('#approvalList')).toBeAttached(); // empty until scan → not "visible"
  });

  test('deploy view renders wizard form', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await page.click('.nav-item[data-view="deploy"]');
    await expect(page.locator('#deployStandard')).toBeVisible();
    await expect(page.locator('#deployName')).toBeVisible();
    await expect(page.locator('#deploySymbol')).toBeVisible();
    await expect(page.locator('#btnDeploy')).toBeVisible();
  });

  test('activity view renders empty state', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await page.click('.nav-item[data-view="activity"]');
    await expect(page.locator('#activityList')).toBeVisible();
  });

  test('NFT view renders gallery container', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await page.click('.nav-item[data-view="nft"]');
    await expect(page.locator('#nftList')).toBeVisible();
  });
});