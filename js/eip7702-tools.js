// ═══════════════════════════════════════════════════════════════
// Bear Tool — eip7702-tools.js
// Batch Call, Rescue Atomic, Claim Airdrop — via EIP-7702 delegation.
// Loads solc.js lazily from CDN for on-chain contract compilation.
// ═══════════════════════════════════════════════════════════════

import { $, toast, confirmTx, escapeHtml } from './ui.js';
import { get, set, addActivity, requireUnlock, emit } from './state.js';
import { runTx, waitForReceipt } from './safetx.js';
import { getNetworkById, getProvider, getDelegation, EIP7702 } from './network.js';
import * as wallet from './wallet.js';
import { saveDeployed, findDeployed, listDeployed, removeDeployed } from './registry.js';

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

// ── solc.js lazy loader ──
let solcInstance = null;
let solcLoading = false;

function ensureSolcLoaded() {
  return new Promise((resolve, reject) => {
    if (solcInstance) return resolve(solcInstance);
    if (solcLoading) {
      const check = setInterval(() => {
        if (solcInstance) { clearInterval(check); resolve(solcInstance); }
      }, 200);
      return;
    }
    solcLoading = true;
    toast('Loading Solidity compiler (~8MB, one-time)...', 'info');
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/solc@0.8.28/solc.js';
    script.onload = () => {
      solcInstance = globalThis.solc;
      solcLoading = false;
      toast('Solidity compiler ready!', 'success');
      resolve(solcInstance);
    };
    script.onerror = () => {
      solcLoading = false;
      reject(new Error('Failed to load solc.js from CDN'));
    };
    document.head.appendChild(script);
  });
}

// ── compile a Solidity source → { abi, bytecode } ──
async function compileSource(source, contractName) {
  const solc = await ensureSolcLoaded();
  const input = {
    language: 'Solidity',
    sources: { [contractName + '.sol']: { content: source } },
    settings: {
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } }
    }
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  if (output.errors) {
    const errs = output.errors.filter(e => e.severity === 'error');
    if (errs.length) throw new Error('Compile error: ' + errs[0].formattedMessage);
  }
  const contract = output.contracts?.[contractName + '.sol']?.[contractName];
  if (!contract?.evm?.bytecode?.object) throw new Error('No bytecode for ' + contractName);
  return { abi: contract.abi, bytecode: '0x' + contract.evm.bytecode.object };
}

// ── deploy a compiled contract ──
async function deployContract(signer, abi, bytecode, constructorArgs = []) {
  const factory = new ethers.ContractFactory(abi, bytecode, signer);
  const contract = await factory.deploy(...constructorArgs);
  await contract.waitForDeployment();
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
    // Self-sponsored: auth nonce = nonce + 1
    const authNonce = nonce + 1;

    const authorization = targetSigner.authorizeSync({
      chainId: net.chainId,
      address: implAddress,
      nonce: authNonce
    });

    const feeData = await provider.getFeeData();
    const sponsorSigner = opts.sponsorSigner || targetSigner;

    // Send delegation + calldata in one tx
    const tx = await sponsorSigner.sendTransaction({
      to: targetAddress,
      authorizationList: [authorization],
      data: calldata,
      maxFeePerGas: feeData.maxFeePerGas,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas
    });
    return tx;
  } else {
    // Already delegated — just send the calldata
    const signer = opts.sponsorSigner || opts.targetSigner;
    const feeData = await provider.getFeeData();
    const tx = await signer.sendTransaction({
      to: targetAddress,
      data: calldata,
      maxFeePerGas: feeData.maxFeePerGas,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas
    });
    return tx;
  }
}

// ── deployed-contract registry (reuse to save gas) ──
async function contractExists(provider, address) {
  try { return (await provider.getCode(address)) !== '0x'; } catch { return false; }
}

// Find a registry entry that is still alive on-chain. Stale entries
// (contract gone / wrong chain) are dropped so they never get reused.
async function findUsableDeployed(type, chainId, predicate, provider) {
  const found = findDeployed(type, chainId, predicate);
  if (!found) return null;
  if (await contractExists(provider, found.address)) return found;
  removeDeployed(type, found.address, chainId);
  return null;
}

// ── batch call helpers ──
let batchCalls = [];

function renderBatchList() {
  const list = $('#eip7702BatchList');
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
  if (!wallet.isValidAddress(valid[0].to)) return toast('Invalid target address', 'error');

  const net = getNetworkById(get('networkId'));
  if (net.type === 'mainnet') {
    const ok = await confirmTx({
      title: 'BATCH CALL ON MAINNET!',
      rows: [{ k: 'Calls', v: String(valid.length) }, { k: 'Network', v: net.name }],
      confirmText: 'Execute', danger: true, requireType: 'EXECUTE'
    });
    if (!ok) return;
  }

  await runTx('eip7702-batch', $('#btnEip7702BatchExec'), async () => {
    const provider = get('provider');
    const signer = get('signer').connect(provider);
    const chainId = Number(net.chainId);

    // Reuse an existing batch contract deployed by this wallet (gas savings)
    let batchContract;
    const existing = await findUsableDeployed('batch', chainId, item =>
      item.deployer?.toLowerCase() === get('address').toLowerCase(), provider);
    if (existing) {
      batchContract = new ethers.Contract(existing.address, existing.abi, signer);
      toast('Reusing batch contract: ' + wallet.shortAddress(existing.address), 'info');
    } else {
      toast('Compiling batch contract...', 'info');
      const { abi, bytecode } = await compileSource(BATCH_SOURCE, 'batch');
      batchContract = await deployContract(signer, abi, bytecode);
      const batchAddr = await batchContract.getAddress();
      saveDeployed('batch', batchAddr, { chainId, deployer: get('address'), abi });
      toast('Batch contract deployed: ' + wallet.shortAddress(batchAddr), 'success');
    }
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
  const type = $('#eip7702RescueType').value;
  $('#eip7702RescueTokenWrap').classList.toggle('hidden', type === 'eth');
  $('#eip7702RescueTokenIdWrap').classList.toggle('hidden', type !== 'erc721');
}

async function executeRescue() {
  if (!get('unlocked')) { requireUnlock(); return; }
  const target = $('#eip7702RescueTarget').value.trim();
  const safe = $('#eip7702RescueSafe').value.trim();
  const type = $('#eip7702RescueType').value;
  const tokenAddr = $('#eip7702RescueTokenAddr').value.trim();
  const tokenIds = $('#eip7702RescueTokenId').value.trim();
  const sponsorKey = $('#eip7702RescueSponsorKey').value.trim();

  if (!wallet.isValidAddress(target)) return toast('Invalid locked wallet address', 'error');
  if (!wallet.isValidAddress(safe)) return toast('Invalid SAFE address', 'error');
  if (type !== 'eth' && !wallet.isValidAddress(tokenAddr)) return toast('Invalid token contract address', 'error');
  if (!sponsorKey || !/^0x[a-fA-F0-9]{64}$/.test(sponsorKey)) return toast('Invalid sponsor private key', 'error');

  const net = getNetworkById(get('networkId'));
  if (net.type === 'mainnet') {
    const ok = await confirmTx({
      title: 'RESCUE ON MAINNET!',
      rows: [
        { k: 'Locked wallet', v: wallet.shortAddress(target) },
        { k: 'SAFE destination', v: wallet.shortAddress(safe) },
        { k: 'Token type', v: type.toUpperCase() },
        { k: 'Network', v: net.name }
      ],
      confirmText: 'Rescue', danger: true, requireType: 'RESCUE'
    });
    if (!ok) return;
  }

  await runTx('eip7702-rescue', $('#btnEip7702RescueExec'), async () => {
    const provider = await getProvider(net.chainId);
    const chainId = Number(net.chainId);
    // Gas sponsor must exist in BOTH branches (reuse and fresh deploy) and is
    // used again at delegateAndExecute. Declared in the `else` branch it was
    // out of scope at that call → ReferenceError on every rescue.
    const sponsorSigner = new ethers.Wallet(sponsorKey, provider);

    // Reuse an existing rescue contract for the same (safe, target) pair
    let rescueContract;
    const existing = await findUsableDeployed('rescue', chainId, item =>
      item.safe?.toLowerCase() === safe.toLowerCase() && item.target?.toLowerCase() === target.toLowerCase(), provider);
    if (existing) {
      rescueContract = new ethers.Contract(existing.address, existing.abi, provider);
      toast('Reusing rescue contract: ' + wallet.shortAddress(existing.address), 'info');
    } else {
      toast('Compiling rescue contract...', 'info');
      const { abi, bytecode } = await compileSource(RESCUE_SOURCE, 'rescue');
      rescueContract = await deployContract(sponsorSigner, abi, bytecode, [safe, target]);
      const rescueAddr = await rescueContract.getAddress();
      saveDeployed('rescue', rescueAddr, { chainId, safe, target, abi });
      toast('Rescue contract deployed: ' + wallet.shortAddress(rescueAddr), 'success');
    }
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

    // Delegate target wallet to rescue contract, then execute
    // The target wallet signs authorization, sponsor pays gas
    // For this to work, we need the target wallet's private key
    // In a real scenario, the target wallet would sign locally
    // Here we use the sponsor to send (target must be unlocked or provide key)
    const targetSigner = get('signer').connect(provider);

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
    addActivity({ hash: tx.hash, type: 'eip7702-rescue', status: receipt.status === 1 ? 'success' : 'failed', ts: Date.now(), detail: `Rescue ${type}` });
    toast(receipt.status === 1 ? 'Assets rescued! 🎉' : 'Rescue failed!', receipt.status === 1 ? 'success' : 'error');
    renderDeployedRegistry();
    emit('refresh');
  });
}

// ── claim airdrop ──
async function executeClaim() {
  if (!get('unlocked')) { requireUnlock(); return; }
  const contractAddr = $('#eip7702ClaimContract').value.trim();
  const claimData = $('#eip7702ClaimData').value.trim();
  const tokenAddr = $('#eip7702ClaimToken').value.trim();
  const safe = $('#eip7702ClaimSafe').value.trim();
  const sponsorKey = $('#eip7702ClaimSponsorKey').value.trim();

  if (!wallet.isValidAddress(contractAddr)) return toast('Invalid airdrop contract address', 'error');
  if (!claimData || !claimData.startsWith('0x')) return toast('Invalid claim calldata (must start with 0x)', 'error');
  if (!wallet.isValidAddress(safe)) return toast('Invalid SAFE address', 'error');
  if (!sponsorKey || !/^0x[a-fA-F0-9]{64}$/.test(sponsorKey)) return toast('Invalid sponsor private key', 'error');

  const net = getNetworkById(get('networkId'));
  if (net.type === 'mainnet') {
    const ok = await confirmTx({
      title: 'CLAIM AIRDROP ON MAINNET!',
      rows: [
        { k: 'Airdrop contract', v: wallet.shortAddress(contractAddr) },
        { k: 'Forward to', v: wallet.shortAddress(safe) },
        { k: 'Network', v: net.name }
      ],
      confirmText: 'Claim', danger: true, requireType: 'CLAIM'
    });
    if (!ok) return;
  }

  await runTx('eip7702-claim', $('#btnEip7702ClaimExec'), async () => {
    const provider = await getProvider(net.chainId);
    const chainId = Number(net.chainId);
    const targetAddress = get('address');
    // Same fix as executeRescue: the sponsor payer is needed in both the
    // reuse and the deploy branch AND at delegateAndExecute.
    const sponsorSigner = new ethers.Wallet(sponsorKey, provider);

    // Reuse an existing claimer contract for this wallet (gas savings)
    let claimerContract;
    const existing = await findUsableDeployed('airdrop', chainId, item =>
      item.target?.toLowerCase() === targetAddress.toLowerCase(), provider);
    if (existing) {
      claimerContract = new ethers.Contract(existing.address, existing.abi, provider);
      toast('Reusing claimer contract: ' + wallet.shortAddress(existing.address), 'info');
    } else {
      toast('Compiling airdrop claimer contract...', 'info');
      const { abi, bytecode } = await compileSource(AIRDROP_CLAIMER_SOURCE, 'airdropClaimer');
      claimerContract = await deployContract(sponsorSigner, abi, bytecode, [targetAddress]);
      const claimerAddr = await claimerContract.getAddress();
      saveDeployed('airdrop', claimerAddr, { chainId, target: targetAddress, abi });
      toast('Claimer contract deployed: ' + wallet.shortAddress(claimerAddr), 'success');
    }
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

// ── deployed-contract registry UI ──
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

// ── bind all events ──
export function bindEip7702ToolsEvents() {
  // Batch
  $('#btnEip7702BatchAdd').addEventListener('click', addBatchItem);
  $('#btnEip7702BatchExec').addEventListener('click', executeBatch);

  // Rescue
  $('#eip7702RescueType').addEventListener('change', toggleRescueFields);
  $('#btnEip7702RescueExec').addEventListener('click', executeRescue);

  // Claim
  $('#btnEip7702ClaimExec').addEventListener('click', executeClaim);

  // Password toggles
  bindPasswordToggle('#btnRescueKeyToggle', '#eip7702RescueSponsorKey');
  bindPasswordToggle('#btnClaimKeyToggle', '#eip7702ClaimSponsorKey');

  // Registry list (delegated remove buttons re-render themselves)
  renderDeployedRegistry();
}
