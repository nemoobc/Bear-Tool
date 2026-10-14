// ═════════════════════════════════════════════════════════.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  canDerive, botStartIndex, deriveBotWallets, splitBudget, tradeableWallets,
} from '../js/dex/bot-wallets.js';

const PHRASE = 'test test test test test test test test test test test junk';
const Q = (n) => BigInt(Math.round(n * 1e18));
globalThis.ethers = (await import('ethers')).ethers;

// ── a private key can make exactly one address, and must say so ────
test('a seed phrase can derive; a bare private key cannot', () => {
  assert.equal(canDerive(PHRASE), true);
  assert.equal(canDerive('0x' + 'a'.repeat(64)), false);
  assert.equal(canDerive(''), false);
  assert.equal(canDerive(null), false);
  assert.equal(canDerive('two words'), false);
});

// ── addresses must never collide with the user's own accounts ──────
test('bot addresses start past every account the user already has', () => {
  // Deriving into an occupied slot would hand the bot the key of an account the
  // user is also spending from — two signers, one address, and no way to tell
  // whose transaction is whose.
  assert.equal(botStartIndex([{ path: "m/44'/60'/0'/0/0" }]), 1);
  assert.equal(botStartIndex([{ path: "m/44'/60'/0'/0/7" }, { path: "m/44'/60'/0'/0/2" }]), 8);
  assert.equal(botStartIndex([{ path: 'imported' }]), 0, 'an imported account has no slot');
  assert.equal(botStartIndex([]), 0);
  assert.equal(botStartIndex(null), 0);
});

// ── derivation is deterministic, distinct, and private ─────────────
test('derived addresses are distinct, stable, and never the seed account', () => {
  const a = deriveBotWallets(PHRASE, 5, 4);
  const b = deriveBotWallets(PHRASE, 5, 4);

  const addrs = a.map((w) => w.address);
  assert.equal(new Set(addrs).size, 4, 'every derived address must differ');
  assert.deepEqual(addrs, b.map((w) => w.address), 'the same seed must give the same addresses');
  assert.match(addrs[0], /^0x[0-9a-fA-F]{40}$/, 'addresses must be real addresses');

  // Slot 0 is the account the app itself opens. If the bot derived from 0 it
  // would be spending the user's main wallet.
  const zero = deriveBotWallets(PHRASE, 0, 1)[0].address;
  assert.ok(!addrs.includes(zero), 'the bot must never derive the main account');
});

test('each derived wallet can actually sign', async () => {
  const [w] = deriveBotWallets(PHRASE, 5, 1);
  // signMessage is what a real transaction ends up doing, and it hashes for us —
  // SigningKey.sign wants a 32-byte digest, not a string.
  const sig = await w.signer.signMessage('hello');
  assert.equal(typeof sig, 'string');
  assert.ok(sig.length > 40, 'a real signature, not a stub');
  assert.equal(w.signer.address, w.address, 'the signer must match the address it claims');
});

test('a private key is refused loudly instead of yielding the same wallet twice', () => {
  assert.throws(() => deriveBotWallets('0x' + 'b'.repeat(64), 0, 3), /seedRequired/);
});

// ── the budget split ────────────────────────────────────────────────
test('the split hands out the whole budget, to the wei', () => {
  const shares = splitBudget(Q(100), 4);
  assert.equal(shares.length, 4);
  assert.equal(shares.reduce((a, b) => a + b, 0n), Q(100), 'no coin may vanish in the split');
});

test('each wallet keeps gas money, and the shortfall goes to the first', () => {
  // Without a pad the last wallet receives exactly its share and then cannot
  // send anything: gas and trading come out of the same coins.
  const shares = splitBudget(Q(100), 4, Q(1));
  assert.equal(shares.reduce((a, b) => a + b, 0n), Q(100), 'the total must still be exact');
  assert.ok(shares.slice(1).every((s) => s === Q(24)), 'each wallet gives up the gas pad');
  assert.equal(shares[0], Q(100) - Q(24) * 3n, 'the first wallet absorbs what the others gave back');
});

test('a budget too small to pad is not split into untradeable crumbs', () => {
  const shares = splitBudget(Q(1), 4, Q(1));
  assert.ok(shares.every((s) => s >= 0n));
  assert.equal(shares.reduce((a, b) => a + b, 0n), Q(1), 'and still adds up');
  assert.equal(splitBudget(Q(1), 0, Q(1)).length, 0);
});

test('an unpadded split is even, and the rounding remainder is not lost', () => {
  // 10 does not divide by 3. Floor everywhere would leave a wei behind that no
  // wallet could ever trade — small enough to be invisible, and exactly the kind
  // of dust that makes a balance look wrong.
  const shares = splitBudget(Q(10), 3);
  const each = Q(10) / 3n;
  assert.deepEqual(shares, [each + 1n, each, each], 'the remainder goes to the first wallet');
  assert.equal(shares.reduce((a, b) => a + b, 0n), Q(10));
});

// ── wallets that cannot trade are filtered out ─────────────────────
test('wallets that cannot afford a trade are left out', () => {
  const wallets = [{ address: 'a' }, { address: 'b' }, { address: 'c' }];
  const balances = { a: { quote: Q(5), token: 0n }, b: { quote: 0n, token: 0n }, c: { quote: Q(0.5), token: Q(9) } };
  const usable = tradeableWallets(wallets, balances, Q(1), Q(1));
  assert.deepEqual(usable.map((w) => w.address), ['a', 'c']);
});

test('an empty balance map is not an error', () => {
  assert.deepEqual(tradeableWallets([{ address: 'a' }], {}, 0n, 0n).map((w) => w.address), ['a']);
  assert.deepEqual(tradeableWallets(null, null, 1n, 1n), []);
});

// ── the module must not touch the network ──────────────────────────
test('deriving addresses is local key maths, never a network call', () => {
  const src = readFileSync(new URL('../js/dex/bot-wallets.js', import.meta.url), 'utf8');
  for (const forbidden of ['fetch(', 'provider', 'JsonRpcProvider', 'sendTransaction', 'localStorage']) {
    assert.ok(!src.includes(forbidden), `wallet derivation must never mention ${forbidden}`);
  }
});