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
// Skip policy (mirrors tests/fork): transport failure at INIT exits 0 with a
// SKIP line; any failure AFTER the session is established is a real FAIL
// (exit 1) — a half-working wallet must never look like "no internet".
//
// The live UI clicks around this protocol (pair sheet, proposal modal, Sign
// dialog) are covered by hand via the browser each round; this script guards
// the layer under them so a relay/dependency update can't rot silently.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SignClient } from '@walletconnect/sign-client';
import { Wallet, getBytes, verifyMessage } from 'ethers';

const PROJECT_ID = '99909bde486039e2102663b92be74974';
const MSG = '0x68656c6c6f2062656172'; // "hello bear", the same shape the UI signs
const METHODS = ['eth_requestAccounts', 'eth_accounts', 'personal_sign'];

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
  const signer = Wallet.createRandom();
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
const fail = (m) => {
  console.error('[e2e-wc] FAIL:', m);
  try { walletProc?.kill('SIGKILL'); } catch { /* already gone */ }
  process.exit(1);
};
setTimeout(() => fail('global timeout 120s'), 120000);

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
    eip155: { methods: ['eth_requestAccounts', 'personal_sign'], chains: ['eip155:1'], events: [] },
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

await dapp.disconnect({ topic: session.topic }).catch(() => {});
child.stdin.end();
await new Promise((r) => child.on('exit', r));
log('PASS: full WC protocol round-trip in two processes (pair → approve → accounts → sign → verify → disconnect)');
process.exit(0);
