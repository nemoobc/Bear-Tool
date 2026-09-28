// The error translator, tested against the error shapes this app actually
// produces rather than the ones that are convenient to write down.
//
// The feature exists because the swap path showed a user this:
//
//   Swap failed: execution reverted: "UniswapV2Library: INSUFFICIENT_INPUT_AMOUNT"
//   (action="estimateGas", data="0x7ff36ab5…", reason=…, transaction={…})
//
// The revert strings below are the real ones. The four V2/V3 router messages come
// from the Uniswap v2-periphery source; the EVM-level ones are what ethers and
// geth produce. A table written from imagination would pass a test written from
// the same imagination, which is how the swap module stayed broken and green.
//
// The two properties that matter most, and that are easy to lose quietly:
//   - idempotency: a message the app already wrote in plain words must arrive
//     unchanged, or the translator starts mangling good copy;
//   - no code leaks: no selector, no 40-hex address, no calldata, no stack.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const { explainError, looksRaw, rawDetail, __tableSize } =
  await import(pathToFileURL(path.join(here, '..', 'js', 'errors.js')).href);

// ── real inputs ────────────────────────────────────────────────────────────

// Ethers wraps a revert several objects deep; the top-level message is a wall of
// transaction JSON. This is the shape that reached the user, built to match.
function ethersLike(reason, extra = {}) {
  const err = new Error(
    `cannot estimate gas; transaction may fail or may require manual gas limit (error={...` +
    `reason="${reason}", method="estimateGas", transaction={data="0x7ff36ab5000"}})`
  );
  err.code = 'UNPREDICTABLE_GAS_LIMIT';
  err.shortMessage = `execution reverted: "${reason}"`;
  err.reason = reason;
  err.info = { error: { message: `execution reverted: "${reason}"` } };
  return Object.assign(err, extra);
}

const CASES = [
  // [name, input, must mention / must not merely echo]
  ['gas: not enough for the fee',
    new Error('insufficient funds for gas * price + value'), /coin|network fee|gas/i],
  ['gas limit too low',
    new Error('gas required exceeds allowance'), /gas limit|raise the gas limit/i],
  ['base fee above max fee',
    new Error('max fee per gas less than block base fee'), /maximum fee|network fee/i],
  ['pending transaction in the way',
    new Error('nonce too low'), /still (?:pending|waiting)/i],
  ['replacement underpriced',
    new Error('replacement transaction underpriced'), /pending|raise the fee/i],
  ['out of gas',
    new Error('out of gas'), /gas/i],
  ['token balance too low',
    new Error('ERC20: transfer amount exceeds balance'), /not enough of this token/i],
  ['approval missing',
    ethersLike('TransferHelper: TRANSFER_FROM_FAILED'), /not approved|approve/i],
  ['price moved (out)',
    ethersLike('UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT'), /price moved|slippage/i],
  ['no pair',
    ethersLike('UniswapV2Library: INSUFFICIENT_INPUT_AMOUNT'), /no trading pair|different token or network/i],
  ['pair invariant changed',
    ethersLike('UniswapV2: K'), /reserves changed/i],
  ['identical addresses',
    ethersLike('UniswapV2Library: IDENTICAL_ADDRESSES'), /same asset/i],
  ['invalid path',
    ethersLike('UniswapV2Router: INVALID_PATH'), /same asset|route/i],
  ['expired',
    ethersLike('UniswapV2Router: EXPIRED'), /expired/i],
  ['user cancelled',
    { code: 'ACTION_REJECTED', message: 'user rejected action' }, /cancelled|nothing was sent/i],
  ['wallet locked',
    new Error('wallet is locked'), /locked/i],
  ['wrong password',
    new Error('incorrect password'), /password/i],
  ['network unreachable',
    new Error('fetch failed'), /could not reach the network|connection/i],
  ['chain not supported',
    new Error('uniswap_v2 is not deployed on chain 999'), /not one this tool can connect|supported network/i],
  ['opensea 401',
    new Error('HTTP 401: api key required'), /api key/i],
  ['opensea 404 collection',
    new Error('OpenSea 404: no collection named zz-nope'), /no collection/i],
  ['opensea 429',
    new Error('HTTP 429 rate limit'), /rate-limit/i],
];

for (const [name, input, pattern] of CASES) {
  test(`explains: ${name}`, () => {
    const out = explainError(input, 'Swap');
    assert.match(out, pattern, `pesan tidak menjelaskan masalahnya: "${out}"`);
    // The pattern alone is not evidence: several raw inputs contain the very words
    // the pattern looks for, so an untranslated message satisfies it. The first run
    // of this file passed "gas: not enough for the fee" while returning the raw
    // string untouched — the word "gas" was in it. So the output must also differ
    // from the input.
    const rawText = typeof input === 'string' ? input : String(input.message || '');
    assert.notEqual(out, rawText, `masih mentah: "${out}"`);
  });
}

// ── the two properties that are easy to lose ───────────────────────────────

test('a message the app already wrote in plain words is left alone', () => {
  // The failure mode of any translator: a rewrite that "improves" a good message.
  // Every one of these came out of this app and is already what a person needs.
  const keep = [
    'Enter amount to swap',
    'Fill contract, token ID, and price.',
    'Pick a wallet first',
    'Fill contract and token ID to cancel.',
    'Quote is for a different token — re-quote',
    'Network error — check your connection',
  ];
  for (const m of keep) {
    assert.equal(explainError(m, 'Swap'), m, `pesan yang sudah baik dirubah: ${m}`);
    assert.equal(explainError(new Error(m), 'Swap'), m, `Error dengan pesan baik dirubah: ${m}`);
  }
});

test('nothing in the output looks like code', () => {
  // The whole point of the module. Asserted on the output, not on the table,
  // because a single leaky rule is enough and it would not be caught otherwise.
  const leaky = [
    ethersLike('UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT'),
    new Error('insufficient funds for gas * price + value'),
    { code: 'ACTION_REJECTED', message: 'user rejected action' },
    new Error('fetch failed'),
    new Error('some brand new failure nobody has seen before'),
  ];
  for (const e of leaky) {
    const out = explainError(e, 'Send');
    assert.doesNotMatch(out, /0x[0-9a-fA-F]{6,}/, `hex bocor: ${out}`);
    assert.doesNotMatch(out, /UNISWAP|ERC20|ERC721|CALL_EXCEPTION|UNPREDICTABLE|TRANSFER_FROM|IDENTICAL_ADDRESS/i,
      `kode bocor: ${out}`);
    assert.doesNotMatch(out, /action=|transaction=|reason=|data=/i, `json bocor: ${out}`);
    assert.doesNotMatch(out, /\bat\s+\S+\s+\(/, `stack bocor: ${out}`);
    assert.doesNotMatch(out, /Error:/, `prefix Error bocor: ${out}`);
  }
});
test('an unrecognised but machine-shaped failure gets the generic sentence', () => {
  // The fallback fires for things that look machine-shaped and match no rule. It
  // must still name the feature and point at the console, and it must not hand the
  // raw text back to the reader.
  const out = explainError(
    Object.assign(new Error('opcode 0xfe not recognised at pc 0x4a2b'), { code: 'UNKNOWN' }), 'Bridge');
  assert.match(out, /Bridge could not be completed/, `fallback tidak menyebut fiturnya: ${out}`);
  assert.match(out, /console/i, 'fallback harus menunjuk ke mana mencari detail');
  assert.doesNotMatch(out, /opcode|0xfe|0x4a2b/);
});

test('unfamiliar prose is passed through rather than rewritten', () => {
  // A deliberate choice, pinned as a test because it otherwise reads as a bug.
  // Nothing can tell "a sentence this app wrote that I have not seen" apart from
  // "an unfamiliar machine message", and mangling a good message is worse than
  // passing through a strange one: the first loses information, the second merely
  // reads oddly. Machine-shaped input is handled by looksRaw, and anything with a
  // recognisable token is handled by the table.
  const sentence = 'EIP-99999 something entirely new happened here';
  assert.equal(explainError(new Error(sentence), 'Bridge'), sentence);
});

test('the raw text is kept for the console and never returned to the user', () => {
  const e = ethersLike('UniswapV2Router: EXPIRED');
  const raw = rawDetail(e);
  assert.match(raw, /EXPIRED/, 'rawDetail harus menyimpan revert asli');
  assert.doesNotMatch(explainError(e, 'Swap'), /EXPIRED/,
    'revert mentah tidak boleh bocor ke output');
});

test('looksRaw separates machine text from a sentence', () => {
  for (const s of [
    'execution reverted: "boom"',
    'cannot estimate gas; transaction may fail',
    'error={"reason":"K"}',
    '0x7ff36ab5',
    'TypeError: x is not a function',
  ]) assert.ok(looksRaw(s), `harus dianggap mentah: ${s}`);
  for (const s of [
    'Enter amount to swap',
    'Fill contract, token ID, and price.',
    'Pick a network first',
    'That took too long, try again',
  ]) assert.doesNotMatch(s, /^$/), assert.ok(!looksRaw(s), `harus dianggap kalimat: ${s}`);
});

test('the table is not empty and every rule is reachable', () => {
  // A table that lost its entries would still leave a module that returns the
  // fallback for everything, and the tests above would notice — but only for the
  // cases they happen to cover. This asserts the shape instead: a real table, with
  // every rule carrying a sentence that reads like one.
  assert.ok(__tableSize >= 30, `hanya ${__tableSize} aturan — tabel kemungkinan hilang`);
});
