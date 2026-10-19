// ═══════════════════════════════════════════════════════════════
// Bear Tool — js/dex/launch.js (Dex v2) — the launch step (M5).
//
// One path: approve the EXACT seed quote (only when the pool asks for it),
// then factory.launch() in a second transaction — the token, the pair, the
// socials and the opening liquidity are all born in that single call, and
// the Launched event on the receipt is the deed. The UI never invents the
// result: it parses the receipt.
//
// Pure data: validators, the encode, the receipt decode (shared from
// pools.js), the token face read, and the launcher's memory of owned
// tokens — chain-scoped, capped, newest first. No DOM here.
// ═══════════════════════════════════════════════════════════════

const { ethers } = globalThis;

import { BEAR_FACTORY_ABI } from './abi.js';
import { decodeLaunched, factoryContract, sqrt } from './pools.js';
import { isAddress, tokenContract } from './swap.js';

const FACTORY_I = new ethers.Interface(BEAR_FACTORY_ABI);

const FEE_CAP_BPS = 30; // BEAR/FEE-CAP in the factory

/** The minShares floor a fresh launch gets: 1% band on sqrt(seedQ·seedT). */
export function seedMinShares(seedQuote, seedToken, bps = 100) {
  const made = sqrt(seedQuote * seedToken);
  return (made * (10000n - BigInt(bps))) / 10000n;
}

/**
 * Calldata for factory.launch — every guard the contract runs is mirrored
 * HERE first, with a why-tag so the sheet can answer in the user's words
 * before any wallet opens:
 *   name|symbol (meta), supply (0), seed (zero), seedover (> supply),
 *   fee (> 30), lock (past), min (zero), factory (bad address).
 * Returns { to, data } — the caller owns the send.
 */
export function launchTx(factoryAddress, args) {
  if (!isAddress(factoryAddress)) {
    const e = new Error('dex/launch: bad factory'); e.why = 'factory'; throw e;
  }
  const meta = args.meta;
  const name = String(meta?.name ?? '').trim();
  const symbol = String(meta?.symbol ?? '').trim();
  if (!name) { const e = new Error('dex/launch: name'); e.why = 'name'; throw e; }
  if (!symbol) { const e = new Error('dex/launch: symbol'); e.why = 'symbol'; throw e; }

  const totalSupply = BigInt(args.totalSupply ?? 0n);
  if (totalSupply <= 0n) { const e = new Error('dex/launch: supply'); e.why = 'supply'; throw e; }

  const seedQuote = BigInt(args.seedQuote ?? 0n);
  const seedToken = BigInt(args.seedToken ?? 0n);
  if (seedQuote <= 0n || seedToken <= 0n) {
    const e = new Error('dex/launch: seed'); e.why = 'seed'; throw e;
  }
  if (seedToken > totalSupply) { const e = new Error('dex/launch: seedover'); e.why = 'seedover'; throw e; }

  const creatorFeeBps = Number(args.creatorFeeBps ?? 0);
  if (!Number.isInteger(creatorFeeBps) || creatorFeeBps < 0 || creatorFeeBps > FEE_CAP_BPS) {
    const e = new Error('dex/launch: fee'); e.why = 'fee'; throw e;
  }

  const lpLockUntil = BigInt(args.lpLockUntil ?? 0n);
  if (lpLockUntil > 0n && lpLockUntil < BigInt(Math.floor(Date.now() / 1000))) {
    const e = new Error('dex/launch: lock'); e.why = 'lock'; throw e;
  }

  const minShares = BigInt(args.minShares ?? 0n);
  if (minShares <= 0n) { const e = new Error('dex/launch: min'); e.why = 'min'; throw e; }

  const data = FACTORY_I.encodeFunctionData('launch', [[
    name, symbol,
    String(meta.image ?? ''), String(meta.desc ?? ''),
    String(meta.twitter ?? ''), String(meta.telegram ?? ''), String(meta.website ?? ''),
  ], totalSupply, creatorFeeBps, lpLockUntil, seedQuote, seedToken, minShares]);
  return { to: factoryAddress, data };
}

/** Parse a launch receipt's logs into the deed, or null when absent. */
export function launchFromReceipt(logs) {
  for (const log of (logs ?? [])) {
    const row = decodeLaunched(log);
    if (row) return row;
  }
  return null;
}

/** The face of a launched token, from its own public strings. */
export async function tokenFace(providerLike, tokenAddress) {
  if (!isAddress(tokenAddress)) {
    const e = new Error('dex/launch: token'); e.why = 'token'; throw e;
  }
  const t = tokenContract(tokenAddress, providerLike);
  const [name, symbol, imageURI, description, twitter, telegram, website,
    socialsSet, totalSupply, quoteToken] = await Promise.all([
    t.name(), t.symbol(), t.imageURI(), t.description(),
    t.twitter(), t.telegram(), t.website(),
    t.socialsSet(), t.totalSupply(), t.quoteToken(),
  ]);
  return {
    token: tokenAddress.toLowerCase(),
    name: String(name), symbol: String(symbol),
    image: String(imageURI), desc: String(description),
    twitter: String(twitter), telegram: String(telegram), website: String(website),
    socialsSet: Boolean(socialsSet),
    totalSupply: BigInt(totalSupply),
    quote: String(quoteToken).toLowerCase(),
  };
}

/** The pair address the factory keeps for a token — the trade door. */
export async function pairOfToken(providerLike, factoryAddress, tokenAddress) {
  const factory = factoryContract(factoryAddress, providerLike);
  return String(await factory.pairOf(tokenAddress)).toLowerCase();
}

// ── the launcher's memory of owned tokens, chain-scoped ───────────────
// One list per chain (dexLaunches.<chainId>), newest first, capped at 50.
// The factory keep the USER'S own launches only — the pools scanner is the
// whole-chain registry.

const KEY = (chainId) => `dexLaunches.${Number(chainId) & 0xffffffff}`;
const CAP = 50;

function readList(chainId) {
  try {
    const raw = localStorage.getItem(KEY(chainId));
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function writeList(chainId, arr) {
  try { localStorage.setItem(KEY(chainId), JSON.stringify(arr.slice(0, CAP))); } catch { /* private mode */ }
}

/** Remember {token, pair, launcher, creatorFeeBps, lpLockUntil, lpShares, name?, symbol?, at}. */
export function launchRemember(chainId, rec) {
  if (!rec || !rec.token) return;
  const list = readList(chainId).filter((r) => r?.token !== String(rec.token).toLowerCase());
  // Memory is JSON: bigints would throw sniff-silent in writeList, so the
  // display-only fields are flattened to JSON-safe primitives here.
  const flat = {
    ...rec,
    token: String(rec.token).toLowerCase(),
    at: Number(rec.at ?? Date.now()),
    creatorFeeBps: Number(rec.creatorFeeBps ?? 0),
    lpLockUntil: Number(rec.lpLockUntil ?? 0),
    lpShares: String(BigInt(rec.lpShares ?? 0n)),
  };
  list.unshift(flat);
  writeList(chainId, list);
}

/** The launcher's remembered launches for a chain, newest first. */
export function launchRecall(chainId) {
  return readList(chainId);
}

/** Forget one token (or everything when token is omitted). */
export function launchForget(chainId, token) {
  if (token === undefined) { try { localStorage.removeItem(KEY(chainId)); } catch { /* private mode */ } return; }
  writeList(chainId, readList(chainId).filter((r) => r?.token !== String(token).toLowerCase()));
}
