// Bear Tool — js/dex/factory.js
// The factory: deploying it, remembering it, and the one place its address is
// read from. A v2 DEX has ONE factory per chain; every pool is born from it,
// and discovery (pools.js) filters its logs by this address.
//
// Deployment runs through the SAME two seams the rest of the app uses:
//   • js/solc.js compileContract — in the browser the compiler is injected from
//     the app's own solc loading path; in tests it is injected too. Nothing
//     here reads the compiler directly, so the bytecode the user deploys is
//     the bytecode the tests proved (tests/dex-v2-onchain-e2e.mjs).
//   • sendDexTx — bounded broadcast + bounded receipt wait + verdict, shared
//     with every trade, so a deploy cannot be the one action without a spine.
//
// The address lives per chain in localStorage, validated on every read. No
// factory stored = '' — a state the launch UI must say out loud, never paper
// over with a launch button that cannot work.

import { compileContract } from '../solc.js';
import { BEAR_SOURCE } from './bear-source.js';
import { provider, ethersLib, sendDexTx, needSigner, isAddr, DEX_CHAIN_ID, toast } from './core.js';

const FACTORY_KEY = 'bear.dex.factory';

function factoryStoreKey() { return `${FACTORY_KEY}.${DEX_CHAIN_ID}`; }

/** The factory this device deploys against ('' when none is set yet). */
export function factoryAddress() {
  try {
    const raw = String(localStorage.getItem(factoryStoreKey()) || '').trim();
    return isAddr(raw) ? raw.toLowerCase() : '';
  } catch {
    return '';
  }
}

/**
 * Remember the factory address. Returns false when the value is not an
 * address — a garbage address must never become a log filter that silently
 * matches nothing.
 */
export function setFactoryAddress(addr) {
  const a = String(addr || '').trim().toLowerCase();
  if (!isAddr(a)) return false;
  try {
    localStorage.setItem(factoryStoreKey(), a);
    return true;
  } catch {
    return false;
  }
}

/**
 * Deploy BearFactory with the connected wallet and remember it.
 *
 * One transaction, one time per chain. Returns the address on success, null
 * when the wallet is locked, compilation fails, or the tx does not confirm —
 * sendDexTx has already said why on screen by then.
 *
 * @param {object} [o]
 * @param {object} [o.signer]  a connected ethers signer; defaults to the
 *   wallet (needSigner) so the UI can call this bare.
 */
export async function deployFactory({ signer } = {}) {
  const s = signer || needSigner();
  if (!s) return null;
  const E = ethersLib();
  if (!E || !provider()) return null;

  let compiled;
  try {
    compiled = await compileContract(BEAR_SOURCE, 'BearFactory');
  } catch (e) {
    // A compiler that failed must not look like a dead button. The message is
    // technical on purpose: the solc error names the file and the line.
    toast((e && (e.message || e.shortMessage)) || String(e), 'error');
    return null;
  }
  const art = compiled?.contracts?.BearFactory || compiled;
  if (!art?.abi || !art?.bytecode) return null;

  const cf = new E.ContractFactory(art.abi, art.bytecode, s);
  // cf.deploy() resolves to a Contract (a handle), but the tx spine
  // (sendDexTx → waitForReceipt) runs on a TransactionResponse — grab
  // deploymentTransaction() so the deploy rides the same rails as every trade.
  const receipt = await sendDexTx(() => cf.deploy().then((c) => c.deploymentTransaction()), 'Factory');
  if (!receipt) return null;

  const addr = receipt.contractAddress;
  if (!isAddr(addr) || !setFactoryAddress(addr)) return null;
  // Returned in the node's checksummed form (what contract calls hand back);
  // the STORED form is lowercase (factoryAddress), so log filters and every
  // later compare agree.
  return addr;
}
