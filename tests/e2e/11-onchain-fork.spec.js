// 11 — ONCHAIN THROUGH THE REAL WEB UI.
// Opens the app in a browser, imports anvil's funded default key, switches to
// each of the 12 networks and SENDS a real transaction. The app's RPC
// requests are proxied to a local anvil fork of that network (run-fork-web.sh),
// so every send lands in a real chain state. Each test then verifies the
// receipt ONCHAIN through the fork's own RPC: status=1, correct from/to.
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { ethers } from 'ethers';
import {
  gotoApp, skipIntro, importWallet, expectUnlocked, openSendView, appClick,
} from './helpers.js';

// Anvil forks pin to the block they started at. Some upstream nodes (BSC,
// Polygon, Arbitrum…) prune state after ~128 blocks, so a fork that has been
// up for more than a few minutes on a fast chain serves BROKEN state
// ("missing trie node", estimateGas reverts) even though eth_getBalance still
// answers. Fix: restart the fork for THIS network right before each test —
// every test gets a fresh, non-stale fork. Ports never overlap between
// sequential single-worker tests.
const REPO = new URL('../../', import.meta.url).pathname;
function freshFork(netId) {
  execFileSync('bash', ['run-fork-web.sh', 'restart-one', netId], {
    cwd: REPO, stdio: 'pipe', timeout: 90_000,
  });
}

test.setTimeout(300_000);

const ANVIL_KEY0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ANVIL_0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const ANVIL_1 = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

// networkId → { port, type, hosts } — hosts mirror the first RPCs in
// js/network.js for that network (the app tries them in order).
const FORKS = {
  ethereum:          { port: 18545, type: 'mainnet', hosts: ['ethereum-rpc.publicnode.com', 'eth.drpc.org'] },
  bsc:               { port: 18546, type: 'mainnet', hosts: ['bsc-dataseed.binance.org', 'bsc-rpc.publicnode.com'] },
  polygon:           { port: 18547, type: 'mainnet', hosts: ['polygon-bor-rpc.publicnode.com', 'polygon.drpc.org'] },
  arbitrum:          { port: 18548, type: 'mainnet', hosts: ['arb1.arbitrum.io', 'arbitrum-one-rpc.publicnode.com'] },
  optimism:          { port: 18549, type: 'mainnet', hosts: ['mainnet.optimism.io', 'optimism-rpc.publicnode.com'] },
  base:              { port: 18550, type: 'mainnet', hosts: ['mainnet.base.org', 'base-rpc.publicnode.com'] },
  sepolia:           { port: 18551, type: 'testnet', hosts: ['sepolia.gateway.tenderly.co', 'ethereum-sepolia-rpc.publicnode.com'] },
  amoy:              { port: 18552, type: 'testnet', hosts: ['polygon-amoy.drpc.org', 'polygon-amoy-bor-rpc.publicnode.com'] },
  'arbitrum-sepolia': { port: 18553, type: 'testnet', hosts: ['sepolia-rollup.arbitrum.io', 'arbitrum-sepolia-rpc.publicnode.com'] },
  'op-sepolia':       { port: 18554, type: 'testnet', hosts: ['sepolia.optimism.io', 'optimism-sepolia-rpc.publicnode.com'] },
  'base-sepolia':     { port: 18555, type: 'testnet', hosts: ['sepolia.base.org', 'base-sepolia-rpc.publicnode.com'] },
  'bsc-testnet':      { port: 18556, type: 'testnet', hosts: ['data-seed-prebsc-1-s1.bnbchain.org:8545', 'bsc-testnet-rpc.publicnode.com'] },
};

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Intercept only the app's RPC hosts and proxy each request to the fork.
// Everything else (ethers CDN, price API) continues normally.
async function proxyRpc(page, fork) {
  const re = new RegExp('^https://(' + fork.hosts.map(escapeRe).join('|') + ')(:|/|$)');
  await page.route(re, async (route) => {
    const req = route.request();
    // The browser sends a CORS preflight before a JSON POST — answer it so
    // the app's cross-origin fetch is allowed through our local proxy.
    if (req.method() === 'OPTIONS') {
      await route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'POST, OPTIONS',
          'access-control-allow-headers': 'content-type',
        },
        body: '',
      });
      return;
    }
    if (req.method() !== 'POST') { await route.continue(); return; }
    const body = req.postData();
    const resp = await fetch(`http://127.0.0.1:${fork.port}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }).catch(() => null);
    if (!resp) { await route.fulfill({ status: 502, body: 'fork proxy unavailable' }); return; }
    await route.fulfill({
      status: resp.status,
      headers: {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
      },
      body: await resp.text(),
    });
  });
}

// Wait until a send tx shows as success in the persisted activity.
async function waitSendSuccess(page, timeout = 45000) {
  await page.waitForFunction(() => {
    try {
      const acts = JSON.parse(localStorage.getItem('bear.activity') || '[]');
      return acts.some((a) => a.type === 'send' && a.status === 'success');
    } catch { return false; }
  }, null, { timeout });
  return page.evaluate(() => {
    const acts = JSON.parse(localStorage.getItem('bear.activity') || '[]');
    return acts.find((a) => a.type === 'send' && a.status === 'success');
  });
}

async function getReceipt(port, hash) {
  const provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${port}`);
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
  await appClick(page, `.asset-row[data-net="${netId}"]`);
  await page.waitForFunction(
    (id) => localStorage.getItem('bear.networkId') === id,
    netId, { timeout: 10_000 }
  );
}

for (const [netId, fork] of Object.entries(FORKS)) {
  test(`onchain send via web UI → ${netId} fork (:${fork.port})`, async ({ page }) => {
    freshFork(netId); // stale fork state = root cause of intermittent onchain flake
    await proxyRpc(page, fork);
    await gotoApp(page);
    await skipIntro(page);
    await importWallet(page, { secret: ANVIL_KEY0 });
    await expectUnlocked(page);

    await switchNetwork(page, netId);

    // Send view with the native token loaded (proves fork RPC answered).
    await openSendView(page);
    await page.fill('#sendTo', ANVIL_1);
    await page.fill('#sendAmount', '0.0001');
    await page.locator('#btnSend').click({ timeout: 5000 }).catch(async () => {
      const box = await page.locator('#btnSend').boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    });

    // Mainnet networks show an extra "MAINNET TRANSACTION!" gate. Whether it
    // also demands a typed confirmation is app config (TYPED_CONFIRMATION in
    // js/ui.js), so handle both shapes instead of assuming one: if the input is
    // rendered, fill it, then clear the gate. Afterwards the sign dialog is
    // always confirmed.
    if (fork.type === 'mainnet') {
      const typed = page.locator('#confirmTypeInput');
      if (await typed.count() > 0 && await typed.isVisible().catch(() => false)) {
        await typed.fill('YA');
      }
      const gate = page.locator('#confirmYes');
      if (await gate.count() > 0) {
        await gate.click({ timeout: 5000 }).catch(async () => {
          const box = await gate.boundingBox();
          if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        });
      }
    }
    // SIGN TRANSACTION dialog → re-pin the fork right before broadcast
    // (fast chains prune the fork base state within minutes and the UI flow
    // up to here is slow) → sign & send
    await page.waitForSelector('#confirmYes', { timeout: 15_000 });
    freshFork(netId);
    await page.locator('#confirmYes').click({ timeout: 5000 }).catch(async () => {
      const box = await page.locator('#confirmYes').boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    });

    // success persisted in activity → then verify the receipt onchain
    const entry = await waitSendSuccess(page);
    expect(entry, `send activity entry for ${netId}`).toBeTruthy();
    expect(entry.hash).toMatch(/^0x[0-9a-fA-F]{64}$/);

    const receipt = await getReceipt(fork.port, entry.hash);
    expect(receipt, `receipt for ${entry.hash} on ${netId} fork`).toBeTruthy();
    expect(receipt.status).toBe(1);
    expect(receipt.from.toLowerCase()).toBe(ANVIL_0.toLowerCase());
    expect(receipt.to.toLowerCase()).toBe(ANVIL_1.toLowerCase());
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
  freshFork(netId);
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

  // single confirmTx dialog gates+signs. Typed confirmation is disabled
  // app-wide (TYPED_CONFIRMATION in js/ui.js), so there is no
  // #confirmTypeInput — waiting for #confirmYes alone is correct now.
  await page.waitForSelector('#confirmYes', { timeout: 90_000 });
  // dialog is up = compile done → re-pin before broadcast (fast chains
  // prune within minutes, compile already consumed time)
  freshFork(netId);
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
  const provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${fork.port}`);
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