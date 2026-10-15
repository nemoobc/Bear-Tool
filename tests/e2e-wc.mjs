// tests/e2e-wc.mjs — CI-only WalletConnect PROTOCOL end-to-end over the
// PUBLIC relay. TWO OS PROCESSES: this one plays the dApp, a spawned child
// plays the wallet (both plain SignClient stacks — same projectId, same relay,
// same protocol a production pair of apps uses). Two processes ON PURPOSE:
// WalletConnect Core is a per-process singleton, so two clients inside one
// process share one relay subscriber and cross their events — the proposal
// never reaches the "wallet" listener that way (live failure 2026-10-09:
// "No listener for session_proposal event"). The signature is verified
// cryptographically with ethers, not string-compared. Run: npm run test:e2e-wc
//
// The wallet role is anvil's first account and a plain anvil is booted first
// (chain-id 1, port 8611): when it is up, the round-trip also proves
// eth_signTypedData_v4 and eth_sendTransaction — refusal rail, broadcast,
// receipt, balance — on a real chain. No anvil on PATH → those sections skip
// honestly; everything above them still runs and still must pass.
//
// Skip policy (mirrors tests/fork): transport failure at INIT exits 0 with a
// SKIP line; any failure AFTER the session is established is a real FAIL
// (exit 1) — a half-working wallet must never look like "no internet".
//
// The live UI clicks around this protocol (pair sheet, proposal modal, Sign
// dialog) are covered by tests/e2e/23-wc-sign.spec.js; this script guards the
// layer under them so a relay/dependency update can't rot silently.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SignClient } from '@walletconnect/sign-client';
import { JsonRpcProvider, Wallet, getBytes, parseEther, verifyMessage, verifyTypedData } from 'ethers';

const PROJECT_ID = '99909bde486039e2102663b92be74974';
const MSG = '0x68656c6c6f2062656172'; // "hello bear", the same shape the UI signs
const METHODS = ['eth_requestAccounts', 'eth_accounts', 'personal_sign', 'eth_signTypedData_v4', 'eth_sendTransaction'];
// Plain anvil for THIS test only — a chain, not a fork of one. Port 8611: the
// dex e2e scripts already own 8609 on the same box. Chain-id 1 so the eip155:1
// session narrative matches the chain the broadcast actually lands on.
const ANVIL_PORT = Number(process.env.WC_E2E_ANVIL_PORT || 8611);
const ANVIL_URL = 'http://127.0.0.1:' + ANVIL_PORT;
// Foundry's first well-known account — public key, worthless by design; the
// same address helpers.js documents for the Playwright suite.
const ANVIL_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const readStdinLine = () => new Promise((resolve) => {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { buf += d; if (buf.includes('\n')) resolve(buf.split('\n')[0].trim()); });
  process.stdin.on('end', () => resolve(buf.trim()));
});

// ── wallet role (spawned child): pair from stdin URI, approve, answer ──
if (process.argv[2] === 'wallet') {
  const log = (...a) => console.log('[e2e-wc:wallet]', ...a);
  let wallet;
  try {
    wallet = await SignClient.init({
      projectId: PROJECT_ID,
      metadata: { name: 'Bear Tool E2E Wallet', url: 'http://127.0.0.1:8080', icons: [] },
    });
  } catch (e) {
    console.log('SKIP_INIT');
    process.exit(0);
  }
  // Anvil's account #0, not a random one: eth_sendTransaction needs a signer
  // that actually HOLDS a balance on the chain under test, and a deterministic
  // address makes every failure readable.
  const signer = new Wallet(ANVIL_KEY);
  let anvilProvider = null;
  const provider = () => (anvilProvider ||= new JsonRpcProvider(ANVIL_URL));
  log('account', signer.address);
  wallet.on('session_proposal', async ({ id }) => {
    try {
      // SignClient's API is approve()/reject() — approveSession() is the
      // WalletKit wrapper's name and throws "not a function" on raw client.
      await wallet.approve({
        id,
        namespaces: {
          eip155: { accounts: ['eip155:1:' + signer.address], chains: ['eip155:1'], methods: METHODS, events: [] },
        },
      });
      log('session approved');
    } catch (e) {
      console.log('ERR approve:', (e && e.message) || e);
      process.exit(1);
    }
  });
  // Event shape in this build: { id, topic, params: { request, chainId } } —
  // the request is NOT a top-level key (live crash 2026-10-09).
  wallet.on('session_request', async ({ id, topic, params }) => {
    const request = params?.request || {};
    try {
      if (request.method === 'eth_requestAccounts' || request.method === 'eth_accounts') {
        await wallet.respond({ topic, response: { id, jsonrpc: '2.0', result: [signer.address] } });
      } else if (request.method === 'personal_sign') {
        const sig = await signer.signMessage(getBytes(request.params[0]));
        await wallet.respond({ topic, response: { id, jsonrpc: '2.0', result: sig } });
        log('personal_sign answered');
      } else if (request.method === 'eth_signTypedData_v4') {
        // Canonical order [address, typedDataJSON] — the same convention the
        // app's splitTypedParams prefers (dapp-exec.js). The foreign-`from`
        // check mirrors the app's 4100 so the refusal travels with the exact
        // shape a real dApp would see.
        const [from, json] = request.params || [];
        if (String(from || '').toLowerCase() !== signer.address.toLowerCase()) {
          await wallet.respond({ topic, response: { id, jsonrpc: '2.0', error: { code: 4100, message: 'The account ' + from + ' is not the active account.' } } });
        } else {
          const data = JSON.parse(json);
          const sig = await signer.signTypedData(data.domain, data.types, data.message);
          await wallet.respond({ topic, response: { id, jsonrpc: '2.0', result: sig } });
          log('eth_signTypedData_v4 answered');
        }
      } else if (request.method === 'eth_sendTransaction') {
        const tx = (request.params || [])[0] || {};
        if (tx.from && String(tx.from).toLowerCase() !== signer.address.toLowerCase()) {
          await wallet.respond({ topic, response: { id, jsonrpc: '2.0', error: { code: 4100, message: 'The account ' + tx.from + ' is not the active account.' } } });
        } else {
          const sent = await signer.connect(provider()).sendTransaction({ to: tx.to, value: BigInt(tx.value || 0), data: tx.data });
          await wallet.respond({ topic, response: { id, jsonrpc: '2.0', result: sent.hash } });
          log('eth_sendTransaction broadcast', sent.hash.slice(0, 14) + '…');
        }
      } else {
        await wallet.respond({
          topic,
          response: { id, jsonrpc: '2.0', error: { code: 4200, message: request.method + ' is not supported by the E2E wallet' } },
        });
      }
    } catch (e) {
      console.log('ERR respond(' + request.method + '):', (e && e.message) || e);
      process.exit(1);
    }
  });
  log('listening');
  const uri = await readStdinLine();
  if (!uri.startsWith('wc:')) { console.log('ERR bad uri'); process.exit(1); }
  log('uri received', uri.length, 'chars');
  await Promise.race([
    wallet.pair({ uri }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('pair timeout')), 45000)),
  ]).catch((e) => { console.log('ERR pair:', (e && e.message) || e); process.exit(1); });
  log('paired');
  await new Promise((resolve) => { process.stdin.on('end', resolve); process.stdin.on('close', resolve); });
  process.exit(0);
}

// ── dApp role (this process): connect → drive requests → verify ──
const log = (...a) => console.log('[e2e-wc]', ...a);
let walletProc = null;
let anvilProc = null;
const fail = (m) => {
  console.error('[e2e-wc] FAIL:', m);
  try { walletProc?.kill('SIGKILL'); } catch { /* already gone */ }
  try { anvilProc?.kill('SIGKILL'); } catch { /* never started */ }
  process.exit(1);
};
// 150s: an anvil boot, a broadcast and a receipt wait ride on top of the
// original pair → sign → verify round-trip.
setTimeout(() => fail('global timeout 150s'), 150000);

// Boot the chain BEFORE the wallet child: the child broadcasts to it, so it
// must answer before the first transaction request goes out. Missing anvil is
// an honest partial skip — never a failure: the protocol round-trip (pair,
// accounts, personal_sign, typed data) needs no chain at all.
let anvilUp = false;
try {
  anvilProc = spawn('anvil', ['--port', String(ANVIL_PORT), '--chain-id', '1', '--silent'], { stdio: 'ignore' });
  const t0 = Date.now();
  await new Promise((resolve, reject) => {
    anvilProc.on('error', reject);
    anvilProc.on('exit', (c) => reject(new Error('anvil exited ' + c)));
    const poll = async () => {
      try {
        const r = await fetch(ANVIL_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
        });
        if (r.ok && (await r.json()).result === '0x1') return resolve();
      } catch { /* not up yet */ }
      if (Date.now() - t0 > 8000) return reject(new Error('anvil boot timeout'));
      setTimeout(poll, 250);
    };
    poll();
  });
  anvilUp = true;
  log('anvil up on', ANVIL_PORT);
} catch (e) {
  log('SKIP-ANVIL:', (e && e.message) || e, '— broadcast section will be skipped');
  try { anvilProc?.kill('SIGKILL'); } catch { /* never started */ }
  anvilProc = null;
}

const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'wallet'], { stdio: ['pipe', 'pipe', 'inherit'] });
walletProc = child;
let childBuf = '';
const childWaiters = [];
child.stdout.on('data', (d) => {
  process.stdout.write(String(d).replace(/^/gm, '  │ '));
  childBuf += d;
  for (let i = childWaiters.length - 1; i >= 0; i--) {
    if (childBuf.includes(childWaiters[i].needle)) childWaiters.splice(i, 1)[0].done();
  }
});
const waitForChild = (needle, ms, what) => new Promise((res, rej) => {
  if (childBuf.includes(needle)) return res();
  const t = setTimeout(() => rej(new Error(what + ' timeout')), ms);
  childWaiters.push({ needle, done: () => { clearTimeout(t); res(); } });
});
child.on('exit', (code) => { if (code && code !== 0) fail('wallet process died (exit ' + code + ')'); });

let dapp;
try {
  dapp = await SignClient.init({
    projectId: PROJECT_ID,
    metadata: { name: 'Bear Tool E2E dApp', url: 'http://127.0.0.1:9999', icons: [] },
  });
} catch (e) {
  log('SKIP: relay unreachable at init —', (e && e.message) || e);
  process.exit(0);
}

try {
  await waitForChild('[e2e-wc:wallet] listening', 40000, 'wallet boot');
} catch (e) {
  if (childBuf.includes('SKIP_INIT')) { log('SKIP: relay unreachable at wallet init'); process.exit(0); }
  fail(e.message);
}

const { uri, approval } = await dapp.connect({
  requiredNamespaces: {
    eip155: { methods: ['eth_requestAccounts', 'personal_sign', 'eth_signTypedData_v4', 'eth_sendTransaction'], chains: ['eip155:1'], events: [] },
  },
});
if (!uri || !uri.startsWith('wc:')) fail('no pairing URI');
log('pairing URI issued → wallet process');
child.stdin.write(uri + '\n');

const tIssue = Date.now();
// This sign-client build returns approval as a FUNCTION (older docs show a
// bare promise) — Promise.race would otherwise resolve instantly with the
// function itself (live 2026-10-09: "approval settled after 1ms → function").
const approvalP = typeof approval === 'function' ? approval() : approval;
const session = await Promise.race([
  approvalP,
  new Promise((_, rej) => setTimeout(() => rej(new Error('session approval timeout')), 60000)),
]).catch((e) => fail(e.message));
log('approval settled after', Date.now() - tIssue, 'ms →', typeof session, session && Object.keys(session).slice(0, 8).join(','));
if (!session?.topic) fail('no session');
log('session established, topic', session.topic.slice(0, 12) + '…');

const accounts = await Promise.race([
  dapp.request({ topic: session.topic, chainId: 'eip155:1', request: { method: 'eth_requestAccounts', params: [] } }, { timeout: 30000 }),
  new Promise((_, rej) => setTimeout(() => rej(new Error('eth_requestAccounts timeout')), 35000)),
]).catch((e) => fail(e.message));
if (typeof accounts?.[0] !== 'string' || !accounts[0].startsWith('0x')) fail('bad accounts shape: ' + JSON.stringify(accounts));
const mChild = childBuf.match(/\[e2e-wc:wallet\] account (0x[0-9a-fA-F]{40})/);
if (!mChild) fail('wallet process never announced its account');
if (mChild[1] !== accounts[0]) fail('wallet process account ' + mChild[1] + ' ≠ session account ' + accounts[0]);
log('eth_requestAccounts →', accounts[0], '(matches the wallet process)');

const sig = await Promise.race([
  dapp.request({ topic: session.topic, chainId: 'eip155:1', request: { method: 'personal_sign', params: [MSG, accounts[0]] } }, { timeout: 30000 }),
  new Promise((_, rej) => setTimeout(() => rej(new Error('personal_sign timeout')), 35000)),
]).catch((e) => fail(e.message));
if (typeof sig !== 'string' || !sig.startsWith('0x')) fail('bad signature shape');
const recovered = verifyMessage(getBytes(MSG), sig);
if (recovered !== accounts[0]) fail('signature recovers to ' + recovered + ', session account is ' + accounts[0]);
log('personal_sign verified —', sig.slice(0, 20) + '…');

// ── typed data (offline signature — runs with or without anvil) ──
const domain = { name: 'Bear Tool E2E', version: '1', chainId: 1 };
const types = { Mail: [{ name: 'content', type: 'string' }] };
const typedValue = { content: 'hello typed bear' };
const typedSig = await Promise.race([
  dapp.request({
    topic: session.topic,
    chainId: 'eip155:1',
    request: {
      method: 'eth_signTypedData_v4',
      params: [accounts[0], JSON.stringify({ domain, types, message: typedValue, primaryType: 'Mail' })],
    },
  }, { timeout: 30000 }),
  new Promise((_, rej) => setTimeout(() => rej(new Error('eth_signTypedData_v4 timeout')), 35000)),
]).catch((e) => fail(e.message));
if (typeof typedSig !== 'string' || !typedSig.startsWith('0x')) fail('bad typed signature shape');
const typedRecovered = verifyTypedData(domain, types, typedValue, typedSig);
if (typedRecovered !== accounts[0]) fail('typed signature recovers to ' + typedRecovered + ', session account is ' + accounts[0]);
log('eth_signTypedData_v4 verified —', typedSig.slice(0, 20) + '…');

// ── on-chain section (only with a chain under it) ──
if (anvilUp) {
  const provider = new JsonRpcProvider(ANVIL_URL);
  const recipient = Wallet.createRandom().address; // fresh — balance starts at 0
  const valueWei = parseEther('0.01');

  // 1. A foreign `from` must be refused with 4100 — the same rail the app's
  //    buildSendTx enforces (unit-tested in dapp-exec.test.js); here the point
  //    is that the refusal survives the protocol journey back to the dApp.
  let refusal = null;
  try {
    await dapp.request({
      topic: session.topic,
      chainId: 'eip155:1',
      request: { method: 'eth_sendTransaction', params: [{ from: '0x' + 'ab'.repeat(20), to: recipient, value: '0x1' }] },
    }, { timeout: 30000 });
  } catch (e) { refusal = e; }
  if (!refusal) fail('a foreign `from` was not refused (expected 4100)');
  const refusalText = String(refusal && (refusal.message || refusal));
  if (!(refusal.code === 4100 || /not the active account/.test(refusalText) || /4100/.test(refusalText))) {
    fail('foreign-from refusal shape unexpected: ' + refusalText.slice(0, 160));
  }
  log('foreign-from refused —', refusalText.slice(0, 80));

  // 2. The real thing: broadcast, then verify on the chain itself — receipt
  //    status, moved balance, and the sender the chain recorded.
  const txHash = await Promise.race([
    dapp.request({
      topic: session.topic,
      chainId: 'eip155:1',
      request: { method: 'eth_sendTransaction', params: [{ from: accounts[0], to: recipient, value: '0x' + valueWei.toString(16) }] },
    }, { timeout: 30000 }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('eth_sendTransaction timeout')), 35000)),
  ]).catch((e) => fail(e.message));
  if (typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) fail('bad tx hash shape: ' + txHash);
  const receipt = await provider.waitForTransaction(txHash, 1, 20000);
  if (!receipt || receipt.status !== 1) fail('no successful receipt for ' + txHash);
  const moved = await provider.getBalance(recipient);
  if (moved !== valueWei) fail('recipient balance ' + moved + ' ≠ ' + valueWei + ' — the transaction did not move the value it claimed');
  const sentTx = await provider.getTransaction(txHash);
  if (String(sentTx.from).toLowerCase() !== accounts[0].toLowerCase()) fail('tx.from ' + sentTx.from + ' ≠ session account ' + accounts[0]);
  log('eth_sendTransaction verified — receipt status 1, 0.01 ETH moved to', recipient.slice(0, 12) + '…');
} else {
  log('SKIP-TX: no anvil on this machine — broadcast section skipped (protocol round-trip still enforced)');
}

await dapp.disconnect({ topic: session.topic }).catch(() => {});
child.stdin.end();
await new Promise((r) => child.on('exit', r));
try { anvilProc?.kill('SIGKILL'); } catch { /* never started */ }
log('PASS: full WC protocol round-trip in two processes (pair → approve → accounts → personal_sign → typed → ' + (anvilUp ? 'tx/receipt → ' : 'tx skipped → ') + 'disconnect)');
process.exit(0);
