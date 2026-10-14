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

// ── the wiring between the panel and the app ────────────────────────
// Every gate above drives the engine directly, which is exactly why a broken
// link between the PANEL and the engine can stay green forever. The market
// maker shipped for a full test cycle with `token.signer` — a property no
// launched coin has — so start() refused with "the wallet is locked" on every
// device, while 12/12 on-chain checks reported success. These assertions are
// about wiring: what the panel reads, and from where.
test('the panel gets the signer from app state, never from the coin', () => {
  const src = readFileSync(new URL('../js/dex/bot.js', import.meta.url), 'utf8');
  assert.ok(!/token\.signer/.test(src),
    'a launched coin is metadata (address, name, symbol, creator) and carries NO signer — '
    + 'reading one from it is always undefined and the bot can never start');
  assert.match(src, /const master = get\('signer'\)/,
    'the signer comes from app state, which is where the app actually keeps it');
});

test('the panel reads nothing off the coin that a launched coin does not carry', () => {
  // Anything read as token.X must be a field the Dex genuinely stores. If a new
  // property appears here, the coin shape has to grow with it or the bot reads
  // undefined at runtime — quietly, and only when a user presses Start.
  const src = readFileSync(new URL('../js/dex/bot.js', import.meta.url), 'utf8');
  const used = new Set([...src.matchAll(/\btoken\.([a-zA-Z_$][\w$]*)/g)].map((m) => m[1]));
  // What js/dex/index.js and js/dex/tokens.js put on a coin object.
  const KNOWN = new Set(['address', 'name', 'symbol', 'creator', 'image', 'quoteToken']);
  for (const prop of used) {
    assert.ok(KNOWN.has(prop),
      `bot.js reads token.${prop}, which no launched coin carries — `
      + `a coin only ever has: ${[...KNOWN].join(', ')}`);
  }
});

test('every module the bot imports is actually exported by it', () => {
  // An import of a name that is not exported is a hard error at load time, but
  // only when that panel is first rendered — i.e. in the app, never in a test
  // that drives the engine directly.
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const bot = read('../js/dex/bot.js');
  const exportsOf = (src) => {
    const names = new Set();
    for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
    for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) {
      for (const part of m[1].split(',')) {
        const n = part.split(/\s+as\s+/).pop().trim();
        if (n) names.add(n);
      }
    }
    return names;
  };
  for (const m of bot.matchAll(/import\s*\{([^}]+)\}\s*from\s*'(\.[^']+)'/g)) {
    const rel = m[2];
    const target = new URL(rel, new URL('../js/dex/bot.js', import.meta.url)).pathname;
    const names = exportsOf(readFileSync(new URL(`file://${target}`), 'utf8'));
    for (const part of m[1].split(',')) {
      const n = part.trim();
      if (!n) continue;
      assert.ok(names.has(n),
        `bot.js imports { ${n} } from ${rel}, which does not export it — the panel throws the first time a coin is opened`);
    }
  }
});

// ── the two sides are not the same unit ────────────────────────────
// The engine used one `size` for both, read as a QUOTE amount for a buy and a
// TOKEN amount for a sell. With the default 0.01 that made each sell about
// 1e-11 quote, so a two-sided band could only go one way: the bot bought and
// never unwound, while draining its budget. The docstring even said so.
test('a buy spends quote and a sell gives up tokens, so the sizes must differ', () => {
  const d = decide(base({
    price: Q(0.5), size: Q(1),
    sizeIn: Q(1),                 // 1 quote per buy
    sizeOut: Q(1000000),          // 1M tokens per sell — the same VALUE, not the same number
    quoteBal: Q(10), tokenBal: Q(1000000),
  }));
  assert.equal(d.action, BUY);
  assert.equal(d.amount, Q(1), 'a buy must be denominated in quote');
});

test('the budget is a quote budget, so a sell must not spend it', () => {
  const room = Q(1);
  // Almost no budget left, but plenty of tokens. Selling costs no quote, so the
  // bot must still be allowed to sell — checking the cap against the sell size
  // stopped it from ever unwinding.
  const d = decide(base({
    price: Q(5), size: Q(1), sizeIn: Q(1), sizeOut: Q(1000),
    quoteBal: Q(10), tokenBal: Q(1000),
    spent: room, cap: room,
  }));
  assert.equal(d.action, SELL, 'a sell must not be blocked by an exhausted quote budget');
  assert.equal(d.why, WHY.ABOVE_CEILING);
});

test('an exhausted quote budget still stops a buy', () => {
  const d = decide(base({
    price: Q(0.5), size: Q(1), sizeIn: Q(1), sizeOut: Q(1000),
    quoteBal: Q(10), tokenBal: Q(1000),
    spent: Q(1), cap: Q(1),
  }));
  assert.equal(d.action, STOP);
  assert.equal(d.why, WHY.NO_BUDGET);
});

// ── a start in progress ─────────────────────────────────────────────
// start() guards on `if (R)`, but R is not assigned until after the curve
// read, the confirm sheet, derivation and the funding transfers. Two clicks in
// that window both passed the guard: two confirm sheets, the budget paid out
// twice, and the second run overwriting the first — which was already holding a
// live timer and kept trading against an object the UI could no longer see.
test('a start in progress blocks a second one', () => {
  const src = readFileSync(new URL('../js/dex/bot.js', import.meta.url), 'utf8');
  assert.match(src, /let starting = false/, 'there must be an in-flight flag');
  assert.match(src, /if \(starting\)/, 'and start() must check it');
  // It has to be cleared on EVERY exit, including the early returns for an
  // invalid band, a locked wallet and a failed funding.
  assert.match(src, /finally \{[\s\S]{0,80}starting = false/,
    'the flag must be released in a finally — a plain assignment is skipped by the early returns');
  assert.ok(!/if \(!sent\) \{ stop\(t\('dex\.bot\.fundFailed'\)\) \)/.test(src),
    'stop() is a no-op before the runner exists, so a funding failure must report itself');
});

test('the market maker and the pool say what the size is denominated in', () => {
  // The UI offered one "Each trade" field whose unit differed per side. That is
  // a number the user cannot reason about.
  const src = readFileSync(new URL('../js/dex/bot.js', import.meta.url), 'utf8');
  assert.match(src, /sizeOut|sizeIn/, 'the runner must pass the two sizes the engine now distinguishes');
  const i18n = readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');
  assert.match(i18n, /dex\.bot\.size': '[^']*quote/i,
    'the label must say the figure is a quote amount, or it is a unit the user has to guess');
});
