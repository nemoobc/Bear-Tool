// ═══════════════════════════════════════════════════════════════
// Bear Tool — activity-view.js
// The Activity list's own rendering: the icon per action, the row, and the
// "other scope" section.
//
// It lives here, not in app.js, for two reasons: app.js is the biggest file
// in the app and the audit's own drift alarm says so (it crossed 3200 in
// 2026-10 and the guard asks "did this balloon by accident?"), and the
// Activity view is a self-contained concern — a row is a row, wherever the
// list shows it.
//
// Pure rendering: no state, no chain, no DOM lookups beyond the helpers it
// imports. The app decides WHICH rows to show (the scope rules live in
// state.js) and opens the detail sheet when a row is tapped.
// ═══════════════════════════════════════════════════════════════

import { escapeHtml, titleCase, fmtTimeShort } from './ui.js';

// Activity icon mapping
export function actIcon(type) {
  const typ = (type || '').toLowerCase();
  if (typ.includes('send')) return 'send';
  if (typ.includes('receive')) return 'receive';
  if (typ.includes('swap')) return 'swap';
  if (typ.includes('bridge')) return 'bridge';
  if (typ.includes('approve')) return 'approve';
  if (typ.includes('7702') || typ.includes('delegate') || typ.includes('revoke')) return 'delegate';
  if (typ.includes('rescue') || typ.includes('claim') || typ.includes('deploy') || typ.includes('helper')) return 'deploy';
  return 'send';
}

export function actSvg(type) {
  const cls = actIcon(type);
  const svgs = {
    send: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>',
    receive: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>',
    swap: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
    bridge: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 17h20"/><path d="M4 12V7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v5"/><circle cx="12" cy="17" r="3"/></svg>',
    approve: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
    deploy: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>',
    delegate: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>'
  };
  return `<div class="activity-icon ${cls}">${svgs[cls] || svgs.send}</div>`;
}

/**
 * One activity row.
 * @param {object} a        the activity row
 * @param {number} i        its index inside its own list
 * @param {string} scope    which list it belongs to, so a tap can find it
 *   again (the main list, or the "other networks" / "other wallets" sections
 *   that appear when the current scope is empty).
 */
export function activityRowHtml(a, i, scope = 'current') {
  return `
    <div class="activity-item activity-item--openable" role="button" tabindex="0"
         data-act-index="${i}" data-act-scope="${scope}">
      ${actSvg(a.type)}
      <div class="activity-details">
        <div class="activity-action">${escapeHtml(titleCase(a.type))} — ${escapeHtml(titleCase(a.status))}</div>
        <div class="activity-meta">${escapeHtml(a.detail)} · ${escapeHtml(fmtTimeShort(a.ts))}</div>
      </div>
    </div>`;
}

/**
 * A group of rows that live OUTSIDE the current scope (the user's other
 * networks / other wallets), under a heading that says where they are.
 * Nothing is mixed into the main list — these are named, not blended.
 */
export function activityScopeSection(rows, scope, title, note) {
  if (!rows || !rows.length) return '';
  return `
      <div class="activity-scope">
        <div class="activity-scope-head">${escapeHtml(title)}</div>
        <div class="small dim">${escapeHtml(note)}</div>
        ${rows.map((a, i) => activityRowHtml(a, i, scope)).join('')}
      </div>`;
}
