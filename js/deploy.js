// ═══════════════════════════════════════════════════════════════
// Bear Tool — deploy.js
// Deploy wizard: standard selector + extra fields + honest stub
// (needs pre-compiled Solidity bytecode templates).
// ═══════════════════════════════════════════════════════════════

import { $, toast, confirmTx } from './ui.js';
import { get, requireUnlock } from './state.js';
import { getNetworkById } from './network.js';

export function bindDeployEvents() {
  $('#deployStandard').addEventListener('change', renderDeployExtra);
  $('#btnDeploy').addEventListener('click', doDeploy);
}

export function renderDeployExtra() {
  const std = $('#deployStandard').value;
  const extra = $('#deployExtra');
  if (std === 'erc20') {
    extra.innerHTML = `
      <div class="field"><label>Initial supply</label><input class="input" id="deploySupply" type="number" placeholder="1000000"></div>
      <div class="field"><label>Decimals</label><input class="input" id="deployDecimals" type="number" value="18"></div>`;
  } else if (std === 'erc721') {
    extra.innerHTML = `
      <div class="field"><label>Base URI</label><input class="input" id="deployBaseUri" placeholder="https://.../"></div>`;
  } else {
    extra.innerHTML = `
      <div class="field"><label>Base URI</label><input class="input" id="deployBaseUri" placeholder="https://.../"></div>`;
  }
}

export async function doDeploy() {
  if (!get('unlocked')) { requireUnlock(); return; }
  const std = $('#deployStandard').value;
  const name = $('#deployName').value.trim();
  const symbol = $('#deploySymbol').value.trim();
  if (!name || !symbol) return toast('Enter name and symbol', 'error');
  const net = getNetworkById(get('networkId'));
  if (net.type === 'mainnet') {
    const ok = await confirmTx({
      title: 'DEPLOY ON MAINNET!',
      rows: [{ k: 'Standard', v: std.toUpperCase() }, { k: 'Name', v: name }, { k: 'Symbol', v: symbol }],
      confirmText: 'Deploy', danger: true, requireType: 'YA'
    });
    if (!ok) return;
  }
  toast('Deploy wizard needs contract templates (Solidity bytecode). See docs/PROMPT.md for full wizard spec.', 'info');
}