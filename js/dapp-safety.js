// ═══════════════════════════════════════════════════════════════
// dapp-safety.js — decide whether a dApp may be opened, and say why.
//
// Wallets like MetaMask, Coinbase and Rabby all gate a dApp before it loads.
// The commercial version of that is Blockaid's scanner (<0.002% false positives,
// verdict in under 300ms — MetaMask, Coinbase Wallet, Trust, Rabby and OKX all
// buy it). We cannot buy it, and pretending a handful of regexes is a malware
// scan would be a lie, so this file does only the parts that are honestly
// doable in a browser and labels them as heuristics:
//
//   - scheme allow-list (javascript:/data:/blob:/file: can never be navigated)
//   - HTTPS or not
//   - punycode / mixed-script host → homograph lookalike, the single most common
//     way a real dApp's name is faked
//   - IP-literal hosts
//   - keyword+TLD pairing that the phishing industry leans on (claim/airdrop on
//     a cheap TLD), kept small and clearly named as a heuristic
//   - membership in the curated catalogue, so an unknown site is not presented
//     as known-good
//
// Everything is a pure function over a string so it can be unit-tested without
// a browser, and every verdict carries the signals that produced it. No single
// "is safe" boolean is returned, because a boolean here would be read as an
// audit and these checks are not one.
// ═══════════════════════════════════════════════════════════════

export const VERDICT = {
  BLOCKED: 'blocked',   // cannot be navigated at all
  DANGER: 'danger',     // almost certainly hostile — refuse unless forced
  CAUTION: 'caution',   // unknown / unencrypted — warn, then allow
  KNOWN: 'known',       // in the curated catalogue, nothing raised
};

const OK_SCHEMES = new Set(['http:', 'https:']);

// Schemes that must never be navigated into. javascript: and data: are the
// script-execution ones; the rest can read local files or escape the origin.
const DEAD_SCHEMES = new Set([
  'javascript:', 'data:', 'vbscript:', 'blob:', 'file:', 'about:', 'chrome:',
]);

// Cheapest TLDs, ranked by how often they show up in phishing. Only paired with
// a lure keyword below — a cheap TLD on its own is just a cheap TLD.
const SOFT_TLDS = new Set(['xyz', 'top', 'click', 'link', 'gq', 'cf', 'tk', 'ml', 'ga', 'work', 'rest', 'buzz']);
const LURE_WORDS = /(claim|airdrop|air-drop|free[-_]?mint|free[-_]?nft|giveaway|bonus|reward|presale|whitelist|allowlist|dao[-_]?vote|double)/i;

// Cyrillic / Greek letters that render as Latin ones. Used only to detect a
// mixed-script host, never to rewrite it.
const NON_ASCII_LETTER = /[^\x00-\x7F]/;

export function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

export function originOf(url) {
  try { return new URL(url).origin.toLowerCase(); } catch { return ''; }
}

/** Registrable-ish parent: strips one label so app.uniswap.org ≈ uniswap.org. */
export function baseHost(url) {
  const h = hostOf(url);
  if (!h) return '';
  const parts = h.split('.').filter(Boolean);
  if (parts.length <= 2) return h;
  // Handle two-part public suffixes we actually meet (co.uk, com.au, …).
  const two = new Set(['co', 'com', 'net', 'org', 'gov', 'ac', 'or', 'ne']);
  if (two.has(parts[parts.length - 2]) && parts[parts.length - 1].length === 2) {
    return parts.slice(-3).join('.');
  }
  return parts.slice(-2).join('.');
}

/** Bare hostname of the browser's own origin, e.g. localhost. */
function selfHost() {
  try { return globalThis.location?.hostname?.toLowerCase() || ''; } catch { return ''; }
}

/**
 * Decide what the user typed.
 * @returns {{kind:'url'|'blocked'|'search', url?:string, reason?:string}}
 */
export function classifyInput(input) {
  const s = (input || '').trim();
  if (!s) return { kind: 'search', reason: 'empty' };

  // A scheme was written out. Trust the scheme, then vet it.
  const schemeMatch = s.match(/^([a-z][a-z0-9+.-]*):/i);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase() + ':';
    if (DEAD_SCHEMES.has(scheme)) {
      return { kind: 'blocked', reason: `The ${scheme} scheme can execute script or read local data, so it is never loaded.` };
    }
    if (!OK_SCHEMES.has(scheme)) {
      return { kind: 'blocked', reason: `Only http and https can be opened; ${scheme} is not allowed.` };
    }
    if (!s.slice(scheme.length).trim()) return { kind: 'blocked', reason: 'No address after the scheme.' };
    return { kind: 'url', url: s };
  }

  // Bare hostname with a dot and no spaces — treat as a URL.
  if (!/\s/.test(s) && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(s)) {
    return { kind: 'url', url: 'https://' + s };
  }

  // localhost / an IP, with an optional port and path.
  if (!/\s/.test(s) && /^(localhost|127\.0\.0\.1|\[?::1\]?)(:\d+)?(\/.*)?$/i.test(s)) {
    return { kind: 'url', url: 'http://' + s };
  }

  // Protocol-relative, e.g. //example.com — never typed on purpose, but cheap
  // to support and cheaper to reject than to guess.
  if (s.startsWith('//')) return { kind: 'url', url: 'https:' + s };

  return { kind: 'search', url: s };
}

/** True when `host` or its parent matches an entry in a user host list. */
export function matchHostList(host, base, list) {
  if (!host || !Array.isArray(list) || !list.length) return false;
  // Order matters: a user pasting "  https://x.com/y " must have the spaces
  // gone before the scheme is stripped, or the scheme regex never matches.
  const clean = list
    .map((h) => String(h || '').toLowerCase().trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim())
    .filter(Boolean);
  return clean.some((h) => host === h || base === h || host.endsWith('.' + h) || h.endsWith('.' + host));
}

/**
 * Full inspection of a navigable URL.
 * @param {string} url
 * @param {Array<{name:string,url:string,frameable?:boolean,category?:string}>} [catalog]
 * @param {{blockedHosts?:string[], trustedHosts?:string[]}} [opts]
 *   `blockedHosts` — the user's own report list; a match is an unconditional
 *   block and nothing in the UI offers a way past it.
 *   `trustedHosts` — the user's "I know this one" list. It can clear CAUTION
 *   because that is only ever "we have not looked at this", but it can never
 *   clear DANGER: a user vouching for a homograph must not be able to talk the
 *   gate out of a homograph.
 * @returns {{url,host,baseHost,verdict:string,signals:Array,known:object|null}}
 */
export function inspectUrl(url, catalog = [], opts = {}) {
  const signals = [];
  const add = (level, label, detail) => signals.push({ level, label, detail });

  let scheme = '';
  try { scheme = new URL(url).protocol; } catch { /* handled below */ }

  if (DEAD_SCHEMES.has(scheme)) {
    add('fail', 'Blocked scheme', `${scheme} pages are not loaded in the in-app browser.`);
    return { url, host: '', baseHost: '', verdict: VERDICT.BLOCKED, signals, known: null };
  }
  if (!OK_SCHEMES.has(scheme)) {
    add('fail', 'Unsupported scheme', `${scheme || 'unknown'} is not http or https.`);
    return { url, host: '', baseHost: '', verdict: VERDICT.BLOCKED, signals, known: null };
  }

  const host = hostOf(url);
  const base = baseHost(url);
  const self = selfHost();

  if (!host) {
    add('fail', 'Unreadable address', 'That address could not be parsed.');
    return { url, host: '', baseHost: '', verdict: VERDICT.BLOCKED, signals, known: null };
  }

  // Our own origin: nothing to vet, it is this very page.
  if (self && (host === self || base === self)) {
    add('pass', 'Same origin', 'This is the wallet’s own page.');
    return { url, host, baseHost: base, verdict: VERDICT.KNOWN, signals, known: null };
  }

  // The user's own blocklist, checked before anything else so a reported site
  // cannot be softened by any later signal.
  const blocked = matchHostList(host, base, opts.blockedHosts);
  if (blocked) {
    add('fail', 'On your blocklist', `You reported ${host} as unsafe. Opening it needs you to remove it from the blocklist first, in Settings → Security.`);
    return { url, host, baseHost: base, verdict: VERDICT.BLOCKED, signals, known: null };
  }

  if (scheme === 'http:') {
    add('warn', 'Not encrypted', 'Traffic is plain HTTP, so anyone on the path can read and alter it. Never type a seed phrase or a key on such a page.');
  }

  const tld = host.split('.').pop() || '';
  const label = host.split('.')[0] || '';

  // Homograph. The URL parser normalises an IDN host to punycode, so the raw
  // input has to be re-read to tell "typed a Cyrillic а" apart from "typed
  // xn--". Same attack, different spelling, so the label names which was seen.
  const typedIdn = NON_ASCII_LETTER.test(url) || NON_ASCII_LETTER.test(label);
  if (typedIdn) {
    add('fail', 'Mixed-script host', 'The address was typed with non-Latin letters inside the domain name. That is how "аpple.com" — with a Cyrillic "а" — is spelled: visually identical, different site.');
  } else if (host.includes('xn--')) {
    add('fail', 'Punycode host', 'The hostname uses punycode (xn--), the usual written form of an IDN lookalike domain. A dApp you genuinely know will not need it.');
  }

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[')) {
    add('warn', 'Raw IP address', 'The site is an IP, not a named domain. Legitimate dApps publish a name; an IP is what a redirect or a seized domain leaves behind.');
  }

  if (LURE_WORDS.test(host) && SOFT_TLDS.has(tld)) {
    add('fail', 'Lure words on a cheap domain', `"${label}" on .${tld} matches the shape of most NFT/airdrop phishing. This is a heuristic, but it is the right shape to refuse.`);
  }

  if (host.length > 45 || (label.match(/-/g) || []).length > 3) {
    add('warn', 'Unusual hostname', 'Long, hyphen-heavy hostnames are common in generated phishing domains.');
  }

  // Catalogue membership. An unknown host is reported as unknown, not as good.
  const known = (catalog || []).find((d) => {
    if (!d?.url) return false;
    const dh = baseHost(d.url);
    return dh && (base === dh || host === dh || host.endsWith('.' + dh));
  }) || null;

  if (known) {
    add('pass', 'In the curated list', `${known.name} is in Bear Tool’s hand-checked catalogue${known.frameable === false ? ', but it refuses embedding, so it opens in a new tab' : ''}.`);
  } else if (host !== 'localhost') {
    add('warn', 'Not in our catalogue', 'This site is not on the hand-checked list. That is not evidence of anything — it just means nobody here has looked at it. Check the project’s own channels before connecting.');
  }

  let worst = signals.some((s) => s.level === 'fail') ? VERDICT.DANGER
    : signals.some((s) => s.level === 'warn') ? VERDICT.CAUTION
      : VERDICT.KNOWN;

  // "I know this site" is allowed to clear a CAUTION, because CAUTION only ever
  // means "nobody here has looked at it" or "plain HTTP". It is deliberately not
  // allowed to clear a DANGER: the user's memory is exactly what a homograph or
  // a lure domain is built to fake, so honouring it there would hand the
  // attacker the one thing they are after.
  if (worst === VERDICT.CAUTION && matchHostList(host, base, opts.trustedHosts)) {
    signals.push({
      level: 'pass',
      label: 'You marked this site as trusted',
      detail: 'You vouch for this host, so the "nobody has checked it" warning is cleared. The hard checks above still apply.',
    });
    worst = VERDICT.KNOWN;
  }

  return { url, host, baseHost: base, verdict: worst, signals, known };
}

export function verdictRank(v) {
  return { [VERDICT.BLOCKED]: 0, [VERDICT.DANGER]: 1, [VERDICT.CAUTION]: 2, [VERDICT.KNOWN]: 3 }[v] ?? 2;
}

const MARK = { pass: '✔', warn: '⚠', fail: '✖' };

/** Renders signals as list items. Kept here so every caller words it the same. */
export function renderSignalList(signals) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return (signals || []).map((s) =>
    `<li class="dsig dsig-${esc(s.level)}"><span class="dsig-mark" aria-hidden="true">${MARK[s.level] || '·'}</span>`
    + `<span><strong>${esc(s.label)}</strong> — ${esc(s.detail)}</span></li>`).join('');
}
