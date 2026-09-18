// Bear Tool — ui-nav.test.js
// UI invariants for the nav/status/settings changes:
//  - Activity sits next to Dashboard in the sidebar (Send moved out)
//  - the green "Connected" status indicator is gone
//  - Settings has a Testnet mode toggle
//  - NFT empty state says "Not Found", never the user's native balance
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const nft = fs.readFileSync(new URL('../js/nft.js', import.meta.url), 'utf8');

test('sidebar: Activity sits next to Dashboard; Send is not in the sidebar', () => {
  const sidebar = html.match(/<nav class="sidebar"[\s\S]*?<\/nav>/);
  assert.ok(sidebar, 'sidebar nav must exist');
  const dashIdx = sidebar[0].indexOf('data-view="dashboard"');
  const actIdx = sidebar[0].indexOf('data-view="activity"');
  assert.ok(dashIdx !== -1, 'Dashboard nav item must exist');
  assert.ok(actIdx !== -1, 'Activity nav item must exist');
  assert.ok(actIdx > dashIdx, 'Activity must come right after Dashboard');
  // no Send item in the sidebar anymore
  assert.ok(
    !/<div class="nav-item"[^>]*data-view="send"/.test(sidebar[0]),
    'Send must not be a sidebar nav item'
  );
});

test('mobile nav: Activity replaces Send next to Home', () => {
  const mobile = html.match(/<nav class="mobile-nav"[\s\S]*?<\/nav>/);
  assert.ok(mobile, 'mobile nav must exist');
  const homeIdx = mobile[0].indexOf('data-view="dashboard"');
  const actIdx = mobile[0].indexOf('data-view="activity"');
  assert.ok(actIdx > homeIdx, 'Activity must come right after Home');
  assert.ok(
    !/<button class="mobile-nav-item"[^>]*data-view="send"/.test(mobile[0]),
    'Send must not be a mobile nav item'
  );
});

test('dashboard: green Connected status indicator is gone', () => {
  assert.ok(!html.includes('wallet-status'), 'wallet-status block must be removed');
  assert.ok(!html.includes('status-dot'), 'status-dot must be removed');
  assert.ok(!html.includes('status-text'), 'status-text must be removed');
});

test('settings: testnet mode toggle exists and defaults on', () => {
  assert.match(html, /id="setTestnet"/, 'testnet toggle must exist');
  assert.match(html, /id="setTestnet" checked/, 'testnet toggle must default to on');
});

test('nft: empty state says Not Found, never shows native balance', () => {
  assert.match(nft, /Not Found/, 'empty state must say Not Found');
  assert.ok(!nft.includes('Native balance'), 'native balance must not be shown');
});