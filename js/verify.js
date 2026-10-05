// ═══════════════════════════════════════════════════════════════
// Bear Tool — verify.js
// Auto-verify the contract we just deployed: publish the source so anyone can
// read it next to the bytecode.
//
// Two services, deliberately in this order:
//   1. Sourcify — keyless, standard JSON input, covers most EVM chains.
//   2. Etherscan V2 — one BYO key for every Etherscan-run explorer (the
//      `chainid` in the URL picks the chain). Stored in localStorage like the
//      OpenSea key: a public read key, never a wallet secret.
//
// ENDPOINTS (both verified 2026-10-04 against the vendors' own docs):
//   docs.sourcify.dev/docs/api/
//     POST {SOURCIFY}/v2/verify/{chainId}/{address}
//       body { stdJsonInput, compilerVersion, contractIdentifier,
//              creationTransactionHash? }  →  { verificationId }
//     GET  {SOURCIFY}/v2/verify/{verificationId}   → poll until terminal
//   docs.etherscan.io/api-reference/endpoint/verifysourcecode
//     POST {ETHERSCAN}?chainid=N&module=contract&action=verifysourcecode
//       form  apikey, contractaddress, sourceCode, codeformat,
//             contractname, compilerversion, constructorArguments, licenseType
//       → { status:'1', result:'<GUID>' }
//     GET  {ETHERSCAN}?chainid=N&module=contract&action=checkverifystatus
//            &guid=<GUID>&apikey=…  → result reads 'Pass - Verified' when done.
//
// HONESTY RULES THIS MODULE OWNS:
//   - A loopback/dev chain (anvil, hardhat, a mainnet fork on :8546) has no
//     public explorer. We SKIP with a reason instead of pretending.
//   - Verification failure never turns a landed deploy into an error — the
//     contract exists either way; we report per service and carry on.
//   - The published input is byte-for-byte the input compileContract() sent
//     (js/solc.js buildStandardJsonInput), so "verified" cannot drift from
//     "deployed".
// ═══════════════════════════════════════════════════════════════

import { buildStandardJsonInput, SOLC_ID_SOURCIFY, SOLC_ID_ETHERSCAN } from './solc.js';
import { isLoopbackRpc, LOCAL_DEV_CHAIN_IDS } from './network.js';

export const SOURCIFY_BASE = 'https://sourcify.dev/server';
export const ETHERSCAN_V2_BASE = 'https://api.etherscan.io/v2/api';
const KEY_STORE = 'bear.etherscanKey';

// Poll budget: enough for a slow queue, short enough that the deploy card is
// not spinning forever. Injectable so tests never sleep.
const DEFAULT_POLLS = 8;
const DEFAULT_INTERVAL_MS = 2500;

// ── the key ────────────────────────────────────────────────────
export function getEtherscanKey() {
  try { return localStorage.getItem(KEY_STORE) || ''; } catch { return ''; }
}

/** Save (or clear, when empty) the BYO Etherscan key. Returns what was stored. */
export function setEtherscanKey(value) {
  const v = String(value || '').trim();
  try {
    if (v) localStorage.setItem(KEY_STORE, v);
    else localStorage.removeItem(KEY_STORE);
  } catch { /* private mode: the key lives for this page only */ }
  return v;
}

// ── honest skip ────────────────────────────────────────────────
/**
 * Why verification is impossible here, or null when it is worth attempting.
 * @param {{chainId?: number|string, rpc?: string|string[]}} net
 * @param {string} [address]
 */
export function localSkipReason(net, address) {
  if (!address) return 'No contract address to verify';
  // ANY loopback endpoint in the list means this network is (or can fall back
  // to) a local chain — checking only rpc[0] would skip a dev chain the moment
  // the app is using its second endpoint, and then report "failed" instead of
  // "skipped".
  const list = (Array.isArray(net?.rpc) ? net.rpc : [net?.rpc]).filter(Boolean);
  const hit = list.find((u) => isLoopbackRpc(u));
  if (hit) return `Local chain (${hit}) — no public explorer to verify against`;
  if (LOCAL_DEV_CHAIN_IDS.has(Number(net?.chainId))) {
    return `Dev chain ${net.chainId} (anvil/hardhat) — no public explorer to verify against`;
  }
  return null;
}

// ── constructor arguments (Etherscan wants them ABI-encoded) ───
/**
 * ABI-encoded constructor arguments WITHOUT the leading 0x, as the API asks.
 * Returns '' when the contract has no constructor or was deployed with none —
 * which is also the only correct answer in that case.
 * @param {Array} abi
 * @param {Array} [args]
 */
export function encodeConstructorArgs(abi, args) {
  const ctor = (abi || []).find((e) => e && e.type === 'constructor');
  if (!ctor || !Array.isArray(args) || args.length === 0) return '';
  const { ethers } = globalThis;
  if (!ethers?.Interface) throw new Error('encodeConstructorArgs: ethers is not loaded');
  const iface = new ethers.Interface([{ type: 'constructor', inputs: ctor.inputs || [] }]);
  return iface.encodeDeploy(args).slice(2);
}

// ── plumbing ───────────────────────────────────────────────────
async function bodyJson(res) {
  const text = typeof res?.text === 'function' ? await res.text() : String(res);
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

const msgOf = (d) => d?.error?.message || d?.error || d?.message || d?.raw || '';
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A stalled socket must not hold the deploy screen hostage. Verification is
// best-effort by design, so every request carries its own deadline — a hung
// connect otherwise leaves the button reading "Verifying" forever.
const FETCH_TIMEOUT_MS = 20000;
const fetchSignal = () => (
  typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(FETCH_TIMEOUT_MS)
    : undefined
);

// ── Sourcify (keyless) ─────────────────────────────────────────
/**
 * Submit standard JSON input, then poll the ticket. Throws on a terminal
 * failure; returns { service, ok, msg } on success.
 */
export async function verifySourcify({
  chainId, address, stdJsonInput, contractName, creationTxHash,
  fetchFn = globalThis.fetch, sleepFn = defaultSleep,
  polls = DEFAULT_POLLS, intervalMs = DEFAULT_INTERVAL_MS, onStatus,
} = {}) {
  if (!chainId || !address) throw new Error('sourcify: chainId and address are required');
  const contractIdentifier = `${contractName}.sol:${contractName}`;
  onStatus?.('Submitting source to Sourcify…');
  const res = await fetchFn(`${SOURCIFY_BASE}/v2/verify/${chainId}/${address}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: fetchSignal(),
    body: JSON.stringify({
      stdJsonInput,
      compilerVersion: SOLC_ID_SOURCIFY,
      contractIdentifier,
      ...(creationTxHash ? { creationTransactionHash: creationTxHash } : {}),
    }),
  });
  const data = await bodyJson(res);
  if (res && res.ok === false) throw new Error(`sourcify: HTTP ${res.status} — ${msgOf(data) || 'request rejected'}`);

  // Terminal already? Some deployments answer the POST with the verdict.
  const instant = terminalSourcify(data);
  if (instant) return { service: 'sourcify', ok: instant.ok, msg: instant.msg };

  const ticket = data?.verificationId || data?.id;
  if (!ticket) throw new Error(`sourcify: ${msgOf(data) || 'no verificationId in the response'}`);

  for (let i = 0; i < polls; i++) {
    onStatus?.(`Sourcify: waiting for a match (${i + 1}/${polls})…`);
    await sleepFn(intervalMs);
    const r = await fetchFn(`${SOURCIFY_BASE}/v2/verify/${ticket}`, {
      headers: { Accept: 'application/json' },
      signal: fetchSignal(),
    });
    const d = await bodyJson(r);
    const hit = terminalSourcify(d);
    if (hit) return { service: 'sourcify', ok: hit.ok, msg: hit.msg };
    if (i === polls - 1) break;
  }
  throw new Error(`sourcify: still pending after ${polls} checks`);
}

// Sourcify has answered in more than one shape across versions, so the verdict
// is read defensively: status/verification.status/match/verification.match.
function terminalSourcify(d) {
  const v = d?.verification || d || {};
  const status = String(v.status ?? d?.status ?? '').toLowerCase();
  const match = v.match ?? d?.match;
  const matchName = typeof match === 'string' ? match.toLowerCase() : String(match?.kind || match?.status || '').toLowerCase();
  const err = d?.error?.message || d?.error;
  if (err && !d?.verificationId) return { ok: false, msg: String(err) };
  // An in-flight ticket is never a verdict, whatever else it carries.
  if (['pending', 'queued', 'processing', 'running', 'started', 'idle', 'in progress', 'in_progress'].includes(status)) return null;
  if (['finished', 'success', 'succeeded', 'completed', 'verified'].includes(status)) {
    return { ok: true, msg: matchName ? `Sourcify ${matchName} match` : 'Sourcify verified' };
  }
  if (['error', 'failed', 'mismatch'].includes(status)) {
    return { ok: false, msg: String(v.message || d?.message || status) };
  }
  if (matchName === 'perfect' || matchName === 'partial') return { ok: true, msg: `Sourcify ${matchName} match` };
  return null;
}

// ── Etherscan V2 (BYO key) ─────────────────────────────────────
/** Submit + poll. Throws on terminal failure, returns { service, ok, msg }. */
export async function verifyEtherscan({
  chainId, address, stdJsonInput, contractName, constructorArguments = '',
  key, fetchFn = globalThis.fetch, sleepFn = defaultSleep,
  polls = DEFAULT_POLLS, intervalMs = DEFAULT_INTERVAL_MS, onStatus,
} = {}) {
  if (!key) throw new Error('etherscan: no API key saved');
  if (!chainId || !address) throw new Error('etherscan: chainId and address are required');
  const contractname = `${contractName}.sol:${contractName}`;

  onStatus?.('Submitting source to Etherscan…');
  const body = new URLSearchParams({
    apikey: key,
    contractaddress: address,
    sourceCode: JSON.stringify(stdJsonInput),
    codeformat: 'solidity-standard-json-input',
    contractname,
    compilerversion: SOLC_ID_ETHERSCAN,
    constructorArguments: constructorArguments || '',
    licenseType: '3', // MIT
  });
  const res = await fetchFn(`${ETHERSCAN_V2_BASE}?chainid=${chainId}&module=contract&action=verifysourcecode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    signal: fetchSignal(),
    body,
  });
  const data = await bodyJson(res);
  const result = String(data?.result ?? '');
  if (/already verified/i.test(result) || /already verified/i.test(String(data?.message || ''))) {
    return { service: 'etherscan', ok: true, msg: 'already verified' };
  }
  if (String(data?.status) !== '1' || !result) {
    throw new Error(`etherscan: ${result || msgOf(data) || 'submission rejected'}`);
  }
  const guid = result;

  for (let i = 0; i < polls; i++) {
    onStatus?.(`Etherscan: checking status (${i + 1}/${polls})…`);
    if (i > 0) await sleepFn(intervalMs);
    const r = await fetchFn(
      `${ETHERSCAN_V2_BASE}?chainid=${chainId}&module=contract&action=checkverifystatus&guid=${encodeURIComponent(guid)}&apikey=${encodeURIComponent(key)}`,
      { headers: { Accept: 'application/json' }, signal: fetchSignal() },
    );
    const d = await bodyJson(r);
    const verdict = String(d?.result ?? '');
    if (/^(pass|exact match)/i.test(verdict)) return { service: 'etherscan', ok: true, msg: verdict };
    if (/^fail/i.test(verdict)) throw new Error(`etherscan: ${verdict}`);
    // Keys/chains are fatal — polling a rejected key just burns the budget.
    if (/api ?key|not supported|invalid/i.test(verdict)) throw new Error(`etherscan: ${verdict}`);
    if (i === polls - 1) throw new Error(`etherscan: ${verdict || 'no status'} after ${polls} checks`);
    onStatus?.(`Etherscan: ${verdict || 'pending'}…`);
  }
  throw new Error('etherscan: status polling exhausted');
}

// ── the auto flow ──────────────────────────────────────────────
/**
 * Verify everywhere we can, report per service, never throw for a verification
 * problem (a landed deploy is not an error).
 *
 * @param {object} o
 * @param {{chainId:number, rpc?:string|string[], name?:string}} o.net
 * @param {string} o.address          deployed contract address
 * @param {string} o.source           exact source that was compiled
 * @param {string} o.contractName
 * @param {Array}  [o.abi]            used to encode constructor args
 * @param {Array}  [o.args]           constructor args, as deployed
 * @param {object} [o.compiler]       { language, evmVersion, optimizer, runs }
 * @param {string} [o.creationTxHash]
 * @returns {Promise<{skipped:boolean, reason?:string, ok:boolean, results:Array, line:string}>}
 */
export async function autoVerify({
  net, address, source, contractName, abi, args, compiler = {}, creationTxHash,
  fetchFn = globalThis.fetch, sleepFn = defaultSleep, onStatus,
} = {}) {
  const skip = localSkipReason(net, address);
  if (skip) return { skipped: true, reason: skip, ok: false, results: [], line: `Verify skipped: ${skip}` };

  let stdJsonInput;
  let constructorArguments;
  try {
    stdJsonInput = buildStandardJsonInput(source, contractName, compiler);
    constructorArguments = encodeConstructorArgs(abi, args);
  } catch (e) {
    const line = `Verify skipped: ${e?.message || e}`;
    onStatus?.(line);
    return { skipped: true, reason: line, ok: false, results: [], line };
  }

  const results = [];
  const run = async (service, fn) => {
    try {
      const r = await fn();
      results.push(r);
    } catch (e) {
      results.push({ service, ok: false, msg: e?.message || String(e) });
    }
  };

  await run('sourcify', () => verifySourcify({
    chainId: Number(net.chainId), address, stdJsonInput, contractName,
    creationTxHash, fetchFn, sleepFn, onStatus,
  }));

  const key = getEtherscanKey();
  if (key) {
    await run('etherscan', () => verifyEtherscan({
      chainId: Number(net.chainId), address, stdJsonInput, contractName,
      constructorArguments, key, fetchFn, sleepFn, onStatus,
    }));
  } else {
    results.push({ service: 'etherscan', skipped: true, msg: 'no API key saved (Sourcify ran keyless)' });
  }

  const ok = results.some((r) => r.ok);
  const line = results
    .map((r) => (r.skipped
      ? `${r.service}: ${r.msg}`
      : `${r.service}: ${r.ok ? r.msg : `failed — ${r.msg}`}`))
    .join(' · ');
  const out = { skipped: false, ok, results, line };
  onStatus?.(line);
  return out;
}
