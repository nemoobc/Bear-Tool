// ensurePlugin must never hand the raw Capacitor plugin proxy to an
// await/then boundary. Capacitor v8's proxy answers GET 'then' with a native
// method wrapper whose invocation fires an internal native call that rejects
// as its OWN promise — it never calls the resolve/reject it was handed — so
// `await proxy` hangs forever and leaks one "BearDappBrowser.then() is not
// implemented" unhandled rejection per adoption site.
//
// Proven on a real Android runtime: emulator CI run 38012047691 (2026-10-10)
// captured TWO boot-time unhandled rejections (diag ping + rpc init), the
// [dApp diag] line never printed (its await was frozen), the rpcRequest
// listener never attached, and openNativeDapp() never reached p.open() — the
// blank "not implemented" bug reported from the field. The fix is a wrapper
// proxy whose 'then' reads undefined (not thenable → not adopted) plus a
// single-flight registration (the old code raced two concurrent
// ensurePlugin() calls into "Cannot register plugins twice").
//
// No emulator needed to keep this broken again: assert the shapes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, '..', 'js', 'native-dapp.js'), 'utf8');
// Comments quote the forbidden shapes; the detector judges code only.
const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

test("the plugin proxy hides 'then' — awaiting it must resolve, not freeze", () => {
  assert.match(code, /k === 'then' \? undefined : Reflect\.get\(t, k\)/,
    "GET 'then' wajib undefined: proxy thenable = await membeku selamanya + unhandled rejection per adoption (run 38012047691)");
  assert.match(code, /new Proxy\(raw/,
    'registerPlugin() tidak boleh dipakai telanjang — wajib lewat wrapper');
});

test('registration is single-flight — two concurrent ensurePlugin() calls must not double-register', () => {
  assert.match(code, /if \(!pluginPromise\)/,
    'import+register wajib di-guard satu promise: lomba dua pemanggil boot-time menghasilkan "Cannot register plugins twice" (run 38012047691)');
  assert.match(code, /return pluginPromise;/,
    'async return pluginPromise = promise asli, bukan objek proxy — aman dari adopsi thenable');
});

test('no path returns the bare proxy from an async boundary', () => {
  // The old bug, verbatim shape: registerPlugin result flowing straight out.
  assert.doesNotMatch(code, /plugin = core\.registerPlugin\('BearDappBrowser'\);\s*\n\s*return plugin;/,
    'return plugin telanjang setelah registerPlugin = bug hang 2026-10-10 hidup lagi');
});
