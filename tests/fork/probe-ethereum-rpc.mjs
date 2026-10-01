// Probe retention & stabilitas kandidat RPC ethereum publik — pemilih RPC fork.
// Sama bentuknya dengan probe-polygon-rpc.mjs (lihat di sana untuk alasan pin /
// arsip); kandidat + pemeriksaan disetel untuk chain 1.
//
// Bukti kegagalan yang mendorong probe ini: wave CI 36919619612 — kode identik
// dengan wave 12/12 hijau 36913592697, tapi round-trip Uniswap V2 revert
// status=0 logs=[] padahal minOut sudah 1% longgar. Temuan: quote (baca)
// sukses, eksekusi (miner, state fetch terpisah) membaca slot yang tidak sama
// → kelas foundry#4700: fetch upstream yang diam-diam gagal saat run, anvil
// menjawab kosong. Endpoint yang stabil & arsip = vaksinnya.
//
// Pemakaian: node tests/fork/probe-ethereum-rpc.mjs

const CANDIDATES = [
  'https://ethereum-rpc.publicnode.com', // endpoint sekarang — kontrol
  'https://eth.drpc.org',                // lolos probe polygon (arsip + stabil)
  'https://1rpc.io/eth',
  'https://rpc.ankr.com/eth',
  'https://ethereum.api.onfinality.io/public',
  'https://eth.llamarpc.com',
  'https://ethereum-mainnet.public.blastapi.io',
];

const ROUTER = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D'; // Uniswap V2 router
const DECIMALS_CALL = '0x313ce567';                          // decimals()
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

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
      await rpc(url, 'eth_getCode', [ROUTER, hexBlock(head - 10_000)]);
      row.depth6h = true;
    } catch (e) { row.err = `6h: ${e.message}`; }
    try {
      await rpc(url, 'eth_getCode', [ROUTER, hexBlock(head - 50_000)]);
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
