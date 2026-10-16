// Bear Tool — tests/dex-lp.test.js
//
// The Liquidity previews must mirror the contract's mint/burn rules to the
// wei, exactly like swapQuote mirrors the pair's swap math. The numbers below
// are hand-computed from the rules, not copied from the implementation:
//
//   mint: shares = min(quoteIn × supply / quoteReserve,
//                      tokenIn × supply / tokenReserve)   [floor]
//   burn: quoteOut = shares × quoteReserve / supply        [floor]
//         tokenOut = shares × tokenReserve / supply        [floor]
//   floors: amountOut × (10000 − bps) / 10000              [floor]
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

// A DOM from the start: the panel is mounted and driven exactly like the
// Swap-sheet tests drive the TradeSheet, and core.js reads localStorage when
// it loads.
const dom = new JSDOM('<!doctype html><html><body><div id="lpHost"></div></body></html>', { url: 'http://localhost/' });
const { window } = dom;
for (const key of ['window', 'document', 'localStorage', 'navigator', 'location',
  'HTMLElement', 'Node', 'CustomEvent', 'Event', 'getComputedStyle']) {
  try { Object.defineProperty(globalThis, key, { value: window[key] ?? window, configurable: true, writable: true }); } catch { /* getter-only global */ }
}

const { addPreview, removePreview, otherSideFromRatio, sharePctShift, imbalance, visibleExcess, addGate, lpHtml, bindLp } =
  await import('../js/dex/lp.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const W = (s) => new window.Event(s, { bubbles: true });

const E18 = 10n ** 18n;
// A launched pool: 500 quote / 800,000 token, supply = sqrt(500e18 × 800000e18)
// = 2e22 shares (the same shape the anvil e2e produces).
const RQ = 500n * E18;
const RT = 800_000n * E18;
const SUPPLY = 2n * 10n ** 22n;

test('addPreview mints the min of the two proportional claims (balanced)', () => {
  // quoteIn 100, tokenIn 160000 — exactly the reserves' ratio (1 : 1600):
  // s1 = 100e18 × 2e22 / 500e18 = 4e21;  s2 = 160000e18 × 2e22 / 800000e18 = 4e21
  const p = addPreview({ quoteIn: 100n * E18, tokenIn: 160_000n * E18, quoteReserve: RQ, tokenReserve: RT, supply: SUPPLY });
  assert.equal(p.ok, true);
  assert.equal(p.shares, 4n * 10n ** 21n, 'shares must be the shared proportional claim');
  // floor at 50 bps: 4e21 × 9950 / 10000 = 3.98e21
  assert.equal(p.minShares, 3_980_000_000_000_000_000_000n, 'minShares must be the 0.5% floor');
});

test('addPreview takes the WEAKER side — an unbalanced deposit mints less', () => {
  // tokenIn halved (80000 instead of 160000): s2 = 2e21 < s1 = 4e21
  const p = addPreview({ quoteIn: 100n * E18, tokenIn: 80_000n * E18, quoteReserve: RQ, tokenReserve: RT, supply: SUPPLY });
  assert.equal(p.ok, true);
  assert.equal(p.shares, 2n * 10n ** 21n, 'the weaker side is the claim — the rest is a gift to the pool');
});

test('removePreview returns both sides floored, with both minOut floors', () => {
  // shares 1e21 out of supply 2.5e22 back from reserves (600, 800000):
  // quoteOut = 1e21 × 600e18 / 2.5e22 = 2.4e19;  tokenOut = 1e21 × 800000e18 / 2.5e22 = 3.2e22
  const p = removePreview({ shares: 1n * 10n ** 21n, quoteReserve: 600n * E18, tokenReserve: 800_000n * E18, supply: 25n * 10n ** 21n });
  assert.equal(p.ok, true);
  assert.equal(p.quoteOut, 24_000_000_000_000_000_000n);
  assert.equal(p.tokenOut, 32_000_000_000_000_000_000_000n);
  assert.equal(p.minQuote, 23_880_000_000_000_000_000n, 'floor at 50 bps: × 9950 / 10000');
  assert.equal(p.minToken, 31_840_000_000_000_000_000_000n);
});

test('both previews refuse nonsense instead of inventing numbers', () => {
  assert.equal(addPreview({ quoteIn: 0n, tokenIn: 1n, quoteReserve: RQ, tokenReserve: RT, supply: SUPPLY }).reason, 'amounts');
  assert.equal(addPreview({ quoteIn: 1n, tokenIn: 1n, quoteReserve: RQ, tokenReserve: RT, supply: 0n }).reason, 'shares');
  assert.equal(removePreview({ shares: 0n, quoteReserve: RQ, tokenReserve: RT, supply: SUPPLY }).reason, 'amounts');
  assert.equal(removePreview({ shares: 1n, quoteReserve: 0n, tokenReserve: RT, supply: SUPPLY }).reason, 'reserves');
  // A deposit too small to mint even one share is refused, not rounded up.
  assert.equal(addPreview({ quoteIn: 1n, tokenIn: 1n, quoteReserve: RQ, tokenReserve: RT, supply: SUPPLY }).reason, 'too small');
});

// ── the clarity helpers (riset R10: "add liquidity bikin bingung") ────
// The contract mints min(quote claim, token claim): a lopsided deposit does
// not fail, it silently wastes the stronger side. These tests pin the exact
// numbers the panel teaches the user — ratio, share shift, and the excess.

test('otherSideFromRatio: a balanced deposit follows the reserves exactly', () => {
  // 1 quote = 1600 token at this pool (500 / 800,000): 100 quote → 160,000 token.
  const r = otherSideFromRatio(100n * E18, RQ, RT);
  assert.equal(r.ok, true);
  assert.equal(r.value, 160_000n * E18);
  // …and the reverse direction is the same ratio.
  assert.equal(otherSideFromRatio(160_000n * E18, RT, RQ).value, 100n * E18);
  // Floors, never rounds up: an up-round would over-deposit the user.
  assert.equal(otherSideFromRatio(1n, 3n, 10n).value, 3n);
  // Nonsense refused; strings are not amounts.
  assert.equal(otherSideFromRatio(0n, RQ, RT).ok, false);
  assert.equal(otherSideFromRatio(1n, 0n, RT).ok, false);
  assert.equal(otherSideFromRatio('100', RQ, RT).ok, false);
});

test('sharePctShift: mint and burn move the share in exact basis points', () => {
  // 4e21 minted on supply 2e22: after = 4e21 / 2.4e22 = 1666 bps = 16.66%.
  const mint = sharePctShift({ currentShares: 0n, delta: 4n * 10n ** 21n, supply: SUPPLY });
  assert.deepEqual(mint, { beforeBps: 0n, afterBps: 1666n });
  // Burning 1e21 out of a 2e21 position: 1000 bps → 1e21 / 1.9e22 = 526 bps.
  const burn = sharePctShift({ currentShares: 2n * 10n ** 21n, delta: -1n * 10n ** 21n, supply: SUPPLY });
  assert.deepEqual(burn, { beforeBps: 1000n, afterBps: 526n });
  // No movement, no supply, no opinion.
  assert.equal(sharePctShift({ currentShares: 0n, delta: 0n, supply: SUPPLY }), null);
  assert.equal(sharePctShift({ currentShares: 0n, delta: 1n, supply: 0n }), null);
});

test('imbalance: the excess is named in money — or the add is called balanced', () => {
  // 100 quote + 80,000 token against a pool needing 160,000: the token side is
  // weaker (2e21 < 4e21 claims), so exactly 50 quote buys nothing.
  const imb = imbalance({ quoteIn: 100n * E18, tokenIn: 80_000n * E18, quoteReserve: RQ, tokenReserve: RT, supply: SUPPLY });
  assert.equal(imb.balanced, false);
  assert.equal(imb.side, 'quote');
  assert.equal(imb.excess, 50n * E18);
  // Exact ratio: no scare line.
  assert.equal(imbalance({ quoteIn: 100n * E18, tokenIn: 160_000n * E18, quoteReserve: RQ, tokenReserve: RT, supply: SUPPLY }).balanced, true);
  // Token side over: double token (320,000) → 160,000 of it adds nothing.
  const tok = imbalance({ quoteIn: 100n * E18, tokenIn: 320_000n * E18, quoteReserve: RQ, tokenReserve: RT, supply: SUPPLY });
  assert.equal(tok.side, 'token');
  assert.equal(tok.excess, 160_000n * E18);
});

test('visibleExcess: floor dust never triggers a false "lopsided" warning', () => {
  // ±1 wei from Auto's floor — below 6 visible decimals → silence.
  assert.equal(visibleExcess(1n, 18), 0n);
  assert.equal(visibleExcess(10n ** 11n, 18), 0n, 'just below the displayable unit');
  // 10^12 wei = 0.000001 token — the first excess that shows as a number.
  assert.equal(visibleExcess(10n ** 12n, 18), 10n ** 12n);
  assert.equal(visibleExcess(1n, 6), 1n, 'at 6 decimals one wei IS the displayable unit');
  assert.equal(visibleExcess(0n, 18), 0n);
});

test('addGate: every refusal carries its reason, in a fixed order, happy path silent', () => {
  const base = {
    unlocked: true, qRaw: '100', tRaw: '160000',
    qParsed: { ok: true, value: 1n }, tParsed: { ok: true, value: 2n },
    qBal: 10n, tBal: 10n, qSym: 'ETH', tSym: 'BEAR', preview: { ok: true },
  };
  assert.equal(addGate({ ...base, unlocked: false }).reasonKey, 'dex.ts.reason.wallet');
  assert.equal(addGate({ ...base, qRaw: '' }).reasonKey, 'dex.swap.pickAmount');
  assert.equal(addGate({ ...base, qParsed: { ok: false } }).reasonKey, 'dex.ts.reason.invalid');
  assert.deepEqual(addGate({ ...base, qParsed: { ok: true, value: 11n } }),
    { disabled: true, reasonKey: 'dex.trade.insufficient', reasonArgs: { sym: 'ETH' } });
  assert.equal(addGate({ ...base, tParsed: { ok: true, value: 11n } }).reasonArgs.sym, 'BEAR');
  assert.equal(addGate({ ...base, preview: { ok: false, reason: 'too small' } }).reasonKey, 'dex.ts.reason.small');
  assert.equal(addGate({ ...base, preview: { ok: false, reason: 'reserves' } }).reasonKey, 'dex.ts.reason.empty');
  const happy = addGate(base);
  assert.equal(happy.disabled, false);
  assert.equal(happy.reasonKey, null);
});

// ── the panel in jsdom: dead ends lead back, grey always says why ────

const mountLp = async () => {
  const host = window.document.getElementById('lpHost');
  host.innerHTML = lpHtml();
  await bindLp(host);
  return host;
};

test('LP dead chain: CTAs disabled, the panel says why, retry is reachable', async () => {
  const host = await mountLp();
  for (const id of ['dexLpAddGo', 'dexLpRemoveGo', 'dexLpLockGo']) {
    assert.equal(host.querySelector(`#${id}`).disabled, true, `${id} cannot be live without a chain`);
  }
  assert.ok(host.querySelector('#dexLpNote').textContent.trim().length > 0, 'a dead panel must say why');
  assert.equal(host.querySelector('#dexLpRetry').hidden, false, 'and offer the way back');
});

test('the invariant: a disabled LP control never sits under an empty reason', async () => {
  const host = await mountLp();
  const pairs = [['dexLpAddGo', 'dexLpAddReason'], ['dexLpRemoveGo', 'dexLpRemoveReason'], ['dexLpLockGo', 'dexLpLockReason']];
  const note = host.querySelector('#dexLpNote').textContent.trim();
  for (const [btn, reason] of pairs) {
    const b = host.querySelector(`#${btn}`);
    const r = host.querySelector(`#${reason}`).textContent.trim();
    assert.ok(!b.disabled || r.length > 0 || note.length > 0, `${btn} disabled with no reason anywhere`);
  }
});

test('the clarity affordances exist before any chain read: Auto + ratio line + approve note', async () => {
  const host = await mountLp();
  assert.ok(host.querySelector('#dexLpAuto').textContent.trim().length > 0, 'Auto button labeled');
  assert.ok(host.querySelector('#dexLpRate') !== null && host.querySelector('#dexLpApproveNote') !== null,
    'ratio line and approve note present in the shell');
});

test('a comma is corrected in the LP fields themselves, visibly', async () => {
  const host = await mountLp(); // dead panel — the field rule holds regardless
  const qi = host.querySelector('#dexLpQuoteIn');
  qi.value = '0,5';
  qi.dispatchEvent(W('input'));
  assert.equal(qi.value, '0.5');
});

test('retry asks the chain again without crashing — and still tells the truth', async () => {
  const host = await mountLp();
  const retry = host.querySelector('#dexLpRetry');
  retry.click();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(retry.hidden, false);
  assert.ok(host.querySelector('#dexLpNote').textContent.trim().length > 0);
});

// ── source pins: the order that protects money ───────────────────────

test('the LP panel pins: confirm before anything is granted, gate before any disable', () => {
  const src = read('../js/dex/lp.js');
  const addHand = src.slice(src.indexOf("addBtn.addEventListener('click'"));
  assert.ok(addHand.indexOf('confirmTx(') > -1, 'add flow confirms first');
  assert.ok(addHand.indexOf('confirmTx(') < addHand.indexOf('addLiquidityTx('),
    'add: the user commits BEFORE shares are minted');
  const remHand = src.slice(src.indexOf("remBtn.addEventListener('click'"));
  assert.ok(remHand.indexOf('confirmTx(') > -1, 'remove flow confirms first');
  assert.ok(remHand.indexOf('confirmTx(') < remHand.indexOf('removeLiquidityTx('),
    'remove: the user commits BEFORE shares are burned');
  assert.match(src, /const g = addGate\(/, 'refreshAdd routes through the gate');
  assert.match(src, /addBtn\.disabled = g\.disabled/, 'the gate owns the add button');
  assert.match(src, /remBtn\.disabled = Boolean\(reasonKey\)/, 'the remove reason owns its button');
  assert.match(src, /retryBtn\.hidden = false/, 'dead ends expose the retry');
  assert.match(src, /otherSideFromRatio\(src\.value/, 'Auto follows the pool ratio');
  assert.match(src, /normalizeAmountInput/, 'comma keyboards are not a dead end here either');
});
