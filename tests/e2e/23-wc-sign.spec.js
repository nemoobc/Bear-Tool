// 23 — WalletConnect signing from a dApp OUTSIDE the app: pair over the real
// relay, then prove every sign request stops at a sheet whose answer reaches
// the dApp cryptographically. The node side of this file IS the dApp
// (@walletconnect/sign-client, same projectId the app falls back to), so the
// test exercises the protocol the app really speaks, not a mock.
//
// Policy (mirrors tests/e2e-wc.mjs): relay unreachable at INIT → SKIP with a
// reason; any failure after the session is established → real FAIL, because a
// half-working wallet must never look like "no internet".
//
// The happy-path broadcast (receipt, moved balance) lives in e2e-wc.mjs
// against anvil. Here the transaction path is covered by the rails that are
// decided BEFORE any network I/O — the sheet the user actually reads (and
// declines), and the two refusals (foreign `from` → 4100, no recipient → no
// calldata) — which is exactly the S1 hardening this spec trains.
import { test, expect } from '@playwright/test';
import { SignClient } from '@walletconnect/sign-client';
import { getBytes, verifyMessage, verifyTypedData } from 'ethers';
import { gotoApp, skipIntro, createWallet, appClick } from './helpers.js';

const PROJECT_ID = '99909bde486039e2102663b92be74974';
const MSG = '0x68656c6c6f2062656172'; // "hello bear" — the same shape the UI signs

test.describe('WalletConnect sign requests', () => {
  test.beforeEach(async ({ page }) => {
    // Full relay ceremony plus onboarding on a slow device — the assertions,
    // not the clock, must decide the outcome.
    test.setTimeout(180_000);
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
    await appClick(page, '.nav-item[data-view="dapps"]');
    await page.waitForSelector('#dappsContainer .dapps-browser', { timeout: 10_000 });
  });

  test('pair → proposal → personal_sign → typed → tx sheet (declined) → refusals', async ({ page }) => {
    let dapp;
    try {
      dapp = await SignClient.init({
        projectId: PROJECT_ID,
        metadata: { name: 'Bear Tool E2E dApp', url: 'https://e2e.example.org', icons: [] },
      });
    } catch (e) {
      test.skip(true, 'relay unreachable at init — ' + ((e && e.message) || e));
    }

    let session = null;
    try {
      const { uri, approval } = await dapp.connect({
        requiredNamespaces: {
          eip155: {
            methods: ['eth_requestAccounts', 'personal_sign', 'eth_signTypedData_v4', 'eth_sendTransaction'],
            chains: ['eip155:1'],
            events: [],
          },
        },
      });
      expect(uri, 'no pairing URI issued').toMatch(/^wc:/);
      // The approval promise must exist BEFORE the sheet is confirmed: this
      // sign-client build returns it as a FUNCTION (same shape guards
      // e2e-wc.mjs against — "approval settled after 1ms → function").
      const approvalP = typeof approval === 'function' ? approval() : approval;

      // 1. The app side: open the browser, go somewhere real (the pair
      //    affordance belongs to a browser that actually loaded a page), and
      //    spend the URI through the pair sheet.
      const card = page.locator('.dapp-card[data-frameable="0"]').first();
      await card.click();
      await page.waitForSelector('#dappBrowserOverlay.open', { timeout: 10_000 });
      await page.fill('#dbrUrl', 'https://example.com/');
      await page.press('#dbrUrl', 'Enter');
      const proceed = page.locator('#dbrBlocked [data-act="proceed"]');
      await proceed.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {});
      if (await proceed.isVisible().catch(() => false)) await proceed.click();
      await appClick(page, '#dbrWcPair');
      await expect(page.locator('#wcPairUri')).toBeVisible({ timeout: 10_000 });
      await page.fill('#wcPairUri', uri);
      await appClick(page, '#wcPairGo');

      // 2. The proposal arrives → consent sheet. It names the dApp and the
      //    host veto (S1) runs before it: an unknown host still gets a sheet,
      //    a blocked/danger one never would.
      await expect(page.locator('.tx-confirm .question')).toContainText('Connect', { timeout: 60_000 });
      await expect(page.locator('.tx-detail')).toContainText('e2e.example.org', { timeout: 10_000 });
      await appClick(page, '#confirmYes');

      session = await Promise.race([
        approvalP,
        new Promise((_, rej) => setTimeout(() => rej(new Error('session approval timeout')), 60_000)),
      ]);
      expect(session?.topic, 'no session topic after approval').toBeTruthy();

      // 3. The session answers reads silently…
      const accounts = await dapp.request(
        { topic: session.topic, chainId: 'eip155:1', request: { method: 'eth_accounts', params: [] } },
        { timeout: 30_000 },
      );
      expect(accounts?.[0]).toMatch(/^0x[0-9a-fA-F]{40}$/);
      const account = accounts[0];

      // 4. …and personal_sign stops at the sheet: the user reads WHAT is
      //    signed and WITH WHICH account, and only then signs.
      const signP = dapp.request(
        { topic: session.topic, chainId: 'eip155:1', request: { method: 'personal_sign', params: [MSG, account] } },
        { timeout: 60_000 },
      );
      await expect(page.locator('.tx-confirm .question')).toContainText('Sign message', { timeout: 30_000 });
      await expect(page.locator('.tx-detail')).toContainText(account.slice(0, 6), { timeout: 10_000 });
      await appClick(page, '#confirmYes');
      const sig = await signP;
      expect(typeof sig === 'string' && sig.startsWith('0x'), 'a real signature, not a node error').toBe(true);
      expect(verifyMessage(getBytes(MSG), sig), 'the signature must recover to the session account').toBe(account);

      // 5. Typed data: same sheet discipline, one chain guard up front (the
      //    domain must match the wallet's chain — eip155:1 here, matching
      //    the app's default network).
      const domain = { name: 'Bear Tool E2E', version: '1', chainId: 1 };
      const types = { Mail: [{ name: 'content', type: 'string' }] };
      const typedValue = { content: 'hello typed bear' };
      const typedP = dapp.request(
        {
          topic: session.topic,
          chainId: 'eip155:1',
          request: {
            method: 'eth_signTypedData_v4',
            params: [account, JSON.stringify({ domain, types, message: typedValue, primaryType: 'Mail' })],
          },
        },
        { timeout: 60_000 },
      );
      await expect(page.locator('.tx-confirm .question')).toContainText('Sign typed data', { timeout: 30_000 });
      await appClick(page, '#confirmYes');
      const typedSig = await typedP;
      expect(verifyTypedData(domain, types, typedValue, typedSig), 'typed signature must recover to the session account').toBe(account);

      // 6. The transaction sheet: the user SEES destination and value, then
      //    declines — and the decline reaches the dApp as an answer (4001),
      //    not as a hang.
      const txRejectP = dapp.request(
        {
          topic: session.topic,
          chainId: 'eip155:1',
          request: {
            method: 'eth_sendTransaction',
            params: [{ from: account, to: '0x' + 'cd'.repeat(20), value: '0x38d7ea4c68000' }], // 0.001 ETH
          },
        },
        { timeout: 60_000 },
      );
      await expect(page.locator('.tx-confirm .question')).toContainText('Send transaction', { timeout: 30_000 });
      await expect(page.locator('.tx-detail')).toContainText('0xcdcd', { timeout: 10_000 });
      await appClick(page, '#confirmNo');
      const txRejected = await txRejectP.then(() => null, (e) => e);
      expect(txRejected, 'declining a transaction must reach the dApp').toBeTruthy();
      expect(String(txRejected?.message || txRejected) + ':' + (txRejected?.code ?? '')).toMatch(/rejected|4001/i);

      // 7. Refusals arrive BEFORE any sheet — decided locally, so nothing was
      //    ever shown, signed, or sent. A foreign `from` (4100)…
      const foreign = await dapp.request(
        {
          topic: session.topic,
          chainId: 'eip155:1',
          request: { method: 'eth_sendTransaction', params: [{ from: '0x' + 'ab'.repeat(20), to: account, value: '0x1' }] },
        },
        { timeout: 30_000 },
      ).then(() => null, (e) => e);
      expect(foreign, 'a foreign `from` must be refused').toBeTruthy();
      expect(String(foreign?.message || foreign) + ':' + (foreign?.code ?? '')).toMatch(/not the active account|4100/);

      // …and a transaction with nothing to send (32602).
      const empty = await dapp.request(
        {
          topic: session.topic,
          chainId: 'eip155:1',
          request: { method: 'eth_sendTransaction', params: [{ from: account }] },
        },
        { timeout: 30_000 },
      ).then(() => null, (e) => e);
      expect(empty, 'a tx with no recipient and no calldata must be refused').toBeTruthy();
      expect(String(empty?.message || empty) + ':' + (empty?.code ?? '')).toMatch(/recipient|32602/);

      // Neither refusal may open a sheet: the wallet never asks about a
      // request it has already decided it cannot honour.
      await expect(page.locator('.tx-confirm .question')).not.toBeVisible();
    } finally {
      try { if (session?.topic) await dapp.disconnect({ topic: session.topic }); } catch { /* session may already be gone */ }
      try { await dapp.core?.relay?.provider?.disconnect?.(); } catch { /* relay teardown is best-effort */ }
    }
  });
});
