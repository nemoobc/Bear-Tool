// Bear Tool — token-logo-identity.test.js
// A token's mark must follow its CONTRACT, not its ticker.
//
// The logo cache was keyed by symbol: cacheLogo(t.symbol, url), read back with
// getCachedLogo(sym), and every surface rendered with tokenLogoHTML(sym). The
// fetch is a CoinGecko lookup by symbol too.
//
// So any token whose ticker matches a listed project is drawn with that
// project's real mark. Counterfeit "USDC" contracts are one of the most common
// things in a wallet, and this is a self-custody wallet that already ships an
// address-poisoning guard — a guard that only ever compares ADDRESSES. A fake
// token wearing the genuine mark walks straight past it, and the user has no way
// to see the difference: the mark is the thing they scan for.
//
// The token rows already carry `address`. The cache just wasn't using it.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};
globalThis.document ??= {
  querySelector: () => null, querySelectorAll: () => [],
  addEventListener() {}, body: { style: {}, appendChild() {} },
};
globalThis.window ??= { addEventListener() {} };
globalThis.matchMedia ??= () => ({ matches: false });

const { cacheLogo, getCachedLogo, tokenLogoHTML, logoKeyFor } = await import('../js/token-logo.js');

const REAL_USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const FAKE_USDC = '0x1111111111111111111111111111111111111111';
const OTHER_FAKE = '0x2222222222222222222222222222222222222222';
const COINGECKO = 'https://assets.coingecko.com/coins/images/6319/usdc.png';

test('a mark is keyed by contract address, with the symbol only as a label', () => {
  assert.equal(logoKeyFor({ address: REAL_USDC, symbol: 'usdc' }), REAL_USDC.toLowerCase(),
    'an address is the identity of a token; the symbol is a label on it');
  assert.equal(logoKeyFor({ address: FAKE_USDC, symbol: 'usdc' }), FAKE_USDC.toLowerCase(),
    'two contracts sharing a ticker must not share a key');
  assert.equal(logoKeyFor({ symbol: 'ETH' }), 'sym:eth',
    'a native coin has no contract, so its symbol is the only identity available');
});

test('a counterfeit contract never inherits the real project mark', () => {
  store.clear();
  cacheLogo(logoKeyFor({ address: REAL_USDC, symbol: 'USDC' }), COINGECKO);
  assert.equal(getCachedLogo(logoKeyFor({ address: REAL_USDC, symbol: 'USDC' })), COINGECKO,
    'the genuine contract must still get its mark');
  assert.equal(getCachedLogo(logoKeyFor({ address: FAKE_USDC, symbol: 'USDC' })), null,
    'a fake USDC contract picked up the real USDC mark — the mark is what users scan for');
});

test('two counterfeit contracts sharing a ticker do not share a mark either', () => {
  store.clear();
  cacheLogo(logoKeyFor({ address: FAKE_USDC, symbol: 'USDC' }), 'https://example.test/a.png');
  assert.equal(getCachedLogo(logoKeyFor({ address: OTHER_FAKE, symbol: 'USDC' })), null);
  assert.equal(getCachedLogo(logoKeyFor({ address: FAKE_USDC, symbol: 'USDC' })), 'https://example.test/a.png');
});

test('the legacy symbol-only cache entry is not honoured for a contract', () => {
  // A cache written by an older build keys by bare symbol. Reading it back for a
  // contract is exactly the leak being closed, so an old entry must not apply.
  store.clear();
  store.set('bear.logoCache', JSON.stringify({ usdc: { url: COINGECKO, ts: Date.now() } }));
  assert.equal(getCachedLogo(logoKeyFor({ address: FAKE_USDC, symbol: 'USDC' })), null,
    'a symbol-keyed entry from an older build leaked the mark onto an unrelated contract');
});

test('the rendered mark follows the address it is given', () => {
  store.clear();
  cacheLogo(logoKeyFor({ address: REAL_USDC, symbol: 'USDC' }), COINGECKO);
  const real = tokenLogoHTML('USDC', 32, { address: REAL_USDC });
  const fake = tokenLogoHTML('USDC', 32, { address: FAKE_USDC });
  assert.match(real, /<img[^>]+src="https:\/\/assets\.coingecko\.com/, 'the real contract shows the fetched mark');
  assert.doesNotMatch(fake, /coingecko/, 'a counterfeit contract must not render the real project mark');
});

test('a native coin still gets a mark, since it has no contract', () => {
  store.clear();
  cacheLogo('sym:eth', COINGECKO);
  assert.equal(getCachedLogo(logoKeyFor({ symbol: 'ETH' })), COINGECKO);
  assert.match(tokenLogoHTML('ETH', 32), /<img/, 'native ETH must still resolve a mark');
});

test('the generated mark is still used when nothing is cached', () => {
  store.clear();
  const html = tokenLogoHTML('ZZZ', 32, { address: FAKE_USDC });
  assert.match(html, /<svg/, 'an uncached token falls back to the generated mark');
  assert.doesNotMatch(html, /<img/, 'and to nothing fetched from the network');
});

// ── the hole the deployed-token report fell through (2026-10-08) ──────────
// The cache was addressed correctly, but an UNCACHED contract still fell to
// markSvg(), which dresses any ticker in its hand-tuned brand: a token you
// deploy named "USDC" rendered Circle's $ disc on sight, no network needed.
test('an uncached contract token never wears the hand-tuned brand for its ticker', () => {
  store.clear();
  const html = tokenLogoHTML('USDC', 32, { address: FAKE_USDC });
  assert.match(html, /<svg/, 'the counterfeit contract falls back to a generated mark');
  assert.doesNotMatch(html, /2775CA/, 'the USDC brand gradient is the real project\'s identity, not any ticker\'s');
  const native = tokenLogoHTML('USDC', 32); // no address: native identity IS the ticker
  assert.match(native, /2775CA/, 'a native coin still wears its hand-tuned mark');
});

test('a dead remote image falls back to the non-branded disc for a contract', () => {
  store.clear();
  cacheLogo(logoKeyFor({ address: FAKE_USDC, symbol: 'LINK' }), 'https://example.test/dead.png');
  const html = tokenLogoHTML('LINK', 32, { address: FAKE_USDC });
  assert.match(html, /data-mark-contract="1"/, 'the renderer tells the guard this mark belongs to a contract');
  assert.match(html, /data-mark-fallback="LINK"/, 'and which ticker the generated fallback should draw');
});
