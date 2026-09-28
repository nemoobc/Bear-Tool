// Bear Tool — OpenSea eligibility verdicts
//
// The whitelist feature answers a question with real consequences: may this
// address mint? Two of its answers have to be distinguishable from each other,
// and one of them was not.
//
// OpenSea answers 200 with an EMPTY list from the holders endpoint for a slug
// that does not exist, while the collection endpoint for the same slug answers
// 404. Measured 2026-09-27:
//
//   GET /api/v2/collections/zz-not-real-qq99          -> 404
//   GET /api/v2/collections/zz-not-real-qq99/holders  -> 200 {"holders": [], "next": null}
//
// So "this address is not a holder" and "there is no such collection" arrived as
// the same string: "Not among the 0 recorded holders." A user reading that about
// a mistyped slug concludes the collection is real and they are simply not on
// the list — which is a different situation, with a different next action, and it
// is not what happened.
//
// These are unit tests over the decision, not over the network. The live
// behaviour is covered by the browser run; what is locked here is that the
// distinction is made at all, so a future simplification of this file cannot
// quietly collapse the two cases back into one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, '..', 'js', 'nft-intel.js'), 'utf8');

test('a zero-holder result is checked against the collection before reporting', () => {
  // The distinction is the whole point, so it is asserted structurally: the
  // zero-holder path must ask whether the collection exists.
  assert.match(src, /scanned === 0 && !truncated/,
    'the zero-holder case must be identified explicitly');
  assert.match(src, /evidence: 'collection-missing'/,
    'and must be able to say the collection is missing, as distinct from empty');
});

test('a missing collection is reported as missing, not as an empty holder list', () => {
  assert.match(src, /OpenSea has no collection called/,
    'the user must be told the collection does not exist');
  // The empty-holder wording still exists — it is correct for a collection that
  // is real and simply has no such holder — so its presence proves nothing. What
  // matters is ORDER: the missing-collection return has to come first, or a slug
  // that does not exist would fall through to it.
  const checkAt = src.indexOf('scanned === 0 && !truncated');
  const missingAt = src.indexOf("evidence: 'collection-missing'");
  const emptyWordingAt = src.indexOf('Not among the ${scanned}');
  assert.ok(checkAt > 0 && missingAt > checkAt,
    'the existence check must return its own verdict');
  assert.ok(emptyWordingAt > missingAt,
    'the empty-holder verdict must come after the existence check, not before it');
});

test('the truncation caveat still applies to a real collection', () => {
  // Two different "you are not on the list" answers: a bounded scan that ran out
  // of pages, and a complete scan that finished. Collapsing them would tell a
  // user their absence from the first 400 entries is proof.
  assert.match(src, /Not in the first \$\{scanned\} holders scanned/,
    'the capped-scan caveat must survive');
  assert.match(src, /not a proof of absence/,
    'and it must say so in words, not imply it');
});

test('a holder is reported with its quantity, and without claiming it is the allowlist', () => {
  // What a holders list proves is on-chain ownership. It is NOT the project's
  // private mint allowlist, which is not publicly readable — and telling a user
  // otherwise sends them to wait for a mint they may already qualify for.
  assert.match(src, /holds: hit\.quantity \?\? 1/);
  assert.match(src, /NOT the project’s private mint allowlist/,
    'the allowlist distinction must be stated');
  // The note is built from concatenated string literals, so the words are split
  // across a quote and a `+`. Match the words themselves rather than the
  // layout — the first version of this assertion tried to span the seam and
  // failed for a reason that had nothing to do with the code.
  assert.match(src, /recorded holder of the collection/,
    'it must say the address is a recorded holder');
  assert.match(src, /on-chain ownership/,
    'and name the evidence as on-chain ownership');
  assert.match(src, /NOT the project’s private mint allowlist/,
    'while saying it is not the project allowlist');
});

test('an invalid address is rejected before any request', () => {
  assert.match(src, /Enter a wallet address to check/,
    'a malformed address must be caught locally');
  assert.match(src, /if \(!address \|\| !\/\^0x\[0-9a-fA-F\]\{40\}\$\/\.test\(address\)\)/,
    'and the check must be the real address shape');
});

test('a missing key and a rejected key are different problems, with different codes', () => {
  // Both surface as a failure, but they are not the same problem and the user
  // cannot act on one by doing the other.
  assert.match(src, /OPENSEA_NO_KEY/, 'no key at all');
  assert.match(src, /OPENSEA_BAD_KEY/, 'a key OpenSea refused');
  assert.doesNotMatch(src, /OPENSEA_BAD_KEY[\s\S]{0,80}API key required/,
    'the two must not share one message');
});
