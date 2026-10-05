// Bear Tool — tests/flip-runtime.test.js
//
// Runtime regression for the swap flip (user report 2026-10-04:
// "pair eth = usdt pas ku pencet anak panah atas bawah jadi usdt = usdt").
//
// The first flip test was STATIC: it asserted that flipSwap contains two
// dispatchEvent calls in the source. A static assertion can only say the
// code is written — it cannot say the triggers actually repaint. This file
// DRIVES the real loadSwapTokens + initTokenPicker + flipSwap against a
// select stub that honours the browser rules that matter:
//   • assigning select.value = X with no option X → value becomes ''
//   • replacing innerHTML resets the select to option 0
//   • 'change' listeners fire on dispatchEvent
// and then asserts what the user would SEE on the two triggers.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

function makeSelect(id) {
  const listeners = {};
  return {
    id,
    _options: [],
    _index: -1,
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {},
    removeAttribute() {},
    focus() {},
    get options() { return this._options; },
    get selectedIndex() { return this._index; },
    set selectedIndex(i) { this._index = i; },
    get value() {
      return this._index >= 0 && this._options[this._index] ? this._options[this._index].value : '';
    },
    set value(v) {
      const i = this._options.findIndex((o) => o.value === v);
      this._index = i; // browser rule: no matching option → -1 → value ''
    },
    set innerHTML(html) {
      this._options = [...String(html).matchAll(/<option value="([^"]*)"/g)].map((m) => ({ value: m[1] }));
      this._index = this._options.length ? 0 : -1; // replacing options resets to first
    },
    get innerHTML() { return this._options.map((o) => `<option value="${o.value}">`).join(''); },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) {
      listeners[type] = (listeners[type] || []).filter((f) => f !== fn);
    },
    dispatchEvent(evt) {
      for (const fn of [...(listeners[evt.type] || [])]) fn.call(this, evt);
      return true;
    },
    closest(sel) { return sel === '.token-picker' ? this._wrap || null : null; },
    querySelector() { return null; },
  };
}

function makePickerWrap(select) {
  const logo = { innerHTML: '' };
  const sym = { textContent: '' };
  const trigger = {
    _attrs: {},
    classList: { add() {}, remove() {} },
    querySelector: (s) => (s === '[data-logo]' ? logo : s === '[data-symbol]' ? sym : null),
    setAttribute(k, v) { this._attrs[k] = v; },
    getAttribute(k) { return this._attrs[k]; },
    addEventListener() {},
  };
  const panel = {
    innerHTML: '',
    hidden: true,
    classList: { add() {}, remove() {} },
    addEventListener() {},
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ bottom: 0, top: 0, height: 0 }),
  };
  const wrap = {
    classList: { add() {}, remove() {} },
    contains: () => false,
    querySelector: (s) => (s === '.token-picker-trigger' ? trigger : s === '.token-picker-panel' ? panel : null),
  };
  select._wrap = wrap;
  return { trigger, sym, logo };
}

const FROM = makeSelect('swapFrom');
const TO = makeSelect('swapTo');
const fromP = makePickerWrap(FROM);
const toP = makePickerWrap(TO);

const generic = new Map();
const genericEl = () => ({
  innerHTML: '', textContent: '', value: '', hidden: false, disabled: false,
  dataset: {}, style: {}, options: [], selectedIndex: 0,
  classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  addEventListener() {}, removeEventListener() {}, setAttribute() {}, removeAttribute() {},
  appendChild() {}, focus() {}, click() {}, querySelector: () => null, querySelectorAll: () => [],
});

globalThis.document = {
  querySelector(sel) {
    if (sel === '#swapFrom') return FROM;
    if (sel === '#swapTo') return TO;
    if (!generic.has(sel)) generic.set(sel, genericEl());
    return generic.get(sel);
  },
  querySelectorAll: () => [],
  getElementById: (id) => globalThis.document.querySelector('#' + id),
  addEventListener() {},
  createElement: () => genericEl(),
};
globalThis.window = { addEventListener() {}, innerHeight: 800, dispatchEvent() {} };
globalThis.addEventListener = () => {};
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
globalThis.requestAnimationFrame = (fn) => fn(0);
globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.ethers = (await import('ethers')).ethers;

const state = await import('../js/state.js');
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';

// Held order mirrors a wallet whose list starts with USDT — list[0] is what
// a broken paint falls back to, which is exactly the reported symptom
// ("usdt = usdt" = From repainted to USDT + To fell back to list[0]/stale).
state.set('networkId', 'ethereum');
state.set('tokens', [
  { address: USDT, symbol: 'USDT', decimals: 6, balance: '100000000' },
  { address: null, symbol: 'ETH', decimals: 18, balance: '1500000000000000000' },
]);
state.set('tokensUsd', {});

const swap = await import('../js/swap.js');

test('flip: both selects carry the SAME option set (a swap can never hit a missing value)', () => {
  swap.loadSwapTokens();
  assert.deepEqual(FROM.options.map((o) => o.value), TO.options.map((o) => o.value),
    'from/to option lists must stay identical — flipSwap assigns values across them');
  assert.ok(FROM.options.some((o) => o.value === 'native'), 'native gas token must be selectable');
});

test('flip: ETH=USDT → flip → display AND values become USDT=ETH (BOTH triggers repaint)', () => {
  FROM.value = 'native';
  TO.value = USDT;
  FROM.dispatchEvent(new Event('change'));
  TO.dispatchEvent(new Event('change'));
  assert.equal(`${fromP.sym.textContent}=${toP.sym.textContent}`, 'ETH=USDT',
    'baseline pair must paint before the flip is meaningful');

  swap.flipSwap();
  assert.equal(`${fromP.sym.textContent}=${toP.sym.textContent}`, 'USDT=ETH',
    'the reported bug: stale To trigger renders "USDT = USDT" after the flip');
  assert.equal(FROM.value, USDT, 'From select value must hold the swapped token');
  assert.equal(TO.value, 'native', 'To select value must hold the swapped token');

  swap.flipSwap();
  assert.equal(`${fromP.sym.textContent}=${toP.sym.textContent}`, 'ETH=USDT',
    'a second flip must return the original pair');
});

test('flip: repaint survives a view re-entry (loadSwapTokens runs on every visit)', () => {
  FROM.value = 'native';
  TO.value = USDT;
  FROM.dispatchEvent(new Event('change'));
  TO.dispatchEvent(new Event('change'));
  swap.loadSwapTokens(); // second view visit repopulates options + re-inits pickers
  swap.flipSwap();
  assert.equal(`${fromP.sym.textContent}=${toP.sym.textContent}`, 'USDT=ETH',
    're-entry must not leave either trigger painting the old pair');
  assert.ok(FROM.value && TO.value, 'values must be populated after re-entry');
});

test('flip: paint falls back to list[0] for an unknown value — the shape of "usdt = usdt"', () => {
  // Documents the failure mode behind the report: when the To value is
  // invalid/empty the paint does find('') || list[0] and renders list[0]
  // (= USDT here) on that side. The guards above keep flip away from this
  // path; this assertion pins the fallback so a change to it is visible.
  TO.value = 'no-such-option';
  TO.dispatchEvent(new Event('change'));
  assert.equal(TO.value, '', 'setting a value no option holds empties the select');
  assert.equal(toP.sym.textContent, 'USDT',
    'fallback paints list[0] — paired with a USDT From this is the reported "USDT = USDT"');
});
