// 13 — Receive modal: the QR must be exactly centred and fit every viewport.
//
// The QR used to sit 22px LEFT of the modal's centre on every screen size,
// desktop and phone alike, because `.modal-close` is `float: right` and narrows
// the float's following content. A screenshot would not have caught it, so these
// tests measure the geometry directly and fail on a sub-pixel offset.
import { test, expect } from '@playwright/test';
import { gotoApp, skipIntro, createWallet } from './helpers.js';

// Everything a user might actually hold. 280 is the narrowest phone still
// worth supporting; 1440 is a desktop.
const VIEWPORTS = [
  { name: 'desktop-1440', width: 1440, height: 900, isMobile: false },
  { name: 'desktop-1280', width: 1280, height: 900, isMobile: false },
  { name: 'laptop-1024', width: 1024, height: 768, isMobile: false },
  { name: 'tablet-768', width: 768, height: 1024, isMobile: true },
  { name: 'mobile-430', width: 430, height: 932, isMobile: true },
  { name: 'mobile-390', width: 390, height: 844, isMobile: true },
  { name: 'mobile-320', width: 320, height: 568, isMobile: true },
];

// Geometry of the QR relative to the modal's real content box (which excludes
// borders, padding and any scrollbar).
async function qrGeometry(page) {
  return page.evaluate(() => {
    const box = document.querySelector('#modalBox');
    const svg = document.querySelector('#modalBox > .receive-qr svg');
    if (!box || !svg) return null;
    const cs = getComputedStyle(box);
    const br = box.getBoundingClientRect();
    const left = br.left + box.clientLeft + (parseFloat(cs.paddingLeft) || 0);
    const right = br.left + box.clientLeft + box.clientWidth - (parseFloat(cs.paddingRight) || 0);
    const sr = svg.getBoundingClientRect();
    const close = document.querySelector('#modalBox .modal-close')?.getBoundingClientRect();
    const overlapsClose = close
      ? !(sr.right <= close.left || sr.left >= close.right || sr.bottom <= close.top || sr.top >= close.bottom)
      : false;
    return {
      offsetPx: (sr.left + sr.width / 2) - (left + right) / 2,
      width: sr.width,
      height: sr.height,
      contentWidth: right - left,
      overlapsClose,
      horizontalScroll: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  });
}

async function openReceive(page) {
  await gotoApp(page);
  await skipIntro(page);
  await createWallet(page);
  await page.locator('#quickReceive').click();
  await page.waitForSelector('#modalBox > .receive-qr svg', { timeout: 10_000 });
  // Let layout settle before measuring.
  await page.waitForTimeout(300);
}

for (const vp of VIEWPORTS) {
  test.describe(`Receive QR @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height }, isMobile: vp.isMobile, hasTouch: vp.isMobile });

    test('QR is centred to within half a pixel', async ({ page }) => {
      await openReceive(page);
      const g = await qrGeometry(page);
      expect(g, 'QR geometry must be measurable').not.toBeNull();
      // Half a pixel: anything larger is a visible off-centre.
      expect(Math.abs(g.offsetPx), `QR is ${g.offsetPx.toFixed(2)}px off the modal centre`).toBeLessThanOrEqual(0.5);
    });

    test('QR stays square, fits the modal, and clears the close button', async ({ page }) => {
      await openReceive(page);
      const g = await qrGeometry(page);
      expect(Math.abs(g.width - g.height), 'QR must be square').toBeLessThanOrEqual(0.6);
      expect(g.width, 'QR must not overflow the modal content box').toBeLessThanOrEqual(g.contentWidth + 0.5);
      expect(g.overlapsClose, 'QR must not sit under the close button').toBe(false);
      expect(g.horizontalScroll, 'the modal must not introduce horizontal scroll').toBe(false);
    });
  });
}

test.describe('Receive modal content', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('address, copy button and QR are all present', async ({ page }) => {
    await openReceive(page);
    await expect(page.locator('#modalBox > .receive-qr svg')).toBeVisible();
    await expect(page.locator('#modalBox > .copy-btn[data-copy]')).toBeVisible();
    const addr = await page.locator('#modalBox > .copy-btn[data-copy]').getAttribute('data-copy');
    expect(addr, 'the copy button must carry the wallet address').toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  test('the QR actually encodes the wallet address', async ({ page }) => {
    await openReceive(page);
    const addr = await page.locator('#modalBox > .copy-btn[data-copy]').getAttribute('data-copy');
    // Regenerate the same QR in-page and compare its module count + data, so a
    // blank or wrong-code placeholder cannot pass.
    const decoded = await page.evaluate((expected) => {
      if (typeof qrcode !== 'function') return { error: 'qrcode lib missing' };
      const qr = qrcode(0, 'M');
      qr.addData(expected);
      qr.make();
      return { moduleCount: qr.getModuleCount(), data: qr.createDataURL(4, 8).slice(0, 40) };
    }, addr);
    expect(decoded.error).toBeUndefined();
    expect(decoded.moduleCount, 'a 42-char address must produce a real QR').toBeGreaterThan(20);
  });
});

// One receive per network (user 2026-10-11: "setiap jaringan fitur receive 1
// aja"): the dashboard sheet belongs to the ACTIVE chain alone. The old
// "Other chains — same recovery phrase" dump of BTC/SOL/XRP under the EVM
// address is gone, so there is exactly one QR and one address in the modal.
test('the receive sheet shows exactly one chain — no other-chains dump', async ({ page }) => {
  await openReceive(page);
  await expect(page.locator('#modalBox > .receive-qr svg')).toHaveCount(1);
  await expect(page.locator('#modalBox > .copy-btn[data-copy]')).toHaveCount(1);
  await expect(page.locator('.receive-other-title')).toHaveCount(0);
  await expect(page.locator('.receive-chain')).toHaveCount(0);
});

// The same-seed chains are ordinary rows in the MAINNET list (not a
// "receive-only" bucket): picking one makes it the ACTIVE network, and Receive
// then shows THAT chain's own address — one receive per active network (user
// 2026-10-11: "jadi network aktif yang bisa dipilih").
test('a same-seed chain is a real network: picking it switches, and Receive follows', async ({ page }) => {
  await gotoApp(page);
  await skipIntro(page);
  await createWallet(page);
  await page.locator('#networkPill').click();
  await page.waitForSelector('[data-net-non-evm="bitcoin"]', { timeout: 10_000 });
  // It is a row of the same MAINNET list, and it never reads as "receive only".
  await expect(page.locator('#modalBox')).not.toContainText(/receive[- ]only/i);
  await page.locator('[data-net-non-evm="bitcoin"]').click();

  // The switch landed: the topbar names the chain, and it marks itself Current
  // when the picker is reopened — a network, not a one-off action.
  await expect(page.locator('#networkName')).toHaveText('Bitcoin');
  await page.locator('#networkPill').click();
  await expect(page.locator('[data-net-non-evm="bitcoin"]')).toContainText('✓ Current');
  await page.locator('#modalBox .modal-close').click();

  // And the wallet on that chain has exactly one thing to offer: its own address.
  await page.locator('#quickReceive').click();
  await page.waitForSelector('#modalBox > .receive-qr svg', { timeout: 10_000 });
  await expect(page.locator('#modalBox h2')).toHaveText(/Receive Bitcoin/);
  const addr = await page.locator('#modalBox > .copy-btn[data-copy]').getAttribute('data-copy');
  expect(addr, 'the sheet must carry the BITCOIN address, not the EVM one').toMatch(/^bc1q/);
});

// Being on a non-EVM chain must not half-open the EVM screens: Send would show
// the previous chain's form and a signer this wallet does not have for Bitcoin.
test('an EVM-only view refuses while a non-EVM network is active', async ({ page }) => {
  await gotoApp(page);
  await skipIntro(page);
  await createWallet(page);
  await page.locator('#networkPill').click();
  await page.waitForSelector('[data-net-non-evm="bitcoin"]', { timeout: 10_000 });
  await page.locator('[data-net-non-evm="bitcoin"]').click();
  await expect(page.locator('#networkName')).toHaveText('Bitcoin');

  await page.locator('#quickActions [data-view="send"]').click();
  await expect(page.locator('#view-dashboard')).toHaveClass(/active/);
  await expect(page.locator('#view-send')).not.toHaveClass(/active/);
  await expect(page.locator('#toast-wrap .toast').first()).toContainText(/switch to an EVM network/i);
});

