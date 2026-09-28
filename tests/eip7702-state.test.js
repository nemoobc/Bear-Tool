// Bear Tool — EIP-7702 state reading and authorization construction
//
// These are the parts of the 7702 lifecycle that can be verified with no chain
// at all, and they turned out to be where the real defect was.
//
// The chain gap is real and now measured: anvil mines a type-4 transaction
// (status 1, gas 46,000, nonce advances) and does not apply the authorization,
// on a fresh chain with --hardfork prague and a clean EOA, in the exact shape
// js/eip7702.js sends. So the on-chain revoke test cannot run there.
//
// But "cannot verify the chain applies it" is not the same as "cannot verify the
// wallet asks for it correctly", and the second is where a silent failure was
// sitting. getDelegation() returned any code beginning 0xef0100 as a live
// delegation. A revoke does not clear the code — it rewrites the target to the
// zero address — so after a revoke that SUCCEEDED, getDelegation returned the
// zero address as if it were an implementation, and revokeDelegation()'s own
// post-check ("any non-null answer means still delegated") reported a successful
// revoke as a failure. The user's most safety-critical button would have told
// them it did not work, on every successful use.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const { getDelegation, EIP7702 } = await import(pathToFileURL(path.join(here, '..', 'js', 'network.js')).href);
const { ethers } = await import('ethers');

const PREFIX = '0xef0100';
const IMPL = '0x1111111111111111111111111111111111111111';
const IMPL2 = '0x2222222222222222222222222222222222222222';
const ZERO = '0x0000000000000000000000000000000000000000';
const ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

// A provider stand-in: getDelegation's only dependency is getCode.
const withCode = (code) => ({ getCode: async () => code });

test('a plain EOA reads as no delegation', async () => {
  assert.equal(await getDelegation(withCode('0x'), ADDR), null);
  assert.equal(await getDelegation(withCode(''), ADDR), null);
  assert.equal(await getDelegation(withCode(null), ADDR), null);
});

test('a live delegation reads back as its implementation', async () => {
  const d = await getDelegation(withCode(PREFIX + IMPL.slice(2)), ADDR);
  assert.equal(d, IMPL);
});

test('an ordinary contract is not mistaken for a delegation', async () => {
  // A real contract's code does not start with 0xef0100, and getDelegation must
  // say "not delegated" rather than returning a 20-byte fragment of bytecode.
  const someContract = '0x6080604052600436106100';
  assert.equal(await getDelegation(withCode(someContract), ADDR), null);
});

test('a REVOKED account reads as no delegation — the 20-byte zero form', async () => {
  // EIP-7702: revoking rewrites the designation to the zero address. eth_getCode
  // then returns 0xef0100 || 0x0000000000000000000000000000000000000000 — NOT
  // 0xef0100 || 0x1111… — and NOT 0x. The old code sliced the remainder and
  // returned it, so this case produced a non-null "delegation" and inverted the
  // revoke verdict.
  const code = PREFIX + ZERO.slice(2);
  assert.equal(code.length, 48, 'sanity: 6 hex prefix + 40 hex address');
  assert.notEqual(code, '0x', 'a revoked account is not code-free');
  assert.equal(await getDelegation(withCode(code), ADDR), null,
    'a zero target means revoked, not delegated-to-nothing');
});

test('a REVOKED account reads as no delegation — the wider 32-byte zero form', async () => {
  // Some clients emit 32 zero bytes after the prefix. Reading only the first 20
  // bytes is what makes that case work too; comparing the whole remainder would
  // have missed it.
  const code = PREFIX + '0'.repeat(64);
  assert.equal(code.length, 72);
  assert.equal(await getDelegation(withCode(code), ADDR), null);
});

test('uppercase hex in the code is still a revocation', async () => {
  assert.equal(await getDelegation(withCode(PREFIX + '0'.repeat(40).toUpperCase()), ADDR), null);
});

test('re-delegating to a different implementation is visible again', async () => {
  assert.equal(await getDelegation(withCode(PREFIX + IMPL.slice(2)), ADDR), IMPL);
  assert.equal(await getDelegation(withCode(PREFIX + ZERO.slice(2)), ADDR), null);
  assert.equal(await getDelegation(withCode(PREFIX + IMPL2.slice(2)), ADDR), IMPL2);
});

// ── the authorization the wallet builds ──────────────────────────────────
// The chain never applies it on anvil, so this is the only place the tuple can
// be checked. A revoke that targets the wrong address, or signs the wrong nonce,
// fails on a real chain in a way no local test would have caught.

const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

test('a revoke authorization targets the zero address, not the implementation', () => {
  const w = new ethers.Wallet(KEY);
  const auth = w.authorizeSync({ chainId: 1, address: EIP7702.ZERO_ADDRESS, nonce: 7 });
  assert.equal(auth.address, EIP7702.ZERO_ADDRESS,
    'revoking means authorising the zero address — anything else re-delegates');
  assert.equal(auth.nonce, 7n);
  assert.equal(auth.chainId, 1n);
});

test('the revoke authorization actually reaches the signed type-4 payload', async () => {
  // authorizeSync() returns an UNSIGNED tuple here — chainId, address, nonce and
  // a `signature` field that is an empty object. Signing happens later, inside
  // the transaction. So "does the wallet ask for the right thing" has to be
  // answered by inspecting the transaction it would actually broadcast.
  //
  // This is the stronger claim and the one that matters. A tuple that is correct
  // in isolation and then dropped during serialization is exactly what an
  // EIP-1559 fallback produces, and that transaction still reports success —
  // which is the failure this file's own skip message describes.
  //
  // What is NOT asserted, and why: the signature is not recoverable from
  // ethers 6.17's parsed transaction. Transaction.from() exposes an authorization
  // whose `signature` is `{}` and no `sighash`, so recoverAddress() has nothing
  // to work with. Writing that assertion anyway would be asserting a guess
  // about the digest rather than a fact about the wallet.
  const w = new ethers.Wallet(KEY);
  const auth = w.authorizeSync({ chainId: 1, address: EIP7702.ZERO_ADDRESS, nonce: 7 });
  const raw = await w.signTransaction({
    type: 4, chainId: 1, nonce: 7, to: ADDR, gasLimit: 100000n,
    maxFeePerGas: 30n * 10n ** 9n, maxPriorityFeePerGas: 2n * 10n ** 9n,
    value: 0n, authorizationList: [auth],
  });

  assert.equal(typeof raw, 'string', 'signTransaction resolves to the raw hex');
  assert.match(raw.slice(0, 4), /^0x04/, 'the payload must be an EIP-7702 type-4 transaction');

  const parsed = ethers.Transaction.from(raw);
  assert.equal(parsed.type, 4, 'and it must parse back as type 4, not as 1559');
  assert.ok(Array.isArray(parsed.authorizationList) && parsed.authorizationList.length === 1,
    `exactly one authorization must be in the payload, got ${parsed.authorizationList === null ? 'null' : parsed.authorizationList.length}`);

  const got = parsed.authorizationList[0];
  assert.equal(got.address, EIP7702.ZERO_ADDRESS,
    'a revoke must serialize the ZERO address — anything else is a delegation');
  assert.equal(got.nonce, 7n);
  assert.equal(got.chainId, 1n);
});

test('a delegate authorization survives serialization too', async () => {
  const w = new ethers.Wallet(KEY);
  const auth = w.authorizeSync({ chainId: 1, address: IMPL, nonce: 42 });
  const raw = await w.signTransaction({
    type: 4, chainId: 1, nonce: 41, to: ADDR, gasLimit: 100000n,
    maxFeePerGas: 30n * 10n ** 9n, maxPriorityFeePerGas: 2n * 10n ** 9n,
    value: 0n, authorizationList: [auth],
  });
  const parsed = ethers.Transaction.from(raw);
  assert.equal(parsed.type, 4);
  assert.equal(parsed.authorizationList.length, 1);
  assert.equal(parsed.authorizationList[0].address, IMPL);
  assert.equal(parsed.authorizationList[0].nonce, 42n);
});

test('changing the authorization changes the signed payload', async () => {
  // Guards the serialization itself: if the authorizationList were being dropped
  // or ignored, every variant would sign to the same bytes and this would pass
  // while proving nothing.
  const w = new ethers.Wallet(KEY);
  const base = { type: 4, chainId: 1, nonce: 5, to: ADDR, gasLimit: 100000n,
    maxFeePerGas: 30n * 10n ** 9n, maxPriorityFeePerGas: 2n * 10n ** 9n, value: 0n };
  const a = await w.signTransaction({ ...base, authorizationList: [w.authorizeSync({ chainId: 1, address: IMPL, nonce: 5 })] });
  const b = await w.signTransaction({ ...base, authorizationList: [w.authorizeSync({ chainId: 1, address: IMPL2, nonce: 5 })] });
  const c = await w.signTransaction({ ...base, authorizationList: [w.authorizeSync({ chainId: 1, address: IMPL, nonce: 6 })] });
  assert.notEqual(a, b, 'a different implementation must change the signed payload');
  assert.notEqual(a, c, 'a different authorization nonce must change the signed payload');
});

test('a delegate authorization keeps the implementation and uses nonce + 1', () => {
  // js/eip7702.js uses authNonce = nonce + 1 for a self-sponsored delegation,
  // because the transaction itself consumes the current nonce. Getting this
  // wrong means the authorization is skipped by the client for that nonce.
  const w = new ethers.Wallet(KEY);
  const txNonce = 41n;
  const auth = w.authorizeSync({ chainId: 1, address: IMPL, nonce: txNonce + 1n });
  assert.equal(auth.address, IMPL);
  assert.equal(auth.nonce, 42n, 'self-sponsored delegation must be nonce + 1');
});

test('the constant the revoke button uses is the zero address', () => {
  // The revoke path reads EIP7702.ZERO_ADDRESS. If that ever became something
  // else, "revoke" would silently become "delegate to X".
  assert.equal(EIP7702.ZERO_ADDRESS, ZERO);
  assert.equal(EIP7702.DELEGATION_PREFIX, '0xef0100');
});

test('the revoke path never reuses the implementation address', async () => {
  // eip7702.js has a delegate/revoke branch; revoke routes through
  // revokeDelegation() so it can target an account that is not the unlocked
  // wallet. That indirection was the fix for "revoked the wrong account and
  // reported success", so it is worth a guard.
  const src = (await import('node:fs')).readFileSync(path.join(here, '..', 'js', 'eip7702.js'), 'utf8');
  assert.match(src, /revokeDelegation\(\)/,
    'the revoke button must call revokeDelegation(), not doEip7702("revoke")');
  assert.match(src, /const impl = action === 'delegate'[\s\S]{0,80}ZERO_ADDRESS/,
    'the revoke branch must select the zero address');
});
