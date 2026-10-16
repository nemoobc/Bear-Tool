// tests/dex-bot-pool.test.js
// The market maker moved off the retired curve (DEX-V2 M5c): it trades the
// POOL now, on the v2 token page the feed actually opens for a launched coin.
// The engine's own rules stay pinned in dex-bot.test.js — these gates pin the
// wiring between the panel, the pool engine and the two pages, which is where
// a broken link can stay green forever.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('the bot trades the pool, not the curve', () => {
  const bot = read('../js/dex/bot.js');
  assert.match(bot, /from '\.\/pool-data\.js';/,
    'reserves dibaca dari pool-data — seam yang sama dengan halaman token');
  assert.match(bot, /from '\.\/swap\.js';/,
    'quote + tx dari swap.js — mesin yang sama dengan sheet manual');
  assert.match(bot, /swapQuote\(\{ quoteReserve, tokenReserve, direction: 'buy'/,
    'buy memakai quote pool (getAmountOut yang sama dengan kontrak)');
  assert.match(bot, /swapTx\(\{ pair: cur\.pair, direction: 'buy'/,
    'tx buy = swapQuoteForToken di pair');
  assert.match(bot, /swapTx\(\{ pair: cur\.pair, direction: 'sell'/,
    'tx sell = swapTokenForQuote di pair');
  assert.match(bot, /ensureAllowanceTx\(\{ token: cur\.quoteAddr, spender: cur\.pair/,
    'allowance quote → pair untuk buy');
  assert.match(bot, /ensureAllowanceTx\(\{ token: cur\.address, spender: cur\.pair/,
    'allowance token → pair untuk sell');
  assert.ok(!/PUMP_ABI|quoteBuy|quoteSell|readCurve/.test(bot),
    'jalur curve lama sudah tidak dipakai bot — satu mesin, bukan dua');
});

test('the bot funds gas too — quote alone cannot send a transaction', () => {
  const bot = read('../js/dex/bot.js');
  assert.match(bot, /masterC\.sendTransaction\(\{ to: wallets\[i\]\.address, value: gasDrip \}\)/,
    'gas drip native ke tiap address — tanpa ETH, approve/swap dari address turunan selalu gagal');
  assert.match(bot, /const masterC = master\.connect\(net\)/,
    'signer keystore tanpa provider = "missing provider" — disambungkan dulu');
  assert.match(bot, /masterC\.getAddress\(\)/);
  const i18n = read('../js/i18n.js');
  assert.equal((i18n.match(/'dex\.bot\.fundingGas':/g) || []).length, 2, 'kunci fundingGas EN+ID');
  assert.equal((i18n.match(/'dex\.bot\.gasRow':/g) || []).length, 2, 'baris gas di sheet konfirmasi EN+ID');
});

test('the panel is mounted on the v2 token page — the page the feed opens', () => {
  const tp = read('../js/dex/token-page.js');
  assert.match(tp, /import \{ botHtml, bindBot \} from '\.\/bot\.js';/);
  assert.match(tp, /\$\{botHtml\(\)\}/, 'panel dirender di halaman coin');
  assert.match(tp, /bindBot\(host, \{ address: token, pair, quote: ps\.quote, qSym, qd, td, symbol: sym \}\)/,
    'bind dengan konteks pool penuh — quote decimals ikut, bukan asumsi 18');
  const trade = read('../js/dex/trade.js');
  assert.ok(!/botHtml|bindBot/.test(trade),
    'halaman legacy tidak lagi memuat bot (pindah, bukan diduplikasi)');
});

test('the bot uses the quote decimals the page read, never a hardcoded 18', () => {
  const bot = read('../js/dex/bot.js');
  assert.match(bot, /E\.parseUnits\(String\(cfg\.size \|\| '0'\), qd\)/, 'size di-parse dengan qd');
  assert.match(bot, /E\.parseUnits\(String\(cfg\.budget \|\| '0'\), qd\)/, 'budget di-parse dengan qd');
  assert.match(bot, /fmtTok\(s\.spent, qd, 4\)/, 'meter memakai qd');
  assert.match(bot, /fmtTok\(budgetWei, qd, 4\)/, 'sheet konfirmasi memakai qd + simbol quote');
});
