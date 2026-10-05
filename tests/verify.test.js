// M10 — auto-verify after deploy (Sourcify + Etherscan V2).
//
// Why this file exists: verification is the one deploy step where a WRONG
// answer looks identical to a right one. A green "verified" that published a
// hand-rebuilt input instead of the input that actually compiled the bytecode
// would say the contract is checked when nobody has checked it. So the tests
// below pin the exact request shape (URL, identifiers, encoded constructor
// arguments) rather than just "some fetch happened", plus the honest skip for
// a chain no explorer has ever heard of.
//
// Every network call is mocked — no key, no rate limit, no live write.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { appSource } from './helpers/app-source.mjs';

// localStorage must exist BEFORE verify.js/network.js run anything that reads
// it (private-mode safe either way, but here we want the key actually stored).
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
globalThis.ethers = ethers;

const verify = await import('../js/verify.js');
const solc = await import('../js/solc.js');
const contracts = await import('../js/contracts.js');

const NET = { chainId: 1, name: 'Ethereum', rpc: ['https://eth.llamarpc.com'], explorer: 'https://etherscan.io' };
const LOCAL = { chainId: 31337, name: 'anvil', rpc: ['http://127.0.0.1:8546'] };
const ADDR = '0x1111111111111111111111111111111111111111';

/** fetch double: first route whose matcher hits answers; nothing else may run. */
function makeFetch(routes) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, opts });
    for (const [match, handler] of routes) {
      const hit = typeof match === 'function' ? match(u, opts) : u.includes(match);
      if (!hit) continue;
      const out = typeof handler === 'function' ? handler(u, opts) : handler;
      const status = out.status ?? 200;
      const text = out.text ?? JSON.stringify(out.body ?? {});
      return { ok: status < 400, status, text: async () => text };
    }
    throw new Error('unexpected fetch: ' + u);
  };
  fn.calls = calls;
  return fn;
}

const noSleep = async () => {};

// A real wizard build, so the input under test is the input production sends.
function erc20Bundle() {
  const plan = contracts.buildDeployPlan({
    standard: 'erc20', name: 'Bear', symbol: 'bear', supply: '1000', decimals: 18,
    evmVersion: 'cancun', optimizer: false, runs: '999',
  });
  const source = contracts.buildTokenSource('erc20', plan.flags);
  return { plan, source };
}

// ── skip reasons ───────────────────────────────────────────────
test('verify: a local/dev chain skips with a reason instead of pretending', () => {
  assert.match(verify.localSkipReason(LOCAL, ADDR), /no public explorer/,
    'anvil must not claim a public explorer exists');
  assert.match(verify.localSkipReason({ chainId: 1, rpc: ['http://localhost:8545'] }, ADDR),
    /no public explorer/, 'a mainnet FORK on loopback is still local');
  assert.match(verify.localSkipReason({ chainId: 1337, rpc: ['https://rpc.example.com'] }, ADDR),
    /no public explorer/, 'the dev chain id alone is enough');
  assert.match(verify.localSkipReason(NET, ''), /No contract address/,
    'no address → nothing to verify');
  assert.equal(verify.localSkipReason(NET, ADDR), null, 'a real chain is worth attempting');
});

test('verify: loopback detection is one shared rule, not two copies', () => {
  const net = readFileSync(new URL('../js/network.js', import.meta.url), 'utf8');
  const det = net.slice(net.indexOf('export function detectNetworkType'));
  assert.match(det, /isLoopbackRpc\(rpcUrl\)/,
    'detectNetworkType must route through isLoopbackRpc — a second host list would drift');
  assert.match(net, /export const LOCAL_DEV_CHAIN_IDS/, 'the dev chain ids are shared too');
});

// ── standard JSON input: compile and verify share one builder ──
test('verify: the published input IS the input that compiled the bytecode', () => {
  const src = readFileSync(new URL('../js/solc.js', import.meta.url), 'utf8');
  assert.match(src, /const input = buildStandardJsonInput\(source, contractName, opts\)/,
    'compileContract must build its input through the shared builder');
  const { source } = erc20Bundle();
  const input = solc.buildStandardJsonInput(source, 'BearERC20', {
    language: 'Solidity', evmVersion: 'cancun', optimizer: false, runs: 999,
  });
  assert.equal(input.language, 'Solidity');
  assert.deepEqual(Object.keys(input.sources), ['BearERC20.sol'],
    'the file name is the contract name — contractname must match it');
  assert.equal(input.sources['BearERC20.sol'].content, source, 'the source is byte-for-byte what compiled');
  assert.deepEqual(input.settings.optimizer, { enabled: false, runs: 999 }, 'compiler knobs ride along');
  assert.equal(input.settings.evmVersion, 'cancun');
  const bare = solc.buildStandardJsonInput(source, 'BearERC20', {});
  assert.equal(bare.settings.evmVersion, undefined,
    'absent evmVersion stays absent — the flag-off path must not pin a default');
  assert.equal(bare.settings.optimizer.enabled, true, 'optimization defaults on, as it always has');
  assert.throws(() => solc.buildStandardJsonInput('', 'X'), Error, 'no source, no input');
});

test('verify: compiler ids are spelled the way each service documents', () => {
  assert.equal(solc.SOLC_ID_SOURCIFY, '0.8.37+commit.f401782d', 'Sourcify: bare long version');
  assert.equal(solc.SOLC_ID_ETHERSCAN, 'v0.8.37+commit.f401782d', 'Etherscan: leading v');
  assert.equal(solc.SOLC_LONG, `${solc.SOLC_VERSION}+commit.${solc.SOLC_COMMIT}`,
    'one source of truth for the pair');
});

// ── constructor arguments ──────────────────────────────────────
test('verify: constructor arguments are ABI-encoded, without 0x', () => {
  const { plan } = erc20Bundle();
  const abi = [
    { type: 'constructor', inputs: [
      { name: '_name', type: 'string' }, { name: '_symbol', type: 'string' },
      { name: '_decimals', type: 'uint8' }, { name: '_supply', type: 'uint256' },
    ] },
  ];
  const enc = verify.encodeConstructorArgs(abi, plan.args);
  assert.ok(/^[0-9a-f]*$/i.test(enc), 'Etherscan takes hex with NO 0x prefix');
  assert.ok(!enc.startsWith('0x'), 'no 0x prefix');
  const back = ethers.AbiCoder.defaultAbiCoder().decode(
    ['string', 'string', 'uint8', 'uint256'], '0x' + enc);
  assert.equal(back[0], 'Bear');
  assert.equal(back[1], 'BEAR', 'the uppercased symbol is what actually went on chain');
  assert.equal(back[2], 18n, 'decimals come back as the uint8 that was encoded');
  assert.equal(back[3], 1000n * 10n ** 18n, 'supply scaled by decimals');
  assert.equal(verify.encodeConstructorArgs([{ type: 'function', name: 'x' }], plan.args), '',
    'no constructor → empty, not a guess');
  assert.equal(verify.encodeConstructorArgs(abi, []), '', 'no args → empty');
});

// ── Sourcify ───────────────────────────────────────────────────
test('verify: Sourcify gets standard JSON input and a creation tx, then polls the ticket', async () => {
  const { source } = erc20Bundle();
  const stdJsonInput = solc.buildStandardJsonInput(source, 'BearERC20', {});
  let polls = 0;
  const fetchFn = makeFetch([
    [(u, o) => o.method === 'POST' && u.includes('/v2/verify/1/' + ADDR),
      { body: { verificationId: 'tkt-42' } }],
    // Verdict and match arrive together: a `match` field on a still-pending
    // ticket would read as terminal, so the mock keeps them in step.
    [(u) => u.includes('/v2/verify/tkt-42'),
      () => (polls++ === 0 ? { body: { status: 'pending' } } : { body: { status: 'finished', match: 'perfect' } })],
  ]);
  const statuses = [];
  const out = await verify.verifySourcify({
    chainId: 1, address: ADDR, stdJsonInput, contractName: 'BearERC20',
    creationTxHash: '0xdead', fetchFn, sleepFn: noSleep,
    onStatus: (m) => statuses.push(m),
  });
  assert.deepEqual(out, { service: 'sourcify', ok: true, msg: 'Sourcify perfect match' });

  const post = fetchFn.calls[0];
  assert.equal(post.url, `${verify.SOURCIFY_BASE}/v2/verify/1/${ADDR}`,
    'chainId + address in the path, per the documented v2 route');
  const body = JSON.parse(post.opts.body);
  assert.equal(body.compilerVersion, '0.8.37+commit.f401782d');
  assert.equal(body.contractIdentifier, 'BearERC20.sol:BearERC20', 'file:contract, as compiled');
  assert.equal(body.creationTransactionHash, '0xdead', 'creation tx lets Sourcify find the deploy');
  assert.deepEqual(body.stdJsonInput, stdJsonInput, 'the shared input, unmodified');
  assert.equal(fetchFn.calls[1].url, `${verify.SOURCIFY_BASE}/v2/verify/tkt-42`,
    'the ticket is polled');
  assert.ok(statuses.length >= 2, 'the deploy card sees progress, not a frozen spinner');
});

test('verify: Sourcify reports a rejected submission instead of polling a dead ticket', async () => {
  const fetchFn = makeFetch([['/v2/verify/', { status: 400, body: { error: { message: 'chain not supported' } } }]]);
  await assert.rejects(
    () => verify.verifySourcify({ chainId: 999999, address: ADDR, stdJsonInput: {}, contractName: 'X', fetchFn, sleepFn: noSleep }),
    /chain not supported/, 'the vendor message survives to the user');
  assert.equal(fetchFn.calls.length, 1, 'no polling after a rejected submission');
});

test('verify: an unconfirmed Sourcify ticket gives up with a bounded message', async () => {
  const fetchFn = makeFetch([
    [(u, o) => o.method === 'POST', { body: { verificationId: 'tkt-9' } }],
    [() => true, { body: { status: 'pending' } }],
  ]);
  await assert.rejects(
    () => verify.verifySourcify({ chainId: 1, address: ADDR, stdJsonInput: {}, contractName: 'X', fetchFn, sleepFn: noSleep, polls: 3 }),
    /still pending after 3 checks/, 'bounded, named, and it says how long it tried');
  assert.equal(fetchFn.calls.length, 4, '1 submit + 3 polls, then stop');
});

// ── Etherscan V2 ───────────────────────────────────────────────
test('verify: Etherscan V2 gets a GUID and is polled until it says Pass', async () => {
  const { source, plan } = erc20Bundle();
  const stdJsonInput = solc.buildStandardJsonInput(source, 'BearERC20', {});
  const enc = verify.encodeConstructorArgs(
    [{ type: 'constructor', inputs: [
      { name: '_name', type: 'string' }, { name: '_symbol', type: 'string' },
      { name: '_decimals', type: 'uint8' }, { name: '_supply', type: 'uint256' },
    ] }], plan.args);
  let checks = 0;
  const fetchFn = makeFetch([
    [(u, o) => o.method === 'POST' && u.includes('action=verifysourcecode'),
      { body: { status: '1', message: 'OK', result: 'guid-xyz' } }],
    [(u) => u.includes('action=checkverifystatus'),
      () => ({ body: { status: '1', result: ++checks < 2 ? 'Pending: 1' : 'Pass - Verified' } })],
  ]);
  const out = await verify.verifyEtherscan({
    chainId: 1, address: ADDR, stdJsonInput, contractName: 'BearERC20',
    constructorArguments: enc, key: 'TESTKEY', fetchFn, sleepFn: noSleep,
  });
  assert.deepEqual(out, { service: 'etherscan', ok: true, msg: 'Pass - Verified' });

  const post = fetchFn.calls[0];
  assert.match(post.url, /v2\/api\?chainid=1&module=contract&action=verifysourcecode$/,
    'chainid in the query, module/action pinned (docs.etherscan.io, 2026-10-04)');
  const form = post.opts.body;
  assert.ok(form instanceof URLSearchParams, 'the endpoint takes form-urlencoded fields');
  assert.equal(form.get('apikey'), 'TESTKEY');
  assert.equal(form.get('contractaddress'), ADDR);
  assert.equal(form.get('codeformat'), 'solidity-standard-json-input');
  assert.equal(form.get('contractname'), 'BearERC20.sol:BearERC20');
  assert.equal(form.get('compilerversion'), 'v0.8.37+commit.f401782d', 'leading v, per their docs');
  assert.equal(form.get('constructorArguments'), enc, 'the real ABI-encoded args, not a placeholder');
  assert.equal(form.get('licenseType'), '3', 'MIT');
  assert.equal(form.get('sourceCode'), JSON.stringify(stdJsonInput), 'the shared input, unmodified');
  const poll = fetchFn.calls[1];
  assert.match(poll.url, /action=checkverifystatus&guid=guid-xyz&apikey=TESTKEY/);
  assert.equal(checks, 2, 'one pending, one verdict');
});

test('verify: Etherscan failures are named, and a bad key fails fast', async () => {
  const noKey = makeFetch([]);
  await assert.rejects(() => verify.verifyEtherscan({ chainId: 1, address: ADDR, stdJsonInput: {}, contractName: 'X', key: '', fetchFn: noKey, sleepFn: noSleep }),
    /no API key saved/);
  assert.equal(noKey.calls.length, 0, 'a missing key never leaves the device');

  const dup = makeFetch([[() => true, { body: { status: '0', message: 'NOTOK', result: 'Contract source code already verified' } }]]);
  assert.deepEqual(await verify.verifyEtherscan({ chainId: 1, address: ADDR, stdJsonInput: {}, contractName: 'X', key: 'K', fetchFn: dup, sleepFn: noSleep }),
    { service: 'etherscan', ok: true, msg: 'already verified' },
    're-running verify is idempotent, not an error');

  const bad = makeFetch([[() => true, { body: { status: '0', message: 'NOTOK', result: 'Missing/Invalid API Key' } }]]);
  await assert.rejects(() => verify.verifyEtherscan({ chainId: 1, address: ADDR, stdJsonInput: {}, contractName: 'X', key: 'nope', fetchFn: bad, sleepFn: noSleep }),
    /Missing\/Invalid API Key/);
  assert.equal(bad.calls.length, 1, 'a rejected key is fatal on submit — no polling loop');

  const mismatch = makeFetch([
    [(u, o) => o.method === 'POST', { body: { status: '1', result: 'g1' } }],
    [() => true, { body: { status: '1', result: 'Fail - Unable to verify' } }],
  ]);
  await assert.rejects(() => verify.verifyEtherscan({ chainId: 1, address: ADDR, stdJsonInput: {}, contractName: 'X', key: 'K', fetchFn: mismatch, sleepFn: noSleep }),
    /Fail - Unable to verify/, 'the explorer says WHY, verbatim');
});

// ── the key ────────────────────────────────────────────────────
test('verify: the Etherscan key is stored like every other public key', () => {
  store.clear();
  assert.equal(verify.getEtherscanKey(), '', 'no key yet');
  assert.equal(verify.setEtherscanKey('  abc  '), 'abc', 'trimmed on save');
  assert.equal(verify.getEtherscanKey(), 'abc', 'remembered across renders');
  assert.equal(localStorage.getItem('bear.etherscanKey'), 'abc', 'localStorage, same key pattern as the OpenSea one');
  verify.setEtherscanKey('');
  assert.equal(verify.getEtherscanKey(), '', 'clearing really clears it');
});

// ── autoVerify ─────────────────────────────────────────────────
test('verify: autoVerify skips a local chain and never calls the network', async () => {
  const fetchFn = makeFetch([]);
  const out = await verify.autoVerify({ net: LOCAL, address: ADDR, source: 'x', contractName: 'X', fetchFn, sleepFn: noSleep });
  assert.equal(out.skipped, true);
  assert.match(out.reason, /no public explorer/);
  assert.equal(fetchFn.calls.length, 0, 'nothing leaves the device for a dev chain');
});

test('verify: autoVerify runs Sourcify keyless and says the key is missing', async () => {
  store.clear();
  const { source, plan } = erc20Bundle();
  let polls = 0;
  const fetchFn = makeFetch([
    [(u, o) => o.method === 'POST' && u.includes('/v2/verify/'), { body: { verificationId: 't' } }],
    [(u) => u.includes('/v2/verify/t'), () => (polls++ === 0 ? { body: { status: 'pending' } } : { body: { status: 'finished', match: 'partial' } })],
  ]);
  const out = await verify.autoVerify({
    net: NET, address: ADDR, source, contractName: 'BearERC20',
    abi: [{ type: 'constructor', inputs: [
      { name: '_name', type: 'string' }, { name: '_symbol', type: 'string' },
      { name: '_decimals', type: 'uint8' }, { name: '_supply', type: 'uint256' },
    ] }], args: plan.args, fetchFn, sleepFn: noSleep,
  });
  assert.equal(out.skipped, false);
  assert.equal(out.ok, true, 'Sourcify alone is enough to call it verified');
  assert.match(out.line, /sourcify: Sourcify partial match/);
  assert.match(out.line, /etherscan: no API key saved/,
    'the missing key is reported as a skip, not as a failure');
  assert.equal(fetchFn.calls.length, 3, 'no Etherscan traffic without a key');
  assert.ok(!fetchFn.calls.some((c) => c.url.includes('etherscan.io')),
    'a keyless install must not ping Etherscan at all');
});

test('verify: autoVerify reports both services and survives one failing', async () => {
  store.clear();
  verify.setEtherscanKey('EK');
  try {
    const { source } = erc20Bundle();
    const routes = [
      [(u, o) => o.method === 'POST' && u.includes('/v2/verify/'), { status: 500, body: { error: { message: 'sourcify down' } } }],
      [(u, o) => o.method === 'POST' && u.includes('action=verifysourcecode'), { body: { status: '1', result: 'g' } }],
      [(u) => u.includes('action=checkverifystatus'), { body: { status: '1', result: 'Pass - Verified' } }],
    ];
    const out = await verify.autoVerify({
      net: NET, address: ADDR, source, contractName: 'BearERC20',
      abi: [], args: [], fetchFn: makeFetch(routes), sleepFn: noSleep,
    });
    assert.equal(out.ok, true, 'one good service is a verified contract');
    assert.match(out.line, /sourcify: failed — sourcify: HTTP 500/);
    assert.match(out.line, /etherscan: Pass - Verified/);
    assert.equal(out.results.length, 2, 'both services are accounted for, neither silently dropped');
  } finally {
    verify.setEtherscanKey('');
  }
});

test('verify: when everything fails, autoVerify says so instead of claiming success', async () => {
  store.clear();
  const { source } = erc20Bundle();
  const fetchFn = makeFetch([[() => true, { status: 503, body: { error: { message: 'unavailable' } } }]]);
  const out = await verify.autoVerify({ net: NET, address: ADDR, source, contractName: 'BearERC20', fetchFn, sleepFn: noSleep });
  assert.equal(out.skipped, false);
  assert.equal(out.ok, false, 'no verification = ok:false, never a green tick');
  assert.match(out.line, /failed/);
  assert.match(out.line, /no API key saved/);
});

test('verify: a deploy with nothing to publish skips with the reason, not a crash', async () => {
  const fetchFn = makeFetch([]);
  const out = await verify.autoVerify({ net: NET, address: ADDR, source: '', contractName: 'X', fetchFn, sleepFn: noSleep });
  assert.equal(out.skipped, true, 'an empty source is not a verification attempt');
  assert.match(out.reason, /Verify skipped/);
  assert.equal(fetchFn.calls.length, 0);
});

// ── wiring ─────────────────────────────────────────────────────
test('verify: the deploy flow really calls autoVerify and the key field really exists', () => {
  const deploy = readFileSync(new URL('../js/deploy.js', import.meta.url), 'utf8');
  assert.match(deploy, /await autoVerify\(\{/,
    'the verify runs after a successful deploy, awaited so its line can land in the status');
  assert.match(deploy, /source, contractName: t\.contractName/,
    'it publishes the source that was ACTUALLY compiled — built ONCE, reused by compile + verify');
  assert.match(deploy, /compiler: plan\.compiler/, 'the wizard compiler config travels with it');
  assert.match(deploy, /creationTxHash: t\.txHash/, 'creation tx helps the indexer find the deploy');
  assert.match(deploy, /setEtherscanKey\(vkey\.value\)/, 'the field saves the key on change');
  assert.match(deploy, /getEtherscanKey\(\)/, 'the field is prefilled from storage');
  assert.match(deploy, /setDeployStatus\(okHtml \+ verifyHtml, 'ok'\)/,
    'a landed deploy stays "ok" no matter what verification says');
  // Critic finding: verification runs AFTER the result is already on screen.
  // A slow or hung verify must not be able to hold the dashboard hostage.
  assert.ok(
    deploy.indexOf("emit('refresh')") < deploy.indexOf("setBtnDots(btn, true, 'Verifying')"),
    'the dashboard refreshes and the toast fires before verification starts');
  assert.ok(!/return autoVerify|throw.*autoVerify/.test(deploy),
    'verification failure must never abort the deploy result');

  const html = appSource();
  assert.match(html, /id="deployVerifyKey"/, 'the key input is in the page markup');
  assert.match(html, /htmlFor="deployVerifyKey"|for="deployVerifyKey"/,
    'and its label points at it (a11y)');
});

// ── critic findings (2026-10-04) ───────────────────────────────
test('verify: a dev chain is skipped even when the app is on its second endpoint', () => {
  const reason = verify.localSkipReason(
    { chainId: 31337, rpc: ['https://example.invalid', 'http://127.0.0.1:8545'] }, ADDR);
  assert.match(String(reason), /Local chain \(http:\/\/127\.0\.0\.1:8545\)/,
    'rpc[0] is not the whole truth — a loopback anywhere in the list IS a local chain');
  assert.match(String(verify.localSkipReason({ chainId: 31337, rpc: ['http://localhost:8545'] }, ADDR)),
    /Local chain/, 'localhost by name too');
  assert.equal(verify.localSkipReason({ chainId: 1, rpc: ['https://eth.example'] }, ADDR), null,
    'a real chain is still worth attempting');
});

test('verify: every request carries a deadline, so a hung socket cannot hold the screen', async () => {
  // The mock has to answer LIKE THE SERVICES DO — a POST that never yields a
  // ticket/guid stops the flow before the poll, and a deadline test that only
  // reaches the two POSTs proves nothing about the two GETs that can hang the
  // deploy screen for the whole poll budget. (Round-2 critique caught exactly
  // that: deleting `signal` from the polls used to keep the suite green.)
  const fetchFn = makeFetch([
    ['/v2/verify/1/', { body: { verificationId: 'ticket-1' } }],   // submit (chain 1 + address)
    ['/v2/verify/ticket-1', { body: { status: 'verified' } }],     // poll
    ['verifysourcecode', { body: { status: '1', result: 'GUID1' } }],
    ['checkverifystatus', { body: { status: '1', result: 'Pass - Verified' } }],
  ]);
  const src = { chainId: 1, address: ADDR, stdJsonInput: { language: 'Solidity' }, contractName: 'BearERC20' };
  const s = await verify.verifySourcify({ ...src, fetchFn, sleepFn: noSleep });
  const e = await verify.verifyEtherscan({ ...src, key: 'TESTKEY', fetchFn, sleepFn: noSleep });
  assert.equal(s.ok, true, 'Sourcify must have reached its poll — otherwise this asserts nothing');
  assert.equal(e.ok, true, 'Etherscan must have reached its poll — otherwise this asserts nothing');
  const polls = fetchFn.calls.filter((c) => !c.opts?.method);
  assert.equal(fetchFn.calls.length, 4, `POST + poll for each service = 4 requests, got ${fetchFn.calls.length}`);
  assert.equal(polls.length, 2, 'two of them are the status polls');
  for (const { url, opts } of fetchFn.calls) {
    assert.ok(opts && opts.signal, `${url}: fetch must carry an AbortSignal deadline`);
  }
});
