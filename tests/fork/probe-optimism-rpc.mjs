// Probe retention & stabilitas kandidat RPC optimism publik — pemilih RPC fork.
// Bentuk sama dengan probe-polygon-rpc.mjs; kandidat + WETH predeploy OP.
//
// Bukti yang mendorong probe ini: wave CI 36921954638 — Fork optimism gagal
// '7702 helper deployment receipt: timed out after 45000ms (attempt 3/3)'.
// Receipt tx lokal anvil seharusnya instan; timeout berarti anvil menggantung
// menunggu fetch upstream (mainnet.optimism.io) saat membuat kontrak → kelas
// stall yang sama dengan throttle publicnode. Endpoint stabil = vaksinnya.
//
// Pemakaian: node tests/fork/probe-optimism-rpc.mjs

const CANDIDATES = [
  'https://mainnet.optimism.io',                 // endpoint sekarang — kontrol
  'https://optimism.drpc.org',
  'https://optimism-rpc.publicnode.com',
  'https://1rpc.io/op',
  'https://rpc.ankr.com/optimism',
  'https://optimism.api.onfinality.io/public',
  'https://optimism.llamarpc.com',
];

const WETH = '0x4200000000000000000000000000000000000006'; // predeploy OP
const DECIMALS_CALL = '0x313ce567';

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
    const head = parseInt(await rpc(url, 'eth_blockNumber', []), 16);
    row.ok = true;
    try {
      await rpc(url, 'eth_getCode', [WETH, hexBlock(head - 10_000)]);
      row.depth6h = true;
    } catch (e) { row.err = `6h: ${e.message}`; }
    try {
      await rpc(url, 'eth_getCode', [WETH, hexBlock(head - 50_000)]);
      row.depth1d = true;
    } catch (e) { if (!row.err) row.err = `1d: ${e.message}`; }
    for (let i = 0; i < 3; i++) {
      try {
        await rpc(url, 'eth_call', [{ to: WETH, data: DECIMALS_CALL }, 'latest']);
        row.stable++;
      } catch { /* hitung */ }
    }
  } catch (e) {
    row.err = e.message;
  }
  rows.push(row);
}

const mark = (b) => (b ? '✓' : '✗');
console.log('RPC'.padEnd(48), 'OK  6h  1d  call×3  err');
for (const r of rows) {
  console.log(
    r.url.padEnd(48),
    `${mark(r.ok)}    ${mark(r.depth6h)}   ${mark(r.depth1d)}   ${r.stable}/3      ${r.err}`,
  );
}
const best = rows.filter((r) => r.depth6h && r.stable === 3)
  .sort((a, b) => Number(b.depth1d) - Number(a.depth1d));
console.log('\nLOLOS (retention 6h + 3/3 stabil):', best[0]?.url ?? 'TIDAK ADA');
