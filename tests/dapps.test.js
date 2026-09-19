// ═══════════════════════════════════════════════════════════════
// Bear Tool — tests/dapps.test.js
// DApps browser: render, popular list, navigation
// ═══════════════════════════════════════════════════════════════
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const dappsSrc = readFileSync(new URL('../js/dapps.js', import.meta.url), 'utf8');
const htmlSrc = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('dapps: exports renderDapps function', () => {
  assert.match(dappsSrc, /export\s+function\s+renderDapps/);
});
test('dapps: exports POPULAR_DAPPS', () => {
  assert.ok(dappsSrc.includes('POPULAR_DAPPS'), 'POPULAR_DAPPS must exist');
  assert.ok(dappsSrc.includes('export'), 'must be exported');
});
test('dapps: has at least 5 popular DApps', () => {
  const count = (dappsSrc.match(/\{ name:/g) || []).length;
  assert.ok(count >= 5, `Expected >=5 DApps, got ${count}`);
});
test('dapps: includes Uniswap', () => {
  assert.match(dappsSrc, /Uniswap/);
});
test('dapps: includes Aave', () => {
  assert.match(dappsSrc, /Aave/);
});
test('dapps: includes OpenSea', () => {
  assert.match(dappsSrc, /OpenSea/);
});
test('dapps: iframe sandbox for security', () => {
  assert.match(dappsSrc, /sandbox="allow-scripts/);
});
test('dapps: index.html has DApps nav item', () => {
  assert.match(htmlSrc, /data-view="dapps"/);
});
test('dapps: index.html has DApps view section', () => {
  assert.match(htmlSrc, /id="view-dapps"/);
});
test('dapps: index.html has DApps container', () => {
  assert.match(htmlSrc, /id="dappsContainer"/);
});
