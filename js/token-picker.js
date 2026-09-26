// ═══════════════════════════════════════════════════════════════
// token-picker.js — in-app token chooser with auto-detected logos.
//
// Replaces the native <select> on the Swap form. A native select draws its
// option list as an OS popup: on a phone that popup escapes the page, ignores
// the app's styling and can sit partly off-screen. The CSS made it worse —
// `.swap-token-select { flex: 0 0 140px }` pinned a fixed basis with
// flex-shrink:0, so the control could not give way on a narrow viewport.
//
// This builds a popover that stays inside the app: absolutely positioned in a
// position:relative wrapper, width-clamped to that wrapper, height-clamped to
// the viewport, scrollable, and flipped above the trigger when there is no room
// below.
//
// The original <select> is left in the DOM, hidden but not display:none, and
// kept in sync. Four call sites in swap.js read `#swapFrom.value` /
// `#swapTo.value`, and the e2e suite reads inputValue(); keeping the native
// control authoritative means none of them had to change.
//
// Logos: a cached CoinGecko URL when one is known, else the app's inline SVG
// marks, else a letter avatar — so a row is never bare text.
// ═══════════════════════════════════════════════════════════════

import { $, escapeHtml, fmtAmount, fmtUsd, titleCase } from './ui.js';
import { tokenLogoHTML, guardTokenLogos, readLogoCache as readCache } from './token-logo.js';

let OPEN = null;

function closeOpen() {
  if (!OPEN) return;
  const { panel, trigger, wrap } = OPEN;
  panel.hidden = true;
  panel.classList.remove('open', 'open-up');
  trigger.setAttribute('aria-expanded', 'false');
  wrap.classList.remove('is-open');
  OPEN = null;
}

function openPanel(picker) {
  const { panel, trigger, wrap } = picker;
  panel.hidden = false;
  panel.classList.add('open');
  trigger.setAttribute('aria-expanded', 'true');
  wrap.classList.add('is-open');
  OPEN = picker;

  // Flip above the trigger when the list would overflow the viewport, and
  // clamp its width to the wrapper so it can never stick out sideways either.
  panel.style.maxHeight = '';
  panel.classList.remove('open-up');
  const r = panel.getBoundingClientRect();
  const vh = window.innerHeight || document.documentElement.clientHeight;
  if (r.bottom > vh - 8 && r.top > r.height) {
    panel.classList.add('open-up');
  }
  const cap = Math.max(160, Math.floor(vh * 0.45));
  panel.style.maxHeight = Math.min(cap, Math.floor(r.height || cap)) + 'px';
  panel.style.width = '100%';
  panel.scrollTop = 0;
}

// ── logos ────────────────────────────────────────────────────────────────
// Uses the SAME renderer as the dashboard (js/token-logo.js) so a token looks
// identical in the asset list and in this list. The first version of this file
// drew its own CSS circles with a letter, which is why the Swap list did not
// look like the dashboard.
function logoHtml(token, size = 22) {
  return tokenLogoHTML(token.symbol || '', size);
}

function readLogoCache() {
  return readCache();
}

function guardLogos(root) {
  guardTokenLogos(root);
}

// ── generic in-app list picker ────────────────────────────────────────────
// Shared core. `rows` is already-rendered HTML for the options; `paint` is
// called with the current value to refresh the trigger. Tokens, networks and
// routers all go through this, so they behave identically.
function initListPicker(selectId, { renderRows, paint, ariaLabel }) {
  // Resolve through the app's own $ helper rather than document.getElementById:
  // the whole codebase does it this way, and it keeps this module importable
  // under Node with the lightweight DOM stubs the unit tests install (those
  // expose querySelector but not getElementById).
  // Wrapped because a picker is an enhancement — it must never be able to take
  // the view it lives in down with it.
  try {
    return initListPickerInner(selectId, { renderRows, paint, ariaLabel });
  } catch (err) {
    console.warn('[token-picker] skipped #' + selectId + ':', err && err.message);
    return null;
  }
}

function initListPickerInner(selectId, { renderRows, paint }) {
  const sel = $('#' + selectId);
  if (!sel) return null;
  const wrap = typeof sel.closest === 'function' ? sel.closest('.token-picker') : null;
  const trigger = wrap ? wrap.querySelector('.token-picker-trigger') : null;
  const panel = wrap ? wrap.querySelector('.token-picker-panel') : null;
  if (!wrap || !trigger || !panel) return null;
  const picker = { sel, wrap, trigger, panel };

  const renderPanel = () => {
    panel.innerHTML = renderRows(sel) || '<p class="token-picker-empty">Nothing to choose</p>';
    guardLogos(panel);
  };

  const paintTrigger = () => { paint(trigger, sel.value, sel); };

  const choose = (v) => {
    if (sel.value !== v) {
      sel.value = v;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      paintTrigger();
    }
    closeOpen();
  };

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (OPEN && OPEN.panel === panel) { closeOpen(); return; }
    closeOpen();
    renderPanel();
    openPanel(picker);
  });

  panel.addEventListener('click', (e) => {
    const row = e.target.closest('.token-row');
    if (row) { e.stopPropagation(); choose(row.dataset.value); }
  });

  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!OPEN || OPEN.panel !== panel) { closeOpen(); renderPanel(); openPanel(picker); }
      const rows = [...panel.querySelectorAll('.token-row')];
      if (!rows.length) return;
      const at = rows.findIndex((r) => r.classList.contains('active'));
      const next = e.key === 'ArrowDown'
        ? Math.min(rows.length - 1, at + 1)
        : Math.max(0, at <= 0 ? 0 : at - 1);
      rows.forEach((r, i) => r.classList.toggle('cursor', i === next));
      rows[next]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      trigger.click();
    } else if (e.key === 'Escape') {
      closeOpen();
    }
  });

  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeOpen(); trigger.focus(); }
  });

  sel.addEventListener('change', paintTrigger);
  paintTrigger();
  return picker;
}

// ── token picker ─────────────────────────────────────────────────────────
const key = (t) => (t.address || 'native');

/**
 * @param {string} selectId id of the authoritative native <select>
 * @param {Array}  tokens   [{ address|null, symbol, decimals, balance, usd }]
 */
export function initTokenPicker(selectId, tokens) {
  const list = tokens || [];
  const find = (v) => list.find((t) => key(t) === v);

  return initListPicker(selectId, {
    ariaLabel: selectId,
    renderRows: (sel) => list.map((t) => {
      const active = sel.value === key(t);
      let bal = '0';
      try { bal = fmtAmount(t.balance || '0', t.decimals ?? 18); } catch { bal = '0'; }
      const usd = t.usd
        ? `<span class="token-row-usd">${escapeHtml(fmtUsd((Number(bal) || 0) * Number(t.usd)))}</span>` : '';
      return `<button type="button" class="token-row${active ? ' active' : ''}" role="option"
        aria-selected="${active}" data-value="${escapeHtml(key(t))}">
        <span class="token-row-logo">${logoHtml(t, 24)}</span>
        <span class="token-row-text">
          <span class="token-row-sym">${escapeHtml(t.symbol || '?')}</span>
          <span class="token-row-bal">${escapeHtml(bal)}</span>
        </span>${usd}
      </button>`;
    }).join(''),
    paint: (trigger, v) => {
      const t = find(v) || list[0];
      if (!t) return;
      const slot = trigger.querySelector('[data-logo]');
      const sym = trigger.querySelector('[data-symbol]');
      if (slot) slot.innerHTML = logoHtml(t, 20);
      if (sym) sym.textContent = t.symbol || '—';
      trigger.setAttribute('aria-label', `Choose token, currently ${t.symbol || 'unknown'}`);
    },
  });
}

// ── network picker ───────────────────────────────────────────────────────
/** @param {Array} networks [{ id, name, type, icon, color }] */
export function initNetworkPicker(selectId, networks) {
  const list = networks || [];
  const find = (v) => list.find((n) => n.id === v);
  return initListPicker(selectId, {
    renderRows: (sel) => list.map((n) => {
      const active = sel.value === n.id;
      return `<button type="button" class="token-row${active ? ' active' : ''}" role="option"
        aria-selected="${active}" data-value="${escapeHtml(n.id)}">
        <span class="token-row-logo"><span class="net-logo" style="font-size:18px">${escapeHtml(n.icon || '🛰️')}</span></span>
        <span class="token-row-text">
          <span class="token-row-sym">${escapeHtml(n.name)}</span>
          <span class="token-row-bal">Chain ${escapeHtml(String(n.chainId))} · ${escapeHtml(titleCase(n.type))}</span>
        </span>
      </button>`;
    }).join(''),
    paint: (trigger, v) => {
      const n = find(v) || list[0];
      if (!n) return;
      const slot = trigger.querySelector('[data-logo]');
      const sym = trigger.querySelector('[data-symbol]');
      if (slot) slot.innerHTML = `<span class="net-logo" style="font-size:16px">${escapeHtml(n.icon || '🛰️')}</span>`;
      if (sym) sym.textContent = n.name || '—';
      trigger.setAttribute('aria-label', `Choose network, currently ${n.name || 'unknown'}`);
    },
  });
}

// ── plain option picker (routers and other simple lists) ─────────────────
/** @param {string[]} labels option texts, aligned with the select's options */
export function initOptionPicker(selectId, labels) {
  const list = labels || [];
  return initListPicker(selectId, {
    renderRows: (sel) => [...sel.options].map((o, i) => {
      const active = sel.selectedIndex === i;
      return `<button type="button" class="token-row${active ? ' active' : ''}" role="option"
        aria-selected="${active}" data-value="${escapeHtml(o.value)}">
        <span class="token-row-text"><span class="token-row-sym">${escapeHtml(list[i] ?? o.textContent)}</span></span>
      </button>`;
    }).join(''),
    paint: (trigger, v, el) => {
      const sym = trigger.querySelector('[data-symbol]');
      if (!sym) return;
      const i = [...el.options].findIndex((o) => o.value === v);
      sym.textContent = i >= 0 ? (list[i] ?? el.options[i].textContent) : '—';
    },
  });
}

export function closeAllPickers() { closeOpen(); }

// Close when tapping elsewhere, or scrolling a parent (the popover is clamped
// to the viewport, so it has to follow the page).
// Guarded: this module is imported by tests/bridge.test.js under Node, where
// there is no document. Touching `document` at module scope made the import
// throw and took 17 unit tests down with it.
if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  document.addEventListener('click', () => closeOpen());
  window.addEventListener('resize', () => closeOpen());
  window.addEventListener('scroll', () => closeOpen(), true);
}
