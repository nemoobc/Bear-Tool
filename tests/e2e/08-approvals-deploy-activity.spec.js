// 08 — Discord (M3, replaced Approvals), Deploy wizard, Activity views.
import { test, expect } from '@playwright/test';
import { gotoApp, skipIntro, createWallet , appClick} from './helpers.js';

test.describe('Discord / Deploy / Activity', () => {
  test('discord view renders the connect form without needing a chain', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await appClick(page, '.nav-item[data-view="discord"]');
    await expect(page.locator('#view-discord')).toHaveClass(/active/);
    // Both ways in: the PKCE login (Client ID + redirect URI to copy) and the
    // pasted-token path. No wallet address required — renderDiscord paints
    // before the address guard, like the dApp catalogue.
    await expect(page.locator('#btnDiscordLogin')).toBeVisible();
    await expect(page.locator('#discordClientId')).toBeVisible();
    await expect(page.locator('#discordRedirect')).toBeVisible();
    await expect(page.locator('#btnDiscordConnect')).toBeVisible();
    // The old feature's controls must not haunt the page.
    await expect(page.locator('#btnApprovalScan')).toHaveCount(0);
    await expect(page.locator('#approvalList')).toHaveCount(0);
  });

  test('deploy view renders wizard form', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await appClick(page, '.nav-item[data-view="deploy"]');
    await expect(page.locator('#deployStandard')).toBeVisible();
    await expect(page.locator('#deployName')).toBeVisible();
    await expect(page.locator('#deploySymbol')).toBeVisible();
    await expect(page.locator('#btnDeploy')).toBeVisible();
  });

  test('activity view renders empty state', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await appClick(page, '.nav-item[data-view="activity"]');
    await expect(page.locator('#activityList')).toBeVisible();
  });

  test('NFT view renders gallery container', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await appClick(page, '.nav-item[data-view="nft"]');
    await expect(page.locator('#nftList')).toBeVisible();
  });
});