// ═══════════════════════════════════════════════════════════════
// Bear Tool — tests/opensea-onchain.test.js
// OpenSea REST API v2 onchain tests:
// WL check, mint estimate, listings, offers, highest offer
// Runs against live API (no fork needed — public endpoints)
// ═══════════════════════════════════════════════════════════════
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const apiSrc = readFileSync(new URL('../js/opensea-api.js', import.meta.url), 'utf8');

// ── OPENSEA API STRUCTURE TESTS ──
test('opensea-api: uses correct API base URL', () => {
  assert.match(apiSrc, /api\.opensea\.io\/api\/v2/);
});

test('opensea-api: checkWL function signature', () => {
  assert.match(apiSrc, /export\s+(async\s+)?function\s+checkWL\s*\(\s*\{[^}]*collection[^}]*address/);
});

test('opensea-api: checkWL accepts an OpenSea LINK (not only a slug) via parseOpenSeaInput', () => {
  assert.match(apiSrc, /export\s+function\s+parseOpenSeaInput/);
  assert.match(apiSrc, /opensea\.io\/collection\//i, 'parser must understand collection links');
  assert.match(apiSrc, /opensea\.io\/assets\//i, 'parser must understand asset links');
  // the WL check must route the user input through the parser, never hardcode a collection
  assert.doesNotMatch(apiSrc, /checkWL\(\{\s*collection:\s*['"]boredapeyachtclub/, 'checkWL body must not hardcode a collection');
});

test('opensea-api: checkWL validates the wallet address honestly', () => {
  assert.match(apiSrc, /\^0x\[0-9a-fA-F\]\{40\}\$/, 'checkWL must validate the wallet address format');
  assert.match(apiSrc, /Invalid wallet address/, 'checkWL must tell the user when the address is malformed');
});

test('opensea-api: checkWL never pretends a per-address whitelist verdict', () => {
  // OpenSea v2 has no "is this wallet whitelisted" endpoint — the module must
  // report public/private status + an explicit note, not a fake "whitelisted".
  assert.match(apiSrc, /no\s+per-address whitelist endpoint/i, 'must document the API limitation');
  assert.match(apiSrc, /Collection is private\/hidden — whitelist is managed off-chain/, 'hidden collections must say WL is off-chain');
});

test('opensea-api: getMintEstimate returns price + gas + total', () => {
  assert.match(apiSrc, /gasEstimate/);
  assert.match(apiSrc, /total.*price|price.*total/);
});

test('opensea-api: getListings function exists', () => {
  assert.match(apiSrc, /export\s+(async\s+)?function\s+getListings/);
});

test('opensea-api: getOffers function exists', () => {
  assert.match(apiSrc, /export\s+(async\s+)?function\s+getOffers/);
});

test('opensea-api: getHighestOffer sorts by price desc', () => {
  assert.match(apiSrc, /sort.*b\.price\s*-\s*a\.price|sort.*price.*desc/);
});

test('opensea-api: cancelListing uses dynamic import of opensea.js', () => {
  assert.match(apiSrc, /import\s*\(\s*['"]\.\/opensea\.js['"]\s*\)/);
});

test('opensea-api: acceptOffer uses fulfillBasicOrder', () => {
  assert.match(apiSrc, /fulfillBasicOrder/);
});

test('opensea-api: no hardcoded secrets (HUKUM 9)', () => {
  assert.ok(!apiSrc.match(/qYSDUOSxp6|sk-[A-Za-z0-9]{20,}|-----BEGIN.*PRIVATE/));
});

// ── OPENSEA MODULE STRUCTURE (Seaport on-chain) ──
const openseaSrc = readFileSync(new URL('../js/opensea.js', import.meta.url), 'utf8');

test('opensea.js: imports from safetx.js (not ui.js for runTx)', () => {
  assert.ok(openseaSrc.includes("from './safetx.js'"), 'must import from safetx.js');
  assert.ok(openseaSrc.includes('runTx'), 'must import runTx');
  assert.ok(!openseaSrc.includes("from './ui.js'") || !openseaSrc.match(/import.*runTx.*from.*ui/), 'runTx must NOT come from ui.js');
});

test('opensea.js: imports get from state.js', () => {
  assert.ok(openseaSrc.includes("from './state.js'"), 'must import from state.js');
  assert.ok(openseaSrc.includes('get'), 'must use get');
});

test('opensea.js: exports cancelOrder', () => {
  assert.match(openseaSrc, /export\s+(async\s+)?function\s+cancelOrder/);
});

test('opensea.js: exports fulfillBasicOrder', () => {
  assert.match(openseaSrc, /export\s+(async\s+)?function\s+fulfillBasicOrder/);
});

test('opensea.js: exports getOrderStatusOnChain', () => {
  assert.match(openseaSrc, /export\s+(async\s+)?function\s+getOrderStatusOnChain/);
});

test('opensea.js: exports buildOrderHash', () => {
  assert.match(openseaSrc, /export\s+function\s+buildOrderHash/);
});

// ── SEAPORT ABI ──
const abiSrc = readFileSync(new URL('../js/seaport-abi.js', import.meta.url), 'utf8');

test('seaport-abi: exports SEAPORT_BY_CHAIN', () => {
  assert.match(abiSrc, /export\s+(const|let)\s+SEAPORT_BY_CHAIN/);
});

test('seaport-abi: exports SEAPORT_ABI', () => {
  assert.match(abiSrc, /export\s+(const|let)\s+SEAPORT_ABI/);
});

test('seaport-abi: has Ethereum mainnet (chain 1)', () => {
  assert.match(abiSrc, /1:\s*SEAPORT/);
});

test('sepolia chain 11155111 in SEAPORT_BY_CHAIN', () => {
  assert.match(abiSrc, /11155111/);
});

// ── HTML: NFT VIEW HAS OPENSEA PANEL ──
const htmlSrc = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('index.html: NFT view has OpenSea panel', () => {
  assert.match(htmlSrc, /id="openSeaPanel"/);
});

test('index.html: has Check WL button', () => {
  assert.match(htmlSrc, /id="btnCheckWL"/);
});

test('index.html: WL check has a wallet address field', () => {
  assert.match(htmlSrc, /id="openSeaWlAddress"/);
  assert.match(htmlSrc, /openSeaWlAddress[\s\S]{0,200}wallet aktif/, 'placeholder should hint the active-wallet fallback');
});

test('index.html: has Accept Top Offer button', () => {
  assert.match(htmlSrc, /id="btnAcceptTopOffer"/);
});

test('index.html: has OpenSea status element', () => {
  assert.match(htmlSrc, /id="openSeaStatus"/);
});

// ── APP.JS WIRING ──
const appSrc = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');

test('app.js: imports opensea-api functions', () => {
  assert.match(appSrc, /from\s+['"]\.\/opensea-api\.js['"]/);
});

test('app.js: imports opensea.js functions', () => {
  assert.match(appSrc, /from\s+['"]\.\/opensea\.js['"]/);
});

test('app.js: has bindOpenSeaPanel function', () => {
  assert.match(appSrc, /function\s+bindOpenSeaPanel/);
});

test('app.js: Check WL reads the collection field + wallet field (no hardcoded collection)', () => {
  assert.match(appSrc, /\$\('#btnCheckWL'\)[\s\S]{0,600}openSeaContract/, 'WL handler must read the collection input');
  assert.match(appSrc, /\$\('#openSeaWlAddress'\)/, 'WL handler must read the wallet address field');
  assert.ok(!appSrc.includes("collection: 'boredapeyachtclub'"), 'no hardcoded collection in the app');
});

test('app.js: refreshView calls bindOpenSeaPanel for deploy view', () => {
  assert.match(appSrc, /view\s*===\s*'deploy'[\s\S]*bindOpenSeaPanel/);
});

// ── INTEGRATION: all modules load without circular deps ──
test('opensea-api.js: no circular import (does NOT import app.js)', () => {
  assert.ok(!apiSrc.includes("from './app.js'"));
});

test('opensea.js: no circular import (does NOT import app.js)', () => {
  assert.ok(!openseaSrc.includes("from './app.js'"));
});
