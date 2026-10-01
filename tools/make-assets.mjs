// Rasterize assets/bear.svg into the Android icon + splash.
//
// CI-only: sharp ships no prebuilt for Termux (android-arm64v8), so this runs
// inside the APK workflow on ubuntu, right before @capacitor/assets generate.
// Output: resources/icon.png (1024) + resources/splash.png (2732), both on the
// brand dark #1a1a2e used by the launch config in capacitor.config.json.
import sharp from 'sharp';
import fs from 'node:fs';

const BG = { r: 26, g: 26, b: 46, alpha: 1 }; // #1a1a2e
fs.mkdirSync('resources', { recursive: true });

const bear = (px) => sharp('assets/bear.svg', { density: 600 })
  .resize(px, px, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toBuffer();

// Icon: bear keeps a margin inside the square so adaptive-icon masks never clip ears.
await sharp({ create: { width: 1024, height: 1024, channels: 4, background: BG } })
  .composite([{ input: await bear(860), gravity: 'centre' }])
  .png()
  .toFile('resources/icon.png');

// Splash: same mascot, smaller, centered on a full dark canvas.
await sharp({ create: { width: 2732, height: 2732, channels: 4, background: BG } })
  .composite([{ input: await bear(720), gravity: 'centre' }])
  .png()
  .toFile('resources/splash.png');

console.log('[assets] resources/icon.png + resources/splash.png OK');
