// Bear Tool — tests/dex-holders.test.js
//
// The holder card is the ONE place in the Dex that dares to show who owns a
// coin — and an ERC-20 has no holder list at all. Every balance on screen is a
// sum of Transfer logs the scan actually read. Which makes the honest failure
// modes the whole point of this file:
//
//   • a partial window must NEVER render as balances (the numbers would be
//     simply wrong — a missed credit reads as "this whale holds less")
//   • a node that pruned the history must say so, not show a guess
//   • a chunk the node refuses for its size must retry smaller, not give up
//   • the scan must resume across passes and still land exactly on supply
//
// So these tests drive the driver with stub nodes in those exact states, and
// hand-compute the sums the way the contract's own mint rules would.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { ethers } from 'ethers';

// A DOM from the start: token-page.js and core.js read localStorage at load,
// exactly like every other Dex test that mounts a page.
const dom = new JSDOM('<!doctype html><html><body><div id="tpHost"></div></body></html>', { url: 'http://localhost/' });
const { window } = dom;
for (const key of ['window', 'document', 'localStorage', 'navigator', 'location',
  'HTMLElement', 'Node', 'CustomEvent', 'Event', 'getComputedStyle']) {
  try { Object.defineProperty(globalThis, key, { value: window[key] ?? window, configurable: true, writable: true }); } catch { /* getter-only global */ }
}

const H = await import('../js/dex/holders.js');
const { tokenPageHtml } = await import('../js/dex/token-page.js');
const { t } = await import('../js/i18n.js');

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const E = ethers; // has everything a reader needs: id, getAddress, AbiCoder

const CREATOR = '0x1111111111111111111111111111111111111111';
const TRADER = '0x2222222222222222222222222222222222222222';
const POOL = '0x9999999999999999999999999999999999999999';

const transferLog = ({ from, to, value }, block = 1) => ({
  blockNumber: block,
  topics: [
    E.id('Transfer(address,address,uint256)'),
    E.zeroPadValue(from, 32),
    E.zeroPadValue(to, 32),
  ],
  data: E.AbiCoder.defaultAbiCoder().encode(['uint256'], [value]),
});

const swapLog = ({ quoteIn, amountIn, amountOut }, block = 1) => ({
  blockNumber: block,
  topics: [E.id('Swap(address,bool,uint256,uint256)'), E.zeroPadValue(TRADER, 32)],
  data: E.AbiCoder.defaultAbiCoder().encode(['bool', 'uint256', 'uint256'], [quoteIn, amountIn, amountOut]),
});

const memCache = () => {
  const store = new Map();
  return { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), _store: store };
};

// ── folding raw logs into balances ───────────────────────────────────

test('a mint plus transfers fold into exact balances and a detected mint', () => {
  const logs = [
    transferLog({ from: H.ZERO_ADDR, to: CREATOR, value: 1000n }, 5),
    transferLog({ from: CREATOR, to: TRADER, value: 300n }, 500),
    transferLog({ from: TRADER, to: POOL, value: 100n }, 9000),
  ];
  const r = H.aggregateTransfers(E, logs);
  assert.equal(r.mintSeen, true, 'the 0x0 sender IS the mint — that is the completeness evidence');
  assert.equal(r.mintSum, 1000n);
  assert.equal(r.bad, 0);
  assert.equal(r.balances.get(CREATOR.toLowerCase()), 700n);
  assert.equal(r.balances.get(TRADER.toLowerCase()), 200n);
  assert.equal(r.balances.get(POOL.toLowerCase()), 100n);
  assert.equal(H.sumOf(r.balances), 1000n);
});

test('self-transfers and zero-value transfers move nothing', () => {
  const b = new Map();
  H.applyTransfer(b, CREATOR, CREATOR, 5n);
  H.applyTransfer(b, CREATOR, TRADER, 0n);
  assert.equal(H.sumOf(b), 0n, 'a self-transfer is +v and −v on the same pocket');
  assert.equal(b.get(TRADER.toLowerCase()), 0n);
});

test('an unreadable log is counted as bad — never silently skipped', () => {
  const r = H.aggregateTransfers(E, [{ topics: ['0xdead'], data: '0x00' }]);
  assert.equal(r.bad, 1, 'skipping it would print balances that are quietly wrong');
});

// ── the visible list ─────────────────────────────────────────────────

test('holder rows: biggest first, pool and zero-pockets dropped, count true', () => {
  const b = new Map([
    [CREATOR.toLowerCase(), 700n],
    [TRADER.toLowerCase(), 200n],
    [POOL.toLowerCase(), 100n],
    ['0x3333333333333333333333333333333333333333', 0n],
  ]);
  const { rows, count } = H.holderRows(b, 1000n, { exclude: [POOL], limit: 50 });
  assert.equal(count, 2, 'the pool is liquidity, not a holder — and zero is not either');
  assert.deepEqual(rows.map((r) => [r.addr, r.amount, r.pctBps]), [
    [CREATOR.toLowerCase(), 700n, 7000],
    [TRADER.toLowerCase(), 200n, 2000],
  ]);
  assert.equal(H.topShareBps(b, 1000n, { top: 10, exclude: [POOL] }), 9000, 'top-10 share in bps');
});

test('the completeness gate: mint + readable + no negatives + exact sum', () => {
  const whole = { balances: new Map([[CREATOR.toLowerCase(), 1000n]]), mintSeen: true, bad: 0, supply: 1000n };
  assert.equal(H.isComplete(whole), true, 'this is the ONLY shape a list may render from');
  assert.equal(H.isComplete({ ...whole, mintSeen: false }), false, 'no mint seen = window may miss history');
  assert.equal(H.isComplete({ ...whole, bad: 1 }), false, 'an unreadable log poisons every sum');
  assert.equal(H.isComplete({ ...whole, supply: 1001n }), false, 'sums must land EXACTLY on supply');
  const pocket = new Map([[CREATOR.toLowerCase(), -1n], [TRADER.toLowerCase(), 1001n]]);
  assert.equal(H.isComplete({ balances: pocket, mintSeen: true, bad: 0, supply: 1000n }), false,
    'a negative pocket proves the window missed an earlier credit');
});

// ── the scan driver over stub nodes ──────────────────────────────────

/** A node that serves the whole chain, one honest range at a time. */
function stubNode(logs, latest) {
  const asked = [];
  return {
    asked,
    getBlockNumber: async () => latest,
    getLogs: async ({ fromBlock, toBlock }) => {
      asked.push([fromBlock, toBlock]);
      return logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
    },
  };
}

const CHAIN = [
  transferLog({ from: H.ZERO_ADDR, to: CREATOR, value: 1000n }, 5),
  transferLog({ from: CREATOR, to: TRADER, value: 400n }, 500),
  transferLog({ from: TRADER, to: POOL, value: 100n }, 9000),
];

test('scan walks backward, resumes from cache, and completes exactly on supply', async () => {
  const node = stubNode(CHAIN, 12000);
  const cache = memCache();
  const token = '0xtok';
  // Pass one: newest chunk only — the mint is out of reach, so the scan must
  // NOT claim completion yet.
  const first = await H.scanHolders({ E, provider: node, token, chunk: 9000, passes: 1, cache, supply: 1000n });
  assert.equal(first.done, false, 'one chunk is not the history');
  assert.equal(first.mintSeen, false);
  assert.equal(first.low, 3000);
  // The partial map is signed: the newest transfer's sender shows a NEGATIVE
  // pocket because his credit lies deeper — the signal resume math must keep.
  assert.equal(first.balances.get(TRADER.toLowerCase()), -100n);
  assert.ok(cache.getItem(H.holderCacheKey(token)), 'progress must be saved after every chunk');

  // Pass two resumes — same provider, same cache: mint found, sums land on
  // supply, and ONLY now is done true.
  const second = await H.scanHolders({ E, provider: node, token, chunk: 9000, passes: 12, cache, supply: 1000n });
  assert.equal(second.done, true);
  assert.equal(second.mintSeen, true);
  assert.equal(second.balances.get(CREATOR.toLowerCase()), 600n);
  assert.equal(second.balances.get(TRADER.toLowerCase()), 300n);
  assert.equal(second.balances.get(POOL.toLowerCase()), 100n);
  assert.equal(H.sumOf(second.balances), 1000n);
  assert.equal(second.low, 0);
});

test('done stays false when supply is unreadable — no list without the check', async () => {
  const node = stubNode(CHAIN, 12000);
  const r = await H.scanHolders({ E, provider: node, token: '0xtok2', chunk: 9000, passes: 12, cache: memCache(), supply: null });
  assert.equal(r.mintSeen, true, 'the scan itself finished…');
  assert.equal(r.done, false, '…but without supply there is no verification, so no list');
});

test('a pruned node is said out loud, never guessed around', async () => {
  const cache = memCache();
  const node = {
    getBlockNumber: async () => 12000,
    getLogs: async () => {
      const e = new Error('could not coalesce error');
      e.info = { error: { code: 4444, message: 'pruned history unavailable' } };
      throw e;
    },
  };
  const r = await H.scanHolders({ E, provider: node, token: '0xtok3', chunk: 9000, passes: 12, cache, supply: 1000n });
  assert.equal(r.pruned, true);
  assert.equal(r.done, false);
  assert.equal(r.ok, false);
  assert.ok(r.reason, 'the reason rides along for the card to show');
  assert.equal(H.isPrunedError({ info: { error: { code: 4444 } } }), true);
  assert.equal(H.isPrunedError({ shortMessage: 'pruned history unavailable' }), true);
  assert.equal(H.isPrunedError(new Error('range too wide')), false, 'a range cap is not a prune');
});

test('a node that caps ranges tighter gets a smaller chunk, not a dead scan', async () => {
  const seen = [];
  const node = {
    getBlockNumber: async () => 12000,
    getLogs: async ({ fromBlock, toBlock }) => {
      seen.push(toBlock - fromBlock);
      if (toBlock - fromBlock > 3000) throw new Error('range too wide');
      return [transferLog({ from: H.ZERO_ADDR, to: CREATOR, value: 1000n }, 6000),
        transferLog({ from: CREATOR, to: TRADER, value: 500n }, 8000)]
        .filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
    },
  };
  const r = await H.scanHolders({ E, provider: node, token: '0xtok4', chunk: 9000, passes: 12, cache: memCache(), supply: 1000n });
  assert.equal(r.done, true, 'the shrink-retry path must still land complete');
  assert.ok(seen.some((s) => s <= 3000), 'the node must have been asked within its own cap');
});

test('a corrupt cache is no cache: the scan starts over instead of trusting junk', async () => {
  const cache = memCache();
  const token = '0xtok5';
  cache.setItem(H.holderCacheKey(token), '{not json');
  const node = stubNode(CHAIN, 12000);
  const r = await H.scanHolders({ E, provider: node, token, chunk: 9000, passes: 12, cache, supply: 1000n });
  assert.equal(r.done, true, 'junk in storage must not poison the numbers');
});

test('chunkedGetLogs quits as soon as a sparse lookup has what it came for', async () => {
  let calls = 0;
  const logs = await H.chunkedGetLogs({
    getLogs: async (lo, hi) => { calls += 1; return [{ blockNumber: hi }]; },
    fromBlock: 0,
    toBlock: 90000,
    chunk: 9000,
    stopAfter: 1,
  });
  assert.equal(calls, 1, '54k blocks of sparse lookup must not cost six queries');
  assert.equal(logs.length, 1);
});

// ── the last day of trades ───────────────────────────────────────────

test('pool24h counts quote volume both ways — buy reads amountIn, sell reads amountOut', async () => {
  const node = stubNode([
    swapLog({ quoteIn: true, amountIn: 100n, amountOut: 5000n }, 100),   // buy: 100 quote in
    swapLog({ quoteIn: false, amountIn: 5000n, amountOut: 60n }, 200),   // sell: 60 quote out
  ], 1000);
  const r = await H.pool24h({ E, provider: node, pair: '0xpair', blocks: 7200 });
  assert.equal(r.ok, true);
  assert.equal(r.trades, 2);
  assert.equal(r.volQuote, 160n, 'the wrong side would print 5100 or 5000 here');
});

test('pool24h failure is `ok:false` with a reason — never a silent zero', async () => {
  const node = { getBlockNumber: async () => 1000, getLogs: async () => { throw new Error('boom'); } };
  const r = await H.pool24h({ E, provider: node, pair: '0xpair' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /boom/);
});

// ── the page: ids, honest copy, and the render gate ──────────────────

test('the token page carries the holder card ids the runtime probes for', () => {
  const html = tokenPageHtml();
  for (const id of ['dexTpStats', 'dexTpHoldersLock', 'dexTpHoldersNote', 'dexTpHoldersList', 'dexTpHoldersMore']) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  }
  assert.ok(html.includes('id="dexTpHoldersMore" hidden'), 'the action button starts hidden');
});

test('the holder copy renders its placeholders in both languages', () => {
  const sum = t('dex.hold.summary', { n: '7', pct: '91.0' });
  assert.ok(sum.includes('7') && sum.includes('91.0') && !sum.includes('{{'), `unfilled summary: ${sum}`);
  const lock = t('dex.hold.lockUntil', { date: '2026-11-01' });
  assert.ok(lock.includes('2026-11-01') && !lock.includes('{{'), `unfilled lock line: ${lock}`);
  assert.notEqual(t('dex.hold.pruned'), 'dex.hold.pruned', 'the honest-prune copy must exist');
});

test('the render gate is pinned: balances only exist inside the done branch', () => {
  const src = read('../js/dex/token-page.js');
  const gate = src.indexOf('if (scan.done) {');
  const paint = src.indexOf('holdList.innerHTML');
  assert.ok(gate !== -1 && paint !== -1 && gate < paint,
    'a partial scan must never reach holdList.innerHTML — the wrong-number lie lives exactly here');
  for (const branch of ['scan.pruned', 'scan.reason', 'scan.mintSeen']) {
    assert.ok(src.includes(branch), `the honest state ${branch} must stay wired`);
  }
});
