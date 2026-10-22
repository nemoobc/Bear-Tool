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
  assert.match(src, /\(tkn\.address \? 65000n : 21000n\) \* \(worst\.maxFeePerGas \?\? worst\.baseFee\)/,
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

test('prompt tx dari dapp menaksir tx objek milik request (bukan string)', () => {
  const src = read('app.js');
  // The revoke path that used to be pinned here (calldata approve(spender,0)
  // estimated before the modal) left with the Approval Manager (M3). What
  // stays is the estimation contract for anything a dapp asks the wallet to
  // send — the shape the price row depends on.
  assert.match(src, /method === 'eth_sendTransaction' && Array\.isArray\(params\) && params\[0\]/,
    'prompt tx dari dapp menaksir tx objek milik request');
});

test('confirmTx meneruskan kunci uang ke totalPriceRow sebelum modal terbuka', () => {
  const src = read('ui.js');
  assert.match(src, /export async function totalPriceRow/);
  assert.match(src, /export async function confirmTx\(\{ title, rows,.*\.\.\.money \}\)/);
  assert.match(src, /await totalPriceRow\(money\)/);
});

// ── the 7702 flows: every sheet that authorizes a transaction carries its
// price (user report 2026-10-20: "di fitur rescue ga ada ask tx gas fee
// total usd" — the rescue sheet showed no fee and no total). The other
// Tools flows had the same hole and are pinned here too.
test('rescue → gasWei (diukur) + valueWei 0 + catatan total', () => {
  const src = read('eip7702-tools.js');
  assert.match(src, /gasWei: fee\.feeWei/, 'the rescue sheet must carry the measured fee');
  assert.match(src, /valueWei: 0n/, 'a rescue moves no native value — only tokens');
  assert.match(src, /totalNote: feeNotes\.join\(' · '\)/);
  assert.match(src, /cf\.est\.fee\.max/, 'a number that is a bound must say so');
});

test('claim → gasWei + valueWei 0', () => {
  const src = read('eip7702-tools.js');
  assert.match(src, /gasWei: claimFee\.feeWei/, 'the claim sheet must carry the measured fee');
  assert.match(src, /valueWei: 0n/);
});

test('revoke → gasWei (revoke does no work, but it is still a transaction)', () => {
  const src = read('eip7702-tools.js');
  assert.match(src, /gasWei: revokeFee\.feeWei/, 'the revoke sheet must carry the fee');
});

test('batch → valueWei (native yang dipindahkan user = uang dia)', () => {
  const src = read('eip7702-tools.js');
  assert.match(src, /valueWei: totalValue/, 'the batch sheet must carry the value it moves');
});

test('the fee is measured on the node, never invented', () => {
  const fee = read('rescue-fee.js');
  const tools = read('eip7702-tools.js');
  assert.match(fee, /measureSweepGas/, 'the measurement lives in one module');
  assert.match(tools, /quote7702Fee\(/, 'the flows share that one measurement');
  assert.match(fee, /SWEEP_DELEGATION_MIN_EXTRA/,
    'a skipped delegation tuple must be distinguishable from a priced one');
  // A price the node could not give is never dressed up as a measurement.
  assert.match(tools, /fee\.measured \? t\('cf\.est\.fee'\) : t\('cf\.est\.fee\.max'\)/);
});

// ── kejujuran sub-cent + pemisah baris (temuan screenshot emulator 2026-10-22) ──

test('biaya sub-cent tidak dibulatkan jadi $0.00 — "< $0.01" yang jujur', async () => {
  // Emulator e288a9c: gas 0.0286 POL dengan POL di bawah ~$0.17 menghasilkan
  // $0.004 → toFixed(2) menyajikannya "≈ $0.00", biaya nyata yang terbaca
  // gratis. Angka yang sama dengan tampilan lama dipakai di sini.
  rate(0.15);
  const row = await totalPriceRow({ gasWei: 28612622512028232n }); // 0.0286 POL ≈ $0.0043
  assert.equal(row.v, '≈ < $0.01', 'sub-cent keeps its magnitude, never a confident $0.00');
});
// The layout gates for the same sheet (gap between label and value) live in
// tests/sheet-layout.test.js — one home per concern.

