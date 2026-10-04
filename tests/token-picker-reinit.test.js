// Bear Tool — token-picker-reinit.test.js
//
// loadSwapTokens()/loadSendTokens() re-init the picker on EVERY view visit.
// Without a re-entry guard the second init stacked a second trigger listener,
// and two identical open/close listeners fired on ONE click leave the panel
// CLOSED — the picker goes permanently dead after the first re-entry (found
// while fixing the Send-picker live report, 2026-10-03). Pins two things:
// re-init keeps ONE binding, and the LATEST token list is what renders.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const els = {};
function makeEl(name) {
  return {
    name, listeners: {}, value: '', innerHTML: '', style: {},
    options: [], hidden: false, scrollTop: 0,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    setAttribute() {}, getAttribute() { return null; },
    dispatchEvent() {}, focus() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { top: 100, bottom: 200, height: 100 }; },
    closest() { return els.wrap; },
  };
}
els.trigger = makeEl('trigger');
els.panel = makeEl('panel');
els.wrap = makeEl('wrap');
els.wrap.querySelector = (s) =>
  s === '.token-picker-trigger' ? els.trigger
    : s === '.token-picker-panel' ? els.panel : null;
els.sel = makeEl('sel');

globalThis.document = {
  querySelector: (s) => (s === '#sendToken' ? els.sel : null),
  addEventListener() {}, removeEventListener() {},
};
globalThis.window = { innerHeight: 800, addEventListener() {}, removeEventListener() {} };
globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };

const { initTokenPicker } = await import('../js/token-picker.js');

test('re-init tidak menumpuk listener trigger', () => {
  const tokens = [{ address: null, symbol: 'ETH', decimals: 18, balance: '0' }];
  initTokenPicker('sendToken', tokens);
  assert.equal(els.trigger.listeners.click?.length || 0, 1, 'init pertama = satu listener click');
  initTokenPicker('sendToken', tokens);   // view dikunjungi kedua kalinya
  assert.equal(els.trigger.listeners.click.length, 1,
    'init kedua tidak boleh menambah listener — panel mati (buka-tutup dalam satu klik)');
});

test('setelah re-init, panel memakai daftar token TERBARU', () => {
  initTokenPicker('sendToken', [{ address: null, symbol: 'BERAS', decimals: 18, balance: '0' }]);
  const clickFn = els.trigger.listeners.click[0];
  clickFn({ stopPropagation() {} });
  assert.match(els.panel.innerHTML, /BERAS/,
    'renderRows terbaru yang dipakai — closure lama harus ikut terganti');
});
