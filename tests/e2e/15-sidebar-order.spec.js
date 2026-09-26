// 15 — Sidebar order and reachability.
//
// Two defects this locks down:
//   1. The sidebar never had a DApps entry. DApps was only reachable from the
//      old hand-written mobile bar, so it was unreachable on desktop — and when
//      the mobile bar started being generated FROM the sidebar, DApps vanished
//      there too. The view and its container were present the whole time, which
//      is what made it look like the feature had been deleted.
//   2. Swap sat below a divider together with Tools and Approvals, after the
//      very thing it is a peer of, instead of in the middle of the main group.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { gotoApp, skipIntro, createWallet, appClick , openView} from './helpers.js';

const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const i18n = readFileSync(new URL('../../js/i18n.js', import.meta.url), 'utf8');

const sidebar = html.slice(html.indexOf('<nav class="sidebar"'), html.indexOf('</nav>', html.indexOf('<nav class="sidebar"')));

function sidebarViews() {
  return [...sidebar.matchAll(/<div class="nav-item[^"]*"[^>]*data-view="([a-z0-9-]+)"/g)].map((m) => m[1]);
}

test.describe('Sidebar — static', () => {
  test('order is Dashboard, Activity, Swap, NFT, DApps, then Tools, Approvals, then Settings', () => {
    expect(sidebarViews()).toEqual([
      'dashboard', 'activity', 'swap', 'nft', 'dapps',
      'deploy', 'approval', 'settings',
    ]);
  });

  test('Swap is in the main group, before the first divider', () => {
    const swap = sidebar.indexOf('data-view="swap"');
    const firstDivider = sidebar.indexOf('nav-divider');
    expect(swap, 'Swap must appear in the sidebar').toBeGreaterThan(-1);
    expect(firstDivider).toBeGreaterThan(-1);
    expect(swap, 'Swap must sit above the first divider').toBeLessThan(firstDivider);
    // The class sits in the opening tag, which is BEFORE data-view — so the
    // window has to start at the tag, not at the attribute. Slicing forward
    // from data-view could never find it, which made this assert nothing.
    const tagStart = sidebar.lastIndexOf('<div class="nav-item', swap);
    expect(sidebar.slice(tagStart, swap + 200), 'Swap keeps its highlight class')
      .toMatch(/nav-item-highlight/);
  });

  test('every view that exists is reachable from the sidebar', () => {
    const views = [...html.matchAll(/<section class="view[^"]*" id="view-([a-z0-9-]+)"/g)].map((m) => m[1]);
    const nav = sidebarViews();
    // send and bridge are intentionally reached from the dashboard quick
    // actions and the Swap→Bridge chooser, not from the sidebar.
    const viaQuick = ['send', 'bridge'];
    const unreachable = views.filter((v) => !nav.includes(v) && !viaQuick.includes(v));
    expect(unreachable, 'these views exist but nothing navigates to them').toEqual([]);
  });

  test('DApps is in the sidebar with a translated label', () => {
    expect(sidebarViews()).toContain('dapps');
    expect(sidebar).toMatch(/data-view="dapps"[^>]*>[\s\S]*?data-i18n="nav\.dapps"/);
    expect(i18n).toMatch(/'nav\.dapps':\s*'DApps'/);
    // …and the view it points at still exists with its container.
    expect(html).toMatch(/id="view-dapps"/);
    expect(html).toMatch(/id="dappsContainer"/);
  });

  test('every nav label is translated', () => {
    const untranslated = [...sidebar.matchAll(/<div class="nav-item[^"]*"[^>]*>[\s\S]*?<\/div>/g)]
      .map((m) => m[0])
      .filter((blk) => !/data-i18n=/.test(blk));
    expect(untranslated.map((b) => b.slice(0, 60)), 'these nav items hardcode their label').toEqual([]);
  });

  test('no physical line concatenates two nav items', () => {
    const bad = sidebar.split('\n')
      .map((l, n) => [n + 1, l])
      .filter(([, l]) => l.includes('nav-item') && (l.match(/data-view=/g) || []).length > 1);
    expect(bad.map(([n]) => n), 'these lines hold more than one nav item').toEqual([]);
  });

  test('the document is structurally sound', () => {
    const open = (html.match(/<section class="view/g) || []).length;
    const close = (html.match(/<\/section>/g) || []).length;
    expect(open, 'every <section> must be closed').toBe(close);
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    expect([...new Set(ids.filter((x) => ids.indexOf(x) !== x))], 'duplicate ids').toEqual([]);
  });
});

test.describe('Sidebar — in the browser', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
  });

  test('the sidebar shows the expected labels in order', async ({ page }) => {
    const labels = await page.locator('.sidebar .nav-item').evaluateAll((els) => els.map((e) => {
      const s = e.querySelector('[data-i18n]');
      return s ? s.textContent.trim() : e.textContent.trim();
    }));
    expect(labels).toEqual(['Dashboard', 'Activity', 'Swap', 'NFT', 'DApps', 'Tools', 'Approvals', 'Settings']);
  });

  test('DApps opens from the sidebar', async ({ page }) => {
    await appClick(page, '.nav-item[data-view="dapps"]');
    await page.waitForSelector('#dappGrid .dapp-card', { timeout: 10_000 });
    await expect(page.locator('#view-dapps')).toHaveClass(/active/);
    expect(await page.locator('#dappGrid .dapp-card').count()).toBeGreaterThanOrEqual(10);
  });

  test('Swap opens from its new position in the middle', async ({ page }) => {
    await appClick(page, '.nav-item[data-view="swap"]');
    await expect(page.locator('#view-swap')).toHaveClass(/active/);
  });

  test('every sidebar entry opens its view', async ({ page }) => {
    for (const v of ['activity', 'nft', 'dapps', 'deploy', 'approval', 'settings']) {
      await appClick(page, `.nav-item[data-view="${v}"]`);
      await expect(page.locator('#view-' + v), `${v} must open`).toHaveClass(/active/, { timeout: 10_000 });
    }
  });

  test('the mobile More sheet inherits the DApps entry', async ({ page }) => {
    // The bar is generated from the sidebar, so a view missing from the sidebar
    // is missing from the phone too. This is the check that would have caught
    // the original regression.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);
    // No sheet to inspect any more, so reachability is proved the only way that
    // means anything: actually open each one on a phone and check it activates.
    for (const v of ['dapps', 'deploy', 'approval']) {
      await openView(page, v);
      await expect(page.locator('#view-' + v), `${v} must open on a phone`).toHaveClass(/active/);
    }
  });
});
