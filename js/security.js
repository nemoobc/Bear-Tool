// ═══════════════════════════════════════════════════════════════
// security.js — the checks that sit between a dApp and a signature.
//
// Every wallet in the comparison set ships some version of this. MetaMask runs
// transactions through Blockaid; Rabby simulates the call and shows which
// assets move; Coinbase Wallet blocks a known scam list. Those are paid
// services. What is reproducible here without one is narrower but real:
//
//   - calldata decoding for the handful of selectors that actually cost people
//     money: approve / increaseAllowance / setApprovalForAll / permit
//   - an "unlimited approval" check, which is the single most common way a
//     wallet gets drained after one careless click
//   - an unknown-selector and unknown-contract warning, because a call you
//     cannot read is a call you should not sign blind
//   - a typed-confirmation recommendation above a value threshold
//   - refusing to persist a URL that looks like it carries a secret, so a seed
//     typed into a dApp form never becomes a bookmark
//   - an EIP-1193 method allow-list for the injected provider
//
// Again: these are heuristics over public calldata, not an audit. Every finding
// states what it saw, and the signature modal always shows the raw calldata so
// the user can check it independently.
// ═══════════════════════════════════════════════════════════════

export const MAX_UINT256 = (1n << 256n) - 1n;

// A "signature" here is an approval, not a login. This is the one every drainer
// asks for and the one people wave through.
const SEL = {
  approve: '0x095ea7b3',            // approve(address,uint256)
  increaseAllowance: '0x39509351',  // increaseAllowance(address,uint256)
  decreaseAllowance: '0xa457c2d7',  // decreaseAllowance(address,uint256)
  setApprovalForAll: '0xa22cb465',  // setApprovalForAll(address,bool)
  transferFrom: '0x23b872dd',       // transferFrom(address,address,uint256)
  permit: '0xd505accf',             // permit(address,address,uint256,uint256,uint8,bytes32,bytes32)
  safeTransferFrom: '0x42842e0e',   // safeTransferFrom(address,address,uint256)
  setApprovalForAllSafe: '0x6c8f2a45', // some ERC721 variants
};

const SEL_NAMES = Object.fromEntries(Object.entries(SEL).map(([k, v]) => [v, k]));

// ═══ URL secret hygiene ═══════════════════════════════════════════════════

// Words that only appear in a URL when someone put a secret in it.
const SECRET_WORDS = /(seed|mnemonic|recovery[-_]?phrase|privkey|priv[-_]?key|private[-_]?key|secret|passphrase|password|api[-_]?key|apikey|token=|bearer)/i;

/** A long hex run: 32+ bytes of raw key material in a path or query. */
const HEX_BLOB = /(^|[?&=/])0x?[0-9a-fA-F]{64,}([0-9a-fA-F]*)/;

/** A 64-char bare hex (no 0x) — a raw private key typed into a search box. */
const BARE_HEX_64 = /(^|[/?&=])[0-9a-fA-F]{64}([0-9a-fA-F]*)/;

/** A 12/15/18/21/24-word sequence — BIP-39 look-alike. */
const WORD_RUN = /\b(\w+\s+){11,23}\w+\b/;

/**
 * Should this URL never be written into history, bookmarks or a tab list?
 * @returns {{secret:boolean, why:string|null}}
 */
export function isSecretishUrl(url) {
  const s = String(url || '');
  if (!s) return { secret: false, why: null };
  let m = s.match(SECRET_WORDS);
  if (m) return { secret: true, why: `the address contains "${m[1]}"` };
  m = s.match(HEX_BLOB) || s.match(BARE_HEX_64);
  if (m) {
    const body = m[1].replace(/^[/?&=]/, '');
    return { secret: true, why: `a ${body.length}-character hex run — that is key material, not a page address` };
  }
  // Only meaningful inside the query or fragment; a long path segment of words
  // is far more likely to be a title.
  const tail = s.split('#')[1] || (s.includes('?') ? s.slice(s.indexOf('?')) : '');
  if (tail && WORD_RUN.test(tail)) {
    return { secret: true, why: 'a long run of words in the query — that is how a recovery phrase gets pasted by accident' };
  }
  return { secret: false, why: null };
}

/**
 * Strip what a stored URL does not need and refuse to store a secret at all.
 * The fragment is dropped: it is never sent to a server, it routinely holds
 * OAuth tokens, and keeping it would put those tokens in localStorage.
 * @returns {string|null} null means "do not store this"
 */
export function sanitizeForStore(url) {
  const s = String(url || '').trim();
  if (!s) return null;
  if (isSecretishUrl(s).secret) return null;
  try {
    const u = new URL(s);
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

// ═══ calldata decoding ════════════════════════════════════════════════════

function stripHex(s) {
  return String(s || '').replace(/^0x/, '').toLowerCase();
}

// ABI layout is a 4-byte selector followed by 32-byte words, so word N starts
// 8 hex characters in — not at N*64 — and the FIRST argument is word 0. Getting
// either wrong makes every decode return null, which reads as "not an approval"
// and would hide a live one. Hence the explicit index pairs below rather than a
// shared guess.
const SELECTOR_BYTES = 8;

/** Read ABI word `index` (0-based, counting arguments) as a bigint. */
function word(hex, index) {
  const start = SELECTOR_BYTES + index * 64;
  const w = hex.slice(start, start + 64);
  if (w.length < 64) return null;
  try { return BigInt('0x' + w); } catch { return null; }
}

/** Read ABI word `index` as a left-padded address, or null. */
function wordAddress(hex, index) {
  const w = hex.slice(SELECTOR_BYTES + index * 64, SELECTOR_BYTES + (index + 1) * 64);
  if (w.length < 64) return null;
  const addr = w.slice(24);
  if (!/^[0-9a-f]{40}$/.test(addr) || /^0{40}$/.test(addr)) return null;
  return '0x' + addr;
}

// Which word holds the spender, and which holds the amount, per selector.
const APPROVAL_LAYOUT = {
  approve: { spender: 0, amount: 1 },
  increaseAllowance: { spender: 0, amount: 1 },
  decreaseAllowance: { spender: 0, amount: 1 },
  setApprovalForAll: { spender: 0, amount: 1 },
  setApprovalForAllSafe: { spender: 0, amount: 1 },
  permit: { spender: 1, amount: 2 },
};

/**
 * Decode the approval-shaped calls.
 * @returns {null|{fn:string,spender:string,amount:bigint,unlimited:boolean,operator:boolean}}
 */
export function decodeApproval(data) {
  const hex = stripHex(data);
  if (hex.length < 8) return null;
  const name = SEL_NAMES['0x' + hex.slice(0, 8)];
  const layout = name && APPROVAL_LAYOUT[name];
  if (!layout) return null;

  const spender = wordAddress(hex, layout.spender);
  if (!spender) return null;
  const amount = word(hex, layout.amount);
  if (amount === null) return null;

  // A bool argument lives in a full word: 0 means false, anything else true.
  const operator = name === 'setApprovalForAll' || name === 'setApprovalForAllSafe';
  // For an operator grant the argument is a flag, not an amount, so "true"
  // means everything rather than "large". For a token allowance the number
  // itself is the exposure, and anything at or above the practical maximum
  // counts as unlimited.
  const unlimited = operator
    ? amount !== 0n
    : amount !== 0n && (amount >= MAX_UINT256 || amount > MAX_UINT256 / 2n);
  return { fn: name, spender, amount, unlimited, operator };
}

export function selectorOf(data) {
  const hex = stripHex(data);
  return hex.length >= 8 ? '0x' + hex.slice(0, 8) : null;
}

export function selectorName(data) {
  return SEL_NAMES[selectorOf(data)] || null;
}

// ═══ transaction scan ═════════════════════════════════════════════════════

/** Above this, ask the user to type the amount instead of just clicking. */
export const BIG_VALUE_WEI = 10n ** 18n; // 1 ETH-equivalent

/**
 * @param {object} tx
 * @param {string} tx.to            recipient / contract
 * @param {string} [tx.data]        calldata
 * @param {bigint|string} [tx.value] native value in wei
 * @param {string[]} [tx.knownContracts] addresses the user has interacted with
 * @param {boolean} [tx.knownSpender] recipient is a token/contract already trusted
 * @returns {{risk:'low'|'elevated'|'high', findings:Array<{level:string,title:string,detail:string}>, approval:object|null}}
 */
export function scanTransaction(tx = {}) {
  const findings = [];
  const to = String(tx.to || '').toLowerCase();
  const data = stripHex(tx.data);
  let value = 0n;
  try { value = BigInt(tx.value ?? 0); } catch { value = 0n; }
  const known = new Set((tx.knownContracts || []).map((a) => String(a).toLowerCase()));
  const add = (level, title, detail) => findings.push({ level, title, detail });

  const approval = decodeApproval(tx.data);

  if (!data) {
    // A plain native transfer. Not dangerous, but still the one people rush.
    add('info', 'Plain transfer', value > 0n
      ? `Sending ${(Number(value) / 1e18).toFixed(6)} native units and nothing else. Double-check the recipient — a transfer cannot be reversed.`
      : 'No calldata. This sends nothing.');
  } else {
    const sel = '0x' + data.slice(0, 8);
    const name = SEL_NAMES[sel];

    if (approval) {
      if (approval.operator && approval.unlimited) {
        add('fail', 'Operator access for every token you own',
          `${approval.spender} may move any NFT you hold, at any time, without asking you. Treat this as handing over the whole collection. Revoke it in Approvals if you did not mean to.`);
      } else if (approval.unlimited) {
        add('fail', 'Unlimited spending approval',
          `${approval.spender} may draw an unlimited amount of this token from your wallet. Any contract it calls can take everything. This is the step that turns one bad interaction into an empty account.`);
      } else if (approval.amount > 0n) {
        add('warn', 'Spending approval',
          `${approval.spender} may spend up to ${approval.amount} of this token. Bounded, but still a standing permission.`);
      } else {
        add('pass', 'Approval revoked', `The allowance for ${approval.spender} is set to zero.`);
      }
    }

    if (name === 'permit') {
      add('warn', 'Off-chain permit',
        'This is a permit: it authorises a spender in one signature, normally so a gasless approval can happen later. The spend is real even though no transaction is sent now.');
    }
    if (name === 'transferFrom' || name === 'safeTransferFrom') {
      add('warn', 'Transferring a token you may not own',
        'This pulls a token out of an address other than your own. If you are approving someone else’s withdrawal, that is a custody decision, not a payment.');
    }
    if (!name) {
      add('warn', 'Unrecognised function',
        `Selector ${sel} is not one this wallet can name. The full calldata is shown below — read it, or refuse it. A call you cannot decode is a call you should not sign on trust.`);
    }
  }

  if (to && known.size && !known.has(to) && data) {
    add('warn', 'Contract you have not used before',
      `${to} has no history with this wallet. A first interaction is exactly when a lookalike contract gets signed.`);
  }
  if (!to) {
    add('fail', 'No destination', 'The transaction has no recipient, so there is nowhere for value to land.');
  }

  if (value >= BIG_VALUE_WEI) {
    add('warn', 'Large amount',
      `This moves ${(Number(value) / 1e18).toFixed(4)} native units. Type the amount to confirm rather than clicking through.`);
  }

  const risk = findings.some((f) => f.level === 'fail') ? 'high'
    : findings.some((f) => f.level === 'warn') ? 'elevated'
      : 'low';

  return { risk, findings, approval };
}

// ═══ EIP-1193 method allow-list ═══════════════════════════════════════════

// What an injected provider on the wallet's own origin will answer. Anything
// not listed is refused with a clear error rather than forwarded, because a
// blanket proxy to the signer is the same as no gate at all.
export const ALLOWED_METHODS = new Set([
  'eth_requestAccounts',
  'eth_accounts',
  'eth_chainId',
  'net_version',
  'eth_getBalance',
  'eth_blockNumber',
  'eth_call',
  'eth_estimateGas',
  'eth_gasPrice',
  'eth_maxPriorityFeePerGas',
  'eth_feeHistory',
  'eth_getBlockByNumber',
  'eth_getTransactionCount',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'eth_getLogs',
  'eth_getCode',
  'eth_getStorageAt',
  'eth_getTransactionByBlockNumberAndIndex',
  'personal_sign',
  'eth_signTypedData',
  'eth_signTypedData_v1',
  'eth_signTypedData_v3',
  'eth_signTypedData_v4',
  'eth_sendTransaction',
  'wallet_switchEthereumChain',
  'wallet_addEthereumChain',
  'wallet_getPermissions',
  'wallet_requestPermissions',
  'wallet_revokePermissions',
  'wallet_watchAsset',
]);

// Methods that change state and therefore always need the wallet's own
// confirmation UI — never a silent answer.
export const CONFIRMED_METHODS = new Set([
  'personal_sign',
  'eth_signTypedData',
  'eth_signTypedData_v1',
  'eth_signTypedData_v3',
  'eth_signTypedData_v4',
  'eth_sendTransaction',
  'wallet_switchEthereumChain',
  'wallet_addEthereumChain',
]);

export function isAllowedMethod(method) {
  return ALLOWED_METHODS.has(String(method || ''));
}

export function needsConfirmation(method) {
  return CONFIRMED_METHODS.has(String(method || ''));
}
