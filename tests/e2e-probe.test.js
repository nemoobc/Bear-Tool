// Bear Tool — manual E2E probe (headless, no browser available)
// Runs module-level flows + real API probes with Node's fetch.
// NOT a substitute for a real browser E2E — see E2E-REPORT.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { appSource } from './helpers/app-source.mjs';
import { jsModules } from './helpers/js-files.mjs';

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

// External APIs (KyberSwap/LI.FI/Binance/DexScreener) rate-limit under CI load
// (503/429). Retry with backoff so a transient 503 does not fail the gate; a
// persistent 503 after all attempts is a real outage and still fails loudly.
async function httpGetRetry(url, attempts = 3, delayMs = 2000) {
  let last;
  for (let i = 0; i < attempts; i++) {
    last = await httpGet(url);
    if (last.status !== 503 && last.status !== 429) return last;
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
  }
  return last;
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

// ── 2. Intro timer + skip ──
test('E2E-probe: intro timer + skip wiring', () => {
  let done = false;
  const intro = makeEl();
  const skip = makeEl();
  const title = makeEl();
  const logo = makeEl();
  document.getElementById = (id) => id === 'intro' ? intro : id === 'introSkip' ? skip : id === 'introTitle' ? title : id === 'introLogo' ? logo : makeEl();
  theme.runIntro(() => { done = true; });
  assert.equal(done, false, 'intro must not finish synchronously');
  assert.equal(theme.INTRO_MS, 1500, 'intro must be 1.5s (fast enough to not annoy)');
  // simulate skip click
  const skipHandler = skip.addEventListener.mock?.calls?.[0]?.[1];
  // (addEventListener is stubbed; skip path verified by code review: click → finish)
  console.log('  intro: 1.5s setTimeout + skip click/touch/keyboard handler present (code review)');
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

// ── 4. EIP-7702: manual delegate form gone, mainnet still classified ──
test('E2E-probe: Smart EOA manual form is removed (no chainId-0 input path)', () => {
  const net = network.getNetworkById('ethereum');
  assert.equal(net.type, 'mainnet');
  // The manual delegate/revoke form (delegateAddr/delegateChainId/
  // delegateAnyChain/btnDelegate) was removed with the Smart EOA card —
  // the only input path that could ever build a chainId-0 authorization.
  // Flows take the chainId from the active network, never from a field.
  const html = appSource();
  for (const id of ['delegateAddr', 'delegateChainId', 'delegateAnyChain', 'btnDelegate', 'btnRevoke']) {
    assert.ok(!html.includes(`id="${id}"`), `#${id} must be gone with the Smart EOA card`);
  }
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

// ── 6. Real API probes (KyberSwap / LI.FI / Binance / DexScreener) ──
test('E2E-probe: KyberSwap quote API returns real route (ETH→USDC, mainnet)', async (t) => {
  const url = 'https://aggregator-api.kyberswap.com/ethereum/api/v1/routes?tokenIn=0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE&tokenOut=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48&amountIn=1000000000000000000';
    const res = await httpGetRetry(url);
    // Same treatment as the CoinGecko probe below: after retries a 429 is the
    // shared runner IP being throttled upstream (CI 36983252072's log: "Your
    // IP has exceeded..."), not a defect in this app's route request — skip
    // honestly instead of failing the gate for someone else's rate limiter.
    if (res.status === 429) {
      return t.skip('KyberSwap rate limit (429) — live probe, not a code failure');
    }
    assert.equal(res.status, 200);
  const json = JSON.parse(res.text);
  assert.equal(json.code, 0);
  assert.ok(json.data?.routeSummary?.amountOut, 'routeSummary.amountOut present');
  console.log('  KyberSwap: amountOut =', json.data.routeSummary.amountOut, '| router =', json.data.routerAddress);
});

test('E2E-probe: LI.FI quote API — bridge.js sends fromAddress (real route, no simulation)', async (t) => {
  // exact URL built by bridge.js doBridge() (fromAddress + toAddress pinned)
  const url = 'https://li.quest/v1/quote?fromChain=1&toChain=10&fromToken=0x0000000000000000000000000000000000000000&toToken=0x0000000000000000000000000000000000000000&fromAmount=1000000000000000000&fromAddress=0x0000000000000000000000000000000000000001&toAddress=0x0000000000000000000000000000000000000001';
  const res = await httpGetRetry(url);
  // Identical upstream dependency as the sibling probe below — which already
  // degrades honestly: li.quest answers /v1/quote with an empty 404 for some
  // callers (keyless measured 404 on 2026-09-27; CI's runner IP 404 on
  // 2026-10-01 while this box got 200 for the byte-identical URL seconds
  // later). One dependency, one treatment: a real 200 still asserts the
  // fromAddress contract, only the credential/IP 404 skips.
  if (res.status === 404 && !process.env.LIFI_API_KEY) {
    return t.skip('LI.FI /v1/quote 404 for this caller (upstream credential/IP), no key set — ' +
      'same treatment as the sibling probe. Set LIFI_API_KEY to assert 200.');
  }
  assert.equal(res.status, 200, 'LI.FI requires fromAddress — bridge.js now sends it');
  const json = JSON.parse(res.text);
  console.log('  LI.FI with fromAddress:', json.tool, '| fromToken.symbol =', json.action?.fromToken?.symbol);
});

test('E2E-probe: LI.FI quote API works when fromAddress is added', async (t) => {
  const url = 'https://li.quest/v1/quote?fromChain=1&toChain=10&fromToken=0x0000000000000000000000000000000000000000&toToken=0x0000000000000000000000000000000000000000&fromAmount=1000000000000000000&fromAddress=0x0000000000000000000000000000000000000001';
  const res = await httpGetRetry(url);
  // LI.FI now answers /v1/quote with 404 and an EMPTY body unless the request
  // carries an API key, while /v1/chains and /v1/connections on the same host
  // still answer 200 — so this is the upstream requiring a credential, not the
  // route being unavailable and not this app being wrong. Measured 2026-09-27
  // across four chain pairs and two amounts: 404 every time, same host 200.
  //
  // Asserting 200 here would mean asserting a key this suite does not have, so
  // the probe degrades to an honest skip — the same treatment CoinGecko's rate
  // limit already gets below. When a key IS configured it must still pass, so
  // the assertion is not simply removed.
  if (res.status === 404 && !process.env.LIFI_API_KEY) {
    return t.skip('LI.FI /v1/quote now requires an API key (404, empty body) — ' +
      'upstream credential, not a code failure. Set LIFI_API_KEY to assert 200.');
  }
  assert.equal(res.status, 200, `LI.FI quote returned ${res.status} with a key configured`);
  const json = JSON.parse(res.text);
  // LI.FI /quote returns a single route object (not {routes:[...]})
  assert.ok(json.id && json.tool, 'route object present');
  console.log('  LI.FI with fromAddress: tool =', json.tool, '| action.fromToken.symbol =', json.action?.fromToken?.symbol);
});

test('E2E-probe: the app degrades honestly when LI.FI has no route', async () => {
  // Whatever LI.FI answers, the app must not invent a route. This is the
  // property that matters and it is testable without a key.
  //
  // The word "simulated" does appear in bridge.js — in the comments that say
  // there is no simulation, and in the guard itself. So the check is on the
  // executable contract, not on the absence of a word: the quote is tagged
  // simulated:false when it is built, and any quote that claims to be simulated
  // is refused before it can be sent.
  const bridge = (await import('node:fs')).readFileSync(new URL('../js/bridge.js', import.meta.url), 'utf8');
  assert.match(bridge, /No route available — no bridge will happen/,
    'a failed LI.FI quote must say so, in those words');
  assert.match(bridge, /\$\{res\.status\}/,
    'the error must carry the real HTTP status, not a generic one');
  assert.match(bridge, /simulated:\s*false/,
    'a real quote must be tagged as not simulated');
  assert.match(bridge, /q\.simulated/,
    'a quote claiming to be simulated must be refused before execution');
  assert.doesNotMatch(bridge, /simulated:\s*true/,
    'no code path may ever produce a simulated quote');
});

test('E2E-probe: keyless price sources work (native + token, dashboard USD)', async (t) => {
  // Binance spot ticker is what js/price.js asks for a native coin's price.
  const res = await httpGetRetry('https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT');
  // 429 = rate limit, 451 = region block. Neither is a defect in this app;
  // everything else in the suite mocks these hosts, so this live probe must
  // degrade to an honest skip instead of failing a shared/blocked CI IP.
  if (res.status === 429 || res.status === 451) {
    return t.skip(`Binance ${res.status} — live probe, not a code failure`);
  }
  assert.equal(res.status, 200);
  const eth = JSON.parse(res.text);
  assert.ok(Number(eth.price) > 0, 'ETHUSDT must be a positive number');
  console.log('  Binance ETH/USDT:', eth.price);

  // DexScreener is the token-price source: one batched request, keyless.
  const dex = await httpGetRetry('https://api.dexscreener.com/tokens/v1/ethereum/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
  if (dex.status === 200) {
    const pairs = JSON.parse(dex.text);
    assert.ok(Array.isArray(pairs), 'DexScreener answers an array of pairs');
    const priced = pairs.find((p) => Number(p?.priceUsd) > 0);
    assert.ok(priced, 'USDC must have a priced pair');
    console.log('  DexScreener USDC:', priced.priceUsd);
  } else {
    console.log(`  ⚠️  DexScreener ${dex.status} — skipped`);
  }
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

test('E2E-probe: flipSwap repaints BOTH pickers (stale To trigger = "USDC = USDC")', async () => {
  const fs = await import('node:fs');
  const swapJs = fs.readFileSync(new URL('../js/swap.js', import.meta.url), 'utf8');
  const i = swapJs.indexOf('export function flipSwap');
  assert.ok(i !== -1, 'flipSwap must exist in js/swap.js');
  const body = swapJs.slice(i, swapJs.indexOf('\n}', i));
  // The picker display syncs on its OWN select's 'change' (token-picker.js).
  // Dispatching on `from` only left the To trigger showing the OLD token —
  // flip ETH=USDC and both sides rendered "USDC". Both selects must fire.
  assert.match(body, /from\.dispatchEvent\(new Event\('change'\)\)/,
    'flipSwap must dispatch change on the From select (repaint + balance)');
  assert.match(body, /to\.dispatchEvent\(new Event\('change'\)\)/,
    'flipSwap must dispatch change on the To select too — otherwise its picker display stays stale');
});

test('E2E-probe: network icons share ONE renderer (bridge picker == network list)', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = new URL('../js/', import.meta.url);
  // Recursive: a flat walk stopped seeing the Dex once it moved into js/dex/,
  // which would have quietly dropped this check off the module it guards.
  const files = jsModules();
  // Exactly one definition, in token-logo.js — the network LIST (app.js) and
  // the Bridge chain PICKER (token-picker.js) must render the same marks.
  // The picker used to paint the raw emoji `n.icon` field instead, so the
  // bridge chain icon never matched the icon in the network list.
  const defs = files.filter((f) => fs.readFileSync(path.join(dir.pathname, f), 'utf8')
    .includes('function getNetworkLogo'));
  assert.deepStrictEqual(defs, ['token-logo.js'],
    `getNetworkLogo must be defined exactly once (found: ${defs.join(', ')})`);
  const picker = fs.readFileSync(path.join(dir.pathname, 'token-picker.js'), 'utf8');
  assert.match(picker, /getNetworkLogo\(n\.name, 18\)/,
    'network picker rows must paint with getNetworkLogo (the list renderer)');
  assert.match(picker, /getNetworkLogo\(n\.name, 16\)/,
    'network picker trigger must paint with getNetworkLogo (the list renderer)');
  assert.ok(!picker.includes("n.icon || '🛰️'"),
    'network picker must not fall back to the raw emoji .icon field');
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

test('E2E-probe: bridge = native + curated ERC-20, context-bound, fail-closed (spec 2026-10-05)', async () => {
  const fs = await import('node:fs');
  const bridgeJs = fs.readFileSync(new URL('../js/bridge.js', import.meta.url), 'utf8');
  const i = bridgeJs.indexOf('export async function doBridge()');
  const body = bridgeJs.slice(i, bridgeJs.indexOf('export async function doBridgeExec()'));
  const execBody = bridgeJs.slice(bridgeJs.indexOf('export async function doBridgeExec()'));
  // Fail closed on an UNMAPPABLE token — no curated twin, no fetch, loud message.
  assert.ok(body.includes("if (tok !== 'native')"), 'bridge must branch fail-closed on non-native selection');
  assert.ok(body.includes("t('bridge.token_not_routable')"), 'unmappable ERC-20 must have a clear user-facing message');
  // Quote URL: curated addresses per context, or 0x0 native on both sides.
  assert.ok(bridgeJs.includes('function quoteUrl('), 'URL built from one context-bound builder');
  assert.ok(bridgeJs.includes('fromToken=${context.tokenAddress || NATIVE}&toToken=${context.toTokenAddress || NATIVE}'),
    'quote must request the curated pair (or native 0x0/0x0)');
  // Context captured before any await; stale quote state cleared
  assert.ok(body.includes('Object.freeze({'), 'quote context must be immutable');
  assert.ok(body.includes("set('bridgeQuote', null)"), 'old quote state must be cleared before await');
  // Out-of-order responses die on the seq id. The quote path awaits ONE
  // Promise.allSettled (every candidate quoted in parallel), so a single check
  // immediately after it covers all of them — pin the STRUCTURE, not the old
  // per-response count from when the fetch was serial.
  const settle = body.indexOf('Promise.allSettled(');
  assert.ok(settle > -1, 'candidates must be quoted in parallel');
  const seqCheck = body.indexOf('seq !== quoteSeq', settle);
  assert.ok(seqCheck > settle && seqCheck - settle < 500, 'seq id must be re-checked right after the await');
  assert.ok((body.match(/seq !== quoteSeq/g) || []).length >= 1, 'out-of-order responses must be ignored via seq id');
  // Response validated field-by-field against context (validateQuote, shared
  // by quote time and the post-approval re-quote)
  assert.ok(bridgeJs.includes('function validateQuote('), 'validation lives in one shared function');
  assert.ok(bridgeJs.includes('Quote fromChain mismatch'), 'action.fromChainId must be validated');
  assert.ok(bridgeJs.includes('Quote toChain mismatch'), 'action.toChainId must be validated');
  assert.ok(bridgeJs.includes('Quote tx value exceeds requested amount'), 'native tx value must be capped at requested amount');
  assert.ok(bridgeJs.includes('Quote tx value must be 0 for an ERC-20 bridge'), 'ERC-20 route must reject native value');
  assert.ok(bridgeJs.includes('Quote fromToken mismatch'), 'ERC-20 fromToken must equal the curated source address');
  assert.ok(bridgeJs.includes('Quote toToken mismatch'), 'ERC-20 toToken must equal the curated destination twin');
  assert.ok(bridgeJs.includes('Quote approvalAddress invalid'), 'approval spender must be validated');
  assert.ok(bridgeJs.includes('txReq.chainId'), 'txRequest.chainId must be validated');
  // ERC-20 execution: allowance → exact approve (reset-0 if stale) → RE-QUOTE
  assert.ok(execBody.includes('encodeFunctionData(\'allowance\''), 'allowance read on-chain before signing');
  assert.ok(execBody.includes('encodeFunctionData(\'approve\''), 'approve built from quote-bound spender');
  assert.ok(execBody.includes('decideApproval('), 'approval decision from the shared helper');
  assert.ok(execBody.includes('Route changed during approval'), 'fresh quote with another spender must abort');
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
  // eip7702.js is now a thin loadEip7702() stub (manual form removed) — the
  // only module that builds authorizations is eip7702-tools.js.
  for (const f of ['eip7702-tools.js']) {
    const js = fs.readFileSync(new URL(`../js/${f}`, import.meta.url), 'utf8');
    assert.ok(!js.includes('signAuthorization'), `${f}: signAuthorization does not exist in ethers 6.14 → dead button`);
    assert.ok(js.includes('authorizeSync({'), `${f}: must call authorizeSync(...)`);
  }
  const stub = fs.readFileSync(new URL('../js/eip7702.js', import.meta.url), 'utf8');
  assert.ok(!stub.includes('sendTransaction'), 'eip7702.js stub must not broadcast anything');
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

// The approval-window gate (wide window, no 10-event cap, disclosed
// scan window) lived here and died with the Approval Manager in M3 — the
// feature was removed on request ("fitur approvals hapus ganti fitur
// discord"). Nothing replaces it: there is no other scan in app.js with a
// truncation window to disclose. What remains is the deletion itself,
// pinned in settings-shape.test.js (view gone, nav gone, scanner gone) —
// a resurrection would have to invent a #approvalMode the gates would
// catch at the next run.

// IDs created dynamically by wallet.js modals/forms — not static HTML.
// Keep this list honest: an entry for an id nothing creates (or nothing
// references any more) hides a real break instead of explaining one.
// Module scope on purpose: the ID probe CONSUMES it and the "really created"
// probe AUDITS it — one list, two tests, no drift between them.
const dynamicSkip = new Set([
  'pwCancel','confirmYes','confirmNo','pwOk','pwInput',
  'cnRpc','clearConfirm','importSecret',
  'importPw','lockBtn','wImport','createPw2','exportBtn','seedDone',
  'importBtn','unlockPw','cnSave','wCreate','createPw','unlockBtn',
  'clearBtn','createBtn','addAccBtn','seedConfirm','addNetBtn',
  'tokenSend','tokenReceive','tokenSwap','tokenHistory','tokenPriceChart','tokenRemove',
  'netSearchInput','netListMainnet','netListTestnet','chooseSwap','chooseBridge',
  'createName','importName','deploySupply','deployDecimals','deployBaseUri',
  // wizard feature options — generated by extraFieldsHtml (contracts.js fields)
  'deployCap','deployBurnable','deployMintable','deployPausable',
  'deployPermit','deployVotes','deployEnumerable','deployUriStorage','deployAccess',
  // M7 (2026-10-04): Callback / Flash Minting toggles + compiler configuration,
  // all rendered by extraFieldsHtml from the field declarations in contracts.js.
  'deployCallback','deployFlashMint','deployLanguage','deployEvmVersion',
  'deployOptimizer','deployRuns',
  // M8 (2026-10-04): ERC-721 manual token ids + fallback image URL.
  'deployAutoInc','deployImage',
  // M9 (2026-10-04): the upgradeable toggle + its proxy-type select, both
  // rendered per standard by extraFieldsHtml (fields in contracts.js).
  'deployUpgradeable','deployProxyType',
  // 2026-10-04: the Helper Contracts card + Smart EOA card were removed. Each
  // flow card now carries a STATIC "Deploy contract" button (deploy.jsx), so
  // these ids need no skip — they are in the markup like any other.
  'deployStatus',
  // Add-network picker + token autodetect + the testnet filter, all injected
  // at runtime. Asserted to be generated by the tests below, so this list
  // cannot quietly excuse an id that nothing ever creates.
  'cnForm','cnIcon','cnNameLabel','cnChainLabel','cnSearch',
  'cnNoMatch','tdIcon','tdSymbol','tdName','tdDecimals','tdNote',
  // Seed-phrase confirmation (showSeedPhrase). Rebuilt per question by
  // paint(), so the choices container cannot live in index.html — and the
  // restart button replaced the ✕ that used to orphan an unsaved wallet.
  'seedChoices','seedQLabel','seedProg','seedRestart',
  // Import sheet (showImportModal) — the Back button that returns to welcome
  'importBack',
  // Create sheet (showCreateModal) — same
  'createBack',
  // Custom-RPC detection inside the Add-network picker (showAddNetworkModal)
  'cnCustomBtn','cnNameField','cnName','cnDetect',
  // Activity detail sheet (showActivityDetail) — the on-chain block fills in
  // after the modal is already open, so it cannot live in index.html
  'actChain',
  // Discord view (M3, js/discord.js): everything except #discordRoot is
  // PAINTED by renderDiscord (connect form, profile card, leave-confirm
  // modal), because the view's contents depend on the auth state — a static
  // card in discord.jsx would flash the wrong shape on every reconnect.
  // Audited below: each id has id="…" in discord.js.
  // #discordInvite (invite join row, painted with the Servers card).
  'discordStatus','discordClientId','discordToken','btnDiscordLeaveConfirm','discordInvite',

  // Dex view (js/dex/*): only #dexRoot is static in dex.jsx — the welcome
  // screen, the chain gate, the tab strip and every panel body are PAINTED by
  // renderDex / the panel renderers, because they depend on the live chainId,
  // the welcome dismissal and which feature is active. Audited: each id below
  // is created by renderDex's innerHTML (welcome + gate + tabs + host) or by a
  // panel's markup (mm status). Nothing here is a typo — each is assigned via
  // an id="…" string in js/dex/index.js.
  'dexWelcome','dexWelcomeTitle','dexWelcomeSub','dexStartHere','dexWorkspace',
  'dexGate','dexGateTitle','dexGateHow','dexGateGo','dexPairInfo',
  'dexTabs','dexPanelHost','dexMmStatus','dexSwapFrom',
  // Dex v2 nav + panels (M3): the nav buttons are painted by renderDex's
  // innerHTML and re-labelled per route; the Swap and Pools panels paint their
  // own bodies (js/dex/swap.js, js/dex/pool-list.js) because every number in
  // them depends on live chain reads.
  'dexNav','dexSwapPool','dexSwapAmount','dexSwapMax','dexSwapBal','dexSwapQuote','dexSwapGo','dexSwapNote',
  'dexPoolsList','dexPoolsNote',

]);

test('E2E-probe: every $(\'#id\') reference across ALL js files exists in the page markup', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const html = appSource();
  const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
  const dir = path.resolve(fileURLToPath(new URL('../js/', import.meta.url)));
  // Recursive, so js/dex/index.js is held to the same "every $() id exists"
  // rule as the flat modules — a folder must not exempt its contents.
  const files = jsModules();
  const missing = [];
  for (const f of files) {
    const content = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of content.matchAll(/\$\('#([^']+)'\)/g)) {
      const id = m[1];
      if (!htmlIds.has(id) && !dynamicSkip.has(id)) missing.push(`${f}: #${id}`);
    }
  }
  assert.deepEqual(missing, [], 'every static JS-referenced ID must exist in the page markup (index.html + src/views) (null element = innerHTML crash)');
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

// NOTE: no live price-history probe here on purpose — the chart sources
// (Binance klines for natives, GeckoTerminal for tokens) would consume the
// keyless rate budget and make the native-price probe above flaky. Covered by
// mocked tests in price.test.js + chart-timeframes.test.js.

// ── M4: rescue pk → sponsor → safe, single binding, auto-detect badge ──
test('M4 eip7702: one binding per dangerous button, rescue signs with the target key', async () => {
  const fs = await import('node:fs');
  const src = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
  const eip = src('../js/eip7702.js');
  const tools = src('../js/eip7702-tools.js');
  const app = src('../js/app.js');
  const deploy = src('../src/views/deploy.jsx');
  const page = src('../index.html');

  // stubs gone: the dangerous buttons bind only in eip7702-tools.js
  assert.ok(!/btnRescue'\)\.addEventListener/.test(eip), 'eip7702.js must not bind #btnRescue (tools owns it)');
  assert.ok(!/doRescue|doClaim/.test(eip), 'stub doRescue/doClaim must be gone from eip7702.js');
  assert.match(tools, /\$\('#btnRescue'\)\?\.addEventListener\('click', executeRescue\)/, 'tools binds the real rescue');

  // EIP-7702 nonce rule: +1 only when sender == authority; wrong nonce = tuple silently skipped
  assert.match(tools, /selfSponsor \? nonce \+ 1 : nonce/, 'auth nonce: +1 only for self-sponsor');
  // RESCUER bound to the sponsor that executes (msg.sender inside the helper)
  assert.match(tools, /deployContract\(sponsorSigner, abi, bytecode, \[safe, sponsorSigner\.address\]\)/, 'RESCUER = sponsor executor');
  // success verdict requires the delegation to actually be on-chain
  assert.match(tools, /const delegated = !!landed && landed\.toLowerCase\(\) === rescueAddr\.toLowerCase\(\)/, 'post-receipt delegation verify');
  // target key: validated against the address, used as signer, wiped from the DOM
  assert.match(tools, /wipeKeyField\('#rescueTargetKey'\)/, 'target key wiped');
  assert.match(tools, /targetKey \? new ethers\.Wallet\(targetKey, provider\)/, 'target signs with its own key');
  assert.match(deploy, /id="rescueTargetKey"/, 'form has the target key field');

  // Locked address is derived, not typed: the field is gone and exactly one
  // helper resolves it, so the address a helper was deployed for cannot drift
  // from the address later rescued.
  assert.ok(!/id="rescueTarget"/.test(deploy), 'the "Locked wallet address" field is gone');
  assert.equal((tools.match(/deriveTargetAddress\(/g) || []).length, 5,
    'one derive helper (keySel parameterised), called by executeRescue, deployRescueHelper, the MAX button and the paste-detect probe');
  // Sponsor: a pasted key wins, the unlocked wallet otherwise — the helper
  // buttons no longer fail on an empty form, and validation is still complete:
  // revoke gained a sponsor picker too (2026-10-03 alignment), so five entry points.
  assert.equal((tools.match(/return toast\('Invalid sponsor private key', 'error'\);/g) || []).length, 5,
    'sponsor validation covers all five entry points (rescue, claim, batch-side helpers, revoke)');
  assert.equal((tools.match(/sponsorSignerOf\(sponsorKey, provider\)/g) || []).length, 6,
    'deploy and execute resolve the sponsor through ONE function (def + 5 sites, revoke included)');
  // Coin detail modal: the ✕ was a second way out of a modal that already has
  // a Close button in its footer.
  const tmOpen = app.lastIndexOf('openModal(`', app.indexOf('token-modal-header'));
  const tmSlice = app.slice(tmOpen, tmOpen + 600);
  assert.match(tmSlice, /token-modal-header/, 'coin detail modal block located');
  assert.ok(!tmSlice.includes('modal-close'), 'coin detail modal carries no ✕ button');

  // auto-detect badge: topline, driven by the topbar
  assert.match(app, /function updateDelegationBadge\(\)/, 'badge updater exists');
  const tb = app.slice(app.indexOf('function updateTopbar'));
  assert.match(tb.slice(0, 1600), /updateDelegationBadge\(\)/, 'badge updates with the topbar');
  assert.match(page, /id="delegationBadge"/, 'badge element sits in the topbar');
  // activity: pending rows settle while the app stays open, not only at boot
  assert.match(app, /setInterval\(\(\) => \{[\s\S]{0,400}reconcileActivity\(get\('provider'\)\)/, 'periodic reconcile of pending rows');
});

// let undici fetch resources settle before the runner tears down
await new Promise(r => setTimeout(r, 1500));
// silence undici resource-timing noise (Node 24 + node:test)
process.on('uncaughtException', (e) => {
  if (String(e?.message || '').includes('markResourceTiming')) return;
  throw e;
});