// 20 — Every view, on a phone and on a desktop.
//
// The user-facing failures this catches are all the same shape: something is
// pinned wider than the screen, so on a 320px phone part of the control — or
// the whole picker panel — sits off the edge where no thumb can reach it. A
// screenshot hides it because the browser clips silently and nothing looks
// broken, so these tests measure geometry and name the offending element.
//
// Two rules keep the measurement honest:
//   - an element inside a horizontally scrollable ancestor is NOT an overflow
//     (the NFT carousel and the browser tab strip are meant to scroll)
//   - only the ACTIVE view is measured, since hidden views have no layout
import { test, expect } from '@playwright/test';
import { gotoApp, skipIntro, createWallet, appClick } from './helpers.js';

const VIEWS = [
  'dashboard', 'send', 'swap', 'bridge',
  'approval', 'deploy', 'activity', 'nft', 'dapps', 'settings',
];

// 320 is the narrowest phone still worth supporting and is where fixed-width
// CSS breaks first; 1440 is a normal desktop.
const VIEWPORTS = [
  { name: 'phone-320', width: 320, height: 568 },
  { name: 'phone-390', width: 390, height: 844 },
  { name: 'tablet-768', width: 768, height: 1024 },
  { name: 'laptop-1280', width: 1280, height: 800 },
  { name: 'desktop-1440', width: 1440, height: 900 },
];

// Navigating a view is layout-dependent, and getting this wrong is what made
// the first run of this file fail at every size: the sidebar is display:none on
// a phone, so clicking .nav-item there waits for a box that never exists. The
// phone route is the generated bottom bar, then the More sheet — which the app
// builds from the same sidebar list, so no view is unreachable.
async function openView(page, view) {
  const side = page.locator(`.sidebar .nav-item[data-view="${view}"]`);
  if (await side.isVisible().catch(() => false)) {
    await appClick(page, `.sidebar .nav-item[data-view="${view}"]`);
    return;
  }
  const bar = page.locator(`.mobile-nav-item[data-view="${view}"]`);
  if (await bar.isVisible().catch(() => false)) {
    await appClick(page, `.mobile-nav-item[data-view="${view}"]`);
    return;
  }
  // Two views are deliberately not in the sidebar, and assuming otherwise is
  // what made the first two runs of this file fail at every size: the walk
  // waited for a nav item that does not exist. The sidebar has exactly eight
  // entries. Send is a dashboard quick action, and Bridge lives under a
  // Swap/Bridge chooser that a second press of Swap opens.
  if (view === 'send') {
    await openView(page, 'dashboard');
    await appClick(page, '.quick-action-btn[data-view="send"]');
    return;
  }
  if (view === 'bridge') {
    await openView(page, 'swap');
    await appClick(page, '.sidebar .nav-item[data-view="swap"], .mobile-nav-item[data-view="swap"]');
    await page.waitForSelector('#chooseBridge', { timeout: 10_000 });
    await appClick(page, '#chooseBridge');
    return;
  }
  await appClick(page, '#mobileMoreBtn');
  await page.waitForSelector(`#navSheet .nav-sheet-item[data-view="${view}"]`, { timeout: 10_000 });
  await appClick(page, `#navSheet .nav-sheet-item[data-view="${view}"]`);
}

/** The view must actually be the active one, or the measurement is of nothing. */
async function assertViewActive(page, view) {
  await page.waitForFunction(
    (v) => document.getElementById('view-' + v)?.classList.contains('active'),
    view, { timeout: 10_000 },
  );
}

const MEASURE = (viewId) => `(() => {
  const de = document.documentElement;
  const vw = de.clientWidth;
  const view = document.getElementById('view-${viewId}');
  if (!view) return { error: 'view-${viewId} not found' };

  const scrolls = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (/(auto|scroll)/.test(cs.overflowX)) return true;
    }
    return false;
  };

  const bad = [];
  for (const el of view.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.position === 'fixed') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    if (r.right <= vw + 1) continue;
    if (scrolls(el)) continue;                 // meant to scroll sideways
    const cls = String(el.className || '').split(' ').filter(Boolean).slice(0, 2).join('.');
    bad.push(el.tagName.toLowerCase() + (cls ? '.' + cls : '') + ' right=' + Math.round(r.right));
  }

  // Controls that are present but narrower than a usable touch target are a
  // separate complaint from overflow, so they are measured, not asserted here.
  const clipped = [];
  for (const el of view.querySelectorAll('button, input, select, a[href]')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1) continue;
    if (r.right > vw + 1 || r.left < -1) clipped.push(el.id || el.className || el.tagName);
  }

  return {
    vw,
    docOverflow: de.scrollWidth - de.clientWidth,
    overflowing: bad.slice(0, 6),
    overflowingCount: bad.length,
    clippedControls: clipped.slice(0, 6),
  };
})()`;

test.describe('Every view — phone and desktop', () => {
  for (const vp of VIEWPORTS) {
    test(`no view overflows at ${vp.name}`, async ({ page }) => {
      // Ten views, each with a navigation and a measurement, on top of a cold
      // keystore. The default 45s is not enough and the failure mode it
      // produces points at a nav item that never became clickable.
      test.setTimeout(240_000);
      const errors = [];
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
      page.on('pageerror', (e) => errors.push('pageerror: ' + String(e.message).slice(0, 160)));

      await page.setViewportSize({ width: vp.width, height: vp.height });
      await gotoApp(page);
      await skipIntro(page);
      await createWallet(page);
      await page.waitForSelector('.sidebar', { state: 'attached', timeout: 20_000 });
      await expect(page.locator('.sidebar .nav-item[data-view="dashboard"]'),
        'the wallet must be created before the views can be measured').toHaveCount(1);

      const problems = [];
      for (const v of VIEWS) {
        await openView(page, v);
        await assertViewActive(page, v);
        await page.waitForTimeout(350);

        const m = await page.evaluate(MEASURE(v));
        expect(m.error, `${v} must exist`).toBeUndefined();
        if (m.docOverflow > 1) problems.push(`${v}: document scrolls ${m.docOverflow}px sideways`);
        if (m.overflowingCount) problems.push(`${v}: ${m.overflowingCount} element(s) past the right edge — ${m.overflowing.join(', ')}`);
        if (m.clippedControls.length) problems.push(`${v}: control(s) off-screen — ${m.clippedControls.join(', ')}`);
      }

      expect(problems, `at ${vp.name}:\n` + problems.join('\n')).toEqual([]);
      // CoinGecko rate-limiting is a known, tolerated condition; anything else
      // is a real error and is reported by name.
      const real = errors.filter((e) => !/coingecko|api\.coingecko|Failed to load resource/.test(e));
      expect(real, `console errors at ${vp.name}:\n` + real.join('\n')).toEqual([]);
    });
  }
});

test.describe('Every view — the swap and bridge pickers stay reachable', () => {
  for (const vp of [{ name: 'phone-320', width: 320, height: 568 }, { name: 'phone-390', width: 390, height: 844 }]) {
    test(`the swap picker panel fits the screen at ${vp.name}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await gotoApp(page);
      await skipIntro(page);
      test.setTimeout(180_000);
      await createWallet(page);

      for (const [view, trigger, panel] of [
        ['swap', '#swapFromBtn', '#swapFromPanel'],
        ['bridge', '#bridgeTokenBtn', '#bridgeTokenPanel'],
      ]) {
        await openView(page, view);
        await assertViewActive(page, view);
        await page.waitForTimeout(400);
        await appClick(page, trigger);
        await page.waitForTimeout(350);

        const box = await page.locator(panel).boundingBox();
        expect(box, `${view} picker must open`).not.toBeNull();
        expect(box.x, `${view} picker starts off the left edge`).toBeGreaterThanOrEqual(-1);
        expect(
          box.x + box.width,
          `${view} picker runs past the right edge (${Math.round(box.x + box.width)} > ${vp.width})`,
        ).toBeLessThanOrEqual(vp.width + 1);
      }
    });
  }
});
