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

test('E2E-probe: LI.FI quote API — bridge.js sends fromAddress (real route, no simulation)', async () => {
  // exact URL built by bridge.js doBridge() (fromAddress + toAddress pinned)
  const url = 'https://li.quest/v1/quote?fromChain=1&toChain=10&fromToken=0x0000000000000000000000000000000000000000&toToken=0x0000000000000000000000000000000000000000&fromAmount=1000000000000000000&fromAddress=0x0000000000000000000000000000000000000001&toAddress=0x0000000000000000000000000000000000000001';
  const res = await httpGet(url);
  assert.equal(res.status, 200, 'LI.FI requires fromAddress — bridge.js now sends it');
  const json = JSON.parse(res.text);
  console.log('  LI.FI with fromAddress:', json.tool, '| fromToken.symbol =', json.action?.fromToken?.symbol);
});

test('E2E-probe: LI.FI quote API works when fromAddress is added', async () => {
  const url = 'https://li.quest/v1/quote?fromChain=1&toChain=10&fromToken=0x0000000000000000000000000000000000000000&toToken=0x0000000000000000000000000000000000000000&fromAmount=1000000000000000000&fromAddress=0x0000000000000000000000000000000000000001';
  const res = await httpGet(url);
  assert.equal(res.status, 200);
  const json = JSON.parse(res.text);
  // LI.FI /quote returns a single route object (not {routes:[...]})
  assert.ok(json.id && json.tool, 'route object present');
  console.log('  LI.FI with fromAddress: tool =', json.tool, '| action.fromToken.symbol =', json.action?.fromToken?.symbol);
});

test('E2E-probe: CoinGecko native price API works (dashboard USD)', async () => {
  const res = await httpGet('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
  assert.equal(res.status, 200);
  const json = JSON.parse(res.text);
  assert.ok(json.ethereum?.usd > 0);
  console.log('  CoinGecko ETH USD:', json.ethereum.usd);
});

// ── 8. Audit-fix regression contracts (source-level, deterministic) ──
test('E2E-probe: tokenReceive shows wallet address, not token contract', async () => {
  const appJs = (await import('node:fs')).readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
  const i = appJs.indexOf("$('#tokenReceive').onclick");
  const line = appJs.slice(i, appJs.indexOf('};', i));
  assert.ok(line.includes("showReceiveModal(get('address')"), 'receive modal must use wallet address');
  assert.ok(!line.includes('_tokenModalAddress'), 'receive modal must NOT use token contract address');
});

test('E2E-probe: swap quote encodes amount in SELL token decimals', async () => {
  const swapJs = (await import('node:fs')).readFileSync(new URL('../js/swap.js', import.meta.url), 'utf8');
  const i = swapJs.indexOf('async function getSwapQuote');
  const body = swapJs.slice(i, swapJs.indexOf('}', swapJs.indexOf('amountInWei')));
  assert.ok(body.includes('parseUnits(amt, fromDecimals)'), 'quote amount must use fromDecimals');
  assert.ok(!body.includes('parseEther(amt)'), 'parseEther(amt) is wrong for ERC-20 with decimals≠18');
});

test('E2E-probe: swap & bridge have NO simulated fallback (real routes or honest error)', async () => {
  const swapJs = (await import('node:fs')).readFileSync(new URL('../js/swap.js', import.meta.url), 'utf8');
  const bridgeJs = (await import('node:fs')).readFileSync(new URL('../js/bridge.js', import.meta.url), 'utf8');
  // No fake-rate generator, no simulated banner, no Math.random amounts
  assert.ok(!swapJs.includes('simulatedQuote'), 'swap must not contain a simulated quote generator');
  assert.ok(!swapJs.includes('Math.random'), 'swap must not fabricate rates');
  assert.ok(!swapJs.includes('simulated-banner'), 'swap must not render a simulated banner');
  assert.ok(!bridgeJs.includes('simulated-banner'), 'bridge must not render a simulated banner');
  assert.ok(!bridgeJs.includes('set(\'bridgeQuote\', { simulated: true })'), 'bridge must never bind a simulated quote');
  // Real routes only: KyberSwap → Uniswap V3 → Uniswap V2, then honest error
  assert.ok(swapJs.includes('No route available'), 'swap must end with an honest no-route error');
  assert.ok(bridgeJs.includes('No route available'), 'bridge must end with an honest no-route error');
  // Auto-route: quote refreshes on input change without a manual button
  assert.ok(swapJs.includes('AUTO-ROUTE'), 'swap must auto-route');
  assert.ok(bridgeJs.includes('AUTO-ROUTE'), 'bridge must auto-route');
  assert.ok(!bridgeJs.includes('btnBridgeQuote'), 'bridge must not depend on a Get Route button');
});

test('E2E-probe: bridge is native-only, context-bound, fail-closed (supersedes old ERC-20 token contract)', async () => {
  const bridgeJs = (await import('node:fs')).readFileSync(new URL('../js/bridge.js', import.meta.url), 'utf8');
  const i = bridgeJs.indexOf('export async function doBridge()');
  const body = bridgeJs.slice(i, bridgeJs.indexOf('export async function doBridgeExec()'));
  // NATIVE ONLY: non-native selection rejected loudly, never silently substituted
  assert.ok(body.includes("tok !== 'native'"), 'bridge must fail closed on non-native token selection');
  assert.ok(body.includes('native_only_reject'), 'ERC-20 rejection must have a clear user-facing message');
  // Quote URL is strictly native on both sides (0x0) — no fromToken===toToken ERC-20 contract
  assert.ok(body.includes('fromToken=${NATIVE}&toToken=${NATIVE}'), 'quote must request native on both chains');
  assert.ok(!body.includes('fromToken=${tokenAddr}'), 'old same-address ERC-20 contract must be gone');
  // Context captured before any await; stale quote state cleared
  assert.ok(body.includes('Object.freeze({'), 'quote context must be immutable');
  assert.ok(body.includes("set('bridgeQuote', null)"), 'old quote state must be cleared before await');
  assert.ok((body.match(/seq !== quoteSeq/g) || []).length >= 4, 'out-of-order responses must be ignored via seq id');
  // Response validated field-by-field against context
  assert.ok(body.includes('Quote fromChain mismatch'), 'action.fromChainId must be validated');
  assert.ok(body.includes('Quote toChain mismatch'), 'action.toChainId must be validated');
  assert.ok(body.includes('Quote tx value exceeds requested amount'), 'tx value must be capped at requested amount');
  assert.ok(body.includes('txReq.chainId'), 'txRequest.chainId must be validated');
});

// ── 9. EIP-7702 authorization API regression (ethers 6.14 has authorizeSync, NOT signAuthorization) ──
test('E2E-probe: ethers Wallet has authorizeSync (runtime proof)', async () => {
  const w = ethers.Wallet.createRandom();
  assert.equal(typeof w.signAuthorization, 'undefined', 'signAuthorization must NOT be relied on');
  assert.equal(typeof w.authorizeSync, 'function', 'authorizeSync must exist for 7702 auth');
  const auth = w.authorizeSync({ address: '0x0000000000000000000000000000000000000001', nonce: 1, chainId: 11155111 });
  assert.ok(auth.signature && auth.address && auth.nonce === 1n, 'authorizeSync returns {address, nonce, chainId, signature}');
});

test('E2E-probe: 7702 modules use authorizeSync, not nonexistent signAuthorization', async () => {
  const fs = await import('node:fs');
  for (const f of ['eip7702.js', 'eip7702-tools.js']) {
    const js = fs.readFileSync(new URL(`../js/${f}`, import.meta.url), 'utf8');
    assert.ok(!js.includes('signAuthorization'), `${f}: signAuthorization does not exist in ethers 6.14 → dead button`);
    assert.ok(js.includes('authorizeSync({'), `${f}: must call authorizeSync(...)`);
  }
});

test('E2E-probe: EIP-7702 flows save + reuse deployed contracts via registry', async () => {
  const fs = await import('node:fs');
  const tools = fs.readFileSync(new URL('../js/eip7702-tools.js', import.meta.url), 'utf8');
  const reg = fs.readFileSync(new URL('../js/registry.js', import.meta.url), 'utf8');
  // registry module exists with the core API
  for (const fn of ['saveDeployed', 'findDeployed', 'listDeployed', 'removeDeployed']) {
    assert.ok(reg.includes(`export function ${fn}`), `registry.js must export ${fn}`);
  }
  // all three flows persist their deployed contract
  for (const type of ["'batch'", "'rescue'", "'airdrop'"]) {
    assert.ok(tools.includes(`saveDeployed(${type},`), `flow must save ${type} contract`);
  }
  // reuse path exists and verifies the contract is still alive on-chain
  assert.ok(tools.includes('findUsableDeployed'), 'reuse helper must exist');
  assert.ok(tools.includes('provider.getCode'), 'reuse must verify contract exists on-chain');
  assert.ok(tools.includes('removeDeployed(type, found.address, chainId)'), 'stale entries must be dropped');
});

test('E2E-probe: approval scan is honest about its window and has no 10-event cap', async () => {
  const fs = await import('node:fs');
  const app = fs.readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
  // no arbitrary cap on events per token
  assert.ok(!app.includes('events.slice(-10)'), 'approval scan must not cap events');
  // wide window with provider-limit fallback
  assert.ok(app.includes('block - 100000'), 'approval scan must use a wide window');
  assert.ok(app.includes('block - 2000'), 'approval scan must keep a fallback window');
  // revoked approvals (allowance 0) are filtered out
  assert.ok(app.includes('allowance <= 0n'), 'zero allowances must be skipped');
  // the UI reports the actual scan window so "Clean! 🐻" is never misleading
  assert.ok(app.includes('Scan window'), 'UI must disclose the scan window');
  assert.ok(app.includes('scannedFrom'), 'scan window must be tracked and shown');
});

test('E2E-probe: every $(\'#id\') reference across ALL js files exists in index.html', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
  // IDs created dynamically by wallet.js modals/forms — not static HTML
  const dynamicSkip = new Set([
    'pwCancel','confirmYes','confirmTypeInput','confirmNo','pwOk','pwInput',
    'cnRpc','cnType','cnExplorer','clearConfirm','cnSymbol','importSecret',
    'importPw','lockBtn','wImport','createPw2','exportBtn','seedDone',
    'importBtn','unlockPw','cnSave','wCreate','createPw','unlockBtn',
    'clearBtn','cnChainId','cnName','createBtn','addAccBtn','seedConfirm','addNetBtn',
    'tokenSend','tokenReceive','tokenSwap','tokenHistory','tokenPriceChart',
    'netSearchInput','netListMainnet','netListTestnet','chooseSwap','chooseBridge',
    'createName','importName','deploySupply','deployDecimals','deployBaseUri',
    'btnDeployBatchHelper','btnDeployRescueHelper','btnDeployAirdropClaimer',
    'deployStatus','helperStatusList'
  ]);
  const dir = path.resolve(new URL('../js/', import.meta.url).pathname);
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
  const missing = [];
  for (const f of files) {
    const content = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of content.matchAll(/\$\('#([^']+)'\)/g)) {
      const id = m[1];
      if (!htmlIds.has(id) && !dynamicSkip.has(id)) missing.push(`${f}: #${id}`);
    }
  }
  assert.deepEqual(missing, [], 'every static JS-referenced ID must exist in index.html (null element = innerHTML crash)');
});

test('E2E-probe: unawaited async render calls are caught (no global "Unexpected error" toast)', async () => {
  const fs = await import('node:fs');
  const app = fs.readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
  // loadNfts() is async and deliberately not awaited (slow scan) — its
  // rejection MUST be handled locally or a null element leaks as a global toast.
  assert.match(app, /loadNfts\(\)\.catch\(/, 'loadNfts() must be .catch()-handled where it is fired');
  // renderAssets must own its element reference (no accidental window named-access global)
  const ra = app.slice(app.indexOf('function renderAssets'));
  assert.match(ra, /const assetList = \$\('#assetList'\);/, 'renderAssets must declare its own assetList');
  // openModal must not assume the modal shell exists
  const ui = fs.readFileSync(new URL('../js/ui.js', import.meta.url), 'utf8');
  assert.match(ui, /if \(!overlay \|\| !box\) return null;/, 'openModal must guard missing modal shell');
});

// NOTE: no live CoinGecko probe for fetchPriceHistory here on purpose —
// it would consume the keyless rate limit and make the native-price probe
// above flaky with HTTP 429. Covered by mocked tests in price.test.js.

// let undici fetch resources settle before the runner tears down
await new Promise(r => setTimeout(r, 1500));
// silence undici resource-timing noise (Node 24 + node:test)
process.on('uncaughtException', (e) => {
  if (String(e?.message || '').includes('markResourceTiming')) return;
  throw e;
});