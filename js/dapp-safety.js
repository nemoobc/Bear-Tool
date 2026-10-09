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
/**
 * A bare host with no scheme: `host[:port][/path][?query][#hash]`, no spaces.
 * Returns the ready-to-load URL (scheme prefixed), or null when the string is
 * not host-shaped at all.
 *
 * This must run BEFORE the scheme grammar below. `/^[a-z][a-z0-9+.-]*:/`
 * matches "example.com:" and "localhost:" just as happily as "http:", so
 * `localhost:3000` used to be answered with "Only http and https can be
 * opened; localhost: is not allowed" — a dev URL blocked by the address bar —
 * and `example.com/path?q=1` fell through to search and never loaded.
 *
 * Scheme choice matches the rest of this file: a hostname gets https, an IP
 * literal or a loopback name gets http (LAN dev nodes serve no TLS).
 */
function bareHostUrl(s) {
  if (!s || /\s/.test(s) || s.startsWith('/')) return null;
  const m = s.match(/^(\[[0-9a-f:.]+\]|[0-9a-zÀ-￿][0-9a-zÀ-￿.-]*)(?::(\d{1,5}))?([/?#].*)?$/i);
  if (!m) return null;
  const host = m[1];
  if (host.startsWith('[')) return 'http://' + s;                       // [::1], [fe80::1]
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return 'http://' + s;     // 1.2.3.4, 192.168.1.10:3000
  if (/^(localhost|127\.0\.0\.1)$/i.test(host)) return 'http://' + s;
  // A dotted name needs a letter somewhere: keeps "2.4"/"build3.1" out of
  // the address bar while "v1.2", "münchen.de", "пример.рф" stay URLs.
  if (host.includes('.') && /[a-zÀ-￿]/i.test(host)) return 'https://' + s;
  return null;
}

export function classifyInput(input) {
  const s = (input || '').trim();
  if (!s) return { kind: 'search', reason: 'empty' };

  // Bare host first — before any scheme can claim the token before a ':'.
  const bare = bareHostUrl(s);
  if (bare) return { kind: 'url', url: bare };

  // A scheme was written out. Trust the scheme, then vet it.
  const schemeMatch = s.match(/^([a-z][a-z0-9+.-]*):/i);
  if (schemeMatch) {
    // A dot in the token before ':' means host-shaped, not a scheme
    // ("example.com:banana") — search is honest, scheme-blocking is not.
    if (schemeMatch[1].includes('.')) return { kind: 'search', url: s };
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

  // Protocol-relative, e.g. //example.com — never typed on purpose, but cheap
  // to support and cheaper to reject than to guess.
  if (s.startsWith('//')) return { kind: 'url', url: 'https:' + s };

  return { kind: 'search', url: s };
}

/**
 * Find the catalogue entry a typed query means, or null.
 *
 * This was an inline `catalog.find(...includes(q))` in the browser's navigate().
 * `includes` is true for an empty needle against every string, and for a
 * one-character needle against nearly every name, so the address bar navigated on
 * noise. Measured against the shipped catalogue: "a" opened Uniswap, "e" Curve,
 * "o" Compound, "x" Etherscan, and pressing Enter in an EMPTY address bar opened
 * Uniswap — classifyInput had already returned reason:'empty' for that one, and the
 * caller ignored it. Dropping the user into a dApp browser, the one surface here
 * that can ask for a signature, because a key was struck, is not a behaviour a
 * wallet should have.
 *
 * So: nothing to search for means nothing opens, one character is still a
 * keystroke on the way to something else, and an exact name is preferred over a
 * prefix and a prefix over a substring, because the catalogue's own order must not
 * decide which dApp opens.
 *
 * @param {Array<{name:string,category?:string,url:string}>} catalog
 * @param {string} query
 * @returns {object|null}
 */
export function matchCatalog(catalog, query) {
  if (!Array.isArray(catalog) || !catalog.length) return null;
  const q = String(query ?? '').trim().toLowerCase();
  if (q.length < 2) return null;                 // empty, whitespace, one keystroke
  const label = (d) => `${d.name || ''} ${d.category || ''}`.trim().toLowerCase();
  const name = (d) => String(d.name || '').trim().toLowerCase();

  // 1. exact name — "Swap" must not be beaten by "CoW Swap" that happens to sit first
  const exact = catalog.find((d) => name(d) === q);
  if (exact) return exact;
  // 2. name starts with it
  const prefix = catalog.find((d) => name(d).startsWith(q));
  if (prefix) return prefix;
  // 3. anywhere in the name or the category — "compound", "lending"
  const anywhere = catalog.find((d) => label(d).includes(q));
  return anywhere || null;
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
  //
  // Mixing is judged PER LABEL. "münchen.de" mixes nothing — ü is Latin — and
  // "пример.com" puts Cyrillic in one label and Latin in the next; neither
  // pretends to be a word it is not. The attack is ONE label spelled two ways
  // — "аpple" with a Cyrillic а inside Latin letters — so only that keeps the
  // hard DANGER with no way past it. A host wholly in one foreign script gets
  // the caution sheet with a named reason ("метамаск" imitating "metamask" is
  // a reason a user can read and weigh): refusing every non-ASCII host would
  // mean "all URLs" except those written in other languages.
  const rawHost = String(url).replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0].replace(/^[^/@]*@/, '');
  const typedIdn = NON_ASCII_LETTER.test(rawHost);
  const scriptOf = (ch) => {
    const c = ch.codePointAt(0);
    if (c < 0x80 || (c >= 0xc0 && c <= 0x24f) || (c >= 0x1e00 && c <= 0x1eff)) return 'latin';
    if (c >= 0x400 && c <= 0x4ff) return 'cyrillic';
    if (c >= 0x370 && c <= 0x3ff) return 'greek';
    if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3040 && c <= 0x30ff) || (c >= 0xac00 && c <= 0xd7af)) return 'east-asian';
    if (c >= 0x600 && c <= 0x6ff) return 'arabic';
    if (c >= 0x590 && c <= 0x5ff) return 'hebrew';
    if (c >= 0x900 && c <= 0x97f) return 'devanagari';
    return 'other';
  };
  const labelMixed = (l) => {
    const scripts = new Set();
    for (const ch of String(l)) if (/\p{L}/u.test(ch)) scripts.add(scriptOf(ch));
    return scripts.size > 1;
  };
  // Punycode the user TYPED hides its scripts — only the raw bytes can say so,
  // and they say ASCII. That case keeps the old hard fail below.
  const mixedLabel = !typedIdn && host.includes('xn--')
    ? false
    : rawHost.split('.').some(labelMixed);
  if (mixedLabel) {
    add('fail', 'Mixed-script host', 'One label mixes alphabets — that is how "аpple.com", with a Cyrillic "а", is spelled: visually identical, different site.');
  } else if (!typedIdn && host.includes('xn--')) {
    add('fail', 'Punycode host', 'The hostname uses punycode (xn--), the usual written form of an IDN lookalike domain. A dApp you genuinely know will not need it.');
  } else if (typedIdn) {
    add('warn', 'Foreign-script host', 'The domain uses accented or non-Latin letters. Read it letter by letter: lookalike glyphs are how a known name gets faked.');
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
