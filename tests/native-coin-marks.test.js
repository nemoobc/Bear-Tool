// Bear Tool — item 11: every bundled network's NATIVE coin renders its own
// brand mark, not the generic peach initial disc.
//
// The dashboard's first row is the native coin. ETH had a hand-tuned MARKS
// entry; BSC showed "BN", Polygon showed "PO" on a peach circle — the one row
// a user checks on every single screen wore a placeholder. Native symbols come
// from NETWORKS[].symbol, so the table is the source of truth to test against.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const { NETWORKS } = await import(pathToFileURL(path.join(here, '..', 'js', 'network.js')).href);
const { tokenLogoHTML } = await import(pathToFileURL(path.join(here, '..', 'js', 'token-logo.js')).href);

// The generic fallback disc is a flat #FFD9C0 circle; a MARKS entry always
// paints a gradient (url(#uid)).
const hasMark = (sym) => /url\(#/.test(tokenLogoHTML(sym, 24, { remote: false }));

test('item 11: every native coin symbol of every bundled network has a brand mark', () => {
  const missing = [...new Set(NETWORKS.map((n) => n.symbol))].filter((s) => !hasMark(s));
  assert.deepEqual(missing, [],
    `native coins without their own mark (generic disc instead): ${missing.join(', ')}`);
});

test('item 11: the known native set is exact', () => {
  const symbols = [...new Set(NETWORKS.map((n) => n.symbol))].sort();
  // 2026-10-05 growth: AVAX, CELO, xDAI, S, MNT arrive with the 11 new
  // mainnets — each needs its own MARKS entry above, never the fallback disc.
  assert.deepEqual(symbols, ['AVAX', 'BNB', 'CELO', 'ETH', 'MNT', 'POL', 'S', 'tBNB', 'xDAI'],
    'if NETWORKS grows a network, its native coin needs a MARKS entry too');
  for (const s of symbols) assert.ok(hasMark(s), `${s} must render its brand mark`);
});

test('item 11: legacy MATIC ticker keeps the Polygon mark (old lists still use it)', () => {
  assert.ok(hasMark('matic'), 'MATIC must not fall back to the initial disc');
});
