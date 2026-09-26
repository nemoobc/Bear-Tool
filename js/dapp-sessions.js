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

// ═══ connected sites ═════════════════════════════════════════════════════

/** @returns {Array<{origin:string,name:string,chainId:number|null,at:number,perms:string[]}>} */
export function listSites() {
  return readArr(LS.sites)
    .filter((s) => s && typeof s.origin === 'string' && /^https?:\/\//i.test(s.origin))
    .map((s) => ({
      origin: s.origin,
      name: s.name || s.origin,
      chainId: Number.isInteger(s.chainId) ? s.chainId : null,
      at: Number.isFinite(s.at) ? s.at : 0,
      perms: Array.isArray(s.perms) ? s.perms : [],
    }));
}

export function siteAllowed(origin) {
  if (!origin) return false;
  return listSites().some((s) => s.origin === String(origin).toLowerCase());
}

/**
 * Grant an origin access. Idempotent — reconnecting to a site already in the
 * list must not create a second row, or the list becomes noise.
 */
export function addSite(origin, { name = '', chainId = null, perms = [] } = {}) {
  const o = String(origin || '').toLowerCase();
  if (!/^https?:\/\//i.test(o)) return false;
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
  const o = String(origin || '').toLowerCase();
  writeArr(LS.sites, listSites().filter((s) => s.origin !== o));
  syncWindow();
}

export function clearSites() {
  writeArr(LS.sites, []);
  syncWindow();
}

/** Per-origin permission grants, so revoking one is possible without a nuke. */
export function grantPermission(origin, method) {
  const o = String(origin || '').toLowerCase();
  const list = listSites();
  const s = list.find((x) => x.origin === o);
  if (!s) return false;
  if (!s.perms.includes(method)) s.perms.push(method);
  writeArr(LS.sites, list);
  syncWindow();
  return true;
}

export function hasPermission(origin, method) {
  const s = listSites().find((x) => x.origin === String(origin || '').toLowerCase());
  return !!s && s.perms.includes(method);
}

export function revokePermission(origin, method) {
  const o = String(origin || '').toLowerCase();
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

export function isBlocked(host) {
  const h = hostOfOrigin(host);
  return !!h && listBlocked().includes(h);
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
