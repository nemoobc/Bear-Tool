// Bear Tool — account-switcher-same.test.js
//
// Live report: "bug bisa switch wallet yang sama" — the Accounts modal ran the
// full switch flow for the row that was ALREADY the active account: a password
// prompt, a "Switched account" toast, accountsChanged pushed to every
// connected dApp and a dashboard reload, none of which moved anything. The
// active row is now inert (aria-current, and an early return BEFORE the
// password prompt). These pins keep it that way: the guard must exist, it must
// sit ahead of the prompt, and it must not carry any of the side effects the
// real switch performs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const i18n = readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');

// The modal body, bounded by the next top-level function — a pin that ran to
// the end of the file would pass against a guard added anywhere else.
const from = app.indexOf('function showAccountModal');
assert.ok(from > -1, 'showAccountModal must exist in js/app.js');
const to = app.indexOf('\nfunction ', from + 10);
const body = app.slice(from, to > -1 ? to : undefined);

test('clicking the already-active account row bails out before the password prompt', () => {
  const guard = body.search(/if \(i === wallet\.getActiveAccountIndex\(\)\) \{/);
  assert.ok(guard > -1, 'the same-account guard must exist inside showAccountModal');
  const prompt = body.indexOf('promptPassword(', guard);
  assert.ok(prompt > -1, 'the password prompt must still exist for a real switch');
  // The return of the guard must come before the prompt is ever reached.
  const ret = body.slice(guard, prompt).indexOf('return;');
  assert.ok(ret > -1, 'the guard must return BEFORE promptPassword runs');
  // ...and ahead of the FIRST prompt in the row handler. A guard parked after
  // the prompt would still "return", but only after the user had already been
  // asked for a password to switch to the account they are standing on.
  const handler = body.indexOf("$all('[data-acc]')");
  assert.ok(handler > -1, 'the row handler must exist');
  const firstPrompt = body.indexOf('promptPassword(', handler);
  assert.ok(guard < firstPrompt,
    'the guard must sit BEFORE the first promptPassword of the switch flow');
});

test('the same-account path carries no switch side effects', () => {
  const guard = body.search(/if \(i === wallet\.getActiveAccountIndex\(\)\) \{/);
  assert.ok(guard > -1, 'the same-account guard must exist inside showAccountModal');
  const block = body.slice(guard, body.indexOf('return;', guard) + 'return;'.length);
  for (const effect of ['setActiveAccount', 'bridgeAccounts', 'loadDashboard', 'updateTopbar']) {
    assert.ok(!block.includes(effect),
      `the same-account path must not call ${effect} — nothing moved`);
  }
  // It should say why, in the user's language, instead of silently ignoring.
  assert.match(block, /toast\(t\('acc\.same'\)/,
    'the same-account path must toast acc.same');
});

test('the active row is marked for assistive tech', () => {
  assert.match(body, /i === idx \? 'active' : ''\}" data-acc="\$\{i\}"\$\{i === idx \? ' aria-current="true"' : ''\}/,
    'the active account row must carry aria-current="true"');
});

test('acc.same is translated in both languages', () => {
  const idStart = i18n.indexOf('\n  id: {');
  assert.ok(idStart > -1, 'i18n.js must keep an id block');
  const en = i18n.slice(0, idStart);
  const id = i18n.slice(idStart);
  for (const [lang, block] of [['en', en], ['id', id]]) {
    assert.ok(/'acc\.same':\s*'[^']+'/.test(block),
      `acc.same must be defined in the ${lang} block`);
  }
});
