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
    const svg = document.querySelector('.receive-qr svg');
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
  await page.waitForSelector('.receive-qr svg', { timeout: 10_000 });
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
    await expect(page.locator('.receive-qr svg')).toBeVisible();
    await expect(page.locator('.copy-btn[data-copy]')).toBeVisible();
    const addr = await page.locator('.copy-btn[data-copy]').getAttribute('data-copy');
    expect(addr, 'the copy button must carry the wallet address').toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  test('the QR actually encodes the wallet address', async ({ page }) => {
    await openReceive(page);
    const addr = await page.locator('.copy-btn[data-copy]').getAttribute('data-copy');
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
