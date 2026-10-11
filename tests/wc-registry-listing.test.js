// Guards for the WalletConnect registry listing packet (docs/WC-REGISTRY-LISTING.md).
//
// Three things can rot silently here, so each has a test:
//   1. the 512x512 logo — a chromium/sharp render that fails still writes a
//      file (blank page, error page), so the pixels are checked, not the name;
//   2. the universal-link page runs attacker-controlled input straight into the
//      OS — the validation is executed against hostile URIs, not just grepped;
//   3. the chain list in the doc must equal the chain list in the app
//      (HUKUM 10: numbers in prose are facts, and facts drift).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import zlib from 'node:zlib';

const root = new URL('..', import.meta.url);

test('the listing logo is a real 512x512 PNG, not a blank or error render', () => {
  const file = new URL('assets/bear-512.png', root);
  assert.ok(existsSync(file), 'assets/bear-512.png must be committed for the dashboard upload');
  const buf = readFileSync(file);
  assert.equal(buf.subarray(1, 4).toString('latin1'), 'PNG', 'PNG signature');
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  assert.deepEqual([w, h], [512, 512], 'the registry wants a square logo — 512x512');

  // Decode for real: a failed headless render still produces a valid PNG.
  const colorType = buf[25];
  let off = 8;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString('latin1');
    if (type === 'IDAT') idat.push(buf.subarray(off + 8, off + 8 + len));
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = colorType === 6 ? 4 : 3;
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  const paeth = (a, b, c) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = y > 0 && x >= bpp ? out[(y - 1) * stride + x - bpp] : 0;
      let v = raw[y * (stride + 1) + 1 + x];
      if (ft === 1) v += a; else if (ft === 2) v += b; else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) v += paeth(a, b, c);
      out[y * stride + x] = v & 255;
    }
  }
  const px = (x, y) => { const i = y * stride + x * bpp; return [out[i], out[i + 1], out[i + 2]].join(','); };
  const colors = new Set();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) colors.add(px(x, y));
  assert.ok(colors.size > 50, `logo must contain the mascot, got ${colors.size} distinct colours`);
  // Brand dark #1a1a2e corners = the background actually rendered.
  for (const [x, y] of [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]]) {
    assert.equal(px(x, y), '26,26,46', `corner ${x},${y} must be the brand dark background`);
  }
});

// The landing page is the only place in the project that navigates to a value
// taken from a URL. Run its validation instead of trusting a regex.
function runPage(search) {
  const html = readFileSync(new URL('public/wc/index.html', root), 'utf8');
  const code = html.slice(html.indexOf('<script>') + '<script>'.length, html.indexOf('</script>'));
  assert.ok(code.includes('location.replace'), 'sanity: the landing script was extracted');
  const els = {};
  const nav = { to: null };
  const g = globalThis;
  const saved = { document: g.document, location: g.location };
  g.document = {
    getElementById: (id) => (els[id] ||= { textContent: '', href: '', hidden: true }),
  };
  g.location = { search, replace: (u) => { nav.to = u; } };
  try {
    new Function(code)();
  } finally {
    g.document = saved.document;
    g.location = saved.location;
  }
  return { nav: nav.to, els };
}

const TOPIC = 'a'.repeat(64);
const VALID = `wc:${TOPIC}@2?relay-protocol=irn&symKey=${'b'.repeat(64)}`;

test('the universal-link page forwards a wc: URI from uri=, wc= or any wc: parameter', () => {
  const enc = encodeURIComponent(VALID);
  assert.equal(runPage(`?uri=${enc}`).nav, VALID, '?uri= is the registry convention');
  assert.equal(runPage(`?wc=${enc}`).nav, VALID, "?wc= is Bear Tool's own web fallback");
  assert.equal(runPage(`?link=${enc}`).nav, VALID, 'a differently named parameter still works');
  const r = runPage(`?uri=${enc}`);
  assert.equal(r.els.open.href, VALID, 'the manual button is the fallback when the redirect is blocked');
  assert.equal(r.els.open.hidden, false);
});

test('the universal-link page refuses anything that is not a wc: URI', () => {
  const hostile = [
    'javascript:alert(document.domain)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'https://evil.example/wc?uri=wc:not-really',
    'http://localhost:8080/?wc=wc:x',
    `wc:${'a'.repeat(64)} with space`,
    `wc:${'a'.repeat(64)}\n@2`,
    'wc:short',
    `wc:${'a'.repeat(3000)}@2`,
    '',
  ];
  for (const bad of hostile) {
    const { nav, els } = runPage(`?uri=${encodeURIComponent(bad)}`);
    assert.equal(nav, null, `must not navigate to: ${bad.slice(0, 40)}`);
    assert.match(els.title.textContent, /not a Bear Tool pairing link/,
      `must explain the refusal for: ${bad.slice(0, 40)}`);
    assert.equal(els.open.hidden, true, 'no open button for a refused URI');
  }
  const missing = runPage('');
  assert.equal(missing.nav, null);
  assert.match(missing.els.err.textContent, /No uri parameter/, 'empty link says what is missing');
});

test('the page never builds a URL from the parameter by string concatenation', () => {
  const html = readFileSync(new URL('public/wc/index.html', root), 'utf8');
  assert.doesNotMatch(html, /innerHTML/, 'the parameter must never reach HTML parsing');
  assert.doesNotMatch(html, /href\s*=\s*['"]?'?\+?\s*(location|params)/,
    'href is set from the validated variable only');
  assert.match(html, /if \(!isValid\(uri\)\)/, 'the validity check gates navigation');
});

test('the doc chain list equals the app chain list (HUKUM 10)', async () => {
  const { NETWORKS } = await import('../js/network.js');
  const mainnet = NETWORKS.filter((n) => n.type === 'mainnet').map((n) => `eip155:${n.chainId}`);
  const doc = readFileSync(new URL('docs/WC-REGISTRY-LISTING.md', root), 'utf8');
  const listed = doc.match(/eip155:\d+/g) || [];
  assert.deepEqual(listed, mainnet,
    'every eip155 id in the listing doc must match js/network.js mainnet, in order');
  assert.match(doc, new RegExp(`the ${mainnet.length} mainnet`),
    `the doc must state the true mainnet count (${mainnet.length})`);
});

test('the packet is wired: logo tool in CI, page in the web deploy', () => {
  const pages = readFileSync(new URL('.github/workflows/pages.yml', root), 'utf8');
  assert.match(pages, /tools\/make-wc-logo\.mjs/, 'CI regenerates the logo (a public copy)');
  assert.match(pages, /npm run build/, 'the web deploy still builds dist/');
  assert.ok(existsSync(new URL('public/wc/index.html', root)),
    'public/ is what Vite copies into dist/ — the page must live there');
  const tool = readFileSync(new URL('tools/make-wc-logo.mjs', root), 'utf8');
  assert.match(tool, /const SIZE = 512/, 'logo size is pinned to what the registry wants');
});
