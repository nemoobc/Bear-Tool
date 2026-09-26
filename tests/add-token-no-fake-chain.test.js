// Add Custom Token had a Chain ID input, and it was a lie.
//
// detect() reads through get('provider') — the CURRENT network — so typing a
// different chain re-ran the same probe against the same node. The save then
// stored parseInt(chainEl.value) next to a name and decimals read from a
// different network. Nothing on screen said so: you could add "DAI on Polygon"
// and get Polygon's chainId attached to a symbol read from Ethereum.
//
// The network is a fact about where the metadata came from, not a setting the
// user gets to assert. It is now shown, never typed, and re-probed if the network
// changes while the modal is open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');

test('there is no Chain ID input to type a wrong number into', () => {
  assert.ok(!/id="customTokenChain"/.test(app), 'the Chain ID input must be gone');
  assert.ok(!/parseInt\(chainEl\.value\)/.test(app),
    'nothing may read a chain id out of the DOM - that is how a wrong one got stored');
  assert.ok(!/chainEl\b/.test(app), 'no dangling reference to the removed element');
});

test('the network is shown, read-only, as the source of the metadata', () => {
  assert.match(app, /id="tdNetwork"/, 'the active network must be stated on screen');
  assert.match(app, /Network: ' \+ activeNetName\(\)/,
    'and it must name the network it will actually read');
  // "chain" here is a chainId, taken from the network record - not typed.
  assert.match(app, /getNetworkById\(get\('networkId'\)\)\?\.chainId/);
});

test('the saved chainId is the one the token was read on', () => {
  assert.match(app, /const chainId = activeChainId\(\)/,
    'save must derive the chain from the active network, never from a field');
  assert.match(app, /tokens\.push\(\{[^}]*chainId/,
    'and it must actually be written onto the token');
});

test('switching networks re-probes an open dialog', () => {
  // Otherwise a token probed on the old chain stays marked valid on the new one.
  assert.match(app, /on\('networkId',[\s\S]{0,90}detect\(\)/,
    'a network change must re-run detection while the dialog is open');
});

test('detection still reads name, symbol and decimals from the contract', () => {
  for (const fn of ['c.symbol()', 'c.name()', 'c.decimals()']) {
    assert.ok(app.includes(fn), `${fn} must still be read`);
  }
  assert.match(app, /Detected on chain|Read from /,
    'the note must say which network answered');
});
