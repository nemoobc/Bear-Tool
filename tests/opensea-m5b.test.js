// ═══════════════════════════════════════════════════════════
// Bear-Tool — tests/opensea-m5b.test.js
// M5-B: sparkline CoinGecko 24h di SEMUA kartu aset (bukan hanya hero —
// yang sudah ada app.js:1453 renderHeroSpark). Test ini memeriksa bahwa
// renderAssets (app.js:867) memanggil fetchPriceHistory CoinGecko PER KARTU
// dan template kartunya punya wadah #spark (bukan 'niche teks kosong').
// ═══════════════════════════════════════════════════════════
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');

test('M5-B: renderAssets memanggil fetchPriceHistory CoinGecko (bukan cuma renderHeroSpark)', () => {
  assert.match(app, /renderAssets[\s\S]{0,2000}fetchPriceHistory/);
});
test('M5-B: template kartu aset punya wadah sparkline (bukan text tanpa chart)', () => {
  assert.match(app, /class="[^"]*asset-spark|id="[^"]*assetSpark/);
});
test('M5-B: data CoinGecko di-render ke spark per kartu (bukan hanya dicek lalu dibuang)', () => {
  assert.match(app, /asset-spark[\s\S]{0,400}(innerHTML|svg|points|spark)/);
});
