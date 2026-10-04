// probe resolusi getProvider — jalankan: node tmp/probe.mjs
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

const state = await import('../js/state.js');
const net = await import('../js/network.js');

localStorage.setItem('bear.customNetworks', JSON.stringify([
  {
    id: 'custom-live-funded', chainId: 11155111, name: 'X',
    symbol: 'ETH', decimals: 18, type: 'testnet', custom: true,
    rpc: ['http://127.0.0.1:1'],
  },
]));
state.set('networkId', 'custom-live-funded');

console.log('state networkId =', JSON.stringify(state.get('networkId')));
console.log('settings =', JSON.stringify(state.get('settings')));
const matches = net.getAllNetworks().filter(n => n.chainId === 11155111);
console.log('kandidat chainId 11155111 =', matches.map(n => `${n.id}@${n.rpc[0]}`));
const activeId = state.get('networkId');
const active = net.getAllNetworks().find(n => n.id === activeId && n.chainId === 11155111);
console.log('active (logika fix) =', active ? `${active.id} -> ${active.rpc[0]}` : 'TIDAK KETEMU');
