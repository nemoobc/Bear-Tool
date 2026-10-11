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
const SAMPLE_URL = 'https://example.com/token-usdc.png';

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
  cacheLogo(logoKeyFor({ address: REAL_USDC, symbol: 'USDC' }), SAMPLE_URL);
  assert.equal(getCachedLogo(logoKeyFor({ address: REAL_USDC, symbol: 'USDC' })), SAMPLE_URL,
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
  store.set('bear.logoCache', JSON.stringify({ usdc: { url: SAMPLE_URL, ts: Date.now() } }));
  assert.equal(getCachedLogo(logoKeyFor({ address: FAKE_USDC, symbol: 'USDC' })), null,
    'a symbol-keyed entry from an older build leaked the mark onto an unrelated contract');
});

test('the rendered mark follows the address it is given', () => {
  store.clear();
  cacheLogo(logoKeyFor({ address: REAL_USDC, symbol: 'USDC' }), SAMPLE_URL);
  const real = tokenLogoHTML('USDC', 32, { address: REAL_USDC });
  const fake = tokenLogoHTML('USDC', 32, { address: FAKE_USDC });
  assert.match(real, /<img[^>]+src="https:\/\/example\.com/, 'the real contract shows the fetched mark');
  assert.doesNotMatch(fake, /example\.com/, 'a counterfeit contract must not render the real project mark');
});

test('a native coin still gets a mark, since it has no contract', () => {
  store.clear();
  cacheLogo('sym:eth', SAMPLE_URL);
  assert.equal(getCachedLogo(logoKeyFor({ symbol: 'ETH' })), SAMPLE_URL);
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

// ── the bundled-registry exception (report 2026-10-11 "logo list coin ga ada") ──
// Every CURATED token in js/network.js is a contract, so the counterfeit guard
// above stripped EVERY dashboard token down to the flat peach disc until a
// DexScreener image arrived — offline that never happened, and the list read as
// "no logos". The guard exists for tokens the USER adds; the wallet's own
// registry cannot be counterfeited, and the caller says so with bundled:true.
test('a bundled registry token wears its brand offline; a user-added one keeps the guard', () => {
  store.clear();
  const bundled = tokenLogoHTML('USDT', 32, { address: REAL_USDC, bundled: true });
  assert.match(bundled, /26A17B/, 'the curated USDT contract renders its brand mark with no network');
  const userAdded = tokenLogoHTML('USDT', 32, { address: FAKE_USDC });
  assert.doesNotMatch(userAdded, /26A17B/, 'a user-added contract still gets the counterfeit guard');
});

test('the marks bundling needs exist: chain natives + the popular curated tickers', () => {
  store.clear();
  for (const sym of ['BTC', 'SOL', 'XRP']) {
    assert.match(tokenLogoHTML(sym, 24, { remote: false }), /url\(#/,
      `${sym} native needs its own mark (receive cards wear it)`);
  }
  for (const sym of ['SHIB', 'ARB', 'OP', 'PEPE', 'CRV', 'SNX', 'SUSHI', 'COMP', 'MKR', 'LDO', 'WETH']) {
    assert.match(tokenLogoHTML(sym, 24, { remote: false, bundled: true }), /url\(#/,
      `bundled ${sym} needs a brand mark, not the peach disc`);
  }
});

test('the bundled flag comes from the registry check, never a blind true', async () => {
  // A blind `bundled: true` at a call site that ALSO receives user tokens would
  // hand a counterfeit ticker the real project's mark — the exact hole this
  // module exists to close (the asset list carries the user's own added
  // tokens; so does the send/swap picker). The flag must be the registry check.
  const { readFileSync } = await import('node:fs');
  const { isBundledContract } = await import('../js/network.js');
  assert.equal(isBundledContract(null), true, 'a native coin is bundled (nothing to counterfeit)');
  assert.equal(isBundledContract(REAL_USDC), true, 'the curated USDC address is bundled');
  assert.equal(isBundledContract(FAKE_USDC), false, 'a user-added contract is NOT bundled');
  const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
  const picker = readFileSync(new URL('../js/token-picker.js', import.meta.url), 'utf8');
  assert.match(app, /bundled: isBundledContract\(t\.address\)/, 'asset list checks the registry per token');
  assert.match(app, /bundled: isBundledContract\(address\)/, 'token modal checks the registry');
  assert.match(picker, /bundled: isBundledContract\(token\.address\)/, 'token picker checks the registry');
  assert.doesNotMatch(app, /bundled: true/, 'no blind bundled:true left in app.js');
  assert.doesNotMatch(picker, /bundled: true/, 'no blind bundled:true left in the picker');
});
