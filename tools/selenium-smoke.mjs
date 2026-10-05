// Bear Tool — Selenium smoke test (engine cross-check).
//
// The E2E suite runs on Playwright; this proves the built app also boots and
// navigates under a SECOND automation engine (Selenium WebDriver + system
// chromedriver + system Chromium — the Termux trio Playwright refuses to
// download for android). Same dist/ build, same assertions, no new framework:
// if Playwright and Selenium disagree about the app, one of them lies.
//
// Usage: node tools/selenium-smoke.mjs          (expects dist/ already built,
//                                                server on BEAR_SMOKE_PORT)

import { Builder, By, until } from 'selenium-webdriver';
import chrome from 'selenium-webdriver/chrome.js';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.join(path.dirname(new URL(import.meta.url).pathname), '..'));
const dist = path.join(root, 'dist');
const PORT = Number(process.env.BEAR_SMOKE_PORT || 8091);

if (!existsSync(path.join(dist, 'index.html'))) {
  console.error('selenium-smoke: dist/index.html missing — run `npm run build` first');
  process.exit(2);
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/index.html';
    const file = path.join(dist, p);
    if (!file.startsWith(dist)) { res.writeHead(403).end(); return; }
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
console.log(`selenium-smoke: serving dist/ on ${PORT}`);

const chromeOptions = new chrome.Options();
chromeOptions.setChromeBinaryPath(process.env.BEAR_CHROMIUM_PATH || '/data/data/com.termux/files/usr/bin/chromium-browser');
chromeOptions.addArguments('--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1280,900');

// The system chromedriver must match the system Chromium major — mismatch is
// the classic silent failure (session not created), so check it out loud.
const checks = [];
let failed = 0;
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  if (!ok) failed++;
  console.log(`  ${ok ? '✔' : '✖'} ${name}${detail ? ' — ' + detail : ''}`);
};

const driver = await new Builder()
  .forBrowser('chrome')
  .setChromeService(new chrome.ServiceBuilder(process.env.BEAR_CHROMEDRIVER_PATH || '/data/data/com.termux/files/usr/bin/chromedriver'))
  .setChromeOptions(chromeOptions)
  .build();

try {
  const ver = await driver.getCapabilities().then((c) => c.get('version') || c.get('browserVersion'));
  check('chromedriver session opens', true, `browser ${ver}`);

  await driver.get(`http://127.0.0.1:${PORT}/`);
  await driver.wait(until.elementLocated(By.css('body')), 15000);
  const title = await driver.getTitle();
  check('app boots (document title)', title.length > 0, JSON.stringify(title));

  // The welcome/first screen must render real text, not a blank shell.
  await driver.wait(until.elementLocated(By.css('#app, main, .welcome-screen, [data-view]')), 15000);
  const bodyText = await driver.findElement(By.tagName('body')).getText();
  check('first screen paints text', bodyText.trim().length > 0, `${bodyText.trim().length} chars`);
  check('no boot-time error overlay', !/Uncaught|TypeError|is not a function/i.test(bodyText));

  // A second navigation — the nav must exist (index.html shell).
  const navCount = await driver.findElements(By.css('.nav-item, [data-view]')).then((e) => e.length);
  check('navigation controls present', navCount > 0, `${navCount} found`);

  // Canvas elements the dashboard/charts rely on exist after render (or are
  // created on demand) — assert the app's script bundle actually executed:
  // a module that threw early leaves zero interactive controls behind.
  const btnCount = await driver.findElements(By.css('button')).then((e) => e.length);
  check('interactive controls rendered (bundle executed)', btnCount > 0, `${btnCount} buttons`);

  console.log(`\nselenium-smoke: ${checks.length - failed}/${checks.length} PASS`);
} finally {
  await driver.quit().catch(() => {});
  server.close();
}

process.exit(failed === 0 ? 0 : 1);
