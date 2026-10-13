// Bear Tool — js/dex/core.js
// The Dex's shared helpers: the three coins, the Sepolia-only rule, the
// provider/ethers accessors, formatting, and the V2 helpers every feature
// panel needs (create / swap+chart / liquidity-list / market-maker / tokens).
//
// This is the ONE source of truth for these, so a feature module never
// re-declares a preset address or copies a formatting helper (which would be
// exactly the "two ETH" confusion). Nothing here imports a feature module, so
// there is no import cycle with index.js / create.js / tokens.js / chart.js.
import { t } from '../i18n.js';
import { get, set, on, off } from '../state.js';
import { getNetworkById } from '../network.js';
import { $, toast, escapeHtml, confirmTx } from '../ui.js';
import { withTimeout, waitForReceipt, receiptVerdict } from '../safetx.js';
import { tokenLogoHTML, guardTokenLogos } from '../token-logo.js';
import {
  UNISWAP_V2, V2_ROUTER_ABI, V2_FACTORY_ABI, V2_PAIR_ABI, DEX_ERC20_ABI,
} from './contract.js';

export { UNISWAP_V2 };

export const DEX_NETWORK_ID = 'sepolia';
export const DEX_CHAIN_ID = 11155111;

// The three native coins of the Dex. Probed on-chain 2026-10-13. 0x8847…fE9 is
// called "ETH" by its own contract; Sepolia's NATIVE ETH is a different thing
// and stays gas-only. The address IS the identity.
export const DEX_PRESETS = [
  { address: '0x8847346f20aCe5bd4619B7fbF3467D001E269fE9', symbol: 'ETH', name: 'Native ETH', decimals: 18 },
  { address: '0x8719D774726b11497FAddCFdf7bc369C56F6B5d3', symbol: 'USDT', name: 'USDT', decimals: 18 },
  { address: '0x4669689d94991bb4ab6A6e071f9af9CC42d9deef', symbol: 'USDC', name: 'USDC', decimals: 18 },
];

export function dexChainId() { return getNetworkById(get('networkId'))?.chainId || 0; }
export function dexChainOk() { return dexChainId() === DEX_CHAIN_ID; }
export function dexPair() { return get('dex.pair') || null; }

export function provider() { return get('provider'); }
export function ethersLib() { return globalThis.ethers; }

const BROADCAST_TIMEOUT_MS = 15000;

// One path out of the Dex: broadcast with a bound, then wait with a bound.
// Returns the receipt, or null when it did not confirm in time (callers treat
// null as "stop", never success). Shared by swap, liquidity and market maker.
export async function sendDexTx(promiseFactory, label) {
  let tx;
  try {
    tx = await withTimeout(promiseFactory(), BROADCAST_TIMEOUT_MS, `${label} broadcast`);
  } catch (e) {
    toast((e && (e.shortMessage || e.message)) || String(e), 'error');
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

export function isAddr(v) { return /^0x[0-9a-fA-F]{40}$/.test(String(v || '')); }
export function presetBy(addr) {
  const a = String(addr || '').toLowerCase();
  return DEX_PRESETS.find((p) => p.address.toLowerCase() === a) || null;
}

export function fmtTok(units, dec = 18, digits = 6) {
  const n = Number(units) / 10 ** dec;
  if (!Number.isFinite(n)) return '0';
  return n.toLocaleString('en-US', { maximumFractionDigits: digits });
}

// bundled marks: the presets are the Dex's own curated registry, so no
// user-supplied contract can wear these marks by matching a ticker.
export function logoHtml(tok, size = 32) {
  return tokenLogoHTML(tok.symbol, size, { address: tok.address, bundled: true });
}

export function needSigner() {
  const p = provider();
  const s = get('signer');
  if (!p) { toast(t('dex.needWallet'), 'error'); return null; }
  if (!s || !get('unlocked')) { toast(t('dex.needWallet'), 'error'); return null; }
  return s.connect(p);
}

export function v2() { return UNISWAP_V2[DEX_CHAIN_ID]; }

export async function poolFor(pair) {
  const E = ethersLib();
  const p = provider();
  if (!p) return null;
  try {
    const f = new E.Contract(v2().factory, V2_FACTORY_ABI, p);
    const addr = await f.getPair(pair.base.address, pair.quote.address);
    if (!addr || /^0x0{40}$/.test(addr)) return null;
    return addr;
  } catch { return null; }
}

export function poolSinceKey(pair) {
  return 'dex.poolSince.' + [pair.base.address, pair.quote.address].map((a) => a.toLowerCase()).sort().join('-');
}

// re-exported so a feature module can pull its UI/state helpers from here too
export { t, get, set, on, off, $, toast, escapeHtml, confirmTx, guardTokenLogos,
  V2_ROUTER_ABI, V2_FACTORY_ABI, V2_PAIR_ABI, DEX_ERC20_ABI };
