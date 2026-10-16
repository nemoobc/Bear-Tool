// Bear Tool — tests/dex-feed.test.js
//
// The feed (user: "fitur launchpad kurang lengkap" → riset launchpad-ux R3)
// must be SEARCHABLE (name / ticker / contract address), SORTABLE (newest /
// trending / liquidity / name) and every row must carry an honest status badge
// — "New"
// only while it really is new, "LP locked" only when the pair's own
// lockedUntil(creator) says so. No badge is ever invented: a pool the chain
// did not confirm simply carries neither.
//
// The pure maths (feedView / isFresh / isLocked) is pinned first; the wiring
// pins below keep the feed screen connected to it (markup ids, bindings, i18n
// keys) so a rename cannot silently unhook the tools.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// core.js → state.js / network.js read localStorage at import time.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const { feedView, isFresh, isLocked, FRESH_BLOCKS, decodeSwapQuote } = await import('../js/dex/tokens.js');
const { ethers: E } = await import('ethers');
const { t, setLang } = await import('../js/i18n.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const row = (over = {}) => ({
  address: '0x' + 'a1'.repeat(20),
  pair: '0x' + 'b2'.repeat(20),
  quote: '0x' + 'c3'.repeat(20),
  creator: '0x' + 'd4'.repeat(20),
  block: 100,
  name: 'Bear Coin',
  symbol: 'BEAR',
  liq: 0n,
  ...over,
});

// ── feedView: the pure view ─────────────────────────────────────────

test('feedView: default order is newest first, ties broken by address', () => {
  const rows = [
    row({ address: '0x' + '02'.repeat(20), block: 100 }),
    row({ address: '0x' + '01'.repeat(20), block: 300 }),
    row({ address: '0x' + '03'.repeat(20), block: 100 }),
  ];
  const out = feedView(rows);
  assert.deepEqual(out.map((r) => r.block), [300, 100, 100]);
  assert.deepEqual(out.slice(1).map((r) => r.address), ['0x' + '02'.repeat(20), '0x' + '03'.repeat(20)],
    'equal blocks order by address, so two paints never shuffle');
  assert.notEqual(out, rows, 'feedView returns a new array, never the caller\'s');
  assert.equal(rows[0].block, 100, 'and never mutates it');
});

test('feedView: rows with no block sink to the bottom instead of exploding', () => {
  const out = feedView([row({ block: 0 }), row({ block: 50, address: '0x' + '55'.repeat(20) })]);
  assert.equal(out[0].block, 50);
  assert.equal(out[1].block, 0);
});

test('feedView: the search box takes name, ticker AND contract address', () => {
  const a = row({ name: 'Bear Coin', symbol: 'BEAR' });
  const b = row({ name: 'Rocket', symbol: 'RCKT', address: '0x' + '99'.repeat(20) });
  assert.deepEqual(feedView([a, b], { q: 'BEAR' }).map((r) => r.address), [a.address],
    'name and ticker match case-insensitively');
  assert.deepEqual(feedView([a, b], { q: 'rocket' }).map((r) => r.address), [b.address]);
  assert.deepEqual(feedView([a, b], { q: '0x' + '99'.repeat(4) }).map((r) => r.address), [b.address],
    'an address substring finds the row — the whole point of R3\'s "by contract address"');
  assert.deepEqual(feedView([a, b], { q: 'nope' }), [], 'no match is an empty view, not an error');
  assert.equal(feedView([a, b], { q: '   ' }).length, 2, 'a blank search shows everything');
});

test('feedView: liquidity sort is BigInt-exact and quiet about gaps', () => {
  const big = row({ address: '0x' + '11'.repeat(20), liq: 5n * 10n ** 18n });
  const small = row({ address: '0x' + '22'.repeat(20), liq: 10n ** 15n });
  const none = row({ address: '0x' + '33'.repeat(20), liq: undefined });
  const out = feedView([small, none, big], { sort: 'liq' });
  assert.deepEqual(out.map((r) => r.address), [big.address, small.address, none.address],
    'a wei reserve exceeds Number range — the sort must survive it');
});

test('feedView: name sort is alphabetical and case-blind, address fills the gap', () => {
  const z = row({ name: 'zebra', address: '0x' + '11'.repeat(20) });
  const a = row({ name: 'Apple', address: '0x' + '22'.repeat(20) });
  const m = row({ name: 'melon', address: '0x' + '33'.repeat(20) });
  const out = feedView([z, m, a], { sort: 'name' });
  assert.deepEqual(out.map((r) => r.name), ['Apple', 'melon', 'zebra'],
    'case does not decide the order');
  const nameless = row({ name: '', symbol: '', address: '0x' + '00'.repeat(20) });
  const out2 = feedView([a, nameless], { sort: 'name' });
  assert.equal(out2[0].address, nameless.address, 'a nameless row sorts by its address — it still gets a seat');
});

test('feedView: an unknown sort never crashes — it behaves like newest', () => {
  const out = feedView([row({ block: 1 }), row({ block: 9, address: '0x' + '77'.repeat(20) })], { sort: 'wat' });
  assert.deepEqual(out.map((r) => r.block), [9, 1]);
});

// ── freshness & locks: the badge math ───────────────────────────────

test('the freshness window is a day, and it is one constant', () => {
  assert.equal(FRESH_BLOCKS, 7_200, '24h at 12s/block — the badge must die when the day does');
});

test('isFresh: the badge is about the window, not the vibe', () => {
  assert.equal(isFresh(9_999, 10_000), true);
  assert.equal(isFresh(10_000 - FRESH_BLOCKS, 10_000), true, 'the boundary still counts');
  assert.equal(isFresh(10_000 - FRESH_BLOCKS - 1, 10_000), false, 'one block past and it is history');
  assert.equal(isFresh(0, 10_000), false, 'no block means no claim');
  assert.equal(isFresh(9_000, undefined), false, 'no tip means no claim');
});

test('isLocked: expiry is not a lock, and absent is not a lock', () => {
  assert.equal(isLocked(2_000, 1_000), true);
  assert.equal(isLocked(1_000, 1_000), false, 'a lock that expired this second is over');
  assert.equal(isLocked(0, 1_000), false);
  assert.equal(isLocked(undefined, 1_000), false);
  assert.equal(isLocked('2000', 1_000), true, 'a getter may answer as string — still a lock');
});

// ── wiring pins: markup, bindings, honesty ──────────────────────────

test('the feed markup ships the search, the sort and the open-a-contract slot', () => {
  const src = read('../js/dex/tokens.js');
  for (const id of ['dexFeedSearch', 'dexFeedSort', 'dexFeedMatch']) {
    assert.ok(src.includes(`id="${id}"`), `tokens.js must paint #${id}`);
  }
  assert.ok(src.includes('class="dex-feedtools"'), 'the tools row');
  assert.ok(src.includes('class="dex-search"'), 'the search input');
  assert.ok(src.includes('class="dex-sort"'), 'the sort select');
  assert.ok(src.includes('data-dex-open'), 'the not-in-list address affordance must exist');
});

test('badges tell the truth: new means new, locked means the pair says so', () => {
  const src = read('../js/dex/tokens.js');
  assert.ok(src.includes('dex-badge-new'), 'the row must carry the new badge');
  assert.ok(src.includes('dex-badge-lock'), 'and the locked badge');
  assert.match(src, /lockedUntil\(/, 'lockedness is read from the pair, never guessed');
  assert.match(src, /isFresh\(/, 'freshness rides the pinned window helper');
  assert.ok(!/dex\.feed\.badgeNew'\)/.test(src) || /t\('dex\.feed\.badgeNew'/.test(src),
    'badge text is i18n, not hardcoded');
});

test('bindTokens wires search, sort and the open-a-contract button', () => {
  const src = read('../js/dex/tokens.js');
  const bind = src.slice(src.indexOf('export function bindTokens'));
  assert.ok(bind.length > 50, 'bindTokens must still exist');
  assert.match(bind, /'input'/, 'typing filters without a re-scan');
  assert.match(bind, /'change'/, 'sorting re-renders without a re-scan');
  assert.match(bind, /data-dex-open/, 'the affordance click opens the coin');
});

test('the view state survives the 20s auto-refresh: it is read from the DOM each paint', () => {
  const src = read('../js/dex/tokens.js');
  const refresh = src.slice(src.indexOf('export async function refreshFeed'));
  assert.match(refresh, /feedView\(/, 'the refresh paints through feedView, not around it');
  assert.match(refresh, /dexFeedSearch/, 'and it reads the live search box value');
  assert.match(refresh, /dexFeedSort/, 'and the live sort selection');
});

test('discovery reports the tip it looked at — freshness needs an anchor', () => {
  const src = read('../js/dex/pools.js');
  assert.match(src, /more: full,\s*latest/, 'discoverPools must return the tip block in its result');
});

// ── R15: the trending sort — volume, and no invented volume ─────────

test('feedView: trend sorts by last-hour volume, then liquidity, then newest', () => {
  const hot = row({ address: '0x' + '11'.repeat(20), vol1h: 5n, liq: 1n, block: 1 });
  const warm = row({ address: '0x' + '22'.repeat(20), vol1h: 5n, liq: 9n, block: 2 });
  const cold = row({ address: '0x' + '33'.repeat(20), vol1h: 0n, liq: 99n, block: 3 });
  const noVol = row({ address: '0x' + '44'.repeat(20), liq: 100n, block: 4 });
  const out = feedView([cold, noVol, warm, hot], { sort: 'trend' });
  assert.deepEqual(out.map((r) => r.address), [warm.address, hot.address, noVol.address, cold.address],
    'same volume falls to liquidity; no volume is a zero, not an error; newest breaks the rest');
});

test('a swap log yields its QUOTE-side amount — both directions, no guesses', () => {
  const data = (quoteIn, aIn, aOut) => E.AbiCoder.defaultAbiCoder()
    .encode(['bool', 'uint256', 'uint256'], [quoteIn, aIn, aOut]);
  const pair = '0x' + 'b2'.repeat(20);
  assert.equal(decodeSwapQuote(E, { address: pair, data: data(true, 111n, 222n) }), 111n,
    'quote in: the quote amount is amountIn');
  assert.equal(decodeSwapQuote(E, { address: pair, data: data(false, 333n, 444n) }), 444n,
    'quote out: the quote amount is amountOut');
  assert.equal(decodeSwapQuote(E, { address: pair, data: '0xdead' }), null,
    'an unreadable log adds nothing — a volume is never guessed');
});

test('R15 wiring: the option, the scan, the cache, the badge, the honest fallback', () => {
  const src = read('../js/dex/tokens.js');
  assert.ok(src.includes('value="trend"'), 'the sort select must offer Trending');
  assert.match(src, /attachVol1h\(priced, out\.latest\)/, 'the refresh attaches volume to the rows it painted');
  assert.match(src, /VOL_TTL_MS/, 'the scan is cached — 20s refreshes must not re-read the same window');
  assert.match(src, /chunkedGetLogs\(/, 'the scan rides the shared chunked log reader');
  assert.ok(src.includes("'Swap(address,bool,uint256,uint256)'"), 'the window is filtered on the pair Swap log');
  assert.match(src, /dex\.feed\.trendFallback/, 'a failed scan says so in the status line');
  assert.ok(src.includes('dex-badge-vol'), 'rows carry the volume badge');
});

test('R15 strings answer in both languages', () => {
  for (const lang of ['en', 'id']) {
    setLang(lang);
    for (const k of ['dex.feed.sortTrend', 'dex.feed.badgeVol', 'dex.feed.trendFallback']) {
      assert.ok(t(k).length > 0 && t(k) !== k, `${k} must be translated in ${lang}`);
    }
  }
  setLang('en');
  assert.match(t('dex.feed.badgeVol', { v: '1.20 ETH' }), /1\.20 ETH/);
});
