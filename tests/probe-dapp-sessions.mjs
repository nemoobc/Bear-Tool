// Adversarial probe for dapp-sessions.js — the permission model.
//
// 15 of this module's exports are referenced by no test, and it decides which
// origins may see the wallet and what the user granted them. That is a security
// surface, and the three bugs found so far in this project all came from the same
// place: code nothing ever ran.
//
// This file is a probe, not a test. It prints what it finds; it does not assert,
// because asserting means I have to predict the bug first, and the whole value of
// calling the code is that I do not.

const store = () => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
  };
};
globalThis.localStorage = store();
globalThis.window = { dispatchEvent() {} };
globalThis.dispatchEvent = () => {};

const S = await import('../js/dapp-sessions.js');
const findings = [];
const ok = (label, cond, detail = '') =>
  findings.push({ label, pass: !!cond, detail: String(detail).slice(0, 160) });

// ── the ordinary path first, so a later failure is not blamed on setup ──────
S.clearBrowsingData();
ok('addSite menerima https', S.addSite('https://dapp.com', { name: 'Dapp' }) === true);
ok('siteAllowed untuk yang ditambahkan', S.siteAllowed('https://dapp.com') === true);
ok('grantPermission lalu hasPermission',
  S.grantPermission('https://dapp.com', 'eth_accounts') && S.hasPermission('https://dapp.com', 'eth_accounts'));
ok('revokePermission mencabut', S.revokePermission('https://dapp.com', 'eth_accounts') &&
  !S.hasPermission('https://dapp.com', 'eth_accounts'));
ok('addSite idempoten (tidak duplikat)',
  (S.addSite('https://dapp.com'), S.addSite('https://dapp.com'), S.listSites().length === 1),
  `jumlah entri: ${S.listSites().length}`);

// ── now the inputs a normal user never types ───────────────────────────────

// 1. Case. The host is case-insensitive, so the same site typed in capitals is the
//    same site. Stored origins are lowercased on write; is the read path as careful?
S.clearBrowsingData();
S.addSite('https://Dapp.COM', { name: 'Cap' });
ok('origin huruf besar/kecil tetap dikenali',
  S.siteAllowed('https://dapp.com') && S.siteAllowed('https://DAPP.com'),
  `disimpan: ${JSON.stringify(S.listSites().map(s => s.origin))}`);

// 2. A mixed-case entry already in storage — which the header promises to tolerate,
//    since it says every read tolerates a corrupt value.
S.clearBrowsingData();
localStorage.setItem('bear.dappSites', JSON.stringify([{ origin: 'https://MixedCase.com', perms: ['eth_accounts'] }]));
ok('entri storage huruf besar/kecil tetap dikenali',
  S.siteAllowed('https://mixedcase.com'),
  `terbaca: ${JSON.stringify(S.listSites().map(s => s.origin))}`);
ok('izin pada entri huruf besar/kecil tetap berlaku',
  S.hasPermission('https://mixedcase.com', 'eth_accounts'));

// 3. Trailing slash and port. https://dapp.com and https://dapp.com/ are the same
//    origin to a browser, and a redirect between them must not silently drop the
//    session.
S.clearBrowsingData();
S.addSite('https://dapp.com', {});
ok('garis miring di akhir dianggap situs yang sama', S.siteAllowed('https://dapp.com/') === true);
S.clearBrowsingData();
S.addSite('https://dapp.com:443', {});
ok('port eksplisit yang sama dianggap situs yang sama', S.siteAllowed('https://dapp.com') === true);

// 4. Blocklist. This is the user's own "do not talk to these" list, so the ways to
//    slip past it are the ones worth probing.
S.clearBrowsingData();
S.addBlockedHost('https://phish.example');
ok('host persis diblokir', S.isBlocked('phish.example'));
ok('http (bukan https) ikut diblokir', S.isBlocked('http://phish.example'));
ok('dengan path ikut diblokir', S.isBlocked('https://phish.example/login'));
ok('subdomain dari host yang diblokir',
  S.isBlocked('login.phish.example'),
  'ini yang perlu dilihat: memblokir example tidak otomatis memblokir subdomain-nya');

// 5. Removing something that was never there must not throw or corrupt.
S.clearBrowsingData();
let threw = null;
try {
  S.removeBlockedHost('never-added.example');
  S.removeTrustedHost('never-added.example');
  S.removeSite('https://never.example');
  S.revokePermission('https://never.example', 'eth_accounts');
} catch (e) { threw = e.message; }
ok('menghapus yang tidak ada tidak melempar', threw === null, threw || '');

// 6. Hostile stored values: a security control that throws on bad input is one
//    that gets switched off, per this module's own header.
S.clearBrowsingData();
const hostile = [
  ['bukan JSON', 'bear.dappSites', '{oops'],
  ['JSON tapi bukan array', 'bear.dappSites', '{"a":1}'],
  ['array tapi elemennya bukan objek', 'bear.dappSites', '[1,2,3]'],
  ['origin non-string', 'bear.dappSites', '[{"origin":123}]'],
  ['perms bukan array', 'bear.dappSites', '[{"origin":"https://a.com","perms":"eth_accounts"}]'],
  ['at itu NaN', 'bear.dappSites', '[{"origin":"https://a.com","at":"x"}]'],
  ['blocked bukan array', 'bear.dappBlocked', '"phish.example"'],
];
for (const [label, key, value] of hostile) {
  localStorage.setItem(key, value);
  let err = null;
  let out = null;
  try { out = S.listSites(); S.isBlocked('x'); S.hasPermission('https://a.com', 'p'); }
  catch (e) { err = e.message; }
  ok(`toleran terhadap: ${label}`, err === null, err || JSON.stringify(out).slice(0, 90));
  localStorage.removeItem(key);
}

// 7. Does granting one method leak into another?
S.clearBrowsingData();
S.addSite('https://dapp.com', { perms: ['eth_accounts'] });
ok('izin eth_sendTransaction tidak ikut diberikan',
  !S.hasPermission('https://dapp.com', 'eth_sendTransaction'));
ok('izin eth_accounts tetap ada', S.hasPermission('https://dapp.com', 'eth_accounts'));
ok('grant lalu check metode lain tetap terpisah',
  (S.grantPermission('https://dapp.com', 'personal_sign'), !S.hasPermission('https://dapp.com', 'eth_sign')));

// 8. Consent gate.
S.clearBrowsingData();
ok('belum consenting', S.hasConsented() === false);
S.setConsented(true);
ok('set consenting', S.hasConsented() === true);
S.setConsented(false);
ok('cabut consenting', S.hasConsented() === false);

// 9. "Clear browsing data" is scoped, and says so.
//
// The first version of this probe assumed clearBrowsingData() was a privacy wipe
// and reported that it left connected sites and their permissions intact. It is
// not a privacy wipe: Security Center has a separate #secDisconnectAll that calls
// clearSites(), and this one toasts "Browsing data cleared. Connected sites were
// left alone." The separation is deliberate and honestly labelled, so the
// assertion below pins the real contract rather than a mistake about it.
localStorage.setItem('bear.dapp.tabs', JSON.stringify([{ id: 't1' }]));
localStorage.setItem('bear.dapp.history', JSON.stringify([{ url: 'https://a.example' }]));
S.clearBrowsingData();
ok('clear browsing data menghapus tab', localStorage.getItem('bear.dapp.tabs') === null);
ok('clear browsing data menghapus history', localStorage.getItem('bear.dapp.history') === null);
S.addSite('https://kept.example', { perms: ['eth_accounts'] });
S.clearBrowsingData();
ok('clear browsing data TIDAK memutus situs — itu tugas clearSites',
  S.siteAllowed('https://kept.example') && S.hasPermission('https://kept.example', 'eth_accounts'));
S.clearSites();
ok('clearSites memutus situs', S.siteAllowed('https://kept.example') === false);
ok('clearSites juga mencabut izinnya', S.hasPermission('https://kept.example', 'eth_accounts') === false);

// 10. Blocked and trusted are separate from sessions, and stay separate.
S.clearBrowsingData();
S.addBlockedHost('phish.example');
S.addSite('https://phish.example', {});
ok('memblokir host tidak memutus sesi yang sudah ada — dua keputusan berbeda',
  S.isBlocked('phish.example') && S.siteAllowed('https://phish.example'));
S.addTrustedHost('phish.example');
ok('mempercayai host mengeluarkan dari blocklist',
  !S.isBlocked('phish.example') && S.listTrusted().includes('phish.example'));

S.clearBrowsingData();
const bad = findings.filter((f) => !f.pass);
for (const f of findings) console.log(`  ${f.pass ? 'ok  ' : 'TEMUAN'}  ${f.label}${f.detail ? '  — ' + f.detail : ''}`);
console.log(`\n  ${findings.length} pemeriksaan · ${bad.length} gagal`);
process.exit(bad.length ? 1 : 0);
