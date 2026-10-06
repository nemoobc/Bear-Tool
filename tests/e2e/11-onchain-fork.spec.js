// 11 — ONCHAIN THROUGH THE REAL WEB UI.
// Opens the app in a browser, imports anvil's funded default key, switches to
// each of the 12 networks and SENDS a real transaction. The app's RPC
// requests are proxied to a local anvil fork of that network (run-fork-web.sh),
// so every send lands in a real chain state. Each test then verifies the
// receipt ONCHAIN through the fork's own RPC: status=1, correct from/to.
import { test, expect } from '@playwright/test';
import { ethers } from 'ethers';
import {
  gotoApp, skipIntro, importWallet, expectUnlocked, openSendView, appClick,
  freshForkResilient, proxyRpc, collectErrors, FORKS, HAS_ANVIL,
} from './helpers.js';

// Every test here needs a real Anvil fork of its network. Anvil forks pin to
// the block they started at, and some upstream nodes (BSC, Polygon, Arbitrum…)
// prune state after ~128 blocks — a fork that has been up for more than a few
// minutes on a fast chain serves BROKEN state ("missing trie node", estimateGas
// reverts) even though eth_getBalance still answers. Hence freshFork() before
// each flow (helpers.js, with the script's own diagnosis attached on failure):
// every test gets a fresh, non-stale fork, ports never overlap between
// sequential single-worker tests, and a machine without foundry reports
// "skipped: needs anvil" instead of an hour of red.
test.beforeEach(() => {
  test.skip(!HAS_ANVIL, 'needs anvil (foundry) — https://foundry.paradigm.xyz');
});

// 660s: freshForkResilient can burn 240s + a 30s pause + 240s before the flow
// even starts (amoy CI 37020081620 needed every second of that window), and a
// test killed at the cap loses the very diagnostics the retry collected.
test.setTimeout(660_000);

const ANVIL_KEY0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ANVIL_0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
// Recipient: 0xdEaD, NOT anvil account 1 (0x7099…). Every one of the 12
// forked chains carries an EIP-7702 delegation on 0x7099… in REAL chain
// state (probe 2026-10-02: mainnets → 0x8a67b5…, sepolia → 0xca11… = multicall3
// with no payable fallback, testnets → their own targets; dEaD is empty code
// 12/12). The app's verifySpendable and signer.sendTransaction both estimateGas
// a transfer TO the recipient, so the delegated code runs there: CI 36997713895
// logged `send failed: execution reverted require(false) … to=0x7099…` on
// sepolia/bsc-testnet and starved amoy's pre-dialog estimate of a response.
// dEaD is the same recipient fork-send.test.js already proves onchain — a
// plain codeless value transfer cannot revert on delegation and needs no
// upstream state fetch, which also keeps the sign window fast.
const SEND_TO = '0x000000000000000000000000000000000000dEaD';

// Wait until a send tx shows as success in the persisted activity.
// 90s, not 45: CI 36983252072's runner IP was rate-limited upstream (429
// "Your IP has exceeded..."), and anvil's fork-retry layer backs off between
// attempts before the receipt ever lands — four sends timed out at 45s with
// the fork itself healthy. The window covers a retry cycle, not a hang.
//
// 150s default, deliberately ABOVE the app's own receipt-retry budget
// (CONFIRM_TIMEOUT_MS = 120s): CI 37027145392 failed bsc and base with
// receipt status=1 on chain and console clean — the app was correctly
// retrying a receipt poll through a publicnode 403 storm (retry to 120s)
// while this wait gave up at 90s. A test may not declare "stuck" while the
// app is still inside its own contract; 150s outwaits 120s with margin.
//
// On timeout the error carries the whole scene, because "Timeout 90000ms
// exceeded" is what CI 36992334807 gave for seven sends — seven rounds of
// root-causing against a blank wall: the last send entry raw from
// localStorage (status/error/hash), which dialog is open, whether the FORK
// itself holds the tx (getReceipt against the port — receipt on chain while
// activity is silent = app recording bug; no receipt = broadcast never
// landed; status 0 = reverted), and the tail of console/pageerror.
async function waitSendSuccess(page, timeout = 150_000, port = null, errors = []) {
  try {
    await page.waitForFunction(() => {
      try {
        const acts = JSON.parse(localStorage.getItem('bear.activity') || '[]');
        return acts.some((a) => a.type === 'send' && a.status === 'success');
      } catch { return false; }
    }, null, { timeout });
  } catch (e) {
    // Dialog identity: closeModal() does NOT clear #modalBox.innerHTML — a
    // settled confirmTx leaves its (hidden) #confirmYes in the DOM forever,
    // so testing bare #confirmYes presence reported "sign-open" for every
    // case in CI 36997713895, including ones whose flow had long moved past
    // it. The overlay's 'open' class is the truth, plus WHICH question is
    // showing and whether #btnSend is stuck in its runTx loading state.
    const snap = await page.evaluate(() => {
      try {
        const acts = JSON.parse(localStorage.getItem('bear.activity') || '[]');
        const sends = acts.filter((a) => a.type === 'send');
        const last = sends[sends.length - 1] || null;
        const overlay = document.querySelector('#modalOverlay');
        const open = !!overlay && overlay.classList.contains('open');
        const q = open
          ? ((document.querySelector('#modalBox .question')?.textContent || '?').slice(0, 60))
          : 'closed';
        const btn = document.querySelector('#btnSend');
        const btnState = btn
          ? `${btn.disabled ? 'disabled' : 'enabled'}:${(btn.textContent || '').trim().slice(0, 24)}`
          : 'missing';
        const dlg = `modal="${q}" btn=${btnState}`
          + (document.querySelector('#sendTo') ? ' send-view' : '');
        return { n: acts.length, last: last ? JSON.stringify(last).slice(0, 500) : null, dlg };
      } catch (x) { return { evalError: String(x), dlg: 'unreadable' }; }
    }).catch((x) => ({ evalError: String(x), dlg: 'page-gone' }));
    let chain = 'not-probed';
    try {
      const m = String(snap.last || '').match(/0x[0-9a-fA-F]{64}/);
      if (!port) chain = 'no port';
      else if (!m) chain = 'no hash in last entry';
      else {
        const r = await getReceipt(port, m[0]);
        chain = r ? `receipt status=${r.status} block=${r.blockNumber}` : 'no receipt on chain';
      }
    } catch (x) { chain = `probe error: ${String(x).slice(0, 120)}`; }
    throw new Error(
      `waitSendSuccess TIMEOUT ${timeout}ms (original: ${String(e).slice(0, 80)}) ` +
      `[dialog=${snap.dlg}] [activity=${JSON.stringify(snap)}] [chain=${chain}] ` +
      `[console/pageerror=${JSON.stringify(errors.slice(-10))}]`
    );
  }
  return page.evaluate(() => {
    const acts = JSON.parse(localStorage.getItem('bear.activity') || '[]');
    return acts.find((a) => a.type === 'send' && a.status === 'success');
  });
}

async function getReceipt(port, hash) {
  // cacheTimeout: -1 — no 250ms response cache, reads see their own writes.
  const provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${port}`, undefined, { cacheTimeout: -1 });
  for (let i = 0; i < 10; i++) {
    const r = await provider.getTransactionReceipt(hash);
    if (r) return r;
    await new Promise((res) => setTimeout(res, 500));
  }
  return null;
}

// Switch network through the network modal — scrolls the row into view first
// (rows below the fold get missed by raw coordinate clicks) and asserts the
// switch stuck via persisted bear.networkId (fail fast, not a mainnet-gate
// dead end 45s later).
async function switchNetwork(page, netId) {
  await appClick(page, '#networkPill');
  const row = page.locator(`.asset-row[data-net="${netId}"]`);
  await row.waitFor({ timeout: 10_000 });
  await row.scrollIntoViewIfNeeded().catch(() => {});
  // Re-selecting the row you already stand on is a deliberate no-op since
  // 342962c (no re-run of the switch, no localStorage write) — decide which
  // case we are in BEFORE clicking, from the current-row marker.
  const already = await page.locator(`.asset-row[data-net="${netId}"][data-net-current]`).count();
  await appClick(page, `.asset-row[data-net="${netId}"]`);
  if (already) {
    await expect(page.locator('#toast-wrap')).toContainText(/Already on this network/i);
  } else {
    await page.waitForFunction(
      (id) => localStorage.getItem('bear.networkId') === id,
      netId, { timeout: 10_000 }
    );
  }
  // Whichever path ran, the wallet must end up standing on netId — the modal
  // names the active network and it must be the one we asked for.
  await expect(page.locator('#networkName')).toContainText(
    netId === 'ethereum' ? /Ethereum/i : /./);
  // The no-op path (re-select current) fires the toast and LEAVES the Networks
  // modal open — 11:320 deploy then timed out waiting for the overlay to lose
  // its 'open' class. Close it explicitly so every caller inherits a shut modal.
  if (await page.locator('#modalOverlay.open').count()) {
    await page.locator('#modalOverlay.open .modal-close')
      .first().click({ timeout: 3000 }).catch(() => {});
    await page.waitForFunction(
      () => !document.querySelector('#modalOverlay')?.classList.contains('open'),
      null, { timeout: 5000 }
    );
  }
}

for (const [netId, fork] of Object.entries(FORKS)) {
  test(`onchain send via web UI → ${netId} fork (:${fork.port})`, async ({ page }) => {
    freshForkResilient(netId); // stale fork state = root cause of intermittent onchain flake
    const errors = collectErrors(page); // dumped by waitSendSuccess on timeout
    await proxyRpc(page, fork);
    await gotoApp(page);
    await skipIntro(page);
    await importWallet(page, { secret: ANVIL_KEY0 });
    await expectUnlocked(page);

    await switchNetwork(page, netId);

    // Send view with the native token loaded (proves fork RPC answered).
    await openSendView(page);
    await page.fill('#sendTo', SEND_TO);
    await page.fill('#sendAmount', '0.0001');
    await page.locator('#btnSend').click({ timeout: 5000 }).catch(async () => {
      const box = await page.locator('#btnSend').boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    });

    // Mainnet networks show an extra "MAINNET TRANSACTION!" gate BEFORE the
    // sign dialog — and it only renders after verifySpendable's estimateGas
    // round-trip returns. The gate and the sign dialog share #confirmYes, so
    // the old non-blocking `gate.count() > 0` raced that render: when the gate
    // was still cooking, the wait below caught the GATE instead of the sign
    // dialog, clicked it, and the real sign dialog opened afterwards with
    // nobody left to click it. CI 36997713895: five mainnet sends sat 90s with
    // dialog=sign-open, activity n=0, silent console. Identify each dialog by
    // its title and click through gates until SIGN is the one up.
    if (fork.type === 'mainnet') {
      await expect(page.locator('#confirmTypeInput')).toHaveCount(0);
      for (let i = 0; i < 4; i++) {
        await page.waitForSelector('#confirmYes', { timeout: 15_000 });
        const q = (await page.locator('.question').first().textContent().catch(() => '')) || '';
        if (/SIGN TRANSACTION/i.test(q)) break;
        // settle() → closeModal() flips the overlay's 'open' class synchronously,
        // so the next visible-wait below only succeeds once the NEXT dialog
        // (the sign one) is actually up — no detached wait needed, and none
        // would work anyway: closeModal keeps #modalBox.innerHTML in the DOM.
        await page.locator('#confirmYes').click({ timeout: 5000 });
      }
    }
    // SIGN TRANSACTION dialog → re-pin the fork right before broadcast
    // (fast chains prune the fork base state within minutes and the UI flow
    // up to here is slow) → sign & send
    await page.waitForSelector('#confirmYes', { timeout: 15_000 });
    const signTitle = (await page.locator('.question').first().textContent().catch(() => '')) || '';
    expect(signTitle, 'dialog yang terbuka harus SIGN TRANSACTION, bukan gate/hasil balapan').toMatch(/SIGN TRANSACTION/i);
    freshForkResilient(netId);
    await page.locator('#confirmYes').click({ timeout: 5000 }).catch(async () => {
      const box = await page.locator('#confirmYes').boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    });

    // success persisted in activity → then verify the receipt onchain
    const entry = await waitSendSuccess(page, 150_000, fork.port, errors);
    expect(entry, `send activity entry for ${netId}`).toBeTruthy();
    expect(entry.hash).toMatch(/^0x[0-9a-fA-F]{64}$/);

    const receipt = await getReceipt(fork.port, entry.hash);
    expect(receipt, `receipt for ${entry.hash} on ${netId} fork`).toBeTruthy();
    expect(receipt.status).toBe(1);
    expect(receipt.from.toLowerCase()).toBe(ANVIL_0.toLowerCase());
    expect(receipt.to.toLowerCase()).toBe(SEND_TO.toLowerCase());
    expect(receipt.blockNumber).toBeGreaterThan(0);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// DEPLOY (Tools → Wizard Deploy) — real ERC-20 deploy through the web UI,
// compiled in-browser by solc, mined on the fork, verified onchain.
// ─────────────────────────────────────────────────────────────────────────────
const NAME = 'Bear Test Token';
const SYMBOL = 'BRK';
const SUPPLY = '1000000';

// The ERC-20 template exposes name()/symbol()/decimals()/totalSupply()/balanceOf().
const ERC20_MIN_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
];

// Run the deploy wizard for one network and verify the result ONCHAIN.
async function deployErc20ViaWeb(page, fork, netId) {
  freshForkResilient(netId);
  await proxyRpc(page, fork);
  await gotoApp(page);
  await skipIntro(page);
  await importWallet(page, { secret: ANVIL_KEY0 });
  await expectUnlocked(page);

  await switchNetwork(page, netId);
  // wait for the network modal to fully close before clicking into Tools
  await page.waitForFunction(
    () => !document.querySelector('#modalOverlay')?.classList.contains('open'),
    null, { timeout: 10_000 }
  );

  // Tools view → Wizard Deploy
  await page.locator('.nav-item[data-view="deploy"]').click({ timeout: 5000 }).catch(async () => {
    const box = await page.locator('.nav-item[data-view="deploy"]').boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  });
  await page.waitForSelector('#btnDeploy', { timeout: 10_000 });
  await page.fill('#deployName', NAME);
  await page.fill('#deploySymbol', SYMBOL);

  // deploy — compiles in-browser (first run downloads solc ~9 MB)
  await page.locator('#btnDeploy').click({ timeout: 5000 }).catch(async () => {
    const box = await page.locator('#btnDeploy').boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  });

  // One confirmTx dialog gates and signs: Cancel plus a named button.
  await page.waitForSelector('#confirmYes', { timeout: 90_000 });
  // dialog is up = compile done → re-pin before broadcast (fast chains
  // prune within minutes, compile already consumed time)
  freshForkResilient(netId);
  await page.locator('#confirmYes').click({ timeout: 5000 }).catch(async () => {
    const box = await page.locator('#confirmYes').boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  });

  // the status card flips to "deployed" with the address
  await page.waitForFunction(
    () => {
      const s = document.querySelector('#deployStatus')?.textContent || '';
      return /deployed/i.test(s);
    },
    null, { timeout: 75_000 }
  );
  const statusText = await page.locator('#deployStatus').textContent();
  const addr = (statusText.match(/0x[0-9a-fA-F]{40}/) || [])[0];
  expect(addr, `deployed contract address for ${netId}`).toMatch(/^0x[0-9a-fA-F]{40}$/);

  // persisted activity entry must be success
  const act = await page.evaluate(() => {
    const acts = JSON.parse(localStorage.getItem('bear.activity') || '[]');
    return acts.find((a) => a.type === 'deploy' && a.status === 'success');
  });
  expect(act, `deploy activity entry for ${netId}`).toBeTruthy();
  expect(act.hash).toMatch(/^0x[0-9a-fA-F]{64}$/);

  // registry is grouped by helper type — wizard deploys live under .token
  const reg = await page.evaluate(() => {
    const r = JSON.parse(localStorage.getItem('bear.deployedContracts') || '{}');
    return ((r && r.token) || []).find((e) => e.address);
  });
  expect(reg, `deployed registry entry for ${netId}`).toBeTruthy();
  expect(reg.address.toLowerCase()).toBe(addr.toLowerCase());

  // ONCHAIN verification straight through the fork's RPC
  // No 250ms cache: freshly deployed code must be visible to getCode.
  const provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${fork.port}`, undefined, { cacheTimeout: -1 });
  const code = await provider.getCode(addr);
  expect(code, `code at ${addr} on ${netId} fork`).not.toBe('0x');
  const token = new ethers.Contract(addr, ERC20_MIN_ABI, provider);
  expect(await token.name()).toBe(NAME);
  expect(await token.symbol()).toBe(SYMBOL);
  expect(await token.decimals()).toBe(18n);
  expect(await token.totalSupply()).toBe(ethers.parseUnits(SUPPLY, 18));
  expect(await token.balanceOf(ANVIL_0)).toBe(ethers.parseUnits(SUPPLY, 18));
}

// one mainnet + one testnet proves both gate paths through the real UI
for (const netId of ['ethereum', 'sepolia']) {
  test(`onchain ERC-20 deploy via web UI → ${netId} fork (:${FORKS[netId].port})`, async ({ page }) => {
    await deployErc20ViaWeb(page, FORKS[netId], netId);
  });
}