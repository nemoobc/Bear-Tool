// Temporary CI probe (branch ci/setbalance-probe): why does ethers getBalance
// return 0 while raw eth_getBalance returns the funded value, on the same
// node, milliseconds apart? v3: capture ethers' resolved blockTag + prove the
// historical-block path serves fork state (no local override).
import { spawnSync } from 'node:child_process';
import { startFork, stopFork } from '../tests/fork/fork-helper.mjs';

const PORT = Number(process.env.FORK_PORT || 8545);
const ADDR = '0x01477a9A2135ab4ce46C08c52Bd8fb41f76e15bd';
const FUND = '0xb5e620f48000'; // 0.75 ETH
const log = (...a) => console.log('[probe]', ...a);

log('node:', process.version);
const av = spawnSync('anvil', ['--version'], { encoding: 'utf8' });
log('anvil:', (av.stdout || av.stderr || 'NOT FOUND').trim().split('\n')[0]);

const { provider, network } = await startFork();
log('fork:', network.name, 'chainId', network.chainId);

const raw = async (method, params) => {
  const r = await fetch(`http://127.0.0.1:${PORT}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return r.json();
};

// Capture what ethers resolves BEFORE it becomes wire traffic.
if (typeof provider._perform === 'function') {
  const orig = provider._perform.bind(provider);
  provider._perform = (op) => {
    log('_perform:', JSON.stringify(op));
    return orig(op);
  };
} else {
  log('_perform: NOT AVAILABLE on this ethers build');
}

log('balBefore ethers:', String(await provider.getBalance(ADDR)));
log('setBalance:', JSON.stringify(await raw('anvil_setBalance', [ADDR, FUND])));
log('raw latest:', JSON.stringify(await raw('eth_getBalance', [ADDR, 'latest'])));
log('balAfter ethers:', String(await provider.getBalance(ADDR)));

// If historical state wins over the local override, a block-number query for
// the SAME balance returns fork state instead of the cheatcode value.
const tip = parseInt((await raw('eth_blockNumber', [])).result, 16);
log('raw at tip-as-number:', JSON.stringify(await raw('eth_getBalance', [ADDR, '0x' + tip.toString(16)])));
log('raw at 0x1 (historical):', JSON.stringify(await raw('eth_getBalance', [ADDR, '0x1'])));

await stopFork();
