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
  // ── 2026-10-05 growth: 4 L1 + 7 L2 promoted from CHAIN_PRESETS ──
  // Every RPC below answered eth_chainId with the claimed id (probe, same day,
  // docs/research/bridge-tokens-2026-10-05.md): ≥2 endpoints each, publicnode
  // or drpc among them. All 11 confirmed inside LI.FI's 70-chain EVM set, so
  // the bridge router covers every shipped mainnet (routers.test.js pins it).
  {
    id: 'avalanche', name: 'Avalanche C-Chain', chainId: 43114, type: 'mainnet',
    symbol: 'AVAX', decimals: 18,
    rpc: [
      'https://avalanche-c-chain-rpc.publicnode.com',
      'https://api.avax.network/ext/bc/C/rpc'
    ],
    explorer: 'https://snowtrace.io',
    icon: '❄️', color: '#E84142'
  },
  {
    id: 'gnosis', name: 'Gnosis', chainId: 100, type: 'mainnet',
    symbol: 'xDAI', decimals: 18,
    rpc: [
      'https://gnosis-rpc.publicnode.com',
      'https://rpc.gnosischain.com'
    ],
    explorer: 'https://gnosisscan.io',
    icon: '🦊', color: '#04795B'
  },
  {
    id: 'celo', name: 'Celo', chainId: 42220, type: 'mainnet',
    symbol: 'CELO', decimals: 18,
    rpc: [
      'https://celo-rpc.publicnode.com',
      'https://forno.celo.org'
    ],
    explorer: 'https://celoscan.io',
    icon: '🟠', color: '#FCFF52'
  },
  {
    id: 'sonic', name: 'Sonic', chainId: 146, type: 'mainnet',
    symbol: 'S', decimals: 18,
    rpc: [
      'https://sonic-rpc.publicnode.com',
      'https://rpc.soniclabs.com'
    ],
    explorer: 'https://sonicscan.org',
    icon: '🎵', color: '#F2A72B'
  },
  {
    id: 'linea', name: 'Linea', chainId: 59144, type: 'mainnet',
    symbol: 'ETH', decimals: 18,
    rpc: [
      'https://linea-rpc.publicnode.com',
      'https://rpc.linea.build'
    ],
    explorer: 'https://lineascan.build',
    icon: '📐', color: '#61DFFF'
  },
  {
    id: 'scroll', name: 'Scroll', chainId: 534352, type: 'mainnet',
    symbol: 'ETH', decimals: 18,
    rpc: [
      'https://scroll-rpc.publicnode.com',
      'https://rpc.scroll.io'
    ],
    explorer: 'https://scrollscan.com',
    icon: '📜', color: '#FFB0B0'
  },
  {
    id: 'blast', name: 'Blast', chainId: 81457, type: 'mainnet',
    symbol: 'ETH', decimals: 18,
    rpc: [
      'https://blast-rpc.publicnode.com',
      'https://rpc.blast.io'
    ],
    explorer: 'https://blastscan.io',
    icon: '💥', color: '#FCFC03'
  },
  {
    id: 'mantle', name: 'Mantle', chainId: 5000, type: 'mainnet',
    symbol: 'MNT', decimals: 18,
    rpc: [
      'https://mantle-rpc.publicnode.com',
      'https://rpc.mantle.xyz'
    ],
    explorer: 'https://mantlescan.xyz',
    icon: '🔱', color: '#65B3AE'
  },
  {
    id: 'zksync', name: 'zkSync Era', chainId: 324, type: 'mainnet',
    symbol: 'ETH', decimals: 18,
    rpc: [
      'https://mainnet.era.zksync.io',
      'https://zksync.drpc.org'
    ],
    explorer: 'https://explorer.zksync.io',
    icon: '🔁', color: '#8C8DFC'
  },
  {
    id: 'unichain', name: 'Unichain', chainId: 130, type: 'mainnet',
    symbol: 'ETH', decimals: 18,
    rpc: [
      'https://mainnet.unichain.org',
      'https://unichain-rpc.publicnode.com'
    ],
    explorer: 'https://unichain.blockscout.com',
    icon: '🦄', color: '#FF00A0'
  },
  {
    id: 'worldchain', name: 'World Chain', chainId: 480, type: 'mainnet',
    symbol: 'ETH', decimals: 18,
    rpc: [
      'https://worldchain.drpc.org',
      'https://worldchain-mainnet.g.alchemy.com/public'
    ],
    explorer: 'https://worldscan.org',
    icon: '🌎', color: '#2F343B'
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
    { address: '0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32', symbol: 'LDO', decimals: 18 },
    // Moved here from the DUPLICATE POPULAR_TOKENS that lived inside js/swap.js
    // (2026-10-05): swap re-exports this map now, so the four exotic swap-list
    // entries come along instead of being dropped.
    { address: '0xae78736Cd615f374D3085123A210448E74Fc6393', symbol: 'rETH', decimals: 18 },
    { address: '0xBe9895146f7AF43049ca1c1AE358B0541Ea49704', symbol: 'cbETH', decimals: 18 },
    { address: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0', symbol: 'wstETH', decimals: 18 },
    { address: '0x9e1028F5F1D5eDE59748FFceE5532509976840E0', symbol: 'FRAX', decimals: 18 }
  ],
  11155111: [
    { address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', symbol: 'USDC', decimals: 6 },
    { address: '0x779877A7B0D9E8603169DdbD7836e478b4624789', symbol: 'LINK', decimals: 18 },
    { address: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14', symbol: 'WETH', decimals: 18 }
  ],
  // ── 2026-10-05: the "list coin sesuaikan" pass ──
  // Every shipped chain now carries a curated list. Addresses come from
  // docs/research/bridge-tokens-2026-10-05.md (97 rows, each probe-verified
  // on-chain: eth_getCode + decimals() + symbol() + EIP-55, same day).
  // SYMBOL_DIFF rows wear the ON-CHAIN symbol (polygon USDT reads USDT0,
  // arbitrum USDT reads USD₮0, BSC's WETH reads ETH). Legacy *.e/USDbC twins
  // are left out on purpose: they read back the SAME symbol as the native
  // issuance, which would put two identical labels in one picker.
  10: [
    { address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', symbol: 'DAI', decimals: 18 },
    { address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', symbol: 'USDC', decimals: 6 },
    { address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', symbol: 'USDT', decimals: 6 },
    { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18 }
  ],
  56: [
    { address: '0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3', symbol: 'DAI', decimals: 18 },
    { address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', symbol: 'USDC', decimals: 18 },
    { address: '0x55d398326f99059fF775485246999027B3197955', symbol: 'USDT', decimals: 18 },
    { address: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8', symbol: 'ETH', decimals: 18 }
  ],
  100: [
    { address: '0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83', symbol: 'USDC', decimals: 6 },
    { address: '0x4ECaBa5870353805a9F068101A40E0f32ed605C6', symbol: 'USDT', decimals: 6 },
    { address: '0x8e5bBbb09Ed1ebdE8674Cda39A0c169401db4252', symbol: 'WBTC', decimals: 8 },
    { address: '0x6A023CCd1ff6F2045C3309768eAd9E68F978f6e1', symbol: 'WETH', decimals: 18 }
  ],
  130: [
    { address: '0x20CAb320A855b39F724131C69424240519573f81', symbol: 'DAI', decimals: 18 },
    { address: '0x078D782b760474a361dDA0AF3839290b0EF57AD6', symbol: 'USDC', decimals: 6 },
    { address: '0x0555E30da8f98308EdB960aa94C0Db47230d2B9c', symbol: 'WBTC', decimals: 8 },
    { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18 }
  ],
  137: [
    { address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', symbol: 'USDC', decimals: 6 },
    { address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', symbol: 'USDT0', decimals: 6 },
    { address: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063', symbol: 'DAI', decimals: 18 },
    { address: '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6', symbol: 'WBTC', decimals: 8 },
    { address: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', symbol: 'WETH', decimals: 18 }
  ],
  146: [
    { address: '0x29219dd400f2Bf60E5a23d13Be72B486D4038894', symbol: 'USDC', decimals: 6 },
    { address: '0x6047828dc181963ba44974801FF68e538dA5eaF9', symbol: 'USDT', decimals: 6 },
    { address: '0x0555E30da8f98308EdB960aa94C0Db47230d2B9c', symbol: 'WBTC', decimals: 8 },
    { address: '0x50c42dEAcD8Fc9773493ED674b675bE577f2634b', symbol: 'WETH', decimals: 18 }
  ],
  324: [
    { address: '0x1d17CBcF0D6D143135aE902365D2E5e2A16538D4', symbol: 'USDC', decimals: 6 },
    { address: '0x493257fD37EDB34451f62EDf8D2a0C418852bA4C', symbol: 'USDT', decimals: 6 },
    { address: '0xBBeB516fb02a01611cBBE0453Fe3c580D7281011', symbol: 'WBTC', decimals: 8 },
    { address: '0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91', symbol: 'WETH', decimals: 18 }
  ],
  480: [
    { address: '0x79A02482A880bCE3F13e09Da970dC34db4CD24d1', symbol: 'USDC', decimals: 6 },
    { address: '0x03C7054BCB39f7b2e5B2c7AcB37583e32D70Cfa3', symbol: 'WBTC', decimals: 8 },
    { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18 }
  ],
  42161: [
    { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', symbol: 'USDC', decimals: 6 },
    { address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', symbol: 'USD₮0', decimals: 6 },
    { address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', symbol: 'DAI', decimals: 18 },
    { address: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', symbol: 'WBTC', decimals: 8 },
    { address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', symbol: 'WETH', decimals: 18 }
  ],
  42220: [
    { address: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C', symbol: 'USDC', decimals: 6 },
    { address: '0x617f3112bf5397D0467D315cC709EF968D9ba546', symbol: 'USDT', decimals: 6 },
    { address: '0x90Ca507a5D4458a4C6C6249d186b6dCb02a5BCCd', symbol: 'DAI', decimals: 18 },
    { address: '0xBAAB46E28388d2779e6E31Fd00cF0e5Ad95E327B', symbol: 'WBTC', decimals: 8 },
    { address: '0x122013fd7dF1C6F636a5bb8f03108E876548b455', symbol: 'WETH', decimals: 18 }
  ],
  43114: [
    { address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', symbol: 'USDC', decimals: 6 },
    { address: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', symbol: 'USDt', decimals: 6 },
    { address: '0xd586E7F844cEa2F87f50152665BCbc2C279D8d70', symbol: 'DAI.e', decimals: 18 },
    { address: '0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB', symbol: 'WETH.e', decimals: 18 },
    { address: '0x50b7545627a5162F82A992c33b87aDc75187B218', symbol: 'WBTC.e', decimals: 8 }
  ],
  5000: [
    { address: '0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9', symbol: 'USDC', decimals: 6 },
    { address: '0x201EBa5CC46D216Ce6DC03F6a759e8E766e956aE', symbol: 'USDT', decimals: 6 },
    { address: '0xCAbAE6f6Ea1ecaB08Ad02fE02ce9A44F09aebfA2', symbol: 'WBTC', decimals: 8 },
    { address: '0xdEAddEaDdeadDEadDEADDEAddEADDEAddead1111', symbol: 'WETH', decimals: 18 }
  ],
  534352: [
    { address: '0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4', symbol: 'USDC', decimals: 6 },
    { address: '0xf55BEC9cafDbE8730f096Aa55dad6D22d44099Df', symbol: 'USDT', decimals: 6 },
    { address: '0xcA77eB3fEFe3725Dc33bccB54eDEFc3D9f764f97', symbol: 'DAI', decimals: 18 },
    { address: '0x3C1BCa5a656e69edCD0D4E36BEbb3FcDAcA60Cf1', symbol: 'WBTC', decimals: 8 },
    { address: '0x5300000000000000000000000000000000000004', symbol: 'WETH', decimals: 18 }
  ],
  59144: [
    { address: '0x176211869cA2b568f2A7D4EE941E073a821EE1ff', symbol: 'USDC', decimals: 6 },
    { address: '0xA219439258ca9da29E9Cc4cE5596924745e12B93', symbol: 'USDT', decimals: 6 },
    { address: '0x4AF15ec2A0BD43Db75dd04E62FAA3B8EF36b00d5', symbol: 'DAI', decimals: 18 },
    { address: '0x3aAB2285ddcDdaD8edf438C1bAB47e1a9D05a9b4', symbol: 'WBTC', decimals: 8 },
    { address: '0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f', symbol: 'WETH', decimals: 18 }
  ],
  81457: [
    { address: '0x4300000000000000000000000000000000000003', symbol: 'USDB', decimals: 18 },
    { address: '0xF7bc58b8D8f97ADC129cfC4c9f45Ce3C0E1D2692', symbol: 'WBTC', decimals: 8 },
    { address: '0x4300000000000000000000000000000000000004', symbol: 'WETH', decimals: 18 }
  ],
  8453: [
    { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6 },
    { address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', symbol: 'USDT', decimals: 6 },
    { address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', symbol: 'DAI', decimals: 18 },
    { address: '0x0555E30da8f98308EdB960aa94C0Db47230d2B9c', symbol: 'WBTC', decimals: 8 },
    { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18 }
  ],
  80002: [
    { address: '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582', symbol: 'USDC', decimals: 6 }
  ],
  421614: [
    { address: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d', symbol: 'USDC', decimals: 6 },
    { address: '0x980B62Da83eFf3D4576C647993b0c1D7faf17c73', symbol: 'WETH', decimals: 18 }
  ],
  84532: [
    { address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', symbol: 'USDC', decimals: 6 },
    { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18 }
  ],
  11155420: [
    { address: '0x5fd84259d66Cd46123540766Be93DFE6D43130D7', symbol: 'USDC', decimals: 6 },
    { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18 }
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
// The 23 networks in NETWORKS are what the app ships with. These are the OTHER
// common EVM chains, offered as one-tap presets so nobody has to type a name,
// chainId, symbol, explorer and RPC by hand. Every entry's RPC was verified to
// answer eth_chainId with the chainId claimed here (see docs/CHAIN-PRESETS.md
// for the probe output). Picking one pre-fills the whole form; the RPC field
// stays editable for anyone behind a private endpoint.
// ═══════════════════════════════════════════════════════════════
export const CHAIN_PRESETS = [
  // 2026-10-05: the 8 presets that graduated into NETWORKS (Celo, Gnosis,
  // Avalanche, Sonic, Linea, Scroll, Blast, Mantle) are gone from here — a
  // chain listed BOTH as shipped and as an addable preset is the same network
  // in two places (HUKUM 10). zksync/unichain/worldchain went straight into
  // NETWORKS (never presets). What remains are the OTHER common EVM chains.
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
  { name: 'Hoodi', chainId: 560048, type: 'testnet', symbol: 'ETH', icon: '🧪', color: '#8B95C4',
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

// ── network type detection (auto) ─────────────────────────────────────────
// Testnet chain ids that are neither in NETWORKS nor CHAIN_PRESETS but must
// still land as testnet when their RPC is pasted into Add Network. Kept
// explicit: there is no on-chain way to ask "are you a testnet?", and the
// fallback for an unknown REMOTE chain is deliberately 'mainnet' — mislabelling
// a testnet mainnet only adds a warning, mislabelling a mainnet testnet
// removes the danger prompt (live report 2026-10-03: pasting Sepolia's RPC
// put a MAINNET badge on the network list).
const TESTNET_CHAIN_IDS = new Set([
  5,        // Goerli
  17000,    // Holesky
  80001,    // Polygon Mumbai
  43113,    // Avalanche Fuji
  59140,    // Linea Sepolia
  534351,   // Scroll Sepolia
]);
// Dev chains: anvil/hardhat defaults. Exported so verify.js can be honest
// about a chain no public explorer has ever heard of (M10).
export const LOCAL_DEV_CHAIN_IDS = new Set([1337, 31337]);

/**
 * Is this RPC endpoint a loopback/dev node? Single home for the host test —
 * detectNetworkType() labels those chains testnet AND verify.js refuses to
 * claim a public explorer exists for them, from one list of hosts.
 * @param {string} rpcUrl
 */
export function isLoopbackRpc(rpcUrl) {
  try {
    const h = new URL(String(rpcUrl || '')).hostname.toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]'
      || h.endsWith('.localhost');
  } catch { /* not a URL — a custom entry can be a bare host:port */ }
  const bare = String(rpcUrl || '').toLowerCase();
  return bare.startsWith('localhost') || bare.startsWith('127.0.0.1')
    || bare.startsWith('[::1]') || bare.startsWith('::1');
}

/**
 * Verdict for a chain: 'testnet' | 'mainnet'.
 * @param {number|string} chainId
 * @param {string} [rpcUrl] loopback endpoints are dev nodes — including a
 *   mainnet FORK — and are labelled testnet regardless of the chain id.
 */
export function detectNetworkType(chainId, rpcUrl) {
  if (isLoopbackRpc(rpcUrl)) return 'testnet';
  const id = Number(chainId);
  if (LOCAL_DEV_CHAIN_IDS.has(id)) return 'testnet';
  // The app's own catalogues already carry a verdict per chain.
  const known = NETWORKS.find(n => Number(n.chainId) === id)
    || CHAIN_PRESETS.find(p => Number(p.chainId) === id);
  if (known) return known.type;
  if (TESTNET_CHAIN_IDS.has(id)) return 'testnet';
  return 'mainnet';
}

export function addCustomNetwork(net) {
  const list = getCustomNetworks();
  // Fallback type is DETECTED, not assumed mainnet.
  list.push({ ...net, id: 'custom-' + Date.now(),
    type: net.type || detectNetworkType(net.chainId, Array.isArray(net.rpc) ? net.rpc[0] : net.rpc),
    custom: true });
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
  // The ACTIVE network wins when it carries this chainId. getNetwork() finds
  // the FIRST chainId match in [...NETWORKS, ...custom], so a user endpoint
  // added for an existing chain (Add Network → paste 127.0.0.1:8546 → chain
  // 11155111) was shadowed by the builtin entry: the picker showed the custom
  // network as active while every call silently ran on the default public
  // node — a funded fork read as balance 0 (live bug; the same silent-
  // substitution class the override refusal below was written against).
  // ChainId mismatches fall through to the old lookup, so cross-chain
  // getProvider(chainId) callers behave exactly as before.
  const activeId = get('networkId');
  const active = getAllNetworks().find(
    (n) => n.id === activeId && n.chainId === Number(chainId),
  );
  const net = active || getNetwork(chainId);
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
    // An override is the endpoint the user picked on purpose, and when it does
    // not work that is the answer — not a reason to carry on against a default
    // they did not choose. This guard used to live only inside the catch, so the
    // `continue` below stepped over it: a wrong-chain override was recorded in
    // `failures` and then silently replaced by a public node, and every on-chain
    // call ran on a chain the user never asked for. Every failure path for the
    // override goes through here now.
    const refuse = (why) => {
      failures.push(`${url} (${why})`);
      if (url === override) {
        // Marked so the catch below can recognise it. A refusal thrown from
        // inside the try used to be caught by that same try's own catch, which
        // re-wrapped it — the user saw the sentence and the hint twice, and the
        // doubled text reads like a stutter rather than an error.
        throw Object.assign(
          new Error(
            `Your RPC for ${net.name} did not answer: ${url} — ${why}. `
            + 'Fix Settings → Custom RPC, or remove it to use the default endpoints.',
          ),
          { bearRpcRefusal: true },
        );
      }
    };
    try {
      // batchMaxCount: 1 — ONE request per POST, stall window off (ethers
      // forces stallTime 0 at maxCount 1, provider-jsonrpc.js:257). ethers
      // defaults queue everything into JSON-ARRAY posts (batchMaxCount 100,
      // stall 10ms), and getFeeData alone fires THREE parallel calls — so the
      // first payload of every send is an array. An endpoint (or middlebox)
      // that rejects or swallows arrays kills every tx at the fee step while
      // sequential reads keep working: the reported "fundex sends, Bear never
      // does" shape, 100% reproducible, invisible to a suite that runs on
      // anvil (which accepts arrays). fundex/viem never batches. Three small
      // single posts per fee fetch is the cheapest reliability in this file.
      const p = new ethers.JsonRpcProvider(url, Number(chainId), { staticNetwork: true, batchMaxCount: 1 });
      // `staticNetwork: true` tells ethers to TRUST the chainId above and skip
      // eth_chainId entirely — so `p.getNetwork()` returns the number we
      // declared, and every chain check built on it (bridge's four TOCTOU
      // re-checks, deploy's registry entry) compares a constant with itself.
      // A wrong or hostile endpoint would then be filed under a chain the
      // contract does not exist on. Ask the node, and refuse it if it disagrees.
      //
      // The answer is read into a variable and compared outside the try on
      // purpose. Refusing from inside that block would be caught by the very
      // catch meant to tolerate a node that simply lacks eth_chainId, and the
      // refusal would be swallowed — which is the bug this replaces.
      let reported = null;
      let unverifiable = null;
      try {
        // eth_chainId is a local lookup, and the blockNumber probe below also
        // proves the socket works — so a 3s budget is generous. It must not
        // double the time the user waits before the next candidate is tried.
        reported = await withTimeout(p.send('eth_chainId', []), 3000, url);
      } catch (e) {
        unverifiable = e?.shortMessage || e?.message || e;
      }
      if (reported !== null && BigInt(reported) !== BigInt(chainId)) {
        refuse(`reports chain ${reported}, expected ${chainId}`);
        continue;
      }
      if (unverifiable !== null) {
        // A node that cannot answer eth_chainId is one we cannot verify — but
        // refusing outright would break every endpoint that simply does not
        // implement it, which is far more common than a node that lies.
        // Unverifiable is not the same as known-wrong: note it and continue.
        failures.push(`${url} (chain id unverified: ${unverifiable})`);
      }
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
      // Already the answer. Wrapping it again would duplicate every sentence.
      if (e && e.bearRpcRefusal) throw e;
      refuse(e?.message || String(e));
    }
  }
  throw new Error(`All RPCs failed for ${net.name} — ` + failures.join('; '));
}

// detect EIP-7702 delegation: returns delegate address or null
export async function getDelegation(provider, address) {
  const code = await provider.getCode(address);
  if (!code || code === '0x') return null;
  if (code.startsWith(EIP7702.DELEGATION_PREFIX)) {
    // 0xef0100 (8 chars) then the delegation target.
    const raw = code.slice(8);
    // A revoke does NOT clear the code to 0x. Per EIP-7702 it rewrites the
    // designation to the zero address, so eth_getCode comes back as 0xef0100
    // followed by zeros. Reporting that as "delegated to 0x0000…0000" is wrong
    // twice over: the status line would call a revoked account still
    // delegated, and revokeDelegation() — which reads any non-null answer as
    // "still delegated" — would report a SUCCESSFUL revoke as a failure. The
    // user would be told their revoke did not work, and be right not to.
    //
    // Only the first 20 bytes are the target. Comparing the whole remainder
    // would miss a revoked account if the node emits the wider 32-byte zero
    // form, which several clients do.
    const target20 = '0x' + raw.slice(0, 40).toLowerCase();
    if (target20 === EIP7702.ZERO_ADDRESS) return null;
    return '0x' + raw;
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