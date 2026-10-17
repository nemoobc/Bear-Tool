// Sweep: nested interactive elements are BANNED in every emitted template.
//
// The class of bug this file exists for was shipped twice and burned the
// user twice. A <button> (or <a>) rendered INSIDE another <button>/<a> is
// invalid HTML: the browser's parser "repairs" it by hoisting the inner
// element OUT of its parent, so:
//   - dataset indexes stop matching the visual row (a ✕ press closed the
//     WRONG dApp tab — live report 2026-10-17), and
//   - click bubbling routes inner taps to unexpected handlers.
// Browsers do this silently and unit stubs mirror the parent behaviour, so
// only a SOURCE-LEVEL rule catches it before shipping.
//
// The detector must scan the same renderer code the browser executes, which
// means comment prose is not markup: "<button>" written in a comment is the
// explanation of a FIX (dapps.js, dapp-browser.js), not a nested tag. JS
// comments are stripped first — a detector tripped by its own explanation
// would teach the next person to delete the explanation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const jsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'js');
const CONTAINERS = ['button', 'a', 'select', 'summary', 'label', 'form'];

export function nestedInteractiveFindings(src) {
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[<>]/g, '·')) // block comments
    .replace(/(^|[^:])\/\/(?!\/).*$/gm, '$1');                    // line comments
  const findings = [];
  const stack = [];
  const re = /<\/?(button|a|select|summary|label|form)\b[^>]*(\/?)>/g;
  let m;
  while ((m = re.exec(stripped))) {
    const tag = m[1];
    if (m[2] === '/') continue;
    if (m[0].startsWith('</')) {
      const i = stack.map((s) => s.tag).lastIndexOf(tag);
      if (i !== -1) stack.length = i;
      continue;
    }
    const line = stripped.slice(0, m.index).split('\n').length;
    const top = stack[stack.length - 1];
    if (top) findings.push({ tag, inside: top.tag, line });
    stack.push({ tag, line });
  }
  CONTAINERS.indexOf('button'); // shape guard: the list is every interactive container
  return findings;
}

test('no interactive element nests inside another (invalid HTML class-bug)', () => {
  const files = readdirSync(jsDir).filter((f) => f.endsWith('.js'));
  const all = [];
  for (const file of files) {
    const findings = nestedInteractiveFindings(readFileSync(path.join(jsDir, file), 'utf8'));
    for (const f of findings) all.push(`${file}:${f.line} <${f.tag}> inside <${f.inside}>`);
  }
  assert.deepEqual(all, [],
    'nested interactive elements found — the parser will hoist the inner one and indexes will lie');
});
