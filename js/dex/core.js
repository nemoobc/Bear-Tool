// Bear Tool — js/dex/core.js
// The launchpad's shared helpers: the Sepolia-only rule, the provider/ethers
// accessors, the one transaction path, and the formatting every screen uses.
//
// This is the ONE source of truth for them, so no feature module re-declares a
// helper. Nothing here imports a feature module, so there is no import cycle
// with index.js / create.js / tokens.js / trade.js / chart.js / history.js.
//
// The pure-launchpad rebuild deleted the Uniswap V2 layer from here: the router,
// presets, pair and pool helpers are gone with the panels that used them. A
// launchpad has no pools — its coins trade on their own curves — so carrying
// those helpers forward would only leave a second "ETH" and a dead pair lying
// around for the next reader to trip over.
import { t } from '../i18n.js';
import { get, set, on, off } from '../state.js';
import { getNetworkById } from '../network.js';
import { $, toast, escapeHtml, confirmTx, setBtnDots } from '../ui.js';
import { withTimeout, waitForReceipt, receiptVerdict } from '../safetx.js';

export const DEX_NETWORK_ID = 'sepolia';
export const DEX_CHAIN_ID = 11155111;

// The Dex's OWN coins — the three contracts, not the chain's native token.
//
// These were deleted during the pure-launchpad rebuild because they were being
// used as POOL SIDES beside native ETH, which is how "which coin do I trade?"
// became ambiguous: two things called ETH on one screen, and no rule saying
// which. The fix was not to throw them away but to give them the job they were
// always for: the currency the launchpad is QUOTED in.
//
// Sepolia native ETH now pays gas and nothing else. The curve contract refuses
// it outright (receive() reverts), so "gas only" is enforced by code rather
// than promised in a label.
export const QUOTE_PRESETS = [
  { address: '0x8847346f20aCe5bd4619B7fbF3467D001E269fE9', symbol: 'ETH', name: 'Bear ETH', decimals: 18 },
  { address: '0x8719D774726b11497FAddCFdf7bc369C56F6B5d3', symbol: 'USDT', name: 'USDT', decimals: 18 },
  { address: '0x4669689d94991bb4ab6A6e071f9af9CC42d9deef', symbol: 'USDC', name: 'USDC', decimals: 18 },
];

export function quoteBy(address) {
  const a = String(address || '').toLowerCase();
  return QUOTE_PRESETS.find((p) => p.address.toLowerCase() === a) || null;
}

export function defaultQuote() { return QUOTE_PRESETS[0]; }

// The slice of ERC-20 the launchpad needs: pull funds in, pay them out, read a
// balance, and grant/inspect the allowance a buy requires. Nothing else, and no
// transferFrom without an explicit allowance — the contract checks it and
// reverts with "approve" rather than pulling something the user did not agree to.
export const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
];

export function dexChainId() { return getNetworkById(get('networkId'))?.chainId || 0; }
export function dexChainOk() { return dexChainId() === DEX_CHAIN_ID; }

export function provider() { return get('provider'); }
export function ethersLib() { return globalThis.ethers; }

const BROADCAST_TIMEOUT_MS = 15000;

// One path out of the launchpad: broadcast with a bound, then wait with a
// bound. Returns the receipt, or null when it did not confirm in time (callers
// treat null as "stop", never success). Shared by buy, sell, claim and
// graduate, so no trade can skip the confirm-then-verify discipline.
export async function sendDexTx(promiseFactory, label) {
  let tx;
  try {
    tx = await withTimeout(promiseFactory(), BROADCAST_TIMEOUT_MS, `${label} broadcast`);
  } catch (e) {
    // A broadcast that ran out of clock is NOT a revert: the wallet may or may
    // not have sent it. The raw `{label} timed out` string is a log line, not
    // an interface — the user gets the honest sentence instead (R17).
    if (e && e.code === 'BEAR_TIMEOUT') toast(t('dex.tx.timeout'), 'error');
    else toast((e && (e.shortMessage || e.message)) || String(e), 'error');
    return null;
  }
  const v = receiptVerdict(await waitForReceipt(tx, { label }));
  if (v.kind !== 'success') {
    toast(v.kind === 'failed'
      ? t('dex.tx.failed')
      : t('dex.tx.pending', { hash: String(v.hash || '').slice(0, 10) }), v.kind === 'failed' ? 'error' : 'info');
    return null;
  }
  return v.receipt;
}

export function fmtTok(units, dec = 18, digits = 6) {
  const n = Number(units) / 10 ** dec;
  if (!Number.isFinite(n)) return '0';
  return n.toLocaleString('en-US', { maximumFractionDigits: digits });
}

// A price, for display only, at a fixed number of SIGNIFICANT digits.
//
// A fresh coin trades near 1e-13 quote per token, and `toFixed(4)` renders
// every price it will ever have as "0.0000" — on a page that also shows the
// real signed trades, that reads as a broken feed rather than a tiny number.
// `toExponential(4)` replaced the zeros but not the confusion: "1.2345e-13" is
// developer notation, not a ticker.
//
// Significant digits keep the price readable at ANY scale a launchpad can
// reach (1e-13 … 1e3) without ever falling back to exponent notation. The
// chart axis, the tape and the token page all format through here — one
// formatter, so no two surfaces can round the same price differently. Nothing
// here feeds a trade — the contract's own integer maths does — so this is a
// display helper and says so.
export function fmtPrice(n, sig = 4) {
  const v = Number(n);
  if (!Number.isFinite(v) || v === 0) return '0';
  const s = Math.min(18, Math.max(1, Math.round(Number(sig) || 4)));
  const exp = Math.floor(Math.log10(Math.abs(v)));
  // Strip what we already spent on the integer part (none below 1) and cap at
  // the 18 decimals a wei-denominated price can meaningfully carry.
  const decimals = Math.min(18, Math.max(0, s - 1 - exp));
  const out = v.toLocaleString('en-US', { maximumFractionDigits: decimals });
  // A sub-1 price that still rounds to zero would be worse than the zeros we
  // set out to remove: say so with a bound instead of printing "0".
  if (Number(out.replace(/,/g, '')) === 0) return `<${(10 ** -decimals).toLocaleString('en-US', { maximumFractionDigits: 18 })}`;
  return out;
}

// Is this a 20-byte address? Checked before anything touches the chain, so a
// pasted or truncated value can never become a log filter that silently matches
// nothing — or something.
export function isAddr(v) { return /^0x[0-9a-fA-F]{40}$/.test(String(v || '')); }

export function needSigner() {
  const p = provider();
  const s = get('signer');
  if (!p) { toast(t('dex.needWallet'), 'error'); return null; }
  if (!s || !get('unlocked')) { toast(t('dex.needWallet'), 'error'); return null; }
  return s.connect(p);
}

// Every launchpad action that broadcasts a transaction runs through here, so
// the button shows a spinner + the stage name and stays disabled until the tx
// settles. Without it a 30-second confirm looked like a dead button (user:
// "loading tx ga ada"). `label` names the stage ("Sending…").
// The finally-restore means a rejected/failed/timeout tx still re-enables it.
export async function withTxButton(btn, label, fn) {
  if (!btn || btn.disabled) return undefined;
  setBtnDots(btn, true, label);
  try {
    return await fn();
  } finally {
    setBtnDots(btn, false);
  }
}

// Re-exported so a feature module imports one place for the helpers it shares
// with the view, rather than reaching into state.js / ui.js on its own.
export { t, get, set, on, off, $, toast, escapeHtml, confirmTx, setBtnDots };
