// ── the wiring gates ────────────────────────────────────────────────
// A function on the contract is not a feature. Twice in this Dex, code shipped
// green with an entire capability unreachable from the app:
//
//   • the market maker read its signer off the coin object, which has none, so
//     start() refused on every device while 12/12 on-chain checks passed
//   • addLiquidity / removeLiquidity shipped on the contract, in the ABI, and
//     proven by an on-chain gate — with no UI anywhere calling them
//
// Both failed the same way: the engine was tested, the wiring was not. So the
// check that matters is not "does the capability work" but "can the app reach
// it" — and that is checkable by reading the two sides against each other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(join(root, p), 'utf8');
const dexFiles = readdirSync(join(root, 'js/dex')).filter((f) => f.endsWith('.js'));
const allDex = dexFiles.map((f) => ({ f, src: read(`js/dex/${f}`) }));
const dexSrc = allDex.map((x) => x.src).join('\n');

test('every Dex module is actually imported by another module', () => {
  // A module nothing imports is code the app never runs. list.js shipped for
  // several commits with seven exported functions and zero callers — delisting
  // was "done" on paper and absent from the product.
  //
  // The v2 pool rebuild has a window where its engine modules (docs/DEX-V2.md
  // M2) are proven on a REAL chain by the v2 harness before their panels land
  // (M3/M4). Those names sit in the list below — and the list has teeth: the
  // exemption holds only while the v2 harness imports the module RIGHT NOW, so
  // losing that proof turns the gate red in the same commit. When a v2 panel
  // starts importing one, delete its line.
  const v2Harness = 'tests/dex-v2-onchain-e2e.mjs';
  const v2PreUi = ['pool-math.js', 'pools.js', 'pool-data.js'];
  for (const { f, src } of allDex) {
    const isEntry = ['index.js', 'pump-source.js'].includes(f);
    if (isEntry) continue;
    if (v2PreUi.includes(f)) {
      assert.ok(read(v2Harness).includes(`js/dex/${f}`),
        `js/dex/${f} is exempt only while ${v2Harness} imports it — the exemption just expired`);
      continue;
    }
    // BOTH import forms count. tokens.js pulls discover.js in with a dynamic
    // `await import()`, and a gate that only understood the static form called
    // a working module dead — which is how a "stranded module" check teaches
    // people to ignore it.
    const re = new RegExp(`(?:from|import)\\s*\\(?\\s*'\\./${f.replace('.', '\\.')}'`);
    const importedBy = allDex.some((o) => o.f !== f && re.test(o.src));
    assert.ok(importedBy, `js/dex/${f} is imported by nothing — the app never runs it`);
  }
});

test('every liquidity function on the contract is reachable from the UI', () => {
  // The gate that would have caught the orphaned pool. Named one by one so the
  // failure says which capability is stranded.
  for (const fn of ['addLiquidity', 'removeLiquidity']) {
    assert.ok(new RegExp(`\\.${fn}\\s*\\(`).test(dexSrc),
      `${fn}() exists on the contract but no UI calls it — it is not a feature yet`);
  }
  // …and the panel must read the pool rather than guess at it.
  for (const read of ['lpValue', 'totalLpShares', 'positionOf']) {
    assert.ok(new RegExp(`\\.${read}\\s*\\(`).test(dexSrc),
      `the pool panel must READ ${read}() from the chain, not invent a number`);
  }
});

test('the pool panel refuses before it spends, and says why', () => {
  const liq = read('js/dex/liquidity.js');
  // Guards that must exist BEFORE the first transaction is sent. A deposit that
  // goes through with no confirmation is a deposit the user cannot see coming.
  assert.match(liq, /confirmTx\(/, 'adding to a pool must be confirmed first');
  assert.match(liq, /if \(amount <= 0n\)/, 'a zero deposit must be refused');
  assert.match(liq, /amount > snap\.qbal/, 'a deposit larger than the balance must be refused');
  assert.match(liq, /shares > snap\.shares/, 'withdrawing more than your own share must be refused');
  assert.match(liq, /if \(snap\.total === 0n \|\| snap\.shares === 0n\)/,
    'withdrawing with no position must be refused, not sent as a zero');
});

test('the pool panel states what a deposit does NOT do', () => {
  // The difference between adding liquidity and buying is the whole point of
  // the feature. A panel that omits it lets the two blur into one another.
  const i18n = read('js/i18n.js');
  assert.ok(/dex\.liq\.truth/.test(i18n), 'the panel must carry its own explanation');
  assert.match(i18n, /dex\.liq\.truth': '[^']*(NOT|does not)[^']*'/,
    'the explanation must say plainly that depositing does not buy tokens and does not move the price');
  for (const lang of ['Add to the pool', 'Masukkan ke pool']) {
    assert.ok(i18n.includes(lang), `both languages must offer the action: ${lang}`);
  }
});

test('deleting a coin is a real delete, and it stays deleted', () => {
  const tokens = read('js/dex/tokens.js');
  const trade = read('js/dex/trade.js');
  // The user (APK, 2026-10-15): "fitur dex itu bener² hapus coin bukan hide
  // coin". A hide behind a Hidden tab with a Restore-all button is exactly what
  // they rejected — none of it may come back.
  assert.ok(!/data-dex-scope="hidden"/.test(tokens), 'no Hidden tab — a delete is not a hide');
  assert.ok(!/dexUnhideAll/.test(tokens), 'no Restore-all button — a delete you can undo is a hide');
  assert.match(tokens, /withoutDeleted\(coins\)/, 'deleted coins must actually leave the feed');
  assert.match(tokens, /export function forgetLaunchedToken/, 'delete must drop the coin from the launched index too');
  assert.match(trade, /forgetLaunchedToken\(token\.address\)/, 'the coin page wires the index removal');
  assert.match(trade, /deleteCoin\(token\.address\)/, 'and the tombstone that keeps it deleted');
  assert.match(trade, /confirmTx\(/, 'a permanent delete must ask first');
  assert.ok(!/unhideCoin|isHidden/.test(trade), 'no restore path may survive on the coin page');
  // The chain keeps the coin; the note must not pretend the coin itself is gone.
  assert.ok(/dex\.list\.deleteNote': '[^']*chain[^']*'/i.test(read('js/i18n.js')),
    'the note must say the contract still lives on the chain, or delete reads as burning the coin');
});

test('a deleted coin cannot be resurrected by the chain scan', () => {
  // withoutDeleted() is applied to coins that came FROM the chain, and the
  // Launched-event scan is creator-scoped — so without the tombstone every
  // refresh would re-find the coin and put it back on the grid, reading as
  // "delete didn't work". The tombstone is the difference. It is applied to a
  // list that was already real; it can only remove, never invent.
  const list = read('js/dex/list.js');
  assert.match(list, /function withoutDeleted/, 'the filter must exist');
  assert.match(list, /localStorage/, 'the tombstone must survive a reload, or the coin returns tomorrow');
  assert.match(list, /bear\.dex\.deleted/, 'the delete log is its own key');
  assert.match(list, /bear\.dex\.hidden/, 'coins hidden before the delete design stay gone (migration)');
  assert.match(list, /try\s*\{/, 'storage writes must be guarded — private mode is not an error to crash on');
});

test('the Dex contract ABI is fully wired: no capability stranded in pump-source.js', () => {
  // A blunt sweep, deliberately. pump-source.js holds the ABI for a contract
  // that grows features; every one of its public capabilities must be called
  // somewhere in the UI. This is the check that turns "we added a function"
  // into "we added a feature", and it fails loudly on the next addition.
  const src = read('js/dex/pump-source.js');
  const abiBlock = src.slice(src.indexOf('PUMP_ABI'), src.indexOf('];', src.indexOf('PUMP_ABI')));
  const sigs = [...abiBlock.matchAll(/'function\s+([a-zA-Z_][\w]*)\s*\(/g)].map((m) => m[1]);
  const unique = [...new Set(sigs)].filter((n) => !['constructor'].includes(n));
  assert.ok(unique.length >= 15, `expected the full capability set, parsed ${unique.length}`);

  const uiSrc = allDex.filter((x) => x.f !== 'pump-source.js').map((x) => x.src).join('\n');
  // Aliases, named out loud with the reason. Each one is a SECOND way to read
  // the same value that the UI gets from somewhere else — so the UI really is
  // using the capability, just not through this particular entry point. A short,
  // justified list is honest; a silent skip is a gate nobody trusts.
  const ALIAS = {
    lpShares: 'positionOf() returns the same shares in its first return value',
    quoteDecimals: "the panel asks the ERC-20 itself for decimals(), which is the same number",
  };
  const stranded = unique.filter((name) => {
    if (name in ALIAS) return false;
    if (name.startsWith('get') || name.startsWith('total')) return false;
    return !new RegExp(`\\.${name}\\s*\\(`).test(uiSrc);
  });
  assert.deepEqual(stranded, [],
    `these contract capabilities are in the ABI but no UI calls them — a function is not a feature: ${stranded.join(', ')}`);
});
// ── the panel-level gates ───────────────────────────────────────────
// The gates above check that a capability is reachable. These check that the
// panel around it is honest, because a reachable button that misleads is worse
// than a missing one: the user acts on it.
test('every Dex panel is rendered by the coin page, not merely defined', () => {
  const trade = read('js/dex/trade.js');
  // liquidityHtml/botHtml exist and are called. A panel defined in a module and
  // never inserted into the page is the same stranded code wearing a UI.
  for (const fn of ['liquidityHtml', 'botHtml']) {
    assert.ok(new RegExp(`\\b${fn}\\(`).test(trade), `the coin page must render ${fn}()`);
  }
  assert.ok(/bindLiquidity\(/.test(trade), 'and bind it, or the buttons do nothing');
});

test('a panel number is never rendered before the chain has been asked', () => {
  // Every stat starts as a placeholder and is filled from a contract read. If a
  // panel painted zeros at the top and then quietly failed to update, the user
  // would read an empty pool as an empty pool.
  const liq = read('js/dex/liquidity.js');
  assert.match(liq, /id="dexLiqPool">—</, 'the pool figure must start as a placeholder, not a number');
  assert.match(liq, /lpValue\(\)/, 'and be filled from lpValue()');
  assert.match(liq, /unreadable/, 'a failed read must be said out loud, not left as a dash');
});

test('the liquidity panel cannot render a position for a signed-out reader', () => {
  // positionOf() and lpShares() take the reader's address. With no address they
  // must not be called with "undefined", and the panel must say the reader has
  // nothing rather than showing someone else's position as their own.
  const liq = read('js/dex/liquidity.js');
  assert.match(liq, /const me = get\('address'\)/, 'the panel reads the wallet address');
  assert.ok(/me\s*&&|if \(!me\)|me \? /.test(liq),
    'and must handle there being no address yet — "undefined" is not an address');
});

test('the delete design leaves no way to bring a coin back', () => {
  // The old design was reversible BY CONSTRUCTION (hidden tab + restore all).
  // The delete design replaces it wholesale: one confirmation, one tombstone,
  // and no UI anywhere that can bring the coin back.
  const list = read('js/dex/list.js');
  assert.ok(!/unhideAll|unhideCoin/.test(list), 'no restore functions may exist in the delete design');
  assert.match(list, /export function deleteCoin/, 'one delete entry point');
  assert.match(list, /export function withoutDeleted/, 'and one filter the UI applies');
  const index = read('js/dex/index.js');
  assert.ok(!/unhideAll/.test(index), 'the feed nav must not wire a restore handler');
  const tokens = read('js/dex/tokens.js');
  assert.ok(!/scope === 'hidden'/.test(tokens), 'and no scope shows what was hidden');
});

// ── duplicate ids ───────────────────────────────────────────────────
// The coin page rendered the market maker TWICE — once from the panel it
// already had, once when the pool panel was added beside it. bindBot resolves
// every control through $(), which is always the FIRST match, so the second
// copy rendered as a header the user could click and nothing would open: 19
// duplicated ids, one visibly inert panel, sitting closest to the fold.
// A gate that regex-matches `botHtml(` cannot tell one call from two.
test('the coin page renders each panel exactly once', () => {
  const trade = read('js/dex/trade.js');
  for (const fn of ['botHtml', 'liquidityHtml']) {
    const n = (trade.match(new RegExp(`\\$\\{${fn}\\(\\)\\}`, 'g')) || []).length;
    assert.equal(n, 1, `${fn}() is rendered ${n} times — every copy past the first is inert, because $() always resolves to the first`);
  }
});

test('no id is rendered twice on the coin page', () => {
  // The general form of the bug above, so the next duplicate is caught whatever
  // its name is.
  const trade = read('js/dex/trade.js');
  const ids = [...trade.matchAll(/id="(dex[A-Za-z0-9_]+)"/g)].map((m) => m[1]);
  const dupes = ids.filter((v, i) => ids.indexOf(v) !== i);
  assert.deepEqual([...new Set(dupes)], [],
    'duplicate ids on one page: the second copy is unreachable and the first is ambiguous');
});

// ── temporal dead zone ──────────────────────────────────────────────
// `once()` was called for the pool panel ABOVE the `const once = …` that
// declares it. Node's parser accepts the file; nothing in the unit suite runs
// bindTokenTrade end to end; and the coin page threw
// "Cannot access 'once' before initialization" on every open — the Dex's
// central screen, dead, behind a green suite. A browser is what found it.
//
// A static gate cannot run the module, so it does the next best thing: every
// identifier used as a call must be declared before that use, in the same
// function. That is the whole of a TDZ bug, checkable by reading.
test('nothing on the coin page is called before it is declared', () => {
  const trade = read('js/dex/trade.js');
  // Comments are stripped FIRST. A prose sentence mentioning `once()` matched
  // this gate before the code did — twice now a static check has been fooled by
  // the explanation next to the code rather than the code itself. Source-scanning
  // gates that read raw text must read only code.
  const noComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map((l) => l.replace(/(\/\/.*)$/, '')).join('\n');
  const body = noComments(trade.slice(trade.indexOf('export function bindTokenTrade')));
  assert.ok(body.length > 1000, 'bindTokenTrade should be the function we check');

  // const/let declarations, in source order.
  const decls = new Map();
  const declRe = /^\s*(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/gm;
  let m;
  while ((m = declRe.exec(body)) !== null) {
    if (!decls.has(m[1])) decls.set(m[1], m.index);
  }

  // Uses that are a bare call on the identifier.
  const useRe = /(^|[^\w.$])([A-Za-z_$][\w$]*)\s*\(/g;
  const problems = [];
  while ((m = useRe.exec(body)) !== null) {
    const name = m[2];
    if (!decls.has(name)) continue;               // not a local const
    const declaredAt = decls.get(name);
    const usedAt = m.index + m[1].length;
    // A declaration initialiser legitimately references its own name only after
    // the '='; anything earlier is a TDZ access.
    const declLine = body.slice(declaredAt, body.indexOf('\n', declaredAt));
    if (usedAt > declaredAt && usedAt < declaredAt + declLine.length) continue;
    if (usedAt < declaredAt) {
      const line = body.slice(0, usedAt).split('\n').length + trade.slice(0, trade.indexOf(body)).split('\n').length;
      problems.push(`${name}() is called on line ~${line} but declared on line ~${body.slice(0, declaredAt).split('\n').length + trade.slice(0, trade.indexOf(body)).split('\n').length}`);
    }
  }
  assert.deepEqual(problems, [], `temporal dead zone — these throw the moment a coin is opened: ${problems.join('; ')}`);
});
