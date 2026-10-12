// tests/non-evm-rpc.test.js — the network edge, driven entirely by a fake fetch.
//
// No real request is made here. What is being tested is the part that cannot be
// discovered from a live endpoint: which URLs are refused, how each backend's
// response shape is normalised, and what happens when the answer is an error.
// A green run must mean "the wallet would behave correctly", not "the internet
// happened to answer today".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';

globalThis.ethers = ethers;
const rpc = await import('../js/non-evm-rpc.js');

/** A fake fetch that records calls and replays a scripted response. */
function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init: init || {} });
    const out = await handler(String(url), init || {}, calls.length);
    const status = out && out.status != null ? out.status : 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      async text() { return typeof out.body === 'string' ? out.body : JSON.stringify(out.body); },
    };
  };
  fn.calls = calls;
  return fn;
}

// ── the allowlist ───────────────────────────────────────────────────────

test('https to an allowlisted host is accepted', () => {
  assert.equal(rpc.assertAllowedEndpoint('https://mempool.space/api/tx'), 'https://mempool.space/api/tx');
  assert.equal(rpc.assertAllowedEndpoint('https://s1.ripple.com:51234/'), 'https://s1.ripple.com:51234/');
});

test('https to an unknown host is refused by name', () => {
  assert.throws(() => rpc.assertAllowedEndpoint('https://evil.example.com/api'), /not an allowlisted endpoint/);
});

test('plain http is refused in production, opened only for debug loopback', () => {
  assert.throws(() => rpc.assertAllowedEndpoint('http://mempool.space/api'), /plain http/);
  assert.throws(() => rpc.assertAllowedEndpoint('http://localhost:8080/'), /plain http/);
  assert.equal(rpc.assertAllowedEndpoint('http://localhost:8080/', { debug: true }), 'http://localhost:8080/');
  assert.equal(rpc.assertAllowedEndpoint('http://127.0.0.1:8545/', { debug: true }), 'http://127.0.0.1:8545/');
  // debug does NOT open a remote cleartext host
  assert.throws(() => rpc.assertAllowedEndpoint('http://evil.example.com/', { debug: true }), /plain http/);
});

test('other schemes, empty strings and junk are refused', () => {
  assert.throws(() => rpc.assertAllowedEndpoint('ftp://mempool.space/'), /scheme/);
  assert.throws(() => rpc.assertAllowedEndpoint(''), /empty endpoint/);
  assert.throws(() => rpc.assertAllowedEndpoint('not a url'), /not a valid URL/);
});

test('the guard is applied on the way out, not just offered as a helper', async () => {
  const fetchFn = fakeFetch(() => ({ body: {} }));
  await assert.rejects(rpc.requestJson('https://evil.example.com/x', { fetchFn }), /not an allowlisted endpoint/);
  assert.equal(fetchFn.calls.length, 0); // it never left the building
});

// ── transport ───────────────────────────────────────────────────────────

test('a JSON body is parsed, a non-JSON body is returned as text', async () => {
  const asJson = fakeFetch(() => ({ body: { hello: 'world' } }));
  assert.deepEqual(await rpc.requestJson('https://mempool.space/api', { fetchFn: asJson }), { hello: 'world' });
  const asText = fakeFetch(() => ({ body: 'plain' }));
  assert.equal(await rpc.requestJson('https://mempool.space/api', { fetchFn: asText }), 'plain');
});

test('a non-2xx answer becomes an error that names the status', async () => {
  const fetchFn = fakeFetch(() => ({ status: 500, body: 'boom' }));
  await assert.rejects(rpc.requestJson('https://mempool.space/api', { fetchFn }), /HTTP 500/);
});

test('a hanging endpoint is aborted by the timeout', async () => {
  const fetchFn = (url, init) => new Promise((_, reject) => {
    if (init && init.signal) init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  await assert.rejects(rpc.requestJson('https://mempool.space/api', { fetchFn, timeoutMs: 30 }), /timed out/);
});

test('POST sends the body and content type; GET sends neither', async () => {
  const fetchFn = fakeFetch(() => ({ body: {} }));
  await rpc.requestJson('https://mempool.space/api/x', { method: 'POST', body: { a: 1 }, fetchFn });
  assert.equal(fetchFn.calls[0].init.method, 'POST');
  assert.equal(fetchFn.calls[0].init.body, '{"a":1}');
  assert.equal(fetchFn.calls[0].init.headers['content-type'], 'application/json');
  await rpc.requestJson('https://mempool.space/api/x', { fetchFn });
  assert.equal(fetchFn.calls[1].init.method, 'GET');
  assert.equal(fetchFn.calls[1].init.body, undefined);
});

// ── Bitcoin ─────────────────────────────────────────────────────────────

test('btcUtxos hits the right path and keeps only spendable fields', async () => {
  const fetchFn = fakeFetch(() => ({
    body: [
      { txid: 'aa'.repeat(32), vout: 1, value: 150000, status: { confirmed: true, block_height: 800000 } },
      { txid: 'bb'.repeat(32), vout: 0, value: 0, status: { confirmed: false } },        // zero-value: dropped
      { txid: 'cc'.repeat(32), vout: 2, value: 25000, status: { confirmed: false } },
    ],
  }));
  const utxos = await rpc.btcUtxos('bc1qexample', { fetchFn });
  assert.equal(fetchFn.calls[0].url, 'https://mempool.space/api/address/bc1qexample/utxo');
  assert.equal(utxos.length, 2);
  assert.deepEqual(utxos[0], { txid: 'aa'.repeat(32), vout: 1, value: 150000, confirmed: true, blockHeight: 800000 });
  assert.equal(utxos[1].confirmed, false);
});

test('btcBalance splits confirmed from unconfirmed', async () => {
  const fetchFn = fakeFetch(() => ({
    body: [
      { txid: 'aa'.repeat(32), vout: 0, value: 1000, status: { confirmed: true } },
      { txid: 'bb'.repeat(32), vout: 0, value: 500, status: { confirmed: false } },
    ],
  }));
  const balance = await rpc.btcBalance('bc1qexample', { fetchFn });
  assert.equal(balance.confirmed, 1000);
  assert.equal(balance.unconfirmed, 500);
  assert.equal(balance.total, 1500);
});

test('btcFeeRate normalises the mempool.space shape', async () => {
  const fetchFn = fakeFetch(() => ({ body: { fastestFee: 20, halfHourFee: 12, hourFee: 8, economyFee: 3, minimumFee: 1 } }));
  const fees = await rpc.btcFeeRate({ fetchFn });
  assert.deepEqual(fees, { fastest: 20, halfHour: 12, hour: 8, economy: 3, minimum: 1 });
  assert.equal(fetchFn.calls[0].url, 'https://mempool.space/api/v1/fees/recommended');
});

test('btcFeeRate falls back to blockstream when the primary fails', async () => {
  const fetchFn = fakeFetch((url) => {
    if (url.startsWith('https://mempool.space')) return { status: 502, body: 'nope' };
    return { body: { '1': 30, '3': 20, '6': 10, '144': 2, '1008': 1 } };
  });
  const fees = await rpc.btcFeeRate({ fetchFn });
  assert.ok(fees.fastest >= fees.minimum);
  assert.equal(fees.minimum, 1);
  assert.ok(fetchFn.calls.some((c) => c.url.startsWith('https://blockstream.info')));
});

test('btcBroadcast posts the hex as text and returns the node computed txid', async () => {
  const txid = 'ab'.repeat(32);
  const fetchFn = fakeFetch(() => ({ body: txid }));
  const out = await rpc.btcBroadcast('0x' + 'deadbeef', { fetchFn });
  assert.equal(out, txid);
  assert.equal(fetchFn.calls[0].url, 'https://mempool.space/api/tx');
  assert.equal(fetchFn.calls[0].init.method, 'POST');
  assert.equal(fetchFn.calls[0].init.body, 'deadbeef');           // 0x stripped
  assert.equal(fetchFn.calls[0].init.headers['content-type'], 'text/plain');
});

test('btcBroadcast surfaces a rejection instead of pretending success', async () => {
  const fetchFn = fakeFetch(() => ({ body: 'bad-txns-inputs-missingorspent' }));
  await assert.rejects(rpc.btcBroadcast('deadbeef', { fetchFn }), /rejected the transaction/);
  await assert.rejects(rpc.btcBroadcast('not hex!', { fetchFn: fakeFetch(() => ({ body: '' })) }), /not hex/);
});

// ── XRP ─────────────────────────────────────────────────────────────────

test('xrpAccountInfo posts JSON-RPC and reads sequence + balance', async () => {
  const fetchFn = fakeFetch(() => ({
    body: { result: { account_data: { Sequence: 42, Balance: '24000000', OwnerCount: 0 }, ledger_current_index: 999, validated: true } },
  }));
  const info = await rpc.xrpAccountInfo('rp2zmfCyJwCV4qRmDmD4ATPiHeY4pSHbs4', { fetchFn });
  assert.equal(info.sequence, 42);
  assert.equal(info.balanceDrops, 24000000n);
  assert.equal(info.ledgerIndex, 999);
  const sent = JSON.parse(fetchFn.calls[0].init.body);
  assert.equal(sent.method, 'account_info');
  assert.equal(sent.params[0].account, 'rp2zmfCyJwCV4qRmDmD4ATPiHeY4pSHbs4');
  assert.equal(fetchFn.calls[0].url, 'https://s1.ripple.com:51234/');
});

test('a JSON-RPC error result becomes a thrown error', async () => {
  const fetchFn = fakeFetch(() => ({ body: { result: { error: 'actNotFound', error_message: 'Account not found.' } } }));
  await assert.rejects(rpc.xrpAccountInfo('rNope', { fetchFn }), /XRP account_info failed/);
});

test('xrpAccountExists turns actNotFound into false, and rethrows anything else', async () => {
  const missing = fakeFetch(() => ({ body: { result: { error: 'actNotFound', error_message: 'Account not found.' } } }));
  assert.equal(await rpc.xrpAccountExists('rNope', { fetchFn: missing }), false);
  const broken = fakeFetch(() => ({ status: 500, body: 'x' }));
  await assert.rejects(rpc.xrpAccountExists('rNope', { fetchFn: broken }), /HTTP 500/);
});

test('xrpSubmit accepts tes and ter, refuses tec/tem/tef', async () => {
  const ok = fakeFetch(() => ({ body: { result: { engine_result: 'tesSUCCESS', engine_result_message: 'The transaction was applied.', tx_json: { hash: 'ABC' } } } }));
  const accepted = await rpc.xrpSubmit('DEADBEEF', { fetchFn: ok });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.tentative, false);
  assert.equal(accepted.hash, 'ABC');

  const retry = fakeFetch(() => ({ body: { result: { engine_result: 'terQUEUED', engine_result_message: 'Held until fee drops.' } } }));
  const queued = await rpc.xrpSubmit('DEADBEEF', { fetchFn: retry });
  assert.equal(queued.accepted, true);
  assert.equal(queued.tentative, true);

  const bad = fakeFetch(() => ({ body: { result: { engine_result: 'tefPAST_SEQ', engine_result_message: 'Sequence number is too small.' } } }));
  await assert.rejects(rpc.xrpSubmit('DEADBEEF', { fetchFn: bad }), /refused the transaction — tefPAST_SEQ/);
});

test('xrpSubmit lowercases nothing it should not: the blob goes up uppercase and hex-checked', async () => {
  const fetchFn = fakeFetch(() => ({ body: { result: { engine_result: 'tesSUCCESS' } } }));
  await rpc.xrpSubmit('0xdeadbeef', { fetchFn });
  assert.equal(JSON.parse(fetchFn.calls[0].init.body).params[0].tx_blob, 'DEADBEEF');
  await assert.rejects(rpc.xrpSubmit('zzz', { fetchFn }), /not hex/);
});

test('xrpLedgerIndex and xrpServerInfo read the fields the wallet needs', async () => {
  const ledger = fakeFetch(() => ({ body: { result: { ledger_index: 12345 } } }));
  assert.equal(await rpc.xrpLedgerIndex({ fetchFn: ledger }), 12345);
  const info = fakeFetch(() => ({ body: { result: { info: { server_state: 'full', validated_ledger: { seq: 99 }, load_factor: 1 } } } }));
  const server = await rpc.xrpServerInfo({ fetchFn: info });
  assert.equal(server.state, 'full');
  assert.equal(server.validatedLedger, 99);
});

test('xrpServerInfo reads the reserves and xrpReserveDrops adds the owner reserve', async () => {
  // Evidence: xrpl.org/docs/concepts/accounts/reserves — the mainnet base
  // reserve is 1 XRP and the owner reserve 0.2 XRP per owned object.
  // server_info reports them as decimal XRP (reserve_base_xrp / reserve_inc_xrp).
  const info = fakeFetch(() => ({ body: { result: { info: { server_state: 'full', validated_ledger: { seq: 99, reserve_base_xrp: 1, reserve_inc_xrp: 0.2 }, load_factor: 1 } } } }));
  const server = await rpc.xrpServerInfo({ fetchFn: info });
  assert.equal(server.reserveBaseDrops, 1000000n);
  assert.equal(server.reserveIncDrops, 200000n);
  assert.equal(rpc.xrpReserveDrops({ serverInfo: server, ownerCount: 0 }), 1000000n);
  assert.equal(rpc.xrpReserveDrops({ serverInfo: server, ownerCount: 3 }), 1600000n);
  // Nothing from the ledger → the documented fallback, never zero and never the
  // stale 10 XRP the wallet used to withhold.
  assert.equal(rpc.xrpReserveDrops({ ownerCount: 0 }), 1000000n);
  assert.equal(rpc.xrpReserveDrops({ ownerCount: 1 }), 1200000n);
});

// ── Solana ──────────────────────────────────────────────────────────────

test('solLatestBlockhash reads value.blockhash', async () => {
  const fetchFn = fakeFetch(() => ({ body: { jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: { blockhash: 'DQ396cE1gRbB5TCY3dj6rK4q4gTVEbMUPUWdu9hhDsgF', lastValidBlockHeight: 999 } } } }));
  const out = await rpc.solLatestBlockhash({ fetchFn });
  assert.equal(out.blockhash, 'DQ396cE1gRbB5TCY3dj6rK4q4gTVEbMUPUWdu9hhDsgF');
  assert.equal(out.lastValidBlockHeight, 999);
  const sent = JSON.parse(fetchFn.calls[0].init.body);
  assert.equal(sent.method, 'getLatestBlockhash');
  assert.equal(sent.params[0].commitment, 'confirmed');
});

test('solBalance accepts both the {value} and the bare number shape', async () => {
  const wrapped = fakeFetch(() => ({ body: { result: { value: 5000000 } } }));
  assert.equal(await rpc.solBalance('addr', { fetchFn: wrapped }), 5000000n);
  const bare = fakeFetch(() => ({ body: { result: 7000000 } }));
  assert.equal(await rpc.solBalance('addr', { fetchFn: bare }), 7000000n);
});

test('solSendTransaction returns the signature and surfaces an RPC error', async () => {
  const ok = fakeFetch(() => ({ body: { result: '3VVk9oT3LdgFqtuWo7TmiqMZ1Pd32R8jgBR1iGgPAtKe8T9acFqvxX8L72QXbjiE4fYuKqfQJccufKjGUGtpF4Qe' } }));
  assert.equal(await rpc.solSendTransaction('AQID', { fetchFn: ok }), '3VVk9oT3LdgFqtuWo7TmiqMZ1Pd32R8jgBR1iGgPAtKe8T9acFqvxX8L72QXbjiE4fYuKqfQJccufKjGUGtpF4Qe');
  const encoding = JSON.parse(ok.calls[0].init.body).params[1];
  assert.equal(encoding.encoding, 'base64');
  assert.equal(encoding.preflightCommitment, 'confirmed');

  const bad = fakeFetch(() => ({ body: { error: { code: -32000, message: 'Transaction simulation failed' } } }));
  await assert.rejects(rpc.solSendTransaction('AQID', { fetchFn: bad }), /simulation failed/);
  await assert.rejects(rpc.solSendTransaction('', { fetchFn: ok }), /no transaction to send/);
});

test('solSignatureStatus reports not-found without throwing', async () => {
  const none = fakeFetch(() => ({ body: { result: { value: [null] } } }));
  const missing = await rpc.solSignatureStatus('sig', { fetchFn: none });
  assert.equal(missing.found, false);
  assert.equal(missing.confirmed, false);

  const done = fakeFetch(() => ({ body: { result: { value: [{ slot: 42, confirmationStatus: 'finalized', err: null }] } } }));
  const status = await rpc.solSignatureStatus('sig', { fetchFn: done });
  assert.equal(status.found, true);
  assert.equal(status.confirmed, true);
  assert.equal(status.finalized, true);
  assert.equal(status.slot, 42);
});

test('an RPC error without a result is not mistaken for success', async () => {
  const fetchFn = fakeFetch(() => ({ body: { error: { code: -32602, message: 'Invalid params' } } }));
  await assert.rejects(rpc.solRpc('getBalance', [], { fetchFn }), /Invalid params/);
  const empty = fakeFetch(() => ({ body: {} }));
  await assert.rejects(rpc.solRpc('getBalance', [], { fetchFn: empty }), /returned no result/);
});

// ── endpoints ───────────────────────────────────────────────────────────

test('every built-in API endpoint is https and allowlisted; explorers are https links', () => {
  // `explorer` is a link we show the user, not a host we POST a signed
  // transaction to — so it must be https but it need not be on the API
  // allowlist. The endpoints the wallet actually contacts must be both.
  for (const [chainId, networks] of Object.entries(rpc.NON_EVM_ENDPOINTS)) {
    for (const [network, config] of Object.entries(networks)) {
      for (const [kind, url] of Object.entries(config)) {
        assert.ok(String(url).startsWith('https://'), `${chainId}/${network}/${kind} must be https`);
        if (kind !== 'explorer') {
          assert.doesNotThrow(() => rpc.assertAllowedEndpoint(url), `${chainId}/${network}/${kind} must be allowlisted`);
        }
      }
    }
  }
});

test('endpointFor picks the right host per chain and network', () => {
  assert.equal(rpc.endpointFor('bitcoin', 'mainnet'), 'https://mempool.space/api');
  assert.equal(rpc.endpointFor('bitcoin', 'testnet'), 'https://mempool.space/testnet/api');
  assert.equal(rpc.endpointFor('xrp', 'testnet'), 'https://s.altnet.rippletest.net:51234/');
  assert.equal(rpc.endpointFor('solana', 'testnet'), 'https://api.devnet.solana.com');
  assert.throws(() => rpc.endpointFor('dogecoin'), /unknown chain/);
  assert.throws(() => rpc.endpointFor('bitcoin', 'mars'), /unknown network/);
});

test('explorer transaction links follow each explorer documented path', () => {
  // Evidence for the XRP paths: docs.xrpscan.com/help/integration-guide documents
  // https://xrpscan.com/tx/{hash} (mainnet) and
  // https://testnet.xrpscan.com/tx/{hash} (testnet). For Solana devnet the cluster
  // is a QUERY STRING after the hash: solscan.io/tx/{sig}?cluster=devnet.
  assert.equal(rpc.explorerTxUrl('xrp', 'mainnet', 'AB'.repeat(32)), `https://xrpscan.com/tx/${'AB'.repeat(32)}`);
  assert.equal(rpc.explorerTxUrl('xrp', 'testnet', 'CD'.repeat(32)), `https://testnet.xrpscan.com/tx/${'CD'.repeat(32)}`);
  assert.equal(rpc.explorerTxUrl('bitcoin', 'mainnet', 'aa'.repeat(32)), `https://mempool.space/tx/${'aa'.repeat(32)}`);
  assert.equal(rpc.explorerTxUrl('solana', 'mainnet', 'Sig1'), 'https://solscan.io/tx/Sig1');
  assert.equal(rpc.explorerTxUrl('solana', 'testnet', 'Sig1'), 'https://solscan.io/tx/Sig1?cluster=devnet');
  // Every link must be a real https URL, never the dead /transactions/ shape and
  // never a query string stuck in front of the path.
  for (const chain of ['bitcoin', 'solana', 'xrp']) {
    for (const network of ['mainnet', 'testnet']) {
      const url = rpc.explorerTxUrl(chain, network, 'X');
      assert.ok(url.startsWith('https://'), url);
      assert.ok(!url.includes('/transactions/'), url);
      assert.ok(!url.includes('/?'), url);
    }
  }
});
