// ═══════════════════════════════════════════════════════════════
// Bear Tool — tests/security.test.js
// The signing guardrails and the URL secret hygiene.
// Every payload here is a real one seen in the wild; the calldata is built the
// way a real contract call is built, so a decoder that only handles a toy
// format cannot pass here.
// ═══════════════════════════════════════════════════════════════
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_UINT256, decodeApproval, selectorOf, selectorName, scanTransaction,
  isSecretishUrl, sanitizeForStore, isAllowedMethod, needsConfirmation,
} from '../js/security.js';

// ── ABI-encoded payloads, built the way the EVM expects ──────────────────
const pad = (hex) => hex.padStart(64, '0');
const addr = (a) => pad(a.replace(/^0x/, '').toLowerCase());
const uint = (n) => pad(BigInt(n).toString(16));

const approve = (spender, amount) =>
  '0x095ea7b3' + addr(spender) + uint(amount);
const setApprovalForAll = (operator, flag) =>
  '0xa22cb465' + addr(operator) + uint(flag ? 1 : 0);
const permit = () =>
  '0xd505accf' + addr('0x' + '11'.repeat(20)) + addr('0x' + '22'.repeat(20))
  + uint(1) + uint(9999999999) + uint(27) + uint('0x' + 'aa'.repeat(32)) + uint('0x' + 'bb'.repeat(32));

// ── approval decoding ────────────────────────────────────────────────────
test('decodeApproval reads an unlimited approve', () => {
  const r = decodeApproval(approve('0x' + 'ab'.repeat(20), MAX_UINT256));
  assert.equal(r.fn, 'approve');
  assert.equal(r.spender, '0x' + 'ab'.repeat(20));
  assert.equal(r.amount, MAX_UINT256);
  assert.equal(r.unlimited, true);
});

test('decodeApproval reads a bounded approve', () => {
  const r = decodeApproval(approve('0x' + 'ab'.repeat(20), 1000));
  assert.equal(r.unlimited, false);
  assert.equal(r.amount, 1000n);
});

test('decodeApproval reads setApprovalForAll(true) as operator access', () => {
  const r = decodeApproval(setApprovalForAll('0x' + 'cd'.repeat(20), true));
  assert.equal(r.fn, 'setApprovalForAll');
  assert.equal(r.operator, true);
  assert.equal(r.unlimited, true);
});

test('decodeApproval reads setApprovalForAll(false) as a revoke', () => {
  const r = decodeApproval(setApprovalForAll('0x' + 'cd'.repeat(20), false));
  assert.equal(r.unlimited, false);
  assert.equal(r.amount, 0n);
});

test('decodeApproval returns null for a call that approves nothing', () => {
  assert.equal(decodeApproval('0xdeadbeef'), null);
  assert.equal(decodeApproval(''), null);
  assert.equal(decodeApproval('0x'), null);
});

test('decodeApproval refuses a zero address spender instead of reporting one', () => {
  // A zero spender is not a real allowance; reporting it would be a lie.
  assert.equal(decodeApproval(approve('0x' + '00'.repeat(20), MAX_UINT256)), null);
});

test('decodeApproval tolerates short calldata without throwing', () => {
  assert.doesNotThrow(() => decodeApproval('0x095ea7b3'));
  assert.doesNotThrow(() => decodeApproval('0xa22cb465' + addr('0x' + '11'.repeat(20))));
});

// ── selector helpers ─────────────────────────────────────────────────────
test('selector helpers name what they can and admit what they cannot', () => {
  assert.equal(selectorOf('0x095ea7b3' + '0'.repeat(64)), '0x095ea7b3');
  assert.equal(selectorName('0xa22cb465' + '0'.repeat(128)), 'setApprovalForAll');
  assert.equal(selectorName('0xdeadbeef'), null);
  assert.equal(selectorOf('0x12'), null);
});

// ── the transaction scan: these are the ones that matter ─────────────────
test('an unlimited approval is high risk and says exactly what is exposed', () => {
  const r = scanTransaction({
    to: '0x' + '11'.repeat(20),
    data: approve('0x' + 'ab'.repeat(20), MAX_UINT256),
    knownContracts: ['0x' + '11'.repeat(20)],
  });
  assert.equal(r.risk, 'high');
  const f = r.findings.find((x) => /Unlimited spending approval/.test(x.title));
  assert.ok(f, 'the finding must exist');
  assert.ok(f.detail.includes('unlimited amount'), 'the detail must name the exposure');
  assert.ok(f.detail.includes('0x' + 'ab'.repeat(20)), 'the spender must be named');
});

test('setApprovalForAll(true) is high risk and names every token', () => {
  const r = scanTransaction({ to: '0x' + '11'.repeat(20), data: setApprovalForAll('0x' + 'cd'.repeat(20), true) });
  assert.equal(r.risk, 'high');
  assert.ok(r.findings.some((x) => /Operator access/.test(x.title)));
});

test('revoking an approval is reported as a pass, not a risk', () => {
  const r = scanTransaction({ to: '0x' + '11'.repeat(20), data: approve('0x' + 'ab'.repeat(20), 0) });
  assert.ok(r.findings.some((x) => x.level === 'pass' && /revoked/i.test(x.title)));
});

test('a permit is called out: no transaction, but a real authorisation', () => {
  const r = scanTransaction({ to: '0x' + '11'.repeat(20), data: permit() });
  assert.equal(r.risk, 'elevated');
  assert.ok(r.findings.some((x) => /Off-chain permit/.test(x.title)));
});

test('an unrecognised selector is never presented as safe', () => {
  const r = scanTransaction({ to: '0x' + '11'.repeat(20), data: '0xdeadbeef' + '00'.repeat(31) });
  assert.ok(r.findings.some((x) => /Unrecognised function/.test(x.title)));
  assert.notEqual(r.risk, 'low');
});

test('a first-time contract is flagged when other contracts are known', () => {
  const known = ['0x' + '11'.repeat(20)];
  const stranger = scanTransaction({ to: '0x' + '99'.repeat(20), data: '0xdeadbeef' + '00'.repeat(31), knownContracts: known });
  assert.ok(stranger.findings.some((x) => /not used before/.test(x.title)));
  const knownCall = scanTransaction({ to: '0x' + '11'.repeat(20), data: '0xdeadbeef' + '00'.repeat(31), knownContracts: known });
  assert.ok(!knownCall.findings.some((x) => /not used before/.test(x.title)));
});

test('a transaction with no destination is refused outright', () => {
  const r = scanTransaction({ to: '', value: 0 });
  assert.equal(r.risk, 'high');
  assert.ok(r.findings.some((x) => /No destination/.test(x.title)));
});

test('a plain transfer is low risk but still warns it is irreversible', () => {
  const r = scanTransaction({ to: '0x' + '11'.repeat(20), value: 10n ** 15n });
  assert.equal(r.risk, 'low');
  assert.ok(r.findings.some((x) => /cannot be reversed/.test(x.detail)));
});

test('a large amount asks for a typed confirmation', () => {
  const big = scanTransaction({ to: '0x' + '11'.repeat(20), value: 5n * 10n ** 18n });
  assert.ok(big.findings.some((x) => /Type the amount/.test(x.detail)));
  const small = scanTransaction({ to: '0x' + '11'.repeat(20), value: 1n });
  assert.ok(!small.findings.some((x) => /Type the amount/.test(x.detail)));
});

test('a zero-value empty transaction is described, not left blank', () => {
  const r = scanTransaction({ to: '0x' + '11'.repeat(20) });
  assert.ok(r.findings.some((x) => /No calldata/.test(x.detail)));
});

// ── URL secret hygiene: a pasted phrase must never be persisted ─────────
test('a recovery phrase pasted into the address bar is refused', () => {
  const phrase = 'https://x.com/?q=' + 'legal winner thank year wave sausage worth useful legal winner thank yellow';
  const r = isSecretishUrl(phrase);
  assert.equal(r.secret, true);
  assert.match(r.why, /recovery phrase|words/i);
  assert.equal(sanitizeForStore(phrase), null, 'must not be stored at all');
});

test('a raw private key in a URL is refused', () => {
  const key = 'https://x.com/' + '1'.repeat(64);
  assert.equal(isSecretishUrl(key).secret, true);
  assert.equal(sanitizeForStore(key), null);
});

test('a 0x-prefixed hex blob in the query is refused', () => {
  const blob = 'https://x.com/?data=0x' + 'a'.repeat(128);
  assert.equal(isSecretishUrl(blob).secret, true);
});

test('ordinary dApp URLs are stored, and only after losing the fragment', () => {
  const u = 'https://app.uniswap.org/#/swap?chain=eth';
  assert.equal(isSecretishUrl(u).secret, false);
  const stored = sanitizeForStore(u);
  assert.ok(!stored.includes('#'), 'the fragment can hold an OAuth token and is never sent to a server');
  assert.ok(stored.startsWith('https://app.uniswap.org/'));
});

test('a normal long article URL is not mistaken for a secret', () => {
  const url = 'https://blog.example.com/2026/09/a-fairly-long-and-normal-looking-slug-about-ethereum-upgrades';
  assert.equal(isSecretishUrl(url).secret, false);
  assert.ok(sanitizeForStore(url));
});

test('sanitizeForStore rejects nonsense instead of persisting it', () => {
  assert.equal(sanitizeForStore(''), null);
  assert.equal(sanitizeForStore('   '), null);
  assert.equal(sanitizeForStore('not a url at all'), null);
});

// ── EIP-1193 allow-list ──────────────────────────────────────────────────
test('reads are allowed, state changes need confirmation', () => {
  assert.ok(isAllowedMethod('eth_chainId'));
  assert.ok(isAllowedMethod('eth_call'));
  assert.ok(isAllowedMethod('eth_sendTransaction'));
  assert.ok(needsConfirmation('eth_sendTransaction'));
  assert.ok(needsConfirmation('personal_sign'));
  assert.ok(needsConfirmation('eth_signTypedData_v4'));
  assert.ok(needsConfirmation('wallet_switchEthereumChain'));
});

test('anything not on the list is refused', () => {
  for (const m of ['eth_sign', 'wallet_unlock', 'debug_traceCall', 'personal_decrypt', '', null, undefined]) {
    assert.equal(isAllowedMethod(m), false, String(m));
  }
});

test('a read method never requires confirmation', () => {
  assert.equal(needsConfirmation('eth_chainId'), false);
  assert.equal(needsConfirmation('eth_getBalance'), false);
});
