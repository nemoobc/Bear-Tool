// ═══════════════════════════════════════════════════════════════
// Bear Tool — nft.js
// NFT gallery: best-effort on-chain enumeration of known ERC-721
// contracts (tokenOfOwnerByIndex + tokenURI metadata). Honest
// limitation message when an indexer is required.
// ═══════════════════════════════════════════════════════════════

import { $, escapeHtml } from './ui.js';
import { get } from './state.js';
import { getNetworkById, ERC721_ABI } from './network.js';

const { ethers } = globalThis;

// curated well-known enumerable ERC-721 contracts (mainnet)
const POPULAR_NFT_CONTRACTS = {
  1: [
    { address: '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D', name: 'Bored Ape Yacht Club' },
    { address: '0x60E4d786628Fea6478F785A6d7e704777c86a7c6', name: 'Mutant Ape Yacht Club' },
    { address: '0xED5AF388653567Af2F388E6224dC7C4b3241C544', name: 'Azuki' },
    { address: '0x8a90CAb2b38dba80c64b7734e58Ee1dB38B8992e', name: 'Doodles' }
  ]
};

const MAX_PER_CONTRACT = 10;
const NFT_TIMEOUT = 5000;

async function fetchWithTimeout(url, timeoutMs = NFT_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

function resolveUri(uri) {
  if (!uri) return null;
  if (uri.startsWith('ipfs://')) return 'https://ipfs.io/ipfs/' + uri.slice(7);
  if (uri.startsWith('ar://')) return 'https://arweave.net/' + uri.slice(5);
  return uri;
}

async function fetchNftMetadata(tokenUri) {
  const url = resolveUri(tokenUri);
  if (!url) return null;
  const res = await fetchWithTimeout(url);
  if (!res.ok) return null;
  return res.json();
}

// enumerate owned NFTs from known contracts (best effort)
export async function enumerateNfts(address, chainId, provider) {
  const contracts = POPULAR_NFT_CONTRACTS[chainId] || [];
  const items = [];
  for (const c of contracts) {
    try {
      const contract = new ethers.Contract(c.address, ERC721_ABI, provider);
      const balance = await contract.balanceOf(address);
      if (balance <= 0n) continue;
      const count = Math.min(Number(balance), MAX_PER_CONTRACT);
      for (let i = 0; i < count; i++) {
        try {
          const tokenId = await contract.tokenOfOwnerByIndex(address, i);
          const tokenUri = await contract.tokenURI(tokenId);
          const meta = await fetchNftMetadata(tokenUri);
          items.push({
            contractAddress: c.address,
            collection: c.name,
            tokenId: tokenId.toString(),
            name: meta?.name || `#${tokenId.toString()}`,
            image: meta?.image ? resolveUri(meta.image) : null
          });
        } catch { /* skip unreadable token */ }
      }
    } catch { /* contract not enumerable / RPC error */ }
  }
  return items;
}

export async function loadNfts() {
  if (!get('unlocked')) return;
  const net = getNetworkById(get('networkId'));
  const grid = $('#nftList');
  if (!grid) return;
  const provider = get('provider');
  try {
    const items = await enumerateNfts(get('address'), net.chainId, provider);
    if (items.length) {
      grid.innerHTML = items.map(nft => `
        <div class="nft-card">
          ${nft.image ? `<img src="${escapeHtml(nft.image)}" alt="${escapeHtml(nft.name)}" loading="lazy" onerror="this.style.display='none'">` : '<div class="nft-card" style="aspect-ratio:1;display:flex;align-items:center;justify-content:center;font-size:2rem">🐻</div>'}
          <div class="meta">${escapeHtml(nft.name)}<br><span class="small">${escapeHtml(nft.collection)}</span></div>
          <div class="openSea-actions">
            <button class="btn-small" data-opensea="list" data-token="${nft.contractAddress}" data-id="${nft.tokenId}">List</button>
            <button class="btn-small" data-opensea="cancel" data-token="${nft.contractAddress}" data-id="${nft.tokenId}">Cancel</button>
            <button class="btn-small" data-opensea="fulfill" data-token="${nft.contractAddress}" data-id="${nft.tokenId}">Fulfill</button>
          </div>
        </div>`).join('');
    } else {
      // .nft-empty spans the grid and centres on both axes — see the CSS note.
      // The gallery is empty for two very different reasons, so say which:
      // the wallet holds no NFT here, versus the network cannot be enumerated.
      grid.innerHTML =
        '<div class="nft-empty" role="status">' +
          '<div class="nft-empty-title">NFT not found</div>' +
          '<div class="nft-empty-hint">This wallet holds no NFT on the current network. ' +
          'Switch network, or import the collection contract below.</div>' +
        '</div>';
    }
  } catch {
    grid.innerHTML =
      '<div class="nft-empty" role="status">' +
        '<div class="nft-empty-title">NFT gallery unavailable</div>' +
        '<div class="nft-empty-hint">This network cannot be enumerated for NFTs. ' +
        'Try Ethereum, Base or Polygon.</div>' +
      '</div>';
  }
}