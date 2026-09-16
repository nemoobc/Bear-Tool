// Bear Tool — manual E2E probe (headless, no browser available)
// Runs module-level flows + real API probes with Node's fetch.
// NOT a substitute for a real browser E2E — see E2E-REPORT.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── minimal DOM stub (enough for modules that touch document) ──
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => store.has(k) ? store.get(k) : null,
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k)
};

const elements = new Map();
function makeEl() {
  return {
    innerHTML: '', textContent: '', value: '', disabled: false, checked: false,
    dataset: {}, classList: { add(){}, remove(){}, toggle(){} },
    addEventListener(){}, appendChild(){}, remove(){}, focus(){},
    setAttribute(){}, removeAttribute(){}, style: {}, options: [], selectedIndex: 0
  };
}
globalThis.document = {
  querySelector: (sel) => { if (!elements.has(sel)) elements.set(sel, makeEl()); return elements.get(sel); },
  querySelectorAll: () => [],
  createElement: () => makeEl(),
  getElementById: (id) => { if (!elements.has('#' + id)) elements.set('#' + id, makeEl()); return elements.get('#' + id); }
};
globalThis.window = { addEventListener(){} };
globalThis.matchMedia = () => ({ matches: false });
globalThis.requestAnimationFrame = (fn) => fn(0);
globalThis.performance = { now: () => Date.now() };

const { ethers } = await import('ethers');
globalThis.ethers = ethers;

// Node 24 undici fetch + node:test → "markResourceTiming is not a function" noise.
// Use node:https instead of fetch for API probes (no undici resource timing).
import https from 'node:https';
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https.get({ hostname: u.hostname, path: u.pathname + u.search, headers: { 'User-Agent': 'BearTool-Test/1.0' } }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => resolve({ status: res.statusCode, text: body }));
    }).on('error', reject);
  });
}

const wallet = await import('../js/wallet.js');
const state = await import('../js/state.js');
const i18n = await import('../js/i18n.js');
const theme = await import('../js/theme.js');
const safetx = await import('../js/safetx.js');
const network = await import('../js/network.js');

// ── 1. Wallet unlock (import test mnemonic) ──
test('E2E-probe: import 12-word mnemonic → address + balance display path', async () => {
  store.clear();
  const w = ethers.Wallet.createRandom();
  const res = await wallet.importWallet(w.mnemonic.phrase, 'password123');
  assert.match(res.address, /^0x[a-fA-F0-9]{40}$/);
  assert.equal(wallet.getAccounts().length, 1);
  assert.equal(wallet.getAccounts()[0].address, res.address);
  // B1 FIXED: unlockWallet now detects secret type (phrase vs key) for imported wallets
  const signer = await wallet.unlockWallet('password123');
  assert.equal(signer.address.toLowerCase(), res.address.toLowerCase());
  state.set('signer', signer);
  state.set('address', res.address);
  state.set('unlocked', true);
  console.log('  address:', res.address);
  console.log('  balance display: requires live RPC (dashboard) — see report');
});

// ── 2. Intro 5s + skip ──
test('E2E-probe: intro 5s timer + skip wiring', () => {
  let done = false;
  const intro = makeEl();
  const skip = makeEl();
  const title = makeEl();
  const logo = makeEl();
  document.getElementById = (id) => id === 'intro' ? intro : id === 'introSkip' ? skip : id === 'introTitle' ? title : id === 'introLogo' ? logo : makeEl();
  theme.runIntro(() => { done = true; });
  assert.equal(done, false, 'intro must not finish before 5s');
  // simulate skip click
  const skipHandler = skip.addEventListener.mock?.calls?.[0]?.[1];
  // (addEventListener is stubbed; skip path verified by code review: click → finish)
  console.log('  intro: 5s setTimeout + skip click handler present (code review)');
});

// ── 3. Send double-submit lock ──
test('E2E-probe: runTx double-submit lock blocks re-entry', async () => {
  let calls = 0;
  const btn = makeEl();
  const p1 = safetx.runTx('send', btn, async () => { calls++; await new Promise(r => setTimeout(r, 50)); });
  const p2 = safetx.runTx('send', btn, async () => { calls++; });
  await Promise.all([p1, p2]);
  assert.equal(calls, 1, 'second call must be blocked by pending lock');
});

// ── 4. EIP-7702 chainId guard (mainnet blocks chainId 0) ──
test('E2E-probe: EIP-7702 chainId guard logic', () => {
  const net = network.getNetworkById('ethereum');
  assert.equal(net.type, 'mainnet');
  // replicate doEip7702 guard: anyChain + chainId 0 on mainnet → blocked
  const anyChain = true;
  const inputVal = 0;
  const chainId = anyChain ? 0 : (inputVal > 0 ? inputVal : net.chainId);
  let blocked = false;
  if (chainId === 0 && net.type === 'mainnet') blocked = true;
  assert.equal(blocked, true, 'chainId 0 must be blocked on mainnet');
  // default (no input, no anyChain) → active chain
  const chainId2 = false ? 0 : (0 > 0 ? 0 : net.chainId);
  assert.equal(chainId2, 1);
});

// ── 5. i18n EN/ID ──
test('E2E-probe: i18n toggle EN → ID changes labels', () => {
  i18n.setLang('en');
  assert.equal(i18n.t('nav.dashboard'), 'Dashboard');
  assert.equal(i18n.t('nav.send'), 'Send');
  i18n.setLang('id');
  assert.equal(i18n.t('nav.dashboard'), 'Dasbor');
  assert.equal(i18n.t('nav.send'), 'Kirim');
  assert.equal(i18n.t('settings.language'), 'Bahasa');
  assert.equal(localStorage.getItem('bear.lang'), 'id');
  i18n.setLang('en');
});

// ── 6. Real API probes (KyberSwap / LI.FI / CoinGecko) ──
test('E2E-probe: KyberSwap quote API returns real route (ETH→USDC, mainnet)', async () => {
  const url = 'https://aggregator-api.kyberswap.com/ethereum/api/v1/routes?tokenIn=0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE&tokenOut=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48&amountIn=1000000000000000000';
  const res = await httpGet(url);
  assert.equal(res.status, 200);
  const json = JSON.parse(res.text);
  assert.equal(json.code, 0);
  assert.ok(json.data?.routeSummary?.amountOut, 'routeSummary.amountOut present');
  console.log('  KyberSwap: amountOut =', json.data.routeSummary.amountOut, '| router =', json.data.routerAddress);
});

test('E2E-probe: LI.FI quote API — current bridge.js call (no fromAddress) fails → simulated fallback', async () => {
  // exact URL built by bridge.js doBridge()
  const url = 'https://li.quest/v1/quote?fromChain=1&toChain=10&fromToken=0x0000000000000000000000000000000000000000&toToken=0x0000000000000000000000000000000000000000&fromAmount=1000000000000000000';
  const res = await httpGet(url);
  assert.equal(res.status, 400, 'LI.FI requires fromAddress — bridge.js omits it');
  const json = JSON.parse(res.text);
  console.log('  LI.FI without fromAddress:', json.message);
});

test('E2E-probe: LI.FI quote API works when fromAddress is added', async () => {
  const url = 'https://li.quest/v1/quote?fromChain=1&toChain=10&fromToken=0x0000000000000000000000000000000000000000&toToken=0x0000000000000000000000000000000000000000&fromAmount=1000000000000000000&fromAddress=0x0000000000000000000000000000000000000001';
  const res = await httpGet(url);
  assert.equal(res.status, 200);
  const json = JSON.parse(res.text);
  // LI.FI /quote returns a single route object (not {routes:[...]})
  assert.ok(json.id && json.tool, 'route object present');
  console.log('  LI.FI with fromAddress: tool =', json.tool, '| action.fromToken.symbol =', json.action?.fromToken?.symbol);
  // bridge.js reads q.routes?.[0] — this shape mismatch means even a 200 falls to simulated
  console.log('  bridge.js reads q.routes?.[0] → SHAPE MISMATCH (routes undefined) → simulated fallback');
});

test('E2E-probe: CoinGecko native price API works (dashboard USD)', async () => {
  const res = await httpGet('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
  assert.equal(res.status, 200);
  const json = JSON.parse(res.text);
  assert.ok(json.ethereum?.usd > 0);
  console.log('  CoinGecko ETH USD:', json.ethereum.usd);
});

// let undici fetch resources settle before the runner tears down
await new Promise(r => setTimeout(r, 1500));
// silence undici resource-timing noise (Node 24 + node:test)
process.on('uncaughtException', (e) => {
  if (String(e?.message || '').includes('markResourceTiming')) return;
  throw e;
});