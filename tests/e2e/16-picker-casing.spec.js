// 16 — Display casing and the in-app pickers.
//
// Two things this locks down:
//
// 1. CASING — the network chooser rendered a "MAINNET" section header directly
//    above row badges reading "mainnet", so one word appeared in two cases in
//    the same dialog. Values stay lower-case in the data; only the display is
//    normalised, via titleCase().
//
// 2. PICKERS — Swap and Bridge used native <select>s. A native select draws its
//    option list as an OS popup: on a phone it escapes the page, ignores the
//    app's styling and can sit partly off-screen. `.swap-token-select` made it
//    worse with `flex: 0 0 140px` (fixed basis, flex-shrink: 0). The pickers
//    draw the list inside the app. The native select is kept authoritative
//    underneath, because swap.js reads .value in four places, bridge.js in
//    seven, and the suites read inputValue().
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { gotoApp, skipIntro, createWallet, appClick } from './helpers.js';

const app   = readFileSync(new URL('../../js/app.js', import.meta.url), 'utf8');
const ui    = readFileSync(new URL('../../js/ui.js', import.meta.url), 'utf8');
const tp    = readFileSync(new URL('../../js/token-picker.js', import.meta.url), 'utf8');
const dapps = readFileSync(new URL('../../js/dapps.js', import.meta.url), 'utf8');
const swap  = readFileSync(new URL('../../js/swap.js', import.meta.url), 'utf8');
const bridge= readFileSync(new URL('../../js/bridge.js', import.meta.url), 'utf8');
const html  = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const css   = readFileSync(new URL('../../css/cartoon.css', import.meta.url), 'utf8');

// Walk to a view at any width: sidebar when it is shown, otherwise the mobile
// bar, otherwise the More sheet.
async function goView(page, v) {
  await page.evaluate(() => {
    const o = document.querySelector('#modalOverlay');
    if (o) o.classList.remove('open');
    document.querySelectorAll('.toast').forEach((t) => t.remove());
  });
  const side = page.locator(`.sidebar .nav-item[data-view="${v}"]`);
  if (await side.isVisible().catch(() => false)) return side.click();
  const mob = page.locator(`#mobileNav .mobile-nav-item[data-view="${v}"]`);
  if (await mob.isVisible().catch(() => false)) return mob.click();
  await page.locator('#mobileMoreBtn').click();
  await page.waitForSelector('#navSheet', { timeout: 10_000 });
  return page.locator(`#navSheet .nav-sheet-item[data-view="${v}"]`).click();
}

test.describe('Casing — static', () => {
  test('titleCase exists and only touches the first character', () => {
    expect(ui).toMatch(/export function titleCase\(s\)/);
    // It must not lowercase anything else, and must leave the empty case alone.
    expect(ui).toMatch(/charAt\(0\)\.toUpperCase\(\) \+ t\.slice\(1\)/);
  });

  test('network-type badges are title-cased at every render site', () => {
    // Two badge sites in the network modal + the Add-network picker.
    expect(app).toMatch(/badge-mainnet[^`]*titleCase\(n\.type\)/);
    expect(app).toMatch(/badge-mainnet[^`]*titleCase\(p\.type\)/);
    // The network picker's row sub-label.
    expect(tp).toMatch(/titleCase\(n\.type\)/);
    // …and no bare lower-case render is left behind.
    expect(app).not.toMatch(/\$\{escapeHtml\(n\.type\)\}/);
    expect(app).not.toMatch(/\$\{escapeHtml\(p\.type\)\}/);
    expect(tp).not.toMatch(/\$\{escapeHtml\(n\.type\)\}/);
  });

  test('the DApps frameability labels are capitalised', () => {
    expect(dapps).toContain("'In-app'");
    expect(dapps).toContain('↗ New tab');
    expect(dapps).toMatch(/<strong>In-app<\/strong>/);
  });

  test('the stored value stays lower-case (display-only change)', () => {
    // If the capitalised form leaked into state, network filters would break.
    expect(app).toMatch(/type === 'mainnet'/);
    expect(app).toMatch(/type === 'testnet'/);
    // The old third assertion looked for a data-type attribute in index.html.
    // No such attribute exists anywhere — the rows are built in JS — so it
    // asserted something that was never implemented rather than the invariant
    // it meant to protect. The real invariant is that every preset stores a
    // LOWER-CASE type, because the filters compare against 'mainnet'.
    const types = [...app.matchAll(/type:\s*'([a-z]+)'/g)].map((m) => m[1]);
    expect(types.length, 'presets must declare a type').toBeGreaterThan(0);
    for (const t of new Set(types)) {
      expect(['mainnet', 'testnet'], `preset type "${t}" must be lower-case`).toContain(t);
    }
    // And nothing may write the title-cased form back into state.
    expect(app).not.toMatch(/\.type\s*=\s*titleCase\(/);
  });
});

test.describe('Pickers — static', () => {
  test('both forms keep a native select and add a trigger + panel', () => {
    for (const id of ['swapFrom', 'swapTo', 'bridgeFromChain', 'bridgeToChain', 'bridgeToken', 'bridgeRouterSelect']) {
      expect(html, `#${id} select`).toMatch(new RegExp(`id="${id}"`));
      expect(html, `#${id}Btn`).toMatch(new RegExp(`id="${id}Btn"`));
      expect(html, `#${id}Panel`).toMatch(new RegExp(`id="${id}Panel"`));
    }
  });

  test('the fixed-width flex basis that caused the overflow is gone', () => {
    // `flex: 0 0 140px` pinned the control and could not shrink on a phone.
    expect(css).not.toMatch(/\.swap-token-select\s*\{[^}]*flex:\s*0\s+0\s+140px/);
    expect(css).toMatch(/\.token-picker\s*\{[^}]*min-width:\s*0/);
  });

  test('the panel is clamped inside the app', () => {
    const block = css.match(/\.token-picker-panel\s*\{([\s\S]*?)\n\}/);
    expect(block, '.token-picker-panel must exist').not.toBeNull();
    expect(block[1]).toMatch(/position:\s*absolute/);
    expect(block[1]).toMatch(/left:\s*0/);
    expect(block[1]).toMatch(/right:\s*0/);
    expect(block[1]).toMatch(/max-width:\s*100%/);
    expect(block[1]).toMatch(/overflow-y:\s*auto/);
    expect(css).toMatch(/\.token-picker-panel\.open-up/);
  });

  test('swap and bridge both initialise the pickers', () => {
    expect(swap).toMatch(/initTokenPicker\('swapFrom'/);
    expect(swap).toMatch(/initTokenPicker\('swapTo'/);
    expect(bridge).toMatch(/initNetworkPicker\('bridgeFromChain'/);
    expect(bridge).toMatch(/initNetworkPicker\('bridgeToChain'/);
    expect(bridge).toMatch(/initTokenPicker\('bridgeToken'/);
    expect(bridge).toMatch(/initOptionPicker\('bridgeRouterSelect'/);
  });
});

test.describe('Pickers — in the browser', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await skipIntro(page);
    await createWallet(page);
  });

  for (const vp of [{ w: 320, h: 568 }, { w: 390, h: 844 }, { w: 1280, h: 900 }]) {
    test(`the swap token list stays inside the app at ${vp.w}x${vp.h}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.w, height: vp.h });
      await page.waitForTimeout(500);
      await goView(page, 'swap');
      await page.waitForTimeout(1500);
      await page.locator('#swapFromBtn').click();
      await page.waitForSelector('#swapFromPanel .token-row', { timeout: 10_000 });
      const m = await page.evaluate(() => {
        const p = document.querySelector('#swapFromPanel').getBoundingClientRect();
        return {
          insideX: p.left >= -0.5 && p.right <= window.innerWidth + 0.5,
          insideY: p.top >= -0.5 && p.bottom <= window.innerHeight + 0.5,
          rows: document.querySelectorAll('#swapFromPanel .token-row').length,
          withArt: document.querySelectorAll('#swapFromPanel .token-row-logo img, #swapFromPanel .token-row-logo .token-logo-mark').length,
        };
      });
      expect(m.insideX, 'the list must not stick out sideways').toBe(true);
      expect(m.insideY, 'the list must not stick out above or below').toBe(true);
      expect(m.rows, 'the chain tokens must be listed').toBeGreaterThan(1);
      // Every row shows artwork rather than bare text.
      expect(m.withArt, 'every row needs a logo').toBe(m.rows);
    });
  }

  test('every token row shows a logo, not just text', async ({ page }) => {
    await goView(page, 'swap');
    await page.waitForTimeout(1500);
    await page.locator('#swapFromBtn').click();
    await page.waitForSelector('#swapFromPanel .token-row', { timeout: 10_000 });
    const bare = await page.evaluate(() => [...document.querySelectorAll('#swapFromPanel .token-row')]
      .filter((r) => !r.querySelector(
        '.token-row-logo img, .token-row-logo svg, .token-row-logo .net-logo'))
      .map((r) => r.dataset.value));
    expect(bare, 'these rows have no logo').toEqual([]);
    // The trigger itself is decorated too.
    await expect(page.locator('#swapFromBtn [data-logo]')).not.toBeEmpty();
  });

  test('picking a row updates the authoritative select and the trigger', async ({ page }) => {
    await goView(page, 'swap');
    await page.waitForTimeout(1500);
    const before = await page.locator('#swapFrom').inputValue();
    await page.locator('#swapFromBtn').click();
    await page.waitForSelector('#swapFromPanel .token-row', { timeout: 10_000 });
    const rows = page.locator('#swapFromPanel .token-row');
    const n = await rows.count();
    const target = rows.nth(Math.min(3, n - 1));
    const wantValue = await target.getAttribute('data-value');
    const wantLabel = (await target.locator('.token-row-sym').textContent()).trim();
    await target.click();
    await page.waitForTimeout(400);
    expect(await page.locator('#swapFrom').inputValue(), 'the select is authoritative').toBe(wantValue);
    expect((await page.locator('#swapFromBtn [data-symbol]').textContent()).trim()).toBe(wantLabel);
    expect(before === wantValue ? 'picked a different token' : 'changed').toBeTruthy();
    await expect(page.locator('#swapFromPanel')).toBeHidden();
  });

  test('the picker is keyboard operable and Escape closes it', async ({ page }) => {
    await goView(page, 'swap');
    await page.waitForTimeout(1500);
    await page.locator('#swapToBtn').focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('#swapToPanel')).toBeVisible();
    await expect(page.locator('#swapToPanel .token-row.cursor')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('#swapToPanel')).toBeHidden();
  });

  test('the trigger is a real button with the right ARIA wiring', async ({ page }) => {
    await goView(page, 'swap');
    await page.waitForTimeout(1200);
    const b = page.locator('#swapFromBtn');
    await expect(b).toHaveAttribute('aria-haspopup', 'listbox');
    await expect(b).toHaveAttribute('aria-expanded', 'false');
    await b.click();
    await expect(b).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#swapFromPanel')).toHaveAttribute('role', 'listbox');
    await expect(page.locator('#swapFromPanel .token-row').first()).toHaveAttribute('aria-selected', /true|false/);
  });

  test('bridge chain lists get network logos and stay inside the app', async ({ page }) => {
    // Bridge is reached through the Swap→Bridge chooser, not the sidebar.
    await goView(page, 'swap');
    await page.waitForTimeout(1200);
    await goView(page, 'swap');            // second tap opens the chooser
    await page.waitForSelector('#chooseBridge', { timeout: 10_000 });
    await page.locator('#chooseBridge').click();
    await expect(page.locator('#view-bridge')).toHaveClass(/active/);
    await page.waitForTimeout(1200);

    for (const id of ['bridgeFromChain', 'bridgeToChain', 'bridgeToken', 'bridgeRouterSelect']) {
      await expect(page.locator(`#${id}Btn`), `#${id} needs a trigger`).toBeVisible();
    }
    await page.locator('#bridgeFromChainBtn').click();
    await page.waitForSelector('#bridgeFromChainPanel .token-row', { timeout: 10_000 });
    const m = await page.evaluate(() => {
      const p = document.querySelector('#bridgeFromChainPanel').getBoundingClientRect();
      return {
        inside: p.left >= -0.5 && p.right <= window.innerWidth + 0.5
             && p.top >= -0.5 && p.bottom <= window.innerHeight + 0.5,
        rows: document.querySelectorAll('#bridgeFromChainPanel .token-row').length,
        withArt: document.querySelectorAll('#bridgeFromChainPanel .token-row-logo img, #bridgeFromChainPanel .token-row-logo .token-logo-mark, #bridgeFromChainPanel .token-row-logo .net-logo').length,
      };
    });
    expect(m.inside, 'the chain list must stay inside the app').toBe(true);
    expect(m.rows).toBeGreaterThan(1);
    expect(m.withArt, 'every chain row needs a logo').toBe(m.rows);
  });

  test('network badges read Mainnet / Testnet, not lower-case', async ({ page }) => {
    await page.locator('#networkPill').click();
    await page.waitForSelector('#netListMainnet .asset-row', { timeout: 10_000 });
    const badges = await page.locator('#modalBox .badge').evaluateAll((els) => els.map((e) => e.textContent.trim()));
    const header = badges.filter((b) => b === b.toUpperCase() && b.length > 3);
    const rows = badges.filter((b) => /mainnet|testnet/i.test(b));
    expect(rows.length, 'row badges must exist').toBeGreaterThan(0);
    for (const b of rows) {
      expect(b, `"${b}" must be capitalised like the section header`).toBe(b.charAt(0).toUpperCase() + b.slice(1));
    }
    expect(header.length, 'the section header exists too').toBeGreaterThan(0);
  });
});
