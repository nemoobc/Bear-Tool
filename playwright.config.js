// Bear Tool — Playwright E2E config.
// Browser E2E suite lives in tests/e2e/*.spec.js.
// Run: npm run test:e2e  (or: npx playwright test)
import { defineConfig } from '@playwright/test';

// The CI/container may run Chromium with shared libs extracted to a local
// folder (no system package install). If BEAR_BROWSER_LIBS is set (or the
// known extraction dir exists), expose it to the browser child process.
const libDirs = [
  process.env.BEAR_BROWSER_LIBS,
  '/tmp/opencode/browser-libs/extracted/usr/lib/x86_64-linux-gnu',
].filter(Boolean);
if (libDirs.length) {
  process.env.LD_LIBRARY_PATH = [...libDirs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
}

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.BEAR_BASE_URL || 'http://localhost:8080',
    // Seeded by tools/e2e.mjs when a local chain is available, so the app boots
    // pointed at a funded fork instead of real mainnet. Without it every spec that
    // needs a balance times out at the 45s mark, and that failure is
    // indistinguishable from a regression — the untouched HEAD produced MORE of
    // them than the patched tree did.
    ...(process.env.BEAR_STORAGE_STATE ? { storageState: process.env.BEAR_STORAGE_STATE } : {}),
    viewport: { width: 1280, height: 800 },
    launchOptions: {
      args: [
        '--no-sandbox',
        // soljson wasm (~9 MB) compiles synchronously on the main thread —
        // Chrome blocks sync compile >8 MB without this (deploy hangs).
        '--enable-features=WebAssemblyUnlimitedSyncCompilation',
      ],
    },
    trace: 'retain-on-failure',
  },
});