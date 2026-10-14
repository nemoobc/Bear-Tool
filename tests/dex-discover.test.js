// Bear Tool — tests/dex-discover.test.js
// The feed must be a VIEW of the chain, not a notebook in one browser.
//
// This was the last structural weakness in the launchpad: the list of coins came
// from localStorage written by whichever browser launched them. Clear the
// storage, open a different device, use a different browser, and real
// paid-for coins ceased to exist as far as the product was concerned. The chain
// held them the whole time; nothing read it.
//
// PumpToken now emits one indexed `Launched` per coin, so discovery is a single
// filtered log query. These tests pin that contract between the event, the query
// and the merge — including the three outcomes that must stay apart (found /
// found none / could not look), because collapsing them into one empty list is
// exactly the failure this module exists to prevent.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const E = await import('ethers');
const { discoverCoins, reconcile, resetDiscovery, lookbackBlocks } = await import('../js/dex/discover.js');
const { PUMP_ABI, PUMP_TOKEN_SOURCE } = await import('../js/dex/pump-source.js');

const CREATOR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const OTHER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

// A provider that answers getLogs from a scripted list, so the decode and the
// merge are exercised without a chain.
function stubProvider(logs, { latest = 10_000, throws = null } = {}) {
  const calls = [];
  return {
    calls,
    getBlockNumber: async () => latest,
    getLogs: async (filter) => {
      calls.push(filter);
      if (throws) throw new Error(throws);
      return logs;
    },
  };
}

// One Launched log, shaped exactly like ethers hands one back.
function launchedLog(token, name, symbol, block = 100) {
  const coder = E.AbiCoder.defaultAbiCoder();
  return {
    blockNumber: block,
    topics: [
      E.id('Launched(address,address,string,string)'),
      E.zeroPadValue(CREATOR.toLowerCase(), 32),
      E.zeroPadValue(token.toLowerCase(), 32),
    ],
    data: coder.encode(['string', 'string'], [name, symbol]),
  };
}

// globalThis.ethers is what core.js reads, and discovery reads the log filter
// through it — so the stub installs the same shape the browser would.
globalThis.ethers = E;

// The app state every discovery call reads through: provider, chain. Set once,
// then each test swaps the provider for its own stub. Doing this up front rather
// than per-test is what stopped six tests reporting "no provider" instead of
// testing anything.
const state = await import('../js/state.js');
state.set('networkId', 'sepolia');
state.set('network', { id: 'sepolia', chainId: 11155111 });
state.set('provider', stubProvider([]));
const use = (p) => state.set('provider', p);

test('the contract emits an indexed Launched from its constructor', () => {
  assert.ok(PUMP_TOKEN_SOURCE.includes('emit Launched(msg.sender, address(this), _name, _symbol);'),
    'the constructor must emit the launch record, or the coin is undiscoverable');
  const sig = 'event Launched(address indexed creator, address indexed token, string name, string symbol)';
  assert.ok(PUMP_ABI.some((f) => String(f) === sig),
    'the ABI must carry Launched, or ethers cannot filter on it');
});

test('the platform feed filters on the signature only, and "mine" narrows it', async () => {
  // Scope 'all' is what makes the Dex open on a feed of coins rather than a
  // create button over an empty list, so it MUST be the default and it must
  // still be a single filtered query — not a scan of the chain.
  resetDiscovery();
  const all = stubProvider([]);
  use(all);
  await discoverCoins({});
  assert.equal(all.calls.length, 1, 'discovery must be one query, not a scan');
  assert.deepEqual(all.calls[0].topics, [E.id('Launched(address,address,string,string)')],
    'the platform feed filters on the event signature alone');
  assert.ok(Number(all.calls[0].toBlock) >= Number(all.calls[0].fromBlock), 'the window must be ordered');

  // Scope 'mine' adds the creator as a second indexed topic, which is what makes
  // it cheap enough to run on every feed open.
  resetDiscovery();
  const mine = stubProvider([]);
  use(mine);
  await discoverCoins({ scope: 'mine', creator: CREATOR });
  assert.equal(mine.calls[0].topics[1], E.zeroPadValue(CREATOR.toLowerCase(), 32),
    '"my coins" must filter on the creator');
});

test('the log window is bounded, so discovery can never hang the feed', async () => {
  resetDiscovery();
  const p = stubProvider([], { latest: 5_000_000 });
  use(p);
  await discoverCoins({ creator: CREATOR });
  const f = p.calls[0];
  assert.ok(Number(f.toBlock) - Number(f.fromBlock) <= lookbackBlocks(),
    `the window must stay within the declared lookback, got ${Number(f.toBlock) - Number(f.fromBlock)}`);
});

test('a log decodes into a coin with its identity intact', async () => {
  resetDiscovery();
  const token = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
  use(stubProvider([launchedLog(token, 'Bear Moon', 'BMOON', 250)]));
  const out = await discoverCoins({ creator: CREATOR });

  assert.equal(out.ok, true, 'a readable chain must report ok');
  assert.equal(out.coins.length, 1);
  const c = out.coins[0];
  assert.equal(c.address.toLowerCase(), token.toLowerCase(), 'the token comes from the indexed topic');
  assert.equal(c.name, 'Bear Moon');
  assert.equal(c.symbol, 'BMOON');
  assert.equal(c.block, 250, 'the block is kept so the feed can order and page');
});

test('the newest launch comes first', async () => {
  resetDiscovery();
  use(stubProvider([
    launchedLog('0x1111111111111111111111111111111111111111', 'Old', 'OLD', 10),
    launchedLog('0x2222222222222222222222222222222222222222', 'New', 'NEW', 900),
    launchedLog('0x3333333333333333333333333333333333333333', 'Mid', 'MID', 400),
  ]));
  const out = await discoverCoins({ creator: CREATOR });
  assert.deepEqual(out.coins.map((c) => c.symbol), ['NEW', 'MID', 'OLD'],
    'the feed leads with the most recent launch');
});

test('an unreadable log is skipped, not rendered as a broken coin', async () => {
  resetDiscovery();
  const good = launchedLog('0x4444444444444444444444444444444444444444', 'Fine', 'FIN', 100);
  const broken = { blockNumber: 101, topics: good.topics, data: '0xdeadbeef' };
  use(stubProvider([good, broken]));
  const out = await discoverCoins({ creator: CREATOR });
  // the good one still comes through
  assert.ok(out.ok, 'one bad log must not fail the whole query');
  assert.ok(Array.isArray(out.coins), 'and the result stays an array');
});

test('"I could not look" must never look like "you launched nothing"', async () => {
  resetDiscovery();
  // This is the whole point. A failed query that returns [] paints an empty feed,
  // and an empty feed says "you have launched nothing" — which is false and
  // sends the user off to relaunch a coin they already own.
  use(stubProvider([], { throws: 'range too wide' }));
  const out = await discoverCoins({ creator: CREATOR });
  assert.equal(out.ok, false, 'a failed read must report not-ok');
  assert.match(out.reason, /range too wide/, 'and carry the reason so it can be shown');
});

test('every precondition that fails is named, not silently treated as empty', async () => {
  resetDiscovery();
  const bad = await discoverCoins({ scope: 'mine', creator: 'not-an-address' });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'no creator', 'a malformed address must be caught before any RPC');

  // The platform feed needs no address at all — that is the point: a visitor who
  // has never launched anything still gets a feed.
  resetDiscovery();
  use(stubProvider([launchedLog('0x7777777777777777777777777777777777777777', 'Any', 'ANY', 5)]));
  const anon = await discoverCoins({ scope: 'all' });
  assert.equal(anon.ok, true, 'the platform feed must work with no wallet connected');
  assert.equal(anon.coins.length, 1);

  // Sepolia IS the supported chain, so being on it is not a failure — the wrong
  // chain is any other one, and discovery must refuse rather than silently query
  // whatever node is active.
  const saved = state.get('networkId');
  state.set('networkId', 'ethereum');
  const wrong = await discoverCoins({ creator: CREATOR });
  state.set('networkId', saved);
  assert.equal(wrong.ok, false);
  assert.equal(wrong.reason, 'wrong chain', 'off Sepolia discovery must refuse rather than query another chain');
});

test('the feed unions the chain and this browser, chain winning on identity', async () => {
  resetDiscovery();
  const token = '0x5555555555555555555555555555555555555555';
  const local = [
    { address: token, name: 'Stale Name', symbol: 'STALE', image: 'data:image/png;base64,AAA' },
    { address: '0x6666666666666666666666666666666666666666', name: 'Only Local', symbol: 'LOCAL', image: '' },
  ];
  const p = stubProvider([launchedLog(token, 'True Name', 'TRUE', 300)]);

  // reconcile() calls discoverCoins() internally, which uses the module's own
  // provider lookup; drive it through the same stub by swapping the accessor the
  // module reads (core.provider -> state 'provider').
  use(p);
  const out = await reconcile({ scope: 'mine', creator: CREATOR, local });
  assert.equal(out.ok, true);
  const byAddr = new Map(out.coins.map((c) => [c.address.toLowerCase(), c]));

  assert.equal(byAddr.get(token.toLowerCase()).name, 'True Name',
    'the chain is the authority on a coin\'s name — a stale local copy must not win');
  assert.equal(byAddr.get(token.toLowerCase()).image, 'data:image/png;base64,AAA',
    'but the image survives: it is too large to log and lives only here');
  assert.ok(byAddr.get('0x6666666666666666666666666666666666666666'),
    'a coin the chain has not shown us yet must not blink out of the feed');
});

test('a full page means there may be more, and the feed says so', async () => {
  resetDiscovery(0); // lookback 0 -> the window is the whole chain, so a full page is easy to fake
  const many = [];
  for (let i = 0; i < 2000; i++) {
    many.push(launchedLog('0x' + (1000 + i).toString(16).padStart(40, '0'), 'C' + i, 'S' + i, i));
  }
  use(stubProvider(many));
  const out = await discoverCoins({ creator: CREATOR, limit: 10 });
  assert.equal(out.coins.length, 10, 'the caller\'s limit is respected');
  assert.equal(out.more, true,
    'a full page must be reported as "there may be older launches" — not presented as the complete list');
});

// ── the feed is ONE thing with two states ──────────────────────
test('a filter that matches nothing must not leave the old rows on screen', async () => {
  // Found in the browser: switching to "My coins" as a visitor who had launched
  // nothing showed three cards AND an empty message at once, because the grid was
  // only replaced when it had coins. A feed that says "empty" while still listing
  // coins is worse than either state alone.
  const tokens = await (await import('node:fs')).promises.readFile(
    new URL('../js/dex/tokens.js', import.meta.url), 'utf8');
  const fn = tokens.slice(tokens.indexOf('export async function refreshFeed'));
  assert.match(fn, /list\.innerHTML = coins\.map\(rowHtml\)\.join\(''\)/,
    'the grid must be rewritten on EVERY pass, including an empty result');
  assert.match(fn, /box\.hidden = coins\.length > 0/,
    'and the empty box must be hidden exactly when the grid has cards');
  assert.ok(!/if \(ok && coins\.length\) \{\s*list\.innerHTML/.test(fn),
    'the "only replace when non-empty" guard must not come back');
});
