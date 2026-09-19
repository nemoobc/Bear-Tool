// ═══════════════════════════════════════════════════════════════
// Bear Tool — tests/opensea-integration.test.js
// OpenSea integration: WL + list + cancel + accept + coin panel
// ═══════════════════════════════════════════════════════════════
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const appSrc = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const htmlSrc = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('integration: app.js imports opensea-api module', () => {
  assert.match(appSrc, /from ['"]\.\/opensea-api\.js['"]/);
});
test('integration: app.js imports dapps module', () => {
  assert.match(appSrc, /from ['"]\.\/dapps\.js['"]/);
});
test('integration: app.js has bindOpenSeaPanel function', () => {
  assert.match(appSrc, /function\s+bindOpenSeaPanel/);
});
test('integration: app.js has renderCoinPricePanel function', () => {
  assert.match(appSrc, /function\s+renderCoinPricePanel/);
});
test('integration: refreshView handles dapps view', () => {
  assert.match(appSrc, /view\s*===\s*'dapps'.*renderDapps|refreshView[\s\S]*dapps/);
});
test('integration: refreshView handles deploy + OpenSea panel', () => {
  assert.match(appSrc, /view\s*===\s*'deploy'.*bindOpenSeaPanel|refreshView[\s\S]*deploy[\s\S]*bindOpenSeaPanel/);
});
test('integration: index.html has coin price panel div', () => {
  assert.match(htmlSrc, /id="view-deploy"/);
});
test('integration: index.html has OpenSea panel with WL button', () => {
  assert.match(htmlSrc, /id="btnCheckWL"/);
});
test('integration: index.html has Accept Top Offer button', () => {
  assert.match(htmlSrc, /id="btnAcceptTopOffer"/);
});
test('integration: index.html has OpenSea status display', () => {
  assert.match(htmlSrc, /id="openSeaStatus"/);
});
test('integration: loadDashboard calls renderCoinPricePanel', () => {
  assert.match(appSrc, /renderCoinPricePanel\(\)/);
});
test('integration: no API key hardcoded in app.js (HUKUM 9)', () => {
  assert.ok(!appSrc.match(/qYSDUOSxp6/), 'API key must NOT be in app.js');
});
