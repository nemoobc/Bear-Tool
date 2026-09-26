// 17 — MAX must leave enough for the fee.
//
// The failure these exist to catch is the one a user hits in one tap: press
// MAX on the native token and the transaction is rejected because it cannot pay
// for itself. The old button wrote the whole balance. The old percentage button
// also used toFixed(), which rounds — so even a 25% share could land a hair
// above what was in the wallet.
//
// A wallet on a forked chain with a real balance is what makes this testable
// end to end; with no balance there is nothing for MAX to get wrong.
import { test, expect } from '@playwright/test';
import { gotoApp, skipIntro, createWallet, appClick } from './helpers.js';

const BALANCE_WEI = '0x2386f26fc10000'; // 0.1 ETH

test.describe('MAX amount', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
  });

  async function seedBalances(page) {
    // Give the wallet a real native balance and a token balance, so both the
    // gas-paying and the non-gas-paying branch can be exercised.
    await page.evaluate(async (wei) => {
      const { set, get } = await import('/js/state.js');
      const provider = get('provider');
      if (provider) {
        try { await provider.send('anvil_setBalance', [get('address'), wei]); } catch { /* not a fork */ }
      }
      const net = get('tokens').find((t) => !t.address);
      if (net) net.balance = wei;
      const usdc = get('tokens').find((t) => t.symbol === 'USDC');
      if (usdc) usdc.balance = '25000000'; // 25 USDC, 6 dp
      set('tokens', get('tokens'));
    }, BALANCE_WEI);
    await page.waitForTimeout(400);
  }

  test('MAX on the native token is below the balance, not equal to it', async ({ page }) => {
    await seedBalances(page);
    await appClick(page, '.nav-item[data-view="send"]');
    await page.waitForSelector('#sendAmount', { timeout: 10_000 });

    await appClick(page, '.pct-btn[data-pct="100"]');
    await page.waitForTimeout(900);

    const value = await page.inputValue('#sendAmount');
    expect(value, 'MAX must write something').not.toBe('');
    const amt = Number(value);
    expect(amt, 'MAX must be under the balance').toBeLessThan(0.1);
    expect(amt, 'MAX must still be worth sending').toBeGreaterThan(0);
  });

  test('MAX explains what it left in the wallet', async ({ page }) => {
    await seedBalances(page);
    await appClick(page, '.nav-item[data-view="send"]');
    await page.waitForSelector('#sendAmount', { timeout: 10_000 });

    await appClick(page, '.pct-btn[data-pct="100"]');
    await page.waitForTimeout(900);

    const note = page.locator('#sendMaxNote');
    await expect(note).toHaveClass(/show/);
    const text = await note.textContent();
    // The user must be able to see WHY the number is not their balance, and
    // what the remainder is for.
    expect(text).toMatch(/fee|cushion/i);
  });

  test('a percentage share is also inside the sendable amount', async ({ page }) => {
    await seedBalances(page);
    await appClick(page, '.nav-item[data-view="send"]');
    await page.waitForSelector('#sendAmount', { timeout: 10_000 });

    await appClick(page, '.pct-btn[data-pct="50"]');
    await page.waitForTimeout(900);
    const half = Number(await page.inputValue('#sendAmount'));

    await appClick(page, '.pct-btn[data-pct="100"]');
    await page.waitForTimeout(900);
    const full = Number(await page.inputValue('#sendAmount'));

    expect(half).toBeGreaterThan(0);
    // 50% of the sendable amount, so strictly less than 100% of it.
    expect(half).toBeLessThan(full);
  });

  test('MAX on a non-gas token is the whole balance', async ({ page }) => {
    await seedBalances(page);
    await appClick(page, '.nav-item[data-view="send"]');
    await page.waitForSelector('#sendAmount', { timeout: 10_000 });

    // Pick a token that is not the gas token.
    const picked = await page.evaluate(() => {
      const sel = document.querySelector('#sendToken');
      const opt = [...sel.options].find((o) => o.value !== 'native');
      if (!opt) return null;
      sel.value = opt.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return opt.value;
    });
    test.skip(!picked, 'this wallet view lists no non-native token');

    await appClick(page, '.pct-btn[data-pct="100"]');
    await page.waitForTimeout(900);
    const value = Number(await page.inputValue('#sendAmount'));
    // 25 USDC exactly — the fee comes out of the native balance, not this one.
    expect(value).toBeCloseTo(25, 4);
  });

  test('swap MAX leaves the fee behind too', async ({ page }) => {
    await seedBalances(page);
    await appClick(page, '.nav-item[data-view="swap"]');
    await page.waitForSelector('#btnSwapMax', { timeout: 10_000 });
    await page.waitForTimeout(800);

    await appClick(page, '#btnSwapMax');
    await page.waitForTimeout(1200);
    const value = await page.inputValue('#swapFromAmount');
    expect(value).not.toBe('');
    expect(Number(value)).toBeLessThan(0.1);
  });

  test('bridge has a MAX button at all', async ({ page }) => {
    await appClick(page, '.nav-item[data-view="bridge"]');
    await page.waitForSelector('#btnBridgeMax', { timeout: 10_000 });
    await expect(page.locator('#btnBridgeMax')).toBeVisible();
    await expect(page.locator('#bridgeMaxNote')).toHaveCount(1);
  });
});

test.describe('MAX is honest about a balance that cannot pay the fee', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
  });

  test('a balance below the fee produces an explanation, not a raw node error', async ({ page }) => {
    // 1 wei of native: no fee can ever be paid from this.
    await page.evaluate(async () => {
      const { set, get } = await import('/js/state.js');
      const net = get('tokens').find((t) => !t.address);
      if (net) net.balance = '1';
      set('tokens', get('tokens'));
    });
    await appClick(page, '.nav-item[data-view="send"]');
    await page.waitForSelector('#sendAmount', { timeout: 10_000 });

    await appClick(page, '.pct-btn[data-pct="100"]');
    await page.waitForTimeout(900);

    // The field must be emptied rather than filled with something doomed.
    expect(await page.inputValue('#sendAmount')).toBe('');
    const note = await page.locator('#sendMaxNote').textContent();
    expect(note).toMatch(/not enough|fee/i);
  });
});
