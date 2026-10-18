// ═══════════════════════════════════════════════════════════════
// Bear Tool — js/dex/abi.js (Dex v2) — the ABI the UI ships.
//
// Generated from DEX_SOLIDITY with the pinned solc 0.8.37 (the browser
// loader's pin) and trimmed to the fields ethers actually consumes:
// { type, name, stateMutability, inputs, outputs } with components kept
// (tuples need them to encode at all — the launch meta/socials structs).
// THE PINS LIVE IN tests/dex-abi.test.js: every entry must interoperate
// byte-wise with the codegen from the contract source, so a contract
// change is forced through here — the UI's ABI may never drift silently.
//
// Ships token + pair (traded surfaces, M3) + factory (discovery, M4).
// One namespace, never a partial hand-edit.
// ═══════════════════════════════════════════════════════════════

export const BEAR_TOKEN_ABI = [
      {"type":"constructor","stateMutability":"nonpayable","inputs":[{"name":"factory_","type":"address"},{"name":"meta","type":"tuple","components":[{"name":"name","type":"string"},{"name":"symbol","type":"string"},{"name":"image","type":"string"},{"name":"desc","type":"string"}]},{"name":"totalSupply_","type":"uint256"},{"name":"quoteToken_","type":"address"}]},
      {"type":"event","name":"Approval","inputs":[{"name":"owner","type":"address"},{"name":"spender","type":"address"},{"name":"value","type":"uint256"}]},
      {"type":"event","name":"SocialsSet","inputs":[{"name":"twitter","type":"string"},{"name":"telegram","type":"string"},{"name":"website","type":"string"}]},
      {"type":"event","name":"Transfer","inputs":[{"name":"from","type":"address"},{"name":"to","type":"address"},{"name":"value","type":"uint256"}]},
      {"type":"function","name":"allowance","stateMutability":"view","inputs":[{"name":"owner","type":"address"},{"name":"spender","type":"address"}],"outputs":[{"name":"","type":"uint256"}]},
      {"type":"function","name":"allowances","stateMutability":"view","inputs":[{"name":"","type":"address"},{"name":"","type":"address"}],"outputs":[{"name":"","type":"uint256"}]},
      {"type":"function","name":"approve","stateMutability":"nonpayable","inputs":[{"name":"spender","type":"address"},{"name":"value","type":"uint256"}],"outputs":[{"name":"","type":"bool"}]},
      {"type":"function","name":"balanceOf","stateMutability":"view","inputs":[{"name":"owner","type":"address"}],"outputs":[{"name":"","type":"uint256"}]},
      {"type":"function","name":"balances","stateMutability":"view","inputs":[{"name":"","type":"address"}],"outputs":[{"name":"","type":"uint256"}]},
      {"type":"function","name":"decimals","stateMutability":"view","outputs":[{"name":"","type":"uint8"}]},
      {"type":"function","name":"description","stateMutability":"view","outputs":[{"name":"","type":"string"}]},
      {"type":"function","name":"factory","stateMutability":"view","outputs":[{"name":"","type":"address"}]},
      {"type":"function","name":"imageURI","stateMutability":"view","outputs":[{"name":"","type":"string"}]},
      {"type":"function","name":"name","stateMutability":"view","outputs":[{"name":"","type":"string"}]},
      {"type":"function","name":"quoteToken","stateMutability":"view","outputs":[{"name":"","type":"address"}]},
      {"type":"function","name":"setSocials","stateMutability":"nonpayable","inputs":[{"name":"s","type":"tuple","components":[{"name":"twitter","type":"string"},{"name":"telegram","type":"string"},{"name":"website","type":"string"}]}]},
      {"type":"function","name":"socialsSet","stateMutability":"view","outputs":[{"name":"","type":"bool"}]},
      {"type":"function","name":"symbol","stateMutability":"view","outputs":[{"name":"","type":"string"}]},
      {"type":"function","name":"telegram","stateMutability":"view","outputs":[{"name":"","type":"string"}]},
      {"type":"function","name":"totalSupply","stateMutability":"view","outputs":[{"name":"","type":"uint256"}]},
      {"type":"function","name":"transfer","stateMutability":"nonpayable","inputs":[{"name":"to","type":"address"},{"name":"value","type":"uint256"}],"outputs":[{"name":"","type":"bool"}]},
      {"type":"function","name":"transferFrom","stateMutability":"nonpayable","inputs":[{"name":"from","type":"address"},{"name":"to","type":"address"},{"name":"value","type":"uint256"}],"outputs":[{"name":"","type":"bool"}]},
      {"type":"function","name":"twitter","stateMutability":"view","outputs":[{"name":"","type":"string"}]},
      {"type":"function","name":"website","stateMutability":"view","outputs":[{"name":"","type":"string"}]}
    ];

export const BEAR_FACTORY_ABI = [
      {"type":"constructor","stateMutability":"nonpayable","inputs":[{"name":"quote_","type":"address"}]},
      {"type":"event","name":"Launched","inputs":[{"name":"token","type":"address"},{"name":"pair","type":"address"},{"name":"launcher","type":"address"},{"name":"creatorFeeBps","type":"uint256"},{"name":"lpLockUntil","type":"uint64"},{"name":"lpShares","type":"uint256"}]},
      {"type":"function","name":"launch","stateMutability":"nonpayable","inputs":[{"name":"meta","type":"tuple","components":[{"name":"name","type":"string"},{"name":"symbol","type":"string"},{"name":"image","type":"string"},{"name":"desc","type":"string"},{"name":"twitter","type":"string"},{"name":"telegram","type":"string"},{"name":"website","type":"string"}]},{"name":"totalSupply_","type":"uint256"},{"name":"creatorFeeBps_","type":"uint256"},{"name":"lpLockUntil","type":"uint64"},{"name":"seedQuote","type":"uint256"},{"name":"seedToken","type":"uint256"},{"name":"minShares","type":"uint256"}],"outputs":[{"name":"tokenOut","type":"address"},{"name":"pairOut","type":"address"}]},
      {"type":"function","name":"pairOf","stateMutability":"view","inputs":[{"name":"","type":"address"}],"outputs":[{"name":"","type":"address"}]},
      {"type":"function","name":"quote","stateMutability":"view","outputs":[{"name":"","type":"address"}]},
      {"type":"function","name":"tokenCount","stateMutability":"view","outputs":[{"name":"","type":"uint256"}]},
      {"type":"function","name":"tokens","stateMutability":"view","inputs":[{"name":"","type":"uint256"}],"outputs":[{"name":"","type":"address"}]}
    ];

export const BEAR_PAIR_ABI = [
      {"type":"constructor","stateMutability":"nonpayable","inputs":[{"name":"factory_","type":"address"},{"name":"token_","type":"address"},{"name":"quote_","type":"address"},{"name":"creator_","type":"address"},{"name":"creatorFeeBps_","type":"uint256"}]},
      {"type":"event","name":"Approval","inputs":[{"name":"owner","type":"address"},{"name":"spender","type":"address"},{"name":"value","type":"uint256"}]},
      {"type":"event","name":"FeesClaimed","inputs":[{"name":"creator","type":"address"},{"name":"amount","type":"uint256"}]},
      {"type":"event","name":"LiquidityAdded","inputs":[{"name":"who","type":"address"},{"name":"shares","type":"uint256"}]},
      {"type":"event","name":"LiquidityRemoved","inputs":[{"name":"who","type":"address"},{"name":"shares","type":"uint256"}]},
      {"type":"event","name":"Locked","inputs":[{"name":"who","type":"address"},{"name":"until","type":"uint64"}]},
      {"type":"event","name":"Swap","inputs":[{"name":"who","type":"address"},{"name":"to","type":"address"},{"name":"amountIn","type":"uint256"},{"name":"amountOut","type":"uint256"},{"name":"quoteIn","type":"bool"}]},
      {"type":"event","name":"Transfer","inputs":[{"name":"from","type":"address"},{"name":"to","type":"address"},{"name":"value","type":"uint256"}]},
      {"type":"fallback","stateMutability":"payable"},
      {"type":"function","name":"addLiquidity","stateMutability":"nonpayable","inputs":[{"name":"quoteAmt","type":"uint256"},{"name":"tokenAmt","type":"uint256"},{"name":"minShares","type":"uint256"}],"outputs":[{"name":"made","type":"uint256"}]},
      {"type":"function","name":"allowance","stateMutability":"view","inputs":[{"name":"","type":"address"},{"name":"","type":"address"}],"outputs":[{"name":"","type":"uint256"}]},
      {"type":"function","name":"approve","stateMutability":"nonpayable","inputs":[{"name":"spender","type":"address"},{"name":"value","type":"uint256"}],"outputs":[{"name":"","type":"bool"}]},
      {"type":"function","name":"balanceOf","stateMutability":"view","inputs":[{"name":"","type":"address"}],"outputs":[{"name":"","type":"uint256"}]},
      {"type":"function","name":"claimFees","stateMutability":"nonpayable","outputs":[{"name":"paid","type":"uint256"}]},
      {"type":"function","name":"creator","stateMutability":"view","outputs":[{"name":"","type":"address"}]},
      {"type":"function","name":"creatorFeeBps","stateMutability":"view","outputs":[{"name":"","type":"uint256"}]},
      {"type":"function","name":"decimals","stateMutability":"view","outputs":[{"name":"","type":"uint8"}]},
      {"type":"function","name":"factory","stateMutability":"view","outputs":[{"name":"","type":"address"}]},
      {"type":"function","name":"getAmountOut","stateMutability":"view","inputs":[{"name":"quoteIn","type":"bool"},{"name":"amountIn","type":"uint256"}],"outputs":[{"name":"out","type":"uint256"}]},
      {"type":"function","name":"lastK","stateMutability":"view","outputs":[{"name":"","type":"uint256"}]},
      {"type":"function","name":"lock","stateMutability":"nonpayable","inputs":[{"name":"who","type":"address"},{"name":"until","type":"uint64"}]},
      {"type":"function","name":"lockOf","stateMutability":"view","inputs":[{"name":"who","type":"address"}],"outputs":[{"name":"","type":"uint64"}]},
      {"type":"function","name":"locks","stateMutability":"view","inputs":[{"name":"","type":"address"}],"outputs":[{"name":"","type":"uint256"}]},
      {"type":"function","name":"name","stateMutability":"view","outputs":[{"name":"","type":"string"}]},
      {"type":"function","name":"quote","stateMutability":"view","outputs":[{"name":"","type":"address"}]},
      {"type":"function","name":"removeLiquidity","stateMutability":"nonpayable","inputs":[{"name":"shares","type":"uint256"},{"name":"minQuote","type":"uint256"},{"name":"minToken","type":"uint256"}],"outputs":[{"name":"outQuote","type":"uint256"},{"name":"outToken","type":"uint256"}]},
      {"type":"function","name":"reserves","stateMutability":"view","outputs":[{"name":"quoteReserve","type":"uint256"},{"name":"tokenReserve","type":"uint256"}]},
      {"type":"function","name":"swapQuoteForToken","stateMutability":"nonpayable","inputs":[{"name":"amountIn","type":"uint256"},{"name":"minOut","type":"uint256"},{"name":"to","type":"address"}],"outputs":[{"name":"out","type":"uint256"}]},
      {"type":"function","name":"swapTokenForQuote","stateMutability":"nonpayable","inputs":[{"name":"amountIn","type":"uint256"},{"name":"minOut","type":"uint256"},{"name":"to","type":"address"}],"outputs":[{"name":"out","type":"uint256"}]},
      {"type":"function","name":"symbol","stateMutability":"view","outputs":[{"name":"","type":"string"}]},
      {"type":"function","name":"token","stateMutability":"view","outputs":[{"name":"","type":"address"}]},
      {"type":"function","name":"totalFeesCreator","stateMutability":"view","outputs":[{"name":"","type":"uint256"}]},
      {"type":"function","name":"totalSupply","stateMutability":"view","outputs":[{"name":"","type":"uint256"}]},
      {"type":"function","name":"transfer","stateMutability":"nonpayable","inputs":[{"name":"to","type":"address"},{"name":"value","type":"uint256"}],"outputs":[{"name":"","type":"bool"}]},
      {"type":"function","name":"transferFrom","stateMutability":"nonpayable","inputs":[{"name":"from","type":"address"},{"name":"to","type":"address"},{"name":"value","type":"uint256"}],"outputs":[{"name":"","type":"bool"}]},
      {"type":"receive","stateMutability":"payable"}
    ];
