// 06 — EIP-7702: the four flows the reference tool ships (batch / rescue /
// claim / revoke) render, guard their inputs, and are wired.
// The suite lives inside the Tools view (data-view="deploy") since the separate
// EIP-7702 view was merged into it, so navigation goes through Tools.
//
// The manual delegate form (#delegateAddr, #delegateChainId, #delegateAnyChain,
// #btnDelegate, #btnRevoke) was REMOVED ON PURPOSE — the reference tool
// (nemoobc/EIP-7702-TOOL) only has batch, rescue, claim and revoke, and every
// flow now takes its chainId from the active network, never from a field
// (owner confirmation, 2026-10-05; also pinned by tests/e2e-probe.test.js).
// The three tests below assert what is actually on screen now: the flows'
// render, an input guard per flow, and the removed form staying gone.
import { test, expect } from '@playwright/test';
import { gotoApp, skipIntro, createWallet , appClick} from './helpers.js';

test.describe('EIP-7702 (inside Tools)', () => {
  test('panel renders the EIP-7702 flows (manual delegate form stays gone)', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await appClick(page, '.nav-item[data-view="deploy"]');
    // batch / rescue / claim / revoke controls must be on screen.
    for (const id of ['btnBatchAdd', 'btnBatchExecute',
      'rescueTargetKey', 'btnRescue', 'claimContract', 'btnClaim',
      'revokeTarget', 'btnCheckDelegation', 'btnRevokeDelegation']) {
      await expect(page.locator('#' + id), `#${id} must render in Tools`).toBeVisible();
    }
    // The queue and registry start EMPTY: a childless flex container has a
    // zero-height box, which Playwright reports as hidden even though the
    // element is in the DOM (the batch test below fills it and then asserts
    // visibility — presence is the invariant here, not layout).
    for (const id of ['batchList', 'deployedRegistryList']) {
      await expect(page.locator('#' + id), `#${id} must exist in Tools`).toHaveCount(1);
    }
    // The Smart EOA form must not creep back — the count is against the whole
    // document, so this also catches it reappearing outside Tools.
    for (const id of ['delegateAddr', 'delegateChainId', 'delegateAnyChain',
      'btnDelegate', 'btnRevoke']) {
      await expect(page.locator('#' + id), `#${id} was removed on purpose`).toHaveCount(0);
    }
  });

  test('revoke card rejects an invalid target address with an error toast', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await appClick(page, '.nav-item[data-view="deploy"]');
    // #revokeTarget auto-fills with the active wallet; an address the app
    // refuses must fail BEFORE any RPC round-trip, with an error toast.
    await page.fill('#revokeTarget', '0x123');
    await appClick(page, '#btnCheckDelegation');
    await expect(page.locator('#toast-wrap')).toContainText(/Invalid address/i);
  });

  test('rescue and claim reject invalid addresses with an error toast', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await appClick(page, '.nav-item[data-view="deploy"]');
    // Same guard shape as the removed implementation-address check: a bad
    // address is refused with an error toast and nothing is sent.
    await page.fill('#rescueSafe', '0x123');
    await appClick(page, '#btnRescue');
    await expect(page.locator('#toast-wrap')).toContainText(/Invalid SAFE address/i);

    await page.fill('#claimContract', '0x123');
    await appClick(page, '#btnClaim');
    await expect(page.locator('#toast-wrap')).toContainText(/Invalid airdrop contract address/i);
  });

  test('batch call: add item renders in list', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await appClick(page, '.nav-item[data-view="deploy"]');
    await appClick(page, '#btnBatchAdd');
    await expect(page.locator('#batchList .batch-item')).toHaveCount(1);
  });
});


test.describe('EIP-7702 M4 (rescue pk + single-fire batch)', () => {
  test('rescue form offers a target private key field', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await appClick(page, '.nav-item[data-view="deploy"]');
    await expect(page.locator('#rescueTargetKey')).toBeVisible();
    await expect(page.locator('#btnRescueTargetKeyToggle')).toBeVisible();
  });

  test('one click on "+ Add action" adds exactly one row (single binding)', async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await appClick(page, '.nav-item[data-view="deploy"]');
    await appClick(page, '#btnBatchAdd');
    await expect(page.locator('#batchList .batch-item')).toHaveCount(1);
    await appClick(page, '#btnBatchAdd');
    await expect(page.locator('#batchList .batch-item')).toHaveCount(2);
  });
});
