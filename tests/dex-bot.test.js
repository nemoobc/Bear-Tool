// The market maker's rules, tested as rules.
//
// A bot has no user watching it. The only thing standing between a misconfigured
// band and money is this file, so it covers the cases that actually lose money:
// the boundary price, the budget one wei short, every wallet too poor, and a
// band so narrow it only triggers on rounding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  decide, nextAccount, budgetBps, bandUsable, stopReason,
  BUY, SELL, HOLD, STOP, WHY,
} from '../js/dex/bot-engine.js';

const Q = (n) => BigInt(Math.round(n * 1e18));
const base = (over = {}) => ({
  price: Q(1), floor: Q(0.9), ceil: Q(1.1),
  size: Q(0.1), quoteBal: Q(10), tokenBal: Q(10),
  spent: 0n, cap: 0n, graduated: false, ...over,
});

// ── the two sides ──────────────────────────────────────────────────
test('a price at or under the floor buys', () => {
  assert.equal(decide(base({ price: Q(0.9) })).action, BUY);
  assert.equal(decide(base({ price: Q(0.5) })).action, BUY);
  assert.equal(decide(base({ price: Q(0.9) })).why, WHY.BELOW_FLOOR);
});

test('a price at or over the ceiling sells', () => {
  assert.equal(decide(base({ price: Q(1.1) })).action, SELL);
  assert.equal(decide(base({ price: Q(2) })).action, SELL);
  assert.equal(decide(base({ price: Q(1.1) })).why, WHY.ABOVE_CEILING);
});

test('inside the band the bot holds, and says so', () => {
  const d = decide(base({ price: Q(1) }));
  assert.equal(d.action, HOLD);
  assert.equal(d.why, WHY.IN_BAND);
});

test('the boundaries are inclusive — a floor that needs a tick to fire never fires', () => {
  // Asymmetric rounding here means the price sits exactly on the boundary for a
  // whole second of wall time. A strict `<` would silently skip every tick in
  // that second and the user would call the bot broken.
  assert.equal(decide(base({ price: Q(0.9) })).action, BUY);
  assert.equal(decide(base({ price: Q(1.1) })).action, SELL);
});

// ── stopping is not the same as holding ───────────────────────────
test('a graduated coin stops the bot outright, whatever the price', () => {
  const d = decide(base({ price: Q(0.1), graduated: true }));
  assert.equal(d.action, STOP);
  assert.equal(d.why, WHY.GRADUATED);
});

test('the budget is a hard ceiling, down to the wei', () => {
  // The cap is a promise the user made when they funded the bot. Spending past
  // it because "it was only one wei" is how a bot that runs unattended ends up
  // spending money the user meant to keep.
  const over = decide(base({ price: Q(0.5), size: Q(0.1), spent: Q(0.9) + 1n, cap: Q(1) }));
  assert.equal(over.action, STOP, 'one wei past the cap must not trade');
  assert.equal(over.why, WHY.NO_BUDGET);

  const exact = decide(base({ price: Q(0.5), size: Q(0.1), spent: Q(0.9), cap: Q(1) }));
  assert.equal(exact.action, BUY, 'a trade that lands exactly on the cap must go through');

  const fits = decide(base({ price: Q(0.5), size: Q(0.1), spent: Q(0.899), cap: Q(1) }));
  assert.equal(fits.action, BUY, 'a trade that fits the cap must go through');

  assert.equal(decide(base({ price: Q(0.5), size: Q(0.1), spent: 0n, cap: 0n })).action, BUY,
    'no cap must never block a trade');
});

test('a zero cap means unlimited, not zero', () => {
  assert.equal(decide(base({ price: Q(0.5), spent: Q(1000), cap: 0n })).action, BUY);
});

test('a wallet with nothing to spend stops instead of promising a trade', () => {
  const d = decide(base({ price: Q(0.5), quoteBal: Q(0.05) }));
  assert.equal(d.action, STOP);
  assert.equal(d.why, WHY.NO_WALLET);
});

test('nothing to sell is a stop, not a silent no-op', () => {
  const d = decide(base({ price: Q(5), tokenBal: 0n }));
  assert.equal(d.action, STOP);
  assert.equal(d.why, WHY.NOTHING_TO_SELL);
});

test('an inverted band can never trade, and is reported rather than looped', () => {
  const d = decide(base({ floor: Q(2), ceil: Q(1), price: Q(1.5) }));
  assert.equal(d.action, HOLD);
  assert.equal(d.why, WHY.BAND_TOUCHED);
});

test('every stop maps to something the user can be told', () => {
  for (const why of [WHY.GRADUATED, WHY.NO_BUDGET, WHY.NO_WALLET, WHY.NOTHING_TO_SELL, WHY.BAND_TOUCHED]) {
    assert.ok(stopReason(why), `${why} must have a user-facing reason`);
  }
  assert.equal(stopReason(WHY.IN_BAND), null, 'holding is not a stop');
  assert.equal(stopReason(WHY.BELOW_FLOOR), null, 'trading is not a stop');
});

// ── address rotation ───────────────────────────────────────────────
const acc = (i, q, tk = 0n) => ({ index: i, address: '0x' + i, quoteBal: q, tokenBal: tk });

test('rotation moves through every funded wallet instead of reusing one', () => {
  const list = [acc(0, Q(10)), acc(1, Q(10)), acc(2, Q(10))];
  const picked = [];
  let cursor = 0;
  for (let i = 0; i < 6; i++) {
    const r = nextAccount(list, BUY, Q(1), cursor);
    assert.ok(r.account, 'a funded wallet must be found');
    picked.push(r.account.index);
    cursor = r.cursor;
  }
  assert.deepEqual(picked, [0, 1, 2, 0, 1, 2], 'every wallet must get a turn');
});

test('a wallet that cannot afford the trade is skipped, not retried forever', () => {
  // Without this filter the rotation would ask wallet 0 for money it does not
  // have, fail, and never reach the funded wallets behind it — the bot would
  // report "no wallet" while sitting on ten coins.
  const list = [acc(0, 0n), acc(1, Q(10))];
  const r = nextAccount(list, BUY, Q(1), 0);
  assert.ok(r.account);
  assert.equal(r.account.index, 1);
});

test('rotation checks the right coin for each side', () => {
  const list = [acc(0, Q(100), 0n), acc(1, 0n, Q(100))];
  assert.equal(nextAccount(list, BUY, Q(1), 0).account.index, 0, 'buying needs quote');
  assert.equal(nextAccount(list, SELL, Q(1), 0).account.index, 1, 'selling needs tokens');
});

test('no wallet at all is an answer, not a crash', () => {
  assert.equal(nextAccount([], BUY, Q(1), 0).account, null);
  assert.equal(nextAccount([acc(0, 0n)], BUY, Q(1), 0).account, null);
});

test('the cursor survives a negative or out-of-range value', () => {
  // Restored from storage, a cursor can be anything a corrupted write left
  // behind. The bot must still trade rather than indexing off the end.
  const list = [acc(0, Q(10)), acc(1, Q(10))];
  for (const c of [-5, 999, 0, 1]) {
    const r = nextAccount(list, BUY, Q(1), c);
    assert.ok(r.account, `cursor ${c} must still find a wallet`);
  }
});

// ── the progress bar ───────────────────────────────────────────────
test('budget is reported in basis points and never overflows its bar', () => {
  // BigInt, not a number: at 18 decimals a float would drift, and a progress
  // bar that reads 100% while a wei is left is the kind of lie users act on.
  assert.equal(budgetBps(0n, Q(10)), 0n);
  assert.equal(budgetBps(Q(5), Q(10)), 5000n);
  assert.equal(budgetBps(Q(10), Q(10)), 10000n);
  assert.equal(budgetBps(Q(11), Q(10)), 10000n, 'overspend cannot exceed the bar');
  assert.equal(budgetBps(Q(1), 0n), 0n, 'no cap means no bar to fill');
});

// ── the band must be usable before the bot is allowed to start ────
test('a band needs room between floor and ceiling', () => {
  assert.equal(bandUsable(Q(1), Q(2)), true);
  assert.equal(bandUsable(Q(2), Q(2)), false, 'floor == ceiling can never trade');
  assert.equal(bandUsable(Q(2), Q(1)), false);
  assert.equal(bandUsable(0n, Q(2)), false, 'a zero floor buys on any tick at all');
  assert.equal(bandUsable(Q(1), 0n), false);
});

test('the engine cannot spend, sign, or know about a wallet key', () => {
  // The brain is pure on purpose: it cannot move money even if it is wrong. The
  // code that sends transactions is elsewhere and has to be audited separately.
  const src = readFileSync(new URL('../js/dex/bot-engine.js', import.meta.url), 'utf8');
  for (const forbidden of ['privateKey', 'ethers.', 'signer', 'sendTransaction', 'localStorage', 'fetch(']) {
    assert.ok(!src.includes(forbidden), `the engine must never mention ${forbidden}`);
  }
});
