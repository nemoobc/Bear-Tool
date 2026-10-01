// Bear Tool — audit-regression.test.js
//
// Every test here locks a defect that shipped once and was found by audit
// rather than by a test. They are grouped by the kind of bug, because the
// pattern matters more than the instance: an undeclared custom property, a
// promise with no way to be cancelled, a layout assumption that was never
// checked, and a record written before the thing it records was confirmed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appSource } from './helpers/app-source.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const css = read('css/cartoon.css');
// Halaman = index.html + semua section view (M2 pindah ke src/views/*.jsx).
const html = appSource();
const app = read('js/app.js');
const ui = read('js/ui.js');

/** Strip comments so a rule quoted inside one cannot satisfy a grep. */
const stripCssComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const bareCss = stripCssComments(css);
const stripHtmlComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '');
const bareHtml = stripHtmlComments(html);

// ─────────────────────────────────────────────────────────────────────────────
// 1. Undeclared custom properties
//
// .seed-choice-btn.wrong used `background: var(--danger)` with no fallback and
// --danger was never declared. An undeclared var() with no fallback invalidates
// the declaration at computed-value time, so the background fell back to
// transparent while `color: var(--white)` still applied — white text on the
// cream modal. The result was the bug the rule was written to fix: the word
// "wrong" was invisible.
// ─────────────────────────────────────────────────────────────────────────────

test('every custom property used without a fallback is actually declared', () => {
  const declared = new Set();
  for (const m of bareCss.matchAll(/(--[a-z0-9-]+)\s*:/gi)) declared.add(m[1]);
  for (const m of read('index.html').matchAll(/(--[a-z0-9-]+)\s*:/gi)) declared.add(m[1]);

  const missing = new Set();
  for (const m of bareCss.matchAll(/var\(\s*(--[a-z0-9-]+)\s*\)/gi)) {
    // A closing paren right after the name means no fallback was supplied.
    if (!declared.has(m[1])) missing.add(m[1]);
  }
  assert.deepEqual([...missing], [],
    `used with no fallback but never declared: ${[...missing].join(', ')}`);
});

test('the seed wrong-answer state resolves to a real background', () => {
  const m = bareCss.match(/\.seed-choice-btn\.wrong\s*\{([^}]*)\}/);
  assert.ok(m, '.seed-choice-btn.wrong rule must exist');
  const bg = m[1].match(/background:\s*([^;]+);/i)?.[1]?.trim();
  const colour = m[1].match(/color:\s*([^;]+);/i)?.[1]?.trim();
  assert.ok(bg, 'a wrong-answer state with no background is invisible text');
  assert.ok(colour, 'a wrong-answer state with no text colour is invisible text');
  // Ask the declaration set, not a regex: a negative lookahead over a greedy
  // character class backtracks and matches anyway, which is how an earlier
  // version of this test failed on the very declaration it was checking.
  const declared = new Set([...bareCss.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((x) => x[1]));
  for (const v of (bg.match(/--[a-z0-9-]+/g) || [])) {
    assert.ok(declared.has(v), `background uses ${v}, which is never declared`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Layout assumptions that were never checked
//
// The MAX note was written to sit *under* the control that produces it, and
// the comment in index.html said so. It was in fact the fifth flex child of the
// button row, which squeezed the four percentage buttons to 23-39px and
// rendered the note as a 23x36px box beside them.
// ─────────────────────────────────────────────────────────────────────────────

function ancestorOf(markup, id) {
  const stack = [];
  const owner = {};
  for (const tok of markup.match(/<div\b[^>]*>|<\/div>|<p\b[^>]*>/g) || []) {
    if (tok.startsWith('</')) { stack.pop(); continue; }
    if (tok.startsWith('<div')) { stack.push(tok); continue; }
    const hit = id && tok.includes(`id="${id}"`);
    if (hit) owner[id] = stack[stack.length - 1] || '(top level)';
  }
  return owner[id];
}

test('the MAX note is a sibling of the button row, not a flex child of it', () => {
  for (const id of ['sendMaxNote', 'swapMaxNote', 'bridgeMaxNote']) {
    const parent = ancestorOf(bareHtml, id);
    assert.ok(parent, `${id} must exist in the page markup (index.html + src/views)`);
    assert.ok(!/pct-btns|input-row|amount-row/.test(parent),
      `${id} is inside "${parent}" — that is a flex row, so the note renders ` +
      `beside the buttons at a few px wide instead of under them`);
  }
});

test('.pct-btn has a width floor so four of them cannot shrink below the touch target', () => {
  const m = bareCss.match(/\.pct-btn\s*\{([^}]*)\}/);
  assert.ok(m, '.pct-btn rule must exist');
  assert.match(m[1], /min-width:\s*var\(--touch-min\)/,
    'flex:1 alone lets the buttons share whatever is left; without min-width ' +
    'they measured 34-39px wide at 360px, under the declared 44px floor');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. A modal is a promise in disguise, and every promise needs a way out
//
// openModal() locks body scroll and only closeModal() releases it. Three
// "Close" buttons called classList.remove('open') directly, so declining the
// Delete Wallet dialog left the whole app unscrollable. Separately, confirmTx
// and promptPassword resolve only from their own buttons: closing with ✕, the
// backdrop or Escape stranded the caller forever, with its button still
// spinning.
// ─────────────────────────────────────────────────────────────────────────────

test('no close control bypasses closeModal(), so the scroll lock always lifts', () => {
  const js = ['app.js', 'ui.js', 'deploy.js', 'eip7702-tools.js', 'network.js', 'send.js', 'swap.js', 'bridge.js']
    .map((f) => read(`js/${f}`));
  for (const [i, src] of js.entries()) {
    const offenders = src.match(/classList\.remove\(['"]open['"]\)/g) || [];
    // dapp-browser.js builds its own overlay and is not covered here.
    assert.deepEqual(offenders, [],
      `${['app.js','ui.js','deploy.js','eip7702-tools.js','network.js','send.js','swap.js','bridge.js'][i]} ` +
      `removes the overlay class directly, which leaves body overflow hidden`);
  }
});

test('every close control carries data-close-modal', () => {
  // Every modal is built in JS, so this is a question about the templates, not
  // about index.html — which is where an earlier version of this test looked and
  // found nothing, and called it a failure.
  const sources = { 'app.js': app, 'ui.js': ui, 'deploy.js': read('js/deploy.js'),
                    'eip7702-tools.js': read('js/eip7702-tools.js') };
  let total = 0;
  for (const [name, src] of Object.entries(sources)) {
    const all = src.match(/<button[^>]*class="[^"]*modal-close[^"]*"[^>]*>/g) || [];
    total += all.length;
    for (const b of all) {
      assert.match(b, /data-close-modal/,
        `${name}: a .modal-close without data-close-modal relies on the document ` +
        `net alone: ${b.slice(0, 80)}…`);
    }
  }
  assert.ok(total > 0, 'sanity: the app is expected to have modal-close buttons');
});

test('closeModal settles the promise the dialog was holding', () => {
  assert.match(ui, /if \(onClose\)/,
    'closeModal must invoke the pending settle hook — otherwise confirmTx ' +
    'never resolves when the dialog is dismissed by ✕, backdrop or Escape');
  assert.match(ui, /onClose = \(\) => settle\(false\)/,
    'confirmTx must treat dismissal as "no", not leave the caller pending');
  assert.match(ui, /onClose = \(\) => done\(null\)/,
    'promptPassword must treat dismissal as cancelled');
});

test('openModal captures the opener before it destroys it', () => {
  const capture = ui.indexOf('lastFocused = document.activeElement');
  const rewrite = ui.indexOf('box.innerHTML = html');
  assert.ok(capture >= 0 && rewrite >= 0, 'both lines must exist');
  assert.ok(capture < rewrite,
    'lastFocused was read after box.innerHTML replaced the DOM, so it always ' +
    'captured <body> and closeModal dumped focus at the top of the document');
});

test('openModal binds the close handler by assignment, not by addEventListener', () => {
  const body = ui.slice(ui.indexOf('export function openModal'), ui.indexOf('export function closeModal'));
  assert.doesNotMatch(body, /overlay\.addEventListener/,
    '#modalOverlay is one persistent node, so a listener added per open ' +
    'stacks and one ✕ click runs closeModal() N times');
  assert.match(body, /overlay\.onclick = /, 'the backdrop/✕ handler must be an assignment');
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Records written before the thing they record was confirmed
//
// saveDeployed('token', …) ran before the receipt check, so a deploy whose
// transaction reverted was filed as a working token. CREATE always yields an
// address, so the address exists — with no code at it — and every later screen
// treated it as real.
// ─────────────────────────────────────────────────────────────────────────────

test('a reverted deploy is not recorded as a deployed token', () => {
  const d = read('js/deploy.js');
  const save = d.indexOf('const record = () => saveDeployed(');
  assert.ok(save >= 0, 'expected the save to be behind a record() closure');
  const reverted = d.indexOf("if (status !== 'success')");
  const timedOut = d.indexOf('if (timedOut && !receipt)');
  assert.ok(reverted > 0 && timedOut > 0);
  const afterRevert = d.indexOf('record()', reverted);
  assert.ok(afterRevert > reverted,
    'record() must not run before the revert check returns');
  const timedOutSave = d.indexOf('record()', timedOut);
  assert.ok(timedOutSave < reverted,
    'a timed-out deploy does have a real address and may still land, so it ' +
    'is still recorded — before the revert branch');
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Keys left in the document
//
// The sponsor key was read out of a plain password input and nothing removed
// it, so a private key sat in the live DOM for the rest of the session.
// ─────────────────────────────────────────────────────────────────────────────

test('the sponsor key is wiped from the DOM once it validates', () => {
  const t = read('js/eip7702-tools.js');
  const validations = t.match(/return toast\('Invalid sponsor private key', 'error'\);/g) || [];
  assert.equal(validations.length, 4, 'there are four sponsor-key entry points');
  const wipes = t.match(/wipeKeyField\('#rescueSponsorKey'\); wipeKeyField\('#claimSponsorKey'\);/g) || [];
  assert.equal(wipes.length, 4,
    'every entry point must clear the field after validation, so a valid key ' +
    'does not sit in the document for the rest of the session');
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Approvals that never expire
//
// c.approve(router, MaxUint256) is permanent: the router keeps the right to
// pull the whole balance for as long as it holds the allowance.
// ─────────────────────────────────────────────────────────────────────────────

test('the swap router is approved for the amount being swapped, not the maximum', () => {
  const s = read('js/swap.js');
  assert.doesNotMatch(s, /approve\(\s*\w+\s*,\s*ethers\.MaxUint256\s*\)/,
    'an unlimited approval hands the router a permanent right to the whole ' +
    'balance; approve the exact amountWei instead');
  assert.match(s, /approve\(\s*router\s*,\s*amountWei\s*\)/,
    'the approval must cover this swap, so the next one asks again');
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Confirmation that only happens on mainnet
//
// Batch, Rescue and Claim wrapped the whole confirmTx in
// `if (net.type === 'mainnet')`, so on a testnet all three executed with no
// prompt at all. Every other confirmTx in the app is unconditional and varies
// only the title and the danger flag.
// ─────────────────────────────────────────────────────────────────────────────

test('rescue, claim and batch always ask, on every network', () => {
  const t = read('js/eip7702-tools.js');
  assert.doesNotMatch(t, /if \(net\.type === 'mainnet'\) \{\s*const ok = await confirmTx/,
    'the confirmation is gated on mainnet, so testnets run it unconfirmed');
  for (const [what, call] of [
    ['batch', 'Batch ${valid.length} calls on'],
    ['rescue', 'Rescue from'],
    ['claim', 'Claim on'],
  ]) {
    assert.ok(t.includes(call),
      `${what} needs a non-mainnet title too — the dialog has to name the network`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Validation that stops after the first element
//
// The batch executor checked valid[0].to and let the rest through. The helper
// contract is not a validator, so a malformed entry at position 2 reverts the
// whole batch instead of the one bad call.
// ─────────────────────────────────────────────────────────────────────────────

test('every batch target address is validated, not just the first', () => {
  const t = read('js/eip7702-tools.js');
  assert.doesNotMatch(t, /isValidAddress\(valid\[0\]\.to\)/,
    'only the first address is checked, so a bad entry at position 2..n is ' +
    'handed to the contract and reverts the whole batch');
  assert.match(t, /valid\.map\(\(b, i\) => \(wallet\.isValidAddress\(b\.to\)/,
    'each entry must be validated and the failing positions reported');
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. A security panel that overstates itself
//
// The Security Center described detectors as "Applied to every transaction"
// while scanTransaction was never called from anywhere outside security.js.
// Telling a user a filter is running when it is not is worse than having no
// filter, so the copy has to match the code.
// ─────────────────────────────────────────────────────────────────────────────

test('the Security Center describes the scanner accurately, in both directions', () => {
  const sc = read('js/security-center.js');
  // scanTransaction now HAS a caller, so the panel can no longer claim the
  // checks are not applied — and equally must not imply they cover the wallet's
  // own Send/Swap flows, which they do not.
  assert.doesNotMatch(sc, /not currently run against the transaction/,
    'the detectors are wired into the dApp signing path now');
  assert.match(sc, /Every signing or spending call from a dApp is scanned/,
    'say what is actually covered');
  assert.match(sc, /do <strong>not<\/strong> run on transactions you start yourself/,
    'and be explicit about what is not covered — the wallet\'s own flows are not');

  // And the scanner must genuinely be called, not merely mentioned.
  const app = read('js/app.js');
  assert.match(app, /import \{ scanTransaction \} from '\.\/security\.js'/,
    'app.js must import the detector it describes');
  assert.match(app, /scanSignCall\(method, params\)/,
    'and must call it on the signing path');
});

test('dApp signing and spending are confirmed on every call, not once per site', () => {
  const bridge = read('js/dapp-bridge.js');
  // CONFIRMED_METHODS listed eth_sendTransaction and eth_signTypedData, and the
  // code then let every later call through untouched once the permission existed.
  // The list said "always needs confirmation" and the code did the opposite.
  assert.match(bridge, /const PER_CALL_CONFIRM = new Set\(\[([\s\S]*?)\]\)/,
    'the per-call set must be explicit');
  const set = bridge.match(/const PER_CALL_CONFIRM = new Set\(\[([\s\S]*?)\]\)/)[1];
  for (const m of ['eth_sendTransaction', 'personal_sign', 'eth_signTypedData_v4']) {
    assert.ok(set.includes(`'${m}'`), `${m} must be confirmed on every call`);
  }
  assert.ok(!/wallet_switchEthereumChain/.test(set),
    'a chain switch is reversible and nagging on each one teaches people to click through');
  assert.match(bridge, /if \(PER_CALL_CONFIRM\.has\(method\)\)/,
    'the per-call gate must actually be applied');
  // …and app.js must handle the new kind, not fall through to a plain passthrough.
  const app = read('js/app.js');
  assert.match(app, /kind === 'sign'/, "app.js must handle kind === 'sign'");
});

test('the fork helper verifies the chain on the port instead of adopting it', () => {
  // "Something is listening on 8545" was read as "anvil is up, reuse it". When
  // FORK_NETWORK changes and the previous network's anvil is still there, that
  // adopts the wrong chain and every test fails until something else kills it.
  // Measured: a twelve-network sweep needed a retry on 7 of 7 files, every
  // network, deterministically — which is not flakiness.
  const h = read('tests/fork/fork-helper.mjs');
  assert.match(h, /eth_chainId/,
    'the probe must ask which chain is on the port, not just whether anything answers');
  assert.match(h, /serving chain/,
    'a mismatch must be reported, so the cause is visible in the log');
  assert.match(h, /replacing it rather than adopting it/,
    'and the wrong anvil must be replaced, not reused');
  // The `if (!alive)` start branch is still correct and stays; what was wrong was
  // deciding `alive` from a bare liveness probe. An earlier version of this test
  // forbade the branch outright, which would have banned the fix along with the
  // bug.
  assert.match(h, /if \(!alive\) \{/,
    'nothing on the port must still start a fresh anvil');
});

test('the signing path handles what scanTransaction actually returns', () => {
  // scanTransaction returns { risk, findings, approval }, not a list. Treating its
  // return value as an array threw "findings.find is not a function" the first
  // time a dApp sent a real transaction — a type error on the signing path,
  // found by driving a page, not by reading the source.
  const s = read('js/security.js');
  assert.match(s, /return \{ risk, findings, approval \}/,
    'scanTransaction returns an object; if that ever changes, this test is the canary');
  const app = read('js/app.js');
  assert.match(app, /Array\.isArray\(r\?\.findings\) \? r\.findings : \[\]/,
    'the caller must take the findings array out of the result object');
  assert.doesNotMatch(app, /return scanTransaction\([\s\S]{0,200}?\) \|\| \[\];/,
    'returning the result object and calling .find() on it is the bug');
});

test('no local binding shadows a module-level function of the same name', () => {
  // dapp-bridge.js has a module-level `approved()` consent helper. The per-call
  // gate introduced `const approved` inside request(), shadowing it — harmless
  // until someone inside that block reaches for the helper and gets a boolean.
  // scope.test.js flagged it as a scope violation, which is technically the wrong
  // diagnosis, but it was pointing at a real collision.
  const src = read('js/dapp-bridge.js');
  const helpers = [...src.matchAll(/function\s+(\w+)\s*\(/g)].map((m) => m[1]);
  const shadowed = [];
  for (const m of src.matchAll(/(?:const|let|var)\s+(\w+)\s*=/g)) {
    if (helpers.includes(m[1])) shadowed.push(m[1]);
  }
  assert.deepEqual([...new Set(shadowed)], [],
    `a local binding shadows a module-level function: ${[...new Set(shadowed)].join(', ')}`);
});
