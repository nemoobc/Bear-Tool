// ═══════════════════════════════════════════════════════════════════
// errors.js — turn a machine failure into a sentence a person can act on.
//
// Why this exists. Every feature reported failure the way the stack reported it.
// The swap path produced, verbatim, in the toast:
//
//   Swap failed: execution reverted: "UniswapV2Library: INSUFFICIENT_INPUT_AMOUNT"
//   (action="estimateGas", data="0x7ff36ab5…", reason=…, transaction={…})
//
// That is a developer sentence with a hexadecimal blob in it, shown to someone
// who was told they were out of network fee. The information is real; the
// phrasing is for a machine. There were 110 sites that could show one of these.
//
// Design, and the constraint that shapes it:
//
//   1. IDEMPOTENT. Most messages in this app are already human — "Enter amount to
//      swap", "Fill contract, token ID, and price." Those must pass through
//      untouched. So the translator recognises *raw* text and leaves everything
//      else alone, rather than rewriting all text. A translator that rewrites
//      every string would eventually mangle a good one, and a mangled good
//      message is worse than a bad one.
//
//   2. NO CODE TO THE USER. No selectors, no addresses, no calldata, no stack. The
//      raw text is kept and sent to the console instead, so a bug report can
//      carry it without the person reading it having to.
//
//   3. SAY WHAT TO DO. A message that names the problem and stops is a dead end.
//      Every entry here ends with the next action.
//
//   4. ORDER MATTERS. The table is scanned in order, most specific first, and the
//      first match wins. "insufficient funds for gas" has to beat the generic
//      "insufficient" wording, or the user is told to top up the wrong thing.

// ── the table ──────────────────────────────────────────────────────────────
// Each entry: [matcher, what the user is told]. Matcher is a RegExp tested
// against the flattened error text. Keep the matcher tight: a loose one wins the
// first-match scan and swallows a more specific entry below it.
const TABLE = [
  // ── the person changed their mind ────────────────────────────────────────
  [/user (?:rejected|denied|cancell?ed)|ACTION_REJECTED|code[= ]4001/i,
    'You cancelled this, so nothing was sent.'],
  [/request rejected|denied by (?:the )?user/i,
    'The request was declined in your wallet, so nothing was sent.'],

  // ── the wallet could not pay for the transaction ─────────────────────────
  // Before the generic "insufficient" wording, because the remedy is different:
  // one needs a fee bump, the other needs a bigger balance.
  [/insufficient funds(?: for gas| for .*? \*\s*value|\b.*gas.*\+ value)/i,
    'Not enough coin in this wallet to pay the network fee (gas). Add some, or lower the amount you are sending.'],
  [/gas required exceeds allowance/i,
    'Your wallet set a gas limit that is too low for this transaction. Raise the gas limit, or send a smaller amount.'],
  [/intrinsic gas too low|gas limit too low/i,
    'The network fee (gas) is set too low for the chain to accept it. Raise the gas limit and try again.'],
  [/max fee per gas less than block base fee|maxFeePerGas too low|base fee exceeds gas price/i,
    'The network fee is below what the chain is currently charging. Raise the maximum fee and try again.'],
  [/transaction underpriced|replacement transaction underpriced/i,
    'A transaction from this wallet is still waiting, and the new one is cheaper than it. Wait for the first to finish, or raise the fee.'],
  [/nonce too (?:low|high)|already known/i,
    'A transaction from this wallet is still pending. Wait for it to finish, then try again.'],
  [/replacement fee too low/i,
    'Another transaction from this wallet is pending. Wait for it, or raise the fee above what it paid.'],
  [/gas limit reached|out of gas/i,
    'The transaction ran out of gas before it finished. Try again, or use a route that does more work.'],

  // ── the amount does not fit ──────────────────────────────────────────────
  [/ERC20: transfer amount exceeds balance|ds-math-sub-underflow|insufficient balance/i,
    'Not enough of this token in the wallet for that amount.'],
  [/SafeERC20: low-level call failed|transfer amount exceeds/i,
    'The token transfer was refused. Check the balance and the decimals of the amount.'],

  // ── approval ─────────────────────────────────────────────────────────────
  // Distinct from "not enough balance" on purpose: the balance is fine, the
  // permission is missing, and the fix is a different button.
  [/TRANSFER_FROM_FAILED|ERC20: insufficient allowance|transfer amount exceeds allowance|not enough allowance/i,
    'This token is not approved for the router yet. Approve it first, then run the swap again.'],
  [/ERC20: approve to the zero address/i,
    'That approval was cancelled, so the router still cannot spend this token.'],

  // ── price moved ──────────────────────────────────────────────────────────
  [/INSUFFICIENT_OUTPUT_AMOUNT|Too little received|excessive output amount/i,
    'The price moved against you before the swap went through. Try again, or raise the slippage tolerance a little.'],
  [/EXCESSIVE_INPUT_AMOUNT|Too much requested/i,
    'The price moved in your favour but the swap was capped. Try again to spend less for the same output.'],
  [/INSUFFICIENT_INPUT_AMOUNT|no pair|INSUFFICIENT_LIQUIDITY|Too little requested/i,
    'There is no trading pair with funds for this combination on this network. Try a different token or network.'],
  [/UniswapV2: K\b|K invariant/i,
    'The pair’s reserves changed while the swap was pending. Quote again and send it promptly.'],
  [/IDENTICAL_ADDRESSES|INVALID_PATH/i,
    'Those are the same asset — the native coin and its wrapped form. Pick a different token.'],
  [/EXPIRED|deadline|Transaction too old/i,
    'This request expired before it went through. Try again for a fresh quote.'],
  [/ONLY_SWAP_EXACT_AMOUNT|STF/i,
    'The router rejected this exact-amount swap. Try the other swap direction.'],

  // ── not connected ────────────────────────────────────────────────────────
  [/could not detect network|NETWORK_ERROR|fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|network (?:request )?failed/i,
    'Could not reach the network. Check your internet connection, then try again.'],
  [/underlying network|chain disconnected|LD_LIBRARY/i,
    'The network connection dropped. Reconnect the wallet and try again.'],
  [/Unsupported chain|chain not configured|is not deployed on chain|is not available on chain|not a valid chain/i,
    'That network is not one this tool can connect to. Pick a supported network.'],
  [/timed out|timeout|deadline exceeded/i,
    'That took too long and was stopped before it finished. Try again.'],

  // ── account and keys ─────────────────────────────────────────────────────
  [/unlock|wallet (?:is )?locked|no (?:wallet|signer)|not connected/i,
    'The wallet is locked. Unlock it first, then try again.'],
  [/incorrect password|wrong password|decrypt|invalid password/i,
    'That password did not unlock this wallet. Check it and try again.'],
  [/user rejected the request|signature/i,
    'The signature was not completed, so nothing was sent.'],

  // ── contract and token problems ──────────────────────────────────────────
  [/contract creation code storage out of gas|CREATE2/i,
    'The contract could not be created. The bytecode may not fit in one transaction, or the gas limit is too low.'],
  [/Ownable: caller is not the owner|only owner|not authorized|unauthorized/i,
    'This wallet is not allowed to do that.'],
  [/ERC721: owner query for nonexistent token|ERC721: invalid token ID|invalid token id/i,
    'That token ID does not exist in this collection.'],
  [/ERC721: caller is not owner nor approved|not approved for this token/i,
    'This wallet does not own that token, or is not approved to act for it.'],
  [/ERC1155: batch transfer|Insufficient Balance|ERC1155: caller is not owner/i,
    'This wallet does not hold enough of that item.'],
  // Anchored on "for this token" or "spend", not on the bare word: without that it
  // also matched "gas required exceeds allowance" and answered a fee problem with
  // a token-approval sentence. The specific rule above wins today, and this one is
  // the last line of defence — a last line that catches the wrong thing is worse
  // than no line at all, because it is confident.
  [/allowance for this token|allowance.*(?:not set|is 0|spend)/i,
    'The approval for this token is not set. Approve it first.'],
  [/reentrancy|ReentrancyGuard/i,
    'This call could not complete safely. Try again once.'],
  [/PancakeRouter: EXPIRED|PancakeRouter: INSUFFICIENT_INPUT_AMOUNT|PancakeRouter: INVALID_PATH/i,
    'That route did not go through. Quote again and try.'],

  // ── the tool asking OpenSea things ───────────────────────────────────────
  [/401|api key required|apikey.*required|unauthorized.*opensea/i,
    'OpenSea needs an API key. Paste one in the OpenSea panel above, then try again.'],
  [/429|rate limit|too many requests/i,
    'OpenSea is rate-limiting this key. Wait a moment and try again.'],
  [/no collection|not found.*collection|collection.*not found|404/i,
    'OpenSea has no collection with that name. Check the spelling, or use the contract address.'],
  [/403|forbidden/i,
    'OpenSea refused this request. Check the API key and try again.'],
  [/not a holder|not eligible|zero holders|0 recorded holders/i,
    'That wallet is not in this collection’s holder list, so it is not eligible.'],
];

// ── recognising raw text ───────────────────────────────────────────────────
// If a string shows any of these, it came from a machine and needs translating.
// Everything else is already something a person wrote, and is left alone.
const RAW_MARKERS = [
  /execution reverted/i,
  /"reason":/i,
  /\bCALL_EXCEPTION\b|\bUNPREDICTABLE_GAS_LIMIT\b|\bINSUFFICIENT_FUNDS\b|\bACTION_REJECTED\b|\bTRANSACTION_REPLACED\b/i,
  /\bcode\s*[:=]\s*["']?[A-Z_]{4,}|\bcode=[A-Z_]{4,}/i,
  /\baction\s*[:=]\s*"|\btransaction\s*=\s*\{/i,
  /0x[0-9a-fA-F]{8,}/,
  /^\s*Error:|\bError:\s|\bTypeError\b|\bReferenceError\b|\bRangeError\b/,
  /\sat\s+\S+\s+\(/,
  /\{"|"\w+":/,
  // Ethers' own pre-flight wording, which arrives with no JSON and no hex and
  // so every other marker misses it. Found by the tests, not by reading it.
  /cannot estimate gas|transaction may fail or may require manual gas limit|user canceled|request failed|call revert exception/i,
  /--check|node_modules|\.js:\d+/,
  /^\s*\[object /,
];

/** True when the text looks like it came out of a stack, not out of a person. */
export function looksRaw(msg) {
  const s = String(msg ?? '');
  if (!s.trim()) return false;
  // Long, multi-line stack-shaped text is raw even if no single marker matches.
  if (s.includes('\n') && s.length > 160) return true;
  return RAW_MARKERS.some((re) => re.test(s));
}

/** A short one-line label, for a heading. Falls back to the feature name. */
export function headline(err, context) {
  const where = context ? String(context).replace(/\s+(failed|error)\s*$/i, '').trim() : '';
  return where ? `${where} could not be completed` : 'That did not go through';
}

// Ethers hides the useful part of a revert several objects down, and the top
// level message is a wall of transaction JSON. This is the same walk the fork
// tests need, kept here so features do not each reinvent it and get a different
// depth of detail.
function flatten(err) {
  const parts = [];
  const seen = new Set();
  let cur = err;
  for (let i = 0; i < 8 && cur && typeof cur === 'object'; i++) {
    for (const k of ['reason', 'shortMessage', 'message']) {
      const v = cur[k];
      if (typeof v === 'string' && v.trim() && !seen.has(v)) { seen.add(v); parts.push(v); }
    }
    if (Array.isArray(cur.revert?.args) && cur.revert.args.length) {
      parts.push(`revert args: ${cur.revert.args.filter((a) => typeof a === 'string').join(' ')}`);
    }
    for (const v of [cur.info?.error, cur.error, cur.data?.error]) {
      if (v && typeof v === 'object') { cur = v; break; }
      if (typeof v === 'string' && v.trim() && !seen.has(v)) { seen.add(v); parts.push(v); }
    }
    if (!cur.info?.error && !cur.error) break;
  }
  return parts.join('  •  ') || String(err ?? '');
}

/** The unmangled text, for the console and for bug reports. Never shown. */
export function rawDetail(err) {
  return flatten(err);
}

/**
 * Explain a failure in plain words.
 *
 * @param {*} err   an Error, a rejected-promise value, or a plain string
 * @param {string} [context]  the feature name, e.g. "Swap", "Bridge", "Send"
 * @returns {string} a sentence for a person, with no code in it
 */
export function explainError(err, context) {
  const text = flatten(err);

  // 1. A rule that matches a specific machine token wins. This is tried FIRST, and
  //    the order is the whole design: the first version asked "is this raw?" before
  //    consulting the table, so `new Error('gas required exceeds allowance')` was
  //    judged already-human and passed through untouched — the exact failure it was
  //    written to fix. Deciding "is it raw?" is the wrong question, because half the
  //    machine messages here are bare tokens with no JSON, no stack and no hex, and
  //    a raw-text sniff cannot see them. "Does a rule match?" can.
  //
  //    Safe against over-eager rewriting because every matcher is anchored on a
  //    specific token, not on prose: this app's own sentences do not contain
  //    `INSUFFICIENT_OUTPUT_AMOUNT`, so they never reach a rule.
  for (const [re, say] of TABLE) {
    if (re.test(text)) {
      console.warn(`[explain] ${context || 'error'} →`, say, '\n  raw:', text.slice(0, 400));
      return say;
    }
  }

  // 2. No rule matched. If it reads as a sentence rather than machine output, it is
  //    almost certainly one this app wrote on purpose — "Enter amount to swap",
  //    "Fill contract, token ID, and price." Those must arrive unchanged.
  if (typeof err === 'string' && !looksRaw(err)) return err;
  if (err && typeof err === 'object' && typeof err.message === 'string'
      && !looksRaw(err.message) && !err.reason && !err.code) {
    return err.message;
  }

  // 3. Nothing matched and it did not read as a sentence either. Say what was
  //    attempted and that the detail went to the console — never the raw text,
  //    which is the whole point of this module.
  const what = context ? `${context} could not be completed.` : 'That did not go through.';
  console.warn('[explain] no rule matched →', context, '\n  raw:', text.slice(0, 600));
  return `${what} The technical detail was written to the browser console. Try again in a moment.`;
}

export const __tableSize = TABLE.length;
