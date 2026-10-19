// ═══════════════════════════════════════════════════════════════
// Bear Tool — js/dex/bot-wallets.js
// Addresses the market maker makes for itself.
//
// "Fill the balance, then it runs." The part that has to be solved is the
// addresses: one wallet sending every trade means one nonce queue, one gas
// balance that empties, and one address where every single trade of an
// unattended bot is visible to anyone who looks at the block explorer.
//
// So the bot derives its own addresses from the wallet you already unlocked —
// m/44'/60'/0'/0/5, /6, /7 … — and rotates through them.
//
// ── Why derived, and not generated ─────────────────────────────────────
// A generated wallet would mean storing new private keys, which means storing
// new secrets, which means more ways to lose money. Deriving gets the same
// distinct addresses from the ONE secret that is already encrypted in the
// keystore and already wiped on app close. There is nothing new to protect,
// and nothing new to leak.
//
// ── What this does not do ───────────────────────────────────────────────
// It does not make a coin look traded to anyone who checks. Derived addresses
// from one seed are trivially linkable, and the trade history still shows one
// person on both sides. This spreads load across addresses; it does not create
// real liquidity, and the Dex says so where the user will read it.
// ═══════════════════════════════════════════════════════════════

const DERIVE_ROOT = "m/44'/60'/0'/0";

/**
 * Can this secret produce more than one address?
 *
 * A seed phrase can. An imported private key cannot — there is exactly one
 * address behind it, and pretending otherwise would hand back the same signer
 * N times labelled as N wallets.
 */
export function canDerive(secret) {
  if (typeof secret !== 'string') return false;
  const s = secret.trim();
  return s.split(/\s+/).length >= 12;
}

/**
 * The first address the Bot will use: past every address you already see in
 * the app, so it can never collide with an account the user manages by hand.
 */
export function botStartIndex(accounts) {
  let max = -1;
  for (const a of accounts || []) {
    const m = /\/(\d+)$/.exec(String(a?.path || ''));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

/**
 * Derive `count` wallets. Pure with respect to the chain — it only does local
 * key maths, never a network call, so a failure here is a bug and not a
 * connectivity problem.
 *
 * @param {string} secret  seed phrase from the unlocked session
 * @param {number} start   first derivation index
 * @param {number} count   how many addresses to make
 * @param {string[]} exclude  addresses the caller already controls
 *
 * `exclude` is not optional politeness. Index 0 of a seed is the account the
 * app itself opens — so if the caller's account list is empty, unparsed, or
 * restored from an older format, deriving from 0 hands the bot the key of the
 * wallet that is paying for it. The bot would then spend, receive and rotate
 * through the one address the user spends everything else from, with no error
 * anywhere: every transaction is valid, and the balance simply drains. Skipping
 * taken addresses makes that impossible whatever the caller's bookkeeping says.
 */
export function deriveBotWallets(secret, start, count, exclude = []) {
  const E = globalThis.ethers;
  if (!E || !E.HDNodeWallet) throw new Error('wallet library not ready');
  if (!canDerive(secret)) {
    throw new Error('seedRequired');   // caller shows the user's own words
  }
  const taken = new Set((exclude || []).map((a) => String(a).toLowerCase()));
  const hd = E.HDNodeWallet.fromPhrase(secret.trim(), undefined, DERIVE_ROOT);

  const out = [];
  // A SEPARATE cursor: the index has to keep advancing past an address it skips,
  // or a single collision ends the walk and the bot comes up short of addresses.
  let index = start;
  const walkLimit = start + count + taken.size + 16;
  while (out.length < count && index < walkLimit) {
    const w = hd.derivePath(String(index));
    if (!taken.has(w.address.toLowerCase())) {
      taken.add(w.address.toLowerCase());
      out.push({ index, address: w.address, path: `${DERIVE_ROOT}/${index}`, signer: w });
    }
    index++;
  }
  if (out.length < count) {
    throw new Error('noFreeAddresses');
  }
  return out;
}

/**
 * Split a budget across wallets that will each have to pay gas as well as
 * trade. Giving every wallet exactly budget/N leaves the last one unable to
 * send anything at all — the split is per wallet, but gas comes out of the same
 * coins, so a share with nothing left over is a share that cannot trade.
 *
 * `gasPad` is subtracted per wallet so each one keeps a working balance. The
 * remainder is deliberately NOT redistributed: it stays in wallet 0, which is
 * also the one that reports what is left.
 */
export function splitBudget(total, count, gasPad = 0n) {
  const n = BigInt(count);
  if (n <= 0n) return [];
  const each = (total - gasPad * n) / n;
  const shares = new Array(Number(n)).fill(each < 0n ? 0n : each);
  const handedOut = shares.reduce((a, b) => a + b, 0n);
  if (handedOut < total) shares[0] += total - handedOut;
  return shares;
}

/**
 * Wallets that cannot trade at all are worse than no wallets: the loop would
 * pick them, fail, and charge the user gas for nothing. So every wallet is
 * checked against the smallest trade it would be asked to make.
 */
export function tradeableWallets(wallets, balances, needQuote, needTokens) {
  return (wallets || []).filter((w) => {
    const b = balances[w.address] || { quote: 0n, token: 0n };
    return b.quote >= needQuote || b.token >= needTokens;
  });
}