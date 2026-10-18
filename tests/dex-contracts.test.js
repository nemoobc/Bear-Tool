// Bear Tool — tests/dex-contracts.test.js
// Dex v2 M2: the fresh engine's contracts. This file runs WITHOUT a chain: it
// compiles the real sources through the app's pinned solc 0.8.37 — the same
// compiler the browser loader pins — and asserts the ABI surface the Dex UI
// will call. Behaviour pins live on a real chain in
// tests/fork/dex-contracts.test.js; a regex over the source would prove
// nothing, so everything here goes through the compiler.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { DEX_SOLIDITY } = await import('../js/dex/contracts.js');
const { compileDex } = await import('./helpers/dex-compile.mjs');

const ARTIFACTS = compileDex(DEX_SOLIDITY);

function sigs(abi) {
  const expand = (t) => (t.type === 'tuple'
    ? `(${t.components.map(expand).join(',')})`
    : t.type);
  return abi.filter((x) => x.type === 'function')
    .map((x) => `${x.name}(${x.inputs.map(expand).join(',')})`)
    .sort();
}

test('the compiler produces three real artifacts — no source-text pin', () => {
  for (const [name, c] of Object.entries(ARTIFACTS)) {
    assert.ok(c.bytecode.length > 200, `${name} bytecode suspiciously small: ${c.bytecode.length}`);
    assert.ok(c.abi.length > 3, `${name} abi empty`);
  }
});

test('the factory exposes exactly the launch contract the wizard walks', () => {
  const s = sigs(ARTIFACTS.BearFactory.abi, "f");
  assert.ok(s.includes('launch((string,string,string,string,string,string,string),uint256,uint256,uint64,uint256,uint256,uint256)'), s.join(','));
  assert.ok(s.includes('pairOf(address)'), 'token → pair lookup');
  assert.ok(s.includes('tokenCount()') && s.includes('tokens(uint256)'), 'token list for the feed');
  assert.ok(s.includes('quote()'), 'the ONE quote is fixed');
});

test('BearToken covers the metadata + transfer surface, nothing owner-ish', () => {
  const s = sigs(ARTIFACTS.BearToken.abi, "f");
  for (const want of [
    'balanceOf(address)', 'transfer(address,uint256)', 'transferFrom(address,address,uint256)',
    'approve(address,uint256)', 'allowance(address,address)', 'totalSupply()',
    'name()', 'symbol()', 'decimals()', 'imageURI()', 'description()',
    'twitter()', 'telegram()', 'website()', 'setSocials((string,string,string))',
    'quoteToken()', 'factory()',
  ]) assert.ok(s.includes(want), `missing ${want}`);
  // Supply ships complete: no mint, no burn, no printing authority at all.
  assert.ok(!s.includes('mint(address,uint256)'), 'a BearToken must never mint');
  assert.ok(!s.includes('burn(uint256)'), 'a BearToken must never burn');
});

test('BearPair is the one machine: real-reserve AMM with LP locks and a fee carve', () => {
  const s = sigs(ARTIFACTS.BearPair.abi, "f");
  for (const want of [
    'reserves()', 'getAmountOut(bool,uint256)',
    'swapQuoteForToken(uint256,uint256,address)', 'swapTokenForQuote(uint256,uint256,address)',
    'addLiquidity(uint256,uint256,uint256)', 'removeLiquidity(uint256,uint256,uint256)',
    'lock(address,uint64)', 'locks(address)', 'lockOf(address)',
    'totalFeesCreator()', 'claimFees()',
    'creatorFeeBps()', 'creator()', 'lastK()',
    'balanceOf(address)', 'transfer(address,uint256)', 'transferFrom(address,address,uint256)',
    'approve(address,uint256)', 'totalSupply()',
  ]) assert.ok(s.includes(want), `missing ${want}`);
  // One quote per pool is structural, not a UI promise.
  assert.ok(s.includes('quote()') && s.includes('token()'), s.join(','));
});
