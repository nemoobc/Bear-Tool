// ═══════════════════════════════════════════════════════════════
// Bear Tool — tests/dapp-safety.test.js
// The pre-load gate. Written as attacks that must be caught, not as
// descriptions of behaviour, because a gate that cannot be shown to stop
// something is a gate that does not work.
// ═══════════════════════════════════════════════════════════════
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  VERDICT, classifyInput, inspectUrl, baseHost, hostOf, matchHostList, renderSignalList,
} from '../js/dapp-safety.js';

const CATALOG = [
  { name: 'Uniswap', url: 'https://app.uniswap.org', frameable: false },
  { name: 'Aave', url: 'https://app.aave.com', frameable: true },
];

// ── omnibox: what the user typed ─────────────────────────────────────────
test('classifyInput: a bare hostname becomes an https URL', () => {
  assert.deepEqual(classifyInput('app.uniswap.org'), { kind: 'url', url: 'https://app.uniswap.org' });
});

test('classifyInput: an explicit http URL is kept as typed', () => {
  assert.equal(classifyInput('http://example.com/x').url, 'http://example.com/x');
});

test('classifyInput: words are a search, not a URL', () => {
  assert.equal(classifyInput('uniswap swap eth').kind, 'search');
  assert.equal(classifyInput('how to stake').kind, 'search');
});

// ── the attacks the gate exists for ───────────────────────────────────────
test('GATE: javascript: is blocked outright', () => {
  const r = classifyInput('javascript:alert(1)');
  assert.equal(r.kind, 'blocked');
  const i = inspectUrl('javascript:alert(document.cookie)', CATALOG);
  assert.equal(i.verdict, VERDICT.BLOCKED);
});

test('GATE: data: and blob: are blocked too', () => {
  for (const u of ['data:text/html,<script>alert(1)</script>', 'blob:https://x/abc', 'file:///etc/passwd']) {
    assert.equal(inspectUrl(u, CATALOG).verdict, VERDICT.BLOCKED, u);
  }
});

test('GATE: a punycode homograph is DANGER', () => {
  // "xn--" is how a Cyrillic lookalike of a real dApp gets written down.
  const i = inspectUrl('https://xn--pypal-4ve.com/login', CATALOG);
  assert.equal(i.verdict, VERDICT.DANGER);
  assert.ok(i.signals.some((s) => /Punycode/i.test(s.label)));
});

test('GATE: a mixed-script host is DANGER even without punycode', () => {
  // "аpple" with a Cyrillic а — visually identical, different bytes.
  const i = inspectUrl('https://аpple.com/id', CATALOG);
  assert.equal(i.verdict, VERDICT.DANGER);
  assert.ok(i.signals.some((s) => /Mixed-script/i.test(s.label)));
});

test('GATE: a lure word on a cheap TLD is DANGER', () => {
  const i = inspectUrl('https://freemint-airdrop.xyz/claim', CATALOG);
  assert.equal(i.verdict, VERDICT.DANGER);
  assert.ok(i.signals.some((s) => /Lure words/i.test(s.label)));
});

test('GATE: a lure word on a reputable TLD is never DANGER', () => {
  // A keyword alone must not block a real site, or the gate cries wolf and
  // people learn to click through it. Two cases: inside the catalogue, and a
  // host we have simply never heard of.
  const known = inspectUrl('https://claim.uniswap.org/', CATALOG);
  assert.notEqual(known.verdict, VERDICT.DANGER);
  assert.ok(!known.signals.some((s) => s.level === 'fail'), 'no fail signal on a .org host');

  const unknown = inspectUrl('https://claim.example.com/', CATALOG);
  assert.equal(unknown.verdict, VERDICT.CAUTION, 'unknown host is caution, not danger');
  assert.ok(!unknown.signals.some((s) => s.level === 'fail'));
});

test('GATE: plain http is CAUTION with a named consequence', () => {
  const i = inspectUrl('http://app.aave.com/', CATALOG);
  assert.equal(i.verdict, VERDICT.CAUTION);
  assert.ok(i.signals.some((s) => /Not encrypted/.test(s.label)));
});

test('GATE: an IP-literal host is flagged', () => {
  const i = inspectUrl('https://185.199.108.153/', CATALOG);
  assert.ok(i.signals.some((s) => /Raw IP/.test(s.label)));
});

// ── the user's own lists ─────────────────────────────────────────────────
test('user blocklist overrides everything and offers no way past it', () => {
  const url = 'https://app.uniswap.org/';            // a catalogue entry, https
  const ok = inspectUrl(url, CATALOG);
  assert.equal(ok.verdict, VERDICT.KNOWN, 'baseline: a catalogue site over https is clean');

  const blocked = inspectUrl(url, CATALOG, { blockedHosts: ['app.uniswap.org'] });
  assert.equal(blocked.verdict, VERDICT.BLOCKED);
  assert.ok(blocked.signals.some((s) => /blocklist/i.test(s.label)));
});

test('user blocklist matches the parent host, not just the exact string', () => {
  assert.equal(inspectUrl('https://deep.app.uniswap.org/x', CATALOG, { blockedHosts: ['app.uniswap.org'] }).verdict, VERDICT.BLOCKED);
  assert.equal(inspectUrl('https://unrelated.org/', CATALOG, { blockedHosts: ['app.uniswap.org'] }).verdict, VERDICT.CAUTION);
});

test('a user allow-list clears CAUTION', () => {
  const url = 'http://my-own-defi.example/';
  assert.equal(inspectUrl(url, CATALOG).verdict, VERDICT.CAUTION);
  assert.equal(inspectUrl(url, CATALOG, { trustedHosts: ['my-own-defi.example'] }).verdict, VERDICT.KNOWN);
});

test('a user allow-list CANNOT clear DANGER — that is the whole point', () => {
  // Otherwise the one thing an attacker wants is the user vouching for a
  // homograph, and the gate would obey.
  const evil = 'https://xn--pypal-4ve.com/';
  assert.equal(inspectUrl(evil, CATALOG).verdict, VERDICT.DANGER);
  assert.equal(inspectUrl(evil, CATALOG, { trustedHosts: ['xn--pypal-4ve.com'] }).verdict, VERDICT.DANGER);
});

test('matchHostList tolerates sloppy user input', () => {
  assert.ok(matchHostList('app.uniswap.org', 'app.uniswap.org', ['  https://app.uniswap.org/path ']));
  assert.ok(!matchHostList('app.uniswap.org', 'app.uniswap.org', ['', null, undefined]));
  assert.ok(!matchHostList('', '', ['x.com']));
});

// ── catalogue honesty ────────────────────────────────────────────────────
test('an unknown https site is CAUTION, never silently KNOWN', () => {
  const i = inspectUrl('https://some-random-defi.io/', CATALOG);
  assert.equal(i.verdict, VERDICT.CAUTION);
  assert.ok(i.signals.some((s) => /Not in our catalogue/i.test(s.label)));
  assert.equal(i.known, null);
});

test('a catalogue entry is recognised through its subdomains', () => {
  const i = inspectUrl('https://staging.app.aave.com/', CATALOG);
  assert.equal(i.known?.name, 'Aave');
});

test('the wallet’s own origin needs no vetting', () => {
  // Node has no location, so the gate sees an empty self-host. Stand one up:
  // selfHost() is read at call time, which is the behaviour under test.
  const real = globalThis.location;
  globalThis.location = { href: 'http://localhost:8081/index.html', origin: 'http://localhost:8081', hostname: 'localhost' };
  try {
    const i = inspectUrl('http://localhost:8081/index.html', CATALOG);
    assert.equal(i.verdict, VERDICT.KNOWN);
    assert.ok(i.signals.some((s) => /Same origin/.test(s.label)));
  } finally {
    if (real === undefined) delete globalThis.location; else globalThis.location = real;
  }
});

// ── host maths ───────────────────────────────────────────────────────────
test('baseHost strips a subdomain but keeps a two-part suffix', () => {
  assert.equal(baseHost('https://app.uniswap.org/x'), 'uniswap.org');
  assert.equal(baseHost('https://uniswap.org'), 'uniswap.org');
  assert.equal(baseHost('https://shop.example.co.uk'), 'example.co.uk');
  assert.equal(baseHost('not a url'), '');
});

test('hostOf lowercases and never throws', () => {
  assert.equal(hostOf('https://APP.Uniswap.ORG/x'), 'app.uniswap.org');
  assert.equal(hostOf('garbage'), '');
});

// ── rendering ────────────────────────────────────────────────────────────
test('signal rendering escapes its input', () => {
  const html = renderSignalList([{ level: 'fail', label: '<img onerror=x>', detail: 'a & b' }]);
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img'));
  assert.ok(html.includes('&amp;'));
});

test('every signal carries a level the renderer knows', () => {
  const i = inspectUrl('http://freemint.xyz/', CATALOG);
  for (const s of i.signals) assert.ok(['pass', 'warn', 'fail', 'info'].includes(s.level), s.level);
});
