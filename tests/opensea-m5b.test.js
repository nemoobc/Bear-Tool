// ═══════════════════════════════════════════════════════════
// Bear-Tool — tests/opensea-m5b.test.js
// M5-B put a 24h CoinGecko sparkline on every asset card. It was removed: each
// row fired its own history request, all of which fail CORS from a plain static
// host, so the list rendered a column of empty boxes for real user data. The
// per-token chart still exists inside the token modal, drawn on demand.
//
// These tests now lock the NEW contract, so the per-row fetch cannot creep back:
//   - renderAssets must not call fetchPriceHistory at all
//   - the asset card template must have no sparkline container
//   - the detail modal must keep its chart
// ═══════════════════════════════════════════════════════════
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');

const renderAssetsBody = (() => {
  const i = app.indexOf('function renderAssets(');
  assert.ok(i !== -1, 'renderAssets must exist');
  const j = app.indexOf('\nfunction ', i + 1);
  return app.slice(i, j === -1 ? app.length : j);
})();

test('M5-B: renderAssets does NOT fetch per-row price history', () => {
  assert.doesNotMatch(
    renderAssetsBody,
    /fetchPriceHistory/,
    'renderAssets must not fire a CoinGecko history request per asset card'
  );
});

test('M5-B: asset card template has no sparkline container', () => {
  assert.doesNotMatch(
    renderAssetsBody,
    /class="[^"]*asset-spark|id="[^"]*assetSpark/,
    'the asset list must not render a sparkline container'
  );
});

test('M5-B: the detail modal keeps its chart (per-token, on demand)', () => {
  assert.match(app, /id="tokenPriceChart"/, 'token modal chart canvas must remain');
  assert.match(app, /function drawMiniChart\(/, 'chart drawing helper must remain');
});
