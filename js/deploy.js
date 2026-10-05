// ═══════════════════════════════════════════════════════════════
// Bear Tool — deploy.js
// Deploy wizard: pick a standard → compile it in-browser with solc →
// estimate gas → confirm → deploy → record the address.
// (This file used to be a STUB that only showed a toast — nothing was
// ever deployed, which is what "deploy gabisa" was.)
// ═══════════════════════════════════════════════════════════════

import { $, toast, confirmTx, escapeHtml, setBtnDots } from './ui.js';
import { get, requireUnlock, addActivity, emit } from './state.js';
import { getNetworkById, getProvider, getGasPrice } from './network.js';
import { waitForReceipt } from './safetx.js';
import { compileContract } from './solc.js';
import { getStandard, extraFieldsHtml, buildDeployPlan, buildTokenSource, PROXY_CONTRACT } from './contracts.js';
import { saveDeployed } from './registry.js';
import { autoVerify, getEtherscanKey, setEtherscanKey } from './verify.js';

const { ethers } = globalThis;

export function bindDeployEvents() {
  const sel = $('#deployStandard');
  if (sel && !sel.dataset.bound) {
    sel.dataset.bound = '1';
    sel.addEventListener('change', () => { renderDeployExtra(); renderDeployPreview(); });
  }
  const btn = $('#btnDeploy');
  if (btn && !btn.dataset.bound) {
    btn.dataset.bound = '1';
    btn.addEventListener('click', doDeploy);
  }
  const exp = $('#deployExport');
  if (exp && !exp.dataset.bound) {
    exp.dataset.bound = '1';
    exp.addEventListener('click', onExportClick);
  }
  // Premint presets: renderDeployExtra() REPLACES #deployExtra's innerHTML, so
  // the handler lives on the container (delegate) — buttons come and go.
  const extraBox = $('#deployExtra');
  if (extraBox && !extraBox.dataset.bound) {
    extraBox.dataset.bound = '1';
    extraBox.addEventListener('click', (ev) => {
      const pill = ev.target.closest('[data-preset-for]');
      if (!pill) return;
      const field = document.getElementById(pill.dataset.presetFor);
      if (!field) return;
      field.value = pill.dataset.preset;
      field.dispatchEvent(new Event('input', { bubbles: true }));
      toast(`Initial supply set to ${pill.textContent}`, 'ok');
    });
  }
  // M9: "Proxy type" means nothing until "Upgradeable" is ticked, so it is
  // born disabled (extraFieldsHtml) and flipped here. #deployExtra is rebuilt
  // wholesale on every standard change, so this is delegated like the presets.
  if (extraBox && !extraBox.dataset.boundProxy) {
    extraBox.dataset.boundProxy = '1';
    const syncProxyType = () => {
      const upg = document.getElementById('deployUpgradeable');
      const pt = document.getElementById('deployProxyType');
      if (upg && pt) pt.disabled = !upg.checked;
    };
    extraBox.addEventListener('change', syncProxyType);
    syncProxyType();
  }
  // Report: "Symbol (auto kapital semua)" — uppercase as you type, so the
  // input, the preview plan and buildDeployPlan all agree.
  const sym = $('#deploySymbol');
  if (sym && !sym.dataset.bound) {
    sym.dataset.bound = '1';
    sym.addEventListener('input', () => {
      const upper = sym.value.toUpperCase();
      if (sym.value !== upper) sym.value = upper;
    });
  }
  // Auto-verify key (M10): Sourcify runs keyless, Etherscan V2 takes this one
  // BYO key. Mirrors the OpenSea field — read on load, remembered on change.
  const vkey = $('#deployVerifyKey');
  if (vkey && !vkey.dataset.bound) {
    vkey.dataset.bound = '1';
    vkey.value = getEtherscanKey();
    vkey.addEventListener('change', () => {
      const saved = setEtherscanKey(vkey.value);
      vkey.value = saved;
      toast(saved ? 'Etherscan key saved (this browser only)' : 'Etherscan key cleared', 'ok');
    });
  }
  renderDeployExtra();
  renderDeployPreview();
}

// Last successful compile — what the export row hands out (source / ABI).
// Only valid after a compile succeeded; cleared when a new run starts.
let lastBuild = null;

async function onExportClick(ev) {
  const btn = ev.target.closest('[data-export]');
  if (!btn || !lastBuild) return;
  const kind = btn.dataset.export;
  try {
    if (kind === 'copy-abi') {
      await navigator.clipboard.writeText(JSON.stringify(lastBuild.abi, null, 2));
      toast('ABI copied', 'ok');
    } else if (kind === 'copy-source') {
      await navigator.clipboard.writeText(lastBuild.source);
      toast('Source copied', 'ok');
    } else if (kind === 'download-sol') {
      const blob = new Blob([lastBuild.source], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${lastBuild.contract}.sol`;
      a.click();
      URL.revokeObjectURL(url);
      toast(`${lastBuild.contract}.sol downloaded`, 'ok');
    }
  } catch (e) {
    toast(`Export failed: ${e.message}`, 'error');
  }
}

// Extra (per-standard) fields — name/symbol live in index.html.
export function renderDeployExtra() {
  const extra = $('#deployExtra');
  if (!extra) return;
  extra.innerHTML = extraFieldsHtml($('#deployStandard')?.value);
}

// Card shown above the Deploy button.
export function renderDeployPreview() {
  const box = $('#deployPreview');
  if (!box) return;
  const std = getStandard($('#deployStandard')?.value);
  box.innerHTML = `<div class="deploy-preview-card">
      <span class="deploy-preview-icon">${std.icon}</span>
      <span class="deploy-preview-text">${escapeHtml(std.preview)}</span>
    </div>`;
}

function setDeployStatus(html, kind = '') {
  const el = $('#deployStatus');
  if (!el) return;
  el.className = 'deploy-status' + (kind ? ' ' + kind : '');
  el.innerHTML = html;
  el.classList.remove('hidden');
}

function explorerTxLink(net, hash) {
  if (!net?.explorer) return '';
  return `${String(net.explorer).replace(/\/$/, '')}/tx/${hash}`;
}

export async function doDeploy() {
  if (!get('unlocked')) { requireUnlock(); return; }
  const std = getStandard($('#deployStandard')?.value);
  const btn = $('#btnDeploy');

  let plan;
  try {
    plan = buildDeployPlan({
      standard: std.id,
      name: $('#deployName')?.value,
      symbol: $('#deploySymbol')?.value,
      supply: $('#deploySupply')?.value,
      decimals: $('#deployDecimals')?.value,
      baseUri: $('#deployBaseUri')?.value,
      cap: $('#deployCap')?.value,
      burnable: $('#deployBurnable')?.checked,
      mintable: $('#deployMintable')?.checked,
      pausable: $('#deployPausable')?.checked,
      permit: $('#deployPermit')?.checked,
      votes: $('#deployVotes')?.checked,
      enumerable: $('#deployEnumerable')?.checked,
      uriStorage: $('#deployUriStorage')?.checked,
      access: $('#deployAccess')?.value,
      // M7: Callback / Flash Minting toggles + compiler configuration knobs.
      callback: $('#deployCallback')?.checked,
      flashmint: $('#deployFlashMint')?.checked,
      language: $('#deployLanguage')?.value,
      evmVersion: $('#deployEvmVersion')?.value,
      optimizer: $('#deployOptimizer')?.checked,
      runs: $('#deployRuns')?.value,
      // M8: NFT token ids (auto-inc vs mint(to, id)) + fallback image URL.
      autoInc: $('#deployAutoInc')?.checked,
      image: $('#deployImage')?.value,
      // M9: ERC-1967 proxy. The flag changes the SOURCE (constructor →
      // initialize, ERC1967Proxy appended) and makes the deploy two
      // transactions; proxyType picks where the upgrade gate lives.
      upgradeable: $('#deployUpgradeable')?.checked,
      proxyType: $('#deployProxyType')?.value
    });
  } catch (e) {
    return toast(e.message, 'error');
  }

  const net = getNetworkById(get('networkId'));
  if (btn) setBtnDots(btn, true, 'Compiling');
  setDeployStatus(`Compiling ${std.contract} with solc… (first run downloads ~9 MB)`);
  // A fresh run invalidates the previous export until this compile lands.
  lastBuild = null;
  $('#deployExport')?.classList.add('hidden');

  try {
    const t0 = Date.now();
    // Compose the source from the wizard flags (burnable/mintable/pausable/
    // cap) — the raw std.source path is gone; flag-off = the same template.
    // Built ONCE: the export row, the compiler and the verifier all publish
    // this exact string (M9 appends ERC1967Proxy when upgradeable).
    const source = buildTokenSource(std.id, plan.flags);
    const compiled = await compileContract(source, std.contract, {
      // M7 compiler configuration (language/evmVersion/optimizer/runs) —
      // validated in buildDeployPlan, absent = solc defaults.
      ...plan.compiler,
      onStatus: (msg) => setDeployStatus(escapeHtml(msg))
    });
    const seconds = ((Date.now() - t0) / 1000).toFixed(1);
    const sizeKb = ((compiled.bytecode.length - 2) / 2 / 1024).toFixed(1);
    setDeployStatus(`Compiled ${std.contract} in ${seconds}s · bytecode ${sizeKb} KB`, 'ok');
    // Compiled = exportable, even if the deploy is cancelled right after
    // (wizard parity: the code is the point, not only the broadcast).
    lastBuild = { source, abi: compiled.abi, contract: std.contract };
    $('#deployExport')?.classList.remove('hidden');
    for (const w of compiled.warnings.slice(0, 3)) console.warn('[BearTool deploy] solc warning:', w);

    if (btn) setBtnDots(btn, true, 'Estimating gas');
    const provider = await getProvider(net.chainId);
    const baseSigner = get('signer');
    if (!baseSigner) { requireUnlock(); return; }
    // Keystore signers have no provider attached — deploy() sends a
    // transaction, so connect before building the factory (same pattern as
    // send/swap/eip7702; otherwise: "missing provider").
    const signer = baseSigner.connect(provider);
    const factory = new ethers.ContractFactory(compiled.abi, compiled.bytecode, signer);
    // M9: an upgradeable build deploys TWO contracts, and the proxy's
    // constructor needs the implementation ADDRESS — which does not exist yet
    // at signing time. So the estimate can only be the implementation's, and
    // the dialog row says exactly that instead of implying a total it cannot
    // know. (The proxy's gas is estimated right before its own transaction.)
    const upg = Boolean(plan.flags.upgradeable);
    const deployTx = upg ? await factory.getDeployTransaction() : await factory.getDeployTransaction(...plan.args);

    let gasEstimate;
    try {
      gasEstimate = await provider.estimateGas({ ...deployTx, from: get('address') });
    } catch (e) {
      throw new Error('Gas estimation failed: ' + (e?.shortMessage || e?.message || String(e)));
    }
    const gasPrice = await getGasPrice(provider);
    const cost = gasEstimate * gasPrice;
    const costLabel = gasPrice > 0n
      ? `${ethers.formatEther(cost)} ${net.symbol} (${gasEstimate.toString()} gas @ ${ethers.formatUnits(gasPrice, 'gwei')} gwei)`
      : 'unknown';

    const ok = await confirmTx({
      title: net.type === 'mainnet' ? 'DEPLOY ON MAINNET!' : `Deploy ${std.contract} on ${net.name}?`,
      rows: [...plan.summary, { k: 'Network', v: net.name },
        // One signature releases TWO transactions when upgradeable — the
        // dialog must say so, and must not dress tx 1's estimate up as a total.
        { k: 'Transactions', v: upg ? '2 — implementation, then proxy (estimate above is tx 1 only)' : '1' },
        { k: upg ? 'Est. cost (implementation)' : 'Est. cost', v: costLabel }],
      confirmText: 'Confirm',
      danger: net.type === 'mainnet',
    });
    if (!ok) { setDeployStatus('Deploy cancelled.'); return; }

    if (btn) setBtnDots(btn, true, 'Deploying');

    let address;
    let tx;                 // the transaction that lands THE contract
    let receipt;
    let timedOut;
    let replaced = false;   // speed-up / drop-and-replace: a DIFFERENT hash landed
    let replacement = '';
    let implAddress = '';   // upgradeable only: where the logic lives
    let implTxHash = '';
    let initData = '';      // initialize(...) calldata, delegatecalled by the proxy
    let adminAddr = '';     // address(0) for UUPS, the deployer for Transparent

    if (upg) {
      // ── tx 1: the implementation. NO constructor arguments — everything it
      // needs is set through initialize() once, behind the proxy. Its own
      // constructor only locks _initialized so nobody squats on the logic.
      const implContract = await factory.deploy();
      const implTx = implContract.deploymentTransaction();
      implTxHash = implTx?.hash || '';
      addActivity({
        hash: implTx?.hash, type: 'deploy', status: 'pending', ts: Date.now(),
        detail: `${std.contract} implementation ${plan.name}`
      });
      const implRes = await waitForReceipt(implTx);
      implAddress = await implContract.getAddress();
      // Timeout and replacement are both checked BEFORE the activity row is
      // finalised: neither one is a failure, and a row that says "failed"
      // while the status line says "wait for it" is how a deploy gets paid
      // for twice.
      if (implRes.timedOut && !implRes.receipt) {
        setDeployStatus(`Implementation TX ${escapeHtml(String(implTx?.hash || '').slice(0, 12))}… sent but still unconfirmed. Address: <strong>${escapeHtml(implAddress)}</strong> — wait for it, then run the deploy again.`, 'warn');
        toast('Implementation sent — still confirming', 'info');
        return;
      }
      if (!implRes.receipt && !implRes.timedOut) { // speed-up / drop-and-replace
        setDeployStatus(`Implementation TX was replaced (speed-up or dropped) — ${escapeHtml(String(implRes.replacement || 'another transaction'))} took its place. Track it, then run the deploy again.`, 'warn');
        toast('Implementation tx replaced', 'info');
        return;
      }
      addActivity({
        hash: implTx?.hash, type: 'deploy',
        status: implRes.receipt?.status === 1 ? 'success' : 'failed', ts: Date.now(),
        detail: `${std.contract} implementation → ${implAddress}`
      });
      if (implRes.receipt?.status !== 1) {
        setDeployStatus('Implementation deploy reverted.', 'error');
        return toast('Implementation deploy failed (tx reverted)', 'error');
      }
      setDeployStatus(`Implementation confirmed at <strong>${escapeHtml(implAddress)}</strong> — deploying proxy…`, 'ok');
      if (btn) setBtnDots(btn, true, 'Deploying proxy');

      // ── tx 2: the proxy, carrying initialize() IN its constructor. Not
      // "deploy, then call initialize()" — that would leave a live, uninitialised
      // proxy for a block, and whoever called initialize() first would own the
      // token. The two calls are one transaction apart, not one block apart.
      const iface = new ethers.Interface(compiled.abi);
      initData = iface.encodeFunctionData('initialize', plan.args);
      // Transparent: the deployer admin is the one who can swap implementations.
      // The four admin selectors are the proxy's; every token call — the
      // admin's own included — is delegated, so this wallet can still spend
      // what it just deployed (the deliberate deviation is documented in
      // PROXY_SOURCE and pinned by the tests).
      // UUPS: no admin at all — the gate lives in the implementation.
      adminAddr = plan.flags.proxyType === 'transparent' ? get('address') : ethers.ZeroAddress;
      const proxyArt = compiled.contracts?.[PROXY_CONTRACT];
      if (!proxyArt?.bytecode) throw new Error(`${PROXY_CONTRACT} missing from the compilation output`);
      const proxyFactory = new ethers.ContractFactory(proxyArt.abi, proxyArt.bytecode, signer);
      // The one gas figure we could not know at signing time.
      try {
        await provider.estimateGas({
          ...(await proxyFactory.getDeployTransaction(implAddress, initData, adminAddr)),
          from: get('address')
        });
      } catch (e) {
        throw new Error('Proxy gas estimation failed: ' + (e?.shortMessage || e?.message || String(e)));
      }
      const proxyContract = await proxyFactory.deploy(implAddress, initData, adminAddr);
      tx = proxyContract.deploymentTransaction();
      addActivity({
        hash: tx?.hash, type: 'deploy', status: 'pending', ts: Date.now(),
        detail: `${PROXY_CONTRACT} proxy ${plan.name} (${plan.symbol})`
      });
      ({ receipt, timedOut, replaced, replacement } = await waitForReceipt(tx));
      address = await proxyContract.getAddress();
    } else {
      const contract = await factory.deploy(...plan.args);
      tx = contract.deploymentTransaction();
      addActivity({
        hash: tx?.hash, type: 'deploy', status: 'pending', ts: Date.now(),
        detail: `${std.contract} ${plan.name} (${plan.symbol})`
      });
      ({ receipt, timedOut, replaced, replacement } = await waitForReceipt(tx));
      address = await contract.getAddress();
    }

    // A speed-up / drop-and-replace lands under a DIFFERENT hash. Calling that
    // a revert would be a lie (it may well have landed) and recording it as a
    // success would be another (this address may never have been created), so
    // the row stays unresolved with the replacement hash attached.
    if (replaced && !receipt) {
      setDeployStatus(`Transaction replaced — ${escapeHtml(String(tx?.hash || '').slice(0, 12))}… gave way to <strong>${escapeHtml(String(replacement || 'a replacement tx'))}</strong>. Nothing was recorded: check the replacement before running the deploy again.`, 'warn');
      toast('Transaction replaced', 'info');
      return;
    }

    // Recorded only once the chain has confirmed it. It used to run before the
    // revert check, so a deploy whose transaction reverted was still filed as a
    // working token: the address exists (CREATE always yields one) but there is
    // no code at it, and every later screen would treat it as real. A timed-out
    // transaction is different — the address is real and the deploy may well
    // land, so that one is still recorded, just with the state left unresolved.
    const record = () => saveDeployed('token', address, {
      chainId: net.chainId, standard: std.id, name: plan.name, symbol: plan.symbol,
      deployer: get('address'), txHash: tx?.hash,
      // M9: the logic address is not the address the user holds. File both, or
      // an upgradeable token looks like it has no implementation.
      ...(upg ? { impl: implAddress, proxy: plan.flags.proxyType } : {})
    });

    if (timedOut && !receipt) {
      record();
      setDeployStatus(`TX ${escapeHtml(String(tx?.hash || '').slice(0, 12))}… sent but still unconfirmed. Contract address: <strong>${escapeHtml(address)}</strong>`, 'warn');
      toast('Deploy sent — still confirming', 'info');
      return;
    }
    const status = receipt?.status === 1 ? 'success' : 'failed';
    addActivity({
      hash: tx?.hash, type: 'deploy', status, ts: Date.now(),
      detail: `${std.contract} ${plan.name} (${plan.symbol}) → ${address}`
    });
    if (status !== 'success') {
      setDeployStatus('Deploy transaction reverted.', 'error');
      return toast('Deploy failed (tx reverted)', 'error');
    }
    record();

    const link = explorerTxLink(net, tx?.hash);
    const okHtml = `<strong>${escapeHtml(plan.name)}</strong> deployed<br>
      <span class="mono">${escapeHtml(address)}</span>
      <button class="copy-btn" data-copy="${escapeHtml(address)}" title="Copy contract address" aria-label="Copy contract address"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button><br>
      <span class="small">${escapeHtml(net.name)} · ${plan.summary.map(r => escapeHtml(r.v)).join(' · ')}</span>` +
      (link ? ` <a href="${escapeHtml(link)}" target="_blank" rel="noopener">View tx ↗</a>` : '');
    setDeployStatus(okHtml, 'ok');
    // The deploy is DONE before verification starts: the dashboard refreshes
    // and the toast fires here, so a slow — or hung — verify can never hold
    // the result hostage behind a button that still says "Verifying".
    toast(`${plan.symbol} deployed! 🎉`, 'success');
    emit('refresh');

    // M10 auto-verify — best effort, and never a deploy failure: the contract
    // exists whether or not an explorer accepts the source. A loopback/dev
    // chain skips with a reason; Sourcify runs keyless; Etherscan runs only if
    // a key is saved. Progress replaces the status line, the verdict appends.
    // M9 adds a second target: an explorer only shows the TOKEN once the
    // implementation's source is published too, so both addresses go up.
    if (btn) setBtnDots(btn, true, 'Verifying');
    const targets = upg
      ? [
          { tag: 'impl', address: implAddress, contractName: std.contract, abi: compiled.abi, args: [], txHash: implTxHash },
          { tag: 'proxy', address, contractName: PROXY_CONTRACT,
            abi: compiled.contracts?.[PROXY_CONTRACT]?.abi, args: [implAddress, initData, adminAddr], txHash: tx?.hash }
        ]
      : [{ tag: '', address, contractName: std.contract, abi: compiled.abi, args: plan.args, txHash: tx?.hash }];
    const lines = [];
    for (const t of targets) {
      const prefix = t.tag ? `[${t.tag}] ` : '';
      try {
        const v = await autoVerify({
          net, address: t.address, source, contractName: t.contractName,
          abi: t.abi, args: t.args, compiler: plan.compiler, creationTxHash: t.txHash,
          onStatus: (m) => setDeployStatus(`${okHtml}<br><span class="small">${escapeHtml(prefix + m)}</span>`, 'ok'),
        });
        lines.push(prefix + v.line);
      } catch (e) {
        lines.push(prefix + (e?.message || String(e)));
      }
    }
    const verifyHtml = lines.length
      ? `<br><span class="small">${escapeHtml(lines.join(' · '))}</span>` : '';
    setDeployStatus(okHtml + verifyHtml, 'ok');
  } catch (e) {
    const msg = e?.message || String(e);
    setDeployStatus(escapeHtml(msg), 'error');
    toast(msg, 'error');
  } finally {
    if (btn) setBtnDots(btn, false);
  }
}
