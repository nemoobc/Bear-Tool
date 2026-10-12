// tests/non-evm-redteam.test.js — attack the money paths on purpose.
//
// Sending BTC/SOL/XRP is the highest-stakes code in the build: a mistake here
// cannot be undone by a patch. So this file plays the attacker and the broken
// node, and asserts the wallet refuses rather than signs:
//
//   • a destination that would burn the funds (Solana zero key, taproot, X-address);
//   • an amount that cannot pay for itself, is negative, zero, or is not a whole
//     number of the smallest unit;
//   • a signing key that does not own the sending account;
//   • a node that returns a malformed UTXO, a bad txid, or a hostile address in
//     the URL path;
//   • an endpoint outside the allowlist, or plain http;
//   • an injected unknown field reaching the signed payload;
//   • a non-canonical (high-S) signature.
//
// Every message asserted here was read off the running code first — a red-team
// test that guesses is just a second bug.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';

globalThis.ethers = ethers;
const btc = await import('../js/chain-btc.js');
const xrp = await import('../js/chain-xrp.js');
const sol = await import('../js/chain-sol.js');
const rpc = await import('../js/non-evm-rpc.js');
const { btcKeypair, xrpKeypair, solanaKeypair, ed25519Verify } = await import('../js/coin-trees.js');

const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const A0 = { btc: btcKeypair(SEED, 0), xrp: xrpKeypair(SEED, 0), sol: solanaKeypair(SEED, 0) };
const A1 = { btc: btcKeypair(SEED, 1), xrp: xrpKeypair(SEED, 1), sol: solanaKeypair(SEED, 1) };

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init: init || {} });
    const out = await handler(String(url), init || {}, calls.length);
    const status = out && out.status != null ? out.status : 200;
    return { ok: status >= 200 && status < 300, status, async text() { return typeof out.body === 'string' ? out.body : JSON.stringify(out.body); } };
  };
  fn.calls = calls;
  return fn;
}

// ── Bitcoin ─────────────────────────────────────────────────────────────

const BTC_UTXO = [{ txid: 'aa'.repeat(32), vout: 0, value: 100000, confirmed: true }];

function btcInput(over = {}) {
  return {
    privateKey: A0.btc.privateKey,
    utxos: BTC_UTXO,
    to: A1.btc.nativeSegwit,
    amountSat: 50000n,
    feeSat: 1000n,
    changeAddress: A0.btc.nativeSegwit,
    network: 'mainnet',
    ...over,
  };
}

test('BTC: the change address must be one this key controls', () => {
  assert.throws(() => btc.buildBtcSend(btcInput({ changeAddress: A1.btc.nativeSegwit })), /does not control the change address/);
});

test('BTC: a taproot destination is refused by name', () => {
  // A real bech32m (P2TR) address — the encoding, not a bad checksum, is what
  // this rejects.
  assert.throws(() => btc.decodeBtcAddress('bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297'), /taproot/i);
});

test('BTC: a testnet address on mainnet is refused, not guessed across networks', () => {
  assert.throws(() => btc.decodeBtcAddress('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', 'mainnet'), /not a Bitcoin address/);
});

test('BTC: an amount at or above the balance (fee included) is refused, never signed', () => {
  assert.throws(() => btc.buildBtcSend(btcInput({ amountSat: 100000n })), /not enough to cover/);
  assert.throws(() => btc.buildBtcSend(btcInput({ amountSat: 0n })), /greater than zero/);
  assert.throws(() => btc.buildBtcSend(btcInput({ amountSat: -1n })), /greater than zero/);
});

test('BTC: a node-supplied txid that is not 32 bytes is refused before signing', () => {
  assert.throws(() => btc.buildBtcSend(btcInput({ utxos: [{ txid: 'nope', vout: 0, value: 100000, confirmed: true }] })), /not a txid/);
});

test('BTC: the same transaction is byte-identical every time (no hidden randomness)', () => {
  const a = btc.buildBtcSend(btcInput());
  const b = btc.buildBtcSend(btcInput());
  assert.equal(a.hex, b.hex);
  assert.equal(a.txid, b.txid);
});

test('BTC: btcUtxos drops hostile UTXO fields instead of signing them', async () => {
  const fetchFn = fakeFetch(() => ({ body: [
    { txid: 'aa'.repeat(32), vout: 0, value: 1000, status: { confirmed: true } },   // good
    { txid: 'NOTHEX', vout: 1, value: 5000, status: { confirmed: true } },          // bad txid
    { txid: 'bb'.repeat(32), vout: -1, value: 5000, status: { confirmed: true } },  // negative vout
    { txid: 'cc'.repeat(32), vout: 0, value: -5000, status: { confirmed: true } },  // negative value
    { txid: 'dd'.repeat(32), vout: 0, value: 1.5, status: { confirmed: true } },    // fractional sat
  ] }));
  const utxos = await rpc.btcUtxos('bc1qexample', { fetchFn });
  assert.equal(utxos.length, 1);
  assert.equal(utxos[0].txid, 'aa'.repeat(32));
});

test('BTC: an address cannot escape the URL path it is placed in', async () => {
  const fetchFn = fakeFetch(() => ({ body: [] }));
  await rpc.btcUtxos('../../admin?x=1', { fetchFn });
  assert.ok(/%2F/.test(fetchFn.calls[0].url), 'garis miring harus di-encode');
  assert.ok(!fetchFn.calls[0].url.includes('?x=1'), 'query tidak boleh ikut terbawa');
});

// ── XRP ─────────────────────────────────────────────────────────────────

function xrpInput(over = {}) {
  return {
    privateKey: A0.xrp.privateKey,
    account: A0.xrp.classic,
    destination: A1.xrp.classic,
    amountDrops: '1000000',
    feeDrops: 12,
    sequence: 5,
    lastLedgerSequence: 100,
    ...over,
  };
}

/** Parse a DER-encoded secp256k1 signature (hex, no 0x) into r and s. */
function derToRS(hex) {
  const b = ethers.getBytes('0x' + hex);
  let i = 0;
  assert.equal(b[i++], 0x30, 'DER: sequence tag');
  i += 1;                                    // total length (short form)
  assert.equal(b[i++], 0x02, 'DER: r tag');
  const rLen = b[i++];
  const r = BigInt(ethers.hexlify(b.slice(i, i + rLen)));
  i += rLen;
  assert.equal(b[i++], 0x02, 'DER: s tag');
  const sLen = b[i++];
  const s = BigInt(ethers.hexlify(b.slice(i, i + sLen)));
  return { r, s };
}

test('XRP: an X-address destination is refused (no silent conversion)', () => {
  assert.throws(() => xrp.buildSignedXrp(xrpInput({ destination: 'X7d3e769f3F593D812806965E109aCd7D5EfD9C7' })), /X-addresses are not supported/);
});

test('XRP: the amount must be a whole number of drops, greater than zero', () => {
  assert.throws(() => xrp.buildSignedXrp(xrpInput({ amountDrops: '1000000.5' })), /whole number of drops/);
  assert.throws(() => xrp.buildSignedXrp(xrpInput({ amountDrops: '-1' })), /whole number of drops/);
  assert.throws(() => xrp.buildSignedXrp(xrpInput({ amountDrops: '0' })), /greater than zero/);
});

test('XRP: the account being signed for must match the key', () => {
  assert.throws(() => xrp.buildSignedXrp(xrpInput({ account: A1.xrp.classic })), /does not control the sending account/);
});

test('XRP: the sequence and last-ledger bound are required, not optional', () => {
  assert.throws(() => xrp.buildSignedXrp(xrpInput({ sequence: undefined })), /sequence number is required/);
  assert.throws(() => xrp.buildSignedXrp(xrpInput({ sequence: -1 })), /negative number/);
  assert.throws(() => xrp.buildSignedXrp(xrpInput({ lastLedgerSequence: undefined })), /LastLedgerSequence is required/);
});

test('XRP: a destination tag beyond uint32 is refused', () => {
  assert.throws(() => xrp.buildSignedXrp(xrpInput({ destinationTag: 4294967296 })), /does not fit the field/);
  assert.throws(() => xrp.buildSignedXrp(xrpInput({ destinationTag: -1 })), /negative number/);
});

test('XRP: an injected unknown field is refused instead of silently dropped', () => {
  // The field whitelist lives in the serializer, which is where an unknown key
  // would otherwise be lost without a trace.
  const base = {
    TransactionType: 0,
    Account: A0.xrp.classic,
    Destination: A1.xrp.classic,
    Amount: '1',
    Fee: '12',
    Sequence: 1,
    LastLedgerSequence: 2,
  };
  assert.throws(() => xrp.serializeXrpTx({ ...base, Memos: [] }), /unknown field "Memos"/);
  assert.doesNotThrow(() => xrp.serializeXrpTx(base));
});

test('XRP: a fee below the ledger minimum is refused', () => {
  assert.throws(() => xrp.buildSignedXrp(xrpInput({ feeDrops: 5 })), /at least 12 drops/);
});

test("XRP: the signature is canonical low-S, like Bitcoin's", () => {
  const built = xrp.buildSignedXrp(xrpInput());
  const sigHex = built.txJson?.TxnSignature;
  assert.ok(sigHex, 'harus ada TxnSignature');
  const { s } = derToRS(sigHex);
  const N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
  assert.ok(s <= N / 2n, 's harus low-S (anti-malleability)');
});

// ── Solana ──────────────────────────────────────────────────────────────

const BLOCKHASH = 'DQ396cE1gRbB5TCY3dj6rK4q4gTVEbMUPUWdu9hhDsgF';

function solInput(over = {}) {
  return { privateKey: A0.sol.privateKey, from: A0.sol.address, to: A1.sol.address, lamports: 1000n, recentBlockhash: BLOCKHASH, ...over };
}

test('SOL: a key that does not own the sending account is refused', () => {
  assert.throws(() => sol.buildSolSend(solInput({ from: A1.sol.address })), /does not control the sending account/);
});

test('SOL: the zero key (System Program) is refused as a destination — funds would be lost', () => {
  assert.throws(() => sol.systemTransferInstruction({ from: A0.sol.address, to: sol.SOL_SYSTEM_PROGRAM, lamports: 1n }), /no known key/);
});

test('SOL: a zero or negative amount never becomes an instruction', () => {
  assert.throws(() => sol.systemTransferInstruction({ from: A0.sol.address, to: A1.sol.address, lamports: 0 }), /greater than zero/);
  assert.throws(() => sol.systemTransferInstruction({ from: A0.sol.address, to: A1.sol.address, lamports: -5 }), /greater than zero/);
  assert.throws(() => sol.buildSolSend(solInput({ lamports: 0n })), /greater than zero/);
});

test('SOL: an amount beyond 2^64 is refused, not silently truncated', () => {
  assert.throws(() => sol.systemTransferInstruction({ from: A0.sol.address, to: A1.sol.address, lamports: (1n << 64n) }), /64 bits/);
});

test('SOL: a wrong-length or junk destination is refused', () => {
  assert.throws(() => sol.buildSolSend(solInput({ to: '1111' })), /32 bytes/);
  assert.throws(() => sol.buildSolSend(solInput({ to: 'nope 0OIl' })), /not a valid address/);
});

test('SOL: a blockhash that is not a 32-byte value is refused', () => {
  assert.throws(() => sol.compileSolMessage({
    feePayer: A0.sol.address,
    instructions: [sol.systemTransferInstruction({ from: A0.sol.address, to: A1.sol.address, lamports: 1n })],
    recentBlockhash: 'short',
  }), /32 bytes/);
});

test('SOL: an all-0xff signature (S >= L) is rejected, and one flipped message bit breaks a real one', () => {
  const pk = sol.decodeSolAddress(A0.sol.address).publicKey;
  const message = new TextEncoder().encode('attack');
  assert.equal(ed25519Verify(pk, message, new Uint8Array(64).fill(0xff)), false);
  const msg = sol.compileSolMessage({
    feePayer: A0.sol.address,
    instructions: [sol.systemTransferInstruction({ from: A0.sol.address, to: A1.sol.address, lamports: 1n })],
    recentBlockhash: BLOCKHASH,
  });
  const good = sol.signSolMessage(A0.sol.privateKey, msg);
  assert.equal(ed25519Verify(pk, msg, good), true);
  const tampered = Uint8Array.from(msg);
  tampered[tampered.length - 1] ^= 0x01;
  assert.equal(ed25519Verify(pk, tampered, good), false);
});

// ── endpoints ───────────────────────────────────────────────────────────

test('the RPC guard cannot be talked past with a base override', async () => {
  const fetchFn = fakeFetch(() => ({ body: [] }));
  await assert.rejects(rpc.btcUtxos('bc1qexample', { fetchFn, base: 'https://evil.example.com/api' }), /allowlisted/);
  await assert.rejects(rpc.btcUtxos('bc1qexample', { fetchFn, base: 'http://mempool.space/api' }), /plain http/);
});

test('a Solana RPC error object is never read as a success value', async () => {
  const fetchFn = fakeFetch(() => ({ body: { error: { code: -32000, message: 'blockhash not found' } } }));
  await assert.rejects(rpc.solLatestBlockhash({ fetchFn }), /blockhash not found/);
});
