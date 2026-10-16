// 24 — The EIP-6963 wallet icon: base64, sized, and it actually renders.
//
// 2026-10-16: Etherscan's "Other Wallets" rendered "Bear Tool" with a broken
// image ("Bea Too") because the announced icon was a RAW <svg> data URI —
// unescaped quotes and angle brackets break wherever the string meets HTML
// attribute quoting or a strict URL parser. The icon is now base64; this
// spec proves the URI shape, the decoded artwork AND that a real renderer
// produces pixels from it (naturalWidth > 0) — the failure mode a pure
// string assertion can never catch.
import { test, expect } from '@playwright/test';
// The provider lives as a STRING inside an ES module (it gets injected into
// the native dApp WebView as a classic script). Inline the string, never the
// module file itself: `addScriptTag` would parse `export` as a classic script
// and die with a SyntaxError before any listener exists.
import { NATIVE_PROVIDER_SCRIPT } from '../../js/native-provider.js';

test.describe('native provider icon', () => {
  test('announced icon is a base64 data URI that renders with real pixels', async ({ page }) => {
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.addScriptTag({ content: NATIVE_PROVIDER_SCRIPT });

    const icon = await page.evaluate(() => {
      let found = '';
      const onAnnounce = (e) => { found = (e && e.detail && e.detail.info && e.detail.info.icon) || ''; };
      window.addEventListener('eip6963:announceProvider', onAnnounce);
      window.dispatchEvent(new Event('eip6963:requestProvider'));
      window.removeEventListener('eip6963:announceProvider', onAnnounce);
      return found;
    });

    expect(icon, 'the provider must announce an icon').toBeTruthy();
    expect(icon.startsWith('data:image/svg+xml;base64,'), 'raw <svg> data URIs render broken — base64 only').toBe(true);
    expect(icon, 'base64 alphabet only — nothing to mis-quote').not.toMatch(/[<>"]/);

    const svg = Buffer.from(icon.split(',')[1], 'base64').toString('utf8');
    expect(svg).toContain('<svg');
    expect(svg, 'a definite size — renderers must never auto-size to 0x0').toContain('width="64"');
    expect(svg).toContain('height="64"');

    const dims = await page.evaluate(async (uri) => {
      const img = new Image();
      const settled = new Promise((resolve) => {
        img.onload = () => resolve([img.naturalWidth, img.naturalHeight]);
        img.onerror = () => resolve([0, 0]);
      });
      img.src = uri;
      return settled;
    }, icon);
    expect(dims[0], 'a broken data URI is exactly 0 naturalWidth').toBeGreaterThan(0);
    expect(dims[1]).toBeGreaterThan(0);
  });
});
