// Bear Tool — tests/dex-trade-sheet.test.js
//
// The TradeSheet (riset launchpad-ux R1/R2/R7; user: "buy mentok … gabisa beli
// lagi") is THE trade UI: the token page and the Swap panel both mount this ONE
// component, so two screens can never disagree about what buying means.
//
// The rule this file guards above all others: a disabled CTA must ALWAYS carry
// a visible reason. The old panel could grey out every control after a single
// failed read — no reason, no way back. That is the bug class ("mentok …
// gabisa beli lagi"); these tests pin it dead, and the anvil e2e proves the
// chain-level twin (buy → buy again with a fresh exact approve) still moves.
//
// A comma is normalised IN THE FIELD ITSELF (0,1 → 0.1), never silently: what
// the input shows is exactly what the quote parses. Indonesian phone keyboards
// offer comma; refusing it silently was another way the button never lit up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// ── a small DOM shell: the component needs document + events, nothing else ──
const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', { url: 'http://localhost/' });
const { window } = dom;
for (const key of ['window', 'document', 'localStorage', 'navigator', 'location',
  'HTMLElement', 'Node', 'CustomEvent', 'Event', 'getComputedStyle']) {
  try { Object.defineProperty(globalThis, key, { value: window[key] ?? window, configurable: true, writable: true }); } catch { /* getter-only global */ }
}

const { normalizeAmountInput, tradeGate, mountTradeSheet } = await import('../js/dex/trade-sheet.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const W = (s) => new window.Event(s, { bubbles: true });

const ROW = {
  address: '0x' + 'a1'.repeat(20),
  pair: '0x' + 'b2'.repeat(20),
  quote: '0x' + 'c3'.repeat(20),
  symbol: 'BEAR',
};

// ── normalizeAmountInput: comma keyboards must not be a dead end ─────

test('normalizeAmountInput: an Indonesian keyboard comma becomes a visible dot', () => {
  assert.deepEqual(normalizeAmountInput('0,1'), { value: '0.1', changed: true });
  assert.deepEqual(normalizeAmountInput('0.1'), { value: '0.1', changed: false });
  assert.deepEqual(normalizeAmountInput('1 000,5'), { value: '1000.5', changed: true },
    'spaces and underscores are grouping noise, not numbers');
  assert.deepEqual(normalizeAmountInput('1_000.5'), { value: '1000.5', changed: true });
});

test('normalizeAmountInput: two separators stay refused — never guessed', () => {
  // "1,500" is 1.5 to one user and 1500 to another. The component refuses the
  // truly ambiguous shapes and shows the reason; it does not pick a reading.
  assert.deepEqual(normalizeAmountInput('1,2,3'), { value: '1,2,3', changed: false });
  assert.deepEqual(normalizeAmountInput('1.2,3'), { value: '1.2,3', changed: false });
});

// ── tradeGate: every refusal carries its reason key ──────────────────

const base = {
  unlocked: true,
  raw: '0.1',
  parsed: { ok: true, value: 100n },
  balance: 1_000n,
  inSym: 'ETH',
  native: 1n,
  sim: { ok: true },
};

test('tradeGate: every way to say no comes with its reason key', () => {
  assert.equal(tradeGate({ ...base, unlocked: false }).reasonKey, 'dex.ts.reason.wallet');
  assert.equal(tradeGate({ ...base, raw: '   ' }).reasonKey, 'dex.swap.pickAmount');
  assert.equal(tradeGate({ ...base, parsed: { ok: false, reason: 'number' } }).reasonKey, 'dex.ts.reason.invalid');
  const insuff = tradeGate({ ...base, parsed: { ok: true, value: 2_000n } });
  assert.equal(insuff.reasonKey, 'dex.trade.insufficient');
  assert.deepEqual(insuff.reasonArgs, { sym: 'ETH' });
  assert.equal(tradeGate({ ...base, native: 0n }).reasonKey, 'dex.ts.reason.gas');
  assert.equal(tradeGate({ ...base, sim: { ok: false, reason: 'deep' } }).reasonKey, 'dex.ts.reason.deep');
  assert.equal(tradeGate({ ...base, sim: { ok: false, reason: 'reserves' } }).reasonKey, 'dex.ts.reason.empty');
  assert.equal(tradeGate({ ...base, sim: { ok: false, reason: 'too small' } }).reasonKey, 'dex.ts.reason.small');
});

test('tradeGate: the happy path is the ONLY path with no reason', () => {
  const g = tradeGate(base);
  assert.equal(g.disabled, false);
  assert.equal(g.reasonKey, null);
});

test('tradeGate: refusal order — wallet, amount, validity, balance, gas, pool', () => {
  assert.equal(tradeGate({ ...base, unlocked: false, raw: '' }).reasonKey, 'dex.ts.reason.wallet',
    'the wallet question comes before anything the user typed');
  assert.equal(tradeGate({ ...base, raw: '', parsed: { ok: false } }).reasonKey, 'dex.swap.pickAmount');
  assert.equal(tradeGate({ ...base, balance: 5n, native: 0n }).reasonKey, 'dex.trade.insufficient',
    'balance before gas: what they are short of is the first truth');
  assert.equal(tradeGate({ ...base, native: 0n, sim: { ok: false, reason: 'deep' } }).reasonKey, 'dex.ts.reason.gas');
  assert.equal(tradeGate({ ...base, sim: { ok: false, reason: 'deep' } }).reasonKey, 'dex.ts.reason.deep',
    'the pool speaks last: its limits are checked against a valid amount');
});

// ── the mounted sheet in jsdom: no provider = no lies, no dead end ───

test('mount in a dead-RPC state: a visible reason and a real retry — never a silent grey', async () => {
  const host = window.document.getElementById('host');
  await mountTradeSheet(host, ROW);
  const go = host.querySelector('[data-ts-go]');
  const reason = host.querySelector('[data-ts-reason]');
  const retry = host.querySelector('[data-ts-retry]');
  assert.ok(go && reason && retry, 'the sheet must carry its CTA, its reason line and its retry');
  assert.equal(go.disabled, true, 'without a chain the CTA cannot be live');
  assert.ok(reason.textContent.trim().length > 0,
    'a disabled CTA MUST say why — the greyed-without-a-reason bug is banned');
  assert.equal(retry.hidden, false, 'the retry must be reachable when the read failed');
});

test('the invariant: whenever the CTA is disabled, the reason is not empty', async () => {
  const host = window.document.getElementById('host');
  await mountTradeSheet(host, ROW);
  const go = host.querySelector('[data-ts-go]');
  const reason = host.querySelector('[data-ts-reason]');
  assert.equal(go.disabled && reason.textContent.trim().length === 0, false,
    'disabled ⇒ reason, always, no exceptions');
});

test('typing a comma is corrected in the field itself, visibly', async () => {
  const host = window.document.getElementById('host');
  await mountTradeSheet(host, ROW);
  const input = host.querySelector('[data-ts-amount]');
  input.value = '0,1';
  input.dispatchEvent(W('input'));
  assert.equal(input.value, '0.1',
    'the field shows the number the quote will parse — no silent misread in either direction');
  assert.equal(host.querySelector('[data-ts-go]').disabled, true);
  assert.ok(host.querySelector('[data-ts-reason]').textContent.trim().length > 0);
});

test('presets: buy writes the quote amount, the sell tab swaps the row for percentages', async () => {
  const host = window.document.getElementById('host');
  await mountTradeSheet(host, ROW);
  const presets = host.querySelector('[data-ts-presets]');
  const first = presets.querySelector('[data-ts-preset]');
  assert.equal(first.dataset.tsPreset, '0.01', 'a buy preset is a quote amount');
  first.click();
  const input = host.querySelector('[data-ts-amount]');
  assert.equal(input.value, '0.01', 'clicking the preset writes the amount');

  host.querySelector('[data-ts-dir="sell"]').click();
  const vals = [...presets.querySelectorAll('[data-ts-preset]')].map((b) => b.dataset.tsPreset);
  assert.deepEqual(vals, ['25', '50', '75', '100'], 'the sell presets are percentages of the holding');
  assert.equal(host.querySelector('[data-ts-dir="sell"]').getAttribute('aria-pressed'), 'true');
  assert.equal(host.querySelector('[data-ts-dir="buy"]').getAttribute('aria-pressed'), 'false');
  assert.equal(input.value, '', 'switching direction clears the amount instead of misreading it');
});

test('MAX with nothing readable does nothing rather than inventing a number', async () => {
  const host = window.document.getElementById('host');
  await mountTradeSheet(host, ROW);
  host.querySelector('[data-ts-max]').click();
  assert.equal(host.querySelector('[data-ts-amount]').value, '', 'no balance, no fill');
  assert.ok(host.querySelector('[data-ts-reason]').textContent.trim().length > 0);
});

test('retry is a real line back: clicking it asks the chain again, without crashing', async () => {
  const host = window.document.getElementById('host');
  await mountTradeSheet(host, ROW);
  const retry = host.querySelector('[data-ts-retry]');
  retry.click();
  await new Promise((r) => setTimeout(r, 20));
  // Still no provider in this process — so still honest, still re-tryable.
  assert.equal(retry.hidden, false);
  assert.ok(host.querySelector('[data-ts-reason]').textContent.trim().length > 0);
  assert.equal(host.querySelector('[data-ts-go]').disabled, true);
});

test('re-mount is clean: one sheet, not two', async () => {
  const host = window.document.getElementById('host');
  await mountTradeSheet(host, ROW);
  await mountTradeSheet(host, ROW);
  assert.equal(host.querySelectorAll('[data-ts-go]').length, 1);
  assert.equal(host.querySelectorAll('[data-ts-amount]').length, 1);
  assert.equal(host.querySelectorAll('[data-ts-dir]').length, 2, 'one buy tab, one sell tab');
});

// ── wiring pins: one component, both mounts, one honest order ────────

test('both mounts use the one component — the token page and the Swap panel', () => {
  const tp = read('../js/dex/token-page.js');
  const sw = read('../js/dex/swap.js');
  assert.match(tp, /from '\.\/trade-sheet\.js';/, 'the token page must mount the shared sheet');
  assert.match(tp, /mountTradeSheet\(/, 'and actually mount it');
  assert.ok(tp.includes('id="dexTpTrade"'), 'the token page must carry #dexTpTrade');
  assert.match(sw, /from '\.\/trade-sheet\.js';/, 'the Swap panel must mount the same sheet');
  assert.match(sw, /mountTradeSheet\(/, 'and actually mount it');
  assert.ok(sw.includes('id="dexSwapSheet"'), 'the Swap panel must carry #dexSwapSheet');
});

test('the sheet flow is confirm → approve → swap, the order the anvil e2e proves', () => {
  const ts = read('../js/dex/trade-sheet.js');
  const iConfirm = ts.indexOf('confirmTx(');
  const iApprove = ts.indexOf('ensureAllowanceTx(');
  const iSwap = ts.indexOf('swapTx(');
  assert.ok(iConfirm > -1 && iApprove > iConfirm && iSwap > iApprove,
    'the user commits BEFORE anything is granted or signed — never approve-first');
  assert.match(ts, /withTxButton\(/, 'the CTA runs through the shared tx-button discipline');
});

test('no dex module calls set()/get() without importing it — the bug that froze the Swap panel', () => {
  // swap.js called set('dex.swapToken', …) at the top of its pool loader but
  // never imported set: a ReferenceError the instant a pool finished loading.
  // The engine tests never touched the loader, and the jsdom gate dead-ended
  // before it — both stayed green while the real panel greyed out forever:
  // literally "mentok … gabisa beli lagi". This detector closes that gap for
  // the whole folder.
  const dir = fileURLToPath(new URL('../js/dex', import.meta.url));
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    const src = readFileSync(new URL(`../js/dex/${f}`, import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    for (const name of ['set', 'get']) {
      if (!new RegExp(`(^|[^A-Za-z0-9_.])${name}\\(`, 'm').test(src)) continue;
      const imported = new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from`).test(src);
      const local = new RegExp(`(const|let|var|function)\\s+${name}\\b`).test(src);
      assert.ok(imported || local,
        `js/dex/${f} calls ${name}() but never imports or defines it — exactly how the Swap panel froze ("mentok … gabisa beli lagi")`);
    }
  }
});
