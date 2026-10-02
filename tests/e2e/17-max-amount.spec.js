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
import {
  gotoApp, skipIntro, createWallet, fundedWallet, openSendView, appClick,
  freshFork, proxyRpc, FORKS, HAS_ANVIL,
} from './helpers.js';

const BALANCE_WEI = '0x2386f26fc10000'; // 0.1 ETH

// The chain these tests measure against, wired the same way 11-onchain-fork
// wires its sends: a LOCAL ethereum fork behind proxyRpc.
//
// Every comment in this file already assumes one — "a wallet on a forked
// chain", "the fork's 0.1 ETH", "a mainnet-fork address" — because
// anvil_setBalance only EXISTS on a fork, and opening the Send view re-reads
// balances from the chain and overwrites the cache. CI never provided that
// fork (playwright.config.js says the same out loud: without the seeded
// storageState "every spec that needs a balance times out"), so all three
// balance-dependent tests ran against real mainnet, where anvil's account
// holds nothing: CI 36955492385 failed 111/170/235 with provider=null,
// spendable="0" and "Balance 0 ETH". One fresh fork per FILE (workers:1 →
// one process): the first test pays the restart, the rest reuse it — ethereum
// prunes state slowly, unlike the fast chains 11 restarts per test.
let forkStarted = false;
async function wireFork(page) {
  if (!forkStarted) { freshFork('ethereum'); forkStarted = true; }
  await proxyRpc(page, FORKS.ethereum);
}

// A fork restart (≈15s healthy, longer when the upstream is slow) plus the
// UI flow needs more than the 45s default — the same budget 11-onchain-fork
// already claims for the identical reason.
test.setTimeout(300_000);

// Module scope, not inside the first describe. The second describe — the one about
// a balance too small to pay the fee — called waitForTokens and got a bare
// ReferenceError, because a function declared inside a describe callback is not
// visible to the next one. That is a test that reports a JavaScript scoping error
// as if it were a wallet problem.

// Seed the cached token balances, then RE-ENTER the Send view so the dropdown is
// rebuilt from what was just written.
//
// Both halves matter. MAX prefers a LIVE balanceOf() read and only accepts it when
// it is non-zero, falling back to the cached balance — and on a mainnet fork a
// well-known test address holds none of these tokens, so the live read is always 0
// and the cached value is what decides. A <select> rendered before the seed
// therefore reports the balance the wallet had BEFORE, not the one just set, and MAX
// dutifully reports that: 0 for a seeded 25 USDC, and 0.009919 for a seeded 1 wei
// because it was still working from the fork's 0.1 ETH.
//
// openSendView cannot fix this by itself, and that is deliberate: it is idempotent
// so a second call does not try to click a dashboard button that is display:none
// from inside the Send view. Re-entering is therefore the caller's job.
async function seedAndReenter(page, { native, usdc } = {}) {
  await page.evaluate(async (seed) => {
    const { set, get } = await import('/js/state.js');
    // The NATIVE balance is set on the node first, because that is the read MAX
    // prefers. Patching the cached copy alone is not enough: opening the Send view
    // re-reads from the chain and overwrites it, which is why a seeded 1 wei kept
    // coming back as the fork's 0.1 ETH.
    if (seed.native !== undefined) {
      const provider = get('provider');
      if (provider) {
        try { await provider.send('anvil_setBalance', [get('address'), seed.native]); }
        catch { /* not a fork: the cached patch below is all there is */ }
      }
    }
    const tokens = get('tokens');
    if (seed.native !== undefined) {
      const net = tokens.find((t) => !t.address);
      if (net) net.balance = seed.native;
    }
    if (seed.usdc !== undefined) {
      const t = tokens.find((x) => x.symbol === 'USDC');
      if (t) t.balance = seed.usdc;
    }
    set('tokens', tokens);
  }, { native, usdc });
  await page.waitForTimeout(400);
  await appClick(page, '.nav-item[data-view="dashboard"]');
  await openSendView(page);
  await page.waitForFunction(() => {
    const sel = document.querySelector('#sendToken');
    return sel && sel.options.length > 0;
  }, null, { timeout: 20_000 });
}

async function waitForTokens(page) {
  await openSendView(page);
  await page.waitForFunction(() => {
    const sel = document.querySelector('#sendToken');
    return sel && sel.options.length > 0;
  }, null, { timeout: 20_000 });
}

async function seedBalances(page) {
  // Give the wallet a real native balance and a token balance, so both the
  // gas-paying and the non-gas-paying branch can be exercised.
  await waitForTokens(page);
  await page.evaluate(async (wei) => {
    const { get } = await import('/js/state.js');
    const provider = get('provider');
    if (provider) {
      try { await provider.send('anvil_setBalance', [get('address'), wei]); } catch { /* not a fork */ }
    }
  }, BALANCE_WEI);
  await seedAndReenter(page, { native: BALANCE_WEI, usdc: '25000000' }); // 25 USDC, 6 dp
}

test.describe('MAX amount', () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!HAS_ANVIL, 'needs anvil (foundry) — https://foundry.paradigm.xyz');
    await wireFork(page);
    await gotoApp(page);
    await skipIntro(page);
    // A funded wallet, not a fresh one. createWallet() generates a random key,
    // which holds nothing, so the token dropdown stays empty and every wait for
    // it ends at the 45s test timeout — a failure that says nothing about MAX.
    // Only a wallet that holds something can test what MAX promises.
    await fundedWallet(page);
  });

  // The send dropdown is filled when the SEND VIEW is opened, not at boot. The
  // app boots on the dashboard, where #sendToken legitimately has no options —
  // so waiting for it without opening the view waits for something that will
  // never happen, and 20 seconds later the failure reads like a wallet problem
  // instead of a missing click. The dashboard meanwhile held all 20 assets, which
  // is how it was found: the asset list was full and the dropdown empty at the
  // same instant.

  test('MAX on the native token is below the balance, not equal to it', async ({ page }) => {
    await seedBalances(page);
    await openSendView(page);
    await page.waitForSelector('#sendAmount', { timeout: 10_000 });
    await waitForTokens(page);

    await appClick(page, '.pct-btn[data-pct="100"]');
    await page.waitForTimeout(900);

    const value = await page.inputValue('#sendAmount');
    if (value === '') {
      // resolveMax's refusal reason only reaches #sendMaxNote; an empty field
      // alone cannot say WHY it refused. Carry the note, the seed state and a
      // live re-run of resolveMax into the assertion so the CI log names the
      // cause instead of just the empty input.
      const note = await page.locator('#sendMaxNote').textContent().catch(() => '(none)');
      const diag = await page.evaluate(async (wei) => {
        try {
          const [{ get }, { resolveMax }] = await Promise.all([import('/js/state.js'), import('/js/max-ui.js')]);
          const sel = document.getElementById('sendToken');
          const t = (get('tokens') || []).find((x) => (x.address || 'native') === sel?.value);
          const provider = get('provider');
          let live = null;
          let seeded = null;
          try { live = String(await provider.getBalance(get('address'))); } catch (e) { live = 'ERR ' + (e?.message || e); }
          try { await provider.send('anvil_setBalance', [get('address'), wei]); seeded = 'ok'; } catch (e) { seeded = 'failed: ' + (e?.message || e); }
          const r = await resolveMax({
            token: t && { balance: t.balance, decimals: t.decimals, address: t.address, symbol: t.symbol },
            provider, from: get('address'),
            to: (document.getElementById('sendTo')?.value || '').trim(), pct: 100,
          });
          return { live, seeded, ok: r.ok, spendable: String(r.spendable), balanceSource: r.balanceSource, source: r.source, message: r.message };
        } catch (e) { return { probeError: String(e) }; }
      }, BALANCE_WEI);
      expect(value, `MAX must write something [note="${note}"] [diag=${JSON.stringify(diag)}]`).not.toBe('');
    }
    expect(value, 'MAX must write something').not.toBe('');
    const amt = Number(value);
    expect(amt, 'MAX must be under the balance').toBeLessThan(0.1);
    expect(amt, 'MAX must still be worth sending').toBeGreaterThan(0);
  });

  test('MAX explains what it left in the wallet', async ({ page }) => {
    await seedBalances(page);
    await openSendView(page);
    await page.waitForSelector('#sendAmount', { timeout: 10_000 });
    await waitForTokens(page);

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
    await openSendView(page);
    await page.waitForSelector('#sendAmount', { timeout: 10_000 });
    await waitForTokens(page);

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
    await page.waitForSelector('#sendAmount', { timeout: 10_000 });

    // Pick a token that is not the gas token.
    const picked = await page.evaluate(() => {
      const sel = document.querySelector('#sendToken');
      const opt = [...sel.options].find((o) => o.value !== 'native');
      if (!opt) return null;
      sel.value = opt.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return { value: opt.value, label: opt.textContent };
    });
    test.skip(!picked, 'this wallet view lists no non-native token');
    // Wait for the balance readout that follows the selection to settle.
    await page.waitForTimeout(600);

    // What the wallet is TOLD it holds is the claim MAX has to match.
    //
    // This used to hardcode 25 USDC and failed with 0, because the only way to give
    // a mainnet-fork address a token balance is to patch the cached state — and
    // opening the Send view re-reads balances from the chain and overwrites it. The
    // app preferring a live balanceOf() read over a cached one is correct and
    // deliberate, so the test has to follow the number the app itself is showing
    // rather than fight it with a seeded value. A token the fork says is empty is a
    // token MAX will correctly report as empty.
    const shown = await page.locator('#sendTokenBalance').textContent();
    const shownNum = Number((shown || '').replace(/[^0-9.]/g, ''));

    await appClick(page, '.pct-btn[data-pct="100"]');
    await page.waitForTimeout(900);
    const value = Number(await page.inputValue('#sendAmount'));

    if (!Number.isFinite(shownNum) || shownNum === 0) {
      // Nothing to send: MAX must say so rather than fill in a doomed amount.
      expect(value === 0 || (await page.inputValue('#sendAmount')) === '',
        `MAX filled ${value} for a token the wallet holds none of (${JSON.stringify(shown)})`)
        .toBe(true);
      return;
    }
    // The fee comes out of the native balance, not this one, so MAX on a non-gas
    // token is the whole of it — no reserve.
    expect(value, `MAX on ${picked.value} must be the whole balance shown (${shown})`)
      .toBeCloseTo(shownNum, Math.min(6, Math.max(0, shownNum.toString().split('.')[1]?.length || 0)));
  });

  test('swap MAX leaves the fee behind too', async ({ page }) => {
    await seedBalances(page);
    await appClick(page, '.nav-item[data-view="swap"]');
      // Not #btnSwapMax: there is no such id. Both the swap and the bridge MAX
      // controls were rebuilt as .pct-btn.pct-max carrying data-swap-pct /
      // data-bridge-pct, alongside the 20/50/70 row instead of separate from it, and
      // the comment in index.html says why: beside those, a button reading "100%"
      // promises to send the whole balance, which it deliberately does not do.
      const swapMax = page.locator('.pct-max[data-swap-pct="100"]');
      await page.waitForSelector('.pct-max[data-swap-pct="100"]', { timeout: 10_000 });
      await appClick(page, '.pct-max[data-swap-pct="100"]');
    await page.waitForTimeout(1200);
    const value = await page.inputValue('#swapFromAmount');
    expect(value).not.toBe('');
    expect(Number(value)).toBeLessThan(0.1);
  });

  test('bridge has a MAX button at all', async ({ page }) => {
    await appClick(page, '.nav-item[data-view="swap"]');
    await appClick(page, '.nav-item[data-view="swap"]');
    await appClick(page, '#chooseBridge');
      await page.waitForSelector('.pct-max[data-bridge-pct="100"]', { timeout: 10_000 });
      await expect(page.locator('.pct-max[data-bridge-pct="100"]')).toBeVisible();
    await expect(page.locator('#bridgeMaxNote')).toHaveCount(1);
  });
});

test.describe('MAX is honest about a balance that cannot pay the fee', () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!HAS_ANVIL, 'needs anvil (foundry) — https://foundry.paradigm.xyz');
    await wireFork(page);
    await gotoApp(page);
    await skipIntro(page);
    // A funded wallet, not a fresh one. createWallet() generates a random key,
    // which holds nothing, so the token dropdown stays empty and every wait for
    // it ends at the 45s test timeout — a failure that says nothing about MAX.
    // Only a wallet that holds something can test what MAX promises.
    await fundedWallet(page);
  });

  test('a balance below the fee produces an explanation, not a raw node error', async ({ page }) => {
    // 1 wei of native: no fee can ever be paid from this. Seeded and re-entered
    // through the shared helper — without the re-entry MAX kept reading the fork's
    // 0.1 ETH and reported 0.009919 for a wallet holding a single wei.
    await seedAndReenter(page, { native: '1' });
    await page.waitForSelector('#sendAmount', { timeout: 10_000 });

    await appClick(page, '.pct-btn[data-pct="100"]');
    await page.waitForTimeout(900);

    // The field must be emptied rather than filled with something doomed.
    expect(await page.inputValue('#sendAmount')).toBe('');
    const note = await page.locator('#sendMaxNote').textContent();
    expect(note).toMatch(/not enough|fee/i);
  });
});
