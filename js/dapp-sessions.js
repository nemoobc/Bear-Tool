// ═══════════════════════════════════════════════════════════════
// dapp-sessions.js — who may see the wallet, and what the user has decided.
//
// Two separate stores, deliberately not one:
//
//   SITES   — origins the user has granted wallet access to. This is the
//             "Connected sites" list every wallet shows, with a disconnect
//             per site and a disconnect-all. Reference: Trust Wallet, Rabby.
//
//   LISTS   — the user's own blocklist and trust list, consumed by dapp-safety.
//             Kept apart from SITES because the two answer different questions:
//             "may this talk to me" and "do I believe this site" are not the
//             same decision, and collapsing them means a blocklist entry could
//             be cleared by revoking a session, or the reverse.
//
// Everything is stored under bear.* keys and every read tolerates a corrupt or
// missing value, because a security control that throws on bad input is a
// security control that gets switched off.
// ═══════════════════════════════════════════════════════════════

const LS = {
  sites: 'bear.dappSites',
  blocked: 'bear.dappBlocked',
  trusted: 'bear.dappTrusted',
  consented: 'bear.dappConsented',
};

const readArr = (k) => {
  try {
    const v = JSON.parse(localStorage.getItem(k));
    return Array.isArray(v) ? v : [];
  } catch { return []; }
};
const writeArr = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };

// Origin normalisation, one place, used on the way in AND on the way out.
//
// Writes lowercased and reads did not, so an entry stored by anything that did not
// — an older build, a hand-edited value, a browser profile copied between machines
// — appeared in the connected-sites list while being invisible to siteAllowed()
// and hasPermission(). The wallet's own idea of "who may see me" then disagreed
// with the list on screen, which is the failure the header of this file says it is
// trying to avoid.
//
// The trailing slash is the same bug with the same fix: https://dapp.com and
// https://dapp.com/ are one origin to a browser, so a site that redirects between
// them — extremely common — used to lose the session and every permission on it.
const normOrigin = (v) => {
  const s = String(v || '').trim().toLowerCase();
  if (!/^https?:\/\//i.test(s)) return '';
  return s
    // Each scheme has its own default port, and only its own: http:80 and
    // https:443. Stripping :80 from an https origin would collapse two genuinely
    // different sites onto one, which is a session belonging to someone else.
    .replace(/^(http):\/\/([^/]*):80(?=\/|$)/, '$1://$2')
    .replace(/^(https):\/\/([^/]*):443(?=\/|$)/, '$1://$2')
    // An origin is scheme + host + port. The path, query and fragment are not part
    // of it, so they are dropped rather than kept: a site at /dashboard and one at
    // /trade are one origin to a browser, and storing them as two sessions meant a
    // link from one to the other silently disconnected the user.
    .replace(/^(https?:\/\/[^/?#]+)[/?#].*$/, '$1');
};

// ═══ connected sites ═════════════════════════════════════════════════════

/** @returns {Array<{origin:string,name:string,chainId:number|null,at:number,perms:string[]}>} */
export function listSites() {
  return readArr(LS.sites)
    .filter((s) => s && typeof s.origin === 'string' && normOrigin(s.origin))
    .map((s) => ({
      origin: normOrigin(s.origin),
      name: s.name || normOrigin(s.origin),
      chainId: Number.isInteger(s.chainId) ? s.chainId : null,
      at: Number.isFinite(s.at) ? s.at : 0,
      perms: Array.isArray(s.perms) ? s.perms : [],
    }));
}

export function siteAllowed(origin) {

  const o = normOrigin(origin);
  return !!o && listSites().some((s) => s.origin === o);
}

/**
 * Grant an origin access. Idempotent — reconnecting to a site already in the
 * list must not create a second row, or the list becomes noise.
 */
export function addSite(origin, { name = '', chainId = null, perms = [] } = {}) {
  const o = normOrigin(origin);
    if (!o) return false;
  const list = listSites();
  const i = list.findIndex((s) => s.origin === o);
  if (i >= 0) {
    list[i] = { ...list[i], name: name || list[i].name, chainId, perms: perms.length ? perms : list[i].perms };
  } else {
    list.push({ origin: o, name: name || o, chainId, at: Date.now(), perms });
  }
  writeArr(LS.sites, list);
  syncWindow();
  return true;
}

export function removeSite(origin) {
  const o = normOrigin(origin);
  writeArr(LS.sites, listSites().filter((s) => s.origin !== o));
  syncWindow();
}

export function clearSites() {
  writeArr(LS.sites, []);
  syncWindow();
}

/** Per-origin permission grants, so revoking one is possible without a nuke. */
export function grantPermission(origin, method) {
  const o = normOrigin(origin);
  const list = listSites();
  const s = list.find((x) => x.origin === o);
  if (!s) return false;
  if (!s.perms.includes(method)) s.perms.push(method);
  writeArr(LS.sites, list);
  syncWindow();
  return true;
}

export function hasPermission(origin, method) {
  const s = listSites().find((x) => x.origin === normOrigin(origin));
  return !!s && s.perms.includes(method);
}

export function revokePermission(origin, method) {
  const o = normOrigin(origin);
  const list = listSites();
  const s = list.find((x) => x.origin === o);
  if (!s) return false;
  s.perms = s.perms.filter((m) => m !== method);
  writeArr(LS.sites, list);
  syncWindow();
  return true;
}

// ═══ the user's own site lists ═══════════════════════════════════════════

const hostOfOrigin = (v) => String(v || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim();

export function listBlocked() { return readArr(LS.blocked).map(hostOfOrigin).filter(Boolean); }
export function listTrusted() { return readArr(LS.trusted).map(hostOfOrigin).filter(Boolean); }

// The user's own matcher, kept in step with the gate that actually runs.
//
// This was `listBlocked().includes(h)` — an exact string compare — while
// dapp-safety.js's matchHostList, the one inspectUrl() really uses, matches the
// host, its base host, and both directions of parent/subdomain. Nothing in the
// app called isBlocked, so it was not a live hole, but a function called
// isBlocked sitting next to a real blocklist and answering a different question
// is a trap: the next person to wire it up inherits a rule where reporting
// "app.uniswap.org" does nothing for "deep.app.uniswap.org".
//
// Mirrors matchHostList, in both directions, so the two cannot drift.
// dapp-blocklist-match.test.js asserts they agree on every host shape.
const matchesHostList = (host, list) => {
  if (!host || !Array.isArray(list) || !list.length) return false;
  const clean = list
    .map((x) => String(x || '').toLowerCase().trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim())
    .filter(Boolean);
  return clean.some((x) => host === x || host.endsWith('.' + x) || x.endsWith('.' + host));
};

export function isBlocked(host) {
  const h = hostOfOrigin(host);
  return matchesHostList(h, listBlocked());
}

export function addBlockedHost(host) {
  const h = hostOfOrigin(host);
  if (!h) return false;
  const list = listBlocked();
  if (!list.includes(h)) list.push(h);
  writeArr(LS.blocked, list);
  return true;
}

export function removeBlockedHost(host) {
  const h = hostOfOrigin(host);
  writeArr(LS.blocked, listBlocked().filter((x) => x !== h));
  return true;
}

export function addTrustedHost(host) {
  const h = hostOfOrigin(host);
  if (!h) return false;
  // A host on the blocklist must not be able to also be on the trust list;
  // whichever the user set second is the one they meant.
  removeBlockedHost(h);
  const list = listTrusted();
  if (!list.includes(h)) list.push(h);
  writeArr(LS.trusted, list);
  return true;
}

export function removeTrustedHost(host) {
  const h = hostOfOrigin(host);
  writeArr(LS.trusted, listTrusted().filter((x) => x !== h));
  return true;
}

// ═══ the one-time "you understand the risk" acknowledgement ═══════════════

export function hasConsented() { try { return localStorage.getItem(LS.consented) === '1'; } catch { return false; } }
export function setConsented(v) { try { v ? localStorage.setItem(LS.consented, '1') : localStorage.removeItem(LS.consented); } catch { /* ignore */ } }

// ═══ clearing ════════════════════════════════════════════════════════════

/**
 * Wipe browsing state. `sites` is separate and NOT cleared here: revoking a
 * session and forgetting a website are different intentions, and a user
 * clearing history does not expect their wallet to be disconnected.
 */
export function clearBrowsingData() {
  for (const k of ['bear.dapp.tabs', 'bear.dapp.active', 'bear.dapp.history', 'bear.dappBookmarks']) {
    try { localStorage.removeItem(k); } catch { /* ignore */ }
  }
}

// ═══ window bridge, so the browser UI can read the store without a DOM ════

/**
 * Kept on window on purpose: the browser chrome reads it, and so does the
 * injected provider, and threading a store through both would mean two
 * sources of truth. It holds origins and permission names — never a key.
 */
function syncWindow() {
  try {
    window.__bearSites = listSites();
  } catch { /* no window in tests */ }
}

export function securityConfig() {
  return {
    blockedHosts: listBlocked(),
    trustedHosts: listTrusted(),
    sites: listSites(),
  };
}

export function getSecurityConfig() { return securityConfig(); }

syncWindow();
