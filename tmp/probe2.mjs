// Replika persis test1 custom-rpc-active — cetak endpoint & resolusi.
import net from 'node:net';

const store = new Map();
globalThis.localStorage ??= {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};
globalThis.document ??= {
  querySelector: () => null, querySelectorAll: () => [],
  addEventListener() {}, body: { style: {} },
};
globalThis.window ??= { addEventListener() {} };
globalThis.matchMedia ??= (() => ({ matches: false }));
globalThis.ethers ??= (await import('ethers')).ethers;

console.log('localStorage type =', typeof globalThis.localStorage);

const state = await import('../js/state.js');
const { getProvider, NETWORKS, getAllNetworks, getRpcOverrides } = await import('../js/network.js');

function listen(s) { return new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port))); }
function tinyRpc(result, chainIdHex) {
  const srv = net.createServer((sock) => {
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk.toString();
      const h = buf.indexOf('\r\n\r\n'); if (h < 0) return;
      const len = Number((/content-length:\s*(\d+)/i.exec(buf.slice(0, h)) || [])[1] || 0);
      const body = buf.slice(h + 4, h + 4 + len); if (body.length < len) return;
      buf = buf.slice(h + 4 + len);
      let method = ''; let id = 1;
      try { method = JSON.parse(body)?.method || ''; id = JSON.parse(body)?.id ?? 1; } catch { /* noop */ }
      const out = JSON.stringify({ jsonrpc: '2.0', id, ...(method === 'eth_chainId' ? { result: chainIdHex } : { result }) });
      sock.write(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${out.length}\r\nConnection: keep-alive\r\n\r\n${out}`);
    });
    sock.on('error', () => {});
  });
  return srv;
}

const SEPOLIA = 11155111;
const a = tinyRpc('0x56bc75e2d63100000', '0xaa36a7');
const b = tinyRpc('0x0', '0xaa36a7');
const portA = await listen(a);
const portB = await listen(b);
console.log('A(custom,100) =', portA, ' B(builtin,0) =', portB);

const builtin = NETWORKS.find(n => n.chainId === SEPOLIA);
const orig = builtin.rpc;
builtin.rpc = [`http://127.0.0.1:${portB}`];
localStorage.setItem('bear.customNetworks', JSON.stringify([
  { id: 'custom-live-funded', chainId: SEPOLIA, name: 'Sepolia (local fork)', symbol: 'ETH', decimals: 18, type: 'testnet', custom: true, rpc: [`http://127.0.0.1:${portA}`] },
]));
state.set('networkId', 'custom-live-funded');
console.log('networkId =', state.get('networkId'));
const activeId = state.get('networkId');
const active = getAllNetworks().find(n => n.id === activeId && n.chainId === SEPOLIA);
console.log('active =', active ? `${active.id} -> ${active.rpc[0]}` : 'NONE');
console.log('overrides =', JSON.stringify(getRpcOverrides()));

const provider = await getProvider(SEPOLIA);
console.log('bearer endpoint =', provider.bearEndpoint);
const bal = await provider.getBalance('0x197bCec95428789cB037F83d67e6306A7D29bC2D');
console.log('balance =', bal.toString());

builtin.rpc = orig;
for (const s of [a, b]) { try { s.closeAllConnections?.(); s.close(); } catch { /* noop */ } }
