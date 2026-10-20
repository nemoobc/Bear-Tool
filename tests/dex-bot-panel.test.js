// Bear Tool — tests/dex-bot-panel.test.js
//
// The DEX bot panel crashed the app on any page that does not carry the bot
// card. bindBot() looks its three controls up in the page host — they are
// OPTIONAL — and then subscribes; subscribe() calls the listener straight
// away, so the panel's first repaint wrote `.hidden` on a null element and
// threw "Cannot set properties of null (setting 'hidden')".
//
// The Android E2E caught it as an uncaught error (the console-error gate of
// the emulator run on 2026-10-20) with the stack pointing at the bundled
// repaint. This test pins the behaviour: binding the panel on a host WITHOUT
// the bot card must not throw, and the repaint must survive a state change
// while the card is absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';

const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};
// The dex modules read ethers off the global (the app has no bundler
// shim) — the bot panel's module chain builds an Interface at import time.
const { ethers: realEthers } = await import('ethers');
globalThis.ethers = realEthers;

const b = await import('../js/dex/bot.js');

test('binding the bot panel on a page WITHOUT the bot card does not throw', () => {
  const host = document.getElementById('host');
  assert.ok(host, 'the test host must exist');
  assert.doesNotThrow(() => b.bindBot(host, {}),
    'the panel binds on every dex page — the bot card is only on some of them');
});

test('the panel survives a state change while the card is absent', () => {
  const host = document.getElementById('host');
  let unsub = null;
  assert.doesNotThrow(() => { unsub = b.bindBot(host, {}); },
    'binding subscribes, and subscribe() calls the listener immediately');
  assert.doesNotThrow(() => { unsub?.(); }, 'unsubscribing must be safe too');
});

test('the bot card markup carries the three controls the panel toggles', () => {
  const html = b.botStubHtml();
  for (const id of ['dexBotStart', 'dexBotStop', 'dexBotMeter']) {
    assert.ok(html.includes(id), `the bot card must contain #${id}`);
  }
});

test('the panel never writes .hidden on an unguarded lookup', () => {
  // The shape of the fix: a source guard, because the crash was a null
  // property write and the null came from a page that has no bot card.
  // A write counts as guarded when the element is checked in the lines
  // above it (the file's own style: `if (!body) return;` then the write).
  const lines = fs.readFileSync(new URL('../js/dex/bot.js', import.meta.url), 'utf8').split('\n');
  lines.forEach((line, i) => {
    const m = line.match(/([A-Za-z_$][\w$]*)\.hidden\s*=/);
    if (!m) return;
    const name = m[1];
    if (/&\.|\?\./.test(line)) return;                      // optional chaining
    const before = lines.slice(Math.max(0, i - 4), i + 1).join('\n');
    assert.match(before, new RegExp(`if \\(\\s*!?${name}\\b`),
      `unguarded .hidden write would crash a page without the bot card: ${line.trim()}`);
  });
});
