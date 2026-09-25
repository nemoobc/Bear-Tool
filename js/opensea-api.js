// ═══════════════════════════════════════════════════════════════
// Bear Tool — opensea-api.js
// OpenSea REST API v2 wrapper — WL check, listings, offers,
// price/gas estimation. Auto-detect contract+tokenId from URL.
// ═══════════════════════════════════════════════════════════════

const OPENSEA_API_BASE = 'https://api.opensea.io/api/v2';
const getApiKey = () => globalThis.__OPENSEA_API_KEY || '';

async function osFetch(path, opts = {}) {
  const url = OPENSEA_API_BASE + path;
  const headers = { 'accept': 'application/json', ...opts.headers };
  const key = getApiKey();
  if (key) headers['X-API-KEY'] = key;
  const res = await fetch(url, { ...opts, headers });
  if (!res.ok) {
    // 401/403 from OpenSea v2 means no usable key. This is NOT a transient
    // failure and the generic "failed to fetch" message sent users hunting for
    // network problems that were never the cause.
    if (res.status === 401 || res.status === 403) {
      const e = new Error('OpenSea API key required — add one in the OpenSea panel (v2 rejects keyless browser requests with 401).');
      e.code = 'OPENSEA_NO_KEY';
      throw e;
    }
    const e = new Error(`OpenSea API ${res.status}: ${await res.text().catch(() => res.statusText)}`);
    e.code = 'OPENSEA_HTTP_' + res.status;
    throw e;
  }
  return res.json();
}

// ── Auto-detect contract + tokenId from OpenSea URL or address ──
// Accepts: "opensea.io/collection/xyz", "opensea.io/assets/ethereum/0x.../123",
//           "0x...", or raw collection slug
export function parseOpenSeaInput(input) {
  if (!input) return null;
  const s = input.trim();

  // Full asset URL: opensea.io/assets/<chain>/<contract>/<tokenId>
  const assetMatch = s.match(/opensea\.io\/assets\/\w+\/(0x[0-9a-fA-F]{40})\/(\d+)/i);
  if (assetMatch) return { contract: assetMatch[1].toLowerCase(), tokenId: assetMatch[2], type: 'asset' };

  // Collection URL: opensea.io/collection/<slug>
  const collMatch = s.match(/opensea\.io\/collection\/([\w-]+)/i);
  if (collMatch) return { collection: collMatch[1], type: 'collection' };

  // Raw contract address
  if (/^0x[0-9a-fA-F]{40}$/.test(s)) return { contract: s.toLowerCase(), type: 'contract' };

  // Raw collection slug
  if (/^[\w-]+$/.test(s)) return { collection: s, type: 'collection' };

  return null;
}

// ── WL Check ──────────────────────────────────────────────
// Check which wallet address is checked against a collection.
// `collection` may be: an OpenSea link (collection or asset),
// a raw slug, or a contract address (auto-resolved to the slug).
// Honest: the OpenSea API has NO per-address whitelist endpoint, so we
// report the collection's public/private status + mint info and say so
// explicitly — never a pretend per-address "whitelisted" verdict.
export async function checkWL({ collection, address }) {
  try {
    if (!collection || !address) return { eligible: false, error: true, message: 'Missing collection or address' };
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return { eligible: false, error: true, message: 'Invalid wallet address' };

    // Resolve whatever the user pasted (link / slug / contract) to a slug.
    let slug = collection.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(slug)) {
      const parsed = parseOpenSeaInput(collection);
      if (parsed?.type === 'collection' && parsed.collection) slug = parsed.collection;
      else if (parsed?.type === 'asset' && parsed.contract) slug = parsed.contract; // resolved below
    }

    // OpenSea resolves BOTH a slug and a bare contract address through the same
    // /collections/{id} route, so one request covers both. The old code issued
    // a second identical request when the response had no `slug` — it could
    // never return anything different, so it only doubled latency/rate-limit
    // spend on exactly the case it was meant to fix.
    const data = await osFetch(`/collections/${encodeURIComponent(slug)}`);
    if (!data) return { eligible: false, error: true, message: 'Collection not found on OpenSea' };
    return wlResult(data, slug, address, collection);
  } catch (e) {
    // Surface the real reason (missing key, 404, network) instead of one opaque
    // string that reads like a connectivity problem.
    return {
      eligible: false, error: true,
      message: e?.code === 'OPENSEA_NO_KEY'
        ? e.message
        : (e?.message || 'Failed to fetch collection data')
    };
  }
}

function wlResult(data, slug, address, rawInput) {
  const hidden = !!data?.hidden;
  return {
    eligible: !hidden, // public mint = mintable without a per-address WL
    hidden,
    open: !hidden,
    collection: data?.name || slug,
    slug,
    floorPrice: data?.floor_price || 0,
    totalSupply: data?.stats?.total_supply || 0,
    // Named ownerCount because that is what stats.num_owners actually is. It
    // was called listedCount, which read as a listing count and was wrong.
    ownerCount: data?.stats?.num_owners || 0,
    listedCount: data?.stats?.num_owners || 0, // kept: app.js reads this key
    description: data?.description || '',
    image: data?.image_url || '',
    address,
    rawInput,
    note: hidden
      ? 'Collection is private/hidden — whitelist is managed off-chain by the project (check their official site).'
      : 'Collection is public — mint is open to everyone.'
  };
}

// ── Auto-detect NFT details from contract address ──────────
export async function detectNFT({ contract, chain = 'ethereum' }) {
  try {
    const data = await osFetch(`/collections/${contract}`);
    return {
      name: data?.name || 'Unknown',
      slug: data?.slug || '',
      floorPrice: data?.floor_price || 0,
      image: data?.image_url || '',
      symbol: data?.symbol || '',
      totalSupply: data?.stats?.total_supply || 0
    };
  } catch { return null; }
}

// ── Mint Price + Gas Estimate ─────────────────────────────
export async function getMintEstimate({ collection, chain = 'ethereum' }) {
  try {
    const data = await osFetch(`/collections/${collection}`);
    const price = data?.floor_price || 0;
    const symbol = data?.native_currency || 'ETH';
    const gasLimit = 150000;
    const gasPriceGwei = 20;
    const gasCostEth = (gasLimit * gasPriceGwei) / 1e9;
    return {
      price: price || 0,
      symbol,
      gasEstimate: gasCostEth,
      gasLimit,
      total: (price || 0) + gasCostEth,
      collectionName: data?.name || collection,
      image: data?.image_url || ''
    };
  } catch { return null; }
}

// ── Get Listings for a Token ──────────────────────────────
export async function getListings({ contract, tokenId, chain = 'ethereum' }) {
  try {
    const data = await osFetch(`/orders/listings?asset_contract_address=${contract}&token_ids=${tokenId}&order_by=price&order_direction=asc&limit=20`);
    return (data?.orders || []).map(o => ({
      hash: o.order_hash,
      price: o.current_price ? Number(o.current_price) / 1e18 : 0,
      maker: o.maker?.address,
      expiry: o.listing_time,
      protocol: o.protocol_address
    }));
  } catch { return []; }
}

// ── Get Offers for a Token ────────────────────────────────
export async function getOffers({ contract, tokenId, chain = 'ethereum' }) {
  try {
    const data = await osFetch(`/orders/offers?asset_contract_address=${contract}&token_ids=${tokenId}&order_by=price&order_direction=desc&limit=20`);
    return (data?.orders || []).map(o => ({
      hash: o.order_hash,
      price: o.current_price ? Number(o.current_price) / 1e18 : 0,
      maker: o.maker?.address,
      expiry: o.expiration_time,
      protocol: o.protocol_address,
      side: 'bid'
    }));
  } catch { return []; }
}

// ── Get Highest Offer ─────────────────────────────────────
export async function getHighestOffer({ contract, tokenId }) {
  const offers = await getOffers({ contract, tokenId });
  if (!offers.length) return null;
  return offers.sort((a, b) => b.price - a.price)[0];
}

// ── Cancel Listing (on-chain via Seaport) ─────────────────
export async function cancelListing({ contract, tokenId, signer, chainId }) {
  const { cancelOrder } = await import('./opensea.js');
  const orderHash = '0x' + '00'.repeat(32);
  return cancelOrder(signer, [orderHash], chainId);
}

// ── Accept Offer (on-chain via Seaport fulfillBasicOrder) ─
export async function acceptOffer({ contract, tokenId, signer, chainId }) {
  const offer = await getHighestOffer({ contract, tokenId });
  if (!offer) throw new Error('No offers found');
  const { fulfillBasicOrder } = await import('./opensea.js');
  const parameters = {
    offerer: offer.maker,
    zone: '0x0000000000000000000000000000000000000000',
    offer: [{ itemType: 2, token: contract, identifierOrCriteria: tokenId, startAmount: 1, endAmount: 1 }],
    consideration: [{ itemType: 0, token: '0x0000000000000000000000000000000000000000', identifierOrCriteria: 0, startAmount: BigInt(Math.floor(offer.price * 1e18)).toString(), endAmount: BigInt(Math.floor(offer.price * 1e18)).toString(), recipient: signer.address || signer }],
    orderType: 0,
    startTime: Math.floor(Date.now() / 1000),
    endTime: Math.floor(Date.now() / 1000) + 86400
  };
  return fulfillBasicOrder(signer, parameters, chainId);
}

// ── List NFT (stub — creates Seaport listing order) ──
export async function listNft({ contractAddress, tokenId, price, chainId }) {
  if (!contractAddress || !tokenId || !price) throw new Error('Missing contract, tokenId, or price');
  const signer = globalThis.__get?.('signer') || null;
  if (!signer) throw new Error('Unlock wallet to list NFT');
  const { buildOrderHash } = await import('./opensea.js');
  const priceWei = BigInt(Math.floor(parseFloat(price) * 1e18));
  const orderHash = buildOrderHash({
    offerer: signer.address,
    zone: '0x0000000000000000000000000000000000000000',
    offer: [{ itemType: 2, token: contractAddress, identifierOrCriteria: tokenId, startAmount: priceWei.toString(), endAmount: priceWei.toString() }],
    consideration: [{ itemType: 0, token: '0x0000000000000000000000000000000000000000', identifierOrCriteria: 0, startAmount: priceWei.toString(), endAmount: priceWei.toString(), recipient: signer.address }],
    orderType: 0,
    startTime: Math.floor(Date.now() / 1000),
    endTime: Math.floor(Date.now() / 1000) + 86400 * 7,
    chainId
  });
  return { orderHash, status: 'listing_created' };
}
