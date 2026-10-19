// Bear Tool — tests/dex-token.test.js
// M5b: the token page's DATA layer. The tape is the SAME decode path the app
// uses (Interface over the pair's own ABI, topics+data handed explicitly —
// the real ethers V6 quirk), the candles are index-band OHLC with a strict
// numbers-only contract (no BigInt ever reaches JSON), and the social links
// are https-only — the face's own words never become a javascript: jump.
// Assertions call the real modules the app calls — no source-text regexes
// for logic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers as realEthers } from 'ethers';

// ── harness: same shape as tests/dex-launch.test.js — Contract collapses to
// an in-memory read table while Interface stays REAL.
const READS = new Map();
class FakeContract {
  constructor(addr) {
    const addrL = String(addr).toLowerCase();
    this.address = addrL;
    return new Proxy(this, {
      get: (target, prop) => {
        if (prop in target) return target[prop];
        return (...args) => {
          const val = READS.get(addrL)?.[prop];
          if (val === undefined) throw new Error(`fake-chain: no read for ${addrL}.${String(prop)}`);
          return typeof val === 'function' ? val(...args) : Promise.resolve(val);
        };
      },
    });
  }
}
globalThis.ethers = Object.assign({}, realEthers, { Contract: FakeContract });

const tk = await import('../js/dex/token.js');
const idx = await import('../js/dex/index.js');
const I = new realEthers.Interface((await import('../js/dex/abi.js')).BEAR_PAIR_ABI);

const PAIR = '0x' + '06'.repeat(20);
const WHO = '0x' + '11'.repeat(20);
const TO = '0x' + '22'.repeat(20);
const Q = 10n ** 18n; // one quote
const T = 10n ** 18n; // one token

/** A real, chain-shaped Swap log: topics+data EXACTLY as a node hands them. */
const EV = (amountIn, amountOut, quoteIn, blockNumber) => {
  const enc = I.encodeEventLog(I.getEvent('Swap'), [WHO, TO, amountIn, amountOut, quoteIn]);
  return { topics: enc.topics, data: enc.data, blockNumber };
};
// asc by block, as queryFilter returns
const QIN = (inQ, outT, b) => EV(inQ, outT, true, b);            // buy: quote in → token out
const QOUT = (inT, outQ, b) => EV(inT, outQ, false, b);          // sell: token in → quote out

const provider = {
  getBlockNumber: async () => 1000,
  getBlock: async (b) => ({ timestamp: 1700000000 + b * 12 }),
};

// T1 rowPrice: the pair's own swap semantics, one formula (contracts.js:252,274)
test('rowPrice: quote-per-token — quoteIn ? in/out : out/in, dust never divides', () => {
  const buy = tk.rowPrice(10n * Q, 52n * T, true);
  const sell = tk.rowPrice(26n * T, 13n * Q, false);
  // 1e12 of scale headroom: ratios hold within 1e-10 of the true float —
  // candle shape only needs relative correctness, never the 17th digit.
  assert.ok(Math.abs(buy - 10 / 52) < 1e-10, `buy ratio holds (${buy})`);
  assert.ok(Math.abs(sell - 13 / 26) < 1e-10, `sell ratio holds (${sell})`);
  assert.equal(tk.rowPrice(0n, 5n * T, true), null, 'a zero-in swap is not a price');
  assert.equal(tk.rowPrice(5n * Q, 0n, true), null);
  assert.ok(Number.isFinite(buy) && Number.isFinite(sell));
});

// T2 swapTape: the real decode path, newest-first, capped, timestamps filled
test('swapTape decodes real Swap logs newest-first with price and ts', async () => {
  READS.clear();
  READS.set(PAIR.toLowerCase(), {
    queryFilter: () => [
      QIN(2n * Q, 10n * T, 996),
      QOUT(30n * T, 1n * Q, 997),
      QIN(5n * Q, 20n * T, 998),
      QOUT(9n * T, 4n * Q, 999),
    ],
  });
  const { rows, from, to } = await tk.swapTape(provider, PAIR);
  assert.equal(from, 1000 - tk.TAPE_DEPTH); // the honest window, floored at 0
  assert.equal(to, 1000);
  assert.equal(rows.length, 4);
  assert.equal(rows[0].block, 999, 'newest first');
  assert.equal(rows[3].block, 996);
  assert.equal(rows[0].quoteIn, false);
  assert.equal(String(rows[0].who), WHO.toLowerCase());
  assert.equal(String(rows[0].to), TO);
  assert.ok(Math.abs(rows[0].price - 4 / 9) < 1e-10, 'newest is a sell 9T→4Q');
  assert.equal(rows[1].price, 5 / 20, 'exact ratios survive the scale exactly');
  assert.equal(rows[0].ts, 1700000000 + 999 * 12, 'the provider answers blocks in the ledger');
  // BigInt bodies stay BigInt (the renderer formats; nothing stringifies rows)
  assert.equal(rows[0].amountIn, 9n * T);
  const enc = I.decodeEventLog('Swap', EV(1n, 2n, true, 1).data, EV(1n, 2n, true, 1).topics);
  assert.equal(enc.quoteIn, true, 'the decoder round-trips the same event the pair emits');
});

test('swapTape: limit caps, empty window is an honest page, bad pair refuses', async () => {
  READS.clear();
  const many = [];
  for (let b = 10; b <= 40; b++) many.push(QIN(Q, T, b));
  READS.set(PAIR.toLowerCase(), { queryFilter: () => many });
  const { rows } = await tk.swapTape(provider, PAIR);
  assert.equal(rows.length, tk.TAPE_LIMIT, 'capped at the tape limit');
  assert.equal(rows[0].block, 40, 'limit keeps the NEWEST, not the first');
  READS.set(PAIR.toLowerCase(), { queryFilter: () => [] });
  const none = await tk.swapTape(provider, PAIR);
  assert.deepEqual(none.rows, []);
  await assert.rejects(() => tk.swapTape(provider, '0xzz'), (e) => e.why === 'bad');
});

// T3 candlesOf: index bands, OHLC of the window, numbers only.
// Contract: input is the TAPE's rows (newest-first, as swapTape returns);
// output candles are oldest-left, ready to draw left→right.
test('candlesOf: band OHLC oldest-left, empties honest, JSON can never see a BigInt', () => {
  assert.deepEqual(tk.candlesOf([]), []);
  assert.deepEqual(tk.candlesOf(undefined), []);
  const one = tk.candlesOf([{ price: 3.5 }, { price: null }], 12);
  assert.equal(one.length, 1, 'priceless rows are not fake candles');
  assert.deepEqual(one[0], { o: 3.5, h: 3.5, l: 3.5, c: 3.5 });
  const rows = [ // newest-first, exactly as the tape returns
    { price: 6, block: 6 }, { price: 5, block: 5 }, { price: 4, block: 4 },
    { price: 3, block: 3 }, { price: 2, block: 2 }, { price: 1, block: 1 },
  ];
  const cs = tk.candlesOf(rows, 2);
  assert.equal(cs.length, 2);
  assert.deepEqual(cs[0], { o: 1, h: 3, l: 1, c: 3 }, 'oldest band first, left');
  assert.deepEqual(cs[1], { o: 4, h: 6, l: 4, c: 6 });
  const tiny = tk.candlesOf(rows, 100);
  assert.equal(tiny.length, 6, 'number of bands never exceeds the tape');
  assert.ok(JSON.stringify(cs) && !JSON.stringify(cs).includes('BigInt'), 'numbers only');
  const flop = tk.candlesOf([{ price: 9, block: 3 }, { price: 4, block: 2 }, { price: 5, block: 1 }], 2);
  assert.deepEqual(flop[0], { o: 5, h: 5, l: 4, c: 4 });
  assert.deepEqual(flop[1], { o: 9, h: 9, l: 9, c: 9 });
});

// T4 socials are https-only — public strings never become script jumps
test('socialUrl: https or nothing — javascript:, data:, http, junk all refused', () => {
  assert.equal(tk.socialUrl('https://x.com/b'), 'https://x.com/b');
  assert.equal(tk.socialUrl('  HTTPS://x.com/B '), 'HTTPS://x.com/B');
  assert.equal(tk.socialUrl('http://insecure.example'), '', 'http is not https');
  assert.equal(tk.socialUrl('javascript:alert(1)'), '');
  assert.equal(tk.socialUrl('JAVASCRIPT:x'), '');
  assert.equal(tk.socialUrl('data:text/html,<x>'), '');
  assert.equal(tk.socialUrl('//naive.example'), '');
  assert.equal(tk.socialUrl('x.com/b'), '');
  assert.equal(tk.socialUrl(''), '');
  assert.equal(tk.socialUrl(null), '');
  assert.equal(tk.socialUrl(42), '');
});

// T5 the page itself: face rows, socials gated, tape painted, trade door
test('tokenPageHtml paints the face, gates socials on https+socialsSet, renders the tape', () => {
  const face = {
    token: '0x' + '05'.repeat(20), name: 'B Meme', symbol: 'BM',
    image: 'https://i/b.png', desc: 'a bear meme',
    twitter: 'https://x.com/b', telegram: 'https://t.me/b', website: 'https://b.example',
    socialsSet: true, totalSupply: 10n ** 24n, quote: '0x' + 'aa'.repeat(20),
  };
  const rows = [
    { who: WHO, to: TO, amountIn: 2n * Q, amountOut: 10n * T, quoteIn: true, price: 0.2, block: 998, ts: 1700001200 },
    { who: WHO, to: TO, amountIn: 30n * T, amountOut: 1n * Q, quoteIn: false, price: 0.0333, block: 999, ts: null },
  ];
  const html = idx.tokenPageHtml({ face, trail: { rows }, pair: PAIR, qSymbol: 'USDC', dec: 18 });
  assert.match(html, /data-dex-token/);
  assert.match(html, /B Meme/);
  assert.match(html, /rel="noopener noreferrer"/, 'every external door is noopener');
  assert.doesNotMatch(html, /javascript:/i);
  assert.match(html, /dex-tape-row/, 'the tape paints');
  assert.match(html, /#999/, 'a hole block is honest, not blank');
  assert.match(html, /data-dex-token-trade/, 'the trade door exists with a pair');
  assert.match(html, /dex-candles/);
  // socialsSet forbidden → not a single chip, even with strings present
  const quiet = idx.tokenPageHtml({ face: { ...face, socialsSet: false }, trail: { rows: [] }, pair: '', qSymbol: '', dec: 18 });
  assert.doesNotMatch(quiet, /dex-social/, 'unset socials never render');
  assert.doesNotMatch(quiet, /data-dex-token-trade/, 'no pair → no trade door');
  assert.match(quiet, /dex-t-hint/, 'the empty tape says so in words');
  // a poisoned face: strings arrive but the door refuses them
  const evil = idx.tokenPageHtml({
    face: { ...face, twitter: 'javascript:alert(1)', website: "x'\"onmouseover=x" },
    trail: { rows: [] }, pair: '', qSymbol: '', dec: 18,
  });
  assert.doesNotMatch(evil, /javascript:alert/, 'the poison string is not a door');
  assert.doesNotMatch(evil, /onmouseover=/, 'quote-breaks stay escaped');
});

// T6 the whole trail never feeds JSON a BigInt — the ledger→page seam
test('swapTape rows render through the page without BigInt leakage anywhere', async () => {
  READS.clear();
  READS.set(PAIR.toLowerCase(), { queryFilter: () => [QIN(10n ** 24n * Q, 7n, 50)] });
  const { rows } = await tk.swapTape(provider, PAIR);
  const face = {
    token: '0x' + '05'.repeat(20), name: 'B', symbol: 'B', image: '', desc: '',
    twitter: '', telegram: '', website: '', socialsSet: false,
    totalSupply: 10n ** 24n, quote: '0x' + 'aa'.repeat(20),
  };
  // the paint must not throw on absurd magnitudes, and the output is a STRING
  const html = idx.tokenPageHtml({ face, trail: { rows }, pair: PAIR, qSymbol: 'Q', dec: 18 });
  assert.equal(typeof html, 'string');
  assert.match(html, /dex-tape-row/);
  assert.ok(Array.isArray(tk.candlesOf(rows, 12)));
});
