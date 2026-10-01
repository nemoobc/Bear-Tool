// Probe retention & stabilitas kandidat RPC polygon publik — pemilih RPC fork.
//
// Anvil di-fork pada block PIN (eth_blockNumber saat start), lalu suite menggiling
// beberapa menit. Endpoint non-archive (publicnode polygon = full node biasa)
// melepas state pin setelah jendela retention singkat → eth_getCode/eth_call pada
// pin mulai menjawab `historical state ... is not available` — DETERMINISTIS, bukan
// flake, jadi retry tidak menolong. Tercoda nyata: fork-poly4 no-code PASS (20s),
// fork-poly5 no-code FAIL (24m setelah pin menua) di endpoint yang sama.
//
// Syarat lolos (diurutkan):
//   1. serve state di N-10000 (~6 jam lalu)  → retention > durasi suite mana pun
//   2. serve state di N-50000 (~1 hari lalu)  → bonus, arsip sungguhan
//   3. 3× eth_call decimals di pin terkini tanpa error 5xx → backend stabil
//
// Pemakaian: node tests/fork/probe-polygon-rpc.mjs
// (Fork-helper memakai kandidat terbaik; hasilnya dicatat di komentar FORK_NETWORKS.)

const CANDIDATES = [
  'https://polygon-bor-rpc.publicnode.com', // endpoint sekarang — kontrol
  'https://polygon-rpc.com',
  'https://1rpc.io/matic',
  'https://polygon.drpc.org',
  'https://polygon-mainnet.public.blastapi.io',
  'https://polygon.api.onfinality.io/public',
  'https://rpc.ankr.com/polygon',
  'https://polygon-bor.gateway.tenderly.co',
];

const ROUTER = '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff'; // QuickSwap V2 router
const DECIMALS_CALL = '0x313ce567';                          // decimals()
const USDC = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

let id = 0;
async function rpc(url, method, params, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (j.error) throw new Error(`${j.error.code}: ${String(j.error.message).slice(0, 70)}`);
    return j.result;
  } finally {
    clearTimeout(t);
  }
}

const hexBlock = (n) => '0x' + n.toString(16);

const rows = [];
for (const url of CANDIDATES) {
  const row = { url, ok: false, depth6h: false, depth1d: false, stable: 0, err: '' };
  try {
    const headHex = await rpc(url, 'eth_blockNumber', []);
    const head = parseInt(headHex, 16);
    row.ok = true;

    // 1. retention: state 10rb block lalu HARUS terlayani
    try {
      await rpc(url, 'eth_getCode', [ROUTER, hexBlock(head - 10_000)]);
      row.depth6h = true;
    } catch (e) { row.err = `6h: ${e.message}`; }

    // 2. bonus: state 50rb block lalu (arsip sungguhan)
    try {
      await rpc(url, 'eth_getCode', [ROUTER, hexBlock(head - 50_000)]);
      row.depth1d = true;
    } catch (e) { if (!row.err) row.err = `1d: ${e.message}`; }

    // 3. stabilitas: 3× eth_call decimals pada USDC (latest)
    for (let i = 0; i < 3; i++) {
      try {
        await rpc(url, 'eth_call', [{ to: USDC, data: DECIMALS_CALL }, 'latest']);
        row.stable++;
      } catch { /* hitung */ }
    }
  } catch (e) {
    row.err = e.message;
  }
  rows.push(row);
}

const mark = (b) => (b ? '✓' : '✗');
console.log('RPC'.padEnd(46), 'OK  6h  1d  call×3  err');
for (const r of rows) {
  console.log(
    r.url.padEnd(46),
    `${mark(r.ok)}    ${mark(r.depth6h)}   ${mark(r.depth1d)}   ${r.stable}/3      ${r.err}`,
  );
}
const best = rows.filter((r) => r.depth6h && r.stable === 3)
  .sort((a, b) => Number(b.depth1d) - Number(a.depth1d));
console.log('\nLOLOS (retention 6h + 3/3 stabil):', best[0]?.url ?? 'TIDAK ADA');
