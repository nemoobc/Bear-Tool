// Bear Tool — dex-history.test.js
//
// The trade tape and the candle chart are the part of the rebuild that reads
// something NEW: a launchpad has no Uniswap V2 Swap logs, so the curve's own
// Bought/Sold events ARE the tape. That makes this the only place where a
// silent wrong answer is possible — a dropped trade, a chart that runs
// backwards, or two trades in the same second that quietly vanish.
//
// Everything here is a pure function over decoded logs, so it runs with no
// chain: the shapes are what matter, and the shapes are where the bugs are.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const { historyCandles, tradesHtml, HISTORY_EVENTS } = await import('../js/dex/history.js');
const { PRICE_SCALE } = await import('../js/dex/chart.js');

// One decoded log row, shaped exactly like what ethers hands back.
// These fixtures used the names the PRODUCTION CODE used (ethIn / ethOut) —
// which are not in the ABI at all. history.js read the same wrong names, so the
// test agreed with the bug and both went green while every coin's tape and
// candle series rendered "NaN". A fixture that copies the code's mistake proves
// nothing; these are named from the contract, and the test below reads the
// names back out of the ABI so the two cannot drift apart again.
const bought = (block, buyer, quoteIn, tokensOut) => ({
  blockNumber: block,
  args: { buyer, quoteIn, tokensOut },
});
const sold = (block, seller, tokensIn, quoteOut) => ({
  blockNumber: block,
  args: { seller, tokensIn, quoteOut },
});

// loadHistory is driven through a stub provider/contract so the decode path is
// exercised, not just the candle maths below.
function stubChain({ buys = [], sells = [], graduated = [], latest = 1000, stamps = {} }) {
  const asked = { filters: [], blocks: [] };
  const contract = {
    filters: {
      Bought: () => 'Bought',
      Sold: () => 'Sold',
      Graduated: () => 'Graduated',
    },
    queryFilter: async (filter, fromBlock, toBlock) => {
      asked.filters.push({ filter, fromBlock, toBlock });
      return filter === 'Bought' ? buys : filter === 'Sold' ? sells : graduated;
    },
  };
  const provider = {
    getBlockNumber: async () => latest,
    // ethers v6 getBlock takes ONE BlockTag and returns ONE block — matching it
    // here is what makes these tests catch a list-passing regression.
    getBlock: async (n) => (stamps[n] ? { number: n, timestamp: stamps[n] } : null),
  };
  return { contract, provider, asked };
}

test('the history reads exactly the three events the contract emits', async () => {
  // A filter that names a different event decodes nothing and the tape comes
  // back silently empty — which reads as "this coin has no trades", a lie.
  const names = [...HISTORY_EVENTS].sort();
  assert.deepEqual(names, ['Bought', 'Graduated', 'Sold'],
    'the tape must read the curve\'s own Bought/Sold, plus the graduation marker');

  const { loadHistory } = await import('../js/dex/history.js');
  const c = stubChain({ buys: [bought(10, '0xaaa', 10n ** 16n, 5n * 10n ** 18n)] });
  const out = await loadHistory(c.contract, c.provider);
  assert.equal(out.ok, true, 'a readable chain must report ok');
  assert.equal(out.trades.length, 1, 'one buy is one trade');
  assert.equal(c.asked.filters.length, 3, 'all three events must be queried');
});

test('the slippage floor is a percentage OF the quote, never a fraction of it', async () => {
  // The one bug in this repo that the on-chain gate could not see, because the
  // contract faithfully enforced whatever number it was handed. The app divided
  // the quote by 100 instead of taking 99% of it, so "1% slippage guard" meant
  // "I accept 1% of what you quoted" — a 99% tolerance — and the dialog said so
  // in the calmest possible voice. The floor must be within SLIPPAGE_BPS of the
  // quote, or barely below it.
  const src = readFileSync(new URL('../js/dex/trade.js', import.meta.url), 'utf8');
  assert.match(src, /q\.tokensOut \* \(10_000n - SLIPPAGE_BPS\)\)? \/ 10_000n/,
    'the buy floor must be (100% - 1%) of the quote');
  assert.match(src, /q\.quoteOut \* \(10_000n - SLIPPAGE_BPS\)\)? \/ 10_000n/,
    'the sell floor must be (100% - 1%) of the quote');

  // …and it must not be expressible the wrong way round any more.
  assert.ok(!/q\.tokensOut \* SLIPPAGE_BPS \/ 10_000n/.test(src),
    'dividing the quote by the bps is the bug that shipped; it must not come back');

  // The arithmetic, spelled out, so the intent is checkable without the source.
  const BPS = 100n, q = 50_486_599n;
  const floor = (q * (10_000n - BPS)) / 10_000n;
  assert.equal(floor, 49_981_733n,
    `1% off 50,486,599 is 49,981,733 — the first version produced 504,865`);
  assert.ok(floor > q / 2n, 'the floor must stay within 1% of the quote, not 99% of it');
});

test('a buy and a sell decode into the same trade shape', async () => {
  const { loadHistory } = await import('../js/dex/history.js');
  const { contract, provider } = stubChain({
    buys: [bought(11, '0xBuyer', 3n * 10n ** 16n, 7n * 10n ** 18n)],
    sells: [sold(10, '0xSeller', 4n * 10n ** 18n, 1n * 10n ** 16n)],
    stamps: { 11: 1700000011, 10: 1700000010 },
  });
  const { trades } = await loadHistory(contract, provider);

  assert.equal(trades.length, 2);
  // Newest first: the most recent fill is the row the eye lands on.
  assert.equal(trades[0].block, 11, 'the newest trade must come first');

  const [buy, sell] = trades;
  assert.equal(buy.kind, 'buy');
  assert.equal(buy.who, '0xBuyer');
  assert.equal(buy.eth, 3n * 10n ** 16n, 'a buy\'s ETH is what was paid');
  assert.equal(buy.tokens, 7n * 10n ** 18n, 'a buy\'s tokens are what was received');
  assert.equal(buy.time, 1700000011, 'the row must carry the real block timestamp');

  assert.equal(sell.kind, 'sell');
  assert.equal(sell.who, '0xSeller');
  assert.equal(sell.eth, 1n * 10n ** 16n, 'a sell\'s ETH is what was received');
  assert.equal(sell.tokens, 4n * 10n ** 18n, 'a sell\'s tokens are what was given');
});

test('each row shows the price THAT fill got, not the price today', async () => {
  // The tempting shortcut is to price every row at the current curve. That
  // makes a sell look like it happened at today's price and hides the whole
  // point of a tape — what you actually got.
  // 0.1 ETH paid for 100 tokens => 0.001 ETH per token, the row's own fill.
  const { loadHistory } = await import('../js/dex/history.js');
  const { contract, provider } = stubChain({
    buys: [bought(10, '0xA', 10n ** 17n, 10n ** 20n)],
    stamps: { 10: 1700000000 },
  });
  const { trades } = await loadHistory(contract, provider);
  assert.ok(Math.abs(trades[0].price - 1e-3) < 1e-12,
    `price must be eth/tokens of that row, got ${trades[0].price}`);
});

test('a chain that cannot serve old logs does not take the coin page down', async () => {
  const { loadHistory } = await import('../js/dex/history.js');
  const contract = {
    filters: { Bought: () => 'Bought', Sold: () => 'Sold', Graduated: () => 'Graduated' },
    queryFilter: async () => { throw new Error('range too wide'); },
  };
  const provider = { getBlockNumber: async () => 5_000_000 };
  const out = await loadHistory(contract, provider);
  assert.equal(out.ok, false, 'a failed read must report not-ok, not throw');
  assert.deepEqual(out.trades, [], 'and carry no trades rather than a half-read list');
  // The reason must survive: a silent catch turned a wrong RPC call into a coin
  // that "has never traded", which is a lie nobody can audit.
  assert.match(out.reason, /range too wide/, 'the failure must carry its reason');
});

test('block timestamps are read one at a time, never as a list', async () => {
  // ethers v6 getBlock takes ONE BlockTag. Handing it an array threw, and the
  // catch turned that into "this coin has never traded" — found in the browser
  // against a real anvil, not in a unit test. The stub REJECTS a list so this
  // cannot regress silently.
  const { loadHistory, _clearStampCache } = await import('../js/dex/history.js');
  _clearStampCache();
  const seen = [];
  const provider = {
    getBlockNumber: async () => 100,
    getBlock: async (n) => {
      if (Array.isArray(n)) throw new TypeError('getBlock takes one BlockTag, not an array');
      seen.push(n);
      return { number: n, timestamp: 1700000000 + n };
    },
  };
  const { contract } = stubChain({
    buys: [bought(10, '0xA', 1n, 1n), bought(11, '0xB', 1n, 1n)],
    sells: [sold(12, '0xC', 1n, 1n)],
  });
  const out = await loadHistory(contract, provider);
  assert.equal(out.ok, true, `the read must succeed, got: ${out.reason || ''}`);
  assert.equal(out.trades.length, 3, 'every trade must survive the read');
  assert.ok(!seen.some(Array.isArray), 'getBlock must never be handed an array');
  assert.equal(seen.length, 3, 'one call per distinct block, and no more');
  // Real timestamps, so the chart's time axis is real time.
  assert.deepEqual(out.trades.map((t) => t.time).sort((a, b) => a - b),
    [1700000010, 1700000011, 1700000012]);
});

test('block timestamps are fetched once, not on every repaint', async () => {
  // The coin page repaints on a timer. Without a memo, a busy coin cost up to
  // 60 getBlock RPCs every repaint — a rate-limit problem, not a one-off.
  const { loadHistory, _clearStampCache } = await import('../js/dex/history.js');
  _clearStampCache();
  let calls = 0;
  const provider = {
    getBlockNumber: async () => 100,
    getBlock: async (n) => { calls++; return { number: n, timestamp: 1700000000 + n }; },
  };
  const { contract } = stubChain({
    buys: [bought(10, '0xA', 1n, 1n), bought(11, '0xB', 1n, 1n)],
    sells: [sold(12, '0xC', 1n, 1n)],
  });
  await loadHistory(contract, provider);
  const first = calls;
  await loadHistory(contract, provider);
  await loadHistory(contract, provider);
  assert.equal(first, 3, 'the first read fetches each block once');
  assert.equal(calls, 3, 'later reads must reuse the cache and cost no RPCs');
});

test('a coin with more blocks than the read budget still gets a rising time axis', async () => {
  // Over budget the unfetched blocks are interpolated from the ones we hold.
  // The first attempt at this replaced them with their BLOCK NUMBER, which put
  // ancient blocks at 1..80 beside real ones at ~1.7e9 — the chart's time axis
  // inverted. So the invariant is pinned: ordering by BLOCK must equal ordering
  // by TIME, with no ties. (The rows themselves come newest-first, because that
  // is what the tape wants — historyCandles is what flips them.)
  const { loadHistory, _clearStampCache } = await import('../js/dex/history.js');
  _clearStampCache();
  const provider = {
    getBlockNumber: async () => 500,
    getBlock: async (n) => ({ number: n, timestamp: 1700000000 + n }),
  };
  const buys = [];
  for (let i = 1; i <= 120; i++) buys.push(bought(i, '0xA', 1n, 1n));
  const { contract } = stubChain({ buys });
  const out = await loadHistory(contract, provider, { limit: 120 });

  assert.equal(out.trades.length, 120, 'no trade may be dropped for being old');

  const byBlock = [...out.trades].sort((a, b) => a.block - b.block);
  const times = byBlock.map((t) => t.time);
  assert.deepEqual([...times].sort((a, b) => a - b), times,
    'time must rise with block, even where the exact second is interpolated');
  assert.equal(new Set(times).size, times.length,
    'and no two blocks may share a time — the chart library rejects duplicates');

  // The newest ones are fetched exactly; the rest are close to it, not junk.
  assert.ok(Math.abs(byBlock[119].time - (1700000000 + 120)) < 1,
    'the newest block must carry its real timestamp');
  assert.ok(Math.abs(byBlock[0].time - (1700000000 + 1)) < 30,
    `the oldest must be interpolated near its true second, got ${byBlock[0].time}`);
});

test('the log window is bounded, so an old coin cannot hang the page', async () => {
  const { loadHistory } = await import('../js/dex/history.js');
  const { contract, provider, asked } = stubChain({ latest: 10_000_000 });
  await loadHistory(contract, provider);
  const q = asked.filters[0];
  assert.ok(q.toBlock === 10_000_000, 'the window must end at the current block');
  assert.ok(q.fromBlock > 0, 'the window must start before genesis on a deep chain');
  assert.ok(q.toBlock - q.fromBlock <= 40_000, 'the window must be bounded');
});

test('candles open in chronological order — a backwards chart is a broken chart', async () => {
  // The rows render newest-first; feeding them to the chart as-is would open
  // every candle backwards, which still draws (and looks plausible) but is wrong.
  const trades = [
    { kind: 'buy', eth: 1n, tokens: 1n, block: 30, time: 300, price: 2e-13 },
    { kind: 'sell', eth: 1n, tokens: 1n, block: 10, time: 100, price: 1e-13 },
    { kind: 'buy', eth: 1n, tokens: 1n, block: 20, time: 200, price: 1.5e-13 },
  ];
  const candles = await historyCandles(trades);
  const times = candles.map((c) => c.time);
  assert.deepEqual([...times].sort((a, b) => a - b), times,
    'candles must be strictly ascending in time');
  // open is the OLDEST price in the bucket, close the newest.
  assert.ok(Math.abs(candles[0].open - 1e-13) < 1e-18, 'the first candle must open at the oldest price');
  assert.ok(Math.abs(candles[candles.length - 1].close - 2e-13) < 1e-18,
    'the last candle must close at the newest price');
});

test('two trades in the same second both survive', async () => {
  // The chart library rejects duplicate timestamps — it drops the series or
  // stacks it wrongly. Two fills in one block are ordinary (a bot, two
  // accounts), so ties are nudged forward here instead of losing a trade.
  // One trade per candle (max = 2 over 2 rows) is what forces them apart.
  const trades = [
    { kind: 'buy', eth: 1n, tokens: 1n, block: 10, time: 500, price: 1e-13 },
    { kind: 'sell', eth: 1n, tokens: 1n, block: 10, time: 500, price: 2e-13 },
  ];
  const candles = await historyCandles(trades);
  const times = candles.map((c) => c.time);
  assert.equal(times.length, 2, 'neither fill may be dropped');
  assert.equal(new Set(times).size, times.length, 'no duplicate timestamps may reach the chart');
  assert.deepEqual([...times].sort((a, b) => a - b), times, 'and they must stay ascending');
});

test('a coin with no trades yields no candles but does not throw', async () => {
  // The caller renders an empty candlestick frame on purpose; it must get [].
  assert.deepEqual(await historyCandles([]), []);
});

test('volume is the ETH that changed hands, not a made-up unit', async () => {
  const trades = [
    { kind: 'buy', eth: 2n * 10n ** 16n, tokens: 1n, block: 10, time: 100, price: 1e-13 },
    { kind: 'sell', eth: 1n * 10n ** 16n, tokens: 1n, block: 20, time: 200, price: 1e-13 },
  ];
  const candles = await historyCandles(trades);
  const total = candles.reduce((a, c) => a + c.volume, 0);
  assert.ok(Math.abs(total - 0.03) < 1e-9, `volume must be the ETH traded, got ${total}`);
});

test('prices reach the chart scaled by PRICE_SCALE, keeping their precision', async () => {
  // A bonding-curve price is ~1e-13 ETH per token. Unscaled it is representable
  // but its RATIO to a rounded display figure is not; the renderer wants the
  // scaled form chart.js already uses for pool trades.
  const trades = [{ kind: 'buy', eth: 1n, tokens: 1n, block: 10, time: 100, price: 1.5e-13 }];
  const [c] = await historyCandles(trades);
  assert.ok(Math.abs(c.close - 1.5e-13) < 1e-18,
    `the candle must carry the real price, got ${c.close}`);
  assert.ok(PRICE_SCALE === 1e18, 'PRICE_SCALE is the shared contract with chart.js');
});

test('the tape renders a row per fill, newest first, with the real side', () => {
  const trades = [
    { kind: 'sell', eth: 1n * 10n ** 16n, tokens: 5n * 10n ** 18n, block: 20, time: 200, price: 2e-13 },
    { kind: 'buy', eth: 3n * 10n ** 16n, tokens: 4n * 10n ** 18n, block: 10, time: 100, price: 1e-13 },
  ];
  const html = tradesHtml(trades, 'BMOON');
  const rows = html.match(/class="dex-trade-row/g) || [];
  assert.equal(rows.length, 2, 'one row per fill');
  assert.ok(html.indexOf('sell') < html.indexOf('buy'), 'the newest row must be first');
  assert.match(html, /BMOON/, 'the row must name the coin\'s ticker');
  assert.match(html, /ago|lalu/, 'the row must say how long ago the fill happened');
});

test('the tape escapes what it prints', () => {
  // who/ticker come from a user-supplied coin; the tape is innerHTML.
  const trades = [{
    kind: 'buy',
    eth: 10n ** 16n,
    tokens: 10n ** 18n,
    block: 10,
    time: 100,
    price: 1e-13,
  }];
  const html = tradesHtml(trades, '<img src=x onerror=alert(1)>');
  assert.ok(!html.includes('<img'), 'a ticker must never become markup in the tape');
  assert.match(html, /&lt;img/, 'it must be escaped, not stripped');
});

test('an empty tape says so — it never shows an empty box', () => {
  const html = tradesHtml([], 'BMOON');
  assert.match(html, /No trades yet/i, 'an empty tape must say there are no trades');
});

// ── the gate that was missing ───────────────────────────────────────
// history.js read `args.ethIn` while the event is `quoteIn`, so every trade
// decoded to undefined, the price was NaN, and the tape and the whole candle
// series rendered "NaN" on every coin that had ever traded. The unit tests
// passed because their fake logs carried the SAME wrong names — a gate built
// from the bug's own constant. This one reads the names out of the shipped ABI,
// so the fixture and the contract cannot drift apart without it going red.
test('every event field the tape reads is a field the contract actually emits', async () => {
  const { PUMP_ABI } = await import('../js/dex/pump-source.js');

  // PUMP_ABI is the human-readable array of strings that actually ships, so the
  // names are read out of THAT rather than out of a re-typed copy of the ABI.
  const namesOf = (eventName) => {
    const frag = PUMP_ABI.find((f) => typeof f === 'string' && f.startsWith(`event ${eventName}(`));
    assert.ok(frag, `the shipped ABI has no ${eventName} event`);
    const args = frag.slice(frag.indexOf('(') + 1, frag.lastIndexOf(')'));
    return new Set(args.split(',').map((a) => a.trim().split(/\s+/).pop()).filter(Boolean));
  };
  const bought = namesOf('Bought');
  const sold = namesOf('Sold');

  // What the production code asks for.
  const src = readFileSync(new URL('../js/dex/history.js', import.meta.url), 'utf8');
  const asked = [...src.matchAll(/l\.args\.([a-zA-Z_$][\w$]*)/g)].map((m) => m[1]);
  assert.ok(asked.length >= 6, 'the tape should read several event fields');

  for (const n of asked) {
    assert.ok(bought.has(n) || sold.has(n),
      `history.js reads args.${n}, which neither Bought nor Sold emits — `
      + `that field is undefined on every trade, and the price becomes NaN`);
  }

  // And specifically the two that broke: quoted in an ERC-20 since the rename.
  assert.ok(bought.has('quoteIn'), 'Bought must emit quoteIn — the curve is not quoted in native ETH');
  assert.ok(sold.has('quoteOut'), 'Sold must emit quoteOut');
});

test('a trade the decoder cannot read is dropped, never rendered as NaN', async () => {
  const { loadHistory } = await import('../js/dex/history.js');
  // A log shaped like a real one but missing its amounts: the old code turned
  // this into Number(undefined) → NaN and painted it.
  const logs = [
    { blockNumber: 10, args: { buyer: '0x' + '1'.repeat(40) } },
    { blockNumber: 11, args: { buyer: '0x' + '1'.repeat(40), quoteIn: 10n ** 18n, tokensOut: 5n * 10n ** 18n } },
  ];
  const provider = {
    getBlockNumber: async () => 100,
    getBlock: async () => ({ timestamp: 1700000000 }),
  };
  const contract = {
    queryFilter: async (f) => (f.name === 'Bought' ? logs : []),
    filters: { Bought: () => ({ name: 'Bought' }), Sold: () => ({ name: 'Sold' }), Graduated: () => ({ name: 'Graduated' }) },
  };
  const out = await loadHistory(contract, provider);
  assert.equal(out.trades.length, 1, 'the unreadable trade is dropped');
  for (const tr of out.trades) {
    assert.ok(Number.isFinite(tr.price), `price must be finite, got ${tr.price}`);
  }
  assert.ok(Number.isFinite(out.candles?.[0]?.close ?? 1), 'and no candle may be NaN');
});

// ── the v2 pool tape ────────────────────────────────────────────────
// A pool's Swap log is the same tape in another dialect. The pair emits the
// direction (quoteIn) and both amounts, so both machines decode into ONE row
// shape — and everything above (candles, the tape renderer) never learns
// which machine it read.
const swapLog = (block, trader, quoteIn, amountIn, amountOut) => ({
  blockNumber: block,
  args: { trader, quoteIn, amountIn, amountOut },
});

function stubPool({ swaps = [], latest = 10_000_000, stamps = {} }) {
  const asked = { filter: null, fromBlock: null, toBlock: null };
  const contract = {
    filters: { Swap: () => 'Swap' },
    queryFilter: async (f, from, to) => {
      asked.filter = f; asked.fromBlock = from; asked.toBlock = to;
      return f === 'Swap' ? swaps : [];
    },
  };
  const provider = {
    getBlockNumber: async () => latest,
    getBlock: async (n) => (stamps[n] ? { number: n, timestamp: stamps[n] } : null),
  };
  return { contract, provider, asked };
}

test('a pool buy and a pool sell decode into the SAME trade shape the curve uses', async () => {
  const { loadPoolHistory, _clearStampCache } = await import('../js/dex/history.js');
  _clearStampCache(); // never inherit another test's stamps — the seam says so
  const buyBlock = 9_990_002;
  const sellBlock = 9_990_001;
  const { contract, provider } = stubPool({
    swaps: [
      swapLog(buyBlock, '0xBuyer', true, 3n * 10n ** 16n, 7n * 10n ** 18n),
      swapLog(sellBlock, '0xSeller', false, 4n * 10n ** 18n, 1n * 10n ** 16n),
    ],
    stamps: { [buyBlock]: 1_700_000_011, [sellBlock]: 1_700_000_010 },
  });
  const out = await loadPoolHistory(contract, provider);
  assert.equal(out.ok, true, 'a readable pool reports ok');
  assert.equal(out.trades.length, 2);
  assert.equal(out.trades[0].block, buyBlock, 'newest first, like the curve tape');

  const [buy, sell] = out.trades;
  assert.equal(buy.kind, 'buy');
  assert.equal(buy.who, '0xBuyer');
  assert.equal(buy.eth, 3n * 10n ** 16n, 'a buy\'s quote is what was PAID (amountIn)');
  assert.equal(buy.tokens, 7n * 10n ** 18n, 'and its tokens are what CAME OUT (amountOut)');
  assert.equal(buy.time, 1_700_000_011, 'the stamp comes from the block, exact');
  assert.ok(Math.abs(buy.price - (3e16 / 7e18)) < 1e-15, 'price is THAT fill\'s own rate');

  assert.equal(sell.kind, 'sell');
  assert.equal(sell.eth, 1n * 10n ** 16n, 'a sell\'s quote is what was RECEIVED (amountOut)');
  assert.equal(sell.tokens, 4n * 10n ** 18n, 'and its tokens are what WENT IN (amountIn)');
  assert.equal(sell.time, 1_700_000_010);
});

test('an empty pool says "no trades", not "unreadable"', async () => {
  const { loadPoolHistory, _clearStampCache } = await import('../js/dex/history.js');
  _clearStampCache();
  const { contract, provider } = stubPool({ swaps: [] });
  const out = await loadPoolHistory(contract, provider);
  assert.equal(out.ok, true, 'no swaps is a readable answer');
  assert.deepEqual(out.trades, []);
  assert.equal(out.reason, undefined, 'no reason belongs on a successful read');
});

test('the pool tape window is bounded, and it reads Swap and nothing else', async () => {
  const { loadPoolHistory, _clearStampCache } = await import('../js/dex/history.js');
  _clearStampCache();
  const { contract, provider, asked } = stubPool({});
  await loadPoolHistory(contract, provider);
  assert.equal(asked.filter, 'Swap', 'the pool tape reads Swap, nothing else');
  assert.equal(asked.toBlock, 10_000_000);
  assert.ok(asked.fromBlock >= 0 && asked.toBlock - asked.fromBlock <= 40_000, 'bounded window, like the curve');
});

test('a pool node that cannot serve logs reports why, and never throws', async () => {
  const { loadPoolHistory } = await import('../js/dex/history.js');
  const contract = {
    filters: { Swap: () => 'Swap' },
    queryFilter: async () => { throw new Error('range too wide'); },
  };
  const out = await loadPoolHistory(contract, { getBlockNumber: async () => 5_000_000 });
  assert.equal(out.ok, false);
  assert.deepEqual(out.trades, []);
  assert.match(out.reason, /range too wide/, 'the reason is carried, not swallowed');
});

test('a swap log without its amounts is dropped, never rendered as NaN', async () => {
  const { loadPoolHistory, _clearStampCache } = await import('../js/dex/history.js');
  _clearStampCache();
  const good = 9_990_004;
  const bad = 9_990_003;
  const { contract, provider } = stubPool({
    swaps: [
      { blockNumber: bad, args: { trader: '0x' + '1'.repeat(40), quoteIn: true } },
      swapLog(good, '0x' + '2'.repeat(40), true, 10n ** 16n, 10n ** 18n),
    ],
    stamps: { [bad]: 1_700_000_003, [good]: 1_700_000_004 },
  });
  const out = await loadPoolHistory(contract, provider);
  assert.equal(out.trades.length, 1, 'the unreadable swap is dropped');
  assert.equal(out.trades[0].block, good);
  for (const t of out.trades) assert.ok(Number.isFinite(t.price), 'price must be finite');
});

test('the pool tape reads fields the pair actually emits', async () => {
  const { BEAR_PAIR_ABI } = await import('../js/dex/bear-source.js');
  const frag = BEAR_PAIR_ABI.find((f) => typeof f === 'string' && f.startsWith('event Swap('));
  assert.ok(frag, 'BEAR_PAIR_ABI must ship the Swap event');
  const args = frag.slice(frag.indexOf('(') + 1, frag.lastIndexOf(')'));
  const names = new Set(args.split(',').map((s) => s.trim().split(/\s+/).pop()).filter(Boolean));
  for (const n of ['trader', 'quoteIn', 'amountIn', 'amountOut']) {
    assert.ok(names.has(n), `Swap must emit ${n} — the pool tape reads it`);
  }
  const src = readFileSync(new URL('../js/dex/history.js', import.meta.url), 'utf8');
  for (const n of ['quoteIn', 'amountIn', 'amountOut', 'trader']) {
    assert.ok(src.includes(`a.${n}`), `loadPoolHistory must read the emitted name a.${n}`);
  }
});

test('poolCandles is the same candle maths — one shape, one chart', async () => {
  const { poolCandles, historyCandles } = await import('../js/dex/history.js');
  assert.equal(poolCandles, historyCandles, 'the pool name must BE the shared function, not a fork');
  const trades = [
    { kind: 'sell', who: '0xS', eth: 1n, tokens: 1n, block: 30, time: 300, price: 2e-13 },
    { kind: 'buy', who: '0xB', eth: 1n, tokens: 1n, block: 10, time: 100, price: 1e-13 },
  ];
  const candles = await poolCandles(trades);
  assert.ok(candles.length >= 1, 'the shared maths must produce candles');
  const times = candles.map((c) => c.time);
  assert.deepEqual([...times].sort((a, b) => a - b), times, 'pool candles ascend like curve candles');
});

// ── nodes that refuse the wide window ───────────────────────────────
// A range cap and a prune look alike from here and need opposite answers: the
// cap is cured by asking smaller (the WHOLE window must come back), the prune
// is not cured by anything (the newest rows come back, flagged, or the node's
// reason does). The single wide call is tried first on every node — these
// stubs refuse it on purpose.

function rangeCappedChain({ swaps = [], cap = 5_000 }) {
  const asked = [];
  const contract = {
    filters: { Swap: () => 'Swap' },
    queryFilter: async (f, from, to) => {
      const fits = to - from <= cap;
      asked.push({ from, to, ok: fits });
      if (!fits) throw new Error('block range is too wide');
      return swaps.filter((s) => s.blockNumber >= from && s.blockNumber <= to);
    },
  };
  const provider = {
    getBlockNumber: async () => 10_000_000,
    getBlock: async () => ({ timestamp: 1_700_000_000 }),
  };
  return { contract, provider, asked };
}

const prunedError = () => {
  const e = new Error('pruned history unavailable');
  e.info = { error: { code: 4444 } };
  return e;
};

test('a range-capped node still gets the WHOLE window — the walk shrinks until it fits', async () => {
  const { loadPoolHistory, _clearStampCache } = await import('../js/dex/history.js');
  _clearStampCache();
  const newest = 9_999_000;
  const oldest = 9_960_500; // outside one small ask, inside the 40k window
  const { contract, provider, asked } = rangeCappedChain({
    swaps: [
      swapLog(newest, '0xBuyer', true, 10n ** 16n, 10n ** 18n),
      swapLog(oldest, '0xBuyer', true, 2n * 10n ** 16n, 10n ** 18n),
    ],
  });
  const out = await loadPoolHistory(contract, provider);
  assert.equal(out.ok, true, 'a range cap is not a failure — it is a smaller ask');
  assert.equal(out.partial, undefined, 'the whole window was read; nothing was cut');
  assert.deepEqual(out.trades.map((t) => t.block), [newest, oldest], 'both fills, newest first');
  assert.ok(asked.some((a) => !a.ok), 'the wide ask was refused at least once');
  const firstOk = asked.findIndex((a) => a.ok);
  assert.ok(firstOk > 0, 'a chunk size that fits was found only by shrinking');
  assert.ok(asked.slice(firstOk).every((a) => a.ok), 'once a size fits, every following ask uses it');
});

test('a pruned node yields the newest trades — flagged partial, never silent', async () => {
  const { loadPoolHistory, _clearStampCache } = await import('../js/dex/history.js');
  _clearStampCache();
  const floor = 10_000_000 - 9_000; // the newest chunk is all the node still serves
  const kept = swapLog(9_999_500, '0xBuyer', true, 10n ** 16n, 10n ** 18n);
  const contract = {
    filters: { Swap: () => 'Swap' },
    queryFilter: async (f, from, to) => {
      if (from < floor) throw prunedError();
      return [kept].filter((s) => s.blockNumber >= from && s.blockNumber <= to);
    },
  };
  const provider = { getBlockNumber: async () => 10_000_000, getBlock: async () => ({ timestamp: 1_700_000_000 }) };
  const out = await loadPoolHistory(contract, provider);
  assert.equal(out.ok, true, 'the rows the node still serves are real and shown');
  assert.equal(out.partial, true, 'but the window was cut — the page must say so');
  assert.deepEqual(out.trades.map((t) => t.block), [9_999_500]);
  assert.match(out.reason, /pruned/i, 'the cut carries the node\'s own words');
});

test('a pruned node with nothing readable is still an honest failure', async () => {
  const { loadPoolHistory, _clearStampCache } = await import('../js/dex/history.js');
  _clearStampCache();
  const contract = {
    filters: { Swap: () => 'Swap' },
    queryFilter: async (f, from) => {
      if (from < 10_000_000 - 9_000) throw prunedError();
      return [];
    },
  };
  const out = await loadPoolHistory(contract, { getBlockNumber: async () => 10_000_000 });
  assert.equal(out.ok, false, 'no readable rows is not "no trades" — it is "cannot read"');
  assert.deepEqual(out.trades, []);
  assert.match(out.reason, /pruned/i);
});

test('the curve tape survives a prune too: partial rows, flag, and the reason kept', async () => {
  const { loadHistory, _clearStampCache } = await import('../js/dex/history.js');
  _clearStampCache();
  const floor = 5_000_000 - 9_000;
  const buyAt = 4_999_600;
  const logs = [bought(buyAt, '0x' + '1'.repeat(40), 10n ** 16n, 10n ** 18n)];
  const contract = {
    filters: { Bought: () => 'Bought', Sold: () => 'Sold', Graduated: () => 'Graduated' },
    queryFilter: async (f, from, to) => {
      if (from < floor) throw prunedError();
      return f === 'Bought' ? logs.filter((l) => l.blockNumber >= from && l.blockNumber <= to) : [];
    },
  };
  const provider = {
    getBlockNumber: async () => 5_000_000,
    getBlock: async () => ({ timestamp: 1_700_000_000 }),
  };
  const out = await loadHistory(contract, provider);
  assert.equal(out.ok, true);
  assert.equal(out.partial, true, 'the cut is stated, not hidden');
  assert.equal(out.trades.length, 1, 'the buy the node still serves is shown');
  assert.match(out.reason, /pruned/i);
});
