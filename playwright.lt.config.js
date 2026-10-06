// Bear Tool — Playwright config for the LambdaTest (TestMu) cloud grid.
// Browser runs in the cloud; the app under test stays on localhost:BEAR_PORT,
// reachable through the LT tunnel (~/bin/LT -n bear-e2e). Credentials come
// ONLY from the environment — never from this file.
import { defineConfig } from '@playwright/test';

const user = process.env.LT_USERNAME;
const accessKey = process.env.LT_ACCESS_KEY;
if (!user || !accessKey) {
  throw new Error('LT_USERNAME / LT_ACCESS_KEY belum di-set di environment');
}

const capabilities = {
  browserName: 'Chrome',
  browserVersion: 'latest',
  'LT:Options': {
    platform: 'Windows 11',
    build: process.env.LT_BUILD || 'Bear Tool e2e',
    name: 'playwright-suite',
    user,
    accessKey,
    network: true,
    console: true,
    video: false,
    // Route the cloud browser's localhost traffic through THIS tunnel.
    tunnel: true,
    tunnelName: process.env.LT_TUNNEL_NAME || 'bear-e2e',
    w3c: true,
  },
};

const wsEndpoint =
  `wss://cdp.lambdatest.com/playwright?capabilities=${encodeURIComponent(JSON.stringify(capabilities))}`;

const libDirs = [
  process.env.BEAR_BROWSER_LIBS,
  '/tmp/opencode/browser-libs/extracted/usr/lib/x86_64-linux-gnu',
].filter(Boolean);
if (libDirs.length) {
  process.env.LD_LIBRARY_PATH = [...libDirs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
}

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.BEAR_BASE_URL || 'http://localhost:8081',
    connectOptions: { wsEndpoint },
    ...(process.env.BEAR_STORAGE_STATE ? { storageState: process.env.BEAR_STORAGE_STATE } : {}),
    viewport: { width: 1280, height: 800 },
  },
});
