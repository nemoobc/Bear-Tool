// Which stablecoin on Polygon actually has a QuickSwap pair, measured.
//
// Why: the swap test picked its stable from the KNOWN_TOKENS table, and on
// Polygon that row points at 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174. The
// quote call succeeded against a fork and the swap transaction then reverted with
// INSUFFICIENT_INPUT_AMOUNT — which reads like a router problem and is not one.
// It is the difference between "a pair address exists" and "the pair holds
// reserves the router can spend", and only a reserve read tells them apart.
//
// So: no address is taken from memory here either. Every candidate is asked what
// the chain says, and the answer goes in the table. Polygon migrated its bridged
// USDC to a native token, and the address that used to be the obvious answer is
// exactly the kind of thing that goes stale without anything failing loudly.
//
//   node tools/probe-polygon-stables.mjs
//   FORK_NETWORK=polygon FORK_PORT=8547 node tools/probe-polygon-stables.mjs

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

// Windows: a dynamic import of an absolute path is rejected outright —
// ERR_UNSUPPORTED_ESM_URL_SCHEME, "Received protocol 'c:'". It must be a file://
// URL. Not a Windows quirk to work around; it is how the ESM loader is specified,
// and every dynamic import in this file has to go through pathToFileURL.
const load = (rel) => import(pathToFileURL(path.join(repoRoot, rel)).href);

const { getRouterAddress } = await load('js/routers.js');
const { NETWORKS: NET_LIST } = await load('js/network.js');
const ethers = await import('ethers');
const { JsonRpcProvider, Contract } = ethers;

const NET = process.env.FORK_NETWORK || 'polygon';
const PORT = process.env.FORK_PORT || '8551';
const VENUE = process.env.PROBE_VENUE || 'quickswap';

const NETWORKS = NET_LIST || NET_LIST.default?.NETWORKS || NET_LIST.default;
// The matching key is `id`, not `name`: network.js carries id: 'polygon' with
// name: 'Polygon' for display. Matching on `name` finds nothing, and an error
// that says only "unknown network" sends the next reader off to guess field
// names. So the message lists what is actually there.
const net = NETWORKS.find((n) => n.id === NET || String(n.chainId) === NET);
if (!net) {
  console.error(`jaringan tidak dikenal: ${NET}`);
  console.error(`id yang tersedia: ${NETWORKS.map((n) => n.id).join(', ')}`);
  process.exit(2);
}
const routerAddr = getRouterAddress(VENUE, net.chainId);
if (!routerAddr) { console.error(`tidak ada address untuk ${VENUE} di chain ${net.chainId}`); process.exit(2); }

const RPCS = net.rpc || [];
if (!RPCS.length) { console.error(`tidak ada rpc untuk ${net.id}`); process.exit(2); }

console.log(`jaringan  ${net.id} (${net.name})  chainId=${net.chainId}`);
console.log(`router    ${VENUE} = ${routerAddr}`);
console.log(`rpc       ${RPCS[0]}`);
console.log('');

// The candidates, each with why it is here. Written out rather than derived, so
// a future reader can see the whole candidate set and not just the winner.
const CANDIDATES = [
  { addr: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', label: 'USDC.e (bridged)' },
  { addr: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', label: 'USDC (native)' },
  { addr: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', label: 'USDT' },
  { addr: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063', label: 'DAI' },
  { addr: '0x4d2f4f3F6Bd1EE9D1e0ACdBE7C6D1e0B2e3a4c5d', label: 'USDC (placeholder, sengaja salah)' },
];

const ROUTER_ABI = [
  'function WETH() external view returns (address)',
  'function factory() external view returns (address)',
  'function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)',
];
const FACTORY_ABI = ['function getPair(address, address) external view returns (address)'];
const PAIR_ABI = [
  'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() external view returns (address)',
  'function token1() external view returns (address)',
];
const ERC20_ABI = [
  'function symbol() external view returns (string)',
  'function decimals() external view returns (uint8)',
  'function totalSupply() external view returns (uint256)',
];

// The fork lives on a private port, so this probe never collides with a running
// suite. A collision here would adopt the wrong chain and report a wrong answer,
// which is the failure this harness was written to end.
const PORT_P = Number(PORT);
let anvil = null;

async function withFork(fn) {
  const rpc = RPCS[0];
  const child = spawn('anvil', [
    '--fork-url', rpc,
    '--port', String(PORT_P),
    '--silent',
    '--allow-origin', '*',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c.toString(); });
  anvil = child;

  // Wait for the port, by asking the chain — not by sleeping a guessed interval.
  const provider = new JsonRpcProvider(`http://127.0.0.1:${PORT_P}`, undefined, { staticNetwork: true });
  let chainId = null;
  for (let i = 0; i < 60; i++) {
    try {
      const got = await provider.send('eth_chainId', []);
      chainId = parseInt(got, 16);
      break;
    } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  if (chainId !== Number(net.chainId)) {
    child.kill();
    console.error(`anvil tidak siap atau chain salah (dapat ${chainId}, mau ${net.chainId})`);
    console.error(stderr.split('\n').slice(-5).join('\n'));
    process.exit(2);
  }
  try {
    return await fn(provider);
  } finally {
    child.kill();
  }
}

await withFork(async (provider) => {
  const router = new Contract(routerAddr, ROUTER_ABI, provider);
  const weth = (await router.WETH()).toLowerCase();
  const factoryAddr = (await router.factory()).toLowerCase();
  const factory = new Contract(factoryAddr, FACTORY_ABI, provider);

  console.log(`WETH()    ${weth}`);
  console.log(`factory() ${factoryAddr}`);
  console.log('');

  const ZERO = '0x0000000000000000000000000000000000000000';
  const pairAddr = String(await factory.getPair(weth, CANDIDATES[0].addr)).toLowerCase();
  console.log(`cek silang: factory.getPair(${weth.slice(0, 10)}…, USDC.e) = ${pairAddr}` +
    (pairAddr === ZERO ? '   ← nol: TIDAK ada pair' : ''));
  console.log('');
  console.log('kandidat            pair ada?   reserve0/1 (terbaca)                        getAmountsOut(1 WETH)');
  console.log('-'.repeat(112));

  const results = [];
  // A missing pair comes back as the zero address, not as "0x". The first version
  // of this probe compared against the string '0x', so the deliberately-wrong
  // control address sailed through the "has a pair" column — the control was not
  // controlling anything, and the table below it looked more confident than the
  // evidence allowed.
  for (const c of CANDIDATES) {
    const addr = c.addr.toLowerCase();
    let pair = ZERO;
    try { pair = String(await factory.getPair(weth, addr)).toLowerCase(); } catch { pair = 'error'; }
    const hasPair = pair !== ZERO && pair !== 'error';

    let resv = '—';
    if (hasPair) {
      try {
        const p = new Contract(pair, PAIR_ABI, provider);
        const r = await p.getReserves();
        resv = `${r.reserve0.toString().padStart(22)} / ${r.reserve1.toString().padStart(22)}`;
      } catch (e) { resv = `baca gagal: ${(e.shortMessage || e.message).slice(0, 40)}`; }
    } else {
      resv = hasPair ? '—' : 'tidak ada pair';
    }

    let quote = '—';
    if (hasPair) {
      try {
        const amts = await router.getAmountsOut(10n ** 18n, [weth, addr]);
        quote = `${amts[1].toString()}`;
      } catch (e) {
        quote = `GAGAL: ${(e.shortMessage || e.message).slice(0, 46)}`;
      }
    }

    // symbol/decimals, so the winning row is identifiable in the table without
    // the reader having to look the address up.
    let sym = '?';
    try { sym = await new Contract(addr, ERC20_ABI, provider).symbol(); } catch { sym = 'bukan ERC20'; }

    const ok = hasPair && /^\d+$/.test(quote) && BigInt(quote) > 0n;
    results.push({ ...c, addr, hasPair, quote, ok, sym });
    console.log(
      `${(c.label + ' ').padEnd(20, '.')} ${hasPair ? 'ya' : 'TIDAK'}    ${resv.padEnd(40)} ${quote}`
    );
  }

  console.log('');
  const winners = results.filter((r) => r.ok);
  if (!winners.length) {
    console.log('HASIL: tidak ada kandidat yang bisa dipakai. Jangan menebak — periksa likuiditas pair.');
  } else {
    console.log('HASIL: kandidat yang bisa dipakai untuk swap:');
    for (const w of winners) console.log(`  ${w.label.padEnd(20)} ${w.addr}  (symbol on-chain: ${w.sym})`);
  }
});
