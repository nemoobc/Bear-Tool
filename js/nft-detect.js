// ═══════════════════════════════════════════════════════════════
// Bear Tool — nft-detect.js
// Owner-wide NFT auto-detect + floor price. BYO-key, with fallback.
//
// WHY AN INDEXER EXISTS AT ALL — research-nft-detect.md (2026-10-04,
// every claim there sourced): owner-wide enumeration on-chain is
// ±2.4M eth_getLogs calls on Ethereum (Alchemy's free tier answers
// 10 blocks per call), ERC-721 Enumerable is OPTIONAL (OpenZeppelin's
// default ships without it), and Seaport has no "listing created"
// event — floor price cannot be derived from chain state at all.
// Reservoir's NFT API sunset 2025-10-15, SimpleHash shut down
// 2025-03-27, Moralis starts at $149/mo. What survives with CORS
// PROVEN from a browser page (preflight tested 2026-10-04):
//
//   OpenSea v2 — 600 reads/h on the instant key; per-owner list with
//                `estimated_value_usd` per NFT; floor from
//                /collections/{slug}/stats → total.floor_price +
//                floor_price_symbol (0 = no active listing → no
//                floor shown). Chain enum has NO bsc.
//   Alchemy    — 30M CU/mo free; getNFTsForOwner carries
//                contract.openseaMetadata.floorPrice for free (ETH +
//                Polygon mainnet only). The key rides in the URL —
//                their documented form; note it can land in logs.
//
// CONTRACT WITH THE CALLER (js/nft.js):
//   items === null  → NO indexer available here (no key, chain outside
//                     both providers' coverage, or every attempt
//                     failed) → caller falls back to its on-chain scan
//                     of curated + registry + imported contracts.
//   items === []    → the indexer ANSWERED with zero — the whole truth
//                     for this address on this chain.
//   items.length    → auto-detected list; entries may carry floor /
//                     floorSymbol / usd.
// Never throws. Keys are BYO, live in this browser's storage, and only
// travel with the requests they authorise. Pages are bounded
// (MAX_PAGES) so one wallet cannot turn a gallery render into a
// rate-limit suicide. — M3, 2026-10-04.
// ═══════════════════════════════════════════════════════════════

// chainId → provider chain slug. Numbers, not strings: chainId from
// network.js is a number and a string "1" silently matches neither map.
export const OPENSEA_CHAINS = {
  1: 'ethereum',
  137: 'polygon',
  42161: 'arbitrum',
  10: 'optimism',
  8453: 'base',
};
export const ALCHEMY_CHAINS = {
  1: 'eth-mainnet',
  137: 'polygon-mainnet',
  42161: 'arb-mainnet',
  10: 'opt-mainnet',
  8453: 'base-mainnet',
};

// A gallery page, not an archive crawl: 3 pages × 100 items is the cap.
// Both providers paginate with an opaque cursor; hitting the cap shows
// the first N and says nothing about the rest (SELAIN in the report).
export const MAX_PAGES = 3;
export const PAGE_SIZE = 100;
// Floor = one stats call per DISTINCT collection slug, capped — a wallet
// holding 200 collections would otherwise burn the whole hourly quota
// decorating rows nobody scrolls to.
const MAX_FLOOR_SLUGS = 10;

const numOrNull = (v) => {
  if (v == null || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};
const str = (v) => (v == null ? '' : String(v));
const safeJson = async (r) => {
  try { return await r.json(); } catch { return null; }
};
const errLabel = (e) => String((e && e.message) || e || 'fetch-failed');

// ── URL builders (pure — tests pin them without a network) ─────

export function openseaNftsUrl(chainId, address, cursor = '') {
  const slug = OPENSEA_CHAINS[Number(chainId)];
  if (!slug || !address) return null;
  const limit = Math.min(Number(PAGE_SIZE) || 100, 200); // docs: limit max 200
  let url = `https://api.opensea.io/api/v2/chain/${slug}/account/${encodeURIComponent(address)}/nfts?limit=${limit}`;
  if (cursor) url += `&next=${encodeURIComponent(cursor)}`;
  return url;
}

export function openseaStatsUrl(slug) {
  if (!slug) return null;
  return `https://api.opensea.io/api/v2/collections/${encodeURIComponent(slug)}/stats`;
}

export function alchemyNftsUrl(chainId, address, key, pageKey = '') {
  const slug = ALCHEMY_CHAINS[Number(chainId)];
  if (!slug || !address || !key) return null;
  let url = `https://${slug}.g.alchemy.com/nft/v3/${encodeURIComponent(key)}` +
    `/getNFTsForOwner?owner=${encodeURIComponent(address)}&pageSize=${PAGE_SIZE}&withMetadata=true`;
  if (pageKey) url += `&pageKey=${encodeURIComponent(pageKey)}`;
  return url;
}

// ── response parsers (pure — defensive by design: the fixtures in
//    tests/nft-detect-api.test.js are documented shapes, and every
//    field is optional-chained so a provider wording change degrades
//    to an empty list, never to a thrown gallery) ────────────────

export function parseOpenSeaNfts(json) {
  const rows = Array.isArray(json?.nfts) ? json.nfts : [];
  return rows.map((n) => {
    const coll = n?.collection;
    return {
      // v2 lists `contract` as the address string; older shapes carried
      // an object. Both are accepted, neither is trusted beyond str().
      contractAddress: str(typeof n?.contract === 'object' && n?.contract !== null
        ? n.contract.address : (n?.contract || n?.contract_address || '')),
      collection: str(typeof coll === 'object' && coll !== null ? coll.name : (coll || n?.collection_name || '')),
      collectionSlug: str(typeof coll === 'object' && coll !== null ? coll.slug : (n?.collection_slug || '')),
      tokenId: str(n?.identifier ?? n?.token_id ?? ''),
      name: str(n?.name || (n?.identifier != null ? '#' + n.identifier : 'NFT')),
      image: str(n?.image_url || n?.image_thumbnail_url || '') || null,
      usd: numOrNull(n?.estimated_value_usd),
      floor: null,
      floorSymbol: null,
    };
  });
}

export function parseOpenSeaFloor(json) {
  // Docs (get_collection_stats.md): total.floor_price + floor_price_symbol,
  // where 0 means "no active listing" — a zero floor is no floor.
  const price = numOrNull(json?.total?.floor_price);
  if (price == null || price <= 0) return null;
  const symbol = typeof json?.total?.floor_price_symbol === 'string' && json.total.floor_price_symbol
    ? json.total.floor_price_symbol : null;
  return { price, symbol };
}

const alchemyImage = (img) => {
  if (typeof img === 'string') return img || null;
  return str(img?.cachedUrl || img?.thumbnailUrl || img?.originalUrl || '') || null;
};

export function parseAlchemyNfts(json) {
  const rows = Array.isArray(json?.ownedNfts) ? json.ownedNfts
    : (Array.isArray(json?.nfts) ? json.nfts : []);
  return rows.map((n) => {
    const c = n?.contract;
    const obj = typeof c === 'object' && c !== null;
    const meta = obj ? c.openseaMetadata : null;
    return {
      contractAddress: str(obj ? c.address : (c || '')),
      collection: str(obj ? (c.name || '') : ''),
      collectionSlug: str(meta?.slug || n?.collection?.slug || ''),
      tokenId: str(n?.tokenId ?? ''),
      name: str(n?.name || n?.title || (n?.tokenId != null ? '#' + n.tokenId : 'NFT')),
      image: alchemyImage(n?.image),
      usd: null,
      // Free floor, ETH + Polygon mainnet only — everywhere else the
      // field is absent and the card simply shows no floor line.
      floor: numOrNull(meta?.floorPrice),
      floorSymbol: null,
    };
  });
}

// ── page fetchers ───────────────────────────────────────────────
// First-page failure throws (that provider is down / refused / rate
// limited → caller may try the next one). A later page failing keeps
// what was already collected: a partial honest list beats an empty
// error screen.

async function fetchOpenSeaPages(fetchFn, chainId, address, key, errors) {
  const headers = { 'x-api-key': key, accept: 'application/json' };
  const all = [];
  let cursor = '';
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await fetchFn(openseaNftsUrl(chainId, address, cursor), { headers });
    if (!r || !r.ok) {
      if (page === 0) throw new Error('HTTP ' + (r ? r.status : 'no-response'));
      errors.push('opensea:page' + (page + 1) + ':' + (r ? r.status : 'no-response'));
      break;
    }
    const json = await safeJson(r);
    all.push(...parseOpenSeaNfts(json));
    cursor = str(json?.next);
    if (!cursor) break;
  }
  return all;
}

async function fetchAlchemyPages(fetchFn, chainId, address, key, errors) {
  const headers = { accept: 'application/json' };
  const all = [];
  let pageKey = '';
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await fetchFn(alchemyNftsUrl(chainId, address, key, pageKey), { headers });
    if (!r || !r.ok) {
      if (page === 0) throw new Error('HTTP ' + (r ? r.status : 'no-response'));
      errors.push('alchemy:page' + (page + 1) + ':' + (r ? r.status : 'no-response'));
      break;
    }
    const json = await safeJson(r);
    all.push(...parseAlchemyNfts(json));
    pageKey = str(json?.pageKey);
    if (!pageKey) break;
  }
  return all;
}

// One stats call per distinct slug (capped), attached back onto every
// item of that collection. A failed floor call is a missing line, not
// a missing gallery — each is swallowed on purpose.
async function attachOpenSeaFloors(fetchFn, items, key, errors) {
  const slugs = [...new Set(items.map((i) => i.collectionSlug).filter(Boolean))].slice(0, MAX_FLOOR_SLUGS);
  if (!slugs.length) return;
  const headers = { 'x-api-key': key, accept: 'application/json' };
  await Promise.all(slugs.map(async (slug) => {
    try {
      const r = await fetchFn(openseaStatsUrl(slug), { headers });
      if (!r || !r.ok) {
        errors.push('floor:' + slug + ':' + (r ? r.status : 'no-response'));
        return;
      }
      const f = parseOpenSeaFloor(await safeJson(r));
      if (!f) return;
      for (const it of items) {
        if (it.collectionSlug === slug) { it.floor = f.price; it.floorSymbol = f.symbol; }
      }
    } catch (e) {
      errors.push('floor:' + slug + ':' + errLabel(e));
    }
  }));
}

// ── the entry point ─────────────────────────────────────────────

export async function detectNfts({ address, chainId, openSeaKey = '', alchemyKey = '', fetchFn } = {}) {
  const out = { items: null, source: null, floors: {}, errors: [] };
  const go = fetchFn || ((...a) => globalThis.fetch(...a));
  if (!address) return out;
  const cid = Number(chainId);

  if (openSeaKey && OPENSEA_CHAINS[cid]) {
    try {
      const items = await fetchOpenSeaPages(go, cid, address, openSeaKey, out.errors);
      out.items = items;
      out.source = 'opensea';
      await attachOpenSeaFloors(go, items, openSeaKey, out.errors);
      for (const it of items) {
        if (it.floor != null) out.floors['slug:' + it.collectionSlug] = it.floor;
      }
      return out;
    } catch (e) {
      out.errors.push('opensea:' + errLabel(e));
      // fall through to Alchemy — the fallback layer (research §3, A + E)
    }
  }

  if (alchemyKey && ALCHEMY_CHAINS[cid]) {
    try {
      const items = await fetchAlchemyPages(go, cid, address, alchemyKey, out.errors);
      out.items = items;
      out.source = 'alchemy';
      for (const it of items) {
        if (it.floor != null && it.contractAddress) {
          out.floors[String(it.contractAddress).toLowerCase()] = it.floor;
        }
      }
      return out;
    } catch (e) {
      out.errors.push('alchemy:' + errLabel(e));
    }
  }

  return out; // items stays null → caller runs its on-chain scan
}
