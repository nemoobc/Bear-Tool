// Temporary CI probe (branch ci/setbalance-probe): does anvil_setBalance stick
// on a fork in the GitHub runner? Reproduces journey.test.js:211 in isolation:
// fresh anvil fork, raw JSON-RPC, no test framework in the way.
//
// Prints environment (node, anvil), whether port 8545 was already taken, and
// every response on the path: setBalance -> eth_getBalance raw -> ethers.
import { spawnSync } from 'node:child_process';
import { startFork, stopFork } from '../tests/fork/fork-helper.mjs';

const PORT = Number(process.env.FORK_PORT || 8545);
const ADDR = '0x01477a9A2135ab4ce46C08c52Bd8fb41f76e15bd'; // same shape as CI wallet
const FUND = '0xb5e620f48000'; // 0.75 ETH, same as journey.test.js

const log = (...a) => console.log('[probe]', ...a);

log('node:', process.version);
const av = spawnSync('anvil', ['--version'], { encoding: 'utf8' });
log('anvil:', (av.stdout || av.stderr || 'NOT FOUND').trim().split('\n')[0]);

// Was something already listening on the port before we start (adoption race)?
const pre = await fetch(`http://127.0.0.1:${PORT}`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
}).then((r) => r.json()).catch((e) => ({ error: String(e) }));
log('port pre-start:', JSON.stringify(pre));

const { provider, network } = await startFork();
log('fork:', network.name, 'chainId', network.chainId, 'rpc', network.rpc);

const raw = async (method, params) => {
  const r = await fetch(`http://127.0.0.1:${PORT}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return r.json();
};

log('balBefore ethers:', String(await provider.getBalance(ADDR)));
const sb = await raw('anvil_setBalance', [ADDR, FUND]);
log('setBalance resp:', JSON.stringify(sb));
const after1 = await raw('eth_getBalance', [ADDR, 'latest']);
log('eth_getBalance(latest) raw:', JSON.stringify(after1));
const after2 = await raw('eth_getBalance', [ADDR, '0x0']);
log('eth_getBalance(0) raw:', JSON.stringify(after2));
log('balAfter ethers:', String(await provider.getBalance(ADDR)));
const blk = await raw('eth_blockNumber', []);
log('blockNumber:', JSON.stringify(blk));

const bal = after1?.result ? BigInt(after1.result) : -1n;
log('VERDICT:', bal === BigInt(parseInt(FUND, 16)) ? 'setBalance STICKS' : 'setBalance NO-OP');

await stopFork();

// ── v2: exact wire traffic — why does ethers disagree with raw? ──
const { provider: p2 } = await (async () => {
  await stopFork();
  return startFork();
})();
p2.on('debug', (d) => {
  if (d.action === 'request') log('ethers REQ:', JSON.stringify(d.request));
  if (d.action === 'response') log('ethers RES:', JSON.stringify(d.response));
});
try { log('ethers url:', p2._getConnection().url); } catch (e) { log('url ?', String(e)); }
log('v2 balBefore:', String(await p2.getBalance(ADDR)));
log('v2 setBalance:', JSON.stringify(await raw('anvil_setBalance', [ADDR, FUND])));
log('v2 raw latest:', JSON.stringify(await raw('eth_getBalance', [ADDR, 'latest'])));
log('v2 balAfter ethers:', String(await p2.getBalance(ADDR)));
await stopFork();
