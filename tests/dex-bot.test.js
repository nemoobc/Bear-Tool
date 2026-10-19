// Bear Tool — tests/dex-bot.test.js
// M6: the market maker's whole brain and its address factory, plus the feed's
// tombstone rule. The ENGINE and WALLETS are pure — every awkward case is
// exercised with no chain, no browser, and no coin. The bot module's own
// reads (readBand) run against the same FakeContract harness the launch tests
// use, so the price the bot plans with is the price the POOL returns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers as realEthers } from 'ethers';

// ── harness ───────────────────────────────────────────────────────────
const SEED_STORE = new Map();
globalThis.localStorage = {
  getItem: (k) => (SEED_STORE.has(k) ? SEED_STORE.get(k) : null),
  setItem: (k, v) => { SEED_STORE.set(k, String(v)); },
  removeItem: (k) => { SEED_STORE.delete(k); },
};

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
globalThis.ethers = Object.assign({}, realEthers, { Contract: FakeContract });

const e = await import('../js/dex/bot-engine.js');
const w = await import('../js/dex/bot-wallets.js');
const b = await import('../js/dex/bot.js');
const tk = await import('../js/dex/tokens.js');
const ls = await import('../js/dex/list.js');

const PRICE = 10n ** 18n; // 1.0 quote per token

// ── T1 the decide() contract: band, budget, wallets ───────────────────
test('decide: buy below floor, sell above ceil, hold in band, nothing trades inside', () => {
  const base = { price: PRICE, floor: PRICE * 9n / 10n, ceil: PRICE * 11n / 10n, size: 10n ** 16n };
  let d = e.decide({ ...base, price: PRICE * 89n / 100n, quoteBal: 10n ** 18n });
  assert.deepEqual([d.action, d.why], [e.BUY, e.WHY.BELOW_FLOOR]);
  d = e.decide({ ...base, price: PRICE * 111n / 100n, tokenBal: 10n ** 18n });
  assert.deepEqual([d.action, d.why], [e.SELL, e.WHY.ABOVE_CEILING]);
  d = e.decide(base);
  assert.deepEqual([d.action, d.why], [e.HOLD, e.WHY.IN_BAND]);
});

test('decide: guards before trades — inverted band, budget cap, empty wallet', () => {
  const base = { price: PRICE, floor: PRICE * 9n / 10n, ceil: PRICE * 11n / 10n, size: 10n ** 16n };
  let d = e.decide({ ...base, floor: base.ceil, ceil: base.floor });
  assert.deepEqual([d.action, d.why], [e.HOLD, e.WHY.BAND_TOUCHED]);
  d = e.decide({ ...base, price: base.floor, quoteBal: 10n ** 18n, spent: 10n ** 18n, cap: 10n ** 18n });
  assert.deepEqual([d.action, d.why, d.amount], [e.STOP, e.WHY.NO_BUDGET, 0n], 'the cap counts the NEXT spend, not the past');
  d = e.decide({ ...base, price: base.floor, quoteBal: 0n });
  assert.deepEqual([d.action, d.why], [e.STOP, e.WHY.NO_WALLET]);
  d = e.decide({ ...base, price: base.ceil, tokenBal: 0n });
  assert.deepEqual([d.action, d.why], [e.STOP, e.WHY.NOTHING_TO_SELL]);
});

test('decide: the buy leg spends quote, the sell leg gives tokens — per-side sizes', () => {
  const base = { price: PRICE, floor: PRICE * 9n / 10n, ceil: PRICE * 11n / 10n };
  // a sell costs nothing from the quote budget (sellSize notes of cap)
  let d = e.decide({ ...base, price: base.ceil, tokenBal: 10n ** 18n, spent: 10n ** 18n, cap: 10n ** 18n });
  assert.equal(d.action, e.SELL, 'a sell with no budget left still unwinds what was bought');
  // per-side overrides are respected: sizeIn buys 1 quote, sizeOut sells 2 tokens
  d = e.decide({ ...base, price: base.floor, quoteBal: 10n ** 18n, sizeIn: 10n ** 18n, sizeOut: 2n * 10n ** 18n });
  assert.equal(d.amount, 10n ** 18n);
  d = e.decide({ ...base, price: base.ceil, tokenBal: 3n * 10n ** 18n, sizeIn: 10n ** 18n, sizeOut: 2n * 10n ** 18n });
  assert.equal(d.amount, 2n * 10n ** 18n);
});

// ── T2 the wallet picker ──────────────────────────────────────────────
test('nextAccount: rotation skips empty wallets, cursor advances past the pick', () => {
  const accs = [
    { index: 5, address: '0xa', quoteBal: 0n, tokenBal: 10n ** 18n },
    { index: 6, address: '0xb', quoteBal: 10n ** 18n, tokenBal: 1n },
    { index: 7, address: '0xc', quoteBal: 10n ** 18n, tokenBal: 0n },
  ];
  const buy = e.nextAccount(accs, e.BUY, 5n * 10n ** 17n, 0);
  assert.equal(buy.account.address, '0xb', 'an empty wallet is not asked to pay');
  assert.equal(buy.cursor, 2, 'the cursor passes the picker');
  const sell = e.nextAccount(accs, e.SELL, 5n * 10n ** 17n, buy.cursor);
  assert.equal(sell.account.address, '0xa', 'rotation spreads the load rather than hammering one wallet');
  const none = e.nextAccount(accs, e.BUY, 10n ** 30n, 0);
  assert.equal(none.account, null, 'nobody can afford it → nobody is picked');
  const empty = e.nextAccount([], e.BUY, 1n, 0);
  assert.equal(empty.account, null);
});

// ── T3 budget + band helpers ──────────────────────────────────────────
test('budgetBps and bandUsable keep their edges honest', () => {
  assert.equal(e.budgetBps(0n, 10n ** 18n), 0n);
  assert.equal(e.budgetBps(5n * 10n ** 17n, 10n ** 18n), 5000n);
  assert.equal(e.budgetBps(10n ** 20n, 10n ** 18n), 10_000n, 'over-spend clamps, never negative');
  assert.equal(e.budgetBps(1n, 0n), 0n, 'no cap → no bar — a number, not a throw');
  assert.equal(e.bandUsable(10n ** 17n, 10n ** 18n), true);
  assert.equal(e.bandUsable(0n, 1n), false);
  assert.equal(e.bandUsable(2n, 1n), false, 'floor above ceil is not a band');
});

test('stopReason names only the durable stops', () => {
  assert.equal(e.stopReason(e.WHY.NO_BUDGET), 'budget');
  assert.equal(e.stopReason(e.WHY.NO_WALLET), 'noWallet');
  assert.equal(e.stopReason(e.WHY.NOTHING_TO_SELL), 'nothingToSell');
  assert.equal(e.stopReason(e.WHY.BAND_TOUCHED), 'bandTouched');
  assert.equal(e.stopReason(e.WHY.IN_BAND), null, 'a HOLD is not a stop');
});

// ── T4 the wallets: derived, never colliding, split floor, gas pad ────
test('bot wallets: a seed derives exclusive addresses, an import refuses', async () => {
  assert.equal(w.canDerive('word '.repeat(12).trim()), true);
  assert.equal(w.canDerive('word word word'), false, 'a private key has ONE address — the panel says so');
  assert.equal(w.canDerive(null), false);

  const start = w.botStartIndex([{ path: "m/44'/60'/0'/0/3" }]);
  assert.equal(start, 4, 'the bot starts past the accounts you manage by hand');
  assert.equal(w.botStartIndex([]), 0);

const SEED_BIP39 = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const seed = SEED_BIP39;
  const taken = ['0x' + '11'.repeat(20)];
  const wk = w.deriveBotWallets(seed, 20, 2, taken);
  assert.equal(wk.length, 2);
  assert.ok(wk[0].address.startsWith('0x'));
  assert.ok(wk[0].path.endsWith('/20'));
  assert.notEqual(wk[0].address.toLowerCase(), taken[0]);
  assert.notEqual(wk[0].address, wk[1].address, 'the two derived wallets never meet');
  try { w.deriveBotWallets('word', 20, 2, []); assert.fail('a private-key-like secret must refuse'); }
  catch (er) { assert.equal(er.message, 'seedRequired'); }
});

test('splitBudget: floor-split with the remainder parked in wallet 0', () => {
  const shares = w.splitBudget(1005n, 2n, 0n);
  assert.equal(shares[0] + shares[1], 1005n, 'nothing is lost, the remainder stays in wallet 0');
  assert.ok(shares.every((s) => s >= 0n));
  assert.deepEqual(w.splitBudget(10n, 0n), []);
  const padded = w.splitBudget(1000n, 3n, 100n); // gasPad: each trades 233, the pad rides in wallet 0
  assert.equal(padded.reduce((a, b) => a + b, 0n), 1000n, 'every funded wei still lands in a wallet');
  assert.equal(padded[0], 534n, 'wallet 0 holds its 233 plus the 300 gas pad + 1 remainder — the reporter wallet');
  assert.deepEqual([...padded.slice(1)], [233n, 233n]);
});

test('tradeableWallets: a wallet that cannot trade is never picked', () => {
  const wallets = [{ address: '0xa' }, { address: '0xb' }];
  const balances = { '0xa': { quote: 10n ** 18n, token: 0n }, '0xb': { quote: 0n, token: 0n } };
  const ok = w.tradeableWallets(wallets, balances, 10n ** 17n, 10n ** 17n);
  assert.deepEqual(ok.map((x) => x.address), ['0xa']);
});

// ── T5 the bot's own read: the price comes from the POOL ──────────────
test('readBand reads reserves() and scales the price 1e18', async () => {
  READS.clear();
  const PAIR = '0x' + '06'.repeat(20);
  READS.set(PAIR, { reserves: [2000n * 10n ** 18n, 1000n * 10n ** 18n] }); // 2000K : 1000T — price 2.0
  const band = await b.readBand({}, PAIR);
  assert.equal(band.price, 2n * 10n ** 18n);
  assert.equal(band.quoteRes, 2000n * 10n ** 18n);
  assert.equal(band.tokenRes, 1000n * 10n ** 18n);
  await assert.rejects(() => b.readBand({}, '0xzz'), (er) => er.why === 'bad');
  READS.set(PAIR, { reserves: [2000n * 10n ** 18n, 0n] });
  await assert.rejects(() => b.readBand({}, PAIR), (er) => er.why === 'empty', 'an empty pool prices nothing');
});

// ── T6 the feed: live price of a pool + tombstones that stay dead ─────
test('feed: price from reserves, row paints the door and the delete, empty says nothing', () => {
  const st = { token: { address: '0x' + '05'.repeat(20), symbol: 'BM', name: 'B Meme' }, reserves: [2000n * 10n ** 18n, 1000n * 10n ** 18n] };
  assert.equal(tk.feedPrice(st), 2);
  const PAIR = '0x' + '06'.repeat(20);
  const row = tk.feedRowHtml(st, PAIR);
  assert.match(row, /data-dex-feed-open="0x06/);
  assert.match(row, /data-dex-feed-del="0x06/);
  assert.match(row, /aria-label=/, 'the delete door is named for a screen reader');
  assert.match(row, /BM/);
 READS.set(PAIR, { reserves: [1n, 0n] });
  assert.equal(tk.feedPrice({ ...st, reserves: [10n, 0n] }), null, 'a dead reserve prices nothing');
  const empty = tk.feedHtml(undefined);
  assert.match(empty, /dex-t-hint/);
});

test('tombstone: delete per chain, scans cannot resurrect it, address junk ignored', () => {
  SEED_STORE.clear();
  const TOK = '0x' + '05'.repeat(20);
  ls.rememberDeleted(11155111, TOK);
  ls.rememberDeleted(11155111, '0xZZ');                     // address junk — refused
  ls.rememberDeleted(11155111, 'draft');                     // not an address — refused
  ls.rememberDeleted(11155111, TOK);                         // a second delete is idempotent
  assert.deepEqual(ls.deletedList(11155111), [TOK], 'storage only ever holds addresses');
  assert.equal(ls.deletedList(1).length, 0, 'chains do not leak — Sepolia deletion does not touch another chain');
  const rows = [
    { pair: '0x' + '01'.repeat(20), token: TOK },
    { pair: '0x' + '02'.repeat(20), token: '0x' + '07'.repeat(20) },
  ];
  const live = ls.withoutDeleted(rows, 11155111);
  assert.deepEqual(live.map((r) => r.pair), ['0x' + '02'.repeat(20)], 'the deleted coin does not come back');
});
