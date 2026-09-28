// Bear Tool — nft-intel-safety.test.js
// The on-chain safety signals, and what the honeypot check can actually know.
//
// contractSafety() simulates a sale to answer "can this wallet transfer an NFT
// out?" — a contract that mints happily but blocks sells is the classic trap.
// The simulation it runs is:
//
//     transferFrom(0x…dEaD, 0x…dEaD, 0)   from = 0x…dEaD
//
// That address owns nothing in any real collection, so ERC-721's
// _isApprovedOrOwner fails and the call reverts — for an honest contract and for
// a honeypot alike. The signal therefore comes out the same every time: a `warn`
// whose text says "That can be a honeypot", and a verdict of `caution`.
//
// So the check has no power to tell the two apart, and every collection in the
// app reads as suspicious. A warning that is always on is not a finding; it is
// noise the user learns to ignore, and it is worse than saying nothing because
// it looks like evidence.
//
// What it CAN honestly say: the transfer could not be simulated because the test
// address holds no token. That is a limitation of the check, and it has to be
// reported as one.
import { test } from 'node:test';
import assert from 'node:assert/strict';

if (!globalThis.localStorage) {
  const store = new Map();
  globalThis.localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  };
}
globalThis.document ??= {
  querySelector: () => null, querySelectorAll: () => [],
  addEventListener() {}, body: { style: {}, appendChild() {} },
};
globalThis.window ??= { addEventListener() {} };
globalThis.matchMedia ??= () => ({ matches: false });
if (!globalThis.ethers) {
  const { ethers } = await import('ethers');
  globalThis.ethers = ethers;
}

const { contractSafety } = await import('../js/nft-intel.js');

const CONTRACT = '0x1111111111111111111111111111111111111111';
const SEL_OWNER = '0x8da5cb5b';
const SEL_PAUSED = '0x5c975abb';
const SEL_SUPPLY = '0x18160ddd';
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const ZERO32 = '0x' + '0'.repeat(64);

// A provider that answers only what the named handler knows, and reverts on
// everything else — which is what a real node does for a selector a contract
// does not implement.
function providerWith({ transfer }) {
  return {
    async call({ data }) {
      if (data === SEL_OWNER) return ZERO32;          // owner renounced
      if (data === SEL_SUPPLY) return '0x' + (1000).toString(16);
      if (data === SEL_PAUSED) throw new Error('execution reverted');   // not pausable
      if (data === IMPL_SLOT) throw new Error('execution reverted');   // not a 1967 proxy
      if (typeof data === 'string' && data.startsWith('0x23b872dd')) {
        // transferFrom(address,address,uint256) — selector 0x23b872dd
        if (transfer === 'ok') return '0x';
        throw new Error(transfer);
      }
      throw new Error('execution reverted');
    },
  };
}

const HOLDER = '0x2222222222222222222222222222222222222222';
const intel = { owner: HOLDER, tokenId: '7' };

const signalText = (r) => r.signals.map(s => `${s.level}: ${s.label} — ${s.detail}`).join(' || ');

test('a contract that blocks every sale is reported, not passed', async () => {
  const r = await contractSafety(providerWith({ transfer: 'execution reverted: TRANSFERS_BLOCKED' }), CONTRACT);
  assert.ok(r.signals.length, 'signals must be produced');
  assert.notEqual(r.verdict, 'no-red-flags', 'a blocking contract must not read as clean');
});

test('a contract whose transfer cannot be simulated is NOT called a honeypot', async () => {
  // The test address owns no token, so the revert says nothing about the
  // contract. Claiming "that can be a honeypot" from this revert is inventing a
  // finding, and it fires on every collection in the app.
  const r = await contractSafety(
    providerWith({ transfer: 'execution reverted: ERC721: caller is not token owner or approved' }),
    CONTRACT,
  );
  const text = signalText(r).toLowerCase();
  assert.ok(!text.includes('honeypot'),
    `an undecidable transfer simulation was reported as honeypot risk: ${signalText(r)}`);
});

test('an undecidable transfer is reported as a limit of the check', async () => {
  const r = await contractSafety(
    providerWith({ transfer: 'execution reverted: ERC721: caller is not token owner or approved' }),
    CONTRACT,
  );
  const s = r.signals.find(x => /transfer/i.test(x.label));
  assert.ok(s, 'the transfer signal must still be shown — silence would hide the gap');
  assert.match(s.detail, /own|no token|hold|not judge|cannot|simulat/i,
    `the signal must say why it could not judge, and what that means: ${s && s.detail}`);
});

test('with a holder, a normal contract and a trap are told apart', async () => {
  // This is the whole point of the check, and it is only possible from an
  // address that owns the token. Compared without a holder, the two look
  // identical — which is exactly why the old wording claimed a honeypot on both.
  const normal = await contractSafety(providerWith({ transfer: 'ok' }), CONTRACT, { intel });
  const trap = await contractSafety(
    providerWith({ transfer: 'execution reverted: TRANSFERS_BLOCKED' }), CONTRACT, { intel });
  assert.notEqual(signalText(normal), signalText(trap),
    'a working sale and a blocked sale must not produce the same signal');
  assert.notEqual(normal.verdict, trap.verdict,
    `the verdict must move with the evidence: normal=${normal.verdict} trap=${trap.verdict}`);
});

test('a contract that lets the simulated transfer through is not warned about', async () => {
  // With a holder: the check can actually run, and a success is a pass.
  const r = await contractSafety(providerWith({ transfer: 'ok' }), CONTRACT, { intel: { owner: HOLDER, tokenId: '7' } });
  const t = r.signals.find(x => /transfer/i.test(x.label));
  assert.equal(t.level, 'pass', `a successful simulation must pass: ${t && t.detail}`);
  assert.equal(r.verdict, 'no-red-flags',
    `with nothing but renounced ownership and a working transfer, the verdict is ${r.verdict}`);
});

// nftIntel() already returns the holder of a specific token (`owner`, `tokenId`).
// A honeypot check is only possible from an address that actually owns something:
// the earlier test address owned nothing, so its revert was about the test, not
// the contract. With a real holder the same simulation becomes a real question.

test('with a known holder, an honest contract simulates a sale and passes', async () => {
  const r = await contractSafety(providerWith({ transfer: 'ok' }), CONTRACT, { intel });
  const t = r.signals.find(x => /transfer/i.test(x.label));
  assert.equal(t.level, 'pass', `a sale simulated from the real holder must pass: ${t && t.detail}`);
  assert.match(t.detail, new RegExp(HOLDER.slice(2, 10), 'i'),
    'the signal must name the holder it simulated from, so the claim can be checked');
});

test('with a known holder, a contract that blocks the sale is a real finding', async () => {
  const r = await contractSafety(
    providerWith({ transfer: 'execution reverted: TRANSFERS_BLOCKED' }), CONTRACT, { intel });
  const t = r.signals.find(x => /transfer/i.test(x.label));
  assert.equal(t.level, 'warn', `a blocked sale from a real holder is a finding: ${t && t.detail}`);
  assert.match(t.detail, /block|sold|honeypot|transfer/i);
});

test('without a holder, the check reports its own limit and claims nothing', async () => {
  const r = await contractSafety(
    providerWith({ transfer: 'execution reverted: TRANSFERS_BLOCKED' }), CONTRACT, { intel: { tokenId: '7' } });
  const text = signalText(r).toLowerCase();
  assert.ok(!text.includes('honeypot'),
    `with no holder there is no evidence of a honeypot, and the app must not imply one: ${signalText(r)}`);
});
