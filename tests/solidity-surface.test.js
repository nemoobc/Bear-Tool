// Bear Tool — solidity-surface.test.js
//
// The ERC-721 rescue bug was a Solidity bug, and the suite was green while
// it shipped: the helper called
//   abi.encodeWithSignature("transferFrom", address(this), SAFE, ids[i])
// and abi.encodeWithSignature hashes the string EXACTLY as given — it does
// not append the argument types — so the selector was 0x0c41b033, which no
// ERC-721 implements. Every NFT sweep reverted.
//
// No test compiled the sources, so nothing noticed. This gate compiles
// every Solidity source the app ships and checks the two things that make
// a call land on the wrong function:
//
//   1. an inner call must use a CANONICAL selector (the app's whitelist:
//      transfer / transferFrom / balanceOf / approve / allowance /
//      totalSupply) — a typo or a hand-typed hash cannot slip through;
//   2. a manual ABI fragment (the encode-only fragments the app uses for a
//      pasted contract) must hash to the SAME selector as the compiled
//      contract it talks to.
//
// It also refuses a bare encodeWithSignature: the call that started all of
// this. Comments are stripped first — prose is not code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const solc = require('solc');
const { ethers } = require('ethers');

const REL = ['js/eip7702-tools.js', 'js/contracts.js', 'js/dex/contracts.js'];
const read = (rel) => fs.readFileSync(new URL('../' + rel, import.meta.url), 'utf8');

// The selectors an inner call may use. Each is the canonical hash of the
// function it names — the whitelist IS the check.
const CANONICAL = new Map([
  ['0xa9059cbb', 'transfer(address,uint256)'],
  ['0x23b872dd', 'transferFrom(address,address,uint256)'],
  ['0x70a08231', 'balanceOf(address)'],
  ['0x095ea7b3', 'approve(address,uint256)'],
  ['0xdd62ed3e', 'allowance(address,address)'],
  ['0x18160ddd', 'totalSupply()'],
]);
for (const [sel, sig] of CANONICAL) {
  assert.equal(ethers.id(sig).slice(0, 10), sel, `whitelist entry ${sig} is not ${sel}`);
}

function stripSolidityComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

// Every Solidity template literal in a file, with its name.
function sourcesIn(rel) {
  const src = read(rel);
  return [...src.matchAll(/(?:const|let|var)\s+([A-Z_0-9]+)\s*=\s*`([\s\S]*?)`;/g)]
    .filter((m) => /pragma solidity/.test(m[2]))
    .map((m) => ({ rel, name: m[1], code: stripSolidityComments(m[2]) }));
}

function compile(code, label) {
  const input = {
    language: 'Solidity',
    sources: { [`${label}.sol`]: { content: code } },
    settings: { outputSelection: { '*': { '*': ['abi'] } } },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errs = (out.errors || []).filter((e) => e.severity === 'error');
  if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join('\n'));
  return Object.values(out.contracts[Object.keys(out.contracts)[0]])[0].abi;
}

const ALL = REL.flatMap(sourcesIn);
assert.ok(ALL.length >= 6, `expected the app's Solidity sources to be found, got ${ALL.length}`);

test('every Solidity source the app ships compiles', () => {
  for (const s of ALL) {
    let abi = null;
    try { abi = compile(s.code, s.name.toLowerCase()); }
    catch (e) { assert.fail(`${s.rel}:${s.name} does not compile — ${e.message.slice(0, 300)}`); }
    assert.ok(Array.isArray(abi) && abi.length, `${s.rel}:${s.name} compiled to an empty ABI`);
  }
});

test('an inner call only ever uses a canonical selector', () => {
  for (const s of ALL) {
    for (const m of s.code.matchAll(/encodeWithSelector\(\s*(0x[0-9a-fA-F]{8})/g)) {
      const sel = m[1].toLowerCase();
      assert.ok(CANONICAL.has(sel),
        `${s.rel}:${s.name} calls the unknown selector ${sel} — the app's inner calls must be canonical (${[...CANONICAL.values()].join(', ')})`);
    }
  }
});

test('no source calls a function by a bare name', () => {
  // abi.encodeWithSignature("transferFrom", ...) hashes the bare word. The
  // full signature ("transferFrom(address,address,uint256)") is the only
  // form that can be right — and even then the selector form is clearer.
  for (const s of ALL) {
    for (const m of s.code.matchAll(/encodeWithSignature\(\s*["']([^"']+)["']/g)) {
      assert.ok(m[1].includes('('),
        `${s.rel}:${s.name} calls ${m[1]} without argument types — the selector would be the hash of the bare name`);
    }
  }
});

test('the manual ABI fragments hash to the compiled contract selectors', () => {
  // The fragments the app uses for a pasted contract (no solc round-trip)
  // must address the SAME functions the compiled contract exposes.
  const tools = read('js/eip7702-tools.js');
  const rescueAbi = compile(
    sourcesIn('js/eip7702-tools.js').find((s) => s.name === 'RESCUE_SOURCE').code,
    'rescue',
  );
  const compiled = new Map(rescueAbi
    .filter((f) => f.type === 'function')
    .map((f) => [f.name + '(' + f.inputs.map((i) => i.type).join(',') + ')', f]));

  for (const blockName of ['RESCUE_MANUAL_ABI', 'RESCUE_PROBE_ABI']) {
    const m = tools.match(new RegExp(`const ${blockName} = \\[([\\s\\S]*?)\\];`));
    assert.ok(m, `${blockName} must exist in js/eip7702-tools.js`);
    const frags = [...m[1].matchAll(/'function\s+([A-Za-z0-9_]+)\(([^)]*)\)/g)];
    assert.ok(frags.length, `${blockName} must list functions`);
    for (const f of frags) {
      const types = f[2].split(',').map((x) => x.trim().split(/\s+/)[0]).filter(Boolean).join(',');
      const sig = `${f[1]}(${types})`;
      assert.ok(compiled.has(sig),
        `${blockName} lists ${sig}, but the compiled rescue helper does not expose it`);
    }
  }
});
