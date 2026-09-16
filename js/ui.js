// ═══════════════════════════════════════════════════════════════
// Bear Tool — ui.js
// Render helpers: modal (a11y: focus trap, Escape, restore focus),
// toast, spinner (unified helper + countdown), confirm dialogs,
// escaping, button loading state, animated counter.
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

// ── modal (a11y: aria-labelledby, focus trap, Escape, restore focus) ──
let lastFocused = null;

function getFocusable(box) {
  if (!box) return [];
  return [...box.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
    .filter(el => el.offsetParent !== null && !el.classList.contains('modal-close'));
}

export function openModal(html) {
  const overlay = $('#modalOverlay');
  const box = $('#modalBox');
  box.innerHTML = html;
  // aria-labelledby → first heading (WCAG 4.1.2)
  const heading = box.querySelector('h1, h2, h3');
  if (heading) {
    if (!heading.id) heading.id = 'modalTitle';
    box.setAttribute('aria-labelledby', heading.id);
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
  }
  overlay.classList.add('open');
  // scroll lock
  document.body.style.overflow = 'hidden';
  // remember who opened it, then move focus inside (WCAG 2.4.3)
  lastFocused = document.activeElement;
  box.tabIndex = -1;
  const first = getFocusable(box)[0];
  (first || box).focus();
  // close on overlay click (outside modal)
  overlay.onclick = (e) => { if (e.target === overlay) closeModal(); };
  return box;
}

export function closeModal() {
  const overlay = $('#modalOverlay');
  if (!overlay) return;
  overlay.classList.remove('open');
  document.body.style.overflow = '';
  // restore focus to opener (WCAG 2.4.3)
  if (lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus();
  lastFocused = null;
}

// Delegated listeners — guarded so module import works in test stubs
// (tests/e2e-probe.test.js uses a minimal document without addEventListener).
if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('keydown', (e) => {
    const overlay = document.getElementById('modalOverlay');
    if (!overlay || !overlay.classList.contains('open')) return;
    if (e.key === 'Escape') { closeModal(); return; }
    if (e.key === 'Tab') {
      const box = document.getElementById('modalBox');
      const items = getFocusable(box);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });
  // safety net: any .modal-close click closes (legacy inline onclick still works)
  document.addEventListener('click', (e) => {
    if (e.target.closest && e.target.closest('.modal-close')) closeModal();
  });
}

// ── spinner (unified helper) ──
// spinner(size, timeoutSec, label) → HTML string.
// size: wrap diameter in px (default 64). timeoutSec: pass >0 and call
// startSpinnerCountdown() to show a live countdown. label: status text.
export function spinner(size = 64, timeoutSec = 0, label = 'Loading...') {
  const count = timeoutSec > 0
    ? `<span class="spinner-count" data-countdown role="timer" aria-live="polite">${timeoutSec}s</span>`
    : '';
  return `<div class="spinner-wrap" role="status" aria-live="polite">
    <span class="spinner-bear-wrap" style="width:${size}px;height:${size}px;">
      <span class="ring" aria-hidden="true"></span>
      <img src="assets/bear.svg" alt="" class="spinner-bear">
    </span>
    <span class="spinner-info">
      <span class="spinner-label">${escapeHtml(label)}</span>
      ${count}
      <span class="spinner-dots" aria-hidden="true"><span></span><span></span><span></span></span>
    </span>
  </div>`;
}

// ── button loading state ──
export function setBtnLoading(btn, loading) {
  if (!btn) return;
  if (loading) {
    btn.classList.add('loading');
    btn.disabled = true;
  } else {
    btn.classList.remove('loading');
    btn.disabled = false;
  }
}

// Live countdown for a spinner already inserted in the DOM.
// container: element containing .spinner-count. seconds: total to count down.
// Returns the interval id (caller may clearInterval early).
export function startSpinnerCountdown(container, seconds) {
  const el = container && container.querySelector('.spinner-count');
  if (!el) return null;
  let left = seconds;
  el.textContent = left + 's';
  const id = setInterval(() => {
    left -= 1;
    if (left <= 0) { el.textContent = '0s'; clearInterval(id); return; }
    el.textContent = left + 's';
  }, 1000);
  return id;
}

// ── legacy spinner variants (kept for swap.js / bridge.js) ──
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