// 06 — EIP-7702: panel render + mainnet chainId-0 guard.
import { test, expect } from '@playwright/test';
import { ethers } from 'ethers';
import { gotoApp, skipIntro, createWallet , appClick} from './helpers.js';

test.describe('EIP-7702', () => {
  test('panel renders delegate form', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await appClick(page, '.nav-item[data-view="eip7702"]');
    await expect(page.locator('#delegateAddr')).toBeVisible();
    await expect(page.locator('#delegateChainId')).toBeVisible();
    await expect(page.locator('#delegateAnyChain')).toBeVisible();
    await expect(page.locator('#btnDelegate')).toBeVisible();
    await expect(page.locator('#btnRevoke')).toBeVisible();
  });

  test('mainnet blocks chainId 0 (all chains) with error toast', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await appClick(page, '.nav-item[data-view="eip7702"]');
    await page.fill('#delegateAddr', ethers.Wallet.createRandom().address);
    await page.check('#delegateAnyChain');
    await page.fill('#delegateChainId', '0');
    await appClick(page, '#btnDelegate');
    await expect(page.locator('#toast-wrap')).toContainText(/blocked on mainnet/i);
  });

  test('invalid implementation address rejected', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await appClick(page, '.nav-item[data-view="eip7702"]');
    await page.fill('#delegateAddr', '0x123');
    await appClick(page, '#btnDelegate');
    await expect(page.locator('#toast-wrap')).toContainText(/Invalid implementation address/i);
  });

  test('batch call: add item renders in list', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await appClick(page, '.nav-item[data-view="eip7702"]');
    await appClick(page, '#btnBatchAdd');
    await expect(page.locator('#batchList .batch-item')).toHaveCount(1);
  });
});