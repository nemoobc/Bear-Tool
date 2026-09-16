// ═══════════════════════════════════════════════════════════════
// Bear Tool — ui.js
// Render helpers: modal, toast, spinner, confirm dialogs, escaping,
// button loading state, animated counter.
// Original implementation — no copying.
// ═══════════════════════════════════════════════════════════════

export function $(sel) { return document.querySelector(sel); }
export function $all(sel) { return document.querySelectorAll(sel); }

// ── XSS guard: escape any string before it enters innerHTML ──
export function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

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

export function spinnerHoney() {
  return `<div class="spinner-honey" role="status" aria-label="Loading"></div>`;
}

// ── button loading state (double-submit visual lock) ──
export function setBtnLoading(btn, loading, label = 'Loading...') {
  if (!btn) return;
  if (loading) {
    if (!btn.dataset.origHtml) btn.dataset.origHtml = btn.innerHTML;
    btn.classList.add('is-loading');
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    btn.innerHTML = `<span class="btn-spinner" aria-hidden="true"></span> ${escapeHtml(label)}`;
  } else {
    btn.classList.remove('is-loading');
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
    if (btn.dataset.origHtml) {
      btn.innerHTML = btn.dataset.origHtml;
      delete btn.dataset.origHtml;
    }
  }
}

// ── animated number counter (respects prefers-reduced-motion) ──
export function animateValue(el, target, { duration = 800, formatter = v => v } = {}) {
  if (!el) return;
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) { el.textContent = formatter(target); return; }
  const start = performance.now();
  const from = 0;
  const tick = (now) => {
    const p = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - p, 3); // ease-out cubic
    el.textContent = formatter(from + (target - from) * eased);
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// ── confirm dialog with bear ──
export function confirmTx({ title, rows, confirmText = 'Confirm', danger = false, requireType = null }) {
  return new Promise((resolve) => {
    const rowsHtml = rows.map(r =>
      `<div class="row"><span class="k">${escapeHtml(r.k)}</span><span class="v">${escapeHtml(r.v)}</span></div>`
    ).join('');
    const typeInput = requireType
      ? `<div class="field mt-8"><label>Type <strong>${escapeHtml(requireType)}</strong> to confirm</label>
         <input class="input" id="confirmTypeInput" placeholder="${escapeHtml(requireType)}"></div>`
      : '';
    openModal(`
      <button class="modal-close" onclick="document.getElementById('modalOverlay').classList.remove('open')">✕</button>
      <div class="tx-confirm">
        <img src="assets/bear.svg" alt="Bear asks">
        <div class="question">${danger ? '⚠️ ' : ''}${escapeHtml(title)}</div>
        <div class="tx-detail">${rowsHtml}</div>
        ${typeInput}
        <div class="flex gap-8">
          <button class="btn btn-ghost" id="confirmNo">Cancel</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="confirmYes">${escapeHtml(confirmText)}</button>
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
      <h2>🔒 ${escapeHtml(title)}</h2>
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