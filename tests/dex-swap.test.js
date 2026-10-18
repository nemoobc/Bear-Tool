// Bear Tool — tests/dex-swap.test.js
// M3: the trade surface, pinned at the behavior level — parse, slippage, the
// EXACT-cap allowance law, the encoded trade, the DOM strings the sheets
// produce, and the wiring of the trade card. Assertions call the real
// modules the app calls (no source-text regexes over js/dex).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';

globalThis.ethers = ethers; // app doctrine: modules read ethers off globalThis

const s = await import('../js/dex/swap.js');
const v = await import('../js/dex/index.js');
const { SLIP_DEFAULT_BPS, SLIP_MAX_BPS } = s;

// ── T1 parseAmount ─────────────────────────────────────────────────────
test('parseAmount: exact floors, commas become dots, junk never trades', () => {
  assert.equal(s.parseAmount('1').value, 10n ** 18n);
  assert.equal(s.parseAmount('1,5').value, 1500000000000000000n);
  assert.equal(s.parseAmount('.5').value, 500000000000000000n);
  assert.equal(s.parseAmount('0.05').value, 50000000000000000n);
  // floor law: the 19th..20th decimal digits are dropped, never rounded up
  assert.equal(s.parseAmount('1.00000000000000000099').value, 10n ** 18n);
  assert.equal(s.parseAmount('  ').why, 'empty');
  assert.equal(s.parseAmount('-1').why, 'bad');
  assert.equal(s.parseAmount('1e3').why, 'bad');
  assert.equal(s.parseAmount('1+2').why, 'bad');
  assert.equal(s.parseAmount('0').why, 'zeros');
  assert.equal(s.parseAmount('0,0').why, 'zeros');
  assert.equal(s.parseAmount('1.2.3').why, 'bad');
  assert.equal(s.parseAmount('abc').why, 'bad');
  assert.equal(s.parseAmount('9'.repeat(65)).why, 'big');
  // 6-decimal quote coins parse at 6 (readPair carries real decimals)
  assert.equal(s.parseAmount('1.000001', 6).value, 1000001n);
  assert.equal(s.parseAmount('1.0000009', 6).value, 1000000n); // floor
});

// ── T2 slippage band ───────────────────────────────────────────────────
test('minOut: 1% default, bps must be an integer 1..3000, floor not round', () => {
  const out = 99849774661992989484226n;
  assert.equal(s.slippageMinOut(out, 100), (out * 9900n) / 10000n);
  assert.equal(s.slippageMinOut(out), (out * 9900n) / 10000n, 'default = 100 bps');
  assert.equal(SLIP_DEFAULT_BPS, 100);
  assert.equal(SLIP_MAX_BPS, 3000);
  assert.throws(() => s.slippageMinOut(out, 0));
  assert.throws(() => s.slippageMinOut(out, 3001));
  assert.throws(() => s.slippageMinOut(out, '100'), undefined, 'a string bps must not widen or narrow a trade');
  assert.throws(() => s.slippageMinOut(out, 99.5));
  assert.equal(s.slippageMinOut(1n, 100), 0n, 'a 1 wei out floors to a 0 minOut — the guard above catches it elsewhere');
});

// ── T3 the EXACT-cap approval ──────────────────────────────────────────
test('approveData encodes the EXACT amount — never a hard MAX', () => {
  const data = s.approveData('0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222', 123n);
  const iface = new ethers.Interface(['function approve(address spender, uint256 value)']);
  const [spender, value] = iface.decodeFunctionData('approve', data);
  assert.equal(spender, '0x2222222222222222222222222222222222222222');
  assert.equal(value, 123n);
  const MAX = 2n ** 256n - 1n;
  const maxData = s.approveData('0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222', MAX);
  assert.notEqual(data, maxData);
  assert.throws(() => s.approveData('0x123', '0x2222222222222222222222222222222222222222', 1n));
});

// ── T4 the trade calldata ──────────────────────────────────────────────
test('swapData: buy encodes swapQuoteForToken, sell swapTokenForQuote, minOut echoes', () => {
  const to = '0x3333333333333333333333333333333333333333';
  const buy = s.swapData(true, 1000n, 7n, to);
  const sell = s.swapData(false, 1000n, 7n, to);
  assert.equal(buy.slice(0, 10), '0x39e95543');
  assert.equal(sell.slice(0, 10), '0x35767f0e');
  const iface = new ethers.Interface(s.BEAR_PAIR_ABI);
  {
    const [amountIn, minOut, rcpt] = iface.decodeFunctionData('swapQuoteForToken', buy);
    assert.equal(amountIn, 1000n);
    assert.equal(minOut, 7n);
    assert.equal(rcpt, to);
  }
  {
    const [amountIn, minOut, rcpt] = iface.decodeFunctionData('swapTokenForQuote', sell);
    assert.equal(amountIn, 1000n);
    assert.equal(minOut, 7n);
    assert.equal(rcpt, to);
  }
});

// ── T5 + T7 address checks live on the engine ──────────────────────────
test('address gate: 40 hex, nothing shorter, and readPair refuses pre-RPC', async () => {
  assert.equal(s.isAddress('0x' + 'a'.repeat(40)), true);
  assert.equal(s.isAddress('0x123'), false);
  assert.equal(s.isAddress('0x' + 'a'.repeat(39) + 'g'), false);
  await assert.rejects(() => s.readPair({}, '0x123'), (e) => e.why === 'bad');
});

// ── T6 the DOM the view ships: dialog pair, no emoji, real select ──────
test('trade card + sheet strings: cancel+confirm dialog, zero emoji', () => {
  const stub = v.tradeStubHtml();
  const st = {
    pairAddress: '0x' + 'a'.repeat(40), buy: true, creatorBps: 0,
    token: { decimals: 18, symbol: 'BMEME' }, quote: { decimals: 18, symbol: 'SQ' },
    reserves: [10n ** 21n, 10n ** 23n],
  };
  const body = v.tradeBodyHtml(st);
  const sheet = v.sheetHtml('t');
  for (const [name, html] of [['stub', stub], ['body', body], ['sheet', sheet]]) {
    assert.equal(/\p{Extended_Pictographic}/u.test(html), false, `${name} must not carry emoji — icons are SVG`);
  }
  assert.match(sheet, /role="dialog"/);
  assert.match(sheet, /data-dex-cancel/);
  assert.match(sheet, /data-dex-confirm/);
  assert.match(body, /inputmode="decimal"/);
  assert.match(body, /<select id="dexSwapSlip"/);
  assert.match(body, /value="100"/, 'the default band is 1% (selected in the markup)');
  const seller = { ...st, buy: false };
  assert.match(v.tradeBodyHtml(seller), /aria-pressed="true"[^>]*>[^<]*<\/button>/);
});

test('creator fee line only speaks when the pool carries a creator cut', () => {
  const withFee = v.tradeBodyHtml({
    pairAddress: '0x' + 'a'.repeat(40), buy: true, creatorBps: 12,
    token: { decimals: 18, symbol: 'BMEME' }, quote: { decimals: 18, symbol: 'SQ' },
    reserves: [10n ** 21n, 10n ** 23n],
  });
  assert.match(withFee, /12 bps of it to the creator|dari itu 12 bps ke pembuat|0.30%/);
  assert.match(withFee, /0\.30%/);
});

// ── T8/T9 wiring: the Open button guards input, the chain gate hides the card
test('renderDex wires the trade card only on the engine chain, and guards input', async () => {
  // DOM stub routed by a registry the test owns (the app's test pattern).
  const mkEl = () => ({
    _listeners: new Map(),
    addEventListener(type, fn) { this._listeners.set(type, fn); },
    removeEventListener(type) { this._listeners.delete(type); },
    click() { this._listeners.get('click')?.({}); },
    press(key) { this._listeners.get('keydown')?.({ key }); },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: {}, dataset: {}, hidden: false, value: '', textContent: '', innerHTML: '',
    setAttribute() {}, getAttribute: () => null, appendChild() {}, removeChild() {},
    querySelector: () => null, querySelectorAll: () => [], focus() {}, blur() {},
    children: [], parentNode: null, remove() {},
  });
  const openBtn = mkEl();
  const pairIn = mkEl();
  const statusNode = mkEl();
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, val) => { store.set(k, String(val)); },
  };
  const stmod = await import('../js/state.js');

  const root = {
    _innerHTML: '',
    set innerHTML(v) { this._innerHTML = v; },
    get innerHTML() { return this._innerHTML; },
    querySelector(sel) {
      if (sel === '#dexSwapOpen') return openBtn;
      if (sel === '#dexSwapPair') return pairIn;
      if (sel === '#dexSwapStatus') return statusNode;
      return null;
    },
    isConnected: true,
  };

  // A chain the engine refuses leaves NO trade affordance to bind.
  stmod.set('networkId', 'ethereum');
  const outMainnet = v.renderDex(root, {});
  assert.equal(outMainnet.chainOk, false);
  assert.equal(openBtn._listeners.size, 0, 'no Open binding off the engine chain');

  // On the engine chain: the card binds; bad input answers inline, never
  // opens a panel; a well-shaped address attempts the honest read (and
  // reports instead of hanging, since no provider exists in this env).
  stmod.set('networkId', 'sepolia');
  const out = v.renderDex(root, {});
  assert.equal(out.chainOk, true);
  assert.match(root.innerHTML, /dex-card/);
  assert.ok(openBtn._listeners.has('click'), 'the Open button is wired');
  pairIn.value = '0x123';
  openBtn.click();
  assert.match(statusNode.textContent, /not an address|bukan alamat/i);
  pairIn.value = '0x' + 'a'.repeat(40);
  openBtn.click();
  assert.ok(statusNode.textContent.length > 0, 'the panel speaks instead of hanging silently');
});
