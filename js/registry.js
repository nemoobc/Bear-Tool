// ═══════════════════════════════════════════════════════════════
// Bear Tool — registry.js
// Deployed-contract registry (localStorage): helper contracts
// deployed via EIP-7702 flows (batch/rescue/airdrop/proxy/revoker).
// Persisted per chain so contracts can be REUSED (gas savings)
// instead of redeployed on every execution. Entries are validated
// (checksummed address + positive chainId) and deduped.
// ═══════════════════════════════════════════════════════════════

const { ethers } = globalThis;

const REGISTRY_KEY = 'bear.deployedContracts';
// 'token' = contracts deployed by the Deploy wizard (ERC-20/721/1155)
const TYPES = ['batch', 'rescue', 'airdrop', 'proxy', 'revoker', 'token'];

function emptyRegistry() {
  return { batch: [], rescue: [], airdrop: [], proxy: [], revoker: [], token: [] };
}

export function isValidAddress(a) {
  try { ethers.getAddress(String(a)); return true; } catch { return false; }
}

// Load + sanitize the registry. Never throws — a corrupt entry is dropped.
export function loadRegistry() {
  try {
    const data = JSON.parse(localStorage.getItem(REGISTRY_KEY) || 'null');
    if (!data || typeof data !== 'object') return emptyRegistry();
    const out = emptyRegistry();
    for (const type of TYPES) {
      const list = Array.isArray(data[type]) ? data[type] : [];
      out[type] = list.filter(item =>
        item && typeof item === 'object' &&
        typeof item.address === 'string' && isValidAddress(item.address) &&
        Number.isInteger(Number(item.chainId)) && Number(item.chainId) > 0
      );
    }
    return out;
  } catch { return emptyRegistry(); }
}

function persist(reg) {
  localStorage.setItem(REGISTRY_KEY, JSON.stringify(reg));
}

// Save a deployed contract. Dedupes on (type, address, chainId) — a
// re-deploy of the same contract on the same chain replaces the old entry.
export function saveDeployed(type, address, extra = {}) {
  if (!TYPES.includes(type)) throw new Error('Unknown registry type: ' + type);
  if (!isValidAddress(address)) throw new Error('Invalid contract address');
  const chainId = Number(extra.chainId ?? 0);
  if (!Number.isInteger(chainId) || chainId <= 0) throw new Error('Invalid chainId');
  const reg = loadRegistry();
  const addr = ethers.getAddress(address);
  reg[type] = reg[type].filter(item =>
    !(item.address.toLowerCase() === addr.toLowerCase() && Number(item.chainId) === chainId)
  );
  reg[type].push({ address: addr, chainId, ts: Date.now(), ...extra });
  persist(reg);
  return reg[type];
}

// Find a deployed contract by type + chainId (+ optional predicate).
export function findDeployed(type, chainId, predicate) {
  const list = loadRegistry()[type] || [];
  return list.find(item =>
    Number(item.chainId) === Number(chainId) && (!predicate || predicate(item))
  ) || null;
}

// List deployed contracts of a type, optionally filtered by chainId.
export function listDeployed(type, chainId) {
  const list = loadRegistry()[type] || [];
  return chainId === undefined ? list : list.filter(item => Number(item.chainId) === Number(chainId));
}

// Remove one entry. Returns true if something was removed.
export function removeDeployed(type, address, chainId) {
  const reg = loadRegistry();
  const before = reg[type].length;
  reg[type] = reg[type].filter(item =>
    !(item.address.toLowerCase() === String(address).toLowerCase() && Number(item.chainId) === Number(chainId))
  );
  persist(reg);
  return reg[type].length < before;
}

export function clearRegistry() {
  persist(emptyRegistry());
}