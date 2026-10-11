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
import { get, requireUnlock } from './state.js';
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

  // NO `EIP712Domain` entry here. ethers derives the domain type from the
  // `domain` object it was given, so declaring it again makes the type set
  // ambiguous and every call dies with "ambiguous primary types or unused
  // types: EIP712Domain, OrderComponents" (probe 2026-10-11 against the real
  // Seaport 1.5 on a mainnet fork). OrderComponents alone is the struct Seaport
  // hashes in _deriveOrderHash.
  return ethers.TypedDataEncoder.hash(domain, { ...ORDER_TYPES }, orderComponents);
}

// ── On-chain actions (real transactions — uniform dots via runTx,
//    consistent with send/swap/bridge — HUKUM 1, HUKUM 9). ──


/**
 * Publish a signed order to Seaport (`validate`) — this is what makes a listing
 * real and visible to buyers. Until it is sent, a computed orderHash is just a
 * number: nothing on the chain knows the order exists. The signature must be
 * over EIP-712(domain, OrderComponents) — the digest Seaport re-derives in
 * _verifySignature.
 * Real transaction via runTx (uniform dots).
 */
export async function validateOrder(btn, order, signature, chainId) {
  const seaportAddr = SEAPORT_BY_CHAIN[chainId];
  if (!seaportAddr) throw new Error('OpenSea: Seaport 1.5 not deployed on this chain');
  if (!get('unlocked')) { requireUnlock(); return; }
  const signer = get('signer');
  if (!signer) throw new Error('OpenSea: wallet locked');
  if (!order || !order.offerer) throw new Error('OpenSea: order is missing its offerer');
  if (!signature) throw new Error('OpenSea: order must be signed before it can be published');

  return runTx('opensea-validate', btn, async () => {
    const connected = typeof signer.connect === 'function' ? signer.connect(get('provider')) : signer;
    const seaport = new ethers.Contract(seaportAddr, SEAPORT_ABI, connected);
    return await seaport.validate(order, signature);
  }, { loadingLabel: 'Publishing listing…' });
}

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
 * Cancel one or more Seaport orders. Seaport 1.5 `cancel` takes the full
 * OrderComponents STRUCTS (it re-derives each hash and bumps the offerer's
 * counter) — passing bare bytes32 hashes, which is what this used to do, cannot
 * even encode against the ABI. The order objects therefore carry everything
 * Seaport needs; only the offerer's own orders can be cancelled (Seaport
 * enforces it, and we surface that failure rather than swallow it).
 * Real transaction via runTx (uniform dots). Honest: throws when Seaport has no
 * code on this chain.
 */
export async function cancelOrder(btn, orders, chainId) {
  const seaportAddr = SEAPORT_BY_CHAIN[chainId];
  if (!seaportAddr) throw new Error('OpenSea: Seaport 1.5 not deployed on this chain');
  // Item 12: locked wallet → raise the password prompt instead of throwing a
  // dead "wallet locked" error the user cannot act on from here.
  if (!get('unlocked')) { requireUnlock(); return; }
  const signer = get('signer');
  if (!signer) throw new Error('OpenSea: wallet locked');
  const list = Array.isArray(orders) ? orders : [orders];
  if (!list.length || list.some((o) => !o || !o.offerer)) {
    throw new Error('OpenSea: nothing to cancel — the order is missing its offerer');
  }

  return runTx('opensea-cancel', btn, async () => {
    const connected = typeof signer.connect === 'function' ? signer.connect(get('provider')) : signer;
    const seaport = new ethers.Contract(seaportAddr, SEAPORT_ABI, connected);
    const tx = await seaport.cancel(list);
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
  // Item 12: same as cancelOrder — locked → password prompt, not a dead error.
  if (!get('unlocked')) { requireUnlock(); return; }
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
