// Bear Tool — dapp-blocklist-match.test.js
// The blocklist must mean the same thing everywhere it is read.
//
// Two matchers existed with different rules:
//
//   dapp-safety.js  matchHostList(host, base, list)
//     host === entry || base === entry || host.endsWith('.'+entry) || entry.endsWith('.'+host)
//   dapp-sessions.js isBlocked(host)
//     list.includes(host)          ← exact string only
//
// isBlocked is not called by any app code today — only by the adversarial probe —
// so this was never a live hole. It is still a trap: a function called
// isBlocked, sitting next to a real blocklist, answering a question the rest of
// the app answers differently. Anyone who later wires it up inherits a rule where
// reporting "app.uniswap.org" as unsafe does nothing for "deep.app.uniswap.org".
//
// The rule that matters is the one the live gate already enforces, and these
// tests pin both matchers to it so they cannot drift apart again.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};
globalThis.document ??= {
  querySelector: () => null, querySelectorAll: () => [],
  addEventListener() {}, body: { style: {}, appendChild() {} },
};
globalThis.window ??= { addEventListener() {} };
globalThis.matchMedia ??= () => ({ matches: false });

const S = await import('../js/dapp-sessions.js');
const { matchHostList, hostOf, baseHost } = await import('../js/dapp-safety.js');

const report = (host) => { S.addBlockedHost(host); };

test('blocking a host blocks its subdomains, the way the live gate does', () => {
  store.clear();
  report('app.uniswap.org');
  assert.equal(S.isBlocked('app.uniswap.org'), true, 'the reported host itself');
  assert.equal(S.isBlocked('deep.app.uniswap.org'), true,
    'a subdomain of a reported host must be blocked too — this is exactly what matchHostList enforces');
  assert.equal(S.isBlocked('https://deep.app.uniswap.org/x'), true, 'a full URL is normalised first');
  assert.equal(S.isBlocked('unrelated.org'), false, 'an unrelated host stays open');
});

test('the two matchers agree on every host shape they are given', () => {
  // If these ever disagree, one of them is a bug waiting to be wired up. The
  // scanner is the live one, so it defines the rule.
  const list = ['app.uniswap.org'];
  for (const host of [
    'app.uniswap.org',
    'deep.app.uniswap.org',
    'a.b.c.app.uniswap.org',
    'APP.UNISWAP.ORG',
    'https://deep.app.uniswap.org/path',
    'uniswap.org',
    'notuniswap.org',
    'unrelated.org',
  ]) {
    // The live gate is handed a host and base DERIVED FROM A URL: inspectUrl() runs
    // hostOf()/baseHost() first, and hostOf('app.uniswap.org') throws without a
    // scheme, so it returns '' and matchHostList answers false. Feeding it a bare
    // hostname made the two disagree for a reason that had nothing to do with
    // either matcher. So the comparison goes through the same derivation the app
    // does, from a URL that carries a scheme.
    const url = /^[a-z][a-z0-9+.-]*:/i.test(host) ? host : 'https://' + host;
    const live = matchHostList(hostOf(url), baseHost(url), list);
    store.clear();
    report('app.uniswap.org');
    const sessions = S.isBlocked(host);
    assert.equal(sessions, live,
      `isBlocked and matchHostList disagree on ${host}: ${sessions} vs ${live}`);
  }
});

test('reporting a subdomain also covers its parent, as the live gate does', () => {
  // This test first asserted the opposite — that "login.bank.com" must leave
  // "bank.com" alone. That was me inventing a policy the app does not have:
  // matchHostList matches entry.endsWith('.' + host) as well, so reporting the
  // clone you were actually phished on also takes the parent out of reach. That
  // is the deliberate reading — a user reporting login.bank.com is reporting the
  // operation, and a lookalike on the parent is the same lure. The test now
  // pins the behaviour that exists instead of the one I preferred.
  store.clear();
  report('login.bank.com');
  assert.equal(S.isBlocked('login.bank.com'), true);
  assert.equal(S.isBlocked('bank.com'), true,
    'matchHostList blocks the parent of a reported subdomain; isBlocked must not quietly disagree');
  assert.equal(S.isBlocked('notbank.com'), false, 'a different domain is untouched');
});

test('an empty or unparseable host is never blocked, and never crashes', () => {
  store.clear();
  report('phish.example');
  for (const bad of ['', null, undefined, '   ']) {
    assert.equal(S.isBlocked(bad), false, `${JSON.stringify(bad)} must not count as blocked`);
  }
});
