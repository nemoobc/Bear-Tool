// ═══════════════════════════════════════════════════════════════
// Bear Tool — pull-refresh.js (main-screen pull-to-refresh)
// ═══════════════════════════════════════════════════════════════
// Pull down at the very top of the main window → release → the SAME
// 'refresh' event the auto-refresh timer and every post-tx path emit,
// so there is exactly one refresh pipeline (loadDashboard) in the app.
//
// Why window-level touch listeners and not a CSS overscroll trick:
//  - the dApp-browser iframe is cross-origin, gestures inside it never
//    reach us (the same wall that keeps Uniswap out of an iframe);
//  - Android Chrome's own pull-to-refresh fires alongside ours and
//    reloads the whole wallet, losing the SPA state — the root gets
//    overscroll-behavior-y: none in cartoon.css to retire it;
//  - the scroller here is window.scrollY (see scrollTopFab), so "at
//    the top" is window.scrollY <= 0.
//
// Gesture rules (thumb-friendly, no accidental refresh):
//  - start only at the top, never from an input/button or over a modal;
//  - direction must settle vertically before pulling starts — a mostly
//    horizontal drag is a back-swipe, not a refresh;
//  - pull is damped (half speed) and capped, so the indicator follows
//    the thumb without teleporting;
//  - the refresh fires only past PULL_REFRESH_THRESHOLD px of visible
//    pull, and never while a previous refresh is still running.
import { emit } from './state.js';

export const PULL_REFRESH_THRESHOLD = 72; // visible px before release fires
const DAMPING = 0.5;        // finger moves 2px → indicator moves 1px
const MAX_PULL = 96;        // indicator never chases past this (px)
const DIR_LOCK = 8;         // px before the gesture picks a direction
const MIN_SPIN = 600;       // spinner stays this long even on a fast refresh

export function initPullRefresh(opts = {}) {
  const win = opts.win || (typeof window !== 'undefined' ? window : null);
  const doc = opts.doc || (typeof document !== 'undefined' ? document : null);
  const onRefresh = opts.onRefresh || (() => emit('refresh'));
  const threshold = opts.threshold || PULL_REFRESH_THRESHOLD;
  if (!win || typeof win.addEventListener !== 'function') return null;
  if (!doc || typeof doc.createElement !== 'function') return null;

  // Fixed-position indicator, created once. It lives outside every view so a
  // switchView can never unmount it, and it is aria-hidden: this is a
  // gesture affordance, not a live region — the dashboard itself carries
  // the refresh for assistive tech.
  const ind = doc.createElement('div');
  ind.className = 'pull-refresh';
  ind.setAttribute('aria-hidden', 'true');
  const spin = doc.createElement('span');
  spin.className = 'pr-spin';
  if (ind.appendChild) ind.appendChild(spin);
  const host = doc.body || doc.documentElement;
  if (host && host.appendChild) host.appendChild(ind);

  let startY = 0;
  let startX = 0;
  let pxNow = 0;      // current visible pull in px (damped, 0 when idle)
  let armed = false;  // touch landed in a legal spot at the top
  let pulling = false;// direction settled into a downward pull
  let busy = false;   // a refresh is in flight — swallow re-pulls

  // CSS owns the easing: .pull-refresh eases transform, .pull-refresh.pull
  // drops the transition so the indicator sticks to the thumb. Deleting the
  // 'pull' class on release is what snaps it home.
  const rest = () => {
    pxNow = 0;
    if (ind.style) ind.style.transform = 'translate(-50%, -72px)';
    ind.classList.remove('show', 'pull', 'go');
    armed = false;
    pulling = false;
  };

  const onMove = (e) => {
    if (!armed) return;
    const t0 = e.touches && e.touches[0];
    if (!t0) return;
    const dy = t0.clientY - startY;
    const dx = t0.clientX - startX;

    if (!pulling) {
      if (Math.abs(dy) < DIR_LOCK && Math.abs(dx) < DIR_LOCK) return;
      if (Math.abs(dx) > Math.abs(dy)) { armed = false; return; } // side-swipe
      if (dy <= 0) { armed = false; return; }                     // scrolled up
      pulling = true;
      ind.classList.add('show', 'pull');
      if (e.cancelable) e.preventDefault(); // no browser rubber-band under it
    }
    if (pulling && dy > 0) {
      if (e.cancelable) e.preventDefault();
      pxNow = Math.min(MAX_PULL, dy * DAMPING);
      if (ind.style) ind.style.transform = `translate(-50%, ${-72 + pxNow}px)`;
    }
  };

  const onEnd = () => {
    if (!armed) return;
    if (!pulling) { armed = false; return; }
    if (pxNow < threshold) { rest(); return; }

    // Past the threshold: commit. busy swallows any second pull until this
    // one finishes; the min spin keeps a cached-fast refresh from flickering.
    pulling = false;
    armed = false;
    busy = true;
    ind.classList.remove('pull');
    ind.classList.add('go');
    if (ind.style) ind.style.transform = `translate(-50%, ${MAX_PULL / 2}px)`;
    const started = Date.now();
    // Called synchronously on release (one deterministic commit point), then
    // the promise — if any — only paces how long the spinner stays.
    let result;
    try { result = onRefresh(); } catch { /* a failed refresh must still close the gesture */ }
    Promise.resolve(result)
      .then(() => new Promise((r) => setTimeout(r, Math.max(0, MIN_SPIN - (Date.now() - started)))))
      .then(() => { busy = false; rest(); });
  };

  // "At the top" must read every place this layout can scroll: window.scrollY
  // for the normal viewport scroller, body.scrollTop for THIS layout — the
  // `overflow-x: hidden` on html,body severs the viewport overflow propagation,
  // so body becomes the scroller and window.scrollY stays 0 forever (proven in
  // the live probe 2026-10-09: de.scrollTop=120 reads back 0, body=140 reads 140).
  const atTop = () => {
    const winY = win.scrollY || 0;
    const sc = doc.scrollingElement || doc.documentElement || {};
    const deY = sc.scrollTop || 0;
    const bodyY = doc.body ? (doc.body.scrollTop || 0) : 0;
    return winY <= 0 && deY <= 0 && bodyY <= 0;
  };

  const onStart = (e) => {
    if (busy) return;
    const t0 = e.touches && e.touches[0];
    if (!t0) return;
    // Never steal a gesture that begins on something the user is operating.
    const target = e.target;
    if (target && typeof target.closest === 'function'
      && target.closest('input, textarea, select, button, a, [contenteditable="true"]')) return;
    if (doc.querySelector && doc.querySelector('.modal.open')) return;
    if (!atTop()) return; // mid-scroll: page scroll, not PTR
    startY = t0.clientY;
    startX = t0.clientX;
    pxNow = 0;
    armed = true;
    pulling = false;
  };

  const onTouchCancel = () => { if (armed) rest(); };

  win.addEventListener('touchstart', onStart, { passive: true });
  win.addEventListener('touchmove', onMove, { passive: false });
  win.addEventListener('touchend', onEnd, { passive: true });
  win.addEventListener('touchcancel', onTouchCancel, { passive: true });

  // First paint: park the indicator above the viewport until the first pull.
  pxNow = 0;
  if (ind.style) ind.style.transform = 'translate(-50%, -72px)';

  return {
    destroy() {
      if (win.removeEventListener) {
        win.removeEventListener('touchstart', onStart);
        win.removeEventListener('touchmove', onMove);
        win.removeEventListener('touchend', onEnd);
        win.removeEventListener('touchcancel', onTouchCancel);
      }
      if (ind.remove) ind.remove();
    },
  };
}
