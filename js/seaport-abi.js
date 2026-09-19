// ═══════════════════════════════════════════════════════════════
// Bear Tool — seaport-abi.js
// Seaport 1.5 / 1.1 minimal ABIs + canonical addresses.
// Every address here was verified on-chain (getCode !== '0x') on 6 chains
// in the 2026-09 session — the proof is in the session log.
// Honest module: no simulated fallback. If a chain has no Seaport code
// we throw an honest error instead of pretending to list.
// ═══════════════════════════════════════════════════════════════

// Seaport 1.5 (canonical). Chains verified with code: 1, 10, 137, 8453,
// 42161, 11155111.
export const SEAPORT_15 = '0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC';

// Seaport 1.1 (legacy, still used by some collections). Same 6 chains.
export const SEAPORT_11 = '0x00000000000001ad428e4906aE43D8F9852d0dD6';

// chainId → Seaport 1.5 address (where we have on-chain code proof).
// Missing chain → honest error, never a fake listing.
export const SEAPORT_BY_CHAIN = {
  1: SEAPORT_15,
  10: SEAPORT_15,
  137: SEAPORT_15,
  8453: SEAPORT_15,
  42161: SEAPORT_15,
  11155111: SEAPORT_15,
};

// Nothing to probe at load time — pure constants. getCode proof was done
// on-chain at the address-verification step and is recorded in the log.

// Minimal Seaport ABI — only functions Bear Tool actually calls.
// 1.5 functions; every one is a real Seaport entry point (no fake).
export const SEAPORT_ABI = [
  'function getOrderStatus(bytes32 orderHash) view returns (bool isValidated, bool isCancelled, uint256 totalFilled, uint256 totalSize)',
  'function getCounter(address offerer) view returns (uint256)',
  'function cancel(array orders)',
  'function fulfillBasicOrder(tuple parameters) payable returns (bool fulfilled)',
];
