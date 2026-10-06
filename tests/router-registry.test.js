// Bear Tool — router registry guards
//
// js/routers.js lists on-chain DEX venues, keyless aggregators and one bridge.
// Three ways that file can rot, all of which have already happened:
//
//   1. An address is listed for a chain where nothing is deployed. Camelot
//      0xc873fEcbd354f5A56E00E710B9cEFf27455E8AA2 and Aerodrome
//      0xcF77a3Ba9A5CA399B7c97c74d54e3b4f7CdeC441 both have no code on the
//      chains they were listed for. Uniswap V3's SwapRouter02 was listed on Base
//      where it does not exist, while its QuoterV2 does — a quoter with no router.
//
//   2. A route is listed that the wallet cannot execute. That is a dead end in a
//      dropdown, which reads to the user as "this venue failed" rather than
//      "this was never available".
//
//   3. A service that started requiring an API key is still carried as a route.
//
// The first group is checked here as source. The second and third need the
// network, and are in router-addresses.test.js.

// ── static rules ─────────────────────────────────────────────────────────
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(here, '..', rel), 'utf8');
const fsExists = (q) => { try { return statSync(q).isDirectory(); } catch { return false; } };
const routersSrc = read('js/routers.js');
const swapSrc = read('js/swap.js');
const bridgeSrc = read('js/bridge.js');

// Load the real module so the assertions run against the actual data, not a
// regex over its source text.
const { SWAP_ROUTERS, BRIDGE_ROUTERS, getRouterAddress, getQuoterAddress, getSwapRoutersForChain } =
  await import(pathToFileURL(path.join(here, '..', 'js', 'routers.js')).href);

const ADDR = /^0x[0-9a-fA-F]{40}$/;

test('every on-chain address is a well-formed address', () => {
  const bad = [];
  for (const r of SWAP_ROUTERS) {
    for (const [chain, addr] of Object.entries(r.router || {})) {
      if (!ADDR.test(addr)) bad.push(`${r.id} chain ${chain}: ${addr}`);
    }
    for (const [chain, addr] of Object.entries(r.quoter || {})) {
      if (!ADDR.test(addr)) bad.push(`${r.id} quoter chain ${chain}: ${addr}`);
    }
  }
  assert.deepEqual(bad, [], `malformed addresses: ${bad.join(', ')}`);
});

test('an entry never claims a chain its address map does not cover', () => {
  // This is the check that would have caught Uniswap V3 on Base: `chains` said
  // 8453 while the honest answer is that SwapRouter02 is not deployed there.
  const bad = [];
  for (const r of SWAP_ROUTERS) {
    if (r.type !== 'dex') continue;
    const listed = new Set(r.chains.map(Number));
    const mapped = new Set(Object.keys(r.router || {}).map(Number));
    for (const c of listed) if (!mapped.has(c)) bad.push(`${r.id} claims chain ${c} with no address`);
    for (const c of mapped) if (!listed.has(c)) bad.push(`${r.id} has an address for unlisted chain ${c}`);
  }
  assert.deepEqual(bad, [], bad.join('; '));
});

test('a V3 entry with a quoter only lists chains where BOTH are mapped', () => {
  // QuoterV2 is CREATE2, so one address covers every chain it exists on — which
  // is exactly why it is easy to assume it covers the chains the router does.
  // It is absent on BNB, BSC testnet and Sepolia while being present on Base,
  // where the router is the thing that is missing.
  const bad = [];
  for (const r of SWAP_ROUTERS) {
    if (r.abi !== 'v3' || !r.quoter) continue;
    for (const c of r.chains.map(Number)) {
      if (!getQuoterAddress(r.id, c)) bad.push(`${r.id} chain ${c} has a router but no quoter`);
    }
  }
  assert.deepEqual(bad, [], bad.join('; '));
});

test('every DEX venue declares an ABI family the wallet has a builder for', () => {
  // abi 'v2' and 'v3' are the two builders in swap.js. A third family would be
  // a route the registry offers and the executor cannot serve.
  for (const r of SWAP_ROUTERS) {
    if (r.type !== 'dex') continue;
    assert.ok(r.abi === 'v2' || r.abi === 'v3', `${r.id} has unknown abi "${r.abi}"`);
  }
  assert.match(swapSrc, /async function v2Quote\(/, 'the v2 builder must exist');
  assert.match(swapSrc, /async function v3Quote\(/, 'the v3 builder must exist');
});

test('no venue that needs an API key is carried as a route', () => {
  // Measured, not assumed: api.1inch.dev/swap/v6.0 answers 401 and
  // api.socket.tech/v2 answers 403 without a credential. A 400 is NOT a key
  // error — KyberSwap and ParaSwap answer 400 to a bad parameter and 200 to a
  // good one, unauthenticated — so this list is short on purpose.
  const KEYS = ['1inch', 'oneinch', 'bungee', 'socket', 'matcha', 'bebop', 'paraswap_api_key'];
  for (const r of [...SWAP_ROUTERS, ...BRIDGE_ROUTERS]) {
    for (const k of KEYS) {
      assert.ok(!r.id.toLowerCase().includes(k), `${r.id} is in the registry but needs a key`);
    }
  }
  const src = routersSrc.toLowerCase();
  for (const host of ['api.1inch.dev', 'api.socket.tech', 'backend.bungee.exchange']) {
    assert.ok(!src.includes(host), `${host} appears in routers.js but answers 401/403 unauthenticated`);
  }
});

test('the bridge registry holds only routes the wallet can actually call', () => {
  // bridge.js executes whatever transactionRequest a service returns, so a
  // protocol that only appears in a list of supported chains is not a route.
  // Measured unauthenticated 2026-10-06: LI.FI /v1/quote → 200, Gas.zip
  // /v2/quotes → 200 (contractDepositTxn), Relay POST /quote/v2 → 200.
  // Superbridge stays OUT: api.superbridge.app → 401 and access is granted
  // case by case — 401 without a credential is the same rule that removed
  // 1inch and Bungee from the swap registry.
  // opstack: canonical OP-stack deposit, built client-side — no endpoint.
  assert.deepEqual(BRIDGE_ROUTERS.map((r) => r.id), ['lifi', 'gaszip', 'relay', 'opstack']);
  const bridgeRoutes = readFileSync(new URL('../js/bridge-routes.js', import.meta.url), 'utf8');
  assert.match(bridgeSrc, /li\.quest/, 'bridge.js must still call the route that is actually live');
  assert.match(bridgeRoutes, /backend\.gas\.zip/, 'gas.zip adapter must call its measured endpoint');
  assert.match(bridgeRoutes, /api\.relay\.link/, 'relay adapter must call its measured endpoint');
  assert.doesNotMatch(bridgeRoutes, /https?:\/\/[^\s'"`]*superbridge/i,
    'superbridge answers 401 without a key — a route the app cannot call has no place here');
  // …and it must not quietly invent a fallback when that call fails.
  assert.doesNotMatch(bridgeSrc, /simulated:\s*true/,
    'a simulated bridge quote is exactly the lie this registry rewrite removed');
});

test('the auto-route ladder is derived from the registry, not hand-listed', () => {
  // A literal array is how a removed router lingers: it stays in the try-order
  // even after the registry no longer lists it.
  assert.match(swapSrc, /SWAP_ROUTERS\.map\(\(r\) => r\.id\)/,
    'the try-order must be read from the registry');
  assert.doesNotMatch(swapSrc, /routerOrder\s*=\s*\[[^\]]*'1inch'/,
    '1inch must not appear in the try-order');
});

test('router addresses are declared in one place only', () => {
  // swap.js used to keep its own copy of the address maps and the two drifted:
  // the registry advertised a Base route the maps had no entry for.
  assert.doesNotMatch(swapSrc, /const UNISWAP_V2_ROUTER\s*=/,
    'swap.js must not re-declare router addresses');
  assert.doesNotMatch(swapSrc, /const UNISWAP_V3_ROUTER\s*=/,
    'swap.js must not re-declare router addresses');
  assert.doesNotMatch(swapSrc, /const UNISWAP_QUOTER_V3\s*=/,
    'swap.js must not re-declare quoter addresses');
  // A fallback WETH table keyed by address is fine; one keyed by chain alone is
  // the ambiguity this replaced.
  assert.match(swapSrc, /CHAIN_WETH_BY_ROUTER/,
    'the V3 fallback should be keyed by router address');

  // …and the inverse of the three assertions above, which is what actually let a
  // working feature die. Those three checked that swap.js no longer declares
  // router *addresses*. They were read as "the rewrite is complete", and in
  // removing the local address tables the rewrite also removed UNISWAP_V2_ABI and
  // UNISWAP_V3_ABI, which nothing else defined. Every quote and every swap then
  // threw ReferenceError, on every chain, for as long as this test passed green.
  //
  // A test that only forbids things is half a gate. This half requires the thing
  // that must still be there, so removing a symbol can no longer pass by
  // satisfying the absence checks alone.
  assert.match(swapSrc, /const UNISWAP_V2_ABI\s*=/,
    'swap.js harus mendeklarasikan UNISWAP_V2_ABI — v2Quote dan uniswapV2Swap memakainya');
  assert.match(swapSrc, /const UNISWAP_V3_ABI\s*=/,
    'swap.js harus mendeklarasikan UNISWAP_V3_ABI — v3Quote dan uniswapV3Swap memakainya');
});

test('getSwapRoutersForChain only returns venues with a usable address', () => {
  for (const chain of [1, 10, 56, 137, 42161, 8453, 11155111, 80002, 421614, 11155420, 84532, 97]) {
    for (const r of getSwapRoutersForChain(chain)) {
      if (r.type !== 'dex') continue;
      assert.ok(getRouterAddress(r.id, chain),
        `${r.name} is offered on chain ${chain} but has no address for it`);
    }
  }
});

test('the registry carries provenance so the next person can re-check it', () => {
  assert.match(routersSrc, /verified/i,
    'a registry of addresses must say how they were verified and when');
  assert.match(routersSrc, /eth_getCode/,
    'name the check that was actually run, not "looks right"');
});

test('the live address check is not in the deterministic gate', () => {
  // `npm test` must stay reproducible offline. A gate that depends on someone
  // else's uptime eventually reports a network problem as a product problem, and
  // the first version of this file did exactly that: hundreds of sequential
  // requests inside `node --test tests/*.test.js` stopped the whole run
  // producing output on a fresh box, with no failure — just silence.
  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.scripts['test:live'], /live\.js/,
    'the live check needs its own script');
  assert.doesNotMatch(pkg.scripts.test, /live/,
    'and must not be in the default gate');
  // The live file must exist, or the script points at nothing.
  const fs = read('tests/live-router-addresses.live.js');
  assert.match(fs, /skipped\(|t\.skip/,
    'it must skip honestly when offline rather than fail');
});

test('the syntax gate runs on the platform the tests run on', () => {
  // `check` was a shell loop. npm runs scripts through cmd.exe on Windows, which
  // fails that loop with "(f was unexpected at this time.)" before checking a
  // single file — so `verify`, the project's own gate, could not run on the box
  // the suite runs on, and nothing reported it.
  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.scripts.check, /node\s+tools\/check\.mjs/,
    'check must be a Node script, not a shell loop');
  assert.doesNotMatch(pkg.scripts.check, /\bfor\b.*\bin\b/,
    'a `for … in …` loop is cmd.exe-incompatible');
  // …and it must be reachable from the gate, not merely present.
  assert.match(pkg.scripts['test:all'], /run check/,
    'the full gate must still start with the syntax check');
  // A script that is not there would make the gate pass by being absent.
  const check = read('tools/check.mjs');
  assert.match(check, /--check/, 'the checker must actually invoke node --check');
  assert.match(check, /process\.exit\(1\)/, 'and must fail loudly');
  // Recursion, and specifically this one. The checker listed only the top level of
  // js/ and tests/, so tests/fork/*.js and tests/e2e/*.js were never parsed while
  // still being counted in the "N file OK" total. A fork test with a syntax error
  // was reported as a clean check locally and only refused to load on the box.
  //
  // A coverage gap inside a gate is worse than a missing gate, because the total
  // says the files were checked. So the traversal itself is pinned here, and the
  // count is pinned against the filesystem rather than against a number someone
  // remembered.
  assert.match(check, /withFileTypes/,
    'the checker must walk directories; a flat readdirSync skips tests/fork and tests/e2e');
  assert.match(check, /entry\.isDirectory\(\)/,
    'subdirectories must be descended into');
  assert.match(check, /node_modules/,
    'the walk must skip node_modules or it will try to parse dependencies');
  const countJs = (dir) => readdirSync(dir, { withFileTypes: true }).reduce((n, e) => {
    if (e.name === 'node_modules' || e.name.startsWith('.')) return n;
    const p = path.join(dir, e.name);
    return n + (e.isDirectory() ? countJs(p) : (/\.m?js$/.test(e.name) ? 1 : 0));
  }, 0);
  // Follow the gate's own TARGETS list rather than repeating it here. Hardcoding
  // the directories duplicated the thing being checked, and immediately went stale:
  // check.mjs grew a `tools` target and this count still said js + tests, so the
  // detector would have gone red on a correct gate. A lock that needs editing
  // alongside the thing it locks is a lock that gets removed.
  const targets = /const TARGETS\s*=\s*\[([^\]]*)\]/.exec(check);
  assert.ok(targets, 'check.mjs harus mendeklarasikan TARGETS sebagai literal array');
  const dirs = [...targets[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(dirs.length > 0, 'TARGETS kosong — gerbang tidak memeriksa apa pun');
  const expected = dirs.reduce((sum, d) => sum + countJs(path.join(here, '..', d)), 0);
  // `--list` instead of a full run: the question is which files the gate reaches,
  // and asking it that costs one process rather than one per file. Running the
  // whole check from in here took 142 seconds to produce the same number.
  const listed = spawnSync(process.execPath, ['tools/check.mjs', '--list'],
    { encoding: 'utf8', cwd: path.join(here, '..') });
  const reported = (listed.stdout || '').trim().split('\n').filter(Boolean).length;
  assert.equal(reported, expected,
    `check mencapai ${reported} file, filesystem punya ${expected} — ada direktori yang dilewati`);
  // …and the list must actually contain the nested directories, named outright so a
  // silent drop back to a flat walk is visible in the failure.
  //
  // Separators normalised first. check.mjs builds paths with path.join, so on
  // Windows the list reads `tests\fork\fork-swap-app.test.js` and a search for the
  // literal "tests/fork/" finds nothing. That is not a harmless portability quirk:
  // the detector went red on the box and green on Termux for the same correct
  // behaviour, which is the worst way for a gate to differ between the machine you
  // develop on and the machine the tests run on.
  const names = (listed.stdout || '').replace(/\\/g, '/');
  for (const nested of ['tests/fork/', 'tests/e2e/']) {
    if (fsExists(path.join(here, '..', nested))) {
      assert.ok(names.includes(nested.replace(/\/$/, '/')),
        `check tidak mencakup ${nested} — file di sana tidak pernah di-parse`);
    }
  }
});

test('fork swap tests read addresses from the registry, not a local copy', () => {
  // Two swap tests have now kept their own address map beside js/routers.js.
  // The second one filed PancakeSwap V3's SmartRouter under "PancakeSwap V2" —
  // invisible while the suite stayed on Ethereum and the entry never fired.
  const t = read('tests/fork/fork-swap.test.js');
  // The import is dynamic — pathToFileURL(...) rather than a static `from` — so
  // an assertion looking for `from '…routers.js'` passed nothing while reading
  // as though the rule were enforced.
  assert.match(t, /import\(.*routers\.js/s, 'the registry is the only place addresses live');
  assert.match(t, /getRouterAddress\(/,
    'and the address must come from the registry lookup, not a local copy');
  assert.doesNotMatch(t, /const V2_ROUTERS\s*=\s*\{/,
    'a local router map is how the two drifted in the first place');
  // At least one venue other than Uniswap, or the registry is untested.
  assert.match(t, /quickswap|quickswap|baseswap/i,
    'a non-Uniswap V2 venue must be exercised on a fork');
});

test('the syntax checker covers js/ and tests/, not just one of them', () => {
  // A gate that checks js/ and misses tests/ passes while a test file is broken —
  // and a broken test file does not announce itself, it just never runs.
  const check = read('tools/check.mjs');
  assert.match(check, /'js'/);
  assert.match(check, /'tests'/);
});

test('no route claims a chain Bear Tool cannot connect to', async (t) => {
  // LI.FI's chain list carried Avalanche, Fantom, Aurora and Gnosis — none of
  // which is in js/network.js. The registry therefore advertised routes to
  // chains the wallet has no way to reach, and the README repeated it as
  // "all chains". A route that needs a missing chain is a dead end in the same
  // way a router with no contract is: it can only end in an error.
  const { NETWORKS } = await import(new URL('../js/network.js', import.meta.url).href);
  const supported = new Set(NETWORKS.map((n) => Number(n.chainId)));
  assert.ok(supported.size >= 6, 'the network list itself must be readable');

  const bogus = [];
  for (const r of [...SWAP_ROUTERS, ...BRIDGE_ROUTERS]) {
    for (const c of r.chains.map(Number)) {
      if (!supported.has(c)) bogus.push(`${r.name} chain ${c}`);
    }
  }
  assert.deepEqual(bogus, [], `these routes claim chains the app does not support: ${bogus.join(', ')}`);

  // And the display names must not drift either: a name for a chain the app
  // cannot open is the same claim in a different place.
  const { CHAIN_NAMES } = await import(new URL('../js/routers.js', import.meta.url).href);
  const extraNames = Object.keys(CHAIN_NAMES).map(Number).filter((c) => !supported.has(c));
  assert.deepEqual(extraNames, [], `CHAIN_NAMES has entries for unsupported chains: ${extraNames.join(', ')}`);
});

test('the README does not describe a route set the registry does not have', () => {
  // Documentation that outruns the code is how "all chains" got here. The ladder
  // is now derived from the registry, so the README must say so rather than
  // naming a fixed sequence that no longer describes what runs.
  const readme = read('README.md');
  // Scope: the FEATURE lines, not the whole file. 1inch legitimately appears in
  // the CSP table, where it is a dApp the app refuses to frame — that says
  // nothing about whether it is offered as a route, and a blanket "the word must
  // not appear" test would push someone to delete a correct security note.
  const featureLines = readme.split('\n')
    .filter((l) => /^\|.*(Swap|Bridge)/.test(l) || /auto-route|LI\.FI quotes/.test(l))
    .join('\n');
  assert.ok(featureLines.length > 0, 'the feature table must be found to check it');
  // A name may legitimately appear in the feature table if the line says it was
  // REMOVED — the README now records that 1inch and Bungee need a key, and
  // deleting that note would be worse than keeping it. So the rule is: never
  // present one as available, and if it is named, say in the same breath that it
  // is gone.
  const REMOVED = ['1inch', 'Bungee', 'Socket.tech', 'stargate.finance', 'Across', 'Wormhole', 'Synapse'];
  for (const line of featureLines.split('\n')) {
    for (const name of REMOVED) {
      if (!new RegExp(name.replace('.', '\\.'), 'i').test(line)) continue;
      assert.match(line, /not offered|removed|need a key|401|403|no longer/i,
        `"${name}" is named in the feature table without saying it was removed:\n      ${line}`);
    }
  }
  assert.match(featureLines, /KyberSwap/);
  assert.match(featureLines, /LI\.FI/);
  // The fixed ladder is gone; the README must not still claim one.
  assert.doesNotMatch(readme, /KyberSwap\s*→\s*Uniswap V3\s*→\s*Uniswap V2/,
    'the auto-route order is derived from the registry, not a fixed sequence');
  assert.doesNotMatch(featureLines, /all chains/,
    'the app supports twelve networks; "all chains" was never true');
});

test('every aggregator in the registry has a tryRouter case (no dead dropdown entries)', () => {
  // The bug this pins: ParaSwap sat in the registry AND in the router dropdown
  // while tryRouter had no case for it — selecting it fell through to the dex
  // default and threw "not an on-chain route here". A listed venue the wallet
  // cannot quote is the dead end this registry exists to prevent (rule 2 in
  // the routers.js header).
  const cases = new Set([...swapSrc.matchAll(/case '([a-z0-9_]+)'/g)].map((m) => m[1]));
  for (const r of SWAP_ROUTERS) {
    if (r.type === 'aggregator') {
      assert.ok(cases.has(r.id),
        `${r.id} is listed and selectable but tryRouter has no case for it`);
    }
  }
});
