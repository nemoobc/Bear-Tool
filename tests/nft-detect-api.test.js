// M3 — NFT auto-detect via BYO-key indexers (js/nft-detect.js) and its
// wiring into the gallery.
//
// What the research pinned (research-nft-detect.md, 2026-10-04): OpenSea
// v2 = 600 reads/h, chain enum WITHOUT bsc, floor from
// /collections/{slug}/stats → total.floor_price + floor_price_symbol
// (0 = no listing); Alchemy = 30M CU/mo with contract.openseaMetadata
// floorPrice inline on ETH/Polygon; CORS proven for both from this page.
// Reservoir/SimpleHash dead, Moralis $149/mo → rejected with numbers.
//
// The contract this pins — the one js/nft.js branches on:
//   items === null → no indexer here → on-chain scan fallback
//   items === []   → the indexer ANSWERED zero (truth for this chain)
//   items.length   → auto-detected list, floor attached when available
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const d = await import('../js/nft-detect.js');
const nftJs = readFileSync(new URL('../js/nft.js', import.meta.url), 'utf8');
const settingsJsx = readFileSync(new URL('../src/views/settings.jsx', import.meta.url), 'utf8');
const appJs = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');

const ADDR = '0xAbc0000000000000000000000000000000000001';

// Response-like stub: every call is logged so tests can assert URLs and
// headers without a network.
const stub = (handler) => {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const r = handler(url, calls.length);
    return { ok: r.ok !== false, status: r.status || 200, json: async () => r.json ?? {} };
  };
  fn.calls = calls;
  return fn;
};

test('URL builders: right chain, right slug, bsc and keyless refused', () => {
  const os = d.openseaNftsUrl(1, ADDR);
  assert.ok(os.startsWith('https://api.opensea.io/api/v2/chain/ethereum/account/'), os);
  assert.ok(os.includes(ADDR));
  assert.ok(os.includes('limit=100'), 'page size inside the documented max 200');
  assert.ok(d.openseaNftsUrl(137, ADDR).includes('/chain/polygon/'));
  assert.ok(d.openseaNftsUrl(42161, ADDR).includes('/chain/arbitrum/'));
  assert.ok(d.openseaNftsUrl(8453, ADDR).includes('/chain/base/'));
  assert.ok(d.openseaNftsUrl(10, ADDR).includes('/chain/optimism/'));

  const cursor = d.openseaNftsUrl(1, ADDR, 'abc+12');
  assert.ok(cursor.includes('next=abc%2B12'), 'cursor is encoded, not pasted raw');
  assert.ok(!d.openseaNftsUrl(1, ADDR, '').includes('next='), 'no empty next= on page 1');

  // Research §1.2: OpenSea's chain enum has NO bsc → null, not a URL that 404s.
  assert.equal(d.openseaNftsUrl(56, ADDR), null, 'BSC is outside OpenSea coverage');
  assert.equal(d.openseaNftsUrl(11155111, ADDR), null, 'testnets are outside coverage');
  assert.equal(d.openseaNftsUrl(1, ''), null, 'no address, no request');

  assert.equal(d.openseaStatsUrl('doodles-official'),
    'https://api.opensea.io/api/v2/collections/doodles-official/stats');
  assert.equal(d.openseaStatsUrl(''), null);

  const al = d.alchemyNftsUrl(1, ADDR, 'KEY1');
  assert.ok(al.startsWith('https://eth-mainnet.g.alchemy.com/nft/v3/KEY1/getNFTsForOwner'), al);
  assert.ok(al.includes('pageSize=100') && al.includes('owner=' + ADDR));
  assert.ok(d.alchemyNftsUrl(137, ADDR, 'KEY1').includes('polygon-mainnet'));
  assert.ok(d.alchemyNftsUrl(42161, ADDR, 'KEY1').includes('arb-mainnet'));
  assert.ok(d.alchemyNftsUrl(1, ADDR, 'KEY1', 'NEXT').includes('pageKey=NEXT'));
  assert.equal(d.alchemyNftsUrl(56, ADDR, 'KEY1'), null, 'Alchemy has no BSC either');
  assert.equal(d.alchemyNftsUrl(1, ADDR, ''), null, 'a keyless Alchemy URL would be a pointless 401');
});

test('parseOpenSeaNfts: documented fields, both collection shapes, defensive defaults', () => {
  const items = d.parseOpenSeaNfts({
    nfts: [
      {
        identifier: '42',
        collection: { name: 'Doodles', slug: 'doodles-official' },
        contract: '0xaF5609E54222F4b08C3d5e0b9C1C8E6E9b0c1234',
        name: 'Doodle #42',
        image_url: 'https://i.openseacdn.com/42.png',
        estimated_value_usd: 1234.5,
      },
      {
        identifier: '7',
        collection: 'bare-slug-string',
        contract: { address: '0x0000000000000000000000000000000000000AaA' },
        image_url: '',
      },
      {},
    ],
  });
  assert.equal(items.length, 3);
  assert.equal(items[0].contractAddress, '0xaF5609E54222F4b08C3d5e0b9C1C8E6E9b0c1234');
  assert.equal(items[0].collection, 'Doodles');
  assert.equal(items[0].collectionSlug, 'doodles-official');
  assert.equal(items[0].tokenId, '42');
  assert.equal(items[0].name, 'Doodle #42');
  assert.equal(items[0].usd, 1234.5);
  assert.equal(items[0].floor, null, 'the list carries no floor — stats attaches it');

  assert.equal(items[1].collection, 'bare-slug-string', 'string collection = slug as given');
  assert.equal(items[1].contractAddress, '0x0000000000000000000000000000000000000AaA');
  assert.equal(items[1].name, '#7', 'missing name falls back to the identifier, never "undefined"');
  assert.equal(items[1].image, null, 'empty image_url becomes null, not ""');

  assert.equal(items[2].name, 'NFT', 'an empty object still yields a renderable card');
  assert.equal(items[2].tokenId, '');

  assert.deepEqual(d.parseOpenSeaNfts({}), [], 'a provider wording change degrades to an empty list');
  assert.deepEqual(d.parseOpenSeaNfts(null), [], 'and a body that is not JSON degrades the same way');
});

test('parseOpenSeaFloor: floor_price + symbol, and 0 means NO floor', () => {
  assert.deepEqual(
    d.parseOpenSeaFloor({ total: { floor_price: 1.25, floor_price_symbol: 'ETH' } }),
    { price: 1.25, symbol: 'ETH' });
  assert.equal(d.parseOpenSeaFloor({ total: { floor_price: 0, floor_price_symbol: 'ETH' } }), null,
    'docs: 0 = no active listing — a zero floor is no floor, not "free"');
  assert.equal(d.parseOpenSeaFloor({ total: { floor_price: '0.7' } }).price, 0.7, 'string numbers accepted');
  assert.deepEqual(d.parseOpenSeaFloor({ total: { floor_price: 0.7 } }).symbol, null,
    'a missing symbol stays null so the card falls back to the network symbol');
  assert.equal(d.parseOpenSeaFloor({}), null);
});

test('parseAlchemyNfts: inline floor (ETH/Polygon), image shapes, title fallback', () => {
  const items = d.parseAlchemyNfts({
    ownedNfts: [
      {
        contract: {
          address: '0xBAYC00000000000000000000000000000000001',
          name: 'Bored Ape',
          openseaMetadata: { floorPrice: 12.4, slug: 'boredapeyachtclub' },
        },
        tokenId: '3001',
        name: 'Ape #3001',
        image: { cachedUrl: 'https://res.cloudinary.com/x.png', thumbnailUrl: 'https://t.png' },
      },
      {
        contract: { address: '0xNoMeta', name: '' },
        tokenId: '9',
        title: 'From title field',
        image: 'https://plain.url/img.png',
      },
      { contract: { address: '0xArb', openseaMetadata: {} }, tokenId: '1' },
    ],
  });
  assert.equal(items[0].floor, 12.4, 'floor rides free inside getNFTsForOwner (research §2.2)');
  assert.equal(items[0].collectionSlug, 'boredapeyachtclub');
  assert.equal(items[0].image, 'https://res.cloudinary.com/x.png');
  assert.equal(items[0].name, 'Ape #3001');

  assert.equal(items[1].name, 'From title field', 'name-less NFTs fall back to title');
  assert.equal(items[1].image, 'https://plain.url/img.png', 'string image accepted');
  assert.equal(items[1].floor, null);

  assert.equal(items[2].floor, null, 'no openseaMetadata (Arbitrum etc.) = no floor, never NaN');
  assert.equal(items[2].name, '#1');
  assert.deepEqual(d.parseAlchemyNfts({}), []);
});

test('detectNfts: no key anywhere → items:null and ZERO network calls', async () => {
  const f = stub(() => ({ json: {} }));
  const out = await d.detectNfts({ address: ADDR, chainId: 1, fetchFn: f });
  assert.equal(out.items, null, 'null (not []) — the caller must fall back to its on-chain scan');
  assert.equal(out.source, null);
  assert.deepEqual(out.errors, []);
  assert.equal(f.calls.length, 0, 'a key-less user must not pay a single request');

  const bsc = stub(() => ({ json: {} }));
  const outBsc = await d.detectNfts({
    address: ADDR, chainId: 56, openSeaKey: 'K', alchemyKey: 'K', fetchFn: bsc,
  });
  assert.equal(outBsc.items, null, 'BSC is outside both providers — on-chain scan stays');
  assert.equal(bsc.calls.length, 0, 'and no doomed request is fired to learn that');
});

test('detectNfts: OpenSea path — key header, floor stats attached per slug', async () => {
  const f = stub((url) => {
    if (url.includes('/stats')) return { json: { total: { floor_price: 3.5, floor_price_symbol: 'ETH' } } };
    return {
      json: {
        nfts: [
          { identifier: '1', collection: { name: 'Doodles', slug: 'doodles-official' },
            contract: '0xC1', name: 'Doodle #1', image_url: 'https://img/1.png' },
          { identifier: '2', collection: { name: 'Doodles', slug: 'doodles-official' },
            contract: '0xC1', name: 'Doodle #2' },
        ],
      },
    };
  });
  const out = await d.detectNfts({ address: ADDR, chainId: 1, openSeaKey: 'SECRET', fetchFn: f });
  assert.equal(out.source, 'opensea');
  assert.equal(out.items.length, 2);
  assert.ok(out.items.every((i) => i.floor === 3.5 && i.floorSymbol === 'ETH'),
    'one stats call per distinct slug, attached to every item of that collection');
  assert.equal(out.floors['slug:doodles-official'], 3.5);
  const listCall = f.calls.find((c) => c.url.includes('/account/'));
  assert.equal(listCall.init.headers['x-api-key'], 'SECRET', 'the key rides as a header, not a query');
  const statsCalls = f.calls.filter((c) => c.url.includes('/stats'));
  assert.equal(statsCalls.length, 1, 'distinct slugs only — two NFTs of one collection = one stats call');
  assert.equal(statsCalls[0].init.headers['x-api-key'], 'SECRET', 'stats needs the key too');
  assert.deepEqual(out.errors, [], 'a working path reports nothing');
});

test('detectNfts: pages bounded at MAX_PAGES, later-page failure keeps the partial list', async () => {
  let page = 0;
  const f = stub((url) => {
    if (url.includes('/stats')) return { json: {} };
    page += 1;
    if (page === 1) return { json: { nfts: [{ identifier: '1', collection: 'c', contract: '0x1' }], next: 'CURSOR' } };
    if (page === 2) return { json: { nfts: [{ identifier: '2', collection: 'c', contract: '0x1' }], next: 'NEVER-ENDING' } };
    return { ok: false, status: 429, json: {} };
  });
  const out = await d.detectNfts({ address: ADDR, chainId: 1, openSeaKey: 'K', fetchFn: f });
  assert.equal(out.source, 'opensea');
  assert.equal(out.items.length, 2, 'partial beats empty: page 1 + page 2 kept');
  assert.ok(out.errors.some((e) => e.startsWith('opensea:page3:429')), 'and the lost page is on record');
  const listCalls = f.calls.filter((c) => c.url.includes('/account/'));
  assert.equal(listCalls.length, 3, 'hard cap — an endless cursor can never loop the gallery');
  assert.ok(listCalls[1].url.includes('next=CURSOR'), 'page 2 follows the cursor');
});

test('detectNfts: OpenSea refuses → Alchemy answers (the fallback layer)', async () => {
  const f = stub((url) => {
    if (url.includes('opensea.io')) return { ok: false, status: 429, json: {} };
    return {
      json: {
        ownedNfts: [{
          contract: { address: '0xC1', name: 'Doodles', openseaMetadata: { floorPrice: 2.2 } },
          tokenId: '5', name: 'Doodle #5',
        }],
      },
    };
  });
  const out = await d.detectNfts({ address: ADDR, chainId: 1, openSeaKey: 'K', alchemyKey: 'A', fetchFn: f });
  assert.equal(out.source, 'alchemy');
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].floor, 2.2);
  assert.ok(out.errors[0].startsWith('opensea:'), 'the refusal is recorded, not swallowed');
  assert.ok(f.calls.some((c) => c.url.includes('eth-mainnet')), 'fallback actually reached Alchemy');
});

test('detectNfts: both providers fail → items stays null (fallback signal, not empty)', async () => {
  const f = stub(() => ({ ok: false, status: 500, json: {} }));
  const out = await d.detectNfts({ address: ADDR, chainId: 1, openSeaKey: 'K', alchemyKey: 'A', fetchFn: f });
  assert.equal(out.items, null, 'provider outage must NOT read as "you own nothing"');
  assert.equal(out.errors.length, 2);
  assert.equal(out.source, null);
});

test('detectNfts: an indexer answer of zero is items:[] — a truth, not a failure', async () => {
  const f = stub(() => ({ json: { nfts: [] } }));
  const out = await d.detectNfts({ address: ADDR, chainId: 1, openSeaKey: 'K', fetchFn: f });
  assert.deepEqual(out.items, []);
  assert.equal(out.source, 'opensea');
  assert.deepEqual(out.errors, []);
});

test('gallery wiring: one card template for both paths, keys wired, honest empties', () => {
  assert.match(nftJs, /import \{ detectNfts \} from '\.\/nft-detect\.js'/, 'nft.js imports the detector');
  assert.match(nftJs, /det\.items\.map\(nftCardHtml\)/, 'indexer path renders through the shared template');
  assert.match(nftJs, /items\.map\(nftCardHtml\)/, 'on-chain path renders through the SAME template');
  assert.equal((nftJs.match(/function nftCardHtml/g) || []).length, 1, 'and there is exactly one of it');
  assert.match(nftJs, /openSeaKey: get\('nftKeyOpenSea'\)/, 'reads the OpenSea key from settings');
  assert.match(nftJs, /alchemyKey: get\('nftKeyAlchemy'\)/, 'reads the Alchemy key from settings');
  assert.match(nftJs, /nft-floor/, 'cards render the floor line');
  assert.match(nftJs, /floorSymbol \|\| getNetworkById/, 'floor unit falls back to the network symbol');
  assert.match(nftJs, /det\.items !== null/, 'the null-vs-zero branch is explicit — empty is never faked');
  assert.match(nftJs, /holds no NFT|NFT not found/, 'honest not-found phrasing survives');
  assert.match(nftJs, /Scanned/, 'the on-chain empty still says how many collections were scanned');
  assert.match(nftJs, /Add a free API key in Settings/, 'the key-less empty says how to fix it');

  assert.match(settingsJsx, /id="setNftKeyOpenSea"/, 'OpenSea key field lives in Settings');
  assert.match(settingsJsx, /id="setNftKeyAlchemy"/, 'Alchemy key field lives in Settings');
  assert.match(settingsJsx, /type="password"/, 'keys are not shoulder-surfed on a phone');
  assert.match(appJs, /'#setNftKeyOpenSea', 'nftKeyOpenSea'/, 'app.js binds the OpenSea field');
  assert.match(appJs, /'#setNftKeyAlchemy', 'nftKeyAlchemy'/, 'app.js binds the Alchemy field');
  assert.match(appJs, /inp\.value = get\(key\) \|\| ''/, 'and reads the saved key back on bind');
});
