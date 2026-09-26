// Lock connect-src, because widening it is silent.
//
// The app is a self-custody wallet that documents custom RPC support, and a
// node on loopback is a normal thing to point it at. Its own CSP used to make
// that impossible: `connect-src 'self' https: wss:` blocked http://localhost:*,
// so a custom RPC to a local node failed with "Failed to fetch" while curl from
// the same machine worked fine — which reads as a wallet bug and is not one.
// frame-src already allowed loopback for the same reason.
//
// What must stay true: loopback over http, and nothing else over http. A blanket
// `http:` would let a page exfiltrate to any cleartext host, which is the one
// thing connect-src is mostly there to prevent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const csp = html.match(/connect-src ([^;"]+)/)?.[1] ?? '';

test('connect-src exists', () => {
  assert.ok(csp, 'no connect-src directive found in index.html');
});

test('a local node is reachable — http on loopback only', () => {
  assert.match(csp, /http:\/\/localhost:\*/, 'localhost over http must be allowed, or a custom RPC to a local node cannot work');
  assert.match(csp, /http:\/\/127\.0\.0\.1:\*/, '127.0.0.1 over http must be allowed too — it is the same machine by another name');
});

test('no blanket http: — cleartext to any host stays blocked', () => {
  // A scheme-source is "http:" as a bare word. "http://localhost:*" contains the
  // substring "http:" but is a host-source, so match the bare form only.
  const bare = csp.split(/\s+/).filter((t) => t === 'http:' || t === 'http');
  assert.deepEqual(bare, [], `connect-src must not allow cleartext to arbitrary hosts: ${JSON.stringify(bare)}`);
});

test('no wildcard host in connect-src', () => {
  const wildcards = csp.split(/\s+/).filter((t) => t === '*' || t === 'http:*' || t === 'https:*');
  assert.deepEqual(wildcards, [], `connect-src must not allow a wildcard host: ${JSON.stringify(wildcards)}`);
});

test('remote endpoints still require https', () => {
  // Every non-loopback source must be a secure scheme. If someone adds a bare
  // "http:" to make a test pass, this is the assertion that says no.
  const sources = csp.split(/\s+/).filter(Boolean);
  for (const s of sources) {
    if (s === "'self'" || s === 'wss:') continue;
    if (s.startsWith('http://localhost:') || s.startsWith('http://127.0.0.1:')) continue;
    assert.ok(s === 'https:' || s.startsWith('https://'),
      `non-loopback source ${s} is not https — a remote RPC over http can be rewritten in flight`);
  }
});

test('ws: is not allowed alongside wss:', () => {
  assert.ok(!csp.split(/\s+/).includes('ws:'),
    'cleartext websockets would undo the point of wss:');
});
