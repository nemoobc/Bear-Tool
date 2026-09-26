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
test('integration: app.js has renderAssets function', () => {
  assert.match(appSrc, /function\s+renderAssets/);
});
test('integration: refreshView handles dapps view', () => {
  assert.match(appSrc, /view\s*===\s*'dapps'.*renderDapps|refreshView[\s\S]*dapps/);
});
test('integration: refreshView handles the Tools view (EIP-7702 + OpenSea)', () => {
  // The OpenSea panel lives in the Tools view: listing, cancelling and
  // accepting an offer are contract calls against the wallet, so they sit with
  // the tooling rather than the gallery.
  assert.match(appSrc, /if \(view === 'deploy'\) \{ loadEip7702\(\); bindOpenSeaPanel\(\); \}/,
    'Tools must run both the EIP-7702 loader and the OpenSea panel');
  assert.doesNotMatch(appSrc, /if \(view === 'nft'\)\s*\{[^}]*bindOpenSeaPanel/,
    'the OpenSea panel must not bind on the NFT view');
});
test('integration: index.html has the Tools view with the OpenSea panel', () => {
  assert.match(htmlSrc, /id="view-deploy"/);
  assert.match(htmlSrc, /id="openSeaPrice"/);
});
test('integration: the OpenSea panel is in the Tools view, not the NFT view', () => {
  const start = htmlSrc.indexOf('id="view-deploy"');
  const end = htmlSrc.indexOf('id="view-activity"');
  const tools = htmlSrc.slice(start, end === -1 ? undefined : end);
  assert.match(tools, /id="openSeaPanel"/, 'OpenSea must be in the Tools view');
  const nftStart = htmlSrc.indexOf('id="view-nft"');
  const nftEnd = htmlSrc.indexOf('id="view-dapps"');
  const nft = htmlSrc.slice(nftStart, nftEnd === -1 ? undefined : nftEnd);
  assert.doesNotMatch(nft, /id="openSeaPanel"/, 'OpenSea must not be in the NFT view');
  assert.match(nft, /id="nftList"/, 'the NFT gallery must still be there');
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
test('integration: loadDashboard calls renderAssets', () => {
  assert.match(appSrc, /renderAssets\(tokens\)/);
});
test('integration: no API key hardcoded in app.js (HUKUM 9)', () => {
  assert.ok(!appSrc.match(/qYSDUOSxp6/), 'API key must NOT be in app.js');
});
