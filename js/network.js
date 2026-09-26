// ═══════════════════════════════════════════════════════════════
// Bear Tool — network.js
// All EVM networks: mainnet + testnet + custom RPC support.
// RPC lists ordered by verified reachability — publicnode/drpc first.
// llamarpc, ankr and cloudflare-eth are frequently unreachable from mobile
// networks, which made "All RPCs failed for Ethereum" common. getProvider()
// tries each URL in order until one answers.
// Original implementation — no copying.
// ═══════════════════════════════════════════════════════════════

import { fetchAllPrices } from './price.js';
import { withTimeout, RPC_TIMEOUT_MS } from './safetx.js';
import { get } from './state.js';

export const NETWORKS = [
  {
    id: 'ethereum', name: 'Ethereum', chainId: 1, type: 'mainnet',
    symbol: 'ETH', decimals: 18,
    rpc: [
      'https://ethereum-rpc.publicnode.com',
      'https://eth.drpc.org',
      'https://rpc.flashbots.net',
      'https://eth-mainnet.public.blastapi.io'
    ],
    explorer: 'https://etherscan.io',
    icon: '⬡', color: '#627EEA'
  },
  {
    id: 'bsc', name: 'BNB Smart Chain', chainId: 56, type: 'mainnet',
    symbol: 'BNB', decimals: 18,
    rpc: [
      'https://bsc-dataseed.binance.org',
      'https://bsc-rpc.publicnode.com',
      'https://bsc-dataseed1.defibit.io'
    ],
    explorer: 'https://bscscan.com',
    icon: '🟡', color: '#F0B90B'
  },
  {
    id: 'polygon', name: 'Polygon', chainId: 137, type: 'mainnet',
    symbol: 'POL', decimals: 18,
    rpc: [
      'https://polygon-bor-rpc.publicnode.com',
      'https://polygon.drpc.org',
      'https://1rpc.io/matic'
    ],
    explorer: 'https://polygonscan.com',
    icon: '🟣', color: '#8247E5'
  },
  {
    id: 'arbitrum', name: 'Arbitrum One', chainId: 42161, type: 'mainnet',
    symbol: 'ETH', decimals: 18,
    rpc: [
      'https://arb1.arbitrum.io/rpc',
      'https://arbitrum-one-rpc.publicnode.com'
    ],
    explorer: 'https://arbiscan.io',
    icon: '🔵', color: '#28A0F0'
  },
  {
    id: 'optimism', name: 'OP Mainnet', chainId: 10, type: 'mainnet',
    symbol: 'ETH', decimals: 18,
    rpc: [
      'https://mainnet.optimism.io',
      'https://optimism-rpc.publicnode.com'
    ],
    explorer: 'https://optimistic.etherscan.io',
    icon: '🔴', color: '#FF0420'
  },
  {
    id: 'base', name: 'Base', chainId: 8453, type: 'mainnet',
    symbol: 'ETH', decimals: 18,
    rpc: [
      'https://mainnet.base.org',
      'https://base-rpc.publicnode.com',
      'https://base.drpc.org'
    ],
    explorer: 'https://basescan.org',
    icon: '🔷', color: '#0052FF'
  },
  {
    id: 'sepolia', name: 'Sepolia', chainId: 11155111, type: 'testnet',
    symbol: 'ETH', decimals: 18,
    rpc: [
      'https://sepolia.gateway.tenderly.co',
      'https://ethereum-sepolia-rpc.publicnode.com'
    ],
    explorer: 'https://sepolia.etherscan.io',
    icon: '🧪', color: '#06D6A0'
  },
  {
    id: 'amoy', name: 'Polygon Amoy', chainId: 80002, type: 'testnet',
    symbol: 'POL', decimals: 18,
    rpc: [
      'https://polygon-amoy.drpc.org',
      'https://polygon-amoy-bor-rpc.publicnode.com'
    ],
    explorer: 'https://amoy.polygonscan.com',
    icon: '🧪', color: '#06D6A0'
  },
  {
    id: 'arbitrum-sepolia', name: 'Arbitrum Sepolia', chainId: 421614, type: 'testnet',
    symbol: 'ETH', decimals: 18,
    rpc: [
      'https://sepolia-rollup.arbitrum.io/rpc',
      'https://arbitrum-sepolia-rpc.publicnode.com'
    ],
    explorer: 'https://sepolia.arbiscan.io',
    icon: '🧪', color: '#06D6A0'
  },
  {
    id: 'op-sepolia', name: 'OP Sepolia', chainId: 11155420, type: 'testnet',
    symbol: 'ETH', decimals: 18,
    rpc: [
      'https://sepolia.optimism.io',
      'https://optimism-sepolia-rpc.publicnode.com'
    ],
    explorer: 'https://sepolia-optimistic.etherscan.io',
    icon: '🧪', color: '#06D6A0'
  },
  {
    id: 'base-sepolia', name: 'Base Sepolia', chainId: 84532, type: 'testnet',
    symbol: 'ETH', decimals: 18,
    rpc: [
      'https://sepolia.base.org',
      'https://base-sepolia-rpc.publicnode.com'
    ],
    explorer: 'https://sepolia.basescan.org',
    icon: '🧪', color: '#06D6A0'
  },
  {
    id: 'bsc-testnet', name: 'BSC Testnet', chainId: 97, type: 'testnet',
    symbol: 'tBNB', decimals: 18,
    rpc: [
      'https://data-seed-prebsc-1-s1.bnbchain.org:8545',
      'https://bsc-testnet-rpc.publicnode.com'
    ],
    explorer: 'https://testnet.bscscan.com',
    icon: '🧪', color: '#06D6A0'
  }
];

// popular ERC-20 tokens per network (address, symbol, decimals)
export const POPULAR_TOKENS = {
  1: [
    { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', symbol: 'USDT', decimals: 6 },
    { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: 6 },
    { address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', symbol: 'DAI', decimals: 18 },
    { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', symbol: 'WETH', decimals: 18 },
    { address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', symbol: 'WBTC', decimals: 8 },
    { address: '0x514910771AF9Ca656af840dff83E8264EcF986CA', symbol: 'LINK', decimals: 18 },
    { address: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', symbol: 'UNI', decimals: 18 },
    { address: '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9', symbol: 'AAVE', decimals: 18 },
    { address: '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE', symbol: 'SHIB', decimals: 18 },
    { address: '0x7D1AfA7B718fb893dB30A3aBc0Cfc608AaCfeBB0', symbol: 'MATIC', decimals: 18 },
    { address: '0xB50721BCf8d664c30412Cfbc6cf7a15145234ad1', symbol: 'ARB', decimals: 18 },
    { address: '0x4200000000000000000000000000000000000042', symbol: 'OP', decimals: 18 },
    { address: '0x6982508145454Ce325dDbE47a25d4ec3d2311933', symbol: 'PEPE', decimals: 18 },
    { address: '0xD533a949740bb3306d119CC777fa900bA034cd52', symbol: 'CRV', decimals: 18 },
    { address: '0xC011a73ee8576Fb46F5E1c5751cA3B9Fe0af2a6F', symbol: 'SNX', decimals: 18 },
    { address: '0x6B3595068778DD592e39A122f4f5a5cF09C90fE2', symbol: 'SUSHI', decimals: 18 },
    { address: '0xc00e94Cb662C3520282E6f5717214004A7f26888', symbol: 'COMP', decimals: 18 },
    { address: '0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2', symbol: 'MKR', decimals: 18 },
    { address: '0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32', symbol: 'LDO', decimals: 18 }
  ],
  11155111: [
    { address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', symbol: 'USDC', decimals: 6 },
    { address: '0x779877A7B0D9E8603169DdbD7836e478b4624789', symbol: 'LINK', decimals: 18 }
  ],
  137: [
    { address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', symbol: 'USDC', decimals: 6 },
    { address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', symbol: 'USDT', decimals: 6 }
  ],
  8453: [
    { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6 }
  ],
  42161: [
    { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', symbol: 'USDC', decimals: 6 },
    { address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', symbol: 'USDT', decimals: 6 }
  ],
  10: [
    { address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', symbol: 'USDC', decimals: 6 }
  ],
  56: [
    { address: '0x55d398326f99059fF775485246999027B3197955', symbol: 'USDT', decimals: 18 },
    { address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', symbol: 'USDC', decimals: 18 }
  ]
};

// ERC-20 ABI (minimal)
export const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function transfer(address,uint256) returns (bool)',
  'event Transfer(address indexed,address indexed,uint256)',
  'event Approval(address indexed,address indexed,uint256)'
];

// ERC-721 ABI (minimal)
export const ERC721_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function balanceOf(address) view returns (uint256)',
  'function tokenOfOwnerByIndex(address,uint256) view returns (uint256)',
  'function tokenURI(uint256) view returns (string)',
  'function ownerOf(uint256) view returns (address)'
];

// ERC-1155 ABI (minimal)
export const ERC1155_ABI = [
  'function balanceOf(address,uint256) view returns (uint256)',
  'function uri(uint256) view returns (string)'
];

// EIP-7702 constants
export const EIP7702 = {
  MAGIC: '0x05',
  DELEGATION_PREFIX: '0xef0100',
  ZERO_ADDRESS: '0x0000000000000000000000000000000000000000',
  GAS_PER_AUTH: 25000
};

// ═══════════════════════════════════════════════════════════════
// CHAIN_PRESETS — catalogue for the "Add network" picker.
//
// The 12 networks in NETWORKS are what the app ships with. These are the OTHER
// common EVM chains, offered as one-tap presets so nobody has to type a name,
// chainId, symbol, explorer and RPC by hand. Every entry's RPC was verified to
// answer eth_chainId with the chainId claimed here (see docs/CHAIN-PRESETS.md
// for the probe output). Picking one pre-fills the whole form; the RPC field
// stays editable for anyone behind a private endpoint.
// ═══════════════════════════════════════════════════════════════
export const CHAIN_PRESETS = [
  { name: 'Celo', chainId: 42220, type: 'mainnet', symbol: 'CELO', icon: '🟠', color: '#FCFF52',
    rpc: ['https://celo-rpc.publicnode.com'], explorer: 'https://celoscan.io' },
  { name: 'Gnosis', chainId: 100, type: 'mainnet', symbol: 'xDAI', icon: '🦊', color: '#04795B',
    rpc: ['https://gnosis-rpc.publicnode.com'], explorer: 'https://gnosisscan.io' },
  { name: 'Avalanche C-Chain', chainId: 43114, type: 'mainnet', symbol: 'AVAX', icon: '❄️', color: '#E84142',
    rpc: ['https://avalanche-c-chain-rpc.publicnode.com'], explorer: 'https://snowtrace.io' },
  { name: 'Sonic', chainId: 146, type: 'mainnet', symbol: 'S', icon: '🎵', color: '#F2A72B',
    rpc: ['https://sonic-rpc.publicnode.com'], explorer: 'https://sonicscan.org' },
  { name: 'Linea', chainId: 59144, type: 'mainnet', symbol: 'ETH', icon: '📐', color: '#61DFFF',
    rpc: ['https://linea-rpc.publicnode.com'], explorer: 'https://lineascan.build' },
  { name: 'Scroll', chainId: 534352, type: 'mainnet', symbol: 'ETH', icon: '📜', color: '#FFB0B0',
    rpc: ['https://scroll-rpc.publicnode.com'], explorer: 'https://scrollscan.com' },
  { name: 'Blast', chainId: 81457, type: 'mainnet', symbol: 'ETH', icon: '💥', color: '#FCFC03',
    rpc: ['https://blast-rpc.publicnode.com'], explorer: 'https://blastscan.io' },
  { name: 'Mantle', chainId: 5000, type: 'mainnet', symbol: 'MNT', icon: '🔱', color: '#65B3AE',
    rpc: ['https://mantle-rpc.publicnode.com'], explorer: 'https://mantlescan.xyz' },
  { name: 'Moonbeam', chainId: 1284, type: 'mainnet', symbol: 'GLMR', icon: '🌙', color: '#53CBC8',
    rpc: ['https://1rpc.io/glmr'], explorer: 'https://moonbeam.moonscan.io' },
  { name: 'Cronos', chainId: 25, type: 'mainnet', symbol: 'CRO', icon: '⏱️', color: '#002D74',
    rpc: ['https://evm.cronos.org'], explorer: 'https://cronoscan.com' },
  { name: 'Aurora', chainId: 1313161554, type: 'mainnet', symbol: 'ETH', icon: '🌅', color: '#70D44B',
    rpc: ['https://mainnet.aurora.dev'], explorer: 'https://explorer.aurora.dev' },
  { name: 'Polygon zkEVM', chainId: 1101, type: 'mainnet', symbol: 'ETH', icon: '🟪', color: '#8247E5',
    rpc: ['https://zkevm-rpc.com'], explorer: 'https://zkevm.polygonscan.com' },
  { name: 'Mode', chainId: 34443, type: 'mainnet', symbol: 'ETH', icon: '🎼', color: '#FF6E00',
    rpc: ['https://1rpc.io/mode'], explorer: 'https://explorer.mode.network' },
  { name: 'Metis Andromeda', chainId: 1088, type: 'mainnet', symbol: 'METIS', icon: '🟠', color: '#00DACC',
    rpc: ['https://andromeda.metis.io/?owner=1088'], explorer: 'https://explorer.metis.io' },
  { name: 'hoodi', chainId: 560048, type: 'testnet', symbol: 'ETH', icon: '🧪', color: '#8B95C4',
    rpc: ['https://ethereum-hoodi-rpc.publicnode.com'], explorer: 'https://hoodi.etherscan.io' }
];
// Chains deliberately NOT listed, because no public RPC answered eth_chainId
// with the claimed id at verification time: Holesky (17000 — deprecated by
// Ethereum, superseded by Hoodi) and Celo Sepolia (44787). Re-add them only once
// `.probe-chains.mjs` reports OK; shipping an unverified preset would let the
// picker add a network that silently talks to the wrong chain.

// custom networks stored in localStorage
const CUSTOM_KEY = 'bear.customNetworks';

export function getCustomNetworks() {
  try { return JSON.parse(localStorage.getItem(CUSTOM_KEY) || '[]'); }
  catch { return []; }
}

export function addCustomNetwork(net) {
  const list = getCustomNetworks();
  list.push({ ...net, id: 'custom-' + Date.now(), type: net.type || 'mainnet', custom: true });
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(list));
  return list;
}

export function removeCustomNetwork(id) {
  const list = getCustomNetworks().filter(n => n.id !== id);
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(list));
  return list;
}

// Per-network custom RPC overrides. A built-in network's rpc list lives in a
// module constant, so unshifting onto it in memory produced a setting that
// vanished on the next reload: the user added an RPC, saw "Custom RPC added",
// refreshed, and was back on the public endpoint with no trace of what they had
// set. These are stored per network id and re-applied on load.
const RPC_OVERRIDE_KEY = 'bear.rpcOverrides';

export function getRpcOverrides() {
  try {
    const v = JSON.parse(localStorage.getItem(RPC_OVERRIDE_KEY) || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

/** Put `url` at the front of `netId`'s endpoint list, and remember it. */
export function addRpcOverride(netId, url) {
  const all = getRpcOverrides();
  const list = Array.isArray(all[netId]) ? all[netId] : [];
  const next = [url, ...list.filter((u) => u !== url)];
  all[netId] = next;
  try { localStorage.setItem(RPC_OVERRIDE_KEY, JSON.stringify(all)); } catch { /* private mode */ }
  return next;
}

export function removeRpcOverride(netId, url) {
  const all = getRpcOverrides();
  if (Array.isArray(all[netId])) {
    all[netId] = all[netId].filter((u) => u !== url);
    if (!all[netId].length) delete all[netId];
  }
  try { localStorage.setItem(RPC_OVERRIDE_KEY, JSON.stringify(all)); } catch { /* private mode */ }
  return all[netId] || [];
}

/** Push every stored override onto the in-memory network it belongs to. */
export function applyRpcOverrides() {
  const all = getRpcOverrides();
  for (const [id, urls] of Object.entries(all)) {
    const net = NETWORKS.find((n) => n.id === id)
      || getCustomNetworks().find((n) => n.id === id);
    if (!net || !Array.isArray(urls)) continue;
    net.rpc = [...urls.filter((u) => !net.rpc.includes(u)), ...net.rpc];
  }
  return all;
}

/** Which node the current provider is actually talking to, for display. */
export function providerEndpoint(provider) {
  return provider?.bearEndpoint || null;
}

export function getAllNetworks() {
  const all = [...NETWORKS, ...getCustomNetworks()];
  // Settings → Testnet mode OFF hides every testnet from choosers.
  const settings = get('settings') || {};
  if (settings.testnet === false) return all.filter(n => n.type !== 'testnet');
  return all;
}

export function getNetwork(chainId) {
  return getAllNetworks().find(n => n.chainId === Number(chainId));
}

export function getNetworkById(id) {
  const found = getAllNetworks().find(n => n.id === id);
  if (found) return found;
  // A stale/unknown saved networkId must not turn every feature into
  // "Cannot read properties of undefined (reading 'chainId')".
  console.warn('[BearTool] unknown networkId "' + id + '" — falling back to ethereum');
  return getAllNetworks().find(n => n.id === 'ethereum') || NETWORKS[0];
}

// try RPCs in order, return first working provider
export async function getProvider(chainId) {
  const net = getNetwork(chainId);
  if (!net) throw new Error('Unknown network chainId ' + chainId);
  const failures = [];

  // The first entry is a user override when one is stored. That endpoint is the
  // one they asked for, and quietly using a DIFFERENT node instead is how a
  // wallet fails for no visible reason: a fresh anvil fork can take a while to
  // answer its first call, the probe times out, and the loop walks on to the
  // public endpoint — which then rejects anvil_setBalance, reports a balance
  // the user never funded, and answers estimateGas for an account that does not
  // exist on the real chain. Every symptom traced back to this one silent
  // substitution, so an override that fails now fails LOUDLY.
  const override = (getRpcOverrides()[net.id] || [])[0];
  const urls = override ? [override, ...net.rpc.filter((u) => u !== override)] : net.rpc;

  for (const url of urls) {
    try {
      const p = new ethers.JsonRpcProvider(url, Number(chainId), { staticNetwork: true });
      // Bounded probe: an endpoint that accepts the connection but never
      // answers would otherwise hang here forever, leaving the UI spinning.
      // One budget, for every attempt, including the first. I gave the first
      // attempt 3x on the theory that a local node may still be initialising;
      // the test that watches for unbounded waits caught the cost immediately —
      // a dead endpoint then held the UI for 24s instead of 8. A cold fork is
      // better fixed by warming the node than by making every dead socket
      // three times worse to discover.
      await withTimeout(p.getBlockNumber(), RPC_TIMEOUT_MS, url);
      // Remember which node answered, so the UI can show it. A provider whose
      // origin is invisible is a provider nobody can debug.
      try { Object.defineProperty(p, 'bearEndpoint', { value: url, enumerable: true }); } catch { /* frozen */ }
      return p;
    } catch (e) {
      failures.push(`${url} (${e?.message || e})`);
      if (url === override) {
        throw new Error(
          `Your RPC for ${net.name} did not answer: ${url} — ${e?.message || e}. `
          + 'Fix Settings → Custom RPC, or remove it to use the default endpoints.',
        );
      }
    }
  }
  throw new Error(`All RPCs failed for ${net.name} — ` + failures.join('; '));
}

// detect EIP-7702 delegation: returns delegate address or null
export async function getDelegation(provider, address) {
  const code = await provider.getCode(address);
  if (!code || code === '0x') return null;
  if (code.startsWith(EIP7702.DELEGATION_PREFIX)) {
    // 0xef0100 (8 chars) + 40-hex address
    return '0x' + code.slice(8);
  }
  return null; // regular contract or plain EOA
}

// current gas price via eth_gasPrice RPC (fallback to feeData)
export async function getGasPrice(provider) {
  if (!provider) return 0n;
  try {
    const hex = await withTimeout(provider.send('eth_gasPrice', []), RPC_TIMEOUT_MS, 'eth_gasPrice');
    return BigInt(hex);
  } catch {
    try {
      const feeData = await withTimeout(provider.getFeeData(), RPC_TIMEOUT_MS, 'getFeeData');
      return feeData.gasPrice || 0n;
    } catch { return 0n; }
  }
}

// USD prices for a token list (delegates to price.js — single source of truth)
export function fetchPrices(tokens, chainId) {
  return fetchAllPrices(tokens, chainId);
}