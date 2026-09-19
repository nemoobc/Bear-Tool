// ═══════════════════════════════════════════════════════════════
// Bear Tool — tests/routers.test.js
// Router registry: SWAP_ROUTERS, BRIDGE_ROUTERS, helpers
// ═══════════════════════════════════════════════════════════════
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../js/routers.js', import.meta.url), 'utf8');
const swapSrc = readFileSync(new URL('../js/swap.js', import.meta.url), 'utf8');
const bridgeSrc = readFileSync(new URL('../js/bridge.js', import.meta.url), 'utf8');
const htmlSrc = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

// ── Router Registry ──
test('routers: exports SWAP_ROUTERS', () => {
  assert.match(src, /export\s+(const|let)\s+SWAP_ROUTERS/);
});
test('routers: exports BRIDGE_ROUTERS', () => {
  assert.match(src, /export\s+(const|let)\s+BRIDGE_ROUTERS/);
});
test('routers: has KyberSwap', () => {
  assert.match(src, /id:\s*'kyberswap'/);
});
test('routers: has 1inch', () => {
  assert.match(src, /id:\s*'1inch'/);
});
test('routers: has ParaSwap', () => {
  assert.match(src, /id:\s*'paraswap'/);
});
test('routers: has SushiSwap', () => {
  assert.match(src, /id:\s*'sushiswap'/);
});
test('routers: has Uniswap V3', () => {
  assert.match(src, /id:\s*'uniswap_v3'/);
});
test('routers: has Uniswap V2', () => {
  assert.match(src, /id:\s*'uniswap_v2'/);
});
test('routers: has Camelot', () => {
  assert.match(src, /id:\s*'camelot'/);
});
test('routers: has Aerodrome', () => {
  assert.match(src, /id:\s*'aerodrome'/);
});
test('routers: has LI.FI bridge', () => {
  assert.match(src, /id:\s*'lifi'/);
});
test('routers: has Socket bridge', () => {
  assert.match(src, /id:\s*'socket'/);
});
test('routers: has Stargate bridge', () => {
  assert.match(src, /id:\s*'stargate'/);
});
test('routers: has Across bridge', () => {
  assert.match(src, /id:\s*'across'/);
});
test('routers: has Hop bridge', () => {
  assert.match(src, /id:\s*'hop'/);
});
test('routers: has Wormhole bridge', () => {
  assert.match(src, /id:\s*'wormhole'/);
});
test('routers: has Bungee bridge', () => {
  assert.match(src, /id:\s*'bungee'/);
});
test('routers: has Synapse bridge', () => {
  assert.match(src, /id:\s*'synapse'/);
});
test('routers: exports getSwapRoutersForChain', () => {
  assert.match(src, /export\s+function\s+getSwapRoutersForChain/);
});
test('routers: exports getBridgeRoutersForChain', () => {
  assert.match(src, /export\s+function\s+getBridgeRoutersForChain/);
});
test('routers: exports getBestSwapRouter', () => {
  assert.match(src, /export\s+function\s+getBestSwapRouter/);
});
test('routers: exports getBestBridgeRouter', () => {
  assert.match(src, /export\s+function\s+getBestBridgeRouter/);
});
test('routers: all chains are numbers', () => {
  const chains = [...src.matchAll(/chains:\s*\[([\d,\s]+)\]/g)];
  assert.ok(chains.length >= 15, `Expected >=15 router entries, got ${chains.length}`);
});

// ── Swap uses router registry ──
test('swap.js: imports from routers.js', () => {
  assert.match(swapSrc, /from\s+['"]\.\/routers\.js['"]/);
});
test('swap.js: has 1inch quote function', () => {
  assert.match(swapSrc, /oneinchQuote/);
});
test('swap.js: has ParaSwap quote function', () => {
  assert.match(swapSrc, /paraswapQuote/);
});
test('swap.js: has SushiSwap quote function', () => {
  assert.match(swapSrc, /sushiswapQuote/);
});
test('swap.js: router selector reads swapRouterSelect', () => {
  assert.match(swapSrc, /swapRouterSelect/);
});
test('swap.js: auto route order includes all 6 routers', () => {
  assert.match(swapSrc, /kyberswap.*1inch.*paraswap.*sushiswap.*uniswap_v3.*uniswap_v2/s);
});

// ── HTML has router selectors ──
test('index.html: swap has router selector', () => {
  assert.match(htmlSrc, /id="swapRouterSelect"/);
});
test('index.html: bridge has router selector', () => {
  assert.match(htmlSrc, /id="bridgeRouterSelect"/);
});
test('index.html: swap router has auto option', () => {
  assert.match(htmlSrc, /value="auto".*Best Price/s);
});
test('index.html: bridge router has auto option', () => {
  assert.match(htmlSrc, /value="auto".*Best Route/s);
});

// ── No secrets (HUKUM 9) ──
test('routers: no hardcoded secrets', () => {
  const noSecret = !src.match(/qYSDUOSxp6|sk-[A-Za-z0-9]{20,}|-----BEGIN.*PRIVATE/);
  assert.ok(noSecret);
});
