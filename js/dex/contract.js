// ═══════════════════════════════════════════════════════════════
// Bear Tool — js/dex-contract.js
// The ABIs the Dex panels call. ONE source of truth: the app builds
// every Dex transaction from these strings and the gate tests read
// this exact file — so what the UI signs and what the tests prove
// cannot be two different ABIs.
//
// There is no curve contract here any more. The Dex's coins are three
// ERC-20s that already exist on Sepolia (DEX_PRESETS in js/dex.js):
// probed 2026-10-13, each answers symbol()/decimals()/balanceOf() and
// each reverts on tokenReserve()/ethReserve() — they are not bonding
// curves and the Create/Curve panels that would have minted one are
// gone with them. Every pair side is one of those tokens; Sepolia ETH
// pays gas and is never quoted, never swapped, never in reserves.
// ═══════════════════════════════════════════════════════════════

// Uniswap V2 on Sepolia — official table (docs.uniswap.org v2 deployments,
// read 2026-10-13) AND probed on-chain the same day through the Tenderly
// gateway: factory.allPairsLength() = 18223 (the deployment is live),
// factory.feeTo() = 0x0, router.WETH() = 0xfFf997…6B14 which matches the
// WETH9 contract that answers name() = "Wrapped Ether", decimals() = 18, and
// factory.createPair(WETH, WETH) reverts with the canonical
// "UniswapV2: IDENTICAL_ADDRESSES". A remembered address is not a verified
// address: the selectors used for those probes were computed with ethers,
// not recalled.
export const UNISWAP_V2 = {
  11155111: {
    factory: '0xF62c03E08ada871A0bEb309762E260a7a6a880E6',
    router: '0xeE567Fe1712Faf6149d80dA1E6934E354124CfE3',
    weth: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14',
  },
};

// The Dex never offers a WETH side: liquidity and swaps are token<->token
// between two of DEX_PRESETS (user order: ETH/WETH is gas ONLY, the custom
// coin is the main coin). The WETH() getter stays in the ABI because the
// router itself answers it, not because the UI offers it.
export const V2_ROUTER_ABI = [
  'function factory() view returns (address)',
  'function WETH() view returns (address)',
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[])',
  'function addLiquidity(address tokenA, address tokenB, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) payable returns (uint256, uint256, uint256)',
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[])',
];

export const V2_FACTORY_ABI = [
  'function getPair(address tokenA, address tokenB) view returns (address)',
  'function allPairsLength() view returns (uint256)',
];

export const V2_PAIR_ABI = [
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
];

// Minimal ERC-20 for allowance/approve on a preset token. Kept here rather
// than imported from network.js so this file stays the one ABI source the
// Dex gate reads.
export const DEX_ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];
