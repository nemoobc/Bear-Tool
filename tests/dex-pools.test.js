// Bear Tool — tests/dex-pools.test.js
// M4: pool discovery + the liquidity math. The previews must be byte-parity
// with BearPair's own rules (Newton sqrt on the seeded exit, MIN of the two
// ratio floors after), the encoders must round-trip, the scan must decode the
// factory's Launched events in chain order, and the launcher's factory memory
// must be chain-scoped. Assertions call the real modules the app calls —
// no source-text regexes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers as realEthers } from 'ethers';

// ── harness ────────────────────────────────────────────────────────────
// `ethers` goes on globalThis BEFORE the dex modules import (app doctrine):
// Interface stays REAL — tests/dex-abi.test.js already pins it to the
// compiler — while Contract collapses to an in-memory read table.

const FAC = '0x' + 'c1'.repeat(20);
const FAKEQ = '0x' + 'aa'.repeat(20);
const TOKA = '0x' + '01'.repeat(20);
const PAIRA = '0x' + '02'.repeat(20);

// reads: addr → { method: value }. A Proxy turns every unknown property into
// an async read; methods not in the table throw, so a call into a stub the
// scenario never wired is a loud failure, not a lie.
const READS = new Map();

class FakeContract {
  constructor(addr) {
    const addrL = String(addr).toLowerCase();
    this.address = addrL;
    return new Proxy(this, {
      get: (target, prop) => {
        if (prop in target) return target[prop];
        if (prop === 'filters') return { Launched: () => ({ topic: 'LAUNCHED' }) };
        return (...args) => {
          const val = READS.get(addrL)?.[prop];
          if (val === undefined) throw new Error(`fake-chain: no read for ${addrL}.${String(prop)}`);
          return typeof val === 'function' ? val(...args) : Promise.resolve(val);
        };
      },
    });
  }
}

// a plain copy: module namespaces resist property writes even on Object.create
const fakeEthers = Object.assign({}, realEthers, { Contract: FakeContract });
globalThis.ethers = fakeEthers;

const { BEAR_FACTORY_ABI, BEAR_PAIR_ABI } = await import('../js/dex/abi.js');
const { slippageMinOut } = await import('../js/dex/swap.js');
const p = await import('../js/dex/pools.js');

// ── T1 the address gate fires before any chain contact ────────────────
test('factoryContract: a malformed address throws before any RPC', () => {
  assert.throws(() => p.factoryContract('not-an-address', { getCode: async () => '0x6080' }), (e) => e.why === 'bad');
  assert.throws(() => p.factoryContract('0x1234', {}), (e) => e.why === 'bad');
});

// ── T2 scan: Launched events decode in chain order, numbers plain ─────
test('scanFactory decodes Launched rows in chain order with plain numbers', async () => {
  const evIface = new realEthers.Interface(BEAR_FACTORY_ABI);
  const ev = evIface.encodeEventLog(evIface.getEvent('Launched'),
    [TOKA, PAIRA, FAC, 45n, 1893456000n, 10n ** 21n]);

  READS.clear();
  READS.set(FAC.toLowerCase(), {
    quote: FAKEQ,
    queryFilter: async () => [{ topics: ev.topics, data: ev.data }],
  });

  const got = await p.scanFactory({ getCode: async () => '0x6080' }, FAC);
  assert.equal(got.factory, FAC.toLowerCase());
  assert.equal(got.quote, FAKEQ.toLowerCase());
  assert.equal(got.pools.length, 1);
  const row = got.pools[0];
  assert.equal(row.token, TOKA.toLowerCase());
  assert.equal(row.pair, PAIRA.toLowerCase());
  assert.equal(row.creatorFeeBps, 45);
  assert.equal(row.lockUntil, 1893456000);
  assert.equal(row.lpShares, 10n ** 21n);

  // an address without code is named plainly, never played factory
  await assert.rejects(
    () => p.scanFactory({ getCode: async () => '0x' }, FAC),
    (e) => e.why === 'contract',
  );
});

// ── T3 the seeded exit: Newton loop parity, no drift from the contract ─
test('sqrt: floors every big int; lopsided adds never mint on the seed side', () => {
  assert.equal(p.sqrt(0n), 0n);
  assert.equal(p.sqrt(10n ** 18n), 10n ** 9n);
  assert.equal(p.sqrt(2n), 1n);
  for (const x of [3n, 8n, 15n, 24n, 999n, 2500n, 99981n,
    10n ** 34n + 7n, 5n ** 40n + 123n]) {
    const r = p.sqrt(x);
    assert.ok(r * r <= x && (r + 1n) * (r + 1n) > x, `sqrt must floor ${x}`);
  }
});

// ── T4 add preview: seeded sqrt mint + MIN of the two ratio floors ────
test('lpPreviewAdd: sqrt-law seed, then MIN of the ratio floors (never round up)', () => {
  const seed = { reserves: [0n, 0n], totalSupply: 0n };
  // sqrt((0+1000)*(0+8000)) = sqrt(8_000_000) = 2828 (floor)
  const seedRes = p.lpPreviewAdd(seed, 1000n, 8000n);
  assert.equal(seedRes.made, 2828n);
  assert.equal(seedRes.lopsided, false);

  const st = { reserves: [2000n, 8000n], totalSupply: 1000n };
  // mQ = 100*1000/2000 = 50 ; mT = 100*1000/8000 = 12 → made 12, lopsided
  const res = p.lpPreviewAdd(st, 100n, 100n);
  assert.equal(res.made, 12n);
  assert.equal(res.lopsided, true, 'the slack leg sits >0.01% above the mint');
  // the user's floor band applies on top, same helper as the trade sheet
  assert.equal(slippageMinOut(res.made, 100), 11n, '1% band floors the mint');

  // a 1-wei floor cut on a deep pool is NOT lopsided — no crying wolf
  const deep = p.lpPreviewAdd({ reserves: [10n ** 18n, 10n ** 18n], totalSupply: 10n ** 18n },
    10n ** 18n + 1n, 10n ** 18n);
  assert.equal(deep.made, 10n ** 18n);
  assert.equal(deep.lopsided, false, 'one wei on 10^18 may never cry wolf');

  const zero = p.lpPreviewAdd(st, 0n, 5n);
  assert.equal(zero.made, 0n);
  assert.equal(zero.why, 'zero');
});

// ── T5 remove preview: proportional floors, always ────────────────────
test('lpPreviewRemove pays r*sup/sup floors, and never more than the pool', () => {
  const st = { reserves: [5000n, 8000n], totalSupply: 1000n };
  const out = p.lpPreviewRemove(st, 250n);
  assert.equal(out.outQuote, 1250n);
  assert.equal(out.outToken, 2000n);
  const rest = p.lpPreviewRemove(st, 1000n);
  assert.equal(rest.outQuote, 5000n);
  assert.equal(rest.outToken, 8000n);
  const zero = p.lpPreviewRemove(st, 0n);
  assert.equal(zero.why, 'zero');
});

// ── T6 the encoders round-trip through the shipped (compiler-pinned) ABI ─
test('addLiqData/removeLiqData encode and decode to the exact numbers sent', () => {
  const iface = new ethers.Interface(BEAR_PAIR_ABI);
  const addB = p.addLiqData(123n, 456n, 789n);
  const [q, t, min] = iface.decodeFunctionData('addLiquidity', addB);
  assert.deepEqual([q, t, min], [123n, 456n, 789n]);

  const rmB = p.removeLiqData(10n ** 21n, 11n, 22n);
  const [shares, minQ, minT] = iface.decodeFunctionData('removeLiquidity', rmB);
  assert.deepEqual([shares, minQ, minT], [10n ** 21n, 11n, 22n]);
});

// ── T7 the launcher's factory memory is chain-scoped ──────────────────
test('factoryRemember/Recall per chainId, Forget clears one chain only', () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  try {
    p.factoryRemember(11155111, FAC);
    p.factoryRemember(31337, '0x' + '99'.repeat(20));
    assert.equal(p.factoryRecall(11155111), FAC.toLowerCase());
    assert.equal(p.factoryRecall(31337), '0x' + '99'.repeat(20));
    p.factoryForget(11155111);
    assert.equal(p.factoryRecall(11155111), '');
    assert.equal(p.factoryRecall(31337), '0x' + '99'.repeat(20));
  } finally {
    delete globalThis.localStorage;
  }
});
