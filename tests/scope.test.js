// Bear Tool — scope.test.js
// Regression guard for a class of bug that shipped: an identifier declared
// with const/let inside a nested BLOCK and then USED at the top level of the
// same function. That is a ReferenceError at runtime — invisible to
// `node --check` and to every "does this element exist" test.
//
// Real case: js/eip7702-tools.js declared `const sponsorSigner` inside the
// `else` branch of the reuse/deploy check, then passed it to
// delegateAndExecute OUTSIDE that branch. Every Rescue and Claim run threw
// "sponsorSigner is not defined" — the whole Tools screen errored.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve(new URL('../js/', import.meta.url).pathname);
const GLOBALS = new Set([
  'console','Math','JSON','Object','Array','String','Number','Boolean','Date','Promise','Set','Map',
  'BigInt','Error','TypeError','RangeError','parseInt','parseFloat','isNaN','isFinite','setTimeout',
  'setInterval','clearInterval','clearTimeout','clearImmediate','queueMicrotask','fetch','alert',
  'btoa','atob','encodeURIComponent','decodeURIComponent','structuredClone','Uint8Array','Int8Array',
  'Uint8ClampedArray','TextEncoder','TextDecoder','URL','URLSearchParams','requestAnimationFrame',
  'cancelAnimationFrame','Intl','RegExp','Symbol','WeakMap','WeakSet','Proxy','Reflect','navigator',
  'window','document','localStorage','location','history','crypto','ethers','globalThis','undefined',
  'NaN','Infinity','formatter','opts'
]);

// Strip comments and string/template literals so they can't look like code.
// Templates nest (`${words.map((w) => `<b>${w}</b>`)}`), so this is a tiny
// recursive reader instead of a single-mode scanner — getting this wrong
// produced false positives from HTML that lives inside template literals.
function stripNoise(src) {
  let out = '';
  let i = 0;

  function readCode(stopAtBraceClose) {
    let depth = 0;
    while (i < src.length) {
      const c = src[i], n = src[i + 1];
      if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
      if (c === '/' && n === '*') {
        i += 2;
        while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
        i += 2; continue;
      }
      if (c === "'" || c === '"') {
        const q = c; out += q; i++;
        while (i < src.length) {
          if (src[i] === '\\') { i += 2; continue; }
          if (src[i] === q) { i++; break; }
          i++;
        }
        out += q; continue;
      }
      if (c === '`') { i++; readTemplate(); out += ' '; continue; }
      if (c === '{') { depth++; out += c; i++; continue; }
      if (c === '}') {
        if (stopAtBraceClose && depth === 0) return; // caller consumes it
        depth--; out += c; i++; continue;
      }
      out += c; i++;
    }
  }

  function readTemplate() {
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { i++; return; }
      if (c === '$' && src[i + 1] === '{') {
        i += 2; out += '${';
        readCode(true);
        if (src[i] === '}') { out += '}'; i++; }
        continue;
      }
      i++;
    }
  }

  readCode(false);
  return out;
}

function functionBodies(src) {
  const bodies = [];
  const re = /(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    const name = m[1], params = m[2];
    let i = re.lastIndex - 1;
    let depth = 0;
    const start = i + 1;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) break; }
    }
    bodies.push({ name, params, body: src.slice(start, i) });
  }
  return bodies;
}

// Walk a body and report names declared only inside a nested BLOCK but used
// at block depth 0 (the function's own scope).
function findOutOfScope(params, body) {
  const paramNames = new Set(
    params.split(',').map(s => s.trim().replace(/^\.\.\./, '')).filter(Boolean)
  );
  // Names bound by nested closures (arrows, function expressions, catch).
  // They are declared-and-used inside their own scope, so they must not be
  // mistaken for a same-named const/let in a sibling block.
  const closureParams = new Set();
  const addParams = (list) => (list || '').split(',').forEach(p => {
    const n = p.trim().replace(/^\.\.\./, '').split(/[=:]/)[0].trim();
    if (/^[A-Za-z_$][\w$]*$/.test(n)) closureParams.add(n);
  });
  for (const m of body.matchAll(/\(([^()]*)\)\s*=>/g)) addParams(m[1]);
  for (const m of body.matchAll(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*=>/g)) addParams(m[1]);
  for (const m of body.matchAll(/function\s*[A-Za-z_$\w]*\s*\(([^()]*)\)/g)) addParams(m[1]);
  for (const m of body.matchAll(/catch\s*\(([^()]*)\)/g)) addParams(m[1]);

  const declDepths = new Map();   // name -> Set of block depths it is declared at
  const useDepths = new Map();    // name -> shallowest block depth it is used at
  const KEYWORDS = new Set(['const','let','var','function','return','if','else','for','while','do','switch',
    'case','break','continue','try','catch','finally','new','delete','typeof','void','in','of','instanceof',
    'await','async','yield','class','extends','super','this','throw','import','export','default','from','as',
    'static','get','set']);

  // brace stack: true = block, false = object literal / class body
  const stack = [];
  let depth = 0;
  let i = 0;
  let lastSig = '';
  let prevWord = '';
  const word = /[A-Za-z_$][\w$]*/y;

  while (i < body.length) {
    const c = body[i];
    if (c === '{') {
      const isBlock = lastSig === ')' || lastSig === '>' || ['else','try','finally','do'].includes(prevWord);
      stack.push(isBlock);
      if (isBlock) depth++;
      i++; lastSig = '{'; continue;
    }
    if (c === '}') {
      const wasBlock = stack.pop();
      if (wasBlock) depth--;
      i++; lastSig = '}'; continue;
    }
    word.lastIndex = i;
    const w = word.exec(body);
    if (!w) { if (!/\s/.test(c)) lastSig = c; i++; continue; }
    const tok = w[0];
    const before = body.slice(Math.max(0, w.index - 16), w.index);
    const after = body.slice(w.index + tok.length);
    const isProp = /[.\]]\s*$/.test(before) || /^\s*:/.test(after);
    const isDecl = /\b(const|let|var)\s+$/.test(before);
    if (isDecl && !paramNames.has(tok)) {
      if (!declDepths.has(tok)) declDepths.set(tok, new Set());
      declDepths.get(tok).add(depth);
    } else if (!isProp && !KEYWORDS.has(tok)) {
      const prev = useDepths.get(tok);
      if (prev === undefined || depth < prev) useDepths.set(tok, depth);
    }
    prevWord = tok;
    lastSig = tok.slice(-1);
    i = w.index + tok.length;
  }

  const bad = [];
  for (const [tok, useDepth] of useDepths) {
    if (paramNames.has(tok) || closureParams.has(tok) || GLOBALS.has(tok)) continue;
    const depths = declDepths.get(tok);
    if (!depths) continue; // declared elsewhere (module scope / import / destructuring)
    // In scope only if some declaration lives at the usage depth or shallower.
    if (![...depths].some(d => d <= useDepth)) bad.push(tok);
  }
  return bad.sort();
}

const problems = [];
for (const f of fs.readdirSync(DIR).filter(x => x.endsWith('.js')).sort()) {
  const src = stripNoise(fs.readFileSync(path.join(DIR, f), 'utf8'));
  for (const fn of functionBodies(src)) {
    for (const bad of findOutOfScope(fn.params, fn.body)) {
      problems.push(`${f}: ${fn.name}() uses "${bad}" outside the block that declares it`);
    }
  }
}

test('scope: no identifier is used outside the block that declares it', () => {
  assert.deepEqual(problems, [], '\n' + problems.join('\n'));
});

test('scope: the checker catches the shipped bug shape', () => {
  const buggy = stripNoise(`
    async function executeRescue() {
      let contract;
      const existing = await find();
      if (existing) {
        contract = existing;
      } else {
        const sponsorSigner = new Wallet(key);
        contract = await deploy(sponsorSigner);
      }
      const tx = await delegateAndExecute(contract, { targetSigner, sponsorSigner });
      return tx;
    }
  `);
  const fn = functionBodies(buggy)[0];
  assert.deepEqual(findOutOfScope(fn.params, fn.body), ['sponsorSigner']);
});

test('scope: a correctly hoisted declaration passes', () => {
  const good = stripNoise(`
    async function executeRescue() {
      const sponsorSigner = new Wallet(key);
      let contract;
      if (await find()) {
        contract = await reuse();
      } else {
        contract = await deploy(sponsorSigner);
      }
      return delegateAndExecute(contract, { sponsorSigner });
    }
  `);
  const fn = functionBodies(good)[0];
  assert.deepEqual(findOutOfScope(fn.params, fn.body), []);
});
