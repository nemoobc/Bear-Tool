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

const { NETWORKS } = await import('../js/network.js');
const { BRIDGE_ROUTERS } = await import('../js/routers.js');

// ── Bridge registry ∩ shipped networks ──
// The lifi entry exists to answer ONE question honestly: which of the chains
// this wallet can actually connect to can LI.FI quote. Research 2026-10-05
// (docs/research/bridge-tokens-2026-10-05.md A5) proved two claims wrong the
// hard way: 97 and 80002 are REJECTED by LI.FI (HTTP 400 code 1011) while
// listed here — a dead route offered in a picker is worse than no route.

test('routers: lifi chains ⊆ NETWORKS — no route to a chain the wallet cannot connect to', () => {
  const lifi = BRIDGE_ROUTERS.find(r => r.id === 'lifi');
  const shipped = new Set(NETWORKS.map(n => n.chainId));
  for (const c of lifi.chains) {
    assert.ok(shipped.has(c), `lifi claims chain ${c} which is not in NETWORKS`);
  }
});

test('routers: lifi does not claim chains LI.FI rejects (97 & 80002 → 400 code 1011)', () => {
  const lifi = BRIDGE_ROUTERS.find(r => r.id === 'lifi');
  for (const dead of [97, 80002]) {
    assert.ok(!lifi.chains.includes(dead),
      `chain ${dead} must not be claimed: LI.FI answers 400 code 1011 for it (probe 2026-10-05)`);
  }
});

test('routers: every shipped mainnet is bridgeable via lifi', () => {
  // All 17 mainnets were confirmed inside LI.FI's 70-chain EVM set (research
  // A5) before they were promoted into NETWORKS — the promise must hold as
  // NETWORKS grows, or the bridge silently has no router on a new chain.
  const lifi = BRIDGE_ROUTERS.find(r => r.id === 'lifi');
  for (const n of NETWORKS.filter(x => x.type === 'mainnet')) {
    assert.ok(lifi.chains.includes(n.chainId),
      `${n.id} (${n.chainId}) is a shipped mainnet but lifi.chains does not cover it`);
  }
});

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
  // Grab each chains:[…] block, drop // line comments, then every remaining
  // token must be a plain integer. (The old regex demanded ] straight after
  // the numbers, so a commented array — added when the lifi list grew to 21
  // chains — silently made the entry uncheckable instead of checked.)
  const chains = [...src.matchAll(/chains:\s*\[([\s\S]*?)\]/g)];
  assert.ok(chains.length >= 8, `Expected >=8 router entries, got ${chains.length}`);
  // Every chainId in the registry must be a plain integer — a stray string or a
  // trailing comma typo silently excludes a venue from every chain filter.
  for (const [, body] of chains) {
    const code = body.replace(/\/\/[^\n]*/g, '');
    for (const part of code.split(',')) {
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

test('paraswapQuote: query-param prices API + approve target taken from the priceRoute', () => {
  // Measured 2026-10-03 against api.paraswap.io unauthenticated:
  //   path-style  /prices/1/0x…/0x…/amount   → 400 {"error":"Invalid tokens"}
  //   query-style /prices/?srcToken=…        → 200 {priceRoute} full quote
  // The priceRoute also carries tokenTransferProxy — the contract that pulls
  // the tokens, which is NOT the address the calldata is sent to (Augustus).
  const fn = swapSrc.slice(swapSrc.indexOf('async function paraswapQuote'),
                           swapSrc.indexOf('// ── get quote'));
  assert.match(fn, /prices\/\?srcToken=/,
    'prices must be fetched from the query-param endpoint, not the dead path style');
  assert.match(fn, /srcDecimals=/, 'the modern endpoint needs srcDecimals');
  assert.match(fn, /destDecimals=/, 'the modern endpoint needs destDecimals');
  assert.match(fn, /tokenTransferProxy/,
    'approveTo must come from the priceRoute — no hardcoded proxy table');
  assert.match(fn, /ignoreChecks/,
    'build runs at quote time, BEFORE doSwap approves — gating on allowance deadlocks: no quote → no approval → no quote');
  assert.match(fn, /approveTo:/, 'the returned build must carry the proxy address');
});

test('tryRouter wires paraswap, and doSwap approves built.approveTo when present', () => {
  // Wiring is the actual bug: the function existed and was never called.
  assert.match(swapSrc, /case 'paraswap'[\s\S]{0,500}paraswapQuote\(/,
    "case 'paraswap' must call paraswapQuote");
  assert.match(swapSrc, /built\.approveTo/,
    'doSwap must approve the proxy the priceRoute names when the route carries one');
});

test('komentar DLN: klaim "five probes" cocok dengan daftar probe di komentar itu sendiri', () => {
  // Komentar ini menolak satu aggregator berdasarkan pengukuran. Sebuah klaim
  // "five probes" dengan satu artefak adalah klaim yang tak terbukti — jadi
  // yang diuji: jumlahnya harus lima, bernomor berurutan, dengan status yang
  // disebut, dan tidak boleh menyebut jalur yang tidak ada di daftar.
  const at = src.indexOf('deBridge DLN');
  assert.ok(at > -1, 'alasan DLN ditolak harus tetap tertulis');
  const block = src.slice(at, src.indexOf('export const BRIDGE_ROUTERS'));
  assert.match(block, /400 \/ 150 bytes/, 'status + ukuran body yang diukur harus disebut');
  assert.match(block, /five of them/, 'jumlah probe disebut eksplisit');
  const numbered = [...block.matchAll(/\((\d)\)/g)].map((m) => m[1]);
  assert.deepEqual(numbered, ['1', '2', '3', '4', '5'],
    `daftar probe harus tepat lima dan berurutan, bukan ${numbered.length} entri`);
  for (const p of ['/v1/chainPairs', '/v1/quote', '/v1/order-book']) {
    assert.ok(block.includes(p), `jalur yang diklaim diuji harus tertulis: ${p}`);
  }

  // Bukti fisik ikut diuji: klaim komentar = isi folder fixture.
  const fx = new URL('./fixtures/dln/', import.meta.url);
  const status = readFileSync(new URL('status.txt', fx), 'utf8').trim().split('\n');
  assert.equal(status.length, 5, 'status.txt harus memuat lima probe');
  for (const line of status) {
    assert.match(line, /^\d: HTTP 400 \/ 150 bytes$/, `probe tidak 400/150: ${line}`);
  }
  const bodies = [1, 2, 3, 4, 5].map((n) =>
    readFileSync(new URL(`body_dln${n}`, fx)));
  assert.ok(bodies.every((b) => b.equals(bodies[0])),
    'kelima body harus identik (nginx 400 polos, bukan JSON)');
  assert.ok(block.includes('tests/fixtures/dln/'),
    'komentar harus menunjuk bukti yang benar-benar ada di repo');
});
