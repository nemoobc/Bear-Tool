// Rasterize assets/bear.svg into the 512px PNG the WalletConnect registry
// listing needs (the Cloud dashboard takes a square logo; the Explorer API then
// serves it as image_url sm/md/lg). One file, one geometry, two rasterizers:
//
//   * chromium-browser --headless (what Termux has — sharp ships no prebuilt
//     for android-arm64v8, see tools/make-assets.mjs)
//   * sharp (what CI has)
//
// Both draw the same picture: a 512x512 canvas in the brand dark #1a1a2e with
// the bear at 440px, centred — the same margin trick as tools/make-assets.mjs,
// so a rounded mask never clips the ears. Reproducible on purpose: the listing
// logo can never drift from the app icon the way a hand-cropped screenshot
// would.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const OUT = process.env.WC_LOGO_OUT || 'assets/bear-512.png';
const SIZE = 512;
const BEAR = 440;
const BG = '#1a1a2e';

const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;

async function viaSharp() {
  const { default: sharp } = await import('sharp');
  const bear = await sharp('assets/bear.svg', { density: 600 })
    .resize(BEAR, BEAR, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  await sharp({ create: { width: SIZE, height: SIZE, channels: 4, background: { r: 26, g: 26, b: 46, alpha: 1 } } })
    .composite([{ input: bear, gravity: 'centre' }])
    .png()
    .toFile(OUT);
  return 'sharp';
}

function viaChromium() {
  // Drop the root width/height the SVG ships with instead of appending ours:
  // duplicate attributes are ignored (the FIRST wins), so the mascot would
  // render at its intrinsic 200px inside the 512 canvas and the logo came out
  // tiny — 92.7% background, a pinhead bear. Size it from CSS instead.
  const svg = fs.readFileSync('assets/bear.svg', 'utf8')
    .replace(/<svg\b([^>]*)>/, (_m, attrs) =>
      `<svg${attrs.replace(/\s(?:width|height)="[^"]*"/g, '')}>`);
  const html = `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;width:${SIZE}px;height:${SIZE}px;background:${BG};overflow:hidden}
    body{display:flex;align-items:center;justify-content:center}
    svg{display:block;width:${BEAR}px;height:${BEAR}px}
  </style>${svg}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-logo-'));
  const page = path.join(dir, 'logo.html');
  fs.writeFileSync(page, html);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const r = spawnSync('chromium-browser', [
    '--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--force-device-scale-factor=1', `--window-size=${SIZE},${SIZE}`,
    `--screenshot=${path.resolve(OUT)}`, 'file://' + page,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  fs.rmSync(dir, { recursive: true, force: true });
  if (r.status !== 0 || !fs.existsSync(OUT)) {
    throw new Error('chromium screenshot failed: ' + String(r.stderr || '').split('\n').slice(-4).join(' | '));
  }
  return 'chromium';
}

let how;
if (has('chromium-browser')) how = viaChromium();
else how = await viaSharp();

const buf = fs.readFileSync(OUT);
const w = buf.readUInt32BE(16);
const h = buf.readUInt32BE(20);
if (buf.subarray(1, 4).toString('latin1') !== 'PNG' || w !== SIZE || h !== SIZE) {
  throw new Error(`[wc-logo] bad output: ${w}x${h} (want ${SIZE}x${SIZE})`);
}
console.log(`[wc-logo] ${OUT} ${w}x${h} via ${how}, ${buf.length} bytes`);
