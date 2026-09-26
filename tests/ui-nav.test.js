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
const jsApp = fs.readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');

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
  // The mobile bar is no longer hand-written HTML — syncMobileNav() builds it
  // from the sidebar so the two cannot drift (eip7702/approval/deploy used to
  // be desktop-only). So assert on the generator, and on the markup contract.
  assert.match(
    jsApp,
    /const MOBILE_PRIMARY = \[[^\]]*'activity'/,
    'MOBILE_PRIMARY must include activity'
  );
  assert.match(
    jsApp,
    /MOBILE_PRIMARY = \[[^\]]*\]/,
    'MOBILE_PRIMARY must exist'
  );
  assert.ok(
    !/MOBILE_PRIMARY = \[[^\]]*'send'/.test(jsApp),
    'Send must not be a bottom-bar item'
  );
  // The container is intentionally empty in index.html — items are injected.
  const mobile = html.match(/<nav class="mobile-nav"[^>]*><\/nav>/);
  assert.ok(mobile, 'mobile nav must exist and be empty (built by syncMobileNav)');
  assert.ok(
    !/<button class="mobile-nav-item"[^>]*data-view="send"/.test(html),
    'Send must not be a mobile nav item'
  );
});

test('mobile nav: every sidebar view is reachable from the phone', () => {
  // The whole point of generating the bar: no view may exist only on desktop.
  const sidebarViews = [...html.matchAll(/<div class="nav-item[^"]*" data-view="([a-z0-9-]+)"/g)].map((m) => m[1]);
  // 8 entries: EIP-7702 was merged into Tools, so the count dropped from 9.
  // The invariant is parity between sidebar and phone, not a fixed number.
  assert.ok(sidebarViews.length >= 8, `sidebar must list the views, got ${sidebarViews.length}`);
  assert.match(jsApp, /const items = \[\.\.\.\$all\('\.sidebar \.nav-item'\)\]/,
    'syncMobileNav must read the sidebar as its single source of truth');
  // Five fixed slots, in the order the user named them, and no More.
  const mSlots = jsApp.match(/const MOBILE_PRIMARY = \[([^\]]+)\]/);
  assert.ok(mSlots, 'MOBILE_PRIMARY must exist');
  const slots = [...mSlots[1].matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]);
  assert.deepEqual(slots, ['dashboard', 'activity', 'swap', 'dapps', 'settings'],
    `the bottom bar must be exactly those five, in that order — got ${JSON.stringify(slots)}`);
  assert.ok(!jsApp.includes('mobileMoreBtn'),
    'the More button is gone; a sixth slot behind a guess is what it replaced');
  assert.ok(!jsApp.includes('showMoreSheet'),
    'the More sheet has no callers and must not linger as a second, parallel route');

  // The invariant that replaced "there is a More button": a view is reachable on
  // a phone if it is a slot OR REACHABLE_ON_MOBILE names a route for it. This is
  // stronger than the old check — that one only proved a button existed, and
  // would have been satisfied by a More sheet that listed the views without
  // making any of them actually reachable.
  const mReach = jsApp.match(/const REACHABLE_ON_MOBILE = \{([\s\S]*?)\n\};/);
  assert.ok(mReach, 'REACHABLE_ON_MOBILE must exist next to MOBILE_PRIMARY');
  const routes = new Set([...mReach[1].matchAll(/^\s*([a-z0-9-]+):/gm)].map((m) => m[1]));
  const unreachable = sidebarViews.filter((v) => !slots.includes(v) && !routes.has(v));
  assert.deepEqual(unreachable, [],
    `sidebar views with no route on a phone: ${unreachable.join(', ')} — a view that exists on desktop and not on mobile is the bug this map exists to prevent`);
  for (const v of ['approval', 'deploy', 'dapps', 'settings']) {
    assert.ok(sidebarViews.includes(v), `${v} must be a sidebar view`);
  }
  // The EIP-7702 suite must live inside Tools, not be a view of its own.
  assert.ok(!sidebarViews.includes('eip7702'), 'EIP-7702 must not be a separate nav entry');
  const toolsStart = html.indexOf('id="view-deploy"');
  const toolsEnd = html.indexOf('id="view-activity"');
  const tools = html.slice(toolsStart, toolsEnd === -1 ? undefined : toolsEnd);
  for (const id of ['btnDelegate', 'btnRevoke', 'batchList', 'btnRescue', 'btnClaim', 'deployStandard']) {
    assert.ok(tools.includes(`id="${id}"`), `#${id} must be inside Tools`);
  }
});

test('dashboard: green Connected status indicator is gone', () => {
  assert.ok(!html.includes('wallet-status'), 'wallet-status block must be removed');
  assert.ok(!html.includes('status-dot'), 'status-dot must be removed');
  assert.ok(!html.includes('status-text'), 'status-text must be removed');
});

test('the testnet filter lives in the network picker, not in Settings', () => {
  // Settings is five settings and nothing else: what the app looks like, how
  // long it holds a key, and the delete button. The testnet filter moved out of
  // it because it does not describe the app - it describes which chains are on
  // screen, so it belongs beside the list it filters.
  assert.doesNotMatch(html, /id="setTestnet"/,
    'the testnet switch is no longer a Settings field');
  assert.match(jsApp, /id="netShowTestnet"/,
    'it must exist in the network picker, generated with the list it filters');
  // It only works if it is reachable while testnets are hidden, so it must not
  // be inside the .mb-8 header that the search box hides when nothing matches.
  const picker = jsApp.slice(jsApp.indexOf('id="netListTestnet"'));
  const toggleAt = picker.indexOf('id="netShowTestnet"');
  const headerAt = picker.indexOf('class="mb-8 mt-16"');
  assert.ok(toggleAt > -1 && headerAt > -1, 'both the header and the filter must exist');
  assert.ok(toggleAt > headerAt + 'class="mb-8 mt-16"'.length,
    'the filter must be a sibling of the .mb-8 header, not inside it - a filter you cannot reach after searching is a filter you cannot turn back off');
  // And it must apply the moment it is flipped, not on Save.
  const handler = jsApp.slice(jsApp.indexOf("id=\"netShowTestnet\""));
  assert.match(handler.slice(0, 900), /addEventListener\('change'/,
    'the filter must react to the change itself');
  assert.match(handler.slice(0, 900), /saveSettings\(\)/,
    'and it must persist, otherwise it forgets on reload');
});

test('nft: empty state says "NFT not found" and never shows a native balance', () => {
  const css = fs.readFileSync(new URL('../css/cartoon.css', import.meta.url), 'utf8');
  // The empty state used to be a bare <p class="small text-center">Not Found</p>.
  // Inside .nft-grid (auto-fill minmax(140px,1fr)) that became ONE 140px cell in
  // the corner, so it was not actually centred. It is now .nft-empty, which
  // spans the grid and centres on both axes.
  assert.match(nft, /NFT not found/, 'empty state must say "NFT not found"');
  assert.match(nft, /class="nft-empty"/, 'empty state must use .nft-empty so it centres');
  assert.match(nft, /NFT gallery unavailable/, 'a failed enumeration must say so separately');
  assert.ok(!nft.includes('Native balance'), 'native balance must not be shown');
  assert.ok(!/<p class="small text-center">Not Found<\/p>/.test(nft), 'the old corner-hugging markup must be gone');

  // The centring itself lives in the stylesheet, not the module.
  const block = css.match(/\.nft-empty\s*\{([\s\S]*?)\n\}/);
  assert.ok(block, '.nft-empty must be defined in cartoon.css');
  assert.match(block[1], /grid-column:\s*1\s*\/\s*-1/, 'must span every grid column');
  assert.match(block[1], /justify-content:\s*center/, 'must centre vertically');
  assert.match(block[1], /align-items:\s*center/, 'must centre horizontally');
  assert.match(block[1], /display:\s*flex/, 'must be a flex box to centre on both axes');
});

test('i18n: the swap label is "Swap", not translated to "Tukar"', () => {
  const i18n = fs.readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');
  const labels = [...i18n.matchAll(/'nav\.swap':\s*'([^']+)'/g)].map((m) => m[1]);
  assert.equal(labels.length, 2, 'both the EN and the ID block must define nav.swap');
  for (const l of labels) {
    assert.equal(l, 'Swap', `nav.swap must be "Swap" in every language block, got "${l}"`);
  }
  const titles = [...i18n.matchAll(/'swap\.title':\s*'([^']+)'/g)].map((m) => m[1]);
  for (const t of titles) {
    assert.ok(!/Tukar/.test(t), `swap.title must not say Tukar, got "${t}"`);
  }
});