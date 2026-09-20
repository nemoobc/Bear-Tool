// 04 — Send view: form render, address validation, poisoning detection.
import { test, expect } from '@playwright/test';
import { ethers } from 'ethers';
import { gotoApp, skipIntro, createWallet, openSendView , appClick} from './helpers.js';

test.describe('Send', () => {
  test('send view renders the form', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await openSendView(page);
    await expect(page.locator('#sendTo')).toBeVisible();
    await expect(page.locator('#sendAmount')).toBeVisible();
    await expect(page.locator('#sendToken')).toBeVisible();
    await expect(page.locator('#btnSend')).toBeVisible();
  });

  test('invalid address shows warning in preview', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await openSendView(page);
    await page.fill('#sendTo', '0x123');
    await page.fill('#sendAmount', '0.01');
    await expect(page.locator('#sendPreview')).toContainText(/Invalid address/i);
  });

  test('valid address renders preview', async ({ page }) => {
    const w = ethers.Wallet.createRandom();
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await openSendView(page);
    await page.fill('#sendTo', w.address);
    await page.fill('#sendAmount', '0.01');
    await expect(page.locator('#sendPreview')).toContainText(/Sending/i);
    await expect(page.locator('#sendPreview')).toContainText(w.address.slice(0, 6));
  });

  test('address poisoning: similar address triggers warning modal', async ({ page }) => {
    const victim = ethers.Wallet.createRandom().address;
    // Seed a previous recipient BEFORE the app boots (state reads localStorage).
    await page.addInitScript((addr) => {
      localStorage.setItem('bear.activity', JSON.stringify([
        { type: 'send', to: addr, detail: addr, ts: Date.now() },
      ]));
    }, victim);
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await openSendView(page);
    // same prefix (6) + suffix (4), different middle → poisoning.
    // Must be checksum-valid: doSend() rejects non-checksum addresses via
    // ethers.getAddress() before any destination warning can show.
    const v = victim.toLowerCase();
    const similar = ethers.getAddress(v.slice(0, 6) + 'deadbeefdeadbeefdeadbeefdeadbeef' + v.slice(-4));
    await page.fill('#sendTo', similar);
    await page.fill('#sendAmount', '0.01');
    await appClick(page, '#btnSend');
    await expect(page.locator('#modalOverlay')).toContainText(/ADDRESS POISONING/i);
    await expect(page.locator('#confirmTypeInput')).toBeVisible();
  });

  test('sending to a token contract triggers destination warning', async ({ page }) => {
    // USDC mainnet contract
    const usdc = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await openSendView(page);
    await page.fill('#sendTo', usdc);
    await page.fill('#sendAmount', '0.01');
    await appClick(page, '#btnSend');
    await expect(page.locator('#modalOverlay')).toContainText(/TOKEN CONTRACT DESTINATION/i);
  });
});