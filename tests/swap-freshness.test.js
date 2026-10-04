// Bear Tool — tests/swap-freshness.test.js
//
// Two ways a swap can be signed for something the user did not agree to:
//
//   1. STALE PAIR — the quote snapshot carries `toToken` (written at quote
//      time) and nothing ever read it back, so a confirmation for token-in A
//      could broadcast a route built for token-out B. The amount and token-in
//      were checked; the other half of the pair was not.
//   2. NO BALANCE — the approve was broadcast before anyone asked whether the
//      wallet actually holds the token, so the user paid gas for an approval
//      that the router then refused.
//
// The first half of this file pins the source shape (the same device the other
// swap tests use); the second half DRIVES the guard, because a textual
// assertion can only say the comparison is written, not that it rejects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const swapSrc = fs.readFileSync(new URL('../js/swap.js', import.meta.url), 'utf8');

// ── 1. the stale guard reads BOTH halves of the pair ─────────────────────────
test('swap: the stale guard checks toToken, not only fromToken', () => {
  const at = swapSrc.indexOf('export function assertQuoteFresh(');
  assert.ok(at > -1, 'assertQuoteFresh must exist');
  const body = swapSrc.slice(at, swapSrc.indexOf('// ── execute swap ──', at));
  assert.match(body, /quote\.toToken && quote\.toToken !== to/,
    'toToken is written into the quote but was never read back');
  assert.match(body, /throw new Error\('Quote stale — ulangi swap'\)/,
    'a mismatched output token must stop the swap with that message');
  assert.match(body, /quote\.fromToken && quote\.fromToken !== from/,
    'token-in check must survive');
  assert.match(body, /Number\(quote\.chainId\) !== Number\(chainId\)/,
    'the chain the quote was built on is part of the same guard');
  assert.match(body, /quote\.amountInWei !== wantWei/,
    'so is the amount');
});

test('swap: doSwap runs the guard BEFORE the dialogs and again before broadcast', () => {
  const start = swapSrc.indexOf('export async function doSwap()');
  assert.ok(start > -1, 'doSwap must exist');
  const body = swapSrc.slice(start, swapSrc.indexOf('\n// ═══', start) > 0
    ? swapSrc.indexOf('\n// ═══', start) : swapSrc.length);

  const call = body.indexOf('assertQuoteFresh(quote, { from, to');
  assert.ok(call > -1, 'doSwap must call the guard');
  const second = body.indexOf('assertQuoteFresh(quote, { from, to', call + 1);
  assert.ok(second > -1, 'the guard must be re-run at execution time');

  const runTxAt = body.indexOf("await runTx('swap'");
  assert.ok(runTxAt > -1, 'runTx must exist');
  assert.ok(call < runTxAt, 'the pair is checked before the confirmation dialogs');
  assert.ok(second > runTxAt, 'and again inside runTx, right before anything is broadcast');

  const approveAt = body.indexOf('c.approve(');
  assert.ok(approveAt > -1, 'the approve call must exist');
  assert.ok(second < approveAt, 'the re-check sits before the approve broadcast');

  // The guard throws, so its failure reaches the user as a toast rather than
  // as an unhandled rejection from a click handler.
  assert.match(body, /catch \(e\) \{\s*return toast\(e\?\.message \|\| 'Quote stale — ulangi swap', 'error'\)/,
    'the guard is called through a try/catch that toasts');
});

// ── 2. balance is read before anything is approved ──────────────────────────
test('swap: doSwap reads balanceOf before it approves', () => {
  const start = swapSrc.indexOf('export async function doSwap()');
  const body = swapSrc.slice(start);
  const bal = body.indexOf('c.balanceOf(userAddr)');
  const allowance = body.indexOf('c.allowance(userAddr');
  const approve = body.indexOf('c.approve(');
  assert.ok(bal > -1, 'the token balance must be read locally');
  assert.ok(allowance > bal, 'balance is read before the allowance');
  assert.ok(approve > bal, 'balance is read before the approval');
  assert.match(body, /const bal = await c\.balanceOf\(userAddr\);[\s\S]{0,400}if \(bal < amountWei\)/,
    'the read must be a GUARD, not a value nobody compares');
  assert.match(body, /throw new Error\(\s*`Insufficient \$\{dispSym\(from\)\} balance/,
    'and the refusal must say which token is short');
  // the guard sits inside the ERC-20 branch (native/wrap needs no allowance)
  const branchAt = body.indexOf("if (from !== 'native' && !quote.wrap) {");
  assert.ok(branchAt > -1 && branchAt < bal,
    'the balance guard belongs to the ERC-20 approve branch');
});

// ── 3. the guard actually rejects (drive it, don't just read it) ────────────
test('swap: assertQuoteFresh refuses a quote built for another output token', async () => {
  const { ethers } = await import('ethers');
  globalThis.ethers = ethers;
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  const mkEl = () => ({
    value: '', innerHTML: '', dataset: {}, style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, removeAttribute() {}, appendChild() {}, remove() {},
    addEventListener() {}, removeEventListener() {}, querySelector: () => null,
    querySelectorAll: () => [], focus() {}, options: [], isConnected: true,
  });
  const els = new Map();
  globalThis.document = {
    querySelector(sel) { if (!els.has(sel)) els.set(sel, mkEl()); return els.get(sel); },
    querySelectorAll: () => [],
    getElementById: (id) => globalThis.document.querySelector(`#${id}`),
    createElement: mkEl,
    addEventListener() {}, body: mkEl(),
  };
  const swap = await import('../js/swap.js');

  const quote = {
    simulated: false,
    amountInWei: '1000000000000000000',
    fromToken: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    toToken: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    chainId: 1,
  };
  const form = {
    from: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    to: '0xcccccccccccccccccccccccccccccccccccccccc',   // form moved on
    chainId: 1,
    wantWei: '1000000000000000000',
  };
  const good = { ...form, to: quote.toToken };
  assert.equal(swap.assertQuoteFresh(quote, good), true,
    'a matching pair passes');
  assert.throws(() => swap.assertQuoteFresh(quote, form),
    /Quote stale — ulangi swap/,
    'a quote built for token-out B must not be broadcast for token-out C');

  // …and the untouched guards still reject the way they used to.
  assert.throws(() => swap.assertQuoteFresh(quote, { ...good, wantWei: '1' }),
    /Quote is stale — waiting for a fresh one/, 'amount moved → stale');
  assert.throws(() => swap.assertQuoteFresh(quote, { ...good, from: '0xdead' }),
    /Quote is for a different token — re-quote/, 'token-in moved → re-quote');
  assert.throws(() => swap.assertQuoteFresh(quote, { ...good, chainId: 56 }),
    /Quote is from another network — re-quote/, 'chain moved → re-quote');
  assert.throws(() => swap.assertQuoteFresh(null, form), /Get a quote first/);
});
