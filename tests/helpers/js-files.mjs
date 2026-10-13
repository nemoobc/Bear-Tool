// Bear Tool — tests/helpers/js-files.mjs
//
// Every gate that walks the source tree used to call readdirSync('js') and
// take the .js files OFF THE TOP LEVEL ONLY. That was correct while every
// module lived flat — and it stopped being correct the moment the Dex moved
// into js/dex/: the flat walk would simply never see js/dex/index.js again,
// so swap/send/deploy kept their full coverage and the Dex silently lost
// every one of those gates. Nothing failed; the checks just quietly stopped
// checking. (Same class of failure as the unused e2e suite and the Windows
// shell loop this project already produced twice.)
//
// So the walk is recursive and lives in ONE place. A gate that forgets to use
// it is the bug, not the tree.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path to js/ */
export const JS_ROOT = fileURLToPath(new URL('../../js', import.meta.url));

// js/vendor holds the vendored browser bundles (ethers, qrcode, walletconnect).
// They are third-party bytes: no i18n keys, no `$()` calls, no relay calls to
// audit, and walking them would triple the cost of every gate below.
const SKIP_DIRS = new Set(['vendor']);

/**
 * Every .js module under js/, recursively, sorted, as PATHS RELATIVE TO js/
 * (e.g. 'app.js', 'dex/index.js', 'dex/contract.js').
 *
 * @param {string} [root] override for tests that need it
 * @returns {string[]}
 */
export function jsModules(root = JS_ROOT) {
  const out = [];
  const walk = (dir, prefix) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      if (name.isDirectory()) {
        if (SKIP_DIRS.has(name.name)) continue;
        walk(join(dir, name.name), `${prefix}${name.name}/`);
      } else if (name.name.endsWith('.js')) {
        out.push(`${prefix}${name.name}`);
      }
    }
  };
  walk(root, '');
  return out.sort();
}

/**
 * The same walk, but as absolute paths — for callers that read the bytes.
 *
 * @param {string} [root]
 * @returns {string[]}
 */
export function jsModulePaths(root = JS_ROOT) {
  return jsModules(root).map((rel) => join(root, rel));
}

/**
 * Read every module's source, keyed by its relative path.
 *
 * @param {string} [root]
 * @returns {Record<string, string>}
 */
export function jsSources(root = JS_ROOT) {
  const out = {};
  for (const rel of jsModules(root)) out[rel] = readFileSync(join(root, rel), 'utf8');
  return out;
}
