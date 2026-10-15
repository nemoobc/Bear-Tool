// ═══════════════════════════════════════════════════════════════
// Bear Tool — tests/dex-trade-read.test.js
//
// Guards on the Dex trade page that behaviour tests never reach: this view is
// driven by a live contract (an unreadable pool, a coin at a random point on
// its curve, a wallet prompt ordering), so what these pin is the SHAPE of the
// flows — the ordering and the binding that are invisible once the page has
// rendered, and are exactly what silently broke before.
//
// Every case here corresponds to a defect that shipped.
// ═══════════════════════════════════════════════════════════════
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../js/dex/trade.js', import.meta.url), 'utf8');

// ── 1. the allowance was granted before the purchase was confirmed ───────
// The buy handler ran the approve FIRST: the wallet popped "let this contract
// spend your quote tokens" while the buyer had not yet been shown what they
// were getting. Cancelling the confirmation sheet afterwards left a pointless
// allowance behind. The order must be confirm intent → approve → buy, which is
// the order the liquidity panel already had (confirmTx, then approve, then
// addLiquidity) — trade.js was the odd one out.
test('a buy confirms intent before any allowance is granted', () => {
  const buy = src.slice(src.indexOf("buyBtn.addEventListener"), src.indexOf("sellBtn.addEventListener"));
  assert.ok(buy.length > 0, 'the buy handler must be findable');

  const confirmAt = buy.indexOf('await confirmTx({');
  const approveAt = buy.indexOf('quote.approve(');
  const sendAt = buy.indexOf('cs.buy(');
  assert.ok(confirmAt > 0, 'the buy handler must ask for confirmation');
  assert.ok(approveAt > 0, 'and must still grant the allowance it needs');
  assert.ok(sendAt > 0, 'and must still send the buy');

  assert.ok(confirmAt < approveAt,
    'confirm the purchase BEFORE approving — the sheet is the buyer\'s decision to approve');
  assert.ok(approveAt < sendAt,
    'the allowance must exist before the buy that spends it');
  assert.ok(!/approve\([^)]*MaxUint256|approve\([^)]*\*\s*10n\s*\*\*\s*/.test(buy),
    'approve only what this trade needs, never an unlimited allowance');
});

// ── 2. an unreadable pool crashed the "graceful unreadable" path ──────────
// The read was bound and destructured in one statement whose right side was
// `Promise.all(...).catch(() => { …; return null; })`. On failure that is
// `const [vE, …] = null` — TypeError thrown BEFORE the `if (!vE) return` guard
// could run, so the path that exists to MARK the page stale was itself a
// crash: the every-5s refresh kept ticking unhandled rejections. The bound
// value must be null-checked before anything is taken out of it, and the catch
// must survive (dropping it would turn a marked page into a thrown one).
test('a failed pool read returns instead of destructuring null', () => {
  const at = src.indexOf('const read = await Promise.all([');
  assert.ok(at > 0, 'the read must be bound as ONE value first');

  const destructure = src.indexOf('const [vE,', at);
  const guard = src.indexOf('if (!read) return', at);
  assert.ok(destructure > at, 'the tuple must be unpacked after the read');
  assert.ok(guard > at, 'the null result must be checked');
  assert.ok(guard < destructure,
    'guard BEFORE destructuring — const [vE] = null throws TypeError, not return');

  assert.match(src.slice(at, destructure), /\.catch\(/,
    'the catch must still mark the page unreadable and report why');
  assert.match(src.slice(at, destructure), /state\.readable = false/,
    'and it must actually set the stale flag, not just log');
});

// ── 3. the curve's "now" marker sat at graduation ────────────────────────
// The marker was drawn from `ve`/`vt` — but those are the LOOP variables, and
// the walk above runs all the way to the graduation line, so they hold the
// POST-graduation reserves. The dot therefore sat pinned at the curve's far
// right on every coin, including a brand-new untraded one, flatly
// contradicting the live price and the graduation bar directly above it. It
// must come from state.vE/state.vT — the live reserves, re-read every 5s —
// falling back to the launch reserves before the first read.
test("the curve's now-marker reads the live reserves, not the walk's end", () => {
  assert.match(src, /const nowE = state\.vE \|\| startE/,
    'the marker must plot state.vE — the coin\'s actual position');
  assert.match(src, /const nowT = state\.vT \|\| startT/,
    'and state.vT, or the price it marks is wrong too');
  assert.ok(!/const nowX = x\(Number\(ve\)\)/.test(src),
    've after the loop is the graduation endpoint — that pinned the dot to the far right');
  // state.vE is populated by the read that feeds every other live number, so
  // the marker refreshes with them instead of standing still.
  assert.match(src, /state\.vE = vE/, 'the read must store the live reserve the marker consumes');
});
