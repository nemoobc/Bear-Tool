// Bear Tool — network-logo.test.js
//
// 2026-10-18 user report: "list network ga ada logo … aku mau logonya otomatis
// ada". The marks keyed on the lowercase NAME only; renamed chains fell to a
// blank satellite, and user-added chains got nothing branded at all. The new
// contract, pinned at behavior level:
//   1. chainId → brand table (the id never lies; names drift),
//   2. legacy name keywords for bare-name callers,
//   3. MONOGRAM roundel for unknown chains — hue hashed from the chain id,
//      letter from the name, green T ring on testnets — a logo appears
//      automatically for every network, and never an emoji.
// Also pinned here: every surface that asked for a logo paints the SAME
// renderer (single definition, e2e-probe owns that source pin).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const logo = await import('../js/token-logo.js');
const getNetworkLogo = logo.getNetworkLogo;

const EMOJI = /\p{Extended_Pictographic}/u;

test('mainnet rings: chain id pins the brand diamond, circle, hexagon', () => {
  assert.match(getNetworkLogo({ name: 'Ethereum', chainId: 1, type: 'mainnet' }), /#627EEA/);
  assert.match(getNetworkLogo({ name: 'BNB Smart Chain', chainId: 56, type: 'mainnet' }), /#F0B90B/);
  assert.match(getNetworkLogo({ name: 'Polygon', chainId: 137, type: 'mainnet' }), /#8247E5/);
  assert.match(getNetworkLogo({ name: 'OP Mainnet', chainId: 10, type: 'mainnet' }), /#FF0420/);
  assert.match(getNetworkLogo({ name: 'Base', chainId: 8453, type: 'mainnet' }), /#0052FF/);
  assert.match(getNetworkLogo({ name: 'Gnosis', chainId: 100, type: 'mainnet' }), /Gnosis/);
  assert.match(getNetworkLogo({ name: 'Celo', chainId: 42220, type: 'mainnet' }), /#FCFF04/);
  assert.match(getNetworkLogo({ name: 'Sonic', chainId: 146, type: 'mainnet' }), /Sonic/);
});

test('sepolia family: diamond with the testnet T ring, driven by type', () => {
  const svg = getNetworkLogo({ name: 'Sepolia', chainId: 11155111, type: 'testnet' });
  assert.match(svg, /#627EEA/, 'same diamond as Ethereum — it IS Ethereum, testnet');
  assert.match(svg, />T</, 'the T ring marks it a testnet');
  const t2 = getNetworkLogo({ name: 'Base Sepolia', chainId: 84532, type: 'testnet' });
  assert.match(t2, /#0052FF/);
  assert.match(t2, />T</);
});

test('unknown chain → determinstic monogram, letter + hue from its chain id', () => {
  const a = getNetworkLogo({ name: 'ZetaFox', chainId: 97799, type: 'mainnet' });
  const b = getNetworkLogo({ name: 'ZetaFox', chainId: 97799, type: 'mainnet' });
  assert.equal(a, b, 'same chain → same mark, every render');
  assert.match(a, /hsl\(/, 'hashed hue, not a fixed satellite fill');
  assert.match(a, />Z</, 'initial letter of the chain name');
  assert.doesNotMatch(a, />T</, 'no testnet ring on a mainnet');
  const t = getNetworkLogo({ name: 'ZetaFox Testnet', chainId: 97799, type: 'testnet' });
  assert.match(t, />T</, 'the type drives the ring on customs too');
  const fallback = getNetworkLogo({ name: '', chainId: null, type: '' });
  assert.match(fallback, /role="img"/, 'never crashes on a shapeless net; still branded');
});

test('bare-name legacy callers keep their exact marks', () => {
  assert.match(getNetworkLogo('ethereum', 18), /#627EEA/);
  assert.match(getNetworkLogo('sepolia', 18), /#627EEA/);
  assert.match(getNetworkLogo('arbitrum sepolia', 18), /#28A0F0/);
  assert.match(getNetworkLogo('avalanche', 18), /AVAX/);
  // A name-only RENAME still lands on the automatic monogram, not blank.
  assert.match(getNetworkLogo('Righam Magnificent Chain', 18), /hsl\(/);
});

test('emoji law: zero pictographic characters in any mark', () => {
  const shapes = [
    { name: 'Ethereum', chainId: 1, type: 'mainnet' },
    { name: 'Sepolia', chainId: 11155111, type: 'testnet' },
    { name: 'Manggo Test Chain', chainId: 880011, type: 'testnet' },
    { name: 'ZetaFox', chainId: 97799, type: 'mainnet' },
    { name: '', chainId: undefined, type: '' },
  ];
  for (const s of shapes) {
    assert.equal(EMOJI.test(getNetworkLogo(s, 32)), false, `mark for "${s.name}" must be pure SVG`);
  }
});

test('a logo must not smuggle a hostile name into an attribute', () => {
  const evil = getNetworkLogo({ name: 'Evil" onerror="alert(1)', chainId: 7, type: 'mainnet' }, 20);
  // The word "onerror" may appear as TEXT inside aria-label; what must never
  // happen is an UNESCAPED quote — that is the one glyph that can break out of
  // the attribute and become markup.
  assert.match(evil, /&quot;/, 'quotes in the name stay entity-encoded');
  assert.doesNotMatch(evil, /Evil"/, 'no raw double-quote breaks out of the attribute');
});
