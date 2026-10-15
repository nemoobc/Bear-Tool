// Bear Tool — tests/dex-pools.test.js
// Discovery v2: the pool feed must be a VIEW of the factory's logs — one
// filtered query, three outcomes kept apart (found / found none / could not
// look), and metadata that can never lie because it is immutable on-chain.
//
// These tests script the logs a node would hand back and pin the query shape,
// the decode, the dedupe, the metadata cache and the local merge. The live
// proof is tests/dex-v2-onchain-e2e.mjs: same module, real factory, anvil.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const E = await import('ethers');
globalThis.ethers = E;

const {
  discoverPools, decodePoolLog, reconcilePools, fillMeta, resetDiscovery,
  lookbackBlocks, factoryAddress, setFactoryAddress, cachedMeta,
} = await import('../js/dex/pools.js');

const CREATOR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const OTHER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const TOKEN_A = '0x1111111111111111111111111111111111111111';
const TOKEN_B = '0x2222222222222222222222222222222222222222';
const TOKEN_C = '0x3333333333333333333333333333333333333333';
// Letters in the address, so "same token, different case" is a real test.
const TOKEN_D = '0xdeadbeef' + '00'.repeat(14) + 'beef';
const PAIR_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PAIR_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const PAIR_C = '0xcccccccccccccccccccccccccccccccccccccccc';
const QUOTE = '0x8847346f20aCe5bd4619B7fbF3467D001E269fE9';
const FACTORY = '0x9999999999999999999999999999999999999999';

// A provider that answers getLogs from a scripted list (and, for fillMeta,
// eth_call from a scripted metadata map), so the decode and the merge are
// exercised without a chain.
function stubProvider(logs = [], { latest = 10_000, throws = null, meta = {} } = {}) {
  const calls = [];
  const callLog = [];
  const coder = E.AbiCoder.defaultAbiCoder();
  const NAME_SEL = '0x06fdde03';
  const SYMBOL_SEL = '0x95d89b41';
  return {
    calls,
    callLog,
    getBlockNumber: async () => latest,
    getLogs: async (filter) => {
      calls.push(filter);
      if (throws) throw new Error(throws);
      return logs;
    },
    call: async ({ to, data }) => {
      callLog.push({ to: String(to).toLowerCase(), sel: String(data).slice(0, 10) });
      const hit = meta[String(to).toLowerCase()];
      if (!hit) throw new Error('CALL_EXCEPTION');
      const sel = String(data).slice(0, 10);
      if (sel === NAME_SEL) return coder.encode(['string'], [hit.name]);
      if (sel === SYMBOL_SEL) return coder.encode(['string'], [hit.symbol]);
      throw new Error('unknown selector');
    },
  };
}

// One factory log, shaped exactly like ethers hands one back: three indexed
// identity topics, the quote as the sole data field.
function poolLog(kind, { creator = CREATOR, token, pair, quote = QUOTE, block = 100 }) {
  const coder = E.AbiCoder.defaultAbiCoder();
  const sig = kind === 'launched'
    ? 'Launched(address,address,address,address)'
    : 'PoolCreated(address,address,address,address)';
  return {
    blockNumber: block,
    topics: [
      E.id(sig),
      E.zeroPadValue(creator.toLowerCase(), 32),
      E.zeroPadValue(token.toLowerCase(), 32),
      E.zeroPadValue(pair.toLowerCase(), 32),
    ],
    data: coder.encode(['address'], [quote]),
  };
}

// The app state every discovery call reads through: provider, chain. Set once,
// then each test swaps the provider for its own stub.
const state = await import('../js/state.js');
state.set('networkId', 'sepolia');
state.set('network', { id: 'sepolia', chainId: 11155111 });
const use = (p) => state.set('provider', p);
use(stubProvider([]));

const fresh = () => {
  store.clear();
  resetDiscovery();
};

test('the factory address is per chain, validated both ways', () => {
  fresh();
  assert.equal(factoryAddress(), '', 'no factory stored = empty, not a guess');
  assert.equal(setFactoryAddress('not-an-address'), false, 'garbage must not become a filter');
  assert.equal(setFactoryAddress(FACTORY), true);
  assert.equal(factoryAddress(), FACTORY, 'stored lowercase for every later compare');
  assert.equal(setFactoryAddress(''), false, 'empty string is not an address');
});

test('no factory, wrong chain, no creator: three DIFFERENT refusals, never a fake empty feed', async () => {
  fresh();
  use(stubProvider([]));

  const noFactory = await discoverPools({});
  assert.equal(noFactory.ok, false);
  assert.equal(noFactory.reason, 'no factory', 'the feed must be able to say "deploy the factory first"');
  assert.deepEqual(noFactory.pools, []);

  setFactoryAddress(FACTORY);
  const saved = state.get('networkId');
  state.set('networkId', 'bogus-network-id');
  const wrong = await discoverPools({});
  assert.equal(wrong.ok, false);
  assert.equal(wrong.reason, 'wrong chain');
  state.set('networkId', saved);

  const noCreator = await discoverPools({ scope: 'mine', creator: '' });
  assert.equal(noCreator.ok, false);
  assert.equal(noCreator.reason, 'no creator');

  const ok = await discoverPools({});
  assert.equal(ok.ok, true, 'with a factory + sepolia + provider the same call succeeds');
});

test('the platform feed is ONE query against the factory, both birth events OR-ed on topic0', async () => {
  fresh();
  setFactoryAddress(FACTORY);
  const p = stubProvider([]);
  use(p);
  await discoverPools({});
  assert.equal(p.calls.length, 1, 'discovery must be one query, not a scan');
  const f = p.calls[0];
  assert.equal(String(f.address).toLowerCase(), FACTORY, 'the address filter is what keeps other contracts out');
  assert.deepEqual(f.topics, [[E.id('Launched(address,address,address,address)'), E.id('PoolCreated(address,address,address,address)')]],
    'both events are how a pool is born; an OR on topic0 catches each');
  assert.ok(Number(f.toBlock) >= Number(f.fromBlock), 'the window must be ordered');
  assert.equal(lookbackBlocks(), 50_000, 'the default window is bounded');

  // Scope 'mine' adds the creator as a second indexed topic.
  resetDiscovery();
  const m = stubProvider([]);
  use(m);
  await discoverPools({ scope: 'mine', creator: CREATOR });
  assert.deepEqual(m.calls[0].topics[1], E.zeroPadValue(CREATOR.toLowerCase(), 32));
  assert.equal(m.calls[0].topics.length, 2, 'and does not accidentally widen the filter');
});

test('logs decode to rows and the feed leads with the newest', async () => {
  fresh();
  setFactoryAddress(FACTORY);
  use(stubProvider([
    poolLog('launched', { token: TOKEN_A, pair: PAIR_A, block: 100 }),
    poolLog('poolCreated', { token: TOKEN_B, pair: PAIR_B, block: 300, creator: OTHER }),
  ]));
  const low = (a) => String(a).toLowerCase();
  const r = await discoverPools({});
  assert.equal(r.ok, true);
  assert.equal(r.pools.length, 2);
  assert.equal(low(r.pools[0].address), low(TOKEN_B), 'newest first');
  assert.equal(r.pools[0].block, 300);
  assert.equal(low(r.pools[0].creator), low(OTHER));
  assert.equal(low(r.pools[0].pair), low(PAIR_B));
  assert.equal(low(r.pools[0].quote), low(QUOTE));
  assert.equal(low(r.pools[1].address), low(TOKEN_A));
  assert.equal(low(r.pools[1].creator), low(CREATOR));
  assert.equal(low(r.pools[1].pair), low(PAIR_A));
});

test('one pool per token — a duplicate log cannot double the feed', async () => {
  fresh();
  setFactoryAddress(FACTORY);
  use(stubProvider([
    poolLog('launched', { token: TOKEN_D, pair: PAIR_A, block: 100 }),
    poolLog('poolCreated', { token: '0x' + TOKEN_D.slice(2).toUpperCase(), pair: PAIR_C, block: 200 }),
  ]));
  const r = await discoverPools({});
  assert.equal(r.pools.length, 1, 'by contract one token has one pool; the feed must agree');
  assert.equal(String(r.pools[0].pair).toLowerCase(), String(PAIR_A).toLowerCase(), 'the first log wins — a later duplicate is not a real event');
});

test('a log that does not decode is skipped, not guessed', () => {
  fresh();
  assert.equal(decodePoolLog(E, { topics: ['0x', '0x0', '0x0'], data: '0x' }), null);
  assert.equal(decodePoolLog(E, { topics: [], data: '0xnope' }), null);
});

test('a node that cannot answer says so — it never looks like an empty feed', async () => {
  fresh();
  setFactoryAddress(FACTORY);
  use(stubProvider([], { throws: 'log query unsupported' }));
  const r = await discoverPools({});
  assert.equal(r.ok, false, 'could-not-look is not found-none');
  assert.match(String(r.reason), /log query unsupported/);
});

test('found none is ok:true with zero rows — a real, verified empty', async () => {
  fresh();
  setFactoryAddress(FACTORY);
  use(stubProvider([]));
  const r = await discoverPools({});
  assert.equal(r.ok, true);
  assert.deepEqual(r.pools, []);
  assert.equal(r.more, false);
});

test('a full page reports more:true so the window can widen honestly', async () => {
  fresh();
  setFactoryAddress(FACTORY);
  const many = [];
  for (let i = 0; i < 2000; i++) {
    many.push(poolLog('launched', {
      token: '0x' + String(i + 0x1000).padStart(40, '0'),
      pair: '0x' + String(i + 0x9000).padStart(40, '0'),
      block: i + 1,
    }));
  }
  use(stubProvider(many));
  const r = await discoverPools({ limit: 10 });
  assert.equal(r.ok, true);
  assert.equal(r.pools.length, 10, 'the caller asked for 10');
  assert.equal(r.more, true, 'a full page means there may be older pools beyond the window');
});

test('fillMeta: local knowledge is cached, chain answers fill the rest, one read each', async () => {
  fresh();
  const p = stubProvider([], { meta: { [TOKEN_B]: { name: 'Bear B', symbol: 'BB' }, [TOKEN_C]: { name: 'Bear C', symbol: 'CC' } } });
  use(p);

  const rows = [
    { address: TOKEN_A, name: 'Bear A', symbol: 'BA' }, // from the local index
    { address: TOKEN_B, name: '', symbol: '' },          // must be read from chain
    { address: TOKEN_C, name: '', symbol: '' },          // must be read from chain
  ];
  const filled = await fillMeta(rows);
  assert.equal(filled[0].name, 'Bear A');
  assert.equal(filled[1].name, 'Bear B');
  assert.equal(filled[1].symbol, 'BB');
  assert.equal(filled[2].name, 'Bear C');
  assert.equal(p.callLog.length, 4, 'two chains read 2 fields each — no third read was needed');

  // Everything is cached now, so a second call must not touch the chain at all.
  p.callLog.length = 0;
  const again = await fillMeta([{ address: TOKEN_A }, { address: TOKEN_B }, { address: TOKEN_C }]);
  assert.equal(again[1].name, 'Bear B', 'cache serves the name');
  assert.equal(p.callLog.length, 0, 'immutable on-chain metadata is read once, ever');
  assert.deepEqual(cachedMeta(TOKEN_A), { name: 'Bear A', symbol: 'BA' });
});

test('a token that will not answer renders as an address, not as a fake name', async () => {
  fresh();
  use(stubProvider([], { meta: {} })); // every call throws CALL_EXCEPTION
  const filled = await fillMeta([{ address: TOKEN_B, name: '', symbol: '' }]);
  assert.equal(filled[0].name, '');
  assert.equal(filled[0].symbol, '');
  assert.equal(cachedMeta(TOKEN_B), null, 'a failure must not be cached as a result');
});

test('reconcile unions local and chain: local contributes the image, chain the truth', async () => {
  fresh();
  setFactoryAddress(FACTORY);
  use(stubProvider([
    poolLog('launched', { token: TOKEN_A, pair: PAIR_A, block: 100 }),
    poolLog('launched', { token: TOKEN_B, pair: PAIR_B, block: 300 }),
  ]));
  const { pools } = await reconcilePools({
    local: [
      { address: TOKEN_A, name: 'Bear A', symbol: 'BA', image: 'data:image/svg+xml,<svg/>', block: 0 },
      { address: TOKEN_C, name: 'Local Only', symbol: 'LOC', image: 'data:x' },
    ],
  });
  const byA = pools.find((x) => x.address === TOKEN_A);
  const byB = pools.find((x) => x.address === TOKEN_B);
  const byC = pools.find((x) => x.address === TOKEN_C);
  assert.equal(byA.image, 'data:image/svg+xml,<svg/>', 'the log does not carry the image; local does');
  assert.equal(byA.source, 'chain', 'and identity still comes from the chain');
  assert.equal(byB.name, '', 'a chain pool this device never launched has no local name yet');
  assert.ok(byC, 'a not-yet-indexed local coin must not blink out while we wait');
  assert.equal(pools[0].address, TOKEN_B, 'chain ordering leads');
});
