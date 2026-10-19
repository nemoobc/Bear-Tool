// Bear Tool — js/dex/list.js
// M6: deleting a coin from YOUR feed — for real.
//
// A coin on the chain cannot be deleted: the contract exists, the trades exist,
// the price is real. But the FEED is ours, and "delete" must mean delete. So:
//
//   • the coin leaves the feed (tokens.js filters it out),
//   • a tombstone here keeps it gone: the chain scan re-finds the factory's
//     Launched log and would otherwise put the coin back on the grid — a
//     resurrection that reads as "delete didn't work". The tombstone wins,
//   • nothing in the UI restores it. The tombstone is an implementation
//     detail of permanence, not a surface (DEX-V2 §2.2 #8, the 2026-10-15
//     "bener-bener hapus bukan hide" order).
//
// Per chain: deleting a Sepolia coin must not delete a mainnet one.

const KEY = (chainId) => `bear.dex.deleted.${Number(chainId) & 0xffffffff}`;

function readAddresses(chainId) {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY(chainId)) || '[]');
    if (!Array.isArray(raw)) return [];
    // Addresses only, lowercased. Anything else in storage is ignored rather
    // than trusted — this list is written from innerHTML-adjacent code, and a
    // stray object must not become a key we later compare against.
    return raw
      .filter((x) => typeof x === 'string' && /^0x[0-9a-fA-F]{40}$/.test(x))
      .map((x) => x.toLowerCase());
  } catch {
    return [];
  }
}

/** The tombstones for this chain, deduped, lowercase. */
export function deletedList(chainId) {
  return [...new Set(readAddresses(chainId))];
}

/** Mark a coin gone — permanently as far as this app is concerned. */
export function rememberDeleted(chainId, token) {
  const t = String(token || '').toLowerCase();
  if (!/^0x[0-9a-fA-F]{40}$/.test(t)) return;
  try {
    localStorage.setItem(KEY(chainId), JSON.stringify([...new Set([...readAddresses(chainId), t])]));
  } catch { /* private mode */ }
}

/** Filter helper for the feed: keep only coins with no tombstone. */
export function withoutDeleted(rows, chainId) {
  const gone = new Set(deletedList(chainId));
  return (rows || []).filter((r) => !gone.has(String(r?.token || '').toLowerCase()));
}
