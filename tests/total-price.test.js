// Total price (USD) di setiap dialog konfirmasi tx onchain — permintaan user
// 2026-10-06: "setiap deploy kontrak itu ga ada total price $ bikin user
// bingung" + "di setiap fitur tx onchain munculin total price usd ya".
//
// Dua lapis bukti:
//   1. perilaku totalPriceRow (ui.js) — jumlah, catatan '(excl. gas)',
//      '(USD ?)', totalNote, estimasi via provider, dan kejujuran saat
//      datanya tak terbaca (0 gas / tak ada yang diketahui → tanpa baris);
//   2. wiring — tiap fitur utama benar-benar meneruskan tx/spend/gas ke
//      confirmTx, bukan baris Total yang menggantung tanpa pemasok.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { totalPriceRow } from '../js/ui.js';
import { set } from '../js/state.js';

const rate = (usd) => set('tokens', [{ usd }, { address: '0xabc', usd: 1 }]);

test('spend + gas dikonversi ke $ dengan rate native', async () => {
  rate(2000);
  const row = await totalPriceRow({
    valueWei: 10n ** 18n,          // 1 ETH × $2000 = $2000
    gasWei: 21000n * 10n ** 9n,    // 21000 × 1 gwei = 0.000021 ETH × $2000 = $0.042
  });
  assert.equal(row.k, 'Total price');
  assert.equal(row.v, '≈ $2000.04');
});

test('spendUsd + gas → jumlah keduanya, tanpa catatan', async () => {
  rate(2000);
  const row = await totalPriceRow({ spendUsd: 10, gasWei: 10n ** 18n }); // gas 1 ETH = $2000
  assert.equal(row.v, '≈ $2010.00');
});

test('gas tak terbaca → tetap tampil dengan (excl. gas), bukan $0 palsu', async () => {
  rate(2000);
  const row = await totalPriceRow({ spendUsd: 5 });
  assert.equal(row.v, '≈ $5.00 (excl. gas)');
});

test('gas 0 bukan gas nyata → dianggap tak terbaca, bukan baris $0.00', async () => {
  rate(2000);
  const row = await totalPriceRow({ gasWei: 0n });
  assert.equal(row, null, 'tak ada yang diketahui → tanpa baris Total');
});

test('tanpa rate → bagian native ditampilkan apa adanya dengan (USD ?)', async () => {
  set('tokens', [{ address: '0xabc', usd: 1 }]); // native tanpa harga
  const row = await totalPriceRow({ valueWei: 12n * 10n ** 15n, gasWei: 21000n * 10n ** 9n });
  assert.equal(row.k, 'Total price');
  assert.match(row.v, /^\d/);
  assert.match(row.v, /gas .* ETH \(USD \?\)$/);
});

test('tanpa rate tapi ada spendUsd → $ + (excl. gas)', async () => {
  set('tokens', [{}]);
  const row = await totalPriceRow({ spendUsd: 3.5, gasWei: 10n ** 15n });
  assert.equal(row.v, '≈ $3.50 (excl. gas)');
});

test('totalNote menyusul angka $ (deploy upgradeable = tx 1 only)', async () => {
  rate(2000);
  const row = await totalPriceRow({ gasWei: 10n ** 18n, totalNote: 'tx 1 only' });
  assert.equal(row.v, '≈ $2000.00 (tx 1 only)');
});

test('tanpa tx/value/spend/gas sama sekali → null (dialog tanpa baris)', async () => {
  rate(2000);
  assert.equal(await totalPriceRow({}), null);
});

test('gas diestimasi dari tx via provider (fallback state), dengan rate', async () => {
  rate(2000);
  set('provider', {
    estimateGas: async () => 50000n,
    getFeeData: async () => ({ maxFeePerGas: 10n ** 9n }),
  });
  const row = await totalPriceRow({ tx: { to: '0xdead', value: 0n } });
  // 50000 × 1 gwei = 5e13 wei = 0.00005 ETH × $2000 = $0.10
  assert.equal(row.v, '≈ $0.10');
  set('provider', null);
});

// ── wiring: tiap fitur benar-benar memasok angkanya ──────────────────────
const read = (p) => fs.readFileSync(new URL(`../js/${p}`, import.meta.url), 'utf8');

test('deploy kontrak (fitur yang user keluhkan) → gasWei + valueWei + totalNote', () => {
  const src = read('deploy.js');
  assert.match(src, /gasWei: cost/, 'biaya gas yang sudah dihitung dijadikan angka $');
  assert.match(src, /valueWei: 0/, 'contract creation tak memindahkan value');
  assert.match(src, /totalNote: upg \? 'tx 1 only' : null/,
    'upgradeable jujur: total hanyalah tx 1');
});

test('send → spendUsd (amount × harga token) + gasWei (formula preview yang sama)', () => {
  const src = read('send.js');
  assert.match(src, /spendUsd: signSpendUsd/);
  assert.match(src, /gasWei: signGasWei/);
  assert.match(src, /\(t\.address \? 65000n : 21000n\) \* \(worst\.maxFeePerGas \?\? worst\.baseFee\)/,
    'gas send memakai limit & fee yang sama dengan baris Est. gas preview');
});

test('swap → spendUsd dari amount × harga token from', () => {
  const src = read('swap.js');
  assert.match(src, /spendUsd: swapSpendUsd/);
  assert.match(src, /parseFloat\(amt\) \* Number\(fromTok\.usd\)/);
});

test('bridge → tx quote-bound (estimasi gas) + spendUsd amount × harga token', () => {
  const src = read('bridge.js');
  assert.match(src, /tx: \{ to: boundTx\.to, data: boundTx\.data, value: boundTx\.value \}/);
  assert.match(src, /spendUsd: bridgeSpendUsd/);
});

test('revoke approval → calldata approve(spender,0) yang akan dikirim diestimasi', () => {
  const src = read('app.js');
  assert.match(src, /0x095ea7b3\$\{String\(a\.spender\)/,
    'selector 0x095ea7b3 = approve(address,uint256), spender di-pad 32 byte');
  assert.match(src, /method === 'eth_sendTransaction' && Array\.isArray\(params\) && params\[0\]/,
    'prompt tx dari dapp menaksir tx objek milik request');
});

test('confirmTx meneruskan kunci uang ke totalPriceRow sebelum modal terbuka', () => {
  const src = read('ui.js');
  assert.match(src, /export async function totalPriceRow/);
  assert.match(src, /export async function confirmTx\(\{ title, rows,.*\.\.\.money \}\)/);
  assert.match(src, /await totalPriceRow\(money\)/);
});
