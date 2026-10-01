// Temporary CI probe v4 (branch ci/setbalance-probe): wire-tap. ethers talks
// to a local proxy that logs the exact bytes both ways, then forwards to the
// real anvil. If the tap shows eth_getBalance latest → 0x0, the difference is
// on the wire; if it shows the funded value, ethers is misreading the reply.
import http from 'node:http';
import { startFork, stopFork } from '../tests/fork/fork-helper.mjs';

const PORT = Number(process.env.FORK_PORT || 8545);
const ADDR = '0x01477a9A2135ab4ce46C08c52Bd8fb41f76e15bd';
const FUND = '0xb5e620f48000';
const log = (...a) => console.log('[probe]', ...a);

const { network } = await startFork();
log('fork:', network.name, 'chainId', network.chainId);

const wire = [];
const proxy = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', async () => {
    wire.push(`REQ ${body}`);
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body,
      });
      const text = await r.text();
      wire.push(`RES ${text}`);
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(text);
    } catch (e) {
      wire.push(`ERR ${String(e)}`);
      res.writeHead(502); res.end(String(e));
    }
  });
});
await new Promise((r) => proxy.listen(9545, r));
log('proxy on 9545 → 8545');

const { ethers } = await import('ethers');
const p = new ethers.JsonRpcProvider('http://127.0.0.1:9545');
if (typeof p._perform === 'function') {
  const orig = p._perform.bind(p);
  p._perform = (op) => { log('_perform:', JSON.stringify(op)); return orig(op); };
}

const raw = async (method, params) => {
  const r = await fetch(`http://127.0.0.1:${PORT}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return r.json();
};

log('balBefore ethers:', String(await p.getBalance(ADDR)));
log('setBalance:', JSON.stringify(await raw('anvil_setBalance', [ADDR, FUND])));
log('raw latest (direct):', JSON.stringify(await raw('eth_getBalance', [ADDR, 'latest'])));
wire.length = 0;
log('balAfter ethers (tapped):', String(await p.getBalance(ADDR)));
for (const l of wire) log(l);

proxy.close();
await stopFork();
