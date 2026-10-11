// A receive address is not always the whole deposit instruction, and the
// difference between "sent" and "credited" is often one small field.
//
// XRP: most exchanges require a DestinationTag next to the address. Send
// without it (or with a tag that changed since yesterday) and the deposit is
// routinely uncredited — the money still exists, but nobody can claim it.
// That makes TWO properties non-negotiable, and both are asserted here:
//   1. the tag is CORRECT — derived from the account, reproducible;
//   2. the tag is STABLE — identical on every call, forever.
// Bitcoin: there is no memo on-chain; BIP-21 carries amount/label instead.
// Solana: no destination tag exists. A memo is exposed but must never be
//   dressed up as mandatory, because on Solana it usually isn't.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nonEvmAddresses, xrpDestinationTag, xrpAddresses,
  btcPaymentUri, xrpPaymentUri, solanaMemoUri,
} from '../js/coin-trees.js';

const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

test('an XRP destination tag exists, is a real uint32, and is never zero', () => {
  const tag = xrpDestinationTag(SEED, 0);
  assert.ok(Number.isInteger(tag), 'a tag is an integer');
  assert.ok(tag >= 1 && tag <= 0xffffffff, `uint32 range, got ${tag}`);
  assert.notEqual(tag, 0, '0 is the wire value for "no tag" and some exchanges reject it');
});

test('the XRP tag is STABLE — the same account shows the same tag every single time', () => {
  // This is the property that actually protects money. A tag generated from a
  // timestamp, a counter, or anything that moves between sessions turns every
  // deposit made after the first into an orphan.
  const first = xrpDestinationTag(SEED, 0);
  for (let i = 0; i < 5; i += 1) {
    assert.equal(xrpDestinationTag(SEED, 0), first, `call ${i + 1} produced a different tag`);
  }
  // …and it survives the address being re-derived from scratch.
  assert.equal(xrpDestinationTag(SEED, 0), first);
});

test('different accounts get different tags', () => {
  const tags = new Set([0, 1, 2, 3].map((i) => xrpDestinationTag(SEED, i)));
  assert.equal(tags.size, 4, 'account N must not share account M\'s tag');
});

test('the tag is bound to the ACCOUNT, not the seed alone', () => {
  // Two different seeds reaching the same account index must not collide; if
  // the tag were derived from the phrase without the account in it, two
  // wallets would present the same tag and an exchange would confuse deposits.
  const other = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
  assert.notEqual(xrpDestinationTag(SEED, 0), xrpDestinationTag(other, 0));
});

test('the tag travels with the address in the same call — they can never disagree', () => {
  const row = nonEvmAddresses(SEED, 0);
  assert.equal(row.xrp.destinationTag, xrpDestinationTag(SEED, 0));
  // If these two ever came from different derivations, the printed pair would
  // be a valid-looking combination that belongs to nobody.
  assert.match(row.xrp.receive, /^r/, 'address is an r… string');
  assert.ok(Number.isInteger(row.xrp.destinationTag));
});

test('non-EVM chains that need no tag are not given one', () => {
  const row = nonEvmAddresses(SEED, 0);
  // Bitcoin has no memo and Solana has no destination tag. Inventing one and
  // printing it would be a small lie that users paste into exchange forms.
  assert.equal(row.bitcoin.destinationTag, undefined);
  assert.equal(row.solana.destinationTag, undefined);
  assert.equal(row.solana.memo, undefined);
});

test('BIP-21 builds a bitcoin: URI with a decimal amount, never satoshis', () => {
  const addr = nonEvmAddresses(SEED, 0).bitcoin.receive;
  const uri = btcPaymentUri({ address: addr, amount: 0.001, label: 'Bear Wallet' });
  assert.ok(uri.startsWith('bitcoin:' + addr), 'starts with the address');
  assert.match(uri, /amount=0\.001(&|$)/, 'amount is decimal BTC');
  assert.doesNotMatch(uri, /amount=1000000/, 'NOT satoshis — that is 1e6× too much');
  assert.match(uri, /label=Bear%20Wallet/, 'label is percent-encoded');
});

test('BIP-21 encodes a label that would otherwise split the URI', () => {
  const addr = nonEvmAddresses(SEED, 0).bitcoin.receive;
  // An unescaped "&" or "#" in a label silently truncates the request into a
  // different (wrong) payment — the kind of bug nobody sees until it is paid.
  const uri = btcPaymentUri({ address: addr, amount: 1, label: 'a&b=c?d#e' });
  const query = uri.slice(uri.indexOf('?') + 1);
  const params = query.split('&');
  assert.equal(params.length, 2, `expected exactly amount + label, got: ${query}`);
  assert.ok(params.every((p) => !p.includes('#')), 'no raw # in the query');
  assert.ok(decodeURIComponent(params[1]).includes('a&b=c?d#e'), 'the label round-trips');
});

test('BIP-21 with no amount is still a valid request', () => {
  const addr = nonEvmAddresses(SEED, 0).bitcoin.receive;
  assert.equal(btcPaymentUri({ address: addr }), 'bitcoin:' + addr);
  assert.equal(btcPaymentUri({ address: addr, amount: '' }), 'bitcoin:' + addr);
});

test('BIP-21 refuses a nonsensical amount rather than encoding it', () => {
  const addr = nonEvmAddresses(SEED, 0).bitcoin.receive;
  assert.throws(() => btcPaymentUri({ address: addr, amount: 0 }), /positive/);
  assert.throws(() => btcPaymentUri({ address: addr, amount: -1 }), /positive/);
  assert.throws(() => btcPaymentUri({ address: addr, amount: 'abc' }), /positive/);
});

test('the xrpl: URI carries the tag, and rejects an out-of-range one', () => {
  const { classic } = xrpAddresses(SEED, 0);
  const tag = xrpDestinationTag(SEED, 0);
  const uri = xrpPaymentUri({ address: classic, tag });
  assert.ok(uri.startsWith('xrpl:' + classic));
  assert.match(uri, new RegExp(`\\?dt=${tag}$`), 'the tag is in the URI');

  assert.throws(() => xrpPaymentUri({ address: classic, tag: -1 }), /uint32/);
  assert.throws(() => xrpPaymentUri({ address: classic, tag: 4294967296 }), /uint32/);
  assert.throws(() => xrpPaymentUri({ address: classic, tag: 1.5 }), /uint32/);
});

test('an xrpl: URI with no tag is legal — the tag is optional on the wire', () => {
  const { classic } = xrpAddresses(SEED, 0);
  assert.equal(xrpPaymentUri({ address: classic }), 'xrpl:' + classic);
});

test('a solana memo URI adds a memo only when there is one', () => {
  const addr = nonEvmAddresses(SEED, 0).solana.receive;
  assert.equal(solanaMemoUri({ address: addr }), 'solana:' + addr);
  assert.equal(solanaMemoUri({ address: addr, memo: 'order 42' }), 'solana:' + addr + '?memo=order%2042');
});

test('every URI builder refuses to build one without an address', () => {
  for (const fn of [btcPaymentUri, xrpPaymentUri, solanaMemoUri]) {
    assert.throws(() => fn({}), /address required/, `${fn.name} must not emit an address-less URI`);
  }
});