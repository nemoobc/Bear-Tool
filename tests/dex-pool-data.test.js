// Bear Tool — tests/dex-pool-data.test.js
// The v2 surfaces share ONE read layer over a pool. These tests script a node's
// eth_call answers (dispatched by real ABI selectors) and pin the three things
// every surface then relies on: reserves in the contract's own order, decimals
// READ not assumed, and LP values floored the way removeLiquidity pays — so no
// screen ever shows a number the contract would not honour.
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

const { poolState, tokenInfo, lpPosition, allowanceOf } = await import('../js/dex/pool-data.js');
const { BEAR_PAIR_ABI, BEAR_TOKEN_ABI } = await import('../js/dex/bear-source.js');

const state = await import('../js/state.js');
state.set('networkId', 'sepolia');
state.set('network', { id: 'sepolia', chainId: 11155111 });

const PAIR = '0x9999999999999999999999999999999999999999';
const TOKEN = '0x1111111111111111111111111111111111111111';
const QUOTE = '0x8847346f20aCe5bd4619B7fbF3467D001E269fE9';
const OWNER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const E18 = 10n ** 18n;

// A provider that answers eth_call by ABI selector from a per-contract handler
// map, so the module is exercised through the real ABI, not a mock of itself.
function mkStub(map, { fail = [] } = {}) {
  const iface = new E.Interface([...BEAR_PAIR_ABI, ...BEAR_TOKEN_ABI]);
  const norm = {};
  for (const [k, v] of Object.entries(map)) norm[k.toLowerCase()] = v;
  const calls = [];
  return {
    calls,
    async call({ to, data }) {
      const sel = String(data).slice(0, 10);
      const key = String(to).toLowerCase();
      calls.push({ to: key, sel });
      const frag = iface.getFunction(sel);
      const h = norm[key];
      const fn = h ? h[frag.name] : undefined;
      // `undefined` means missing. 0n / 0 / '' are ANSWERS, not absences —
      // a zero lockedUntil is a real chain answer.
      if (fn === undefined || fail.includes(frag.name)) throw new Error('CALL_EXCEPTION: reverted 0x');
      const val = typeof fn === 'function' ? fn() : fn;
      return E.AbiCoder.defaultAbiCoder().encode(frag.outputs.map((o) => o.type), Array.isArray(val) ? val : [val]);
    },
  };
}
const use = (p) => state.set('provider', p);

test('poolState: reserves come back in the CONTRACT order (quote first), supply is the pair\'s own ERC-20', async () => {
  use(mkStub({
    [PAIR]: { quote: QUOTE, token: TOKEN, reserves: [500n * E18, 800_000n * E18], totalSupply: 20_000n * E18 },
  }));
  const s = await poolState(PAIR);
  assert.equal(s.ok, true);
  assert.equal(String(s.quote).toLowerCase(), QUOTE.toLowerCase());
  assert.equal(String(s.token).toLowerCase(), TOKEN.toLowerCase());
  assert.equal(s.quoteReserve, 500n * E18, 'first return value is the quote reserve — swapping it would misprice every trade');
  assert.equal(s.tokenReserve, 800_000n * E18);
  assert.equal(s.supply, 20_000n * E18);
});

test('an unreadable pool says so — it never renders as a zero pool', async () => {
  use(mkStub({})); // no handler: every call reverts
  const s = await poolState(PAIR);
  assert.equal(s.ok, false);
  assert.match(String(s.reason), /CALL_EXCEPTION/);

  const bad = await poolState('not-an-address');
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'bad address');

  state.set('provider', null);
  const noP = await poolState(PAIR);
  assert.equal(noP.ok, false);
  assert.equal(noP.reason, 'no provider');
  use(mkStub({}));
});

test('tokenInfo reads decimals from the contract, and balance only when there is an owner', async () => {
  use(mkStub({
    [TOKEN]: { name: 'Bear Moon', symbol: 'BMOON', decimals: 18, balanceOf: 42n * E18 },
  }));
  const t = await tokenInfo(TOKEN, OWNER);
  assert.equal(t.ok, true);
  assert.equal(t.name, 'Bear Moon');
  assert.equal(t.symbol, 'BMOON');
  assert.equal(t.decimals, 18, 'decimals are read, never assumed — the quote coins may not be 18');
  assert.equal(t.balance, 42n * E18);

  const noOwner = await tokenInfo(TOKEN);
  assert.equal(noOwner.ok, true);
  assert.equal(noOwner.balance, 0n, 'no owner = nothing to report as theirs');

  const badOwner = await tokenInfo(TOKEN, 'nope');
  assert.equal(badOwner.balance, 0n, 'a garbage owner is not an address to ask about');
});

test('lpPosition: shares are balanceOf, and what they are worth is floored like removeLiquidity pays', async () => {
  use(mkStub({
    [PAIR]: {
      balanceOf: 1000n,
      lockedUntil: 1_893_456_000n,
      reserves: [500n, 800_000n],
      totalSupply: 2000n,
    },
  }));
  const pos = await lpPosition(PAIR, OWNER);
  assert.equal(pos.ok, true);
  assert.equal(pos.shares, 1000n);
  assert.equal(pos.lockedUntil, 1_893_456_000n, 'the lock is asked of the chain, not remembered from the form');
  assert.equal(pos.quoteShare, 250n, '1000/2000 of 500');
  assert.equal(pos.tokenShare, 400_000n);

  // Floor, not round: 1 of 3 shares of 10 quote is 3, because the contract
  // pays floor and a display that rounded up would promise a wei it won't send.
  use(mkStub({
    [PAIR]: { balanceOf: 1n, lockedUntil: 0n, reserves: [10n, 10n], totalSupply: 3n },
  }));
  const dust = await lpPosition(PAIR, OWNER);
  assert.equal(dust.quoteShare, 3n);

  // A wallet with no shares reports zero, and is not an error.
  use(mkStub({
    [PAIR]: { balanceOf: 0n, lockedUntil: 0n, reserves: [10n, 10n], totalSupply: 3n },
  }));
  const none = await lpPosition(PAIR, OWNER);
  assert.equal(none.ok, true);
  assert.equal(none.shares, 0n);
  assert.equal(none.quoteShare, 0n);

  const noOwner = await lpPosition(PAIR, '');
  assert.equal(noOwner.ok, false);
  assert.equal(noOwner.reason, 'no owner');
});

test('allowanceOf answers the approve-or-not question the swap flow asks', async () => {
  use(mkStub({ [QUOTE]: { allowance: 123n } }));
  const a = await allowanceOf(QUOTE, OWNER, PAIR);
  assert.equal(a.ok, true);
  assert.equal(a.allowance, 123n);

  const bad = await allowanceOf(QUOTE, 'nope', PAIR);
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'bad address');
});
