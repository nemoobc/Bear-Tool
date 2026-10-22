// ═══════════════════════════════════════════════════════════════
// Bear Tool — nft.js
// NFT gallery: best-effort on-chain discovery of the wallet's NFTs.
// Scan sources: curated mainnet list + contracts recorded by the
// Deploy wizard (registry) + manually imported collections. Per
// contract: balance + ERC721Enumerable loop first, then a bounded
// Transfer-log scan for collections without Enumerable (OpenZeppelin's
// default ERC721 has none — that is why a freshly deployed NFT never
// showed up). Honest messages when an indexer is required.
// ═══════════════════════════════════════════════════════════════

import { $, escapeHtml, toast } from './ui.js';
import { get, set } from './state.js';
import { getNetworkById, ERC721_ABI, ERC1155_ABI } from './network.js';
import { listDeployed } from './registry.js';
import { detectNfts } from './nft-detect.js';

const { ethers } = globalThis;

// curated well-known ERC-721 contracts (mainnet)
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
// Stay under the 50000-block ceiling RPCs reject with -32701
// ("exceed maximum block range: 50000"): each getLogs chunk sits just
// below it.
export const LOG_CHUNK = 49000;
// How many chunks a log scan may request per contract — a deploy from
// today lands in the first pass (≈4 chunks ≈ 196k blocks of headroom).
const LOG_MAX_CHUNKS = 4;

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
  if (uri.startsWith('ar://')) return 'https://arweave.net/' + uri.slice(7);
  return uri;
}

async function fetchNftMetadata(tokenUri) {
  const url = resolveUri(tokenUri);
  if (!url) return null;
  const res = await fetchWithTimeout(url);
  if (!res.ok) return null;
  return res.json();
}

// ── scan sources ────────────────────────────────────────────────
// Merged, deduped list of contracts the gallery will query:
// imported (explicit user intent wins the label) → curated mainnet
// → wizard-deployed NFT contracts from the registry. erc20 registry
// entries are never NFTs and stay out.
export function nftScanTargets(chainId, registryEntries = [], importedEntries = []) {
  const out = [];
  const seen = new Set();
  const push = (address, name, source, standard) => {
    if (!address) return;
    const key = String(address).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ address, name: name || `${key.slice(0, 6)}…${key.slice(-4)}`, source, standard });
  };
  for (const e of importedEntries || []) push(e.address, e.name, 'imported', e.standard || 'erc721');
  for (const c of POPULAR_NFT_CONTRACTS[chainId] || []) push(c.address, c.name, 'curated', 'erc721');
  for (const e of registryEntries || []) {
    if (e.chainId != null && e.chainId !== chainId) continue;
    if (e.standard !== 'erc721' && e.standard !== 'erc1155') continue;
    push(e.address, e.name, 'registry', e.standard);
  }
  return out;
}

function importedFor(chainId) {
  const all = get('nftImports') || {};
  return all[chainId] || [];
}

function registryFor(chainId) {
  try { return listDeployed('token', chainId) || []; } catch { return []; }
}

// ── bounded log scanning ────────────────────────────────────────
export function chunkBlockRange(fromBlock, toBlock, size = LOG_CHUNK) {
  const out = [];
  let from = fromBlock;
  while (from <= toBlock) {
    const to = Math.min(from + size - 1, toBlock);
    out.push({ from, to });
    from = to + 1;
  }
  return out;
}

// ERC-721 Transfer indexes tokenId (topics[3]). ERC-1155 TransferSingle has
// THREE indexed addresses (operator, from, to) — its data holds exactly two
// words in EIP-1155 order: (uint256 _id, uint256 _value). The id is the FIRST
// data word; the old code sliced the second one, decoded the QUANTITY as a
// tokenId, and every 1155 lookup asked for token #<qty>.
export function decodeNftLog(log, standard) {
  try {
    if (standard === 'erc1155') {
      const hex = String(log.data || '').replace(/^0x/i, '');
      if (hex.length < 64) return null;
      return BigInt('0x' + hex.slice(0, 64)).toString();
    }
    const t = log.topics?.[3];
    if (!t) return null;
    return BigInt(t).toString();
  } catch { return null; }
}

// TransferBatch (what marketplaces actually use to move 1155s) carries
// ids[] — decoded through the real event ABI, never by hand-slicing:
// the array sits after an offset+length header. Returns every id the log
// proves the owner received; [] for anything unparseable.
const ERC1155_IFACE = new ethers.Interface([
  'event TransferSingle(address indexed _operator, address indexed _from, address indexed _to, uint256 _id, uint256 _value)',
  'event TransferBatch(address indexed _operator, address indexed _from, address indexed _to, uint256[] _ids, uint256[] _values)',
]);
const ERC1155_BATCH_TOPIC0 = ethers.id('TransferBatch(address,address,address,uint256[],uint256[])');

export function decodeErc1155Log(log) {
  try {
    const parsed = ERC1155_IFACE.parseLog({ topics: log.topics, data: log.data });
    if (!parsed) return [];
    const ids = parsed.name === 'TransferBatch' ? parsed.args._ids : [parsed.args._id];
    return ids.map((x) => x.toString());
  } catch { return []; }
}

// Walk backwards from toBlock in LOG_CHUNK slices (each request under
// the range ceiling), collecting token ids sent TO the owner, stopping
// at maxChunks requests or maxIds ids.
export async function scanEventTokenIds(provider, contractAddr, owner, standard, fromBlock, toBlock, opts = {}) {
  const maxChunks = opts.maxChunks ?? LOG_MAX_CHUNKS;
  const maxIds = opts.maxIds ?? MAX_PER_CONTRACT;
  const ownerTopic = ethers.zeroPadValue(owner, 32);
  // ERC-1155 indexes THREE addresses (operator, from, to), so the filter is
  // 4 slots deep and topic0 asks for BOTH transfer events in one request
  // (getLogs treats an array as OR):
  //   - _to is topics[3]. The old [sig, null, owner] landed the owner on
  //     topics[2] = _from — the scan matched the wallet's OUTGOING transfers
  //     and every receive slipped past, so the gallery stayed empty.
  // ERC-721 has only (from, to) indexed: owner on topics[2] is _to, as before.
  const topics = standard === 'erc1155'
    ? [[
        ethers.id('TransferSingle(address,address,address,uint256,uint256)'),
        ERC1155_BATCH_TOPIC0,
      ], null, null, ownerTopic]
    : [ethers.id('Transfer(address,address,uint256)'), null, ownerTopic];
  const found = new Set();
  let to = toBlock;
  for (let i = 0; i < maxChunks && to >= fromBlock; i++) {
    const from = Math.max(fromBlock, to - LOG_CHUNK + 1);
    const logs = await provider.getLogs({ address: contractAddr, topics, fromBlock: from, toBlock: to });
    for (const log of logs) {
      if (standard === 'erc1155' && log.topics?.[0] === ERC1155_BATCH_TOPIC0) {
        for (const id of decodeErc1155Log(log)) found.add(id);
        continue;
      }
      const id = decodeNftLog(log, standard);
      if (id != null) found.add(id);
    }
    if (found.size >= maxIds) break;
    to = from - 1;
  }
  return [...found].slice(0, maxIds);
}

// enumerate owned NFTs across every scan source (best effort)
export async function enumerateNfts(address, chainId, provider, targets = null) {
  const list = targets || nftScanTargets(chainId, registryFor(chainId), importedFor(chainId));
  const items = [];
  let latestBlock = null;
  for (const c of list) {
    try {
      const contract = new ethers.Contract(c.address, ERC721_ABI, provider);
      const standard = c.standard || 'erc721';
      const mine = [];
      if (standard !== 'erc1155') {
        // ERC-721: fast zero-balance skip, then the enumerable loop.
        let balance;
        try {
          balance = await contract.balanceOf(address);
        } catch { balance = -1n; /* no balanceOf(address) → log scan decides */ }
        if (balance === 0n) continue;
        const count = Math.min(Number(balance > 0n ? balance : 0n), MAX_PER_CONTRACT);
        for (let i = 0; i < count; i++) {
          try {
            const tokenId = await contract.tokenOfOwnerByIndex(address, i);
            const tokenUri = await contract.tokenURI(tokenId);
            const meta = await fetchNftMetadata(tokenUri);
            mine.push({
              contractAddress: c.address,
              collection: c.name,
              tokenId: tokenId.toString(),
              name: meta?.name || `#${tokenId.toString()}`,
              image: meta?.image ? resolveUri(meta.image) : null
            });
          } catch { break; /* not ERC721Enumerable (or spent index) → log scan */ }
        }
      }
      if (!mine.length) {
        // Contract without Enumerable (OpenZeppelin's default) or an
        // ERC-1155: bounded Transfer-log scan over the recent window.
        if (latestBlock == null) latestBlock = await provider.getBlockNumber();
        const from = Math.max(0, latestBlock - LOG_CHUNK * LOG_MAX_CHUNKS);
        const ids = await scanEventTokenIds(provider, c.address, address, standard, from, latestBlock);
        // ERC-1155 has no tokenURI() — the standard's metadata call is uri(id),
        // and a receive log only proves the token ARRIVED: a balance check
        // drops the ones since sent away. The 721 path keeps tokenURI().
        const c1155 = standard === 'erc1155' ? new ethers.Contract(c.address, ERC1155_ABI, provider) : null;
        for (const id of ids) {
          try {
            if (c1155 && (await c1155.balanceOf(address, id)) === 0n) continue;
            const rawUri = c1155 ? await c1155.uri(id) : await contract.tokenURI(id);
            // EIP-1155 lets uri() carry an {id} placeholder (case-insensitive,
            // hex, zero-padded to 32 bytes) — fetch it filled or 404s.
            const tokenUri = c1155 && /\{id\}/i.test(rawUri)
              ? String(rawUri).replace(/\{id\}/gi, BigInt(id).toString(16).padStart(64, '0'))
              : rawUri;
            const meta = await fetchNftMetadata(tokenUri);
            mine.push({
              contractAddress: c.address,
              collection: c.name,
              tokenId: id,
              name: meta?.name || `#${id}`,
              image: meta?.image ? resolveUri(meta.image) : null
            });
          } catch { /* unreadable token */ }
        }
      }
      items.push(...mine);
    } catch { /* contract unusable / RPC error — keep scanning the rest */ }
  }
  return items;
}

// The import row lives in the static card (outside #nftList), so the
// handler binds once per element and survives gallery re-renders.
function wireNftImport() {
  const btn = $('#btnNftImport');
  const inp = $('#nftImportAddr');
  if (!btn || !inp || btn.dataset.wired) return;
  btn.dataset.wired = '1';
  const add = () => {
    const addr = (inp.value || '').trim();
    if (!ethers.isAddress(addr)) {
      inp.setAttribute('aria-invalid', 'true');
      // aria-invalid is for assistive tech and has no styling in cartoon.css —
      // a sighted user saw the click land and NOTHING happen (silent dead
      // end). Mirror the deploy form's toast so the rejection is visible.
      // (Live E2E 2026-10-09: empty and "not-an-address" both gave zero
      // feedback while #btnDeploy answers with "Enter a token name".)
      toast(addr ? 'Enter a valid contract address (0x…)' : 'Enter a collection contract address', 'error');
      return;
    }
    inp.removeAttribute('aria-invalid');
    const chainId = getNetworkById(get('networkId')).chainId;
    const all = get('nftImports') || {};
    const list = all[chainId] || [];
    const key = addr.toLowerCase();
    if (!list.some((e) => String(e.address).toLowerCase() === key)) {
      all[chainId] = [...list, { address: ethers.getAddress(addr), standard: 'erc721', name: '' }];
      set('nftImports', all);
    }
    inp.value = '';
    loadNfts();
  };
  btn.addEventListener('click', add);
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
  inp.addEventListener('input', () => inp.removeAttribute('aria-invalid'));
}

// One card template for BOTH paths — the indexer list and the on-chain
// scan — because a second template is how two lists start disagreeing
// about what an NFT is. The floor line appears only when a provider
// actually answered one: OpenSea per collection slug (with its own
// floor_price_symbol), Alchemy inline on ETH/Polygon.
function nftCardHtml(nft) {
  const sym = nft.floorSymbol || getNetworkById(get('networkId'))?.symbol || 'ETH';
  const floor = nft.floor != null && Number.isFinite(Number(nft.floor))
    ? `<div class="small nft-floor">Floor: ${escapeHtml(String(nft.floor))} ${escapeHtml(sym)}</div>` : '';
  const img = nft.image
    ? `<img src="${escapeHtml(nft.image)}" alt="${escapeHtml(nft.name)}" loading="lazy" onerror="this.style.display='none'">`
    : '<div class="nft-card" style="aspect-ratio:1;display:flex;align-items:center;justify-content:center;font-size:2rem">🐻</div>';
  const tok = escapeHtml(String(nft.contractAddress ?? ''));
  const id = escapeHtml(String(nft.tokenId ?? ''));
  return `
        <div class="nft-card">
          ${img}
          <div class="meta">${escapeHtml(nft.name)}<br><span class="small">${escapeHtml(nft.collection)}</span></div>
          ${floor}
          <div class="openSea-actions">
            <button class="btn-small" data-opensea="list" data-token="${tok}" data-id="${id}">List</button>
            <button class="btn-small" data-opensea="cancel" data-token="${tok}" data-id="${id}">Cancel</button>
            <button class="btn-small" data-opensea="fulfill" data-token="${tok}" data-id="${id}">Fulfill</button>
          </div>
        </div>`;
}

// Both empty states share one shell and one wiring step. No "Switch network"
// button anymore: the gallery auto-detects owner-wide (Settings → NFT
// auto-detect), so an honest empty needs no nag to change chains — the top
// network picker is one tap away when the user actually wants that
// (user, 2026-10-06: "autodetect kalau ga ada harusnya ga perlu switch network").
function nftEmptyHtml(title, hintHtml) {
  return '<div class="nft-empty" role="status">' +
    '<div class="nft-empty-title">' + escapeHtml(title) + '</div>' +
    // An empty hint renders NO div — an empty box under the title is still a
    // box: dead space, and a target for a CSS rule that never had a sentence
    // to style.
    (hintHtml ? '<div class="nft-empty-hint">' + hintHtml + '</div>' : '') +
    '</div>';
}

function wireNftEmpty(netLabel) {
  const name = document.getElementById('nftEmptyNet');
  if (name) name.textContent = netLabel;
}

export async function loadNfts() {
  // Not `unlocked`. Enumerating NFTs only reads the chain with an address that
  // is already public, and the app restores a read-only account on boot — so
  // requiring the password meant the gallery silently stayed empty for anyone
  // who had not typed it yet.
  if (!get('address')) return;
  const net = getNetworkById(get('networkId'));
  const grid = $('#nftList');
  if (!grid) return;
  wireNftImport();
  const provider = get('provider');
  const netLabel = net.name + ' (chain ' + net.chainId + ')';
  try {
    // Owner-wide auto-detect first — only with a BYO key saved in
    // Settings → NFT auto-detect. detectNfts answers items:null when no
    // indexer is available here (no key, chain outside both providers'
    // coverage, or the calls failed) and the on-chain scan below takes
    // over; items:[] means the indexer ANSWERED with zero, which is the
    // whole truth for this address on this chain.
    const det = await detectNfts({
      address: get('address'),
      chainId: net.chainId,
      openSeaKey: get('nftKeyOpenSea') || '',
      alchemyKey: get('nftKeyAlchemy') || '',
    });
    if (det.items && det.items.length) {
      grid.innerHTML = det.items.map(nftCardHtml).join('');
      return;
    }
    if (det.items !== null) {
      const who = det.source === 'opensea' ? 'OpenSea' : 'Alchemy';
      grid.innerHTML = nftEmptyHtml('NFT not found',
        who + ' reports 0 NFTs for this address on <span id="nftEmptyNet"></span> — ' +
        'owner-wide detection covers every collection you own, not just a curated list. ' +
        'An NFT on another chain will not appear here.');
      wireNftEmpty(netLabel);
      return;
    }
    const targets = nftScanTargets(net.chainId, registryFor(net.chainId), importedFor(net.chainId));
    const items = await enumerateNfts(get('address'), net.chainId, provider, targets);
    if (items.length) {
      grid.innerHTML = items.map(nftCardHtml).join('');
    } else {
      // .nft-empty spans the grid and centres on both axes — see the CSS note.
      // Two words, and nothing under them (user, 2026-10-13): the paragraph
      // that used to list the scanned sources and offer a key turned an empty
      // gallery into an advertisement for a setup step. The scan this state
      // describes must work WITHOUT a key, and "NFT not found" says the whole
      // truth the wallet actually knows. wireNftEmpty goes with the paragraph:
      // the span it filled (`nftEmptyNet`) is gone with it.
      grid.innerHTML = nftEmptyHtml('NFT not found', '');
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
