// ═══════════════════════════════════════════════════════════════
// Bear Tool — eip7702-tools.js
// Batch Call, Rescue Atomic, Claim Airdrop — via EIP-7702 delegation.
// Loads solc.js lazily from CDN for on-chain contract compilation.
// ═══════════════════════════════════════════════════════════════

const BROADCAST_TIMEOUT_MS = 15000; // same bound send.js uses

import { $, toast, confirmTx, escapeHtml, setBtnDots } from './ui.js';
import { get, set, addActivity, requireUnlock, emit } from './state.js';
import { runTx, waitForReceipt, withTimeout } from './safetx.js';
import { getNetworkById, getProvider, getDelegation, EIP7702 } from './network.js';
import * as wallet from './wallet.js';
import { saveDeployed, findDeployed, listDeployed, removeDeployed } from './registry.js';
import { compileContract } from './solc.js';

const { ethers } = globalThis;

// ── Solidity source code for helper contracts ──
const BATCH_SOURCE = `// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;
contract batch {
    event CallExecuted(address indexed to, uint256 indexed value, bytes data, bool success);
    struct Call { bytes data; address to; uint256 value; }
    address public immutable DEPLOYER;
    modifier onlyDeployer() { require(msg.sender == DEPLOYER, "batch: caller is not deployer"); _; }
    constructor() { DEPLOYER = msg.sender; }
    receive() external payable {}
    fallback() external payable {}
    function execute(Call[] calldata calls) external payable onlyDeployer {
        require(calls.length > 0, "batch: empty call list");
        for (uint256 i=0; i<calls.length; i++) {
            Call memory call = calls[i];
            require(call.to != address(0), "batch: call target zero");
            (bool success, ) = call.to.call{value: call.value}(call.data);
            require(success, "batch: call reverted");
            emit CallExecuted(call.to, call.value, call.data, success);
        }
    }
    function version() external pure returns (string memory) { return "1.0.0"; }
}`;

const RESCUE_SOURCE = `// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.20;
contract rescue {
    address public immutable SAFE;
    address public immutable RESCUER;
    constructor(address safe, address rescuer) { require(safe != address(0), "SAFE=0"); require(rescuer != address(0), "RESCUER=0"); SAFE=safe; RESCUER=rescuer; }
    modifier onlyRescuer() { require(msg.sender == RESCUER, "rescue: caller is not rescuer"); _; }
    receive() external payable {}
    function rescueETH() external onlyRescuer { (bool success, ) = SAFE.call{value: address(this).balance}(""); require(success, "ETH transfer failed"); }
    function rescueERC20(address token, uint256 amount) external onlyRescuer { (bool success, ) = token.call(abi.encodeWithSelector(0xa9059cbb, SAFE, amount)); require(success, "ERC20 transfer failed"); }
    function rescueERC20All(address token) external onlyRescuer {
        (bool okBal, bytes memory ret) = token.call(abi.encodeWithSelector(0x70a08231, address(this)));
        require(okBal && ret.length >= 32, "balanceOf failed");
        (bool success, ) = token.call(abi.encodeWithSelector(0xa9059cbb, SAFE, abi.decode(ret, (uint256))));
        require(success, "ERC20 transfer failed");
    }
    function rescueERC721(address token, uint256[] calldata ids) external onlyRescuer { for (uint256 i=0; i<ids.length; ++i) { (bool success, ) = token.call(abi.encodeWithSignature("transferFrom", address(this), SAFE, ids[i])); require(success, "ERC721 transfer failed"); } }
    function version() external pure returns (string memory) { return "1.1.0"; }
}`;

const AIRDROP_CLAIMER_SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract airdropClaimer {
    address public immutable RESCUER;
    constructor(address rescuer) { require(rescuer != address(0), "RESCUER=0"); RESCUER = rescuer; }
    modifier onlyRescuer() { require(msg.sender == RESCUER, "airdropClaimer: caller is not rescuer"); _; }
    receive() external payable {}
    function claimAndForward(address airdropContract, bytes calldata claimData, address token, address safe) external onlyRescuer {
        require(safe != address(0), "SAFE=0");
        (bool success, ) = airdropContract.call(claimData);
        require(success, "claim failed");
        if (token == address(0)) {
            (success, ) = safe.call{value: address(this).balance}("");
            require(success, "ETH transfer failed");
        } else {
            (bool okBal, bytes memory ret) = token.call(abi.encodeWithSelector(0x70a08231, address(this)));
            require(okBal && ret.length >= 32, "balanceOf failed");
            (success, ) = token.call(abi.encodeWithSelector(0xa9059cbb, safe, abi.decode(ret, (uint256))));
            require(success, "ERC20 transfer failed");
        }
    }
    function version() external pure returns (string memory) { return "1.1.0"; }
}`;

// ── compile a Solidity source → { abi, bytecode } ──
// The compiler lives in solc.js. It used to be loaded straight from the CDN's
// NODE build of solc, which no browser can execute — every compile here died.
async function compileSource(source, contractName) {
  return compileContract(source, contractName, { onStatus: (m) => toast(m, 'info') });
}

// ── deploy a compiled contract (BOUNDED wait — never spins forever) ──
async function deployContract(signer, abi, bytecode, constructorArgs = []) {
  const factory = new ethers.ContractFactory(abi, bytecode, signer);
  const contract = await factory.deploy(...constructorArgs);
  const tx = contract.deploymentTransaction();
  const { receipt, timedOut } = await waitForReceipt(tx);
  if (timedOut) {
    throw new Error(`Helper deploy TX ${String(tx?.hash || '').slice(0, 12)}… is still unconfirmed. Check the explorer before retrying.`);
  }
  if (receipt && receipt.status !== 1) throw new Error('Helper contract deploy reverted');
  return contract;
}

// ── EIP-7702: delegate wallet to implementation, then execute calldata atomically ──
// opts: { sponsorKey?, sponsorSigner? } — at least one must be provided
async function delegateAndExecute(targetAddress, implAddress, calldata, opts = {}) {
  const net = getNetworkById(get('networkId'));
  const provider = await getProvider(net.chainId);

  // Check if already delegated to the correct impl
  const currentDelegate = await getDelegation(provider, targetAddress);
  const needsDelegate = !currentDelegate || currentDelegate.toLowerCase() !== implAddress.toLowerCase();

  if (needsDelegate) {
    // Sign EIP-7702 authorization from target wallet
    const targetSigner = opts.targetSigner;
    if (!targetSigner) throw new Error('Target wallet signer required for delegation');

    const nonce = await provider.getTransactionCount(targetAddress);
    // EIP-7702 (final): the authorization list is processed AFTER the
    // sender's nonce is incremented, and a tuple whose nonce does not equal
    // the authority's current nonce is silently SKIPPED — the tx still mines
    // status 1 while the delegation never applies. So: sender == authority
    // (self-sponsor) → nonce + 1; foreign sponsor → the authority's raw nonce.
    const senderAddr = String((opts.sponsorSigner || opts.targetSigner).address || '');
    const selfSponsor = senderAddr.toLowerCase() === String(targetAddress).toLowerCase();
    const authNonce = selfSponsor ? nonce + 1 : nonce;

    const authorization = targetSigner.authorizeSync({
      chainId: net.chainId,
      address: implAddress,
      nonce: authNonce
    });

    const feeData = await provider.getFeeData();
    const sponsorSigner = opts.sponsorSigner || targetSigner;

    // Send delegation + calldata in one tx
    // withTimeout bounds the WAIT only. It cannot change the authorization, the
    // nonce, the calldata or the fee fields — it just stops the button spinning
    // forever on a node that never answers.
    const tx = await withTimeout(sponsorSigner.sendTransaction({
      to: targetAddress,
      authorizationList: [authorization],
      data: calldata,
      maxFeePerGas: feeData.maxFeePerGas,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas
    }), BROADCAST_TIMEOUT_MS, 'delegate broadcast');
    return tx;
  } else {
    // Already delegated — just send the calldata
    const signer = opts.sponsorSigner || opts.targetSigner;
    const feeData = await provider.getFeeData();
    const tx = await withTimeout(signer.sendTransaction({
      to: targetAddress,
      data: calldata,
      maxFeePerGas: feeData.maxFeePerGas,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas
    }), BROADCAST_TIMEOUT_MS, 'calldata broadcast');
    return tx;
  }
}

// ── deployed-contract registry (reuse to save gas) ──
// Exported because the policy below costs the user real gas when it is wrong, and
// a policy nobody can call cannot be tested. An unexported `findUsableDeployed`
// meant the only thing pinning it was a grep for its name.
//
// Three states, not two. "There is no code at this address" is a fact and the
// entry is dead. "The node did not answer" is not a fact about the chain, and
// treating it as one deleted a perfectly good record — after which the user is
// told to deploy a helper they already paid to deploy.
export async function contractExists(provider, address) {
  try {
    return { known: true, alive: (await provider.getCode(address)) !== '0x' };
  } catch {
    return { known: false, alive: false };
  }
}

// Find a registry entry that is still alive on-chain. Stale entries (contract
// gone / wrong chain) are dropped so they never get reused — but only when the
// chain actually said so.
export async function findUsableDeployed(type, chainId, predicate, provider) {
  const found = findDeployed(type, chainId, predicate);
  if (!found) return null;
  const { known, alive } = await contractExists(provider, found.address);
  if (alive) return found;
  // Unknown is not dead. Keep the record, and say the reuse could not be
  // verified, so the next attempt retries instead of quietly re-deploying.
  if (!known) {
    console.warn('[BearTool] could not verify the deployed record for ' + found.address +
      ' — the node did not answer. Keeping it rather than deleting a record it never disproved.');
    return { ...found, unverified: true };
  }
  removeDeployed(type, found.address, chainId);
  return null;
}

// ── batch call helpers ──
let batchCalls = [];

function renderBatchList() {
  const list = $('#batchList');
  if (!list) return;
  if (!batchCalls.length) {
    list.innerHTML = '<p class="small text-center">No calls yet. Add one below.</p>';
    return;
  }
  list.innerHTML = batchCalls.map((b, i) => `
    <div class="batch-item">
      <span class="idx">${i + 1}</span>
      <input class="input" data-batch-field="to" data-batch-idx="${i}" placeholder="Target 0x..." value="${escapeHtml(b.to)}">
      <input class="input" data-batch-field="data" data-batch-idx="${i}" placeholder="Calldata 0x..." value="${escapeHtml(b.data)}">
      <input class="input" data-batch-field="value" data-batch-idx="${i}" placeholder="ETH value" value="${escapeHtml(b.value)}" style="max-width:100px">
      <button class="btn btn-danger btn-sm batch-remove" data-batch-del="${i}">✕</button>
    </div>`).join('');

  // Bind input handlers
  list.querySelectorAll('[data-batch-field]').forEach(el => {
    el.addEventListener('input', (e) => {
      const idx = Number(e.target.dataset.batchIdx);
      const field = e.target.dataset.batchField;
      batchCalls[idx][field] = e.target.value;
    });
  });
  // Bind delete handlers
  list.querySelectorAll('[data-batch-del]').forEach(el => {
    el.addEventListener('click', () => {
      batchCalls.splice(Number(el.dataset.batchDel), 1);
      renderBatchList();
    });
  });
}

function addBatchItem() {
  batchCalls.push({ to: '', data: '', value: '0' });
  renderBatchList();
}

async function executeBatch() {
  if (!get('unlocked')) { requireUnlock(); return; }
  const valid = batchCalls.filter(b => b.to && b.data);
  if (!valid.length) return toast('Add at least one valid call', 'error');
  // Every address, not just the first. Checking valid[0].to meant a malformed
  // entry at position 2..n sailed straight into the helper's multicall — the
  // contract is not a validator, and a revert there costs the whole batch
  // rather than the one bad call. Reported by position so it can be found.
  const bad = valid.map((b, i) => (wallet.isValidAddress(b.to) ? null : i + 1)).filter(Boolean);
  if (bad.length) {
    return toast(bad.length === 1
      ? `Call #${bad[0]} has an invalid target address`
      : `Invalid target address in calls ${bad.join(', ')}`, 'error');
  }

  const net = getNetworkById(get('networkId'));
  {
    const ok = await confirmTx({
      title: net.type === 'mainnet' ? 'BATCH CALL ON MAINNET!' : `Batch ${valid.length} calls on ${net.name}?`,
      rows: [{ k: 'Calls', v: String(valid.length) }, { k: 'Network', v: net.name }],
      confirmText: 'Execute', danger: net.type === 'mainnet'
    });
    if (!ok) return;
  }

  await runTx('eip7702-batch', $('#btnBatchExecute'), async () => {
    const provider = get('provider');
    const signer = get('signer').connect(provider);
    const chainId = Number(net.chainId);

    // Batch helper must be deployed first (step 1 in the helper status card).
    // No silent auto-deploy here: the user explicitly deploys it up front.
    const existing = await findUsableDeployed('batch', chainId, item =>
      item.deployer?.toLowerCase() === get('address').toLowerCase(), provider);
    if (!existing) {
      toast('Deploy the batch helper first (step 1 above)', 'error');
      return;
    }
    const batchContract = new ethers.Contract(existing.address, existing.abi, signer);
    toast('Reusing batch contract: ' + wallet.shortAddress(existing.address), 'info');
    const batchAddr = await batchContract.getAddress();

    // Encode execute() calldata
    const calls = valid.map(b => ({
      to: b.to,
      data: b.data.startsWith('0x') ? b.data : '0x',
      value: ethers.parseEther(b.value || '0')
    }));
    const executeCalldata = batchContract.interface.encodeFunctionData('execute', [calls]);

    // Delegate wallet to batch contract and execute
    const tx = await delegateAndExecute(
      get('address'),
      batchAddr,
      executeCalldata,
      { targetSigner: signer, sponsorSigner: signer }
    );

    addActivity({ hash: tx.hash, type: 'eip7702-batch', status: 'pending', ts: Date.now(), detail: `${valid.length} calls via batch` });
    toast('Batch tx sent! ⚡', 'info');
    const { receipt, timedOut } = await waitForReceipt(tx);
    if (timedOut) {
      // Sent but not confirmed in time. The pending activity entry is left as
      // "pending" (honest) and the button is released — never spin forever.
      toast(`Tx ${String(tx.hash).slice(0, 10)}… sent but still unconfirmed. Track it on the explorer.`, 'info');
      return;
    }
    addActivity({ hash: tx.hash, type: 'eip7702-batch', status: receipt.status === 1 ? 'success' : 'failed', ts: Date.now(), detail: `${valid.length} calls` });
    toast(receipt.status === 1 ? 'Batch executed! 🎉' : 'Batch failed!', receipt.status === 1 ? 'success' : 'error');
    renderDeployedRegistry();
    emit('refresh');
  });
}

// ── rescue atomic ──
function toggleRescueFields() {
  const type = $('#rescueType').value;
  $('#rescueTokenWrap').classList.toggle('hidden', type === 'eth');
  $('#rescueTokenIdWrap').classList.toggle('hidden', type !== 'erc721');
}

async function executeRescue() {
  if (!get('unlocked')) { requireUnlock(); return; }
  const safe = $('#rescueSafe').value.trim();
  const type = $('#rescueType').value;
  const tokenAddr = $('#rescueTokenAddr').value.trim();
  const tokenIds = $('#rescueTokenId').value.trim();
  const sponsorKey = $('#rescueSponsorKey').value.trim();

  if (!wallet.isValidAddress(safe)) return toast('Invalid SAFE address', 'error');
  if (type !== 'eth' && !wallet.isValidAddress(tokenAddr)) return toast('Invalid token contract address', 'error');
  if (sponsorKey && !addressFromKey(sponsorKey)) return toast('Invalid sponsor private key', 'error');
  // Validated: take it out of the document. From here on the signer holds it.
  wipeKeyField('#rescueSponsorKey'); wipeKeyField('#claimSponsorKey');

  const derived = deriveTargetAddress();
  if (derived.error) return toast(derived.error, 'error');
  const target = derived.address;

  // The 7702 authorization MUST be signed by the target itself — it is the
  // authority of the tuple; the sponsor can only pay gas. Two ways to hold
  // that signature: paste the target's private key, or have the target be the
  // unlocked wallet. Never sign with some other account: refuse rather than
  // guess. The address itself comes from deriveTargetAddress above, so the
  // key and the address it claims can no longer disagree.
  const targetKey = $('#rescueTargetKey')?.value.trim() || '';
  const sponsorAddress = sponsorAddressOf(sponsorKey);
  if (!sponsorAddress) return toast('No usable sponsor — paste a private key or unlock a wallet', 'error');
  // Validated: out of the document; the local strings hold them from here.
  wipeKeyField('#rescueTargetKey');

  const net = getNetworkById(get('networkId'));
  {
    const ok = await confirmTx({
      title: net.type === 'mainnet' ? 'RESCUE ON MAINNET!' : `Rescue from ${wallet.shortAddress(target)}?`,
      rows: [
        { k: 'Locked wallet', v: wallet.shortAddress(target) },
        { k: 'SAFE destination', v: wallet.shortAddress(safe) },
        { k: 'Token type', v: type.toUpperCase() },
        { k: 'Authorization', v: targetKey ? 'Target private key (validated)' : 'Unlocked target wallet' },
        { k: 'Gas sponsor (executor)', v: wallet.shortAddress(sponsorAddress) },
        { k: 'Network', v: net.name }
      ],
      confirmText: 'Rescue', danger: net.type === 'mainnet'
    });
    if (!ok) return;
  }

  await runTx('eip7702-rescue', $('#btnRescue'), async () => {
    const provider = await getProvider(net.chainId);
    const chainId = Number(net.chainId);
    // Gas sponsor must exist in BOTH branches (reuse and fresh deploy) and is
    // used again at delegateAndExecute. Declared in the `else` branch it was
    // out of scope at that call → ReferenceError on every rescue.
    const sponsorSigner = sponsorSignerOf(sponsorKey, provider);

    // Rescue helper must be deployed first (step 1 in the helper status card).
    // No silent auto-deploy here: the user explicitly deploys it up front.
    // Match on what the constructor actually received — SAFE and the sponsor
    // (RESCUER). The locked wallet is NOT a constructor argument, so it is
    // deliberately absent: it is derived now, and matching on a derived value
    // would reject a helper that is perfectly reusable.
    const existing = await findUsableDeployed('rescue', chainId, item =>
      item.safe?.toLowerCase() === safe.toLowerCase()
        && item.sponsor?.toLowerCase() === sponsorAddress.toLowerCase(), provider);
    if (!existing) {
      toast('Deploy the rescue helper first (step 1 above)', 'error');
      return;
    }
    const rescueContract = new ethers.Contract(existing.address, existing.abi, provider);
    toast('Reusing rescue contract: ' + wallet.shortAddress(existing.address), 'info');
    const rescueAddr = await rescueContract.getAddress();

    // Build calldata based on token type
    let calldata;
    if (type === 'eth') {
      calldata = rescueContract.interface.encodeFunctionData('rescueETH');
    } else if (type === 'erc20') {
      // Use rescueERC20All to rescue all tokens
      calldata = rescueContract.interface.encodeFunctionData('rescueERC20All', [tokenAddr]);
    } else if (type === 'erc721') {
      const ids = tokenIds.split(',').map(s => BigInt(s.trim())).filter(n => n >= 0n);
      if (!ids.length) return toast('Enter valid token IDs', 'error');
      calldata = rescueContract.interface.encodeFunctionData('rescueERC721', [tokenAddr, ids]);
    }

    // Delegate target to the rescue contract, then sweep in the same tx:
    // target signs the authorization, sponsor broadcasts (msg.sender inside
    // the helper = the sponsor — which is why RESCUER is bound to it).
    const targetSigner = targetKey ? new ethers.Wallet(targetKey, provider) : get('signer').connect(provider);

    const tx = await delegateAndExecute(
      target,
      rescueAddr,
      calldata,
      { targetSigner, sponsorSigner }
    );

    addActivity({ hash: tx.hash, type: 'eip7702-rescue', status: 'pending', ts: Date.now(), detail: `Rescue ${type} → ${wallet.shortAddress(safe)}` });
    toast('Rescue tx sent! ⚡', 'info');
    const { receipt, timedOut } = await waitForReceipt(tx);
    if (timedOut) {
      // Sent but not confirmed in time. The pending activity entry is left as
      // "pending" (honest) and the button is released — never spin forever.
      toast(`Tx ${String(tx.hash).slice(0, 10)}… sent but still unconfirmed. Track it on the explorer.`, 'info');
      return;
    }
    // A mined receipt is NOT proof the assets moved: a skipped authorization
    // still mines status 1, and a call into an undelegated target is an
    // empty-code no-op. Verify the delegation landed before claiming success.
    let landed = null;
    try { landed = await getDelegation(provider, target); } catch { /* RPC hiccup → honest unknown */ }
    const delegated = !!landed && landed.toLowerCase() === rescueAddr.toLowerCase();
    const rescued = receipt.status === 1 && delegated;
    addActivity({ hash: tx.hash, type: 'eip7702-rescue', status: rescued ? 'success' : 'failed', ts: Date.now(), detail: `Rescue ${type}` });
    if (receipt.status === 1 && !delegated) {
      toast('Tx mined but the delegation did NOT apply — assets were NOT moved.', 'error');
    } else {
      toast(rescued ? 'Assets rescued! 🎉' : 'Rescue failed!', rescued ? 'success' : 'error');
    }
    renderDeployedRegistry();
    emit('refresh');
  });
}

// ── claim airdrop ──
async function executeClaim() {
  if (!get('unlocked')) { requireUnlock(); return; }
  const contractAddr = $('#claimContract').value.trim();
  const claimData = $('#claimData').value.trim();
  const tokenAddr = $('#claimToken').value.trim();
  const safe = $('#claimSafe').value.trim();
  const sponsorKey = $('#claimSponsorKey').value.trim();

  if (!wallet.isValidAddress(contractAddr)) return toast('Invalid airdrop contract address', 'error');
  if (!claimData || !claimData.startsWith('0x')) return toast('Invalid claim calldata (must start with 0x)', 'error');
  if (!wallet.isValidAddress(safe)) return toast('Invalid SAFE address', 'error');
  if (sponsorKey && !addressFromKey(sponsorKey)) return toast('Invalid sponsor private key', 'error');
  // Validated: take it out of the document. From here on the signer holds it.
  wipeKeyField('#rescueSponsorKey'); wipeKeyField('#claimSponsorKey');
  const sponsorAddress = sponsorAddressOf(sponsorKey);
  if (!sponsorAddress) return toast('No usable sponsor — paste a private key or unlock a wallet', 'error');

  const net = getNetworkById(get('networkId'));
  {
    const ok = await confirmTx({
      title: net.type === 'mainnet' ? 'CLAIM AIRDROP ON MAINNET!' : `Claim on ${net.name}?`,
      rows: [
        { k: 'Airdrop contract', v: wallet.shortAddress(contractAddr) },
        { k: 'Forward to', v: wallet.shortAddress(safe) },
        { k: 'Network', v: net.name }
      ],
      confirmText: 'Claim', danger: net.type === 'mainnet'
    });
    if (!ok) return;
  }

  await runTx('eip7702-claim', $('#btnClaim'), async () => {
    const provider = await getProvider(net.chainId);
    const chainId = Number(net.chainId);
    const targetAddress = get('address');
    // Same fix as executeRescue: the sponsor payer is needed in both the
    // reuse and the deploy branch AND at delegateAndExecute.
    const sponsorSigner = sponsorSignerOf(sponsorKey, provider);

    // Airdrop claimer must be deployed first (step 1 in the helper status card).
    // No silent auto-deploy here: the user explicitly deploys it up front.
    const existing = await findUsableDeployed('airdrop', chainId, item =>
      item.target?.toLowerCase() === targetAddress.toLowerCase(), provider);
    if (!existing) {
      toast('Deploy the airdrop claimer first (step 1 above)', 'error');
      return;
    }
    const claimerContract = new ethers.Contract(existing.address, existing.abi, provider);
    toast('Reusing claimer contract: ' + wallet.shortAddress(existing.address), 'info');
    const claimerAddr = await claimerContract.getAddress();

    // Encode claimAndForward() calldata
    const tokenAddress = tokenAddr || ethers.ZeroAddress;
    const calldata = claimerContract.interface.encodeFunctionData('claimAndForward', [
      contractAddr,
      claimData,
      tokenAddress,
      safe
    ]);

    // Delegate target wallet to claimer contract, then execute
    const targetSigner = get('signer').connect(provider);

    const tx = await delegateAndExecute(
      targetAddress,
      claimerAddr,
      calldata,
      { targetSigner, sponsorSigner }
    );

    addActivity({ hash: tx.hash, type: 'eip7702-claim', status: 'pending', ts: Date.now(), detail: `Claim airdrop → ${wallet.shortAddress(safe)}` });
    toast('Claim tx sent! ⚡', 'info');
    const { receipt, timedOut } = await waitForReceipt(tx);
    if (timedOut) {
      // Sent but not confirmed in time. The pending activity entry is left as
      // "pending" (honest) and the button is released — never spin forever.
      toast(`Tx ${String(tx.hash).slice(0, 10)}… sent but still unconfirmed. Track it on the explorer.`, 'info');
      return;
    }
    addActivity({ hash: tx.hash, type: 'eip7702-claim', status: receipt.status === 1 ? 'success' : 'failed', ts: Date.now(), detail: 'Airdrop claim' });
    toast(receipt.status === 1 ? 'Airdrop claimed + forwarded! 🎉' : 'Claim failed!', receipt.status === 1 ? 'success' : 'error');
    renderDeployedRegistry();
    emit('refresh');
  });
}

// ── helper-contract status: step 1 of every flow ──
// Batch/Rescue/Claim all need a helper contract on this chain. This card says
// out loud whether it exists, where, and lets the user deploy it up front
// instead of discovering the requirement when the action fails.
/** Clear a private-key field once its value has been read and accepted.
 *
 *  The sponsor key is typed into a plain <input type=password> and read straight
 *  out of the DOM. Nothing removed it afterwards, so a sponsor key sat in the
 *  live document for the rest of the session — readable by any injected script,
 *  any accidental screenshot, and any later copy/paste of the field. This is
 *  called only after validation has passed, so a mistyped key is not thrown away
 *  before the user can correct it. */
export function wipeKeyField(sel) {
  const el = $(sel);
  if (el) { el.value = ''; el.blur?.(); }
}

// ── the two values this card used to make you retype ──────────────────────
/** The locked wallet. It is no longer a field: it is whatever the target key
 *  says, or — when no key is pasted — the unlocked wallet.
 *  Deriving it in ONE place is what keeps "the address the helper was
 *  deployed for" and "the address being rescued from" the same value, so the
 *  helper you just deployed cannot fail to match the rescue you then run.
 *  Returns { address } or { error }; a malformed key is reported rather than
 *  silently falling back to the unlocked wallet. */
/** Turn a private key into its address, or null when it is not usable.
 *
 *  The hex-shape test ALONE is not enough: 0x00…00 and 0xfff…f are perfect
 *  32-byte hex, and ethers rejects both ("0 < bigint < curve.n"). That throw
 *  escaped the validation path and left the button dead with no toast.
 *  Deriving is the only honest check. */
export function addressFromKey(key) {
  if (!/^0x[a-fA-F0-9]{64}$/.test(key)) return null;
  try { return new ethers.Wallet(key).address; } catch { return null; }
}

export function deriveTargetAddress() {
  const key = $('#rescueTargetKey')?.value.trim() || '';
  if (key) {
    const addr = addressFromKey(key);
    return addr ? { address: addr } : { error: 'Invalid target private key' };
  }
  const unlocked = get('address');
  if (!unlocked) return { error: 'Unlock the target wallet or paste its private key' };
  return { address: String(unlocked) };
}

/** Who pays for gas. A pasted key wins; with no key the unlocked wallet
 *  sponsors. Both already live in memory, so demanding a copy-paste of a key
 *  the app is holding only pushed users to paste it into a second field. */
export function sponsorAddressOf(sponsorKey) {
  if (sponsorKey) return addressFromKey(sponsorKey);
  const unlocked = get('address');
  return unlocked ? String(unlocked) : null;
}

/** Same rule as sponsorAddressOf, as a signing object. Must stay in lockstep:
 *  deploy records this address, execute matches on it — resolving them
 *  differently on the two sides would strand a perfectly good helper. */
function sponsorSignerOf(sponsorKey, provider) {
  if (sponsorKey) return new ethers.Wallet(sponsorKey, provider);
  const signer = get('signer');
  if (!signer) throw new Error('Unlock a wallet or paste a sponsor private key');
  return signer.connect(provider);
}

export function renderHelperStatus() {
  const list = $('#helperStatusList');
  if (!list) return;
  const net = getNetworkById(get('networkId'));
  const chainId = Number(net?.chainId || 0);

  const row = (label, ok, detail, action) => `
    <div class="helper-row ${ok ? 'ok' : 'missing'}">
      <div class="helper-head">
        <span class="helper-name">${escapeHtml(label)}</span>
        <span class="helper-state">${ok ? '✅ deployed' : '❌ not deployed'}</span>
      </div>
      <div class="small">${detail}</div>
      ${action}
    </div>`;

  const batch = findDeployed('batch', chainId);
  const rescue = listDeployed('rescue', chainId);
  const airdrop = listDeployed('airdrop', chainId);
  const short = (a) => (a ? escapeHtml(wallet.shortAddress(a)) : '—');

  list.innerHTML = [
    row('Batch Call', !!batch,
      batch
        ? `Recorded at <span class="mono">${short(batch.address)}</span> · re-checked on-chain before reuse.`
        : 'No batch helper on this chain yet. It takes no constructor arguments, so you can deploy it now.',
      `<button class="btn btn-sm ${batch ? 'btn-ghost' : 'btn-primary'}" id="btnDeployBatchHelper">${batch ? 'Deploy another' : 'Deploy batch helper'}</button>`),
    row('Rescue Atomic', rescue.length > 0,
      rescue.length
        ? `Bound to your inputs: ${rescue.map(r => `<span class="mono">${short(r.address)}</span>`).join(', ')}`
        : 'Deploy it first — its constructor takes your locked wallet + SAFE address from the form below.',
      `<button class="btn btn-sm ${rescue.length ? 'btn-ghost' : 'btn-primary'}" id="btnDeployRescueHelper">${rescue.length ? 'Deploy another' : 'Deploy rescue helper'}</button>`),
    row('Claim Airdrop', airdrop.length > 0,
      airdrop.length
        ? `Bound to your inputs: ${airdrop.map(r => `<span class="mono">${short(r.address)}</span>`).join(', ')}`
        : 'Deploy it first — its constructor takes the locked wallet as rescuer.',
      `<button class="btn btn-sm ${airdrop.length ? 'btn-ghost' : 'btn-primary'}" id="btnDeployAirdropClaimer">${airdrop.length ? 'Deploy another' : 'Deploy airdrop claimer'}</button>`)
  ].join('');

  $('#btnDeployBatchHelper')?.addEventListener('click', deployBatchHelper);
  $('#btnDeployRescueHelper')?.addEventListener('click', deployRescueHelper);
  $('#btnDeployAirdropClaimer')?.addEventListener('click', deployAirdropClaimer);
}

// Explicit "deploy the helper first" action for Batch (no constructor args).
export async function deployBatchHelper() {
  if (!get('unlocked')) { requireUnlock(); return; }
  const net = getNetworkById(get('networkId'));
  const btn = $('#btnDeployBatchHelper');
  setBtnDots(btn, true, 'Deploying');
  try {
    const provider = get('provider') || await getProvider(net.chainId);
    set('provider', provider);
    const signer = get('signer').connect(provider);
    // Sign/Cancel before anything is sent. These helpers deploy straight to
    // the chain with no confirmation at all, so a stray tap could put a
    // contract on mainnet unreviewed.
    const ok = await confirmTx({
      title: net.type === 'mainnet' ? 'DEPLOY HELPER ON MAINNET!' : 'Deploy batch helper?',
      rows: [
        { k: 'Contract', v: 'batch' },
        { k: 'Network', v: net.name },
        { k: 'From', v: get('address') },
      ],
      confirmText: 'Sign',
      danger: net.type === 'mainnet',
    });
    if (!ok) { setBtnDots(btn, false); toast('Deploy cancelled', 'info'); return; }
    const { abi, bytecode } = await compileSource(BATCH_SOURCE, 'batch');
    const contract = await deployContract(signer, abi, bytecode);
    const addr = await contract.getAddress();
    saveDeployed('batch', addr, { chainId: Number(net.chainId), deployer: get('address'), abi });
    addActivity({ type: 'deploy-helper', status: 'success', ts: Date.now(), detail: `batch → ${addr}` });
    toast('Batch helper deployed: ' + wallet.shortAddress(addr), 'success');
    renderDeployedRegistry();
    showDeployedResult('batch', 'Batch helper', addr, net);
    renderHelperStatus();
  } catch (e) {
    toast(e?.message || String(e), 'error');
  } finally {
    setBtnDots(btn, false);
  }
}

// Explicit "deploy the helper first" action for Rescue (constructor: safe,
// sponsor). RESCUER must be the account that BROADCASTS the sweep: the helper
// executes in the target's context, so msg.sender is the sponsor — binding it
// to the target made onlyRescuer revert on every rescue.
export async function deployRescueHelper() {
  if (!get('unlocked')) { requireUnlock(); return; }
  const safe = $('#rescueSafe').value.trim();
  const sponsorKey = $('#rescueSponsorKey').value.trim();
  const derived = deriveTargetAddress();
  if (derived.error) return toast(derived.error, 'error');
  const target = derived.address;
  if (!wallet.isValidAddress(safe)) return toast('Fill a valid SAFE address first', 'error');
  if (sponsorKey && !addressFromKey(sponsorKey)) return toast('Invalid sponsor private key', 'error');
  // Validated: take it out of the document. From here on the signer holds it.
  wipeKeyField('#rescueSponsorKey'); wipeKeyField('#claimSponsorKey');
  const sponsorAddress = sponsorAddressOf(sponsorKey);
  if (!sponsorAddress) return toast('No usable sponsor — paste a private key or unlock a wallet', 'error');

  const net = getNetworkById(get('networkId'));
  const btn = $('#btnDeployRescueHelper');
  setBtnDots(btn, true, 'Deploying');
  try {
    const provider = get('provider') || await getProvider(net.chainId);
    set('provider', provider);
    const sponsorSigner = sponsorSignerOf(sponsorKey, provider);
    const ok = await confirmTx({
      title: net.type === 'mainnet' ? 'DEPLOY HELPER ON MAINNET!' : 'Deploy rescue helper?',
      rows: [
        { k: 'Contract', v: 'rescue' },
        { k: 'Network', v: net.name },
        { k: 'SAFE', v: safe },
        { k: 'Rescue target', v: target },
        { k: 'Sponsor (executor / RESCUER)', v: wallet.shortAddress(sponsorSigner.address) },
      ],
      confirmText: 'Sign',
      danger: net.type === 'mainnet',
    });
    if (!ok) { setBtnDots(btn, false); toast('Deploy cancelled', 'info'); return; }
    const { abi, bytecode } = await compileSource(RESCUE_SOURCE, 'rescue');
    const contract = await deployContract(sponsorSigner, abi, bytecode, [safe, sponsorSigner.address]);
    const addr = await contract.getAddress();
    saveDeployed('rescue', addr, { chainId: Number(net.chainId), safe, target, sponsor: sponsorSigner.address, abi });
    addActivity({ type: 'deploy-helper', status: 'success', ts: Date.now(), detail: `rescue → ${addr}` });
    toast('Rescue helper deployed: ' + wallet.shortAddress(addr), 'success');
    showDeployedResult('rescue', 'Rescue helper', addr, net);
    renderHelperStatus();
    renderDeployedRegistry();
  } catch (e) {
    toast(e?.message || String(e), 'error');
  } finally {
    setBtnDots(btn, false);
  }
}

// Explicit "deploy the helper first" action for Claim Airdrop (constructor: rescuer).
export async function deployAirdropClaimer() {
  if (!get('unlocked')) { requireUnlock(); return; }
  const sponsorKey = $('#claimSponsorKey').value.trim();
  if (sponsorKey && !addressFromKey(sponsorKey)) return toast('Invalid sponsor private key', 'error');
  // Validated: take it out of the document. From here on the signer holds it.
  wipeKeyField('#rescueSponsorKey'); wipeKeyField('#claimSponsorKey');
  const sponsorAddress = sponsorAddressOf(sponsorKey);
  if (!sponsorAddress) return toast('No usable sponsor — paste a private key or unlock a wallet', 'error');

  const net = getNetworkById(get('networkId'));
  const btn = $('#btnDeployAirdropClaimer');
  setBtnDots(btn, true, 'Deploying');
  try {
    const provider = get('provider') || await getProvider(net.chainId);
    set('provider', provider);
    const sponsorSigner = sponsorSignerOf(sponsorKey, provider);
    const targetAddress = get('address');
    const ok = await confirmTx({
      title: net.type === 'mainnet' ? 'DEPLOY HELPER ON MAINNET!' : 'Deploy airdrop claimer?',
      rows: [
        { k: 'Contract', v: 'airdropClaimer' },
        { k: 'Network', v: net.name },
        { k: 'Target', v: targetAddress },
        { k: 'Sponsor', v: wallet.shortAddress(sponsorSigner.address) },
      ],
      confirmText: 'Sign',
      danger: net.type === 'mainnet',
    });
    if (!ok) { setBtnDots(btn, false); toast('Deploy cancelled', 'info'); return; }
    const { abi, bytecode } = await compileSource(AIRDROP_CLAIMER_SOURCE, 'airdropClaimer');
    const contract = await deployContract(sponsorSigner, abi, bytecode, [targetAddress]);
    const addr = await contract.getAddress();
    saveDeployed('airdrop', addr, { chainId: Number(net.chainId), target: targetAddress, abi });
    addActivity({ type: 'deploy-helper', status: 'success', ts: Date.now(), detail: `airdrop → ${addr}` });
    toast('Airdrop claimer deployed: ' + wallet.shortAddress(addr), 'success');
    showDeployedResult('airdrop', 'Airdrop claimer', addr, net);
    renderHelperStatus();
    renderDeployedRegistry();
  } catch (e) {
    toast(e?.message || String(e), 'error');
  } finally {
    setBtnDots(btn, false);
  }
}

// ── deployed-contract registry UI ──
// After a helper lands on-chain, name + address go on screen immediately with
// a copy button, instead of only a toast that disappears. `data-copy` is
// handled globally, so the button needs no listener of its own.
function showDeployedResult(type, label, addr, net) {
  const box = $('#helperResult');
  if (!box) return;
  box.innerHTML = `<div class="asset-row">
      <div class="asset-info">
        <div class="asset-name">${escapeHtml(label)} deployed</div>
        <div class="asset-symbol"><span class="mono">${escapeHtml(addr)}</span></div>
        <div class="small dim">${escapeHtml(net?.name || '')}</div>
      </div>
      <button class="copy-btn" data-copy="${escapeHtml(addr)}" title="Copy contract address" aria-label="Copy contract address"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
    </div>`;
  box.classList.remove('hidden');
}

export function renderDeployedRegistry() {
  const list = $('#deployedRegistryList');
  if (!list) return;
  const net = getNetworkById(get('networkId'));
  const chainId = Number(net?.chainId || 0);
  const all = ['batch', 'rescue', 'airdrop', 'proxy', 'revoker']
    .flatMap(type => listDeployed(type, chainId).map(item => ({ ...item, type })));
  if (!all.length) {
    list.innerHTML = '<p class="small text-center">No deployed helper contracts on this chain yet.</p>';
    return;
  }
  list.innerHTML = all.map((item, i) => `
    <div class="registry-item">
      <span class="reg-type">${escapeHtml(item.type)}</span>
      <span class="addr">${escapeHtml(wallet.shortAddress(item.address))}</span>
      <button class="btn btn-danger btn-sm" data-reg-remove="${i}" aria-label="Remove from registry">✕</button>
    </div>`).join('');
  list.querySelectorAll('[data-reg-remove]').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = all[Number(btn.dataset.regRemove)];
      if (!item) return;
      removeDeployed(item.type, item.address, chainId);
      renderHelperStatus();
      renderDeployedRegistry();
      toast('Removed from registry', 'info');
    });
  });
}

// ── password toggle helper ──
function bindPasswordToggle(btnId, inputId) {
  const btn = $(btnId);
  const input = $(inputId);
  if (!btn || !input) return;
  btn.addEventListener('click', () => {
    const isPassword = input.type === 'password';
    input.type = isPassword ? 'text' : 'password';
    btn.textContent = isPassword ? '🙈' : '👁️';
  });
}

// ── revoke EIP-7702 delegation (from Tools card) ──
async function checkDelegation() {
  const addr = $('#revokeTarget')?.value.trim() || get('address');
  if (!wallet.isValidAddress(addr)) return toast('Invalid address', 'error');
  const net = getNetworkById(get('networkId'));
  const status = $('#revokeStatus');
  const text = $('#revokeStatusText');
  status?.classList.remove('hidden');
  try {
    const provider = await getProvider(net.chainId);
    const delegate = await getDelegation(provider, addr);
    if (delegate) {
      status.className = 'delegate-status delegated';
      text.innerHTML = `Delegated to <span class="addr">${escapeHtml(delegate)}</span>`;
    } else {
      status.className = 'delegate-status eoa';
      text.textContent = 'Plain EOA (no delegation) — nothing to revoke.';
    }
  } catch {
    status.className = 'delegate-status eoa';
    text.textContent = 'Cannot check (RPC error)';
  }
}

export async function revokeDelegation() {
  const target = $('#revokeTarget')?.value.trim() || get('address');
  if (!wallet.isValidAddress(target)) return toast('Invalid address', 'error');
  const key = $('#revokeKey')?.value.trim();

  const net = getNetworkById(get('networkId'));
  const provider = await getProvider(net.chainId);
  set('provider', provider);

  let signer;
  if (target.toLowerCase() === (get('address') || '').toLowerCase()) {
    signer = get('signer').connect(provider);
  } else if (!addressFromKey(key)) {
    return toast('Target is not the active wallet — provide its private key', 'error');
  } else {
    signer = new ethers.Wallet(key, provider);
  }

  const delegate = await getDelegation(provider, target);
  if (!delegate) return toast('No active delegation on this address — nothing to revoke.', 'info');

  const ok = await confirmTx({
    title: 'Revoke EIP-7702 Delegation',
    rows: [
      { k: 'Target', v: target },
      { k: 'Current delegation', v: delegate },
      { k: 'Action', v: 'Revoke (back to plain EOA)' }
    ],
    confirmText: 'Revoke', danger: true
  });
  if (!ok) return;

  const btn = $('#btnRevokeDelegation');
  if (btn) setBtnDots(btn, true, 'Revoking');
  try {
    const nonce = await provider.getTransactionCount(target);
    const authorization = signer.authorizeSync({ chainId: net.chainId, address: EIP7702.ZERO_ADDRESS, nonce });
    const feeData = await provider.getFeeData();
    const tx = await withTimeout(signer.sendTransaction({
      // MUST be explicit: ethers v6 otherwise infers an EIP-1559 type-2 tx from
      // the fee fields and SILENTLY DROPS the authorizationList. The tx then
      // mines fine, receipt.status === 1, the UI reports "Delegation revoked!"
      // — and the delegation is still live on-chain.
      type: 4,
      to: target,
      authorizationList: [authorization],
      maxFeePerGas: feeData.maxFeePerGas,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas
    }), BROADCAST_TIMEOUT_MS, 'revoke broadcast');
    addActivity({ hash: tx.hash, type: 'eip7702-revoke', status: 'pending', ts: Date.now(), detail: `revoke → ${target}` });
    toast('Revoke tx sent! ⚡', 'info');
    const { receipt, timedOut } = await waitForReceipt(tx);
    if (timedOut) {
      toast(`Tx ${tx.hash.slice(0, 10)}… sent but still unconfirmed. Track it on the explorer.`, 'info');
      return;
    }
    // A mined receipt is NOT proof the delegation was removed: a type-2 tx that
    // silently dropped the authorizationList also mines with status 1. Verify
    // the on-chain code actually cleared before telling the user it worked.
    let stillDelegated = null;
    try {
      stillDelegated = await getDelegation(provider, target);
    } catch { /* RPC hiccup — fall through to the receipt verdict */ }
    const revoked = receipt.status === 1 && !stillDelegated;
    addActivity({
      hash: tx.hash, type: 'eip7702-revoke',
      status: revoked ? 'success' : 'failed', ts: Date.now(), detail: `revoke → ${target}`
    });
    if (receipt.status === 1 && stillDelegated) {
      toast('Revoke tx mined but the delegation is STILL ACTIVE on-chain — the authorization did not apply.', 'error');
    } else {
      toast(revoked ? 'Delegation revoked! ✅' : 'Revoke failed!', revoked ? 'success' : 'error');
    }
    checkDelegation();
    emit('refresh');
  } catch (e) {
    toast(e?.message || String(e), 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Revoke delegation'; }
  }
}

// ── bind all events ──
export function bindEip7702ToolsEvents() {
  // Batch (view-deploy only if batch elements exist)
  $('#btnBatchAdd')?.addEventListener('click', addBatchItem);
  $('#btnBatchExecute')?.addEventListener('click', executeBatch);

  // Rescue
  $('#rescueType')?.addEventListener('change', toggleRescueFields);
  $('#btnRescue')?.addEventListener('click', executeRescue);

  // Claim
  $('#btnClaim')?.addEventListener('click', executeClaim);

  // Revoke delegation (Tools card)
  $('#btnCheckDelegation')?.addEventListener('click', checkDelegation);
  $('#btnRevokeDelegation')?.addEventListener('click', revokeDelegation);

  // Password toggles
  bindPasswordToggle('#btnRescueKeyToggle', '#rescueSponsorKey');
  bindPasswordToggle('#btnRescueTargetKeyToggle', '#rescueTargetKey');
  bindPasswordToggle('#btnClaimKeyToggle', '#claimSponsorKey');

  // Helper status (step 1) + registry list
  renderHelperStatus();
  renderDeployedRegistry();
}
