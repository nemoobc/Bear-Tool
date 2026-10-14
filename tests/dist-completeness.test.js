// Bear Tool — tests/dist-completeness.test.js
// dist/ IS the APK. Every folder index.html links to has to be in it.
//
// Found by opening the APK and reading its contents: js/dex/ was MISSING (so the
// whole Dex feature did not exist in the app) and css/ was missing too (so the
// app shipped unstyled). Neither ever failed a build. GitHub Pages looked
// perfect throughout, because Pages serves the source tree and never runs the
// build — so only one of the two shipped targets could have caught it, and the
// one nobody tested was the one shipping to phones.
//
// This gate checks the SHAPE of dist/, which is cheap and does not need a
// Gradle build. The APK workflow additionally asserts the APK's own contents, so
// a hole cannot open up between here and the packaged artifact.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const distDir = join(rootDir, 'dist');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

// The build is not part of `npm test` (it takes ~60s), so the gate asserts the
// rule and reads whatever dist/ currently holds. When dist/ is absent it skips
// loudly rather than passing silently — a gate that cannot check must say so.
const built = existsSync(distDir);

test('every local asset index.html links to must exist in dist/', (t) => {
  if (!built) {
    t.skip('dist/ not built — run `npm run build` to exercise this gate');
    return;
  }

  // href="css/…" and src="js/…" — plain paths, which is what the built bundle
  // resolves against.
  const refs = [...html.matchAll(/(?:href|src)="((?:css|js|assets)\/[^"]+)"/g)]
    .map((m) => m[1]);
  assert.ok(refs.length > 5, `index.html should reference several local assets, found ${refs.length}`);

  const missing = [];
  for (const rel of refs) {
    // Skip URLs Vite rewrites at build time (hashed /@fs /external).
    if (rel.startsWith('js/vendor/')) continue; // copied by publicDir, checked below
    if (!existsSync(`${distDir}/${rel}`)) missing.push(rel);
  }
  assert.deepEqual(missing, [], `these are linked from index.html but absent from dist/: ${missing.join(', ')}`);
});

test('a folder feature must never be dropped by the build again', (t) => {
  if (!built) {
    t.skip('dist/ not built — run `npm run build` to exercise this gate');
    return;
  }
  // The two that actually went missing, named so the failure is specific.
  for (const dir of ['js/dex', 'css']) {
    assert.ok(existsSync(`${distDir}/${dir}`), `dist/${dir} is missing — dist/ is the APK, and this folder did not reach it`);
  }

  // Read the Dex module list off disk rather than repeating it here. A
  // hardcoded list is a list that goes stale: bot.js, bot-engine.js,
  // bot-wallets.js and list.js were all added after this gate was written, and
  // a build that silently dropped the whole market maker would have passed it
  // every single run. The gate has to fail when a NEW module is missing, which
  // it cannot do if it does not know the new module exists.
  const sourceModules = readdirSync(join(rootDir, 'js/dex'))
    .filter((f) => f.endsWith('.js'))
    .sort();
  assert.ok(sourceModules.length >= 10,
    `js/dex should hold the whole launchpad; found only ${sourceModules.length}`);
  for (const f of sourceModules) {
    assert.ok(existsSync(`${distDir}/js/dex/${f}`),
      `dist/js/dex/${f} is missing — every module in js/dex must reach the APK`);
  }

  // The vendored library is the one thing that must load before any screen
  // works; it is copied by publicDir rather than by the js/ walk.
  for (const f of ['ethers.umd.min.js', 'qrcode.min.js']) {
    assert.ok(existsSync(`${distDir}/js/vendor/${f}`), `dist/js/vendor/${f} is missing`);
  }
});

test('the built Dex carries the feature, not just the folder', (t) => {
  if (!built) {
    t.skip('dist/ not built — run `npm run build` to exercise this gate');
    return;
  }
  const index = readFileSync(`${distDir}/js/dex/index.js`, 'utf8');
  const tokens = readFileSync(`${distDir}/js/dex/tokens.js`, 'utf8');
  const css = readFileSync(`${distDir}/css/dex.css`, 'utf8');

  // A stale dist/ is worse than none: the folder present but the old code inside
  // is exactly the failure that shipped. So assert the CURRENT behaviour.
  assert.match(index, /DEX_ROUTES/, 'the built view must be the two-route launchpad');
  assert.match(tokens, /dex-card/, 'the built feed must be the card grid');
  assert.match(tokens, /paintProgress/, 'the built feed must paint curve bars');
  assert.ok(css.includes('.dex-card-curve'), 'the built CSS must style the curve bar');
  assert.ok(css.includes('.dex-pct'), 'the built CSS must style the percentage row');
});

test('the copy step is recursive, by construction', () => {
  // The bug was a loop that copied only top-level `*.js`, so any DIRECTORY under
  // js/ was silently skipped. Assert the shape of the fix instead of the result,
  // so a future refactor cannot quietly go back to listing files.
  const cfg = readFileSync(new URL('../vite.config.js', import.meta.url), 'utf8');
  const fn = cfg.slice(cfg.indexOf('const copyLegacyStatic'));
  assert.match(fn, /for \(const entry of readdirSync\('js'\)\)/,
    'the build must walk every entry under js/, not filter for .js files');
  assert.ok(!/\}\s*endsWith\('\.js'\)\s*\)/.test(fn),
    "the 'only top-level .js files' filter must not come back — it dropped every folder feature");
  for (const dir of ['assets', 'css', 'js']) {
    assert.ok(fn.includes(`cpSync('${dir}'`), `the build must copy ${dir}/ into dist/`);
  }
});
