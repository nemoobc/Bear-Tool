// ═══════════════════════════════════════════════════════════════
// Bear Tool — routers.js
// Router registry: all DEX aggregators + bridges for every chain.
// Single source of truth — swap.js and bridge.js import from here.
// ═══════════════════════════════════════════════════════════════

// ── DEX Router Registry ─────────────────────────────────────
// Each entry: { name, type ('aggregator'|'dex'|'amm'), chains: [chainId], api?, router?, quoter? }
export const SWAP_ROUTERS = [
  // ── Aggregators (API-based, best price routing) ──
  {
    id: 'kyberswap', name: 'KyberSwap', type: 'aggregator',
    chains: [1, 10, 56, 137, 8453, 42161],
    api: 'https://aggregator-api.kyberswap.com',
  },
  {
    id: '1inch', name: '1inch', type: 'aggregator',
    chains: [1, 10, 56, 137, 8453, 42161, 43114, 250, 1313161554, 100, 59144, 137, 80002, 421614, 11155420, 84532, 97, 11155111],
    api: 'https://api.1inch.dev/swap/v6.0',
  },
  {
    id: 'paraswap', name: 'ParaSwap', type: 'aggregator',
    chains: [1, 137, 10, 56, 42161, 8453],
    api: 'https://api.paraswap.io',
  },
  {
    id: 'openocean', name: 'OpenOcean', type: 'aggregator',
    chains: [1, 56, 137, 42161, 10, 8453, 250, 43114, 1313161554, 100],
    api: 'https://openapi.openocean.finance',
  },
  // ── DEX Routers (on-chain, same as Uniswap-compatible) ──
  {
    id: 'uniswap_v3', name: 'Uniswap V3', type: 'dex',
    chains: [1, 10, 137, 42161, 8453],
    router: { 1: '0xE592427A0AEce92De3Edee1F18E0157C05861564', 10: '0xE592427A0AEce92De3Edee1F18E0157C05861564', 137: '0xE592427A0AEce92De3Edee1F18E0157C05861564', 42161: '0xE592427A0AEce92De3Edee1F18E0157C05861564', 8453: '0xE592427A0AEce92De3Edee1F18E0157C05861564' },
    quoter: { 1: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e', 10: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e', 137: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e', 42161: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e', 8453: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e' },
  },
  {
    id: 'uniswap_v2', name: 'Uniswap V2', type: 'dex',
    chains: [1, 10, 137, 42161, 11155111],
    router: { 1: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D', 10: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D', 137: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D', 42161: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D', 11155111: '0xeE567Fe1712Faf6149d80dA1E6934E354124CfE3' },
  },
  {
    id: 'sushiswap', name: 'SushiSwap', type: 'dex',
    chains: [1, 137, 42161, 10, 56, 43114, 250, 8453],
    router: {
      1: '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F',     // Ethereum
      137: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',   // Polygon
      42161: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506', // Arbitrum
      10: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',    // Optimism
      56: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',    // BSC
      43114: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506', // Avalanche
      250: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',   // Fantom
      8453: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',  // Base
    },
  },
  {
    id: 'camelot', name: 'Camelot DEX', type: 'dex',
    chains: [42161],  // Arbitrum-only
    router: { 42161: '0xc873fEcbd354f5A56E00E710B9cEFf27455E8AA2' },
  },
  {
    id: 'aerodrome', name: 'Aerodrome', type: 'dex',
    chains: [8453],  // Base-only
    router: { 8453: '0xcF77a3Ba9A5CA399B7c97c74d54e3b4f7CdeC441' },
  },
];

// ── Bridge Router Registry ──────────────────────────────────
export const BRIDGE_ROUTERS = [
  {
    id: 'lifi', name: 'LI.FI', type: 'aggregator',
    chains: [1, 10, 56, 137, 8453, 42161, 43114, 250, 1313161554, 100, 11155111, 80002, 421614, 11155420, 84532, 97],
    api: 'https://li.quest/v1',
  },
  {
    id: 'socket', name: 'Socket', type: 'aggregator',
    chains: [1, 10, 56, 137, 8453, 42161, 43114, 250, 1313161554],
    api: 'https://api.socket.tech/v2',
  },
  {
    id: 'stargate', name: 'Stargate (LayerZero)', type: 'protocol',
    chains: [1, 10, 56, 137, 42161, 8453, 43114, 1313161554],
    // Stargate router contracts per chain
    router: {
      1: '0x8731d54E9D02c286767d56ac03e8037C07e01e98',
      10: '0x45f1A95A4D3f3836523F5c83673c797f4d4d263B',
      56: '0x4a364f8c717cAADb79a13D774bca9b8B67C9CF2C',
      137: '0x45f1A95A4D3f3836523F5c83673c797f4d4d263B',
      42161: '0x8731d54E9D02c286767d56ac03e8037C07e01e98',
      8453: '0x45f1A95A4D3f3836523F5c83673c797f4d4d263B',
      43114: '0x45f1A95A4D3f3836523F5c83673c797f4d4d263B',
      1313161554: '0x8731d54E9D02c286767d56ac03e8037C07e01e98',
    },
  },
  {
    id: 'across', name: 'Across Protocol', type: 'protocol',
    chains: [1, 10, 137, 42161, 8453],
    api: 'https://app.across.to/api',
  },
  {
    id: 'hop', name: 'Hop Protocol', type: 'protocol',
    chains: [1, 10, 137, 42161, 8453],
    api: 'https://api.hop.exchange',
  },
  {
    id: 'wormhole', name: 'Wormhole', type: 'protocol',
    chains: [1, 56, 137, 42161, 10, 8453, 43114, 1313161554],
    api: 'https://api.wormhole.com',
  },
  {
    id: 'bungee', name: 'Bungee (Socket)', type: 'aggregator',
    chains: [1, 10, 56, 137, 8453, 42161, 43114, 250],
    api: 'https://api.socket.tech/v2',
  },
  {
    id: 'synapse', name: 'Synapse Protocol', type: 'protocol',
    chains: [1, 10, 56, 137, 42161, 8453, 43114, 250, 1313161554],
    router: {
      1: '0x1111111254fb6c44bACbebd6F8Db4A46dec74958',
      10: '0x1111111254fb6c44bACbebd6F8Db4A46dec74958',
      56: '0x1111111254fb6c44bACbebd6F8Db4A46dec74958',
      137: '0x1111111254fb6c44bACbebd6F8Db4A46dec74958',
      42161: '0x1111111254fb6c44bACbebd6F8Db4A46dec74958',
      8453: '0x1111111254fb6c44bACbebd6F8Db4A46dec74958',
    },
  },
];

// ── Helper: get routers available for a specific chain ──
export function getSwapRoutersForChain(chainId) {
  return SWAP_ROUTERS.filter(r => r.chains.includes(Number(chainId)));
}

export function getBridgeRoutersForChain(chainId) {
  return BRIDGE_ROUTERS.filter(r => r.chains.includes(Number(chainId)));
}

// ── Helper: auto-detect best router (aggregator first, then dex) ──
export function getBestSwapRouter(chainId) {
  const available = getSwapRoutersForChain(chainId);
  if (!available.length) return null;
  // Priority: aggregator (API-based) > DEX (on-chain)
  const agg = available.find(r => r.type === 'aggregator');
  return agg || available[0];
}

export function getBestBridgeRouter(fromChainId, toChainId) {
  const fromRouters = getBridgeRoutersForChain(fromChainId);
  const toRouters = getBridgeRoutersForChain(toChainId);
  // Router must support BOTH chains
  const fromIds = new Set(fromRouters.map(r => r.id));
  const common = toRouters.filter(r => fromIds.has(r.id));
  if (!common.length) return fromRouters[0] || null;
  const agg = common.find(r => r.type === 'aggregator');
  return agg || common[0];
}

// ── Helper: all supported chain IDs (union of all routers) ──
export function getAllSwapChainIds() {
  const ids = new Set();
  SWAP_ROUTERS.forEach(r => r.chains.forEach(c => ids.add(c)));
  return [...ids].sort((a, b) => a - b);
}

export function getAllBridgeChainIds() {
  const ids = new Set();
  BRIDGE_ROUTERS.forEach(r => r.chains.forEach(c => ids.add(c)));
  return [...ids].sort((a, b) => a - b);
}

// ── Chain name map for display ──
export const CHAIN_NAMES = {
  1: 'Ethereum', 10: 'Optimism', 56: 'BSC', 137: 'Polygon',
  42161: 'Arbitrum', 8453: 'Base', 43114: 'Avalanche', 250: 'Fantom',
  1313161554: 'Aurora', 100: 'Gnosis', 59144: 'Linea', 1686: 'Mint',
  11155111: 'Sepolia', 80002: 'Amoy', 421614: 'Arb Sepolia',
  11155420: 'OP Sepolia', 84532: 'Base Sepolia', 97: 'BSC Testnet',
};
