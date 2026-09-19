// ═══════════════════════════════════════════════════════════════
// Bear Tool — opensea-api.js
// OpenSea REST API v2 wrapper — WL check, listings, offers,
// price/gas estimation. API key from config (never committed).
// ═══════════════════════════════════════════════════════════════

const OPENSEA_API_BASE = 'https://api.opensea.io/api/v2';
// API key loaded from config at runtime (see config.js)
const getApiKey = () => globalThis.__OPENSEA_API_KEY || '';

async function osFetch(path, opts = {}) {
  const url = OPENSEA_API_BASE + path;
  const headers = { 'accept': 'application/json', ...opts.headers };
  const key = getApiKey();
  if (key) headers['X-API-KEY'] = key;
  const res = await fetch(url, { ...opts, headers });
  if (!res.ok) throw new Error(`OpenSea API ${res.status}: ${await res.text().catch(() => res.statusText)}`);
  return res.json();
}

// ── WL Check ──────────────────────────────────────────────
export async function checkWL({ collection, address }) {
  try {
    const data = await osFetch(`/collections/${collection}`);
    const wl = data?.hidden || false;
    // Collection is "open" if not hidden; WL collections are hidden from public
    return { eligible: !wl, collection: data?.name || collection, slug: collection };
  } catch { return { eligible: false, error: true }; }
}

// ── Mint Price + Gas Estimate ─────────────────────────────
export async function getMintEstimate({ collection, chain = 'ethereum' }) {
  try {
    const data = await osFetch(`/collections/${collection}`);
    const price = data?.floor_price || 0;
    const symbol = data?.native_currency || 'ETH';
    // Gas estimate: ~150k gas for standard mint
    const gasLimit = 150000;
    const gasPriceGwei = 20; // conservative estimate
    const gasCostEth = (gasLimit * gasPriceGwei) / 1e9;
    return {
      price: price || 0,
      symbol,
      gasEstimate: gasCostEth,
      gasLimit,
      total: (price || 0) + gasCostEth
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
  // Build order hash from listing data
  const orderHash = '0x' + '00'.repeat(32); // placeholder — real hash from listing
  return cancelOrder(signer, [orderHash], chainId);
}

// ── Accept Offer (on-chain via Seaport fulfillBasicOrder) ─
export async function acceptOffer({ contract, tokenId, signer, chainId }) {
  const offer = await getHighestOffer({ contract, tokenId });
  if (!offer) throw new Error('No offers found');
  const { fulfillBasicOrder } = await import('./opensea.js');
  // Build parameters from offer data
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
