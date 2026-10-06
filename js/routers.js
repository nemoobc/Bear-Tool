// ═══════════════════════════════════════════════════════════════
// Bear Tool — routers.js
// Router registry: single source of truth for swap.js and bridge.js.
//
// Every address in this file was VERIFIED on 2026-09-27 against the chain it
// claims, by calling the contract rather than reading it:
//
//   - eth_getCode at `latest` on at least two independent public endpoints
//   - eth_call of WETH() (V2 family) or WETH9() (V3 family) plus factory()
//
// That check is what removed four entries this file used to carry. Camelot
// 0xc873fEcbd354f5A56E00E710B9cEFf27455E8AA2 and Aerodrome
// 0xcF77a3Ba9A5CA399B7c97c74d54e3b4f7CdeC441 have NO CODE on Arbitrum and Base.
// Uniswap V3's SwapRouter02 does not exist on Base either, while the entry
// claimed chain 8453 for it. A user who picked any of those was sending a swap
// into an address with nothing behind it.
//
// Two rules follow, and they are why some obvious candidates are absent:
//
//   1. No address may be listed for a chain where it does not answer. A CREATE2
//      address is the same string everywhere it is deployed and meaningless
//      everywhere else — Uniswap's QuoterV2 is on 1/10/137/42161/8453 and is
//      absent on BNB, BSC testnet and Sepolia, so it is listed per chain.
//
//   2. No venue is listed unless the wallet can actually execute it. PancakeSwap
//      V3 is deployed and reachable, and it is still not here: its SmartRouter
//      takes a different params struct from Uniswap's, so it needs its own
//      builder and its own on-chain test. Listing it untested would put a
//      route-shaped dead end in the dropdown, which is the exact thing this
//      rewrite is removing.
//
// API keys: measured, not assumed. 1inch answers 401 and Bungee 403, so both are
// gone. KyberSwap, ParaSwap and LI.FI answer 200 with no credential and stay —
// including a previous note in this project claiming LI.FI had started
// requiring a key, which was wrong; /v1/quote returns a full
// transactionRequest unauthenticated.
//
// See tools/verify-routers.mjs to re-run the check. Addresses rot.

// ── DEX routers: on-chain, no API, no key ────────────────────────────────
// abi: which calldata builder swap.js must use. 'v2' is the Uniswap V2
// interface (swapExactTokensForTokens + getAmountsOut), 'v3' is exactInputSingle
// through a QuoterV2. Everything marked 'v2' is a Uniswap-V2-compatible fork,
// which is why one builder covers all of them.
export const SWAP_ROUTERS = [
  {
    id: 'uniswap_v3', name: 'Uniswap V3', type: 'dex', abi: 'v3',
    chains: [1, 10, 137, 42161],
    router: {
      1: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
      10: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
      137: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
      42161: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    },
    // QuoterV2, CREATE2 — same address on every chain it is deployed on.
    quoter: {
      1: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
      10: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
      137: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
      42161: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    },
  },
  {
    id: 'uniswap_v2', name: 'Uniswap V2', type: 'dex', abi: 'v2',
    chains: [1, 10, 56, 137, 42161, 11155111],
    router: {
      1: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
      10: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
      56: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
      137: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
      42161: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
      11155111: '0xeE567Fe1712Faf6149d80dA1E6934E354124CfE3',
    },
  },
  {
    id: 'sushiswap', name: 'SushiSwap', type: 'dex', abi: 'v2',
    chains: [1, 137, 42161],
    router: {
      1: '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F',
      137: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
      42161: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
    },
  },
  {
    id: 'quickswap', name: 'QuickSwap', type: 'dex', abi: 'v2',
    chains: [137],
    router: { 137: '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff' },
  },
  {
    id: 'baseswap', name: 'BaseSwap', type: 'dex', abi: 'v2',
    chains: [8453],
    router: { 8453: '0x327Df1E6de05895d2ab08513aaDD9313Fe505d86' },
  },

  // ── Aggregators that answer without a credential ───────────────────────
  // These are kept because they were measured working, not because they are
  // famous. A 400 from a router means it read the request and disliked the
  // parameters; a 401 or 403 is the only thing that means "bring a key".
  {
    id: 'kyberswap', name: 'KyberSwap', type: 'aggregator',
    chains: [1, 10, 56, 137, 42161, 8453],
    api: 'https://aggregator-api.kyberswap.com',
  },
  {
    id: 'paraswap', name: 'ParaSwap', type: 'aggregator',
    chains: [1, 10, 56, 137, 42161, 8453],
    api: 'https://api.paraswap.io',
  },
];

// ── Bridge routers ──────────────────────────────────────────────────────
// LI.FI only. It is the one bridge route that both needs no key and returns a
// ready transactionRequest, which is what the executor needs — a route the
// wallet can sign rather than a protocol named on a list.
//
// Gone, and the reason is measured rather than assumed: Socket/Bungee 403,
// Across 404, Hop 530, Wormhole 522, Synapse 404, Stargate unreachable,
// OpenOcean unreachable. deBridge DLN (api.dln.trade) answered 400 with a bare
// nginx HTML page on EVERY probe — five of them re-run 2026-10-03, each HTTP
// 400 / 150 bytes of the same `<html>…<hr><center>nginx</center></html>` body:
// (1) GET /v1/chainPairs, (2) GET /v1/quote with full params, (3) GET
// /v1/order-book, (4) POST /v1/quote with a JSON body, (5) GET /v1/quote over
// HTTP/2 — all sent with a browser UA and an Origin header (evidence:
// tests/fixtures/dln/ — body_dln1…body_dln5 + status.txt, all five identical
// 400/150-byte nginx bodies; re-measured by tests/fixtures/dln/measure.sh). It never
// returned JSON, so no builder can be written against it and it is not
// carried. A bridge entry the wallet cannot execute is a dead end in a
// dropdown, so an unreachable service is not carried as a route.
export const BRIDGE_ROUTERS = [
  {
    id: 'lifi', name: 'LI.FI', type: 'aggregator',
    // The chains Bear Tool can actually be pointed at ∩ the chains LI.FI can
    // quote. This list used to include Avalanche, Fantom, Aurora and Gnosis —
    // which were in no network list in js/network.js — so the registry claimed
    // routes to chains the wallet cannot connect to, and the README repeated
    // it as "all chains". A route that requires a chain the app does not have
    // is a dead end, exactly like a router with no contract behind it.
    // 2026-10-05: +11 chains with the network growth (all 17 mainnets probe-
    // confirmed inside LI.FI's 70-chain EVM set, research A5); −97/80002, which
    // LI.FI REJECTS with HTTP 400 code 1011 while they sat in this list — a
    // dead route offered in a picker is worse than no route. Routers.test.js
    // pins: chains ⊆ NETWORKS, no 97/80002, every shipped mainnet covered.
    chains: [
      1, 10, 56, 137, 8453, 42161,            // original six mainnets
      43114, 100, 42220, 146,                  // +4 L1: Avalanche, Gnosis, Celo, Sonic
      59144, 534352, 81457, 5000, 324, 130, 480, // +7 L2: Linea, Scroll, Blast, Mantle, zkSync, Unichain, World Chain
      84532, 421614, 11155111, 11155420        // testnets (97 & 80002 removed: LI.FI 400)
    ],
    api: 'https://li.quest/v1',
  },
  // ── Gas.zip — measured keyless 2026-10-06 ─────────────────────────────
  // GET backend.gas.zip/v2/chains → 200 unauthenticated; GET
  // /v2/quotes/<from>/<wei>/<to>?from=&to= → 200 with a ready-to-send
  // contractDepositTxn (to + data + value). Their screening rejects a
  // flagged address with HTTP 400 "Address has been flagged as high risk"
  // — a real, honest failure surfaced by the adapter, not a key problem.
  // nativeOnly: the quote route takes deposit_wei, so an ERC-20 never has
  // a Gas.zip quote to give; the adapter refuses before any fetch.
  {
    id: 'gaszip', name: 'Gas.zip', type: 'aggregator', nativeOnly: true,
    // Every chain in Gas.zip's /v2/chains (186) ∩ NETWORKS — all 23 shipped
    // networks were present in the probe response.
    chains: [
      1, 10, 56, 97, 100, 130, 137, 146, 324, 480, 5000, 8453, 42161, 42220,
      43114, 59144, 81457, 534352, 84532, 11155111, 11155420, 421614, 80002,
    ],
    api: 'https://backend.gas.zip/v2',
  },
  // ── Relay — measured keyless 2026-10-06 ───────────────────────────────
  // POST api.relay.link/quote/v2 → 200 with no credential (the OpenAPI marks
  // x-api-key optional "for higher rate limits"). Response carries ordered
  // steps: an `approve` step for ERC-20 (spender read from the calldata) and
  // a `deposit` step that is the transaction to sign.
  {
    id: 'relay', name: 'Relay', type: 'aggregator',
    // api.relay.link/chains → 60 chains ∩ NETWORKS = the 17 shipped
    // mainnets. None of the six testnets is in Relay's list (their testnet
    // API is a separate host), so no testnet claim is made here.
    chains: [
      1, 10, 56, 100, 130, 137, 146, 324, 480, 5000, 8453, 42161, 42220,
      43114, 59144, 81457, 534352,
    ],
    api: 'https://api.relay.link',
  },
];

// ── Lookup helpers ──────────────────────────────────────────────────────
export function getSwapRoutersForChain(chainId) {
  return SWAP_ROUTERS.filter((r) => r.chains.includes(Number(chainId)));
}

export function getSwapRouter(id, chainId) {
  return SWAP_ROUTERS.find((r) => r.id === id) || null;
}

/** The router contract for one entry on one chain, or null if not deployed there. */
export function getRouterAddress(id, chainId) {
  const r = getSwapRouter(id, chainId);
  if (!r || !r.router) return null;
  return r.router[Number(chainId)] || null;
}

export function getQuoterAddress(id, chainId) {
  const r = getSwapRouter(id, chainId);
  if (!r || !r.quoter) return null;
  return r.quoter[Number(chainId)] || null;
}

export function getBridgeRoutersForChain(chainId) {
  return BRIDGE_ROUTERS.filter((r) => r.chains.includes(Number(chainId)));
}

// Aggregator first: they route across venues and usually price better than a
// single pool. The order after that follows the registry.
export function getBestSwapRouter(chainId) {
  const available = getSwapRoutersForChain(chainId);
  if (!available.length) return null;
  return available.find((r) => r.type === 'aggregator') || available[0];
}

export function getBestBridgeRouter(fromChainId, toChainId) {
  const fromRouters = getBridgeRoutersForChain(fromChainId);
  const toRouters = getBridgeRoutersForChain(toChainId);
  const fromIds = new Set(fromRouters.map((r) => r.id));
  const common = toRouters.filter((r) => fromIds.has(r.id));
  return common[0] || fromRouters[0] || null;
}

export function getAllSwapChainIds() {
  const ids = new Set();
  SWAP_ROUTERS.forEach((r) => r.chains.forEach((c) => ids.add(c)));
  return [...ids].sort((a, b) => a - b);
}

export function getAllBridgeChainIds() {
  const ids = new Set();
  BRIDGE_ROUTERS.forEach((r) => r.chains.forEach((c) => ids.add(c)));
  return [...ids].sort((a, b) => a - b);
}

// ── Chain name map for display ──────────────────────────────────────────
// Trimmed to the networks Bear Tool actually supports (js/network.js). The
// previous map listed Avalanche, Fantom, Gnosis, Linea and others with no
// network behind them, so a router entry could name a chain the wallet could
// not connect to.
export const CHAIN_NAMES = {
  1: 'Ethereum', 10: 'Optimism', 56: 'BNB', 137: 'Polygon',
  42161: 'Arbitrum', 8453: 'Base',
  11155111: 'Sepolia', 80002: 'Amoy', 421614: 'Arb Sepolia',
  11155420: 'OP Sepolia', 84532: 'Base Sepolia', 97: 'BSC Testnet',
};
