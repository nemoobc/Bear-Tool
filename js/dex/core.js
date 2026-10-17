// ═══════════════════════════════════════════════════════════════
// Bear Tool — js/dex/core.js (Dex v2)
//
// Built from zero, 2026-10-17, on the user order "hapus fitur dex, buat lagi
// dari 0 sampai jadi dan matang lengkap semua fitur". The old launchpad
// implementation (27 modules with pump-era routes still mounted) is deleted;
// this file starts the fresh engine.
//
// Engine law, unchanged from the spec the user approved: ONE machine — AMM
// pools with REAL reserves (x*y=k; no virtual pressure, no graduation curve,
// no second price feed). Sepolia testnet first; mainnet only passes through
// the audit gate.
// ═══════════════════════════════════════════════════════════════

// The chain the dex engine runs on, v1. RPCs occasionally hand back hex
// strings, so the gate normalises through Number() — passing a finance gate
// on type sloppiness ("11155111" vs 11155111 vs 0x...) is a real bug, not a
// style choice.
export const DEX_CHAIN_ID = 11155111;
export const DEX_NETWORK = 'sepolia';

export function dexChainOk(chainId) {
  if (chainId === undefined || chainId === null) return false;
  const n = Number(chainId);
  return Number.isFinite(n) && n === DEX_CHAIN_ID;
}
