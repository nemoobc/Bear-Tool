// Bear Tool — opensea-collection-flow.test.js
//
// The reported bug: "claim airdrop bug opensea collection". The collection
// side of that screen (Deploy view → OpenSea panel) had four independent
// breaks, each measured against live endpoints or the official OpenSea
// OpenAPI spec (api.opensea.io/api/v2/openapi.json, fetched 2026-11-09):
//
//  1. CHAIN: app.js read `net?.chain` — a field no network object has — so
//     every lookup silently ran on 'ethereum'. A Polygon contract was resolved
//     against Ethereum's index and failed as "not indexed".
//  2. WRAPPER: GET /chain/{chain}/contract/{addr}/nfts/{id} returns
//     { nft: … } per the spec. resolveSlug/nftIntel read `collection` off the
//     WRAPPER, so every contract/asset input threw "does not index that
//     contract" and nftIntel could only ever return nulls.
//  3. ASK: collectionAsk fetched the OFFERS endpoint (collection-wide BIDS)
//     and read `price.amount` — a field that does not exist (the payload has
//     price.value in base units). Every row filtered out → the "Lowest ask /
//     floor" row showed 0 no matter what.
//  4. OFFERS: getOffers called /orders/offers?asset_contract_address=… —
//     removed upstream, live-verified HTTP 404 on 2026-11-09 — and swallowed
//     every error into [], so "Accept Top Offer" always said "No active
//     offers found" even when offers existed.
//
// These are unit tests over the decision and the request shape, with fetch
// stubbed: what is locked is WHICH route is called, with WHICH field, and
// that failures propagate instead of masquerading as an empty result.
import { test, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// ── fetch stub: replay canned OpenSea responses, record every call ────────
let calls = [];
let responder = () => ({ status: 404, body: null });
const realFetch = globalThis.fetch;
const realKey = globalThis.__OPENSEA_API_KEY;

globalThis.__OPENSEA_API_KEY = 'test-key';   // both modules refuse keyless reads
globalThis.fetch = async (url) => {
  const path = String(url).replace('https://api.opensea.io/api/v2', '');
  calls.push(path);
  const r = responder(path) || { status: 404, body: null };
  const status = r.status ?? 404;
  return {
    ok: status < 400,
    status,
    json: async () => r.body ?? null,
    text: async () => JSON.stringify(r.body ?? null),
  };
};
afterEach(() => {
  calls = [];
  responder = () => ({ status: 404, body: null });
});
after(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete globalThis.__OPENSEA_API_KEY;
  else globalThis.__OPENSEA_API_KEY = realKey;
});

const { resolveSlug, collectionAsk, nftIntel, osChainFor } = await import('../js/nft-intel.js');
const { getHighestOffer } = await import('../js/opensea-api.js');

const ADDR_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ADDR_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ADDR_C = '0xcccccccccccccccccccccccccccccccccccccccc';
const ADDR_D = '0xdddddddddddddddddddddddddddddddddddddddd';

// ── 1. chain mapping ──────────────────────────────────────────────────────
test('osChainFor maps the active network to OpenSea’s chain slug', () => {
  assert.equal(osChainFor({ id: 'ethereum', chainId: 1 }), 'ethereum');
  assert.equal(osChainFor({ id: 'polygon', chainId: 137 }), 'polygon');
  assert.equal(osChainFor({ id: 'base', chainId: 8453 }), 'base');
  assert.equal(osChainFor({ id: 'sepolia', chainId: 11155111 }), 'sepolia');
});

test('an unknown network fails closed — never a guessed ethereum', () => {
  // The old code's `?.chain || 'ethereum'` was exactly this guess, and it
  // pointed every lookup at the wrong chain's index.
  assert.equal(osChainFor(null), null);
  assert.equal(osChainFor({ id: 'custom-1730000000000', chainId: 999999999 }), null);
  assert.equal(osChainFor({ id: 'Weird Name', chainId: 424242 }), null);
});

// ── 2. { nft: … } wrapper ─────────────────────────────────────────────────
test('resolveSlug unwraps the { nft: … } response the spec defines', async () => {
  responder = (p) => p.startsWith(`/chain/ethereum/contract/${ADDR_A}`)
    ? { status: 200, body: { nft: { collection: 'real-slug', identifier: '7' } } }
    : { status: 404, body: null };
  const r = await resolveSlug(ADDR_A, 'ethereum');
  assert.equal(r.slug, 'real-slug', 'reading collection off the wrapper throws for every contract');
  assert.equal(r.chain, 'ethereum');
  assert.equal(r.tokenId, '7');
});

test('nftIntel reads its fields off the unwrapped NFT, not the envelope', async () => {
  responder = (p) => p.includes('/nfts/9')
    ? {
        status: 200,
        body: {
          nft: {
            name: 'Item', collection: 'c', identifier: '9',
            owners: [{ address: '0xholder', quantity: 2 }],
            is_suspicious: true, estimated_value_usd: 4.2,
          },
        },
      }
    : { status: 404, body: null };
  const intel = await nftIntel({ contract: ADDR_B, tokenId: '9' });
  assert.equal(intel.slug, 'c');
  assert.equal(intel.owner, '0xholder');
  assert.equal(intel.suspicious, true);
  assert.equal(intel.estimatedUsd, 4.2);
});

// ── 3. chain choice per input ─────────────────────────────────────────────
test('an assets URL states its own chain and it wins over the active one', async () => {
  responder = (p) => p.startsWith('/chain/polygon/')
    ? { status: 200, body: { nft: { collection: 'poly-coll', identifier: '3' } } }
    : { status: 404, body: null };
  const r = await resolveSlug(
    'https://opensea.io/assets/polygon/0x1111111111111111111111111111111111111111/3',
    'ethereum',
  );
  assert.equal(r.chain, 'polygon');
  assert.ok(calls.some((p) => p.startsWith('/chain/polygon/')), 'must query polygon, not the passed chain');
  assert.equal(r.slug, 'poly-coll');
});

test('a contract lookup on a network OpenSea cannot know is refused, not guessed', async () => {
  await assert.rejects(
    resolveSlug(ADDR_C, null),
    /paste the collection link or slug/,
  );
  assert.equal(calls.length, 0, 'no request may go out on a guessed chain');
});

test('token 0 then 1 are tried when the input carries no token id', async () => {
  // Many collections start at 1; token 0 404ing must not report a real
  // contract as "not indexed".
  responder = (p) => (p.endsWith('/nfts/0')
    ? { status: 404, body: null }
    : p.endsWith('/nfts/1')
      ? { status: 200, body: { nft: { collection: 'starts-at-one', identifier: '1' } } }
      : { status: 404, body: null });
  const r = await resolveSlug(ADDR_D, 'ethereum');
  assert.equal(r.slug, 'starts-at-one');
  assert.ok(calls.some((p) => p.endsWith('/nfts/0')), 'token 0 must be tried first');
  assert.ok(calls.some((p) => p.endsWith('/nfts/1')), 'then token 1');
});

// ── 4. the ask row ────────────────────────────────────────────────────────
test('collectionAsk reads the BEST LISTING (an ask), not collection bids', async () => {
  responder = (p) => (p === '/listings/collection/coll/best'
    ? {
        status: 200,
        body: {
          listings: [
            { status: 'EXPIRED', price: { current: { currency: 'ETH', decimals: 18, value: '100000000000000000' } } },
            { status: 'ACTIVE', price: { current: { currency: 'ETH', decimals: 18, value: '2500000000000000000' } } },
          ],
        },
      }
    : { status: 404, body: null });
  const r = await collectionAsk({ slug: 'coll' });
  assert.equal(r.lowest.price, 2.5, 'wei converts through price.current.value/decimals');
  assert.equal(r.lowest.symbol, 'ETH');
  assert.ok(calls.includes('/listings/collection/coll/best'), 'the ask comes from listings');
  assert.ok(!calls.some((p) => p.includes('/offers/')), 'bids are not asks');
});

// ── 5. the top offer read ─────────────────────────────────────────────────
test('getHighestOffer reads the NFT offers route, prices it, and skips expired orders', async () => {
  responder = (p) => (p === '/offers/collection/coll/nfts/5'
    ? {
        status: 200,
        body: {
          offers: [
            { status: 'ACTIVE', order_hash: '0xh1', price: { currency: 'WETH', decimals: 18, value: '1500000000000000000' }, protocol_data: { parameters: { offerer: '0xME' } }, protocol_address: '0xp' },
            { status: 'EXPIRED', order_hash: '0xh2', price: { currency: 'WETH', decimals: 18, value: '9000000000000000000' }, protocol_data: { parameters: { offerer: '0xOLD' } } },
          ],
        },
      }
    : { status: 404, body: null });
  const top = await getHighestOffer({ slug: 'coll', tokenId: '5' });
  assert.equal(top.price, 1.5, 'value is in wei, not a human amount');
  assert.equal(top.symbol, 'WETH');
  assert.equal(top.maker, '0xME', 'an expired 9-WETH bid must not win the sort');
  assert.ok(calls.includes('/offers/collection/coll/nfts/5'), 'slug-keyed v2 route');
});

test('a failed offer read throws — it is not dressed up as "no offers"', async () => {
  // The old internal `catch { return [] }` made a dead route indistinguishable
  // from an empty one; the UI then asserted "No active offers found".
  responder = () => ({ status: 500, body: { errors: 'boom' } });
  await assert.rejects(getHighestOffer({ slug: 'coll', tokenId: '5' }), /OpenSea API 500/);
});

// ── 6. source gates ───────────────────────────────────────────────────────
/** Source with `//` comment lines removed, so prose about the OLD bug does
 *  not count as the bug still being present. */
const codeOnly = (src) => src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

test('the app resolves the chain through osChainFor, never net?.chain', () => {
  const app = fs.readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
  assert.match(app, /osChainFor\(/, 'the eligibility check must map the active network');
  assert.doesNotMatch(codeOnly(app), /\?\.chain\b/,
    'the field that no network object has must stay gone');
});

test('the removed OpenSea order routes are not called from the live flow', () => {
  const api = fs.readFileSync(new URL('../js/opensea-api.js', import.meta.url), 'utf8');
  const start = api.indexOf('export async function getOffers');
  const end = api.indexOf('export async function getHighestOffer');
  assert.ok(start > 0 && end > start, 'both functions must still exist');
  const live = codeOnly(api.slice(start, api.indexOf('\n}', api.indexOf('sort', end)) + 2));
  assert.doesNotMatch(live, /\/orders\/(offers|listings)/,
    'those routes 404 upstream since at least 2026-11-09');
});

test('the ask never comes from the offers endpoint or a nonexistent field', () => {
  const intel = fs.readFileSync(new URL('../js/nft-intel.js', import.meta.url), 'utf8');
  const live = codeOnly(intel);
  assert.doesNotMatch(live, /offers\/collection/, 'bids are not asks');
  assert.doesNotMatch(live, /price\?\.amount/, 'the payload carries price.value, not price.amount');
  assert.match(live, /listings\/collection\/\$\{encodeURIComponent\(slug\)\}\/best/,
    'the ask must come from the best-listing route');
});
