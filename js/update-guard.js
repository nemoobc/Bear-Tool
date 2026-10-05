// ═══════════════════════════════════════════════════════════════
// update-guard.js — stale-tab detector.
//
// The app is a hashed single-page bundle: a tab left open across a rebuild
// keeps running the OLD JavaScript until someone reloads. Every fix then
// lands and the user still sees the old bug — phantom regressions. The flip
// report of 2026-10-04 was exactly this: the fixed bundle was already live
// on :8080 (the served chunk contains the double dispatch) while the open
// tab still ran the old single-dispatch flip and showed "USDT = USDT".
//
// So: poll the served index.html (conditional revalidation — the server
// answers 304 with an empty body while nothing changed), compare the hashed
// entry filename against the one this tab loaded, and when they differ show
// a one-time banner with a Reload button.
//
// No auto-reload on purpose: reloading under the user would destroy
// whatever they were typing (amounts, forms, an in-flight dapp session).
// ═══════════════════════════════════════════════════════════════

import { t } from './i18n.js';

// Entry = the MODULE <script> tag. Other index-*.js chunks exist (lazy
// splits) and must not be mistaken for the entry, so match the tag itself.
const ENTRY_TAG_RE = /<script[^>]*\ssrc="[^"]*?(index-[A-Za-z0-9_-]+\.js)"/;
const SRC_RE = /index-[A-Za-z0-9_-]+\.js/;

/** Hashed entry filename from a full index.html document; null if absent. */
export function entryHash(html) {
  const m = ENTRY_TAG_RE.exec(String(html || ''));
  return m ? m[1] : null;
}

/** Hashed entry filename this tab actually loaded; null outside a build. */
export function currentEntryHash(doc) {
  const d = doc || (typeof document !== 'undefined' ? document : null);
  if (!d || typeof d.querySelector !== 'function') return null;
  const el = d.querySelector('script[type="module"][src]');
  const src = el && typeof el.getAttribute === 'function' ? (el.getAttribute('src') || '') : '';
  const m = SRC_RE.exec(src);
  return m ? m[0] : null;
}

// One-time banner, built through createElement (no innerHTML: the text
// comes from our own i18n table, and a banner is a bad place to trust
// strings). Styled by .update-guard in css/cartoon.css.
function showBanner() {
  if (typeof document === 'undefined' || !document.body) return;
  if (document.getElementById('updateGuardBar')) return;
  const bar = document.createElement('div');
  bar.id = 'updateGuardBar';
  bar.className = 'update-guard';
  bar.setAttribute('role', 'status');
  const msg = document.createElement('span');
  msg.textContent = t('update.msg');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = t('update.reload');
  btn.addEventListener('click', () => {
    if (typeof location !== 'undefined') location.reload();
  });
  bar.append(msg, btn);
  document.body.appendChild(bar);
}

/**
 * Start polling for a newer bundle.
 * @returns {{ stop: () => void, check: () => Promise<boolean> }}
 *   check() resolves true when a stale tab was detected (banner shown).
 */
export function startUpdateGuard({
  fetchImpl,
  current,
  onStale = showBanner,
  intervalMs = 5 * 60 * 1000,
  delayMs = 30 * 1000,
} = {}) {
  const cur = current !== undefined ? current : currentEntryHash();
  // Dev server / no hashed build → nothing to compare, never banner.
  if (!cur) return { stop() {}, check: async () => false };

  const doFetch = fetchImpl || ((url, init) => fetch(url, init));
  let stopped = false;
  let timer = null;
  let kick = null;

  const check = async () => {
    if (stopped) return false;
    try {
      const res = await doFetch('index.html', { cache: 'no-cache' });
      if (!res || !res.ok) return false;
      const fresh = entryHash(await res.text());
      if (fresh && fresh !== cur) {
        stop();
        onStale();
        return true;
      }
    } catch {
      // Offline or transient failure: silent, keep polling.
    }
    return false;
  };

  function stop() {
    stopped = true;
    if (kick) { clearTimeout(kick); kick = null; }
    if (timer) { clearInterval(timer); timer = null; }
  }

  const kickoff = () => { if (!stopped) check(); };
  kick = setTimeout(kickoff, delayMs);
  timer = setInterval(kickoff, intervalMs);
  return { stop, check };
}
