// Bear Tool — js/dex/pools.js
// Finding the pools, from the chain rather than from a notebook.
//
// The v2 DEX has ONE factory per chain (bear-source.js, BearFactory). Every
// pool starts life as one of its two events:
//
//   Launched(creator indexed, token indexed, pair indexed, quote)   — a launch
//   PoolCreated(creator indexed, token indexed, pair indexed, quote) — an
//   existing token getting a pool
//
// Discovery is therefore a single filtered log query against the factory — the
// same discipline the old launchpad feed used (one query, not a chain scan),
// with two v2 changes:
//
//   • The event no longer carries name/symbol. Carrying four strings through
//     the launch transaction blew the EVM stack, and metadata belongs to the
//     token contract anyway. Rows resolve metadata from (in order): the local
//     index of coins this device launched → a per-chain metadata cache → the
//     token contract itself. Immutable after deploy, so the cache never lies.
//   • The factory address is configuration, not a constant: the app deploys
//     the factory (one tx, one time) and remembers it. No factory stored =
//     'no factory' — a state the feed must say out loud instead of showing
//     an empty list.
//
// The three outcomes stay apart (found / found none / could not look), because
// collapsing them into an empty list is exactly the lie this module exists to
// prevent.

import { get } from '../state.js';
import { provider, ethersLib, dexChainOk, isAddr, DEX_CHAIN_ID } from './core.js';
import { factoryAddress } from './factory.js';

// The factory address lives in js/dex/factory.js (one source of truth, with
// its deploy path); discovery reads it through here so callers of this module
// need no second import.
export { factoryAddress, setFactoryAddress } from './factory.js';

// How far back to look. Bounded on purpose: a launchpad that opens its log
// query from genesis on a mature chain hangs, and a hang is worse than a short
// window. The window is widened only when the last page came back full, which
// is what `more` reports.
const DEFAULT_LOOKBACK = 50_000;
const PAGE_SIZE = 2_000;

const LAUNCHED_SIG = 'Launched(address,address,address,address)';
const POOL_CREATED_SIG = 'PoolCreated(address,address,address,address)';

// Remembers how far back we have already looked, so paging deeper does not
// re-scan the same blocks on every feed open.
const cursor = { at: DEFAULT_LOOKBACK };

/** How far back discovery currently searches. */
export function lookbackBlocks() { return cursor.at; }

/** Reset the window — used by tests, and by a chain/factory switch. */
export function resetDiscovery(blocks = DEFAULT_LOOKBACK) { cursor.at = blocks; }

// --- metadata: name/symbol come from the token, once, then from cache ---

const META_KEY = 'bear.dex.meta';

function metaStoreKey() { return `${META_KEY}.${DEX_CHAIN_ID}`; }

function readMetaCache() {
  try {
    const raw = JSON.parse(localStorage.getItem(metaStoreKey()) || '{}');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function writeMetaCache(map) {
  try {
    localStorage.setItem(metaStoreKey(), JSON.stringify(map));
  } catch {
    // Quota/private mode: the read still happened, the next open just reads
    // again. Never throws a user's feed over a cache write.
  }
}

/** Cached metadata for one token, or null. */
export function cachedMeta(address) {
  const a = String(address || '').toLowerCase();
  const hit = readMetaCache()[a];
  if (!hit || typeof hit !== 'object') return null;
  return { name: String(hit.name || ''), symbol: String(hit.symbol || '') };
}

/**
 * Fill name/symbol on rows from local knowledge → cache → the token contract.
 *
 * Metadata is immutable after deploy (constructor-set, no setters), so a read
 * is forever-true and cacheable. Rows that already carry a name from the local
 * index are trusted and cached — the launcher typed it into the same contract.
 * Chain reads run bounded-parallel so a 20-row feed does not serialize 40
 * round-trips on a public RPC.
 *
 * Returns the rows with name/symbol filled where resolvable; a token that will
 * not answer keeps empty strings and renders as an address, not as a fake name.
 */
export async function fillMeta(rows, { concurrency = 6 } = {}) {
  const p = provider();
  const E = ethersLib();
  const cache = readMetaCache();
  const out = rows.map((r) => ({ ...r }));
  const missing = [];

  for (const row of out) {
    const a = String(row.address || '').toLowerCase();
    if (!isAddr(a)) continue;
    if (row.name && row.symbol) {
      cache[a] = { name: row.name, symbol: row.symbol };
      continue;
    }
    const hit = cache[a];
    if (hit) {
      row.name = row.name || hit.name || '';
      row.symbol = row.symbol || hit.symbol || '';
      continue;
    }
    missing.push(row);
  }

  if (missing.length && p && E) {
    let next = 0;
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= missing.length) return;
        const row = missing[i];
        try {
          // BEAR_TOKEN_ABI is the token the factory deploys; a pool over an
          // existing token reads the same two members — every ERC-20 has them.
          const c = new E.Contract(row.address, ['function name() view returns (string)', 'function symbol() view returns (string)'], p);
          const [name, symbol] = await Promise.all([c.name(), c.symbol()]);
          row.name = String(name || '');
          row.symbol = String(symbol || '');
          cache[String(row.address).toLowerCase()] = { name: row.name, symbol: row.symbol };
        } catch {
          // A token that will not answer is not a coin we can name; the row
          // still exists (the pool is real) and renders as an address.
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, missing.length) }, worker));
  }

  writeMetaCache(cache);
  return out;
}

// --- discovery ---

/**
 * Every pool the factory knows, newest first, read from its logs.
 *
 * @param {object} [opts]
 * @param {'all'|'mine'} [opts.scope]  'all' (default) is the PLATFORM feed —
 *   every pool on this factory. 'mine' narrows to pools this wallet created,
 *   using the event's indexed creator topic.
 * @param {string} [opts.creator]  required for scope 'mine'; else the wallet
 * @param {number} [opts.limit]    cap on rows (a feed does not need 10k pools)
 * @param {string} [opts.factory]  override the stored factory (tests, and the
 *   token page checking "is this pool ours")
 * @returns {Promise<{pools: Array, ok: boolean, reason?: string, more: boolean}>}
 *
 * A row is { address (token), pair, quote, creator, block }. Rows are a VIEW:
 * nothing here is invented locally, only filtered and ordered.
 */
export async function discoverPools({ scope = 'all', creator, limit = 100, factory } = {}) {
  const empty = { pools: [], ok: false, more: false };
  const mine = scope === 'mine';
  const who = String(creator || get('address') || '');

  const store = String(factory || factoryAddress() || '').trim().toLowerCase();
  if (!isAddr(store)) return { ...empty, reason: 'no factory' };

  // A discovery pass that answers "you launched nothing" when the answer is
  // really "I could not look" is worse than no answer, so every precondition
  // that fails says so instead of returning an empty list.
  if (mine && !isAddr(who)) return { ...empty, reason: 'no creator' };
  if (!dexChainOk()) return { ...empty, reason: 'wrong chain' };

  const p = provider();
  const E = ethersLib();
  if (!p || !E) return { ...empty, reason: 'no provider' };

  try {
    const latest = await p.getBlockNumber();
    const fromBlock = latest > cursor.at ? latest - cursor.at : 0;

    // Filtering on BOTH signature and factory address is what makes this cheap:
    // the node skips every unrelated log instead of shipping them and letting
    // us throw them away. The two signatures are the two ways a pool is born;
    // an OR on topic0 catches each. Scope 'mine' adds the creator as a second
    // indexed topic, which narrows it further.
    const topic0 = [E.id(LAUNCHED_SIG), E.id(POOL_CREATED_SIG)];
    const topics = mine ? [topic0, E.zeroPadValue(who.toLowerCase(), 32)] : [topic0];
    const logs = await p.getLogs({ address: store, fromBlock, toBlock: latest, topics });

    const seen = new Set();
    const pools = [];
    for (const log of logs) {
      const row = decodePoolLog(E, log);
      if (!row) continue; // a log we cannot read is not a pool we can show
      const key = row.address.toLowerCase();
      if (seen.has(key)) continue; // one pool per token per factory, by contract
      seen.add(key);
      pools.push(row);
    }

    // Newest first: the feed leads with what was created last, and it makes the
    // `more` window meaningful (the newest rows are the ones we just found).
    pools.sort((a, b) => b.block - a.block);

    const full = logs.length >= PAGE_SIZE;
    return { pools: pools.slice(0, limit), ok: true, more: full };
  } catch (e) {
    // Reason rides along. A node that cannot serve the range must not look like
    // an empty feed.
    return {
      ...empty,
      reason: (e && (e.shortMessage || e.message)) || String(e),
    };
  }
}

/**
 * One raw log → one row, or null when it does not decode.
 * Exported for the tests, which feed it logs built the way a node hands them
 * back rather than through a chain.
 */
export function decodePoolLog(E, log) {
  try {
    // Three indexed identity topics — creator, token, pair — and the quote as
    // the one non-indexed address in the data section. (All three are indexed
    // so 'mine' can filter cheaply on the creator topic alone.)
    const creator = E.getAddress('0x' + String(log.topics[1] || '').slice(-40));
    const token = E.getAddress('0x' + String(log.topics[2] || '').slice(-40));
    const pair = E.getAddress('0x' + String(log.topics[3] || '').slice(-40));
    const [quoteRaw] = E.AbiCoder.defaultAbiCoder().decode(['address'], log.data);
    const quote = E.getAddress(quoteRaw);
    const block = Number(log.blockNumber || 0);
    return { address: token, pair, quote, creator, block };
  } catch {
    return null;
  }
}

/**
 * The feed's full picture: what the factory says, plus whatever the browser
 * remembers that the chain has not shown us yet.
 *
 * The merge is deliberate. A pool launched a second ago may not be indexed by
 * every node yet, and a coin remembered locally must not blink out while we
 * wait — so both sources are unioned, chain first for ordering. The local entry
 * carries the image, which the log deliberately omits.
 */
export async function reconcilePools({ scope = 'all', creator, local = [], limit = 100 } = {}) {
  const found = await discoverPools({ scope, creator, limit });
  const byAddress = new Map();

  // Local first so chain values overwrite them: the chain is the authority for
  // identity, the local copy only contributes what the log does not carry.
  for (const x of local) {
    byAddress.set(String(x.address).toLowerCase(), { ...x, source: 'local' });
  }
  for (const x of found.pools) {
    const key = String(x.address).toLowerCase();
    const prev = byAddress.get(key);
    byAddress.set(key, {
      ...prev, ...x,
      name: x.name || prev?.name || '',
      symbol: x.symbol || prev?.symbol || '',
      image: prev?.image || x.image || '',
      source: 'chain',
    });
  }

  const pools = [...byAddress.values()]
    .sort((a, b) => (b.block || 0) - (a.block || 0));

  return { pools, ok: found.ok, reason: found.reason, more: found.more };
}
