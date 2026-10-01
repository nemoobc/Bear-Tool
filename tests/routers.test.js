// ═══════════════════════════════════════════════════════════════
// Bear Tool — tests/routers.test.js
// Router registry: SWAP_ROUTERS, BRIDGE_ROUTERS, helpers
// ═══════════════════════════════════════════════════════════════
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { appSource } from './helpers/app-source.mjs';

const src = readFileSync(new URL('../js/routers.js', import.meta.url), 'utf8');
const swapSrc = readFileSync(new URL('../js/swap.js', import.meta.url), 'utf8');
const bridgeSrc = readFileSync(new URL('../js/bridge.js', import.meta.url), 'utf8');
// Halaman = index.html + section view (M2: src/views/*.jsx).
const htmlSrc = appSource();

// ── Router Registry ──
test('routers: exports SWAP_ROUTERS', () => {
  assert.match(src, /export\s+(const|let)\s+SWAP_ROUTERS/);
});
test('routers: exports BRIDGE_ROUTERS', () => {
  assert.match(src, /export\s+(const|let)\s+BRIDGE_ROUTERS/);
});
// These assertions used to check that specific venues were PRESENT. That is the
// wrong direction: presence is not a property worth locking, and it is how a
// registry ends up carrying a router with no contract behind it. Camelot
// 0xc873fEcbd354f5A56E00E710B9cEFf27455E8AA2 and Aerodrome
// 0xcF77a3Ba9A5CA399B7c97c74d54e3b4f7CdeC441 are well-formed addresses with
// NO CODE on Arbitrum and Base, and both were asserted present for as long as
// the file existed.
//
// So the checks are now: the venues that were verified to answer stay, and the
// ones that were measured dead or key-gated are asserted GONE — which is the
// assertion that actually protects the user.
const PRESENT = [
  ['KyberSwap', 'kyberswap'],       // 200 unauthenticated
  ['ParaSwap', 'paraswap'],         // 200 unauthenticated
  ['SushiSwap', 'sushiswap'],
  ['Uniswap V3', 'uniswap_v3'],
  ['Uniswap V2', 'uniswap_v2'],
  ['QuickSwap', 'quickswap'],
  ['BaseSwap', 'baseswap'],
];
for (const [label, id] of PRESENT) {
  test(`routers: keeps ${label}`, () => {
    assert.match(src, new RegExp(`id:\\s*'${id}'`));
  });
}

test('routers: keeps LI.FI as the one bridge route', () => {
  // /v1/quote returns a full transactionRequest with no credential, which is the
  // only thing bridge.js can actually execute. A previous note in this project
  // claimed LI.FI had started requiring a key; it had not, and that claim would
  // have deleted a working feature.
  assert.match(src, /id:\s*'lifi'/);
});

const REMOVED = [
  ['1inch', 'answers 401 without a credential'],
  ['camelot', '0xc873fEcbd354f5A56E00E710B9cEFf27455E8AA2 has no code on Arbitrum'],
  ['aerodrome', '0xcF77a3Ba9A5CA399B7c97c74d54e3b4f7CdeC441 has no code on Base'],
  ['socket', '403 without a credential'],
  ['bungee', '403 without a credential'],
  ['stargate', 'the API host does not resolve'],
  ['across', '404'],
  ['hop', '530, service down'],
  ['wormhole', '522'],
  ['synapse', '404'],
  ['openocean', 'the API host does not resolve'],
];
for (const [id, why] of REMOVED) {
  test(`routers: no longer lists ${id} — ${why}`, () => {
    assert.doesNotMatch(src, new RegExp(`id:\\s*'${id}'`),
      `${id} must not be offered as a route: ${why}`);
  });
}

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
  assert.ok(chains.length >= 8, `Expected >=8 router entries, got ${chains.length}`);
  // Every chainId in the registry must be a plain integer — a stray string or a
  // trailing comma typo silently excludes a venue from every chain filter.
  for (const [, body] of chains) {
    for (const part of body.split(',')) {
      const s = part.trim();
      if (!s) continue;
      assert.match(s, /^\d+$/, `chainId "${s}" is not a plain integer`);
    }
  }
});

// ── Swap uses router registry ──
test('swap.js: imports from routers.js', () => {
  assert.match(swapSrc, /from\s+['"]\.\/routers\.js['"]/);
});
test('swap.js: no longer calls 1inch', () => {
  assert.doesNotMatch(swapSrc, /oneinch/i,
    'api.1inch.dev answers 401 without a credential');
});
test('swap.js: has ParaSwap quote function', () => {
  assert.match(swapSrc, /paraswapQuote/);
});
test('swap.js: quotes V2-family venues through one builder', () => {
  // SushiSwap, QuickSwap, BaseSwap and Uniswap V2 all implement the same
  // interface, so they share v2Quote(). A per-venue function per venue is how
  // five of them end up, four of them untested.
  assert.match(swapSrc, /async function v2Quote\(/);
  assert.match(swapSrc, /async function v3Quote\(/);
  assert.doesNotMatch(swapSrc, /sushiswapQuote/,
    'SushiSwap is a V2-family venue now, reached through the generic builder');
});
test('swap.js: router selector reads swapRouterSelect', () => {
  assert.match(swapSrc, /swapRouterSelect/);
});
test('swap.js: auto route order comes from the registry', () => {
  // A hand-written ladder is how a removed router lingers: it stays in the
  // try-order even after the registry stops listing it.
  assert.match(swapSrc, /SWAP_ROUTERS\.map\(\(r\) => r\.id\)/);
  assert.doesNotMatch(swapSrc, /routerOrder\s*=\s*\[[^\]]*'1inch'/);
});

// ── HTML has router selectors ──
test('page: swap has router selector', () => {
  assert.match(htmlSrc, /id="swapRouterSelect"/);
});
test('page: bridge has router selector', () => {
  assert.match(htmlSrc, /id="bridgeRouterSelect"/);
});
test('page: swap router has auto option', () => {
  assert.match(htmlSrc, /value="auto".*Best Price/s);
});
test('page: bridge router has auto option', () => {
  assert.match(htmlSrc, /value="auto".*Best Route/s);
});

// ── No secrets (HUKUM 9) ──
test('routers: no hardcoded secrets', () => {
  const noSecret = !src.match(/qYSDUOSxp6|sk-[A-Za-z0-9]{20,}|-----BEGIN.*PRIVATE/);
  assert.ok(noSecret);
});
