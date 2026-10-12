// tests/non-evm-send.test.js — the non-EVM Send screen.
//
// Two halves, matching what can actually be checked without a browser:
//   • the pure amount maths, imported and run;
//   • the wiring, read as text — that a signature is never produced before the
//     user confirms, that the key comes from the ACTIVE account, that broadcast
//     goes through the allowlisted RPC module, and that the EVM form is hidden
//     rather than destroyed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ethers } from 'ethers';

globalThis.ethers = ethers;
const mod = await import('../js/non-evm-send.js');
const send = readFileSync(new URL('../js/non-evm-send.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');

// ── amount maths ────────────────────────────────────────────────────────

test('toSmallest converts a decimal string exactly, with no floating point', () => {
  assert.equal(mod.toSmallest('1', 8), 100000000n);
  assert.equal(mod.toSmallest('0.00000001', 8), 1n);
  assert.equal(mod.toSmallest('2.5', 9), 2500000000n);
  assert.equal(mod.toSmallest('240', 6), 240000000n);
  assert.equal(mod.toSmallest('.5', 6), 500000n);
  // the classic float trap: 0.1 + 0.2 in Number is not 0.3
  assert.equal(mod.toSmallest('0.1', 8) + mod.toSmallest('0.2', 8), mod.toSmallest('0.3', 8));
});

test('toSmallest refuses too many decimals, zero and junk', () => {
  assert.throws(() => mod.toSmallest('0.000000001', 8), /8 decimal places/);
  assert.throws(() => mod.toSmallest('0', 8), /greater than zero/);
  assert.throws(() => mod.toSmallest('abc', 8), /Enter an amount/);
  assert.throws(() => mod.toSmallest('', 8), /Enter an amount/);
  assert.throws(() => mod.toSmallest('.', 8), /Enter an amount/);
});

test('fromSmallest is the inverse and trims trailing zeros', () => {
  assert.equal(mod.fromSmallest(100000000n, 8), '1');
  assert.equal(mod.fromSmallest(1n, 8), '0.00000001');
  assert.equal(mod.fromSmallest(2500000000n, 9), '2.5');
  assert.equal(mod.fromSmallest(0n, 6), '0');
});

// ── wiring: the panel replaces the EVM form without destroying it ───────

test('the EVM send card is hidden, never removed', () => {
  assert.match(send, /evmCard\.style\.display = 'none'/);
  assert.match(send, /evmCard\.style\.display = ''/);
  assert.doesNotMatch(send, /\.remove\(\)/);
});

test('the address book (an EVM-shaped 0x… form) is hidden on a non-EVM send', () => {
  assert.match(send, /querySelector\('#addressBookAccordion'\)/);
});

test('refreshView routes Send to the non-EVM panel for a non-EVM network', () => {
  const start = app.indexOf("if (view === 'send')");
  const body = app.slice(start, start + 520);
  assert.match(body, /isNonEvmNetwork\(sendNet\)/);
  assert.match(body, /loadNonEvmSend\(sendNet\)/);
  assert.match(body, /unloadNonEvmSend\(\)/);
  assert.match(body, /loadSendTokens\(\)/);
});

test('the non-EVM home does not add a second Send/Receive pair', () => {
  // The quick-action bar already offers Send and Receive, and they speak the
  // active chain. renderNonEvmHome used to paint "Send BTC" and "Receive BTC"
  // right below them, so the home screen showed FOUR buttons for TWO actions —
  // and a user could not tell which pair was the real one. The panel now says
  // to use the ones above instead.
  const home = app.slice(app.indexOf('function renderNonEvmHome('), app.indexOf('async function loadDashboard'));
  assert.doesNotMatch(home, /nonEvmSendBtn2/, 'tombol Send duplikat dihapus dari panel non-EVM');
  assert.doesNotMatch(home, /nonEvmReceiveBtn/, 'tombol Receive duplikat dihapus dari panel non-EVM');
  assert.doesNotMatch(home, /<button[^>]*>\s*Send\s*\$\{escapeHtml\(net\.symbol\)/,
    'tidak boleh ada tombol Send berlabel simbol jaringan di panel ini');
  // and the note must actually point at them, or the panel just looks empty
  assert.match(home, /Use <b>Send<\/b> and <b>Receive<\/b> above/,
    'panel harus mengarahkan user ke tombol yang sudah ada');
});

test('Send and Receive on the non-EVM home are the quick actions, wired once', () => {
  // The pair the note points at has to be real and bound: Send goes through
  // data-view="send", Receive through #quickReceive. Both are in the static
  // dashboard, so they exist on every network and there is nothing to paint.
  const dash = readFileSync(new URL('../src/views/dashboard.jsx', import.meta.url), 'utf8');
  assert.match(dash, /data-view="send"/, 'quick-action Send hilang dari dashboard');
  assert.match(dash, /id="quickReceive"/, 'quick-action Receive hilang dari dashboard');
  assert.match(app, /\$\('#quickReceive'\)\?\.addEventListener\('click'/,
    'quickReceive tak ter-bound — panel menunjuk ke tombol yang tak jalan');
});

// ── wiring: confirm before signing, key from the active account ─────────

test('every chain confirms with the real numbers BEFORE it builds or signs', () => {
  for (const fn of ['sendBitcoin', 'sendSolana', 'sendXrp']) {
    const start = send.indexOf(`async function ${fn}(`);
    assert.ok(start > -1, `${fn} harus ada`);
    const body = send.slice(start, send.indexOf('\nasync function', start + 10) === -1 ? undefined : send.indexOf('\nasync function', start + 10));
    const confirmAt = body.indexOf('await confirmTx(');
    // the earliest signing/broadcast call in the same function
    const signAt = Math.min(
      ...['buildBtcSend', 'buildSolSend', 'buildSignedXrp', 'btcBroadcast', 'solSendTransaction', 'xrpSubmit']
        .map((needle) => { const i = body.indexOf(needle); return i === -1 ? Infinity : i; }),
    );
    assert.ok(confirmAt > -1, `${fn} harus memakai confirmTx`);
    assert.ok(confirmAt < signAt, `${fn}: konfirmasi HARUS mendahului penandatanganan/pengiriman`);
    assert.match(body, /if \(!ok\) return;/, `${fn}: batal berarti tidak jadi mengirim`);
  }
});

test('the signing key is derived from the ACTIVE account and the unlocked session', () => {
  assert.match(send, /wallet\.getSession\(\)/);
  assert.match(send, /wallet\.getActiveAccountIndex\(\)/);
  for (const kp of ['btcKeypair(', 'solanaKeypair(', 'xrpKeypair(']) {
    assert.ok(send.includes(kp), `harus menurunkan kunci dengan ${kp}`);
  }
  assert.match(send, /Unlock the wallet to send/);
});

test('the address the wallet signs for is checked to be ours (no silent foreign account)', () => {
  // BTC: change must return to our own P2WPKH; SOL/XRP: builders refuse a
  // foreign account. The panel must pass OUR address as that check's input.
  assert.match(send, /changeAddress: key\.nativeSegwit/);
  assert.match(send, /account: key\.classic/);
  assert.match(send, /from: key\.address/);
});

// ── wiring: broadcast only through the allowlisted RPC module ──────────

test('no raw fetch and no arbitrary URL in the send screen — only non-evm-rpc', () => {
  assert.doesNotMatch(send, /\bfetch\(/, 'tidak ada fetch langsung');
  assert.doesNotMatch(send, /https?:\/\/(?!s?1\.ripple)/, 'tidak ada URL jaringan yang ditulis tangan');
  assert.match(send, /import \* as rpc from '\.\/non-evm-rpc\.js'/);
  for (const call of ['rpc.btcUtxos', 'rpc.btcBroadcast', 'rpc.solSendTransaction', 'rpc.xrpSubmit', 'rpc.solLatestBlockhash']) {
    assert.ok(send.includes(call), `harus lewat ${call}`);
  }
});

test('the destination is validated by the chain module, not by a regex here', () => {
  assert.match(send, /btc\.decodeBtcAddress\(/);
  assert.match(send, /sol\.decodeSolAddress\(/);
  assert.match(send, /xrp\.decodeXrpAddress\(/);
});

// ── wiring: amounts that cannot pay for themselves are refused ─────────

test('MAX subtracts the fee instead of offering the whole balance', () => {
  assert.match(send, /spendableAmount/);
  assert.match(send, /snapshot\.lamports - sol\.SOL_BASE_FEE/);
  assert.match(send, /total - feeNoChange/, 'BTC MAX menyisakan fee output-tunggal');
  assert.match(send, /reserve/, 'XRP menyisakan account reserve');
});

test('the XRP reserve is read from the ledger, not a hardcoded 10 XRP', () => {
  // A hardcoded 10 XRP reserve once withheld 9 XRP of the user's own funds from
  // MAX, and left the manual path free to submit a payment the ledger would
  // reject (tecUNFUNDED_PAYMENT). Both now go through the ledger-read reserve.
  assert.match(send, /rpc\.xrpReserveDrops\(/);
  assert.doesNotMatch(send, /10000000n/, 'no hardcoded 10 XRP reserve');
  assert.match(
    send,
    /BigInt\(info\.balanceDrops\) < amountDrops \+ fee \+ reserve/,
    'sendXrp must refuse an amount that breaks the reserve before it signs',
  );
});

// ── the fee the confirm sheet shows is the fee the chain pays ───────────

test('btcSendFee: change kept → the two-output price, exactly', () => {
  const r = mod.btcSendFee({ total: 100000n, amountSat: 50000n, rate: 5, nIn: 1 });
  assert.equal(r.withChange, true);
  assert.equal(r.fee, BigInt(Math.ceil(r.vsize * 5)));
  assert.equal(r.fee, 700n);
});

test('btcSendFee: change below dust → the whole remainder becomes the fee', () => {
  // 100000 - 99000 = 1000 sat is the real fee once the change output is dropped.
  const r = mod.btcSendFee({ total: 100000n, amountSat: 99000n, rate: 5, nIn: 1 });
  assert.equal(r.withChange, false);
  assert.equal(r.fee, 1000n, 'fee == total - amount, not the one-output estimate');
  assert.equal(r.fee, 100000n - 99000n);
});

test('btcSendFee refuses an amount too small to pay a relayable fee', () => {
  assert.throws(() => mod.btcSendFee({ total: 100000n, amountSat: 100000n, rate: 5, nIn: 1 }), /Not enough|too little/);
  assert.throws(() => mod.btcSendFee({ total: 100000n, amountSat: 99000n, rate: 20, nIn: 1 }), /too little/);
});

// ── the history row must carry a human string, not an object ────────────

test('a non-EVM history row records a readable destination, never an object', () => {
  // app.js renders escapeHtml(a.detail) straight into the row's meta line, so an
  // object there printed "[object Object]" to the user.
  assert.match(send, /detail: `to \$\{wallet\.shortAddress\(to\)\}/);
  assert.doesNotMatch(send, /detail: extra/, 'detail must not be the raw object');
  assert.doesNotMatch(send, /\{ dest: /, 'the decoded address object must not be stored');
  // the destination is kept as the plain address string at every call site
  assert.match(send, /record\('bitcoin', txid, to\)/);
  assert.match(send, /record\('solana', signature, to\)/);
  assert.match(send, /record\('xrp', hash, to, \{ destinationTag \}\)/);
});

test('the destination tag is validated as a real uint32 and only sent when given', () => {
  assert.match(send, /4294967295/);
  assert.match(send, /destinationTag/);
});

test('a sent transaction is recorded in the activity log with its hash', () => {
  assert.match(send, /addActivity\(/);
  assert.match(send, /status: 'pending'/);
});
