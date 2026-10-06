// ═══════════════════════════════════════════════════════════════
// Bear Tool — eip7702-tools.js
// Batch Call, Rescue Atomic, Claim Airdrop — via EIP-7702 delegation.
// Loads solc.js lazily from CDN for on-chain contract compilation.
// ═══════════════════════════════════════════════════════════════

const BROADCAST_TIMEOUT_MS = 15000; // same bound send.js uses

import { $, toast, confirmTx, escapeHtml, setBtnDots, promptPassword } from './ui.js';
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
    // v1.2.0: minimum guaranteed ON-CHAIN. If the claimed result is below
    // minAmount the WHOLE transaction reverts — funds never move halfway.
    // token is MANDATORY ERC-20 (address(0) refused) so the amount can always
    // be compared. Kept in sync with nemoobc/EIP-7702-TOOL v1.2.0.
    function claimAndForwardMin(address airdropContract, bytes calldata claimData, address token, address safe, uint256 minAmount) external onlyRescuer {
        require(safe != address(0), "SAFE=0");
        require(token != address(0), "TOKEN=0 (ERC-20 only)");
        (bool success, ) = airdropContract.call(claimData);
        require(success, "claim failed");
        (bool okBal, bytes memory ret) = token.call(abi.encodeWithSelector(0x70a08231, address(this)));
        require(okBal && ret.length >= 32, "balanceOf failed");
        uint256 bal = abi.decode(ret, (uint256));
        require(bal >= minAmount, "CLAIM<MIN (claim less than required)");
        (success, ) = token.call(abi.encodeWithSelector(0xa9059cbb, safe, bal));
        require(success, "ERC20 transfer failed");
    }
    function version() external pure returns (string memory) { return "1.2.0"; }
}`;

// True when an ABI carries the named function. Entries hold either parsed
// objects ({name}) or human-readable strings — an old airdrop helper saved
// before v1.2.0 has only claimAndForward and would revert on the minimum
// variant, so reuse must ask the ABI, not assume the label.
export function abiHasName(abi, name) {
  return Array.isArray(abi) && abi.some(f =>
    (f && typeof f === 'object' && f.name === name) ||
    (typeof f === 'string' && f.includes(name)));
}

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
      // MUST be explicit — same rule as eip7702.js and revokeDelegation:
      // without it ethers can infer a type-2 tx from the fee fields and drop
      // the authorizationList, so the delegation never lands while the tx
      // still reports success.
      type: 4,
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

// ── resolve helper untuk flow: pakai entri registry, atau — dengan konfirmasi
// eksplisit, tidak pernah senyap — deploy di tempat. Ini yang dijanjikan kartu
// Helper Contracts: "or let the flow deploy it for you" (deploy.jsx:53).
async function ensureDeployedHelper(type, label, chainId, predicate, provider, deployFn) {
  const existing = await findUsableDeployed(type, chainId, predicate, provider);
  if (existing) return { ...existing, reused: true };
  const ok = await confirmTx({
    title: `${label} helper not deployed — deploy it now?`,
    rows: [{ k: 'Action', v: `Deploy ${label} helper (saved, reused on later runs)` }],
    confirmText: 'Deploy',
  });
  if (!ok) {
    toast(`${label} helper is required — deploy it now or from Helper Contracts.`, 'info');
    return null;
  }
  try {
    const entry = await deployFn();
    renderHelperStatus();
    renderDeployedRegistry();
    toast(`${label} helper deployed: ` + wallet.shortAddress(entry.address), 'success');
    return { ...entry, reused: false };
  } catch (e) {
    toast(e?.message || String(e), 'error');
    return null;
  }
}

async function executeBatch() {
  if (!get('unlocked')) { requireUnlock(); return; }
  const valid = batchCalls.filter(b => b.to); // T7: value-only rows (empty data) are legal
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

  // Calldata rules: empty → 0x; anything else must be real 0x-hex. The old
  // code silently ZEROED non-0x data — a typo became a no-op call inside a
  // batch the user had just paid for.
  for (let i = 0; i < valid.length; i++) {
    const d = String(valid[i].data ?? '').trim();
    if (d && d !== '0x' && !/^0x[0-9a-fA-F]*$/.test(d)) {
      return toast(`Invalid hex calldata in call #${i + 1} (must start with 0x)`, 'error');
    }
  }

  const net = getNetworkById(get('networkId'));
  const provider = await getProvider(net.chainId);

  // Value guard BEFORE the prompt: execute() draws value from the delegated
  // EOA's own balance, so a total above that balance can only revert on-chain.
  let totalValue = 0n;
  for (let i = 0; i < valid.length; i++) {
    try { totalValue += ethers.parseEther(String(valid[i].value || '0')); }
    catch { return toast(`Invalid ETH value in call #${i + 1}`, 'error'); }
  }
  if (totalValue > 0n) {
    let balance = 0n;
    try { balance = await provider.getBalance(get('address')); }
    catch { /* node did not answer — unknown is not zero, so do not block */ }
    if (balance > 0n && totalValue > balance) {
      return toast(`Total value ${ethers.formatEther(totalValue)} ETH exceeds the wallet balance (${ethers.formatEther(balance)} ETH) — batch cancelled`, 'error');
    }
  }

  {
    const ok = await confirmTx({
      title: net.type === 'mainnet' ? 'BATCH CALL ON MAINNET!' : `Batch ${valid.length} calls on ${net.name}?`,
      rows: [
        { k: 'Calls', v: String(valid.length) },
        { k: 'Total value', v: `${ethers.formatEther(totalValue)} ETH` },
        { k: 'Transactions', v: '1) helper deploy if missing  2) delegate  3) execute' },
        { k: 'Network', v: net.name },
        { k: 'Delegation', v: 'Permanent until revoked (Tools → Revoke)' },
      ],
      confirmText: 'Execute', danger: net.type === 'mainnet'
    });
    if (!ok) return;
  }

  await runTx('eip7702-batch', $('#btnBatchExecute'), async () => {
    const signer = get('signer').connect(provider);
    const chainId = Number(net.chainId);

    // Resolve the batch helper: reuse the saved entry, or — after an explicit
    // confirmation, never silently — deploy it right here. The Helper
    // Contracts card promises "or let the flow deploy it for you".
    const helper = await ensureDeployedHelper('batch', 'Batch', chainId,
      item => item.deployer?.toLowerCase() === get('address').toLowerCase(),
      provider,
      async () => {
        const { abi, bytecode } = await compileSource(BATCH_SOURCE, 'batch');
        const contract = await deployContract(signer, abi, bytecode);
        const addr = await contract.getAddress();
        const dtx = contract.deploymentTransaction();
        saveDeployed('batch', addr, { chainId, deployer: get('address'), abi });
        addActivity({ hash: dtx?.hash, type: 'deploy-helper', status: 'success', ts: Date.now(), detail: `batch → ${addr}` });
        return { address: addr, abi };
      });
    if (!helper) return;
    const batchContract = new ethers.Contract(helper.address, helper.abi, signer);
    if (helper.reused) toast('Reusing batch contract: ' + wallet.shortAddress(helper.address), 'info');
    const batchAddr = await batchContract.getAddress();

    // Encode execute() calldata — empty data defaults to 0x (value-only call).
    const calls = valid.map(b => ({
      to: b.to,
      data: (() => { const d = String(b.data ?? '').trim(); return (!d || d === '0x') ? '0x' : d; })(),
      value: ethers.parseEther(String(b.value || '0'))
    }));
    const executeCalldata = batchContract.interface.encodeFunctionData('execute', [calls]);

    // Three separate transactions, like the reference: each step names itself
    // in the activity log and a failed step stops the flow instead of burning
    // the whole batch in one atomic revert (the helper deploy already ran as
    // its own transaction inside ensureDeployedHelper).
    // Step 2 — delegate ONLY (calldata 0x). Skipped when the chain says the
    // wallet already delegates to this helper — freshness is read, not assumed.
    const currentDelegate = await getDelegation(provider, get('address'));
    if (!currentDelegate || currentDelegate.toLowerCase() !== batchAddr.toLowerCase()) {
      const txD = await delegateAndExecute(
        get('address'),
        batchAddr,
        '0x',
        { targetSigner: signer, sponsorSigner: signer }
      );
      addActivity({ hash: txD.hash, type: 'eip7702-batch', status: 'pending', ts: Date.now(), detail: `delegate → ${wallet.shortAddress(batchAddr)}` });
      toast('Delegation tx sent…', 'info');
      const dRes = await waitForReceipt(txD);
      if (dRes.timedOut) {
        toast(`Delegation ${String(txD.hash).slice(0, 10)}… sent but still unconfirmed. Track it on the explorer.`, 'info');
        return;
      }
      addActivity({ hash: txD.hash, type: 'eip7702-batch', status: dRes.receipt.status === 1 ? 'success' : 'failed', ts: Date.now(), detail: `delegate → ${wallet.shortAddress(batchAddr)}` });
      if (dRes.receipt.status !== 1) {
        toast('Delegation transaction FAILED — batch not executed.', 'error');
        return;
      }
    }

    // Step 3 — execute through the delegation. If step 2 did not apply
    // (skipped auth tuple), delegateAndExecute re-delegates and executes in
    // one transaction — the flow still completes instead of silently no-opping.
    const tx = await delegateAndExecute(
      get('address'),
      batchAddr,
      executeCalldata,
      { targetSigner: signer, sponsorSigner: signer }
    );

    addActivity({ hash: tx.hash, type: 'eip7702-batch', status: 'pending', ts: Date.now(), detail: `${valid.length} calls via batch` });
    toast('Batch execute tx sent! ⚡', 'info');
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
  // Token address is required for BOTH remaining types (ETH-only was dropped);
  // only the token-id and amount boxes stay type-specific.
  $('#rescueTokenWrap')?.classList.remove('hidden');
  $('#rescueTokenIdWrap')?.classList.toggle('hidden', type !== 'erc721');
  $('#rescueAmountWrap')?.classList.toggle('hidden', type !== 'erc20');
}

// ── pasted rescue contract: probe it on-chain before trusting it ──
// Read-only (no compile): SAFE/RESCUER are public immutables on the rescue
// helper. RESCUER is the deployer here — the contract is broadcast by the
// sponsor signer, so RESCUER === deployer wallet. A mismatch is not fatal by
// itself, but reusing it can only revert (onlyRescuer), so the flow asks
// "deploy baru?" instead of silently burning gas.
const RESCUE_PROBE_ABI = [
  'function SAFE() view returns (address)',
  'function RESCUER() view returns (address)'
];
// Minimal encode-only fragments — no solc round-trip for a pasted contract.
const RESCUE_MANUAL_ABI = [
  'function rescueERC20(address token, uint256 amount)',
  'function rescueERC721(address token, uint256[] tokenIds)',
  'function SAFE() view returns (address)',
  'function RESCUER() view returns (address)'
];

async function probeRescueContract(addr, provider, expectSafe, expectRescuer) {
  let code;
  try { code = await provider.getCode(addr); }
  catch { return { ok: false, reason: 'RPC error — the contract could not be verified' }; }
  if (!code || code === '0x') return { ok: false, reason: 'no contract code at that address' };
  try {
    const c = new ethers.Contract(addr, RESCUE_PROBE_ABI, provider);
    const [safe, rescuer] = await Promise.all([c.SAFE(), c.RESCUER()]);
    const det = { safe: String(safe), rescuer: String(rescuer) };
    if (expectSafe && safe.toLowerCase() !== expectSafe.toLowerCase()) {
      return { ...det, ok: false, reason: `SAFE mismatch — this contract forwards to ${wallet.shortAddress(safe)}, not your SAFE` };
    }
    if (expectRescuer && rescuer.toLowerCase() !== expectRescuer.toLowerCase()) {
      return { ...det, ok: false, reason: `deployer/RESCUER ${wallet.shortAddress(rescuer)} ≠ sponsor ${wallet.shortAddress(expectRescuer)} — onlyRescuer would revert` };
    }
    return { ...det, ok: true };
  } catch {
    return { ok: false, reason: 'not a Bear rescue contract (SAFE/RESCUER could not be read)' };
  }
}

// Live paste → detect, mirroring wireTokenDetect: state shows before Execute,
// so a wrong address is caught while the user still has the field focused.
function wireRescueHelperDetect() {
  const input = $('#rescueHelperAddr');
  const out = $('#rescueHelperDetect');
  if (!input || !out) return;
  const clear = () => { out.textContent = ''; out.className = 'small'; };
  const run = async () => {
    const addr = input.value.trim();
    if (!addr) { clear(); return; }
    if (!wallet.isValidAddress(addr)) { out.textContent = 'Invalid address'; out.className = 'small'; return; }
    out.textContent = 'Checking contract on-chain…';
    try {
      const net = getNetworkById(get('networkId'));
      const provider = await getProvider(net.chainId);
      const det = await probeRescueContract(addr, provider, null, null);
      if (input.value.trim() !== addr) return; // stale — field moved on
      if (det.ok) {
        out.textContent = `Detected rescue contract — SAFE ${wallet.shortAddress(det.safe)} · deployer ${wallet.shortAddress(det.rescuer)}`;
        out.className = 'small';
      } else {
        out.textContent = det.reason + ' — Execute will ask to deploy a new one.';
        out.className = 'small';
      }
    } catch (e) {
      out.textContent = 'Could not read that contract — ' + (e?.shortMessage || e?.message || String(e));
    }
  };
  input.addEventListener('input', run);
  input.addEventListener('paste', () => setTimeout(run, 0));
}

// MAX: read the target's full ERC-20 balance and fill the amount field with
// it — the typed value then goes through the same validation path as any
// other amount (the field accepts the literal "MAX" as well).
async function fillMaxRescueAmount() {
  try {
    const net = getNetworkById(get('networkId'));
    const provider = await getProvider(net.chainId);
    const tokenAddr = $('#rescueTokenAddr')?.value.trim() || '';
    if (!wallet.isValidAddress(tokenAddr)) return toast('Enter the token address first', 'error');
    const derived = deriveTargetAddress();
    if (derived.error) return toast(derived.error, 'error');
    const tc = new ethers.Contract(tokenAddr,
      ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'], provider);
    const [bal, dec] = await Promise.all([
      tc.balanceOf(derived.address),
      tc.decimals().then(Number).catch(() => 18)
    ]);
    const d = (Number.isInteger(dec) && dec >= 0 && dec <= 36) ? dec : 18;
    const el = $('#rescueAmount');
    if (el) el.value = ethers.formatUnits(bal, d);
    toast('MAX filled from the wallet balance', 'info');
  } catch (e) {
    toast('Could not read the token balance: ' + (e?.shortMessage || e?.message || e), 'error');
  }
}

// ── target key: mandatory for every rescue deploy & execute ──────────
// (user, 2026-10-06: "fitur rescue kalau mau deploy harus masukin Target
// private key"). The empty-field fallback derived the ACTIVE wallet as the
// target: a deploy recorded a "Rescue target" that was not the target, and
// an execute signed the 7702 authorization with whatever wallet happened
// to be unlocked — the wrong authority for the tuple. Local check FIRST,
// before the sponsor picker: no password prompt over a dead end. Returns
// the key, or null after a toast already said why.
function requireTargetKey() {
  const key = $('#rescueTargetKey')?.value.trim() || '';
  if (!key) { toast('Target private key is required for rescue', 'error'); return null; }
  if (!addressFromKey(key)) { toast('Invalid target private key', 'error'); return null; }
  return key;
}

async function executeRescue() {
  if (!get('unlocked')) { requireUnlock(); return; }
  const safe = $('#rescueSafe').value.trim();
  const type = $('#rescueType').value;
  const tokenAddr = $('#rescueTokenAddr').value.trim();
  const tokenIds = $('#rescueTokenId').value.trim();

  // Cheap local validation FIRST, secrets after: resolving the sponsor picker
  // can open a password prompt (and, since auto-detect was removed, stops with
  // a toast) — none of that may hide a plainly invalid address behind it.
  if (!wallet.isValidAddress(safe)) return toast('Invalid SAFE address', 'error');
  if (!wallet.isValidAddress(tokenAddr)) return toast('Invalid token contract address', 'error');
  // Target key first — a missing key must not hide behind a password prompt.
  if (requireTargetKey() === null) return;

  const sponsorKey = await sponsorKeyFromPicker('#rescueSponsorFrom');
  if (sponsorKey === null) return;            // password prompt cancelled
  if (sponsorKey && !addressFromKey(sponsorKey)) return toast('Invalid sponsor private key', 'error');

  const derived = deriveTargetAddress();
  if (derived.error) return toast(derived.error, 'error');
  const target = derived.address;

  // The 7702 authorization MUST be signed by the target itself — it is the
  // authority of the tuple; the sponsor can only pay gas. The target's key
  // is REQUIRED at entry now (requireTargetKey, user 2026-10-06: "kalau mau
  // deploy harus masukin Target private key"): the old active-wallet
  // fallback signed with whatever wallet happened to be unlocked. The
  // address itself comes from deriveTargetAddress above, so the key and
  // the address it claims can no longer disagree.
  const targetKey = $('#rescueTargetKey')?.value.trim() || '';
  const sponsorAddress = sponsorAddressOf(sponsorKey);
  if (!sponsorAddress) return toast('No usable sponsor — choose a sponsor wallet', 'error');
  // Validated: out of the document; the local strings hold them from here.
  wipeKeyField('#rescueTargetKey');

  const net = getNetworkById(get('networkId'));
  const provider = await getProvider(net.chainId);

  // ERC-20 amount is explicit (manual or MAX): read the token's scale and the
  // target's on-chain balance BEFORE the prompt, so the number the user
  // confirms is real and an impossible amount is refused before anyone signs.
  let rescueWei = null;
  let rescueDecimals = 18;
  let rescueSymbol = '';
  const rescueAmtRaw = ($('#rescueAmount')?.value.trim() || '');
  if (type === 'erc20') {
    try {
      const tc = new ethers.Contract(tokenAddr,
        ['function decimals() view returns (uint8)', 'function symbol() view returns (string)'], provider);
      rescueDecimals = Number(await tc.decimals());
      rescueSymbol = String(await tc.symbol()).trim() || '';
      if (!Number.isInteger(rescueDecimals) || rescueDecimals < 0 || rescueDecimals > 36) rescueDecimals = 18;
    } catch { toast('Could not read token decimals/symbol — assuming 18.', 'info'); }
    try {
      const bc = new ethers.Contract(tokenAddr, ['function balanceOf(address) view returns (uint256)'], provider);
      const targetBal = await bc.balanceOf(target);
      if (rescueAmtRaw.toUpperCase() === 'MAX') {
        rescueWei = targetBal;
        const amtEl = $('#rescueAmount');
        if (amtEl) amtEl.value = ethers.formatUnits(targetBal, rescueDecimals);
      } else {
        try { rescueWei = ethers.parseUnits(rescueAmtRaw, rescueDecimals); }
        catch { return toast('Invalid token amount', 'error'); }
      }
      if (rescueWei <= 0n) return toast('Token amount must be greater than zero', 'error');
      if (rescueWei > targetBal) {
        return toast(`Token amount exceeds the wallet balance (${ethers.formatUnits(targetBal, rescueDecimals)} ${rescueSymbol}) — rescue cancelled`, 'error');
      }
    } catch (e) {
      return toast('Could not read the token balance — ' + (e?.shortMessage || e?.message || e), 'error');
    }
  }

  // Pasted helper address: probe it on-chain AFTER the balance guard (T5:
  // amount problems must fail before ANY prompt) and BEFORE the confirmation,
  // so a mismatch is decided up front — "deploy baru?" (OK = fresh deploy
  // path, Cancel = abort), never a silent reuse of a contract that can only
  // revert.
  const manualHelperRaw = $('#rescueHelperAddr')?.value.trim() || '';
  let manualHelper = null;
  if (manualHelperRaw) {
    if (!wallet.isValidAddress(manualHelperRaw)) return toast('Invalid contract address', 'error');
    const det = await probeRescueContract(manualHelperRaw, provider, safe, sponsorAddress);
    if (det.ok) {
      manualHelper = { address: manualHelperRaw, abi: RESCUE_MANUAL_ABI, reused: true };
      // Record it: the probe proved SAFE+RESCUER match, which is exactly the
      // registry predicate — next run reuses it without pasting again.
      saveDeployed('rescue', manualHelperRaw,
        { chainId: Number(net.chainId), safe, target, sponsor: sponsorAddress, abi: RESCUE_MANUAL_ABI });
      toast('Using the pasted rescue contract: ' + wallet.shortAddress(manualHelperRaw), 'info');
    } else {
      const okProbe = await confirmTx({
        title: 'Pasted contract unusable — deploy a new one?',
        rows: [
          { k: 'Contract', v: manualHelperRaw },
          { k: 'Detected', v: det.reason },
          { k: 'Action', v: 'Deploy a fresh rescue helper (saved, reused on later runs)' },
        ],
        confirmText: 'Deploy baru',
      });
      if (!okProbe) return toast('Rescue cancelled — paste a matching contract or leave the field empty.', 'info');
      // fall through to the registry/ensure-deploy path below
    }
  }

  {
    const ok = await confirmTx({
      title: net.type === 'mainnet' ? 'RESCUE ON MAINNET!' : `Rescue from ${wallet.shortAddress(target)}?`,
      rows: [
        { k: 'Locked wallet', v: wallet.shortAddress(target) },
        { k: 'SAFE destination', v: wallet.shortAddress(safe) },
        { k: 'Token type', v: type.toUpperCase() },
        ...(type === 'erc20' ? [{ k: 'Amount', v: `${rescueAmtRaw} ${rescueSymbol}` }] : []),
        { k: 'Authorization', v: targetKey ? 'Target private key (validated)' : 'Unlocked target wallet' },
        { k: 'Gas sponsor (executor)', v: wallet.shortAddress(sponsorAddress) },
        { k: 'Network', v: net.name },
        { k: 'Delegation', v: 'Permanent until revoked (Tools → Revoke)' },
      ],
      confirmText: 'Rescue', danger: net.type === 'mainnet'
    });
    if (!ok) return;
  }

  await runTx('eip7702-rescue', $('#btnRescue'), async () => {
    const chainId = Number(net.chainId);
    // Gas sponsor must exist in BOTH branches (reuse and fresh deploy) and is
    // used again at delegateAndExecute. Declared in the `else` branch it was
    // out of scope at that call → ReferenceError on every rescue.
    const sponsorSigner = sponsorSignerOf(sponsorKey, provider);

    // Match on what the constructor actually received — SAFE and the sponsor
    // (RESCUER). Pasted contract already probed OK → use it directly (no
    // registry round-trip). Belum ada → deploy di sini setelah konfirmasi
    // eksplisit (tidak pernah senyap).
    const helper = manualHelper || await ensureDeployedHelper('rescue', 'Rescue', chainId,
      item => item.safe?.toLowerCase() === safe.toLowerCase()
        && item.sponsor?.toLowerCase() === sponsorAddress.toLowerCase(),
      provider,
      async () => {
        const { abi, bytecode } = await compileSource(RESCUE_SOURCE, 'rescue');
        const contract = await deployContract(sponsorSigner, abi, bytecode, [safe, sponsorAddress]);
        const addr = await contract.getAddress();
        const dtx = contract.deploymentTransaction();
        saveDeployed('rescue', addr, { chainId, safe, target, sponsor: sponsorAddress, abi });
        addActivity({ hash: dtx?.hash, type: 'deploy-helper', status: 'success', ts: Date.now(), detail: `rescue → ${addr}` });
        return { address: addr, abi };
      });
    if (!helper) return;
    const rescueContract = new ethers.Contract(helper.address, helper.abi, provider);
    if (helper.reused) toast('Using rescue contract: ' + wallet.shortAddress(helper.address), 'info');
    const rescueAddr = await rescueContract.getAddress();

    // Build calldata by token type (ETH-only rescue was dropped per user
    // request — ERC-20 + ERC-721 are the two assets worth sweeping).
    let calldata;
    if (type === 'erc20') {
      // Explicit amount: manual entry or MAX (which reads the full balance
      // into the field). The old all-sweep took the choice away.
      calldata = rescueContract.interface.encodeFunctionData('rescueERC20', [tokenAddr, rescueWei]);
    } else if (type === 'erc721') {
      const ids = tokenIds.split(',').map(s => BigInt(s.trim())).filter(n => n >= 0n);
      if (!ids.length) return toast('Enter valid token IDs', 'error');
      calldata = rescueContract.interface.encodeFunctionData('rescueERC721', [tokenAddr, ids]);
    } else {
      return toast('Unsupported asset type', 'error');
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
  const amountRaw = $('#claimAmount')?.value.trim() || '';
  const safe = $('#claimSafe').value.trim();
  const targetKeyField = $('#claimTargetKey')?.value.trim() || '';

  if (!wallet.isValidAddress(contractAddr)) return toast('Invalid airdrop contract address', 'error');
  if (!claimData || !/^0x[0-9a-fA-F]*$/.test(claimData)) return toast('Invalid claim calldata (must be 0x-hex)', 'error');
  // The token contract is MANDATORY ERC-20: the guaranteed minimum can only be
  // compared when there is a comparable amount. address(0)/ETH mode is gone —
  // sweeping plain ETH is the Rescue flow's job.
  if (!wallet.isValidAddress(tokenAddr) || tokenAddr.toLowerCase() === ethers.ZeroAddress.toLowerCase()) {
    return toast('Token contract is required (ERC-20) — address(0) is refused', 'error');
  }
  if (!amountRaw) return toast('Claim amount is required (it is granted on-chain as the minimum)', 'error');
  if (!wallet.isValidAddress(safe) || safe.toLowerCase() === ethers.ZeroAddress.toLowerCase()) return toast('Invalid SAFE address', 'error');
  // Inputs all valid → now (and only now) resolve the sponsor, which may ask
  // for the keystore password. A missing sponsor must not mask a bad address.
  const sponsorKey = await sponsorKeyFromPicker('#claimSponsorFrom');
  if (sponsorKey === null) return;            // password prompt cancelled
  if (sponsorKey && !addressFromKey(sponsorKey)) return toast('Invalid sponsor private key', 'error');
  const sponsorAddress = sponsorAddressOf(sponsorKey);
  if (!sponsorAddress) return toast('No usable sponsor — choose a sponsor wallet', 'error');

  // The TARGET signs the authorization — same rule as rescue: pasted key
  // wins, the active wallet is the fallback. Validated before use.
  let targetAddress;
  if (targetKeyField) {
    const derivedKey = addressFromKey(targetKeyField);
    if (!derivedKey) return toast('Invalid target private key', 'error');
    targetAddress = derivedKey;
  } else {
    targetAddress = get('address');
    if (!targetAddress) return toast('Unlock the target wallet or paste its private key', 'error');
  }

  const net = getNetworkById(get('networkId'));
  const provider = await getProvider(net.chainId);
  const targetSigner = targetKeyField
    ? new ethers.Wallet(targetKeyField, provider)
    : get('signer').connect(provider);
  wipeKeyField('#claimTargetKey');

  // Read the token's scale first so the typed amount is encoded with the right
  // decimals, and take the before-numbers the result box will compare against.
  let decimals = 18;
  let symbol = '?';
  try {
    const tc = new ethers.Contract(tokenAddr,
      ['function decimals() view returns (uint8)', 'function symbol() view returns (string)'], provider);
    decimals = Number(await tc.decimals());
    symbol = String(await tc.symbol()).trim() || '?';
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) decimals = 18;
  } catch { toast('Could not read token decimals/symbol — assuming 18.', 'info'); }

  let minWei;
  try { minWei = ethers.parseUnits(amountRaw, decimals); } catch { return toast('Invalid claim amount', 'error'); }
  if (minWei <= 0n) return toast('Claim amount must be greater than zero', 'error');

  let safeBefore = null, safeAfter = null, eoaBefore = null, eoaAfter = null;
  let balReadOk = true;
  try {
    const bc = new ethers.Contract(tokenAddr, ['function balanceOf(address) view returns (uint256)'], provider);
    safeBefore = await bc.balanceOf(safe);
    eoaBefore = await bc.balanceOf(targetAddress);
  } catch { balReadOk = false; }

  {
    const ok = await confirmTx({
      title: net.type === 'mainnet' ? 'CLAIM AIRDROP ON MAINNET!' : `Claim on ${net.name}?`,
      rows: [
        { k: 'Airdrop contract', v: wallet.shortAddress(contractAddr) },
        { k: 'Token', v: `${symbol} (${wallet.shortAddress(tokenAddr)})` },
        { k: 'Minimum (on-chain)', v: `${amountRaw} ${symbol} = ${minWei.toString()} units` },
        { k: 'Forward to', v: wallet.shortAddress(safe) },
        { k: 'Target', v: wallet.shortAddress(targetAddress) + (targetKeyField ? ' (pasted key)' : ' (active wallet)') },
        { k: 'Gas sponsor', v: wallet.shortAddress(sponsorAddress) },
        { k: 'Network', v: net.name },
        { k: 'Delegation', v: 'Permanent until revoked (Tools → Revoke)' },
      ],
      confirmText: 'Claim', danger: net.type === 'mainnet'
    });
    if (!ok) return;
  }

  await runTx('eip7702-claim', $('#btnClaim'), async () => {
    const chainId = Number(net.chainId);
    // Same fix as executeRescue: the sponsor payer is needed in both the
    // reuse and the deploy branch AND at delegateAndExecute.
    const sponsorSigner = sponsorSignerOf(sponsorKey, provider);

    // RESCUER kontrak = sponsor pembayaran. Reuse now ALSO asks the ABI for
    // claimAndForwardMin: a helper saved before v1.2.0 has only the old
    // variant and would revert on the minimum calldata — redeploy instead of
    // trusting the label. Belum ada / tidak serasi → deploy setelah konfirmasi
    // eksplisit (tidak pernah senyap).
    const helper = await ensureDeployedHelper('airdrop', 'Claim', chainId,
      item => String(item.rescuer || item.target || '').toLowerCase() === sponsorAddress.toLowerCase()
        && abiHasName(item.abi, 'claimAndForwardMin'),
      provider,
      async () => {
        const { abi, bytecode } = await compileSource(AIRDROP_CLAIMER_SOURCE, 'airdropClaimer');
        const contract = await deployContract(sponsorSigner, abi, bytecode, [sponsorAddress]);
        const addr = await contract.getAddress();
        const dtx = contract.deploymentTransaction();
        saveDeployed('airdrop', addr, { chainId, target: targetAddress, rescuer: sponsorAddress, abi });
        addActivity({ hash: dtx?.hash, type: 'deploy-helper', status: 'success', ts: Date.now(), detail: `airdrop → ${addr}` });
        return { address: addr, abi };
      });
    if (!helper) return;
    const claimerContract = new ethers.Contract(helper.address, helper.abi, provider);
    if (helper.reused) toast('Reusing claimer contract: ' + wallet.shortAddress(helper.address), 'info');
    const claimerAddr = await claimerContract.getAddress();

    // v1.2.0: the claimed amount is GUARANTEED on-chain — below the typed
    // minimum the whole transaction reverts, so funds never move halfway.
    const calldata = claimerContract.interface.encodeFunctionData('claimAndForwardMin', [
      contractAddr,
      claimData,
      tokenAddr,
      safe,
      minWei
    ]);

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
    // The numbers are the proof: re-read both balances and show them side by
    // side — success or failure, the box states what actually moved.
    if (balReadOk) {
      try {
        const bc = new ethers.Contract(tokenAddr, ['function balanceOf(address) view returns (uint256)'], provider);
        safeAfter = await bc.balanceOf(safe);
        eoaAfter = await bc.balanceOf(targetAddress);
      } catch { /* leave the nulls — the box prints n/a instead of inventing */ }
    }
    const box = $('#claimResult');
    if (box) {
      const fmt = (v) => (v == null ? 'n/a' : ethers.formatUnits(v, decimals));
      const delta = (safeBefore != null && safeAfter != null) ? safeAfter - safeBefore : null;
      box.classList.remove('hidden');
      box.innerHTML =
        `<div class="small"><strong>Claim result</strong> — ${escapeHtml(symbol)}</div>` +
        `<div class="small">SAFE: ${fmt(safeBefore)} → ${fmt(safeAfter)}` +
        (delta != null ? ` (${delta >= 0n ? '+' : ''}${fmt(delta)})` : '') + '</div>' +
        `<div class="small">EOA: ${fmt(eoaBefore)} → ${fmt(eoaAfter)}</div>`;
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

export function deriveTargetAddress(keySel = '#rescueTargetKey') {
  const key = $(keySel)?.value.trim() || '';
  if (key) {
    const addr = addressFromKey(key);
    return addr ? { address: addr } : { error: 'Invalid target private key' };
  }
  const unlocked = get('address');
  if (!unlocked) return { error: 'Unlock the target wallet or paste its private key' };
  return { address: String(unlocked) };
}

/** Who pays for gas — the wallet picked in the sponsor picker. The
 *  active-wallet fallback left with the auto-detect entry (2026-10-06);
 *  '' cannot reach this anymore: sponsorKeyFromPicker stops the flow first. */
export function sponsorAddressOf(sponsorKey) {
  return sponsorKey ? addressFromKey(sponsorKey) : null;
}

/** Same rule as sponsorAddressOf, as a signing object. Must stay in lockstep:
 *  deploy records this address, execute matches on it — resolving them
 *  differently on the two sides would strand a perfectly good helper. Both
 *  sides now resolve ONLY the picked wallet (auto-detect removed 10-06). */
function sponsorSignerOf(sponsorKey, provider) {
  if (sponsorKey) return new ethers.Wallet(sponsorKey, provider);
  // Defensive: every caller stops on null first — '' must never silently
  // pick the active wallet now that the auto entry is gone.
  throw new Error('Choose a sponsor wallet');
}

// ── sponsor = a wallet picker, not a key box ────────────────────────────────
// Live request (user, 2026-10-03): "Sponsor private key ganti jadi auto
// detect yang udah kepasang di appnya dan bisa pilih wallet". The app already
// holds these keys in the keystore — pasting one into a second field only
// put a copy of the secret in the DOM. Options fill from the saved wallets.
// Reversal (user, 2026-10-06): "sponsor wallet auto detect hapus aja, fitur
// bisa milih wallet aja" — the auto entry is gone; the picker lists wallets
// only and an empty pick stops the flow instead of assuming the active one.
function sponsorOptionsHtml() {
  const accounts = wallet.getAccounts() || [];
  return accounts.map((a, i) =>
    `<option value="${i}">${escapeHtml(a.name || 'Wallet ' + (i + 1))} — ${escapeHtml(wallet.shortAddress(a.address))}</option>`
  ).join('');
}

export function renderSponsorPickers() {
  for (const id of ['rescueSponsorFrom', 'claimSponsorFrom', 'revokeSponsorFrom']) {
    const sel = $('#' + id);
    if (!sel) continue;
    const keep = sel.value;
    sel.innerHTML = sponsorOptionsHtml();   // wallets only — no auto entry (2026-10-06)
    if (keep && [...sel.options].some(o => o.value === keep)) sel.value = keep;
  }
}

/**
 * Resolve the chosen picker to a sponsor private key.
 * Returns the chosen account's key, or null when nothing is picked (the
 * auto entry was removed 2026-10-06 — the flow stops with a toast) or when
 * the user cancels the password prompt (callers must stop). The key is
 * derived straight from the keystore and never written to the DOM.
 */
export async function sponsorKeyFromPicker(selId) {
  const sel = $(selId);
  const choice = sel ? String(sel.value || '') : '';
  if (!choice) {                              // no auto pick anymore: stop with a toast
    toast('Choose a sponsor wallet', 'error');
    return null;
  }
  let secret = wallet.getSession();
  if (!secret) {
    const pw = await promptPassword('Enter password to use the chosen sponsor wallet');
    if (!pw) return null;                     // cancelled
    try { secret = await wallet.exportSecret(pw); }
    catch { toast('Wrong password', 'error'); return null; }
  }
  try {
    return wallet.signerFromSecret(secret, Number(choice)).privateKey;
  } catch (e) {
    toast(e?.message || 'Cannot derive the chosen sponsor wallet', 'error');
    return null;
  }
}

export function renderHelperStatus() {
  renderSponsorPickers();
  // Item: the dedicated "Check address (delegation)" box auto-fills with the
  // detected (active) wallet so Check reads THAT address by default.
  const rev = $('#revokeTarget');
  if (rev && !rev.value.trim() && get('address')) rev.value = get('address');
  // The Helper Contracts card is GONE (user request): each flow card carries
  // its own static "Deploy contract" button, bound ONCE in
  // bindEip7702ToolsEvents(). Re-rendering rows + re-binding listeners here
  // would stack duplicate click handlers on the static buttons.
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
      confirmText: 'Confirm',
      danger: net.type === 'mainnet',
    });
    if (!ok) { setBtnDots(btn, false); toast('Deploy cancelled', 'info'); return; }
    const { abi, bytecode } = await compileSource(BATCH_SOURCE, 'batch');
    const contract = await deployContract(signer, abi, bytecode);
    const addr = await contract.getAddress();
    const dtx = contract.deploymentTransaction();
    saveDeployed('batch', addr, { chainId: Number(net.chainId), deployer: get('address'), abi });
    addActivity({ hash: dtx?.hash, type: 'deploy-helper', status: 'success', ts: Date.now(), detail: `batch → ${addr}` });
    toast('Batch helper deployed: ' + wallet.shortAddress(addr), 'success');
    renderDeployedRegistry();
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
  // Local checks before the sponsor picker: a bad SAFE address is answered
  // with a toast, not with a password prompt over a dead end.
  if (!wallet.isValidAddress(safe)) return toast('Fill a valid SAFE address first', 'error');
  // Deploying records a Rescue target (user, 2026-10-06): the key that
  // defines it is mandatory, checked before any password prompt.
  if (requireTargetKey() === null) return;
  const sponsorKey = await sponsorKeyFromPicker('#rescueSponsorFrom');
  if (sponsorKey === null) return;            // password prompt cancelled
  const derived = deriveTargetAddress();
  if (derived.error) return toast(derived.error, 'error');
  const target = derived.address;
  if (sponsorKey && !addressFromKey(sponsorKey)) return toast('Invalid sponsor private key', 'error');
  const sponsorAddress = sponsorAddressOf(sponsorKey);
  if (!sponsorAddress) return toast('No usable sponsor — choose a sponsor wallet', 'error');

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
      confirmText: 'Confirm',
      danger: net.type === 'mainnet',
    });
    if (!ok) { setBtnDots(btn, false); toast('Deploy cancelled', 'info'); return; }
    const { abi, bytecode } = await compileSource(RESCUE_SOURCE, 'rescue');
    const contract = await deployContract(sponsorSigner, abi, bytecode, [safe, sponsorSigner.address]);
    const addr = await contract.getAddress();
    const dtx = contract.deploymentTransaction();
    saveDeployed('rescue', addr, { chainId: Number(net.chainId), safe, target, sponsor: sponsorSigner.address, abi });
    addActivity({ hash: dtx?.hash, type: 'deploy-helper', status: 'success', ts: Date.now(), detail: `rescue → ${addr}` });
    toast('Rescue helper deployed: ' + wallet.shortAddress(addr), 'success');
    const det = $('#rescueHelperDetect');
    if (det) det.textContent = 'Deployed: ' + addr;
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
  const sponsorKey = await sponsorKeyFromPicker('#claimSponsorFrom');
  if (sponsorKey === null) return;            // password prompt cancelled
  if (sponsorKey && !addressFromKey(sponsorKey)) return toast('Invalid sponsor private key', 'error');
  const sponsorAddress = sponsorAddressOf(sponsorKey);
  if (!sponsorAddress) return toast('No usable sponsor — choose a sponsor wallet', 'error');

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
      confirmText: 'Confirm',
      danger: net.type === 'mainnet',
    });
    if (!ok) { setBtnDots(btn, false); toast('Deploy cancelled', 'info'); return; }
    const { abi, bytecode } = await compileSource(AIRDROP_CLAIMER_SOURCE, 'airdropClaimer');
    // RESCUER = sponsor (yang membayar & broadcast tx eksekusi) — selaras dgn
    // rescue. Ikat ke target membuat onlyRescuer revert saat sponsor berbeda
    // dari wallet aktif.
    const contract = await deployContract(sponsorSigner, abi, bytecode, [sponsorAddress]);
    const addr = await contract.getAddress();
    const dtx = contract.deploymentTransaction();
    saveDeployed('airdrop', addr, { chainId: Number(net.chainId), target: targetAddress, rescuer: sponsorAddress, abi });
    addActivity({ hash: dtx?.hash, type: 'deploy-helper', status: 'success', ts: Date.now(), detail: `airdrop → ${addr}` });
    toast('Airdrop claimer deployed: ' + wallet.shortAddress(addr), 'success');
    renderHelperStatus();
    renderDeployedRegistry();
  } catch (e) {
    toast(e?.message || String(e), 'error');
  } finally {
    setBtnDots(btn, false);
  }
}

// ── deployed-contract registry UI ──
// After a helper lands on-chain, name + address go on screen immediately in
// the Deployed Contracts card (renderDeployedRegistry below, `data-copy`
// handled globally), instead of only a toast that disappears. The old
// #helperResult box lived on the removed Helper Contracts card.
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
      <button class="copy-btn" type="button" data-copy="${escapeHtml(item.address)}" title="Copy contract address" aria-label="Copy contract address"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
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

  // The TARGET signs the authorization; a sponsor ALWAYS pays and broadcasts
  // (reference flow — the self-only path is gone). Same shape as rescue/claim:
  // targetSigner.authorizeSync + sponsorSigner.sendTransaction.
  const sponsorKey = await sponsorKeyFromPicker('#revokeSponsorFrom');
  if (sponsorKey === null) return;            // password prompt cancelled
  if (sponsorKey && !addressFromKey(sponsorKey)) return toast('Invalid sponsor private key', 'error');
  const sponsorAddress = sponsorAddressOf(sponsorKey);
  if (!sponsorAddress) return toast('No usable sponsor — choose a sponsor wallet', 'error');

  // Item 12: locked wallet + the target IS the active wallet (no pasted key)
  // → the signing key only exists after unlock, so raise the password prompt
  // NOW instead of crashing on get('signer').connect (null). Pasted target key
  // or a foreign target still works without unlock.
  const isSelf = target.toLowerCase() === (get('address') || '').toLowerCase();
  if (isSelf && !get('unlocked') && !addressFromKey(key)) { requireUnlock(); return; }

  let targetSigner;
  if (isSelf) {
    targetSigner = get('signer').connect(provider);
  } else if (!addressFromKey(key)) {
    return toast('Target is not the active wallet — provide its private key', 'error');
  } else {
    targetSigner = new ethers.Wallet(key, provider);
  }
  const sponsorSigner = sponsorSignerOf(sponsorKey, provider);

  const delegate = await getDelegation(provider, target);
  if (!delegate) return toast('No active delegation on this address — nothing to revoke.', 'info');

  const ok = await confirmTx({
    title: 'Revoke EIP-7702 Delegation',
    rows: [
      { k: 'Target', v: target },
      { k: 'Current delegation', v: delegate },
      { k: 'Gas sponsor (executor)', v: wallet.shortAddress(sponsorAddress) },
      { k: 'Action', v: 'Revoke (back to plain EOA)' }
    ],
    confirmText: 'Revoke', danger: true
  });
  if (!ok) return;

  const btn = $('#btnRevokeDelegation');
  if (btn) setBtnDots(btn, true, 'Revoking');
  try {
    // Nonce rule (reference): the tuple carries the AUTHORITY's current nonce
    // — raw — except when the sponsor IS the target (self-sponsor pays): the
    // sender's nonce is consumed first, so that one tuple needs +1. A wrong
    // nonce is silently SKIPPED: the tx mines with status 1, the delegation
    // survives — a revoke that failed without saying so.
    const nonce = await provider.getTransactionCount(target);
    const selfSponsor = String(sponsorAddress).toLowerCase() === String(target).toLowerCase();
    const authNonce = selfSponsor ? nonce + 1 : nonce;
    const authorization = targetSigner.authorizeSync({ chainId: net.chainId, address: EIP7702.ZERO_ADDRESS, nonce: authNonce });
    const feeData = await provider.getFeeData();
    const tx = await withTimeout(sponsorSigner.sendTransaction({
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

// ── paste → auto-detect: token & NFT identity + the DRAINER's balance ──────
// Live report: "harusnya yang kedetect pk (drainner) tokennya bukan wallet
// sponsor". The holder below is ALWAYS the target-key wallet (drainner,
// deriveTargetAddress — the key field's address, else the active wallet),
// never the sponsor picker. One probe sequence per field so a slow RPC
// cannot overwrite a newer paste.
function wireTokenDetect(inputSel, outSel, opts = {}) {
  const input = $(inputSel);
  const out = $(outSel);
  if (!input || !out) return;
  let seq = 0;
  const render = (html) => { out.classList.remove('hidden'); out.innerHTML = html; };
  const clear = () => { out.classList.add('hidden'); out.innerHTML = ''; };

  const run = async () => {
    const addr = input.value.trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) { clear(); return; }
    const mine = ++seq;
    const derived = deriveTargetAddress(opts.keySel);
    if (derived.error) { render(escapeHtml(derived.error)); return; }
    const holder = derived.address;          // ← the drainner, not the sponsor
    const net = getNetworkById(get('networkId'));
    let provider;
    try { provider = await getProvider(net.chainId); }
    catch (e) { render('Network not ready — ' + escapeHtml(e?.message || String(e))); return; }
    if (mine !== seq) return;
    render('Detecting — reading the contract…');
    try {
      const c = new ethers.Contract(addr, [
        'function name() view returns (string)',
        'function symbol() view returns (string)',
        'function decimals() view returns (uint8)',
        'function balanceOf(address) view returns (uint256)',
        'function balanceOf(address,uint256) view returns (uint256)',
        'function ownerOf(uint256) view returns (address)',
        'function uri(uint256) view returns (string)',
      ], provider);
      const soft = async (fn) => { try { return await fn(); } catch { return null; } };
      const [sym, nm, dec] = await Promise.all([soft(() => c.symbol()), soft(() => c.name()), soft(() => c.decimals())]);
      if (mine !== seq) return;
      const bal = await soft(() => c['balanceOf(address)'](holder));
      const owned = await soft(() => c.ownerOf(1n));   // ERC-721 marker
      const uri1 = await soft(() => c.uri(1n));        // ERC-1155 marker
      if (mine !== seq) return;
      const holderTxt = `drainner ${wallet.shortAddress(holder)}`;

      if (owned != null) {                             // ERC-721
        const total = bal ?? 0n;
        render(`<strong>ERC-721 NFT</strong> · ${escapeHtml(nm || sym || 'Unnamed collection')}<br>` +
          `Owned by ${holderTxt}: <strong>${escapeHtml(String(total))}</strong> token${total === 1n ? '' : 's'}`);
        return;
      }
      if (uri1 != null) {                              // ERC-1155
        const rawId = opts.idSel ? String($(opts.idSel)?.value.trim() || '') : '';
        let balTxt = 'enter a Token ID for the balance';
        if (/^\d+$/.test(rawId)) {
          const v = await soft(() => c['balanceOf(address,uint256)'](holder, BigInt(rawId)));
          if (mine !== seq) return;
          if (v != null) balTxt = String(v);
        }
        render(`<strong>ERC-1155</strong> · ${escapeHtml(nm || sym || 'Multi-token')}<br>` +
          `Balance of ${holderTxt} (id ${escapeHtml(rawId || '?')}): <strong>${escapeHtml(balTxt)}</strong>`);
        return;
      }
      if (sym != null || nm != null || dec != null) {  // ERC-20
        const d = Number(dec ?? 18);
        const safeDec = Number.isInteger(d) && d >= 0 && d <= 36 ? d : 18;
        render(`<strong>ERC-20</strong> · ${escapeHtml(sym || nm || 'Unknown token')}` +
          (nm && sym && nm !== sym ? ` · ${escapeHtml(nm)}` : '') + ` · ${safeDec} decimals<br>` +
          `Balance of ${holderTxt}: <strong>${escapeHtml(ethers.formatUnits(bal ?? 0n, safeDec))}</strong>`);
        return;
      }
      render('No ERC-20/NFT metadata at that address on ' + escapeHtml(net.name) + '.');
    } catch (e) {
      if (mine !== seq) return;
      render('Could not read that contract — ' + escapeHtml(e?.shortMessage || e?.message || String(e)));
    }
  };

  input.addEventListener('input', run);
  input.addEventListener('paste', () => setTimeout(run, 0));
  if (opts.idSel) $(opts.idSel)?.addEventListener('input', run);
  if (opts.keySel) $(opts.keySel)?.addEventListener('input', run);
  clear();
}

// ── bind all events ──
export function bindEip7702ToolsEvents() {
  // Batch (view-deploy only if batch elements exist)
  $('#btnBatchAdd')?.addEventListener('click', addBatchItem);
  $('#btnBatchExecute')?.addEventListener('click', executeBatch);
  // Per-flow "Deploy contract" buttons (the Helper Contracts card is gone —
  // each card carries its own now).
  $('#btnDeployBatchHelper')?.addEventListener('click', deployBatchHelper);

  // Rescue
  $('#rescueType')?.addEventListener('change', toggleRescueFields);
  $('#btnRescueMax')?.addEventListener('click', fillMaxRescueAmount);
  $('#btnRescue')?.addEventListener('click', executeRescue);
  $('#btnDeployRescueHelper')?.addEventListener('click', deployRescueHelper);
  // Paste → detect token/NFT identity + the DRAINNER's balance (not sponsor)
  wireTokenDetect('#rescueTokenAddr', '#rescueTokenDetect', { idSel: '#rescueTokenId' });
  // Paste → probe an existing rescue contract (SAFE/RESCUER deployer) on-chain
  wireRescueHelperDetect();
  toggleRescueFields();   // reflect the default (erc20) visibility on load

  // Claim
  $('#btnClaim')?.addEventListener('click', executeClaim);
  $('#btnDeployAirdropClaimer')?.addEventListener('click', deployAirdropClaimer);
  wireTokenDetect('#claimToken', '#claimTokenDetect', { keySel: '#claimTargetKey' });

  // Revoke delegation (Tools card)
  $('#btnCheckDelegation')?.addEventListener('click', checkDelegation);
  $('#btnRevokeDelegation')?.addEventListener('click', revokeDelegation);

  // Password toggle — the sponsor inputs are gone (wallet picker now);
  // the target key field keeps its reveal toggle.
  bindPasswordToggle('#btnRescueTargetKeyToggle', '#rescueTargetKey');

  // Helper status (step 1) + registry list
  renderHelperStatus();
  renderDeployedRegistry();
}
