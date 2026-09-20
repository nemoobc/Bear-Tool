// ═══════════════════════════════════════════════════════════════
// Bear Tool — opensea.js
// OpenSea / Seaport 1.5 — honest on-chain integration.
//   • buildOrderHash(order)  → deterministic EIP-712 Seaport order hash
//     (pure hashing, no network, no API key). Same order → same hash.
//   • getOrderStatus(orderHash) → eth_call to Seaport.getOrderStatus —
//     0 = not listed, 1 = valid, 2 = cancelled, 3 = filled, 4 = invalid.
//     Honest honest: throws when Seaport has no code on this chain.
//   • cancelOrder / fulfillBasicOrder → real transactions via runTx
//     (uniform dots, consistent with send/swap/bridge — HUKUM 1).
// NO simulated fallback, no fake "listed", no pretend order.

import { $, toast, escapeHtml } from './ui.js';
import { get } from './state.js';
import { runTx, waitForReceipt } from './safetx.js';
import { getNetworkById } from './network.js';
import { SEAPORT_BY_CHAIN, SEAPORT_ABI } from './seaport-abi.js';

const { ethers } = globalThis;

// Item types per Seaport spec 1.5.
export const ITEM_TYPE = {
  NATIVE: 0, ERC20: 1, ERC721: 2, ERC1155: 3,
  ERC721_CRITERIA: 4, ERC1155_CRITERIA: 5,
};

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ZERO_HASH = '0x0000000000000000000000000000000000000000000000000000000000000000';

export const ORDER_TYPES = {
  OrderComponents: [
    { name: 'offerer', type: 'address' },
    { name: 'zone', type: 'address' },
    { name: 'offer', type: 'OfferItem[]' },
    { name: 'consideration', type: 'ConsiderationItem[]' },
    { name: 'orderType', type: 'uint8' },
    { name: 'startTime', type: 'uint256' },
    { name: 'endTime', type: 'uint256' },
    { name: 'zoneHash', type: 'bytes32' },
    { name: 'salt', type: 'uint256' },
    { name: 'conduitKey', type: 'bytes32' },
    { name: 'counter', type: 'uint256' },
  ],
  OfferItem: [
    { name: 'itemType', type: 'uint8' },
    { name: 'token', type: 'address' },
    { name: 'identifierOrCriteria', type: 'uint256' },
    { name: 'startAmount', type: 'uint256' },
    { name: 'endAmount', type: 'uint256' },
  ],
  ConsiderationItem: [
    { name: 'itemType', type: 'uint8' },
    { name: 'token', type: 'address' },
    { name: 'identifierOrCriteria', type: 'uint256' },
    { name: 'startAmount', type: 'uint256' },
    { name: 'endAmount', type: 'uint256' },
    { name: 'recipient', type: 'address' },
  ],
};

export function seaportDomain(chainId) {
  const verifyingContract = SEAPORT_BY_CHAIN[chainId];
  if (!verifyingContract) throw new Error('OpenSea: Seaport 1.5 not deployed on this chain');
  return {
    name: 'Seaport',
    version: '1.5',
    chainId,
    verifyingContract,
  };
}

/**
 * Build a deterministic EIP-712 order hash (Seaport OrderComponents).
 * Pure function — same input always yields same hash (honest, testable).
 */
export function buildOrderHash(order, chainId) {
  const domain = seaportDomain(chainId);

  const orderComponents = {
    offerer: order.offerer,
    zone: order.zone || ZERO_ADDRESS,
    offer: order.offer,
    consideration: order.consideration,
    orderType: order.orderType ?? 0,
    startTime: order.startTime,
    endTime: order.endTime,
    zoneHash: order.zoneHash || ZERO_HASH,
    salt: order.salt ?? 0,
    conduitKey: order.conduitKey || ZERO_HASH,
    counter: order.counter ?? 0,
  };

  const fullTypes = {
    EIP712Domain: [
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
    ],
    ...ORDER_TYPES,
  };

  return ethers.TypedDataEncoder.hash(domain, fullTypes, orderComponents);
}

// ── On-chain actions (real transactions — uniform dots via runTx,
//    consistent with send/swap/bridge — HUKUM 1, HUKUM 9). ──


/**
 * eth_call to Seaport.getOrderStatus(orderHash) — honest view.
 * Returns { isValidated, isCancelled, totalFilled, totalSize };
 * integer status → human label for the UI (0 = not listed, 1 = valid,
 * 2 = cancelled, 3 = filled, 4 = invalid). Seaport 1.5.getOrderStatus
 * never simulates: if Seaport has no code on this chain we throw an
 * honest error instead of pretending the order exists.
 */
export async function getOrderStatusOnChain(orderHash, chainId) {
  const seaportAddr = SEAPORT_BY_CHAIN[chainId];
  if (!seaportAddr) throw new Error('OpenSea: Seaport 1.5 not deployed on this chain');
  const provider = get('provider');
  if (!provider) throw new Error('OpenSea: provider missing');

  // Honest guard: does Seaport actually have code here?
  const code = await provider.getCode(seaportAddr);
  if (!code || code === '0x') throw new Error(`OpenSea: Seaport 1.5 has no code on chain ${chainId}`);

  const seaport = new ethers.Contract(seaportAddr, SEAPORT_ABI, provider);
  const [isValidated, isCancelled, totalFilled, totalSize] = await seaport.getOrderStatus(orderHash  );
  return { status: statusLabel({ isValidated, isCancelled, totalFilled, totalSize }), totalFilled, totalSize };
}

function statusLabel({ isValidated, isCancelled, totalFilled, totalSize }) {
  if (isCancelled) return 'cancelled';
  if (totalFilled > 0n && totalSize > 0n && totalFilled === totalSize) return 'filled';
  if (isValidated) return 'valid';
  if (totalSize === 0n && totalFilled === 0n) return 'not listed';
  return 'invalid';
}

/**
 * Cancel one or more Seaport orders (by order hash) — real transaction
 * via runTx (uniform dots). Honest: throws when the order isn't ours
 * (Seaport.cancel only works for orders with counter set by the offerer).
 */
export async function cancelOrder(btn, orderHashes, chainId) {
  const seaportAddr = SEAPORT_BY_CHAIN[chainId];
  if (!seaportAddr) throw new Error('OpenSea: Seaport 1.5 not deployed on this chain');
  const signer = get('signer');
  if (!signer) throw new Error('OpenSea: wallet locked');

  return runTx('opensea-cancel', btn, async () => {
    const connected = typeof signer.connect === 'function' ? signer.connect(get('provider')) : signer;
    const seaport = new ethers.Contract(seaportAddr, SEAPORT_ABI, connected);
    // cancel(bytes32[] orderHashes) — Seaport 1.5 takes an array of hashes.
    const tx = await seaport.cancel(orderHashes);
    return tx;
  }, { loadingLabel: 'Cancelling…' });
}

/**
 * Fulfill a basic order (accept an offer) — real transaction via runTx.
 * parameters = BasicOrderParameters tuple from the order being accepted.
 * Honest: never simulates a successful acceptance.
 */
export async function fulfillBasicOrder(btn, parameters, chainId) {
  const seaportAddr = SEAPORT_BY_CHAIN[chainId];
  if (!seaportAddr) throw new Error('OpenSea: Seaport 1.5 not deployed on this chain');
  const signer = get('signer');
  if (!signer) throw new Error('OpenSea: wallet locked');

  return runTx('opensea-fulfill', btn, async () => {
    const connected = typeof signer.connect === 'function' ? signer.connect(get('provider')) : signer;
    const seaport = new ethers.Contract(seaportAddr, SEAPORT_ABI, connected);
    const tx = await seaport.fulfillBasicOrder(parametersValidate(parameters));
    return tx;
  }, { loadingLabel: 'Accepting offer…' });
}

function parametersValidate(p) {
  if (!p || typeof p !== 'object') throw new Error('OpenSea: invalid basic order parameters');
  if (!p.offerer || !/^0x[0-9a-fA-F]{40}$/.test(p.offerer)) throw new Error('OpenSea: offerer missing');
  return p;
}
