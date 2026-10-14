// ═══════════════════════════════════════════════════════════════
// Bear Tool — js/dex/bot-engine.js
// The market maker's BRAIN, with no browser in it.
//
// This file decides things. It does not send anything, read the chain, or know
// what a DOM is. That split is deliberate: every rule a market maker lives or
// dies by — when to buy, when to sell, when to stop, which wallet pays — is a
// pure function of numbers, so it can be tested against every awkward case
// (price at exactly the floor, budget one wei short, all wallets empty) without
// a chain, a browser, or a coin.
//
// The rules, in one place, because a market maker that trades "roughly around
// the band" is a market maker that will eventually buy the top and sell the
// bottom:
//
//   BUY   price <= floor   → buy size, from the rotating wallet
//   SELL  price >= ceil    → sell size, from the rotating wallet
//   HOLD  anything in between, or not funded, or not enough token to sell
//
// A two-sided band is the honest shape of market making. One-sided upward
// pushing is not market making; it is a directional bet wearing the name, and
// it is called out in the UI rather than hidden behind a "mode" dropdown.
//
// ── What this is not ────────────────────────────────────────────────────
// It is not liquidity provision and it does not make volume look bigger than
// it is. If every wallet in the rotation belongs to the same person and the
// only coin traded is that person's coin, then this is self-dealing, and any
// exchange, auditor or buyer who looks at it will read it exactly that way.
// So decide() cannot tell a healthy two-sided book from a one-sided push —
// that judgement belongs to the person running it, and the UI says so out loud
// rather than presenting a loss as a strategy.
// ═══════════════════════════════════════════════════════════════

export const BUY = 'buy';
export const SELL = 'sell';
export const HOLD = 'hold';
export const STOP = 'stop';

// Why a decision was made. Every outcome carries one, because "it did nothing"
// is the outcome users most need explained — a silent bot is indistinguishable
// from a broken one, and that ambiguity is how people leave money running in a
// loop they do not understand.
export const WHY = {
  BELOW_FLOOR: 'belowFloor',
  ABOVE_CEILING: 'aboveCeiling',
  IN_BAND: 'inBand',
  NO_BUDGET: 'noBudget',
  NOTHING_TO_SELL: 'nothingToSell',
  GRADUATED: 'graduated',
  NO_WALLET: 'noWallet',
  BAND_TOUCHED: 'bandTouched',   // floor >= ceil — nothing can ever trigger
};

/**
 * One tick of the loop. Pure: same input, same decision, forever.
 *
 * @param {object} p
 * @param {bigint} p.price        current spot price, quote per token (18dp)
 * @param {bigint} p.floor        buy below this
 * @param {bigint} p.ceil         sell above this
 * @param {bigint} p.size         default amount for both sides, when no
 *                                per-side size is given
 * @param {bigint} p.sizeIn       QUOTE amount for a buy (overrides size)
 * @param {bigint} p.sizeOut      TOKEN amount for a sell (overrides size)
 * @param {bigint} p.quoteBal     quote coin the chosen wallet holds
 * @param {bigint} p.tokenBal     the token that chosen wallet holds
 * @param {bigint} p.spent        quote already spent since the bot started
 * @param {bigint} p.cap          total quote the user funded (0 = unlimited)
 * @param {boolean} p.graduated
 * @returns {{action: string, why: string, amount: bigint}}
 */
export function decide(p) {
  const {
    price, floor, ceil, size,
    sizeIn, sizeOut,
    quoteBal = 0n, tokenBal = 0n, spent = 0n, cap = 0n,
    graduated = false,
  } = p;

  // Order matters. Each early return is a fact the user needs more than the
  // next one: a graduated coin cannot be traded at all, and saying "price is in
  // band" when the coin has graduated hides the real reason.
  if (graduated) return stop(WHY.GRADUATED);

  // A band with floor >= ceil is satisfiable by nothing. Run it anyway and the
  // bot will either trade every tick or never; both are the user's mistake, and
  // the UI blocks it, so this is the backstop rather than the guard.
  if (floor >= ceil) return { action: HOLD, why: WHY.BAND_TOUCHED, amount: 0n };

  // The cap is the user's promise to themselves ("once I fund it, that is all
  // it may ever spend"). It is checked before any trade, never after.
  // The cap is denominated in quote, so it is checked against the QUOTE size —
  // a sell costs nothing from the budget. Checking it against the sell size
  // would have let a bot stop trading because of tokens it was not spending.
  const quoteSpend = (price <= floor && floor < ceil) ? (sizeIn ?? size) : 0n;
  if (cap > 0n && spent + quoteSpend > cap) return stop(WHY.NO_BUDGET);

  // The two sizes are SEPARATE and must not be the same number. A buy spends
  // quote; a sell gives up tokens. Using one figure for both made each sell
  // ~10^12 times smaller than each buy: a bot configured with "0.01" bought with
  // 0.01 quote and sold 0.01 TOKEN — about 1e-11 quote — so it could never
  // meaningfully unwind what it bought, and drained its budget on one-way buys.
  // A two-sided band that can only go one way is not market making.
  const buySize = sizeIn ?? size;
  const sellSize = sizeOut ?? size;

  if (price <= floor) {
    if (quoteBal < buySize) return stop(WHY.NO_WALLET);
    return { action: BUY, why: WHY.BELOW_FLOOR, amount: buySize };
  }

  if (price >= ceil) {
    if (tokenBal < sellSize) return stop(WHY.NOTHING_TO_SELL);
    return { action: SELL, why: WHY.ABOVE_CEILING, amount: sellSize };
  }

  return { action: HOLD, why: WHY.IN_BAND, amount: 0n };
}

const stop = (why) => ({ action: STOP, why, amount: 0n });

/**
 * Pick the wallet that pays this trade.
 *
 * Round-robin, filtered to wallets that can actually afford it. That filter is
 * the whole point of rotating addresses: a wallet with no quote cannot be asked
 * to pay, and skipping it is what makes rotation useful instead of decorative.
 *
 * Accounts are tried in rotation order starting after `cursor`, and the cursor
 * advances past whoever was picked — so the load spreads across every funded
 * wallet rather than hammering the first one and starving when it runs dry.
 *
 * @param {Array<{index:number, address:string, quoteBal:bigint, tokenBal:bigint}>} accounts
 * @param {'buy'|'sell'} side
 * @param {bigint} need     quote for a buy, tokens for a sell
 * @param {number} cursor
 * @returns {{account: object|null, cursor: number}}
 */
export function nextAccount(accounts, side, need, cursor = 0) {
  const list = accounts.filter(Boolean);
  if (!list.length) return { account: null, cursor };

  const affordable = list.filter((a) => {
    const bal = side === BUY ? a.quoteBal : a.tokenBal;
    return bal >= need && bal > 0n;
  });
  if (!affordable.length) return { account: null, cursor };

  const start = ((cursor % list.length) + list.length) % list.length;
  for (let i = 0; i < list.length; i++) {
    const cand = list[(start + i) % list.length];
    if (affordable.includes(cand)) {
      return { account: cand, cursor: (start + i + 1) % list.length };
    }
  }
  return { account: null, cursor };
}

/**
 * The one number the user actually reads: how much of what they funded is gone.
 * Returns basis points so a progress bar needs no floating point at 18dp.
 */
export function budgetBps(spent, cap) {
  // Always a BigInt, on every path. The early return used to hand back a plain
  // number, so the one case that runs when there is no cap — the case a bot
  // with unlimited funds hits on its very first tick — returned a different
  // type from every other call, and the caller's arithmetic threw.
  if (cap <= 0n) return 0n;
  const bps = (spent * 10_000n) / cap;
  return bps > 10_000n ? 10_000n : bps;
}

/**
 * A band is only usable when it has room to be hit on both sides. A bot whose
 * floor sits above its ceiling will never trade; one whose band is a sliver will
 * trade on noise alone. The UI uses this to refuse to start, so the failure is
 * a message instead of a loop that looks alive and does nothing.
 */
export function bandUsable(floor, ceil) {
  if (floor <= 0n || ceil <= 0n) return false;
  return floor < ceil;
}

/**
 * Why the bot stopped, in the user's terms — or null while it is still running.
 * Kept separate from decide() so a stop is a durable fact about the session,
 * not a decision that vanishes on the next tick.
 */
export function stopReason(why) {
  switch (why) {
    case WHY.GRADUATED: return 'graduated';
    case WHY.NO_BUDGET: return 'budget';
    case WHY.NO_WALLET: return 'noWallet';
    case WHY.NOTHING_TO_SELL: return 'nothingToSell';
    case WHY.BAND_TOUCHED: return 'bandTouched';
    default: return null;
  }
}