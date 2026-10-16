// Bear Tool — dex-watch.test.js
//
// R14: the watchlist and its watcher. The claims that matter here are the
// QUIET ones: storage keeps nothing but an address and a ticker; a read that
// fails never alerts; the bell rings only on a real move, and only once per
// cooldown; and the whole feature says out loud that it lives inside the app
// — no push when the app is closed. Those are pinned below, plus the wiring
// points in the three modules that carry the feature.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The same localStorage shape the other dex gates use — installed before any
// module import, because network.js (and friends) read it at import time.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const watchJs = read('../js/dex/watch.js');
const tokensJs = read('../js/dex/tokens.js');
const tokenPageJs = read('../js/dex/token-page.js');
const indexJs = read('../js/dex/index.js');

const {
  parseWatch, nextWatch, alertFor, watchList, isWatched, toggleWatch,
  pairOf, sweepWatches, ensureWatcher, stopWatcher,
  WATCH_MAX, WATCH_MOVE_BPS, WATCH_COOLDOWN_MS,
} = await import('../js/dex/watch.js');
const { DEX_CHAIN_ID } = await import('../js/dex/core.js');
const { t, setLang } = await import('../js/i18n.js');

const ADDR = `0x${'a1'.repeat(20)}`;
const ADDR2 = `0x${'b2'.repeat(20)}`;
const watchKey = `bear.dex.watch.${DEX_CHAIN_ID}`;
const seenKey = `bear.dex.watchseen.${DEX_CHAIN_ID}`;

test('parseWatch keeps only watchers it can trust', () => {
  const out = parseWatch([
    { address: ADDR.toUpperCase(), symbol: 'BEAR' },
    { address: ADDR, symbol: 'DUP' }, // duplicate collapses
    { address: 'not-an-address', symbol: 'X' }, // junk is dropped
    null,
    { address: ADDR2, symbol: 'S'.repeat(40) }, // ticker is clipped, never stored raw
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].address, ADDR); // lowercased on the way in
  assert.equal(out[1].symbol.length, 16);
  assert.deepEqual(parseWatch('junk'), []);
  assert.deepEqual(parseWatch(null), []);
});

test('nextWatch toggles purely and refuses past the cap', () => {
  const base = [{ address: ADDR, symbol: 'A' }];
  const added = nextWatch(base, ADDR2, 'B');
  assert.equal(added.length, 2);
  assert.equal(added[0].address, ADDR2); // newest first
  assert.equal(base.length, 1); // pure: the input list is untouched
  assert.deepEqual(nextWatch(added, ADDR2, ''), base); // second toggle removes
  assert.equal(nextWatch(base, 'nope', ''), base); // junk changes nothing
  const full = Array.from({ length: WATCH_MAX }, (_, i) => ({
    address: `0x${String(i).padStart(40, '0')}`,
    symbol: '',
  }));
  assert.equal(nextWatch(full, ADDR, ''), null); // full refuses; never silently drops
});

test('alertFor rings only on a real move, only outside the cooldown', () => {
  const now = 1_700_000_000_000;
  assert.deepEqual(alertFor(100, 110, 0, now), { dir: 'up', bps: 1000 }); // exactly +10% rings
  assert.equal(alertFor(100, 109.9, 0, now), null); // 9.99% stays quiet
  assert.deepEqual(alertFor(100, 88, 0, now), { dir: 'down', bps: 1200 }); // down rings too
  assert.equal(alertFor(100, 200, now - 1000, now), null); // inside cooldown: quiet
  assert.deepEqual(alertFor(100, 200, now - WATCH_COOLDOWN_MS, now), { dir: 'up', bps: 10_000 });
  assert.equal(alertFor(0, 50, 0, now), null); // no baseline (or a zero pool): no claim
  assert.equal(alertFor(100, Number.NaN, 0, now), null);
  assert.equal(WATCH_MOVE_BPS, 1000);
});

test('storage round-trip: toggle, isWatched, and the baseline dies with the watch', () => {
  store.clear();
  assert.equal(isWatched(ADDR), false);
  assert.equal(toggleWatch(ADDR, 'BEAR'), true);
  assert.equal(isWatched(ADDR), true);
  assert.deepEqual(watchList().map((w) => w.address), [ADDR]);
  // A bell baseline may exist from a sweep; stopping the watch drops it, so a
  // future re-watch starts clean instead of waking to a stale move.
  store.set(seenKey, JSON.stringify({ [ADDR]: { r: 1, at: 0 } }));
  assert.equal(toggleWatch(ADDR, ''), false);
  assert.equal(isWatched(ADDR), false);
  assert.equal(JSON.parse(store.get(seenKey) || '{}')[ADDR], undefined); // baseline gone
});

test('a full watchlist refuses the next star and changes nothing', () => {
  store.clear();
  const full = Array.from({ length: WATCH_MAX }, (_, i) => ({
    address: `0x${String(i).padStart(40, '0')}`,
    symbol: '',
  }));
  store.set(watchKey, JSON.stringify(full));
  assert.equal(toggleWatch(ADDR, 'X'), null);
  assert.equal(watchList().length, WATCH_MAX);
  assert.equal(store.get(watchKey), JSON.stringify(full)); // untouched, byte for byte
});

test('the watcher reads nothing without a provider — so a swept list stays silent', async () => {
  store.clear();
  toggleWatch(ADDR, 'BEAR');
  // No provider in this environment: pairOf answers null, the sweep makes no
  // claim, and no bell can ring from an unread coin.
  assert.equal(await pairOf(ADDR), null);
  const out = await sweepWatches({ notify: false });
  assert.deepEqual(out, { checked: 1, alerts: 0 });
  // No baseline invented from a failed read: the seen map holds no entry.
  assert.equal(JSON.parse(store.get(seenKey) || '{}')[ADDR], undefined);
  assert.equal(typeof ensureWatcher, 'function'); // the clock is opt-in, not import-time
  assert.equal(typeof stopWatcher, 'function');
  store.clear();
});

test('every watch string answers in both languages — honesty line included', () => {
  const keys = [
    'dex.tokens.watch', 'dex.watch.watch', 'dex.watch.watching', 'dex.watch.added',
    'dex.watch.removed', 'dex.watch.full', 'dex.watch.emptyTitle', 'dex.watch.emptyMsg',
    'dex.watch.emptyHint', 'dex.watch.moved', 'dex.watch.dirUp', 'dex.watch.dirDown',
  ];
  for (const lang of ['en', 'id']) {
    setLang(lang);
    for (const k of keys) {
      assert.ok(t(k).length > 0, `${k} must answer in ${lang}`);
      assert.notEqual(t(k), k, `${k} must be translated in ${lang}`);
    }
    // The in-app-only limit is part of the feature, not a footnote.
    assert.match(t('dex.watch.emptyHint'), lang === 'en' ? /no push/i : /tidak ada push/i);
  }
  setLang('en');
  assert.match(t('dex.watch.moved', { sym: 'BEAR', dir: 'up', pct: '10.0' }), /BEAR is up 10\.0%/);
  setLang('id');
  assert.match(t('dex.watch.moved', { sym: 'BEAR', dir: 'naik', pct: '10.0' }), /BEAR naik 10\.0%/);
  setLang('en');
});

test('the feed carries a third scope whose empty box speaks for itself', () => {
  assert.match(tokensJs, /data-dex-scope="watch"/);
  assert.match(tokensJs, /watchList\(\)/);
  assert.match(tokensJs, /setEmptyCopy\(host, scope\)/);
  // Watched rows read their coin directly — no discovery window — and the
  // empty watchlist copy claims nothing about the chain.
  assert.match(tokensJs, /async function readWatchRow\(/);
  assert.match(tokensJs, /dex\.watch\.emptyMsg/);
});

test('the watcher clock is one per session, guarded, and never holds a test runner open', () => {
  assert.match(indexJs, /import \{ ensureWatcher \} from '\.\/watch\.js';/);
  assert.match(indexJs, /ensureWatcher\(\);/);
  assert.match(watchJs, /export function ensureWatcher\(/);
  assert.match(watchJs, /document\.hidden/);
  assert.match(watchJs, /unref\(\)/);
  assert.match(watchJs, /WATCH_TICK_MS/);
  assert.match(watchJs, /if \(ratio == null\) return;/); // a failed read never rings
  assert.match(watchJs, /toast\(t\('dex\.watch\.moved'/);
});

test('the star is wired before the reads, like Delete — and says what it is', () => {
  assert.match(tokenPageJs, /id="dexTpWatch" aria-pressed="false"/);
  assert.match(tokenPageJs, /toggleWatch\(token, watchSym\)/);
  assert.match(tokenPageJs, /paintWatch\(\)/);
  const wired = tokenPageJs.indexOf("watchBtn.addEventListener('click'");
  const reads = tokenPageJs.indexOf('tokenInfo(token, me)');
  assert.ok(wired > -1 && reads > -1 && wired < reads,
    'the star must be wired before the contract reads — it has to work even when they fail');
});
