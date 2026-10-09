// tests/anti-relay.test.js — the public-relay grave stays closed.
//
// The 2026-10-09 round PROVED every public CORS relay dead (10/10: 401 / 429 /
// 500 / 503 / timeout) and deleted the proxy architecture that depended on
// them (js/dapp-proxy.js + public/bear-sw.js, gone for good). This gate makes
// sure none of it creeps back: a new "clever workaround" pointing at a public
// relay, the deleted modules themselves, or a service worker that could
// silently start rewriting responses again. See lessons.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Domain/name fragments of relays that were measured dead 2026-10-09, plus
// our own deleted pieces. None may appear in shipped js/.
const BANNED = [
  'allorigins',     // 520 / timeout
  'corsproxy.io',   // 401, key-gated
  'codetabs',       // timeout
  'cors.lol',       // 429
  'whateverorigin', // 500
  'urlreq',         // 503
  'corsfix',        // 400
  'cors.eu.org',    // 429
  'isomorphic-git', // 403
  'bear-relay',     // old dev relay
  'dapp-proxy',     // deleted module
  'bear-sw',        // deleted service worker
];

function listJs(dir) {
  return readdirSync(dir).filter((n) => n.endsWith('.js')).map((n) => join(dir, n));
}

test('no dead public relay or deleted proxy piece appears in js/', () => {
  const files = listJs(join(root, 'js'));
  assert.ok(files.length > 10, 'js/ module tree looks empty — gate would be vacuous');
  const hits = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const bad of BANNED) {
      if (src.toLowerCase().includes(bad.toLowerCase())) {
        hits.push(f.replace(root + '/', '') + ' → "' + bad + '"');
      }
    }
  }
  assert.deepEqual(hits, [], 'banned relay/proxy references found:\n' + hits.join('\n'));
});

test('the deleted proxy modules stay deleted', () => {
  assert.equal(existsSync(join(root, 'js', 'dapp-proxy.js')), false, 'js/dapp-proxy.js is back from the dead');
  assert.equal(existsSync(join(root, 'public', 'bear-sw.js')), false, 'public/bear-sw.js is back from the dead');
});

test('no service worker registration in shipped js/ (a SW could rewrite responses silently)', () => {
  const files = readdirSync(join(root, 'js')).filter((n) => n.endsWith('.js'));
  const regs = files
    .filter((n) => readFileSync(join(root, 'js', n), 'utf8').includes('serviceWorker'))
    .map((n) => 'js/' + n);
  assert.deepEqual(regs, [], 'serviceWorker reference(s) found: ' + regs.join(', '));
});
