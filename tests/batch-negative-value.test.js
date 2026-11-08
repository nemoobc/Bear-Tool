// Bear Tool — batch-negative-value.test.js
//
// ethers v6 parseEther ACCEPTS negatives: "-1" → -1000000000000000000n.
// executeBatch used to sum the rows with it and only asked "total > 0n",
// so a negative row:
//   - CANCELLED other rows' value in the total — [10, -10] totals 0n, the
//     confirm dialog printed "0 ETH" while a 10 ETH call rode along;
//   - could hide inside a positive total ([5, -3] showed "2.0 ETH");
//   - sailed past the balance guard (totalValue > 0n was false for 0n);
//   - then threw at encodeFunctionData — uint256 out-of-range — AFTER the
//     helper deploy had already been paid for when one was needed.
// The EVM has no negative call value. sumBatchValues (exported so this gate
// can call it) rejects any negative row with its row number.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// eip7702-tools destructures `const { ethers } = globalThis` at module scope,
// so the namespace must exist BEFORE the import (swap-approve-revert pattern).
const { ethers } = await import('ethers');
globalThis.ethers = ethers;
const { sumBatchValues } = await import('../js/eip7702-tools.js');

const G = 10n ** 18n;

test('a negative value anywhere is refused with its row number', () => {
  assert.throws(
    () => sumBatchValues(['10', '-10']),
    (e) => e.negative === true && e.row === 2 && /call #2/.test(e.message),
    '[10, -10] must never total to 0n — the dialog would say "0 ETH"'
  );
  assert.throws(
    () => sumBatchValues(['-0.5']),
    (e) => e.negative === true && e.row === 1
  );
  // Negatives that would hide inside a positive total are caught too.
  assert.throws(
    () => sumBatchValues(['5', '0', '-3']),
    (e) => e.negative === true && e.row === 3
  );
});

test('valid rows still total exactly (regression)', () => {
  assert.equal(sumBatchValues(['1', '0.5']), 15n * G / 10n);
  assert.equal(sumBatchValues([]), 0n);
  // Value-only rows (empty data, empty value) are legal — they read as 0.
  assert.equal(sumBatchValues(['', undefined, '0']), 0n);
});

test('a malformed value names its row (existing behaviour kept)', () => {
  assert.throws(
    () => sumBatchValues(['1', '1e18']),
    (e) => e.row === 2 && /Invalid ETH value in call #2/.test(e.message)
  );
});

test('executeBatch routes its value guard through sumBatchValues', () => {
  // Source gate: the guard lives in the exported, tested function — an
  // inline `parseEther` loop here would mean the policy drifted back out
  // of reach of this test.
  const src = fs.readFileSync(new URL('../js/eip7702-tools.js', import.meta.url), 'utf8');
  assert.match(src, /sumBatchValues\(valid\.map\(b => b\.value\)\)/,
    'executeBatch must sum through the tested helper');
  assert.doesNotMatch(src, /totalValue \+= ethers\.parseEther/,
    'the unguarded inline parse loop must not come back');
});
