// ═══════════════════════════════════════════════════════════════
// Bear Tool — ui.js
// Render helpers: modal, toast, spinner, confirm dialogs.
// Original implementation — no copying.
// ═══════════════════════════════════════════════════════════════

export function $(sel) { return document.querySelector(sel); }
export function $all(sel) { return document.querySelectorAll(sel); }

// ── toast ──
export function toast(msg, type = 'info') {
  const wrap = $('#toast-wrap');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.3s';
    setTimeout(() => el.remove(), 300);
  }, 3500);
}

// ── modal ──
export function openModal(html) {
  const overlay = $('#modalOverlay');
  const box = $('#modalBox');
  box.innerHTML = html;
  overlay.classList.add('open');
  // close on overlay click (outside modal)
  overlay.onclick = (e) => { if (e.target === overlay) closeModal(); };
  return box;
}

export function closeModal() {
  $('#modalOverlay').classList.remove('open');
}

// ── spinner ──
export function spinnerBear() {
  return `<div class="spinner-wrap" role="status" aria-label="Loading">
    <img src="assets/bear.svg" alt="loading" class="spinner-bear">
    <span>Loading...</span>
  </div>`;
}

export function spinnerDots() {
  return `<div class="spinner-dots" role="status" aria-label="Loading"><span></span><span></span><span></span></div>`;
}

// ── confirm dialog with bear ──
export function confirmTx({ title, rows, confirmText = 'Confirm', danger = false, requireType = null }) {
  return new Promise((resolve) => {
    const rowsHtml = rows.map(r =>
      `<div class="row"><span class="k">${r.k}</span><span class="v">${r.v}</span></div>`
    ).join('');
    const typeInput = requireType
      ? `<div class="field mt-8"><label>Type <strong>${requireType}</strong> to confirm</label>
         <input class="input" id="confirmTypeInput" placeholder="${requireType}"></div>`
      : '';
    openModal(`
      <button class="modal-close" onclick="document.getElementById('modalOverlay').classList.remove('open')">✕</button>
      <div class="tx-confirm">
        <img src="assets/bear.svg" alt="Bear asks">
        <div class="question">${danger ? '⚠️ ' : ''}${title}</div>
        <div class="tx-detail">${rowsHtml}</div>
        ${typeInput}
        <div class="flex gap-8">
          <button class="btn btn-ghost" id="confirmNo">Cancel</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="confirmYes">${confirmText}</button>
        </div>
      </div>
    `);
    const yes = $('#confirmYes');
    const no = $('#confirmNo');
    const typeEl = $('#confirmTypeInput');
    if (typeEl) {
      yes.disabled = true;
      typeEl.addEventListener('input', () => {
        yes.disabled = typeEl.value.trim() !== requireType;
      });
    }
    yes.onclick = () => { closeModal(); resolve(true); };
    no.onclick = () => { closeModal(); resolve(false); };
  });
}

// ── password prompt ──
export function promptPassword(title = 'Enter password') {
  return new Promise((resolve) => {
    openModal(`
      <button class="modal-close" onclick="document.getElementById('modalOverlay').classList.remove('open')">✕</button>
      <h2>🔒 ${title}</h2>
      <div class="field">
        <label for="pwInput">Password</label>
        <input class="input" id="pwInput" type="password" placeholder="••••••••">
      </div>
      <div class="flex gap-8">
        <button class="btn btn-ghost" id="pwCancel">Cancel</button>
        <button class="btn btn-primary" id="pwOk">Unlock</button>
      </div>
    `);
    const input = $('#pwInput');
    input.focus();
    const done = (val) => { closeModal(); resolve(val); };
    $('#pwOk').onclick = () => done(input.value);
    $('#pwCancel').onclick = () => done(null);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(input.value); });
  });
}

// ── format helpers ──
export function fmtAmount(wei, decimals = 18, max = 6) {
  try {
    const v = ethers.formatUnits(wei, decimals);
    const num = parseFloat(v);
    if (isNaN(num)) return '0';
    return num.toLocaleString('en-US', { maximumFractionDigits: max });
  } catch { return '0'; }
}

export function fmtUsd(num) {
  if (num === null || num === undefined || isNaN(num)) return '$0.00';
  return '$' + num.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

export function fmtTime(ts) {
  return new Date(ts).toLocaleString();
}