// Bear Tool — tests/dex-launch.test.js
// M5: the launch step. The validators mirror the factory's own guards
// (BEAR/SUPPLY-ZERO, SEED-ZERO, SEED-OVER, FEE-CAP, future lock, min>0),
// the encoder round-trips so the wallet sees exactly the args the UI asked
// for, the receipt parser is the SAME decodeLaunched the scanner uses, the
// token face reads the coin's own public strings, and the launcher's memory
// is chain-scoped and capped. Assertions call the real modules the app calls
// — no source-text regexes for logic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers as realEthers } from 'ethers';

// ── harness ────────────────────────────────────────────────────────────
// `ethers` goes on globalThis BEFORE the dex modules import (app doctrine):
// Interface stays REAL — tests/dex-abi.test.js already pins it to the
// compiler — while Contract collapses to an in-memory read table.

const FAC = '0x' + 'c1'.repeat(20);
const FAKEQ = '0x' + 'aa'.repeat(20);
const TOK = '0x' + '05'.repeat(20);
const PAIR = '0x' + '06'.repeat(20);

const READS = new Map();

class FakeContract {
  constructor(addr) {
    const addrL = String(addr).toLowerCase();
    this.address = addrL;
    return new Proxy(this, {
      get: (target, prop) => {
        if (prop in target) return target[prop];
        return (...args) => {
          const val = READS.get(addrL)?.[prop];
          if (val === undefined) throw new Error(`fake-chain: no read for ${addrL}.${String(prop)}`);
          return typeof val === 'function' ? val(...args) : Promise.resolve(val);
        };
      },
    });
  }
}

const fakeEthers = Object.assign({}, realEthers, { Contract: FakeContract });
globalThis.ethers = fakeEthers;

const { BEAR_FACTORY_ABI } = await import('../js/dex/abi.js');
const l = await import('../js/dex/launch.js');

const GOOD = () => ({
  meta: { name: 'B Meme', symbol: 'BM' },
  totalSupply: 10n ** 24n,
  creatorFeeBps: 30,
  lpLockUntil: 0n,
  seedQuote: 1000n * 10n ** 18n,
  seedToken: 8n * 10n ** 18n,
  minShares: 1n,
});

// ── T1 every contract guard mirrored here, with a why-tag ─────────────
test('launchTx mirrors the factory guards with why-tags before any RPC', () => {
  const bad = (args) => {
    try { l.launchTx(FAC, { ...GOOD(), ...args }); return null; }
    catch (e) { return e.why; }
  };
  assert.equal(bad({}), null, 'the GOOD base rows validate');
  assert.equal(bad({ meta: { name: '', symbol: 'BM' } }), 'name');
  assert.equal(bad({ meta: { name: '  ', symbol: 'BM' } }), 'name');
  assert.equal(bad({ meta: { name: 'B', symbol: '' } }), 'symbol');
  assert.equal(bad({ totalSupply: 0n }), 'supply');
  assert.equal(bad({ seedQuote: 0n }), 'seed');
  assert.equal(bad({ seedToken: 0n }), 'seed');
  assert.equal(bad({ seedToken: 10n ** 24n + 1n }), 'seedover');
  assert.equal(bad({ creatorFeeBps: 31 }), 'fee');
  assert.equal(bad({ creatorFeeBps: -1 }), 'fee');
  assert.equal(bad({ creatorFeeBps: 30 }), null, 'FEE-CAP is inclusive');
  // a lock even one second in the past is refused (uint64 0 = no lock)
  assert.equal(bad({ lpLockUntil: 1n }), 'lock');
  assert.equal(bad({ minShares: 0n }), 'min');
  assert.throws(() => l.launchTx('0x1234', GOOD()), (e) => e.why === 'factory');
});

// ── T2 the encode is the truth the wallet will be asked to sign ───────
test('launchTx encodes the callable the wallet signs, args echo back', () => {
  const a = GOOD();
  const tx = l.launchTx(FAC, a);
  assert.equal(tx.to, FAC);
  const I = new realEthers.Interface(BEAR_FACTORY_ABI);
  const [meta, supply, fee, lock, seedQ, seedT, minShares] = I.decodeFunctionData('launch', tx.data);
  assert.deepEqual([...meta], ['B Meme', 'BM', '', '', '', '', ''], 'meta tuple: 7 strings in launch order');
  assert.equal(supply, a.totalSupply);
  assert.equal(fee, 30n);
  assert.equal(lock, 0n);
  assert.equal(seedQ, a.seedQuote);
  assert.equal(seedT, a.seedToken);
  assert.equal(minShares, a.minShares);
});

// ── T3 the auto floor: 1% band of sqrt(seedQ·seedT), never round up ────
test('seedMinShares floors the 1% band of sqrt(seedQ·seedT)', () => {
  assert.equal(l.seedMinShares(1000n, 8000n), 2799n); // floor(sqrt(8_000_000)·99/100)
  assert.equal(l.seedMinShares(1000n, 8000n, 100), 2799n);
  assert.equal(l.seedMinShares(1000n, 8000n, 0), 2828n, 'a 0 band returns the made value');
  assert.equal(l.seedMinShares(1n, 1n), 0n, 'dust seeds floor to 0 — the min guard refuses');
});

// ── T4 the receipt parser is the scanner's decoder, reused ────────────
test('launchFromReceipt decodes Launched off the receipt logs (shared decoder)', () => {
  const I = new realEthers.Interface(BEAR_FACTORY_ABI);
  const ev = I.encodeEventLog(I.getEvent('Launched'),
    [TOK, PAIR, FAC, 45n, 1893456000n, 10n ** 21n]);
  const row = l.launchFromReceipt([{ topics: ev.topics, data: ev.data }]);
  assert.equal(row.token, TOK.toLowerCase());
  assert.equal(row.pair, PAIR.toLowerCase());
  assert.equal(row.launcher, FAC.toLowerCase());
  assert.equal(row.creatorFeeBps, 45);
  assert.equal(row.lpShares, 10n ** 21n);
  assert.equal(l.launchFromReceipt([]), null);
  assert.equal(l.launchFromReceipt([{ topics: [], data: '0x' }]), null, 'a foreign log is ignored');
});

// ── T5 the token face reads the coin's own public strings ─────────────
test('tokenFace reads the 9 public getters and normalizes addresses', async () => {
  READS.clear();
  READS.set(TOK.toLowerCase(), {
    name: 'B Meme', symbol: 'BM', imageURI: 'https://i/b.png', description: 'deb',
    twitter: 'https://x.com/b', telegram: 'https://t.me/b', website: 'https://b.example',
    socialsSet: true, totalSupply: 10n ** 24n, quoteToken: FAKEQ,
  });
  const face = await l.tokenFace({}, TOK);
  assert.equal(face.name, 'B Meme');
  assert.equal(face.symbol, 'BM');
  assert.equal(face.image, 'https://i/b.png');
  assert.equal(face.desc, 'deb');
  assert.equal(face.twitter, 'https://x.com/b');
  assert.equal(face.telegram, 'https://t.me/b');
  assert.equal(face.website, 'https://b.example');
  assert.equal(face.socialsSet, true);
  assert.equal(face.totalSupply, 10n ** 24n);
  assert.equal(face.quote, FAKEQ.toLowerCase());
  await assert.rejects(() => l.tokenFace({}, '0xzz'), (e) => e.why === 'token');
});

// ── T6 pairOfToken reads the factory's pair registry ──────────────────
test('pairOfToken reads factory.pairOf and lowercases', async () => {
  READS.clear();
  READS.set(FAC.toLowerCase(), { pairOf: () => PAIR });
  assert.equal(await l.pairOfToken({}, FAC, TOK), PAIR.toLowerCase());
});

// ── T7 the launcher's memory: chain-scoped, deduped, capped ───────────
test('launch memory is chain-scoped, newest first, deduped, capped at 50', () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, val) => { store.set(k, String(val)); },
    removeItem: (k) => { store.delete(k); },
  };
  l.launchForget(1); l.launchForget(137);
  l.launchRemember(1, { token: '0xAa', pair: '0xBb', lpShares: 1n });
  l.launchRemember(137, { token: '0xCc', lpShares: 2n });
  l.launchRemember(1, { token: '0xDD', lpShares: 3n });
  l.launchRemember(1, { token: '0xaa', lpShares: 4n }); // same token: moved, not duplicated
  const one = l.launchRecall(1);
  assert.equal(one.length, 2, 'a reboot of the same token does not dupe');
  assert.equal(one[0].token, '0xaa');
  assert.equal(one[0].lpShares, '4', 'bigint shares flatten to JSON-safe strings');
  assert.equal(one[1].token, '0xdd');
  assert.equal(l.launchRecall(137).length, 1, 'chains do not leak into each other');
  assert.equal(l.launchRecall(999).length, 0);

  for (let i = 0; i < 60; i++) {
    l.launchRemember(1, { token: '0x' + String(i % 90 + 10).padStart(2, '0').repeat(20), lpShares: 5n });
  }
  assert.ok(l.launchRecall(1).length <= 50, 'the list is capped at 50');

  const first = l.launchRecall(1)[0].token;
  l.launchForget(1, first);
  assert.equal(l.launchRecall(1).some((r) => r.token === first), false);
  l.launchForget(1); l.launchForget(137);
  assert.equal(l.launchRecall(1).length, 0, 'forget() clears a whole chain');
});

// ── T8 the launch card stub: no emoji, no prefill, a11y labels ────────
test('launchStubHtml: labelled inputs, no emoji discard, no prefill', async () => {
  const v = await import('../js/dex/index.js');
  const stub = v.launchStubHtml();
  for (const id of ['dexLaunchName', 'dexLaunchSymbol', 'dexLaunchSupply', 'dexLaunchFee',
    'dexLaunchLock', 'dexLaunchSeedQ', 'dexLaunchSeedT', 'dexLaunchGo',
    'dexLaunchStatus', 'dexLaunchSaved', 'dexLaunchBody']) {
    assert.equal(stub.includes(`id="${id}"`), true, `stub needs #${id}`);
  }
  assert.match(stub, /<details/, 'socials collapse behind a details');
  assert.match(stub, /aria-label=/, 'every input is labelled for a screen reader');
  assert.doesNotMatch(stub, /[\u{1F300}-\u{1FAFF}]/u, 'no emoji in the chrome');
  assert.doesNotMatch(stub, /value="0x/, 'no prefill');

  // The three LP knobs are ONE labelled group ("LP was confusing, it should
  // be one thing with pools"): the seed pair IS the pool's opening liquidity
  // and the lock locks the shares it mints. Loose between the token fields
  // they read as unrelated dials — the group ties them to the Pools card.
  const group = stub.match(/<fieldset class="dex-lp-group">[\s\S]*?<\/fieldset>/);
  assert.ok(group, 'the opening-liquidity fields sit in one fieldset');
  for (const id of ['dexLaunchLock', 'dexLaunchSeedQ', 'dexLaunchSeedT']) {
    assert.equal(group[0].includes(`id="${id}"`), true, `#${id} is inside the LP group`);
  }
  assert.match(group[0], /<legend[^>]*>\$\{t\('dex\.launch\.lp\.h'\)\}|<legend[^>]*>[^<]+<\/legend>/,
    'the group carries a legend');
  // and the launch form is where the OTHER fields are NOT: the group must
  // not swallow name/symbol/supply/fee (those are token identity, not LP)
  for (const id of ['dexLaunchName', 'dexLaunchSymbol', 'dexLaunchSupply', 'dexLaunchFee']) {
    assert.equal(group[0].includes(`id="${id}"`), false, `#${id} is not an LP field`);
  }
  // both locales must speak the group — a bare key name on screen is the bug
  const i18nSrc = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8'));
  for (const key of ['dex.launch.lp.h', 'dex.launch.lp.hint']) {
    const hits = (i18nSrc.match(new RegExp(`'${key.replace(/\./g, '\\.')}':`, 'g')) || []).length;
    assert.equal(hits, 2, `${key} must exist in en AND id (found ${hits})`);
  }
  // the sheet builder keeps the number lines the user must read
  const sheet = v.sheetBodyLaunch({
    meta: { name: 'B Meme', symbol: 'BM' },
    totalSupply: 10n ** 24n, seedQuote: 100n, seedToken: 8n,
    creatorFeeBps: 12, lpLockUntil: 15n, minShares: 1n, quoteSymbol: 'USDC',
  });
  for (const needle of ['B Meme', '0.30%', '12']) {
    assert.equal(sheet.includes(needle), true, `sheet body mentions ${needle}`);
  }
});

// ── T9 renderDex wires the launch card; no factory → the status speaks ─
test('renderDex wires Launch; with no factory scan the card answers needfac', async () => {
  const v = await import('../js/dex/index.js');
  const stmod = await import('../js/state.js');
  const mkEl = () => ({
    _listeners: new Map(),
    addEventListener(type, fn) { this._listeners.set(type, fn); },
    removeEventListener(type) { this._listeners.delete(type); },
    click() { this._listeners.get('click')?.({}); },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: {}, dataset: {}, hidden: false, value: '', textContent: '', innerHTML: '',
    setAttribute() {}, getAttribute: () => null, appendChild() {}, removeChild() {},
    querySelector: () => null, querySelectorAll: () => [], focus() {}, blur() {},
    children: [], parentNode: null, remove() {},
  });
  const launchGo = mkEl();
  const launchStatus = mkEl();
  const launchSaved = mkEl();
  const idless = () => mkEl();
  const root = {
    _i: '',
    set innerHTML(v2) { this._i = v2; },
    get innerHTML() { return this._i; },
    querySelector(sel) {
      if (sel === '#dexLaunchGo') return launchGo;
      if (sel === '#dexLaunchStatus') return launchStatus;
      if (sel === '#dexLaunchSaved') return launchSaved;
      return null;
    },
    isConnected: true,
  };
  stmod.set('networkId', 'sepolia');
  const out = v.renderDex(root, {});
  assert.equal(out.chainOk, true);
  assert.ok(launchGo._listeners.has('click'), 'the Launch button is wired');

  // the saved list is painted from the launcher's memory (empty here, but it
  // must not throw — the store above was cleared by the memory test)
  assert.equal(launchSaved.innerHTML, '');

  // no factory anywhere → the card names the missing piece, never hangs
  launchGo.click();
  assert.match(launchStatus.textContent, /Pools|factory/i,
    `needfac speaks: ${launchStatus.textContent}`);
});
