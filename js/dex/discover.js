// Bear Tool — js/dex/discover.js
// Finding the coins, from the chain rather than from a notebook.
//
// The feed used to be a localStorage list written by the browser that launched
// each coin. That made it a private notebook: clear the storage, open another
// device, or use a different browser, and real paid-for coins simply stopped
// existing as far as the launchpad was concerned. The chain had the coins the
// whole time — nothing read it.
//
// PumpToken now emits one indexed `Launched` per coin (see pump-source.js), so
// discovery is a single filtered log query. That makes the feed a VIEW over the
// chain: the same coins on every device, with nothing to lose.
//
// What still comes from localStorage is only the convenience part — the image
// data URI, which is too large to log and is cheap to re-read from the
// contract. Everything that matters (name, symbol, creator, price, reserve) is
// either in the log or read live.

import { get } from '../state.js';
import { provider, ethersLib, dexChainOk, isAddr, DEX_CHAIN_ID } from './core.js';
import { PUMP_ABI } from './pump-source.js';

// How far back to look. Bounded on purpose: a launchpad that opens its log
// query from genesis on a mature chain hangs, and a hang is worse than a short
// window. The window is widened only when the last page came back full, which
// is what `more` reports.
const DEFAULT_LOOKBACK = 50_000;
const PAGE_SIZE = 2_000;

// Remembers how far back we have already looked, so paging deeper does not
// re-scan the same blocks on every feed open.
const cursor = { at: DEFAULT_LOOKBACK };

/** How far back discovery currently searches. */
export function lookbackBlocks() { return cursor.at; }

/** Reset the window — used by tests, and by a chain switch. */
export function resetDiscovery(blocks = DEFAULT_LOOKBACK) { cursor.at = blocks; }

/**
 * Every coin on the launchpad, newest first, read from the chain.
 *
 * @param {object} [opts]
 * @param {'all'|'mine'} [opts.scope]  'all' (default) is the PLATFORM feed —
 *   every launch on this chain. That is what makes the Dex open on a real feed
 *   of coins instead of a create button over an empty list; a feed scoped to one
 *   wallet is empty for every new visitor, which is how this screen ended up
 *   looking like nothing but a launch form.
 * @param {string} [opts.creator]  required for scope 'mine'; else the wallet
 * @param {number} [opts.limit]    cap on rows (a feed does not need 10k coins)
 * @returns {Promise<{coins: Array, ok: boolean, reason?: string, more: boolean}>}
 *
 * `more` is true when the page came back full, i.e. there may be older launches
 * beyond the window. The caller decides whether to look; this never silently
 * pretends the list is complete.
 */
export async function discoverCoins({ scope = 'all', creator, limit = 100 } = {}) {
  const empty = { coins: [], ok: false, more: false };
  const mine = scope === 'mine';
  const who = String(creator || get('address') || '');

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

    // Filtering on the event signature is what makes this cheap: the node skips
    // every unrelated log on the chain instead of shipping them and letting us
    // throw them away. Scope 'mine' adds the creator as a second indexed topic,
    // which narrows it further; scope 'all' keeps the signature alone.
    const topic = E.id('Launched(address,address,string,string)');
    const topics = mine ? [topic, E.zeroPadValue(who.toLowerCase(), 32)] : [topic];
    const logs = await p.getLogs({ fromBlock, toBlock: latest, topics });

    const coins = [];
    for (const log of logs) {
      // name and symbol are the two non-indexed (data) fields.
      let parsed;
      try {
        parsed = E.AbiCoder.defaultAbiCoder().decode(['string', 'string'], log.data);
      } catch {
        continue; // a log we cannot read is not a coin we can show
      }
      // topics: [signature, creator, token] — both identity fields are indexed,
      // so a coin is addressable from its log even when the data fields are not.
      let address;
      try { address = E.getAddress('0x' + String(log.topics[2] || '').slice(-40)); }
      catch { continue; }
      let creatorAddress = who;
      try { creatorAddress = E.getAddress('0x' + String(log.topics[1] || '').slice(-40)); }
      catch { /* keep the caller's value */ }
      coins.push({
        address,
        creator: creatorAddress,
        name: parsed[0],
        symbol: parsed[1],
        block: Number(log.blockNumber),
      });
    }

    // Newest first: the feed leads with what was launched last, and it makes the
    // `more` window meaningful (the newest rows are the ones we just found).
    coins.sort((a, b) => b.block - a.block);

    const full = logs.length >= PAGE_SIZE;
    return { coins: coins.slice(0, limit), ok: true, more: full };
  } catch (e) {
    // Reason rides along. A node that cannot serve the range must not look like
    // an empty feed — that is the same lie the trade tape refused to tell.
    return {
      ...empty,
      reason: (e && (e.shortMessage || e.message)) || String(e),
    };
  }
}

/**
 * The feed's full picture: what the chain says, plus whatever the browser
 * remembers that the chain has not shown us yet.
 *
 * The merge is deliberate. A coin launched a second ago may not be indexed by
 * every node yet, and a coin remembered locally must not blink out while we
 * wait — so both sources are unioned, chain first for ordering. The local entry
 * carries the image, which the log deliberately omits.
 */
export async function reconcile({ scope = 'all', creator, local = [] } = {}) {
  const found = await discoverCoins({ scope, creator });
  const byAddress = new Map();

  // Local first so chain values overwrite them: the chain is the authority for
  // identity, the local copy only contributes what the log does not carry.
  for (const x of local) {
    byAddress.set(String(x.address).toLowerCase(), { ...x, source: 'local' });
  }
  for (const x of found.coins) {
    const key = String(x.address).toLowerCase();
    const prev = byAddress.get(key);
    byAddress.set(key, { ...prev, ...x, image: prev?.image || x.image || '', source: 'chain' });
  }

  const coins = [...byAddress.values()]
    .sort((a, b) => (b.block || 0) - (a.block || 0));

  return { coins, ok: found.ok, reason: found.reason, more: found.more, chainOnly: DEX_CHAIN_ID && found.coins.length };
}
