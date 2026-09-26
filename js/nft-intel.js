// ═══════════════════════════════════════════════════════════════
// nft-intel.js — eligibility, cost and safety for an NFT drop.
//
// WHAT "ELIGIBLE" ACTUALLY MEANS HERE, because the honest answer is narrower
// than "whitelist":
//
//   OpenSea exposes NO per-address allowlist endpoint. A project's private mint
//   allowlist lives in its own contract or off-chain and is not publicly
//   readable. So this module answers the one question that IS verifiable from
//   public data and does not pretend to answer the other:
//
//     "Is this address a recorded holder of this collection?"
//
//   That comes from GET /api/v2/collections/{slug}/holders, which is derived
//   from real ownership. It is reported as `holds` with a quantity, never as a
//   bare "you are whitelisted" verdict, and the UI says where the answer comes
//   from. If a user needs a project's private allowlist they must ask the
//   project; this cannot know it and does not guess.
//
// COST: an asking price plus a real gas estimate. OpenSea has no "mint price"
//   field, so the number shown is the lowest ask / floor and is labelled as
//   such — calling it the mint price would be a lie.
//
// SAFETY: a list of individually-sourced signals with pass / warn / fail, from
//   OpenSea's own `is_suspicious` flag plus on-chain reads over the RPC the
//   wallet already has. It is a triage aid, not an audit, and says so.
// ═══════════════════════════════════════════════════════════════

import { escapeHtml, fmtUsd } from './ui.js';

const OS = 'https://api.opensea.io/api/v2';
const HOLDER_PAGE_LIMIT = 20;      // hard cap: do not hammer a rate-limited API

function apiKey() {
  try { return (globalThis.__OPENSEA_API_KEY || '').trim(); } catch { return ''; }
}

async function osGet(path) {
  const key = apiKey();
  if (!key) {
    const e = new Error('OpenSea API key required — API v2 answers 401 to keyless browser requests.');
    e.code = 'OPENSEA_NO_KEY';
    throw e;
  }
  const res = await fetch(OS + path, { headers: { 'x-api-key': key, accept: 'application/json' } });
  if (res.status === 401 || res.status === 403) {
    const e = new Error('OpenSea rejected the API key (' + res.status + ').');
    e.code = 'OPENSEA_BAD_KEY';
    throw e;
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('OpenSea HTTP ' + res.status);
  return res.json();
}

// ── input parsing ────────────────────────────────────────────────────────
const CHAIN_BY_ID = {
  ethereum: 'ethereum', mainnet: 'ethereum', eth: 'ethereum', matic: 'polygon',
  polygon: 'polygon', bsc: 'bsc', 'binance-smart-chain': 'bsc',
  arbitrum: 'arbitrum', optimism: 'optimism', base: 'base',
  sepolia: 'sepolia', amoy: 'amoy', 'bsc-testnet': 'bsc',
};

/** Accepts an OpenSea link, a bare contract, a slug, or an asset link. */
export function parseDropInput(input) {
  const s = (input || '').trim();
  if (!s) return null;

  // opensea.io/assets/<chain>/<contract>/<tokenId>
  let m = s.match(/opensea\.io\/assets\/([\w-]+)\/(0x[0-9a-fA-F]{40})\/(\d+)/i);
  if (m) return { kind: 'asset', chain: CHAIN_BY_ID[m[1].toLowerCase()] || m[1].toLowerCase(), contract: m[2].toLowerCase(), tokenId: m[3] };

  // opensea.io/collection/<slug>
  m = s.match(/opensea\.io\/collection\/([\w.-]+)/i);
  if (m) return { kind: 'collection', slug: m[1] };

  // Any other URL: try to pull a contract/token out of it.
  m = s.match(/(0x[0-9a-fA-F]{40})(?:\/(\d+))?/);
  if (m) return { kind: 'contract', contract: m[1].toLowerCase(), tokenId: m[2] || null };

  if (/^0x[0-9a-fA-F]{40}$/.test(s)) return { kind: 'contract', contract: s.toLowerCase() };
  if (/^[\w.-]+$/.test(s)) return { kind: 'collection', slug: s };
  return null;
}

/**
 * Resolve any accepted input to a collection slug.
 * The API is slug-keyed, but a contract address alone is enough: fetching token
 * #0 of a contract returns that NFT's `collection`, which IS the slug. That is
 * the documented workaround for the missing contract→slug route.
 */
export async function resolveSlug(input, chain = 'ethereum') {
  const p = parseDropInput(input);
  if (!p) throw new Error('Could not read that link, address or slug.');
  if (p.kind === 'collection') return { slug: p.slug, input: p };
  const c = p.contract;
  if (!c) throw new Error('No contract address in that input.');
  const nft = await osGet(`/chain/${chain}/contract/${c}/nfts/${p.tokenId || 0}`);
  if (!nft || !nft.collection) {
    throw new Error('OpenSea does not index that contract yet, so the collection could not be resolved.');
  }
  return { slug: nft.collection, contract: c, chain, input: p };
}

// ── eligibility: is this address a recorded holder? ───────────────────────
/**
 * Walks the paginated holders list looking for `address`.
 * Returns a verdict that names its own evidence, never a bare boolean.
 */
export async function checkEligibility({ slug, address }) {
  if (!slug) return { eligible: false, error: 'No collection resolved.' };
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return { eligible: false, error: 'Enter a wallet address to check (0x…).' };
  }
  const want = address.toLowerCase();
  let next = null;
  let scanned = 0;
  let truncated = false;

  for (let page = 0; page < HOLDER_PAGE_LIMIT; page++) {
    const q = next ? `?next=${encodeURIComponent(next)}` : '';
    let data;
    try { data = await osGet(`/collections/${encodeURIComponent(slug)}/holders${q}`); }
    catch (e) { return { eligible: false, error: e.message, code: e.code }; }
    if (!data) return { eligible: false, error: 'Collection not found on OpenSea.' };

    const holders = Array.isArray(data.holders) ? data.holders : [];
    scanned += holders.length;
    const hit = holders.find((h) => String(h.address || '').toLowerCase() === want);
    if (hit) {
      return {
        eligible: true,
        holds: hit.quantity ?? 1,
        sharePct: typeof hit.percentage === 'number' ? hit.percentage : null,
        scanned,
        evidence: 'holders',
        note: 'This address is a recorded holder of the collection. That is real, '
            + 'on-chain ownership — it is NOT the project’s private mint allowlist, '
            + 'which is not publicly readable. If you need the allowlist, ask the project.',
      };
    }
    next = data.next || null;
    if (!next) break;
    if (page === HOLDER_PAGE_LIMIT - 1) truncated = true;
  }

  return {
    eligible: false,
    holds: 0,
    scanned,
    truncated,
    evidence: 'holders',
    note: truncated
      ? `Not in the first ${scanned} holders scanned. The list is longer than the ${HOLDER_PAGE_LIMIT}-page cap, so this is not a proof of absence.`
      : `Not among the ${scanned} recorded holder${scanned === 1 ? '' : 's'}. If the project has a private allowlist it is off-chain and cannot be read here.`,
  };
}

// ── NFT facts: price, OpenSea's own risk flag, traits ───────────────────
export async function nftIntel({ contract, tokenId, chain = 'ethereum' }) {
  const nft = await osGet(`/chain/${chain}/contract/${contract}/nfts/${tokenId ?? 0}`);
  if (!nft) return null;
  const usd = typeof nft.estimated_value_usd === 'number' ? nft.estimated_value_usd : null;
  return {
    slug: nft.collection || null,
    name: nft.name || null,
    contract: nft.contract || contract,
    tokenId: nft.identifier ?? String(tokenId ?? 0),
    standard: nft.token_standard || null,
    image: nft.display_image_url || nft.image_url || null,
    openseaUrl: nft.opensea_url || null,
    estimatedUsd: usd,
    suspicious: !!nft.is_suspicious,
    disabled: !!nft.is_disabled,
    nsfw: !!nft.is_nsfw,
    owner: Array.isArray(nft.owners) && nft.owners[0] ? nft.owners[0].address : null,
    ownerQty: Array.isArray(nft.owners) && nft.owners[0] ? nft.owners[0].quantity : null,
    rarityRank: nft.rarity?.rank ?? null,
    traits: Array.isArray(nft.traits) ? nft.traits.map((t) => `${t.trait_type}: ${t.value}`) : [],
  };
}

/** Cheapest ask for the collection, in ETH and USD. Labelled as an ASK. */
export async function collectionAsk({ slug, chain = 'ethereum' }) {
  const offers = await osGet(`/chain/${chain}/offers/collection/${encodeURIComponent(slug)}?limit=20`);
  const list = Array.isArray(offers?.offers) ? offers.offers : [];
  const priced = list
    .map((o) => ({ price: Number(o.price?.amount), symbol: o.price?.currency || 'ETH' }))
    .filter((o) => Number.isFinite(o.price) && o.price > 0)
    .sort((a, b) => a.price - b.price);
  return { lowest: priced[0] || null, count: priced.length };
}

// ── on-chain safety signals ──────────────────────────────────────────────
// Everything here uses only eth_call against the RPC the wallet already holds.
// Each signal is independently sourced and individually labelled; there is no
// single "safe" boolean because that would overstate what is knowable.
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'; // EIP-1967
const SEL_OWNER = '0x8da5cb5b';   // owner()
const SEL_PAUSED = '0x5c975abb';   // paused()
const SEL_SUPPLY = '0x18160ddd';   // totalSupply()

async function callStr(provider, to, data) {
  return provider.call({ to, data });
}

function decodeAddress(hex) {
  if (!hex || hex === '0x') return null;
  const body = hex.slice(0, 66);
  if (!/^0x0{24}[0-9a-fA-F]{40}$/.test(body)) return null;
  return '0x' + body.slice(26).toLowerCase();
}

function decodeUint(hex) {
  if (!hex || hex === '0x') return null;
  try { return BigInt(hex); } catch { return null; }
}

/**
 * @param {object} provider ethers provider
 * @param {string} contract
 * @param {object} [opt] { intel } output of nftIntel(), for the OpenSea flag
 */
export async function contractSafety(provider, contract, opt = {}) {
  const signals = [];
  const add = (level, label, detail) => signals.push({ level, label, detail });

  if (!provider || !contract) {
    add('warn', 'Not checked', 'No RPC provider or contract address.');
    return { signals, verdict: 'unknown', note: 'No signals could be gathered.' };
  }

  // 1. Upgradeable proxy? A proxy can change the rules after you mint.
  let impl = null;
  try { impl = decodeAddress(await callStr(provider, contract, IMPL_SLOT)); } catch { /* not a 1967 proxy */ }
  if (impl) {
    add('fail', 'Upgradeable proxy',
      'The contract is an EIP-1967 proxy (implementation ' + impl + '). Its logic can be replaced at any time, including after you mint.');
  } else {
    add('pass', 'Not a 1967 proxy', 'No EIP-1967 implementation slot found. Rules cannot be swapped via the standard proxy slot.');
  }

  // 2. Owner renounced? A live owner can freeze/blacklist you.
  let owner = null;
  try { owner = decodeAddress(await callStr(provider, contract, SEL_OWNER)); } catch { /* Ownable not present */ }
  if (owner === null) {
    add('warn', 'Owner unknown', 'No Ownable owner() found, so renouncement cannot be judged either way.');
  } else if (owner === '0x0000000000000000000000000000000000000000') {
    add('pass', 'Owner renounced', 'owner() is the zero address — no one can pause, blacklist or change the drop.');
  } else {
    add('warn', 'Owner still active', 'owner() is ' + owner + '. That address can pause transfers or blacklist wallets.');
  }

  // 3. Paused right now?
  try {
    const p = await callStr(provider, contract, SEL_PAUSED);
    if (decodeUint(p)) add('fail', 'Contract paused', 'paused() is true — minting and transfers are currently blocked.');
    else add('pass', 'Not paused', 'paused() is false.');
  } catch { /* not pausable */ }

  // 4. Honeypot: can this wallet actually transfer an NFT out? Simulate a
  //    transfer to a throwaway address. A contract that mints fine but blocks
  //    sells is the classic trap, and only a simulation catches it.
  let sellOk = null, sellErr = null;
  try {
    const iface = new ethers.Interface([
      'function transferFrom(address from, address to, uint256 tokenId)',
    ]);
    const data = iface.encodeFunctionData('transferFrom', [
      '0x000000000000000000000000000000000000dEaD',
      '0x000000000000000000000000000000000000dEaD', 0,
    ]);
    await provider.call({ from: '0x000000000000000000000000000000000000dEaD', to: contract, data });
    sellOk = true;
  } catch (e) { sellOk = false; sellErr = e?.shortMessage || e?.message || 'reverted'; }
  if (sellOk === true) {
    add('pass', 'Transfers not blocked (simulated)', 'A transferFrom simulation succeeded, so this is not an obvious honeypot.');
  } else if (sellOk === false) {
    add('warn', 'Transfer simulation reverted', 'A transferFrom simulation reverted (' + String(sellErr).slice(0, 90) + '). That can be a honeypot, or just a contract that needs an owner-side approval. Treat as a risk.');
  }

  // 5. Supply
  try {
    const s = decodeUint(await callStr(provider, contract, SEL_SUPPLY));
    if (s !== null) add('info', 'Minted so far', s.toString() + ' token(s) exist.');
  } catch { /* not ERC-721 Supply */ }

  // 6. OpenSea's own flag
  if (opt.intel) {
    if (opt.intel.suspicious) add('fail', 'Flagged by OpenSea', 'OpenSea marks this item is_suspicious=true.');
    else add('pass', 'Not flagged by OpenSea', 'OpenSea reports is_suspicious=false.');
    if (opt.intel.disabled) add('warn', 'Disabled on OpenSea', 'OpenSea reports is_disabled=true for this item.');
  }

  const verdict = signals.some((s) => s.level === 'fail') ? 'risk'
    : signals.some((s) => s.level === 'warn') ? 'caution'
    : 'no-red-flags';
  return {
    signals,
    verdict,
    note: 'Automated signals from public chain reads and OpenSea flags. This is triage, not an audit — '
        + 'no automated check can prove a mint is safe. Check the project’s own channels before signing.',
  };
}

// ── cost breakdown ───────────────────────────────────────────────────────
/**
 * @param {object} o
 * @param {number} o.askEth      lowest ask / floor, in ETH
 * @param {bigint|string} o.gasWei  gas limit × price, from the wallet's own estimate
 * @param {number} [o.ethUsd]    ETH price for the USD column
 */
export function costBreakdown({ askEth, gasWei, ethUsd }) {
  const ask = Number.isFinite(Number(askEth)) ? Number(askEth) : 0;
  let gas = 0n;
  try { gas = BigInt(gasWei ?? 0); } catch { gas = 0n; }
  const gasEth = Number(gas) / 1e18;
  const totalEth = ask + gasEth;
  const rate = Number.isFinite(Number(ethUsd)) ? Number(ethUsd) : null;
  return {
    askEth: ask,
    gasEth,
    totalEth,
    askUsd: rate ? ask * rate : null,
    gasUsd: rate ? gasEth * rate : null,
    totalUsd: rate ? totalEth * rate : null,
    askLabel: 'Lowest ask / floor (asking price, not a mint price)',
    gasLabel: 'Estimated gas for one mint',
    totalLabel: 'Asking price + gas',
  };
}

export function renderSignals(signals) {
  const mark = { pass: '✔', warn: '⚠', fail: '✖', info: 'ℹ' };
  return (signals || []).map((s) =>
    `<li class="intel-signal intel-${escapeHtml(s.level)}"><span class="intel-mark">${mark[s.level] || '·'}</span>`
    + `<span><strong>${escapeHtml(s.label)}</strong> — ${escapeHtml(s.detail)}</span></li>`).join('');
}

export function renderCost(c) {
  const row = (label, eth, usd) =>
    `<li class="intel-cost-row"><span>${escapeHtml(label)}</span>`
    + `<span class="mono">${eth === null ? '—' : eth.toFixed(6) + ' ETH'}</span>`
    + `<span class="mono dim">${usd === null ? '—' : fmtUsd(usd)}</span></li>`;
  return `<ul class="intel-cost">`
    + row(c.askLabel, c.askEth, c.askUsd)
    + row(c.gasLabel, c.gasEth, c.gasUsd)
    + `<li class="intel-cost-row intel-total"><span>${escapeHtml(c.totalLabel)}</span>`
    + `<span class="mono">${c.totalEth.toFixed(6)} ETH</span>`
    + `<span class="mono">${c.totalUsd === null ? '—' : fmtUsd(c.totalUsd)}</span></li></ul>`;
}
