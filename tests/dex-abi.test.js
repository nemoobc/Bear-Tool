// Bear Tool — tests/dex-abi.test.js
// M2/M3 pin: the UI ships its own abi.js (trimmed fragments) — this file
// proves that trim is information-preserving against the compiler itself.
// If DEX_SOLIDITY changes shape and aba.js is not regenerated, the selector
// and signature sets stop matching and the suite fails here, before any
// wallet can encode against a drifted ABI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';

const { DEX_SOLIDITY } = await import('../js/dex/contracts.js');
const { BEAR_TOKEN_ABI, BEAR_PAIR_ABI } = await import('../js/dex/abi.js');

// offline compiler path (solc 0.8.37 pin — the browser loader's pin)
const require = (await import('node:module')).createRequire(import.meta.url);
const { compileDex } = await import('./helpers/dex-compile.mjs');

const art = compileDex(DEX_SOLIDITY);

// Canonical spellings of the codegen ABI re-shaped exactly like the shipped
// trimmer does ({type,name,stateMutability,inputs,outputs}, components kept
// flattened). If the shipped file and this fan-out stop matching, the UI's
// ABI has drifted and no wallet should ever encode against it.
function canonSetT(abi) {
  const tt = (c) => c.map((x) => x.components?.length ? { name: x.name, type: x.type, components: tt(x.components) } : { name: x.name, type: x.type });
  return new Set(abi.map((e) => {
    const o = { type: e.type, name: e.name };
    if (e.stateMutability) o.stateMutability = e.stateMutability;
    if (e.inputs?.length) o.inputs = tt(e.inputs);
    if (e.outputs?.length) o.outputs = tt(e.outputs);
    return JSON.stringify(o);
  }).sort());
}

const canonSet = (abi) => new Set(abi.map((e) => JSON.stringify(e)).sort());

test('shipped BEAR_TOKEN_ABI is the compiled codegen, field for field', () => {
  const shipped = canonSet(BEAR_TOKEN_ABI);
  const codegen = canonSetT(art.BearToken.abi);
  assert.equal(shipped.size, 24, 'token fragment count (M2 surface pin)');
  assert.deepEqual([...shipped].sort(), [...codegen].sort());
});

test('shipped BEAR_PAIR_ABI is the compiled codegen, field for field', () => {
  const shipped = canonSet(BEAR_PAIR_ABI);
  const codegen = canonSetT(art.BearPair.abi);
  assert.equal(shipped.size, 36, 'pair fragment count (M2 surface pin)');
  assert.deepEqual([...shipped].sort(), [...codegen].sort());
});

test('the trade selectors the sheet encodes are the contract ones', () => {
  const p = new ethers.Interface(BEAR_PAIR_ABI);
  assert.equal(p.getFunction('swapQuoteForToken').selector, '0x39e95543');
  assert.equal(p.getFunction('swapTokenForQuote').selector, '0x35767f0e');
  assert.equal(p.getFunction('getAmountOut').selector, '0x8290d9b8');
});
