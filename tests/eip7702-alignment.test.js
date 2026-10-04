// Flow alignment with the reference (nemoobc/EIP-7702-TOOL), user decisions
// 2026-10-03: batch = 3 separate transactions with a value guard; claim =
// ERC-20 token mandatory + claimAndForwardMin minimum on-chain + target key +
// before/after result; rescue = ERC-20 amount manual/MAX with a balance guard;
// revoke = sponsor always broadcasts (self-sponsor path removed, +1 nonce only
// when sponsor == target). Deploy-helper activity must carry the tx hash.
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => readFileSync(path.join(root, p), 'utf8');

const toolsSrc = src('js/eip7702-tools.js');
const jsx = src('src/views/deploy.jsx');

// Function window: from its declaration to the next async function. ('async'
// matters: ABI literals like 'function decimals() view returns (uint8)' would
// truncate the window mid-body.)
function fn(name) {
  const i = toolsSrc.indexOf(`function ${name}(`);
  assert.ok(i > -1, `${name}() must exist in eip7702-tools.js`);
  const j = toolsSrc.indexOf('async function ', i + 10);
  return toolsSrc.slice(i, j > -1 ? j : i + 14000);
}

// ── claim ──────────────────────────────────────────────────────
test('T1: claimer source gains claimAndForwardMin and the flow encodes it', () => {
  assert.match(toolsSrc, /function claimAndForwardMin\(address airdropContract, bytes calldata claimData, address token, address safe, uint256 minAmount\)/,
    'CLAIMER_SOURCE must contain the v1.2.0 minimum variant');
  const claim = fn('executeClaim');
  assert.match(claim, /encodeFunctionData\('claimAndForwardMin'/, 'flow encodes the minimum variant');
  assert.match(claim, /abiHasName\(item\.abi, 'claimAndForwardMin'\)/,
    'reuse predicate refuses old helpers whose ABI lacks the minimum variant');
});

test('T2: claim token is mandatory — empty and address(0) both rejected', () => {
  const claim = fn('executeClaim');
  assert.match(claim, /isValidAddress\(tokenAddr\)/, 'token address is validated');
  assert.match(claim, /ZeroAddress/, 'address(0) is explicitly refused');
  assert.ok(!/tokenAddr \|\| ethers\.ZeroAddress/.test(claim), 'the ETH-default fallback is gone');
  assert.match(claim, /Token contract is required|token.*required/i, 'empty token rejected with a message');
});

test('T3: claim amount required and greater than zero', () => {
  const claim = fn('executeClaim');
  assert.match(claim, /#claimAmount/, 'reads the minimum-amount field');
  assert.match(claim, /greater than zero/i, 'zero/empty amount rejected');
  assert.match(claim, /parseUnits\(/, 'amount interpreted with the token decimals');
});

test('T10: claim accepts the target private key like rescue', () => {
  assert.match(jsx, /id="claimTargetKey"/, 'field exists in the view');
  const claim = fn('executeClaim');
  assert.match(claim, /#claimTargetKey/, 'flow reads it');
  assert.match(claim, /targetSigner/, 'authorization is signed by the target');
});

test('T11: claim shows before/after token balances', () => {
  assert.match(jsx, /id="claimResult"/, 'result box exists in the view');
  const claim = fn('executeClaim');
  assert.match(claim, /claimResult/, 'flow writes the result box');
  assert.match(claim, /safeBefore/, 'balance before the claim is captured');
  assert.match(claim, /safeAfter/, 'balance after the claim is re-read');
});

// ── rescue ─────────────────────────────────────────────────────
test('T4: rescue ERC-20 uses an explicit amount (manual or MAX)', () => {
  const rescue = fn('executeRescue');
  assert.match(jsx, /id="rescueAmount"/, 'amount field exists');
  assert.match(jsx, /id="btnRescueMax"/, 'MAX button exists');
  assert.match(rescue, /#rescueAmount/, 'flow reads the amount');
  assert.match(rescue, /encodeFunctionData\('rescueERC20'/, 'encodes rescueERC20(token, amount) — not the all-sweep');
  assert.match(toolsSrc, /btnRescueMax/, 'MAX button is wired');
  assert.match(rescue, /'MAX'|=== 'MAX'/i, 'MAX sentinel fills the full balance');
});

test('T5: rescue amount above the wallet balance is refused BEFORE the confirm prompt', () => {
  const rescue = fn('executeRescue');
  const guardIdx = rescue.search(/exceeds|leaves the wallet|greater than the/i);
  const confirmIdx = rescue.indexOf('confirmTx');
  assert.ok(guardIdx > -1, 'a balance guard exists');
  assert.ok(confirmIdx > -1, 'confirmTx exists');
  assert.ok(guardIdx < confirmIdx, 'the guard must run before the user confirms');
  assert.match(rescue, /balanceOf/, 'the guard reads the on-chain balance');
});

// ── batch ──────────────────────────────────────────────────────
test('T6: batch guards total value against the balance before the confirm prompt', () => {
  const batch = fn('executeBatch');
  assert.match(batch, /getBalance/, 'reads the balance');
  const guardIdx = batch.search(/totalValue/);
  const confirmIdx = batch.indexOf('confirmTx');
  assert.ok(guardIdx > -1 && confirmIdx > -1, 'both exist');
  assert.ok(guardIdx < confirmIdx, 'the value guard runs before the confirm prompt');
  assert.match(batch, /insufficient|exceeds|more than/i, 'refusal has a message');
});

test('T7: batch calldata defaults to 0x; empty data no longer drops the row', () => {
  const batch = fn('executeBatch');
  assert.match(batch, /filter\(b => b\.to\)/, 'rows with value only (empty data) stay valid');
  assert.match(batch, /Invalid hex calldata|valid hex/i, 'non-hex data is refused loudly, not silently zeroed');
  assert.match(batch, /'0x'/, 'empty data defaults to 0x');
});

test('T13: batch runs helper → delegate-only → execute as separate transactions', () => {
  const batch = fn('executeBatch');
  assert.match(batch, /delegateAndExecute\([\s\S]{0,200}?,\s*'0x',\s*\{/,
    'a delegate-only transaction is sent first (calldata 0x)');
  const waits = batch.match(/waitForReceipt\(/g) || [];
  assert.strictEqual(waits.length, 2, 'delegate receipt and execute receipt are each awaited');
  assert.match(batch, /needsDelegate|already delegated|currentDelegate/i, 'delegation is checked, skipped when fresh');
  assert.ok(!/data: b\.data\.startsWith/.test(batch), 'the old atomic single-tx encoding is gone');
});

// ── revoke ─────────────────────────────────────────────────────
test('T8: revoke always has a sponsor — sender is the sponsor, nonce raw unless self', () => {
  const revoke = fn('revokeDelegation');
  assert.match(revoke, /#revokeSponsorFrom/, 'sponsor picker is read');
  assert.match(revoke, /sponsorSigner\.sendTransaction/, 'sponsor broadcasts');
  assert.match(revoke, /targetSigner\.authorizeSync/, 'target signs the authorization');
  assert.match(revoke, /selfSponsor \? nonce \+ 1 : nonce|authNonce/, 'nonce rule encoded');
  assert.match(revoke, /type: 4/, 'type-4 stays explicit');
  assert.match(jsx, /id="revokeSponsorFrom"/, 'sponsor select exists in the view');
  assert.match(toolsSrc, /revokeSponsorFrom/, 'renderSponsorPickers covers the revoke picker');
});

test('T9: revoke still verifies the chain state after the receipt', () => {
  const revoke = fn('revokeDelegation');
  assert.match(revoke, /stillDelegated/, 'post-receipt delegation read');
  assert.match(revoke, /STILL ACTIVE/, 'mined-but-not-applied is reported honestly');
  assert.match(revoke, /requireUnlock|get\('unlocked'\)|Unlock|wallet is locked|active wallet/i, 'target key rules kept');
});

// ── activity hashes ─────────────────────────────────────────────
test('T12: every deploy-helper activity entry carries the deployment tx hash', () => {
  const all = [...toolsSrc.matchAll(/addActivity\((\{[^}]*'deploy-helper'[^}]*\})/g)];
  const total = (toolsSrc.match(/'deploy-helper'/g) || []).length;
  assert.ok(total >= 6, `expected the six helper-deploy sites, found ${total}`);
  assert.strictEqual(all.length, total, 'every deploy-helper entry goes through addActivity');
  for (const m of all) assert.match(m[1], /hash:/, `entry without hash: ${m[1]}`);
});

// ── view copy ──────────────────────────────────────────────────
test('T14: batch card no longer claims a single atomic transaction', () => {
  assert.ok(!/\(atomic\)/.test(jsx), 'the (atomic) label is gone');
  assert.match(jsx, /delegate/i, 'the card explains the delegate step');
});
