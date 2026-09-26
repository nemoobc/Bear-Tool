// ═══════════════════════════════════════════════════════════════
// Bear Tool — swap.js
// Swap & Bridge view: token select, flip, auto-route quote
// (KyberSwap → Uniswap V3 → Uniswap V2), slippage wired,
// approve + execute path. NO simulated fallback — every quote is
// a real on-chain/API route or an honest error.
// ═══════════════════════════════════════════════════════════════

import { $, toast, confirmTx, escapeHtml, spinnerDots } from './ui.js';
import { get, set, addActivity, requireUnlock, emit } from './state.js';
import { runTx, waitForReceipt } from './safetx.js';
import { getNetworkById, ERC20_ABI } from './network.js';
import { SWAP_ROUTERS, getSwapRoutersForChain, getBestSwapRouter, CHAIN_NAMES } from './routers.js';
import { initTokenPicker } from './token-picker.js';
import { resolveMax } from './max-ui.js';

const { ethers } = globalThis;

// ── KyberSwap Aggregator constants ──
const KYBER_API = 'https://aggregator-api.kyberswap.com';
const CLIENT_ID = 'bear-tool';
const NATIVE_SENTINEL = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const CACHE_TTL = 30_000;

// ── 1inch Aggregator API ──
const ONEINCH_API = 'https://api.1inch.dev/swap/v6.0';

// ── ParaSwap API ──
const PARASWAP_API = 'https://api.paraswap.io';

// ── Uniswap Router V2/V3 constants ──
const UNISWAP_V2_ROUTER = {
  1: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D', // Ethereum
  5: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D', // Goerli
  11155111: '0xeE567Fe1712Faf6149d80dA1E6934E354124CfE3', // Sepolia (V2Router02 — different address from mainnet!)
  10: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D', // Optimism
  137: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D', // Polygon
  42161: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D', // Arbitrum
};
const UNISWAP_V3_ROUTER = {
  1: '0xE592427A0AEce92De3Edee1F18E0157C05861564', // Ethereum
  5: '0xE592427A0AEce92De3Edee1F18E0157C05861564', // Goerli
  11155111: '0xE592427A0AEce92De3Edee1F18E0157C05861564', // Sepolia
  10: '0xE592427A0AEce92De3Edee1F18E0157C05861564', // Optimism
  137: '0xE592427A0AEce92De3Edee1F18E0157C05861564', // Polygon
  42161: '0xE592427A0AEce92De3Edee1F18E0157C05861564', // Arbitrum
};
// Uniswap V3 QuoterV2 — deterministic CREATE2 address, same on every chain.
// (Verified on-chain: code present on 1/10/137/42161/8453; Sepolia has none
// and is rejected by the runtime code guard → honest error.)
const UNISWAP_QUOTER_V3 = {
  1: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
  10: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
  137: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
  42161: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
  8453: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
};

// Uniswap V2 Router ABI (minimal)
const UNISWAP_V2_ABI = [
  'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
  'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)',
  'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
  'function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)',
  'function factory() external pure returns (address)',
  'function WETH() external pure returns (address)',
];

// Uniswap V3 SwapRouter ABI (minimal)
const UNISWAP_V3_ABI = [
  'function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) calldata params) external payable returns (uint256 amountOut)',
  'function exactInput(tuple(bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum) calldata params) external payable returns (uint256 amountOut)',
];

// chainId → native wrapped token (used for V3 native substitution)
const CHAIN_WETH = {
  1: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // Ethereum WETH
  5: '0xB4FBF271143F4FBf7B91A5ded31805e42b2208d6', // Goerli WETH
  10: '0x4200000000000000000000000000000000000006', // OP WETH
  56: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', // BSC WBNB
  137: '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270', // Polygon WMATIC
  8453: '0x4200000000000000000000000000000000000006', // Base WETH
  42161: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', // Arbitrum WETH
  11155111: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14', // Sepolia WETH (verified on-chain via router.WETH())
};

// ── Extended popular tokens ──
export const POPULAR_TOKENS = {
  1: [ // Ethereum Mainnet
    { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', symbol: 'WETH', decimals: 18 },
    { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: 6 },
    { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', symbol: 'USDT', decimals: 6 },
    { address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', symbol: 'DAI', decimals: 18 },
    { address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', symbol: 'WBTC', decimals: 8 },
    { address: '0x514910771AF9Ca656af840dff83E8264EcF986CA', symbol: 'LINK', decimals: 18 },
    { address: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', symbol: 'UNI', decimals: 18 },
    { address: '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9', symbol: 'AAVE', decimals: 18 },
    { address: '0xae78736Cd615f374D3085123A210448E74Fc6393', symbol: 'rETH', decimals: 18 },
    { address: '0xBe9895146f7AF43049ca1c1AE358B0541Ea49704', symbol: 'cbETH', decimals: 18 },
    { address: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0', symbol: 'wstETH', decimals: 18 },
    { address: '0x9e1028F5F1D5eDE59748FFceE5532509976840E0', symbol: 'FRAX', decimals: 18 },
  ],
11155111: [ // Sepolia
    { address: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14', symbol: 'WETH', decimals: 18 },
    { address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', symbol: 'USDC', decimals: 6 },
    { address: '0x779877A7B0D9E8603169DdbD7836e478b4624789', symbol: 'LINK', decimals: 18 },
  ],
  42161: [ // Arbitrum
    { address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', symbol: 'WETH', decimals: 18 },
    { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', symbol: 'USDC', decimals: 6 },
    { address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', symbol: 'USDT', decimals: 6 },
    { address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', symbol: 'DAI', decimals: 18 },
  ],
};

// chainId → KyberSwap API slug
const KYBER_CHAIN_SLUG = {
  1: 'ethereum',
  10: 'optimism',
  56: 'bnb',
  137: 'polygon',
  8453: 'base',
  42161: 'arbitrum',
};

// ── simple quote cache
let quoteCache = { key: null, data: null, ts: 0 };

function cacheKey(slug, tokenIn, tokenOut, amountIn) {
  return `${slug}:${tokenIn}:${tokenOut}:${amountIn}`;
}

// ── token lookup helper
function tokenInfo(addr) {
  return get('tokens').find(t => t.address === addr) || null;
}

export function bindSwapEvents() {
  $('#btnSwap').addEventListener('click', doSwap);
  $('#btnSwapFlip').addEventListener('click', flipSwap);
  $('#swapFromAmount').addEventListener('input', debounce(getSwapQuote, 600));
  // slippage buttons
  document.querySelectorAll('.slippage-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.slippage-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });
  // MAX button. It used to fill the field with the entire balance, which on the
  // native token means the swap cannot pay its own gas — the transaction is
  // rejected and the user has no idea why. resolveMax subtracts the fee first
  // and truncates, and it leaves the field empty with an explanation when the
  // balance cannot cover the fee at all.
  const maxBtn = $('#btnSwapMax');
  if (maxBtn) {
    maxBtn.addEventListener('click', async () => {
      const sel = $('#swapFrom');
      const t = get('tokens').find(x => (x.address || 'native') === sel.value);
      if (!t) return;
      const r = await resolveMax({
        token: { balance: t.balance, decimals: t.decimals, address: t.address, symbol: t.symbol },
        provider: get('provider'),
        from: get('address'),
        pct: 100,
      });
      const field = $('#swapFromAmount');
      const note = $('#swapMaxNote');
      if (!r.ok) {
        field.value = '';
        if (note) { note.textContent = r.message; note.classList.add('show'); }
        toast('MAX is not available here', 'error');
        return;
      }
      field.value = r.amount;
      if (note) { note.textContent = r.message; note.classList.add('show'); }
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
}

export function loadSwapTokens() {
  const from = $('#swapFrom'), to = $('#swapTo');
  if (!from || !to) return;
  const net = getNetworkById(get('networkId'));

  // Offer the chain's popular tokens plus anything the user holds. Previously
  // this listed ONLY held tokens, so a wallet holding just ETH got a
  // single-option dropdown and swapping was impossible.
  const held = get('tokens') || [];
  const tokens = [...held];
  const seen = new Set(held.map(t => (t.address || 'native').toLowerCase()));
  for (const p of (POPULAR_TOKENS[net?.chainId] || [])) {
    if (!seen.has(p.address.toLowerCase())) {
      tokens.push({ address: p.address, symbol: p.symbol, decimals: p.decimals, balance: '0', usd: null });
      seen.add(p.address.toLowerCase());
    }
  }
  // native gas token must always be selectable
  if (!tokens.some(t => !t.address)) {
    tokens.unshift({
      address: null, symbol: net?.symbol || 'Native',
      decimals: net?.decimals ?? 18, balance: '0', usd: null
    });
  }

  const opts = tokens.map(t =>
    `<option value="${escapeHtml(t.address || 'native')}">${escapeHtml(t.symbol)}</option>`
  ).join('');
  from.innerHTML = opts;
  to.innerHTML = opts;
  if (from.options.length > 1) to.selectedIndex = 1;

  // Show an in-app chooser with logos on top of the native select, which stays
  // authoritative. A native select's option list is an OS popup that escapes
  // the page on a phone; the picker's list is clamped inside the app.
  initTokenPicker('swapFrom', tokens);
  initTokenPicker('swapTo', tokens);

  // update balance displays + auto-route quote on token change
  const updateBalance = () => {
    const ft = tokens.find(x => (x.address || 'native') === from.value);
    const tt = tokens.find(x => (x.address || 'native') === to.value);
    const fb = $('#swapFromBalance'), tb = $('#swapToBalance');
    if (fb && ft) fb.textContent = `Balance: ${parseFloat(ethers.formatUnits(ft.balance, ft.decimals)).toFixed(4)}`;
    if (tb && tt) tb.textContent = `Balance: ${parseFloat(ethers.formatUnits(tt.balance, tt.decimals)).toFixed(4)}`;
    // auto-route: refresh quote when tokens change (if amount > 0)
    const amt = $('#swapFromAmount')?.value;
    if (amt && parseFloat(amt) > 0) getSwapQuote();
  };
  // re-binding on every view switch used to stack duplicate listeners
  if (from._bearBalanceHandler) from.removeEventListener('change', from._bearBalanceHandler);
  if (to._bearBalanceHandler) to.removeEventListener('change', to._bearBalanceHandler);
  from._bearBalanceHandler = updateBalance;
  to._bearBalanceHandler = updateBalance;
  from.addEventListener('change', updateBalance);
  to.addEventListener('change', updateBalance);
  updateBalance();
}

export function flipSwap() {
  const from = $('#swapFrom'), to = $('#swapTo');
  const tmp = from.value; from.value = to.value; to.value = tmp;
  // refresh balances (which also triggers auto-quote if amount > 0)
  from.dispatchEvent(new Event('change'));
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ── fetch with timeout (AbortController) ──
async function fetchWithTimeout(url, opts = {}, ms = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── KyberSwap: fetch routes (quote) ──
async function kyberQuote(slug, tokenIn, tokenOut, amountIn) {
  const url = `${KYBER_API}/${slug}/api/v1/routes?tokenIn=${tokenIn}&tokenOut=${tokenOut}&amountIn=${amountIn}`;
  const res = await fetchWithTimeout(url, { headers: { 'x-client-id': CLIENT_ID } });
  if (!res.ok) throw new Error(`KyberSwap quote HTTP ${res.status}`);
  const json = await res.json();
  if (!json.data?.routeSummary) throw new Error('KyberSwap: empty route');
  return json.data; // { routeSummary, routerAddress }
}

// ── KyberSwap: build transaction data ──
async function kyberBuild(slug, routeSummary, sender, recipient, slippageBps) {
  const url = `${KYBER_API}/${slug}/api/v1/route/build`;
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-client-id': CLIENT_ID },
    body: JSON.stringify({
      routeSummary,
      sender,
      recipient,
      slippageTolerance: slippageBps,
    }),
  });
  if (!res.ok) throw new Error(`KyberSwap build HTTP ${res.status}`);
  const json = await res.json();
  if (!json.data?.data || !json.data?.routerAddress) throw new Error('KyberSwap: empty build');
  return json.data; // { data (calldata), routerAddress (address) }
}

// ── 1inch: fetch swap quote ──
async function oneinchQuote(chainId, tokenIn, tokenOut, amountIn) {
  const url = `${ONEINCH_API}/${chainId}/quote?src=${tokenIn}&dst=${tokenOut}&amount=${amountIn}`;
  const res = await fetchWithTimeout(url, { headers: { 'Authorization': 'Bearer ' + (globalThis.__ONEINCH_API_KEY || '') } });
  if (!res.ok) throw new Error(`1inch quote HTTP ${res.status}`);
  const json = await res.json();
  if (!json.dstAmount) throw new Error('1inch: empty quote');
  return json; // { dstAmount, srcToken, dstToken, protocols }
}

// ── 1inch: build swap transaction ──
async function oneinchBuild(chainId, tokenIn, tokenOut, amountIn, fromAddr, slippageBps) {
  const slippagePct = slippageBps / 100;
  const url = `${ONEINCH_API}/${chainId}/swap?src=${tokenIn}&dst=${tokenOut}&amount=${amountIn}&from=${fromAddr}&slippage=${slippagePct}&disableEstimate=true`;
  const res = await fetchWithTimeout(url, { headers: { 'Authorization': 'Bearer ' + (globalThis.__ONEINCH_API_KEY || '') } });
  if (!res.ok) throw new Error(`1inch swap HTTP ${res.status}`);
  const json = await res.json();
  if (!json.tx) throw new Error('1inch: empty tx');
  return { data: json.tx.data, routerAddress: json.tx.to, amountOut: json.dstAmount };
}

// ── ParaSwap: fetch swap quote + build ──
async function paraswapQuote(chainId, tokenIn, tokenOut, amountIn, fromAddr, slippageBps) {
  // tokenIn/Out: use NATIVE_SENTINEL for native
  const srcToken = tokenIn === NATIVE_SENTINEL ? '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' : tokenIn;
  const dstToken = tokenOut === NATIVE_SENTINEL ? '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' : tokenOut;
  const url = `${PARASWAP_API}/prices/${chainId}/${srcToken}/${dstToken}/${amountIn}?side=SELL&slippage=${slippageBps / 100}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`ParaSwap quote HTTP ${res.status}`);
  const json = await res.json();
  if (!json.priceRoute?.destAmount) throw new Error('ParaSwap: empty quote');
  // Now build tx
  const buildUrl = `${PARASWAP_API}/transactions/${chainId}`;
  const buildRes = await fetchWithTimeout(buildUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      srcToken, dstToken, srcAmount: amountIn, destAmount: json.priceRoute.destAmount,
      userAddress: fromAddr, slippage: slippageBps / 100,
      priceRoute: json.priceRoute, side: 'SELL',
    }),
  });
  if (!buildRes.ok) throw new Error(`ParaSwap build HTTP ${buildRes.status}`);
  const tx = await buildRes.json();
  return { data: tx.data, routerAddress: tx.to, amountOut: BigInt(json.priceRoute.destAmount) };
}

// ── SushiSwap: on-chain quote via getAmountsOut (Uniswap V2 compatible) ──
async function sushiswapQuote(chainId, tokenIn, tokenOut, amountIn) {
  const routerAddr = SWAP_ROUTERS.find(r => r.id === 'sushiswap')?.router?.[chainId];
  if (!routerAddr) throw new Error('SushiSwap not available on this chain');
  const provider = get('provider');
  const code = await provider.getCode(routerAddr);
  if (!code || code === '0x') throw new Error('SushiSwap router has no code on this chain');
  const router = new ethers.Contract(routerAddr, UNISWAP_V2_ABI, provider);
  const weth = CHAIN_WETH[chainId];
  if (!weth) throw new Error('SushiSwap: no WETH mapping for this chain');
  const path = [tokenIn === NATIVE_SENTINEL ? weth : tokenIn, tokenOut === NATIVE_SENTINEL ? weth : tokenOut];
  const amounts = await router.getAmountsOut(amountIn, path);
  return { amounts, router: routerAddr, path };
}

// ── get quote — AUTO-ROUTE or user-selected router ──
// Every returned quote is REAL (API or on-chain). No simulation.
export async function getSwapQuote() {
  const amt = $('#swapFromAmount').value;
  if (!amt || parseFloat(amt) <= 0) return;

  const from = $('#swapFrom').value, to = $('#swapTo').value;
  const net = getNetworkById(get('networkId'));
  const slippageBtn = document.querySelector('.slippage-btn.active');
  const slippage = slippageBtn ? slippageBtn.dataset.val : '0.5';
  const quoteBox = $('#swapQuote');
  if (!quoteBox) return;
  quoteBox.innerHTML = spinnerDots();
  quoteBox.classList.remove('hidden');

  const sellSymbol = from === 'native' ? net.symbol : (tokenInfo(from)?.symbol ?? '???');
  const buySymbol = to === 'native' ? net.symbol : (tokenInfo(to)?.symbol ?? '???');
  const toDecimals = to === 'native' ? 18 : (tokenInfo(to)?.decimals ?? 18);
  const fromDecimals = from === 'native' ? 18 : (tokenInfo(from)?.decimals ?? 18);

  const tokenIn = from === 'native' ? NATIVE_SENTINEL : from;
  const tokenOut = to === 'native' ? NATIVE_SENTINEL : to;
  const amountInWei = ethers.parseUnits(amt, fromDecimals).toString();
  const slippageBps = Math.round(parseFloat(slippage) * 100);
  const userAddr = get('address');

  // Check user-selected router (or 'auto' = try all)
  const selectedRouter = $('#swapRouterSelect')?.value || 'auto';
  const errors = [];

  // Helper: try a specific router
  async function tryRouter(id) {
    switch (id) {
      case 'kyberswap': {
        const slug = KYBER_CHAIN_SLUG[net.chainId];
        if (!slug) throw new Error('chain not supported');
        const key = cacheKey(slug, tokenIn, tokenOut, amountInWei);
        const now = Date.now();
        let quoteData;
        if (quoteCache.key === key && now - quoteCache.ts < CACHE_TTL) {
          quoteData = quoteCache.data;
        } else {
          quoteData = await kyberQuote(slug, tokenIn, tokenOut, amountInWei);
          quoteCache = { key, data: quoteData, ts: now };
        }
        const built = await kyberBuild(slug, quoteData.routeSummary, userAddr, userAddr, slippageBps);
        const outAmount = BigInt(quoteData.routeSummary.amountOut ?? '0');
        return { source: 'KyberSwap', built, routerAddress: built.routerAddress, outAmount };
      }
      case '1inch': {
        if (!globalThis.__ONEINCH_API_KEY) throw new Error('no API key');
        const built = await oneinchBuild(net.chainId, tokenIn, tokenOut, amountInWei, userAddr, slippageBps);
        return { source: '1inch', built: { data: built.data, routerAddress: built.routerAddress }, outAmount: BigInt(built.amountOut) };
      }
      case 'paraswap': {
        const result = await paraswapQuote(net.chainId, tokenIn, tokenOut, amountInWei, userAddr, slippageBps);
        return { source: 'ParaSwap', built: { data: result.data, routerAddress: result.routerAddress }, outAmount: result.amountOut };
      }
      case 'sushiswap': {
        const v2 = await sushiswapQuote(net.chainId, tokenIn, tokenOut, amountInWei);
        const outAmount = v2.amounts[v2.amounts.length - 1];
        return { source: 'SushiSwap', uniswap: { kind: 'v2', chainId: net.chainId, tokenIn, tokenOut, amountIn: amountInWei, amountOutMin: (outAmount * (10000n - BigInt(slippageBps))) / 10000n, router: v2.router }, outAmount };
      }
      case 'uniswap_v3': {
        const v3 = await uniswapV3Quote(net.chainId, tokenIn, tokenOut, amountInWei);
        return { source: 'Uniswap V3', uniswap: { kind: 'v3', chainId: net.chainId, tokenIn, tokenOut, amountIn: amountInWei, amountOutMin: (v3.amountOut * (10000n - BigInt(slippageBps))) / 10000n, fee: v3.fee, router: v3.router }, outAmount: v3.amountOut };
      }
      case 'uniswap_v2': {
        const v2 = await uniswapV2Quote(net.chainId, tokenIn, tokenOut, amountInWei);
        const outAmount = v2.amounts[v2.amounts.length - 1];
        return { source: 'Uniswap V2', uniswap: { kind: 'v2', chainId: net.chainId, tokenIn, tokenOut, amountIn: amountInWei, amountOutMin: (outAmount * (10000n - BigInt(slippageBps))) / 10000n, router: v2.router }, outAmount };
      }
      default: throw new Error('unknown router: ' + id);
    }
  }

  // Show result from a successful quote
  function showResult(result) {
    const outFormatted = ethers.formatUnits(result.outAmount, toDecimals);
    const rate = parseFloat(outFormatted) / parseFloat(amt);
    const quoteData = { simulated: false, ...result };
    delete quoteData.outAmount;
    set('swapQuote', quoteData);
    $('#swapToAmount').value = outFormatted;
    quoteBox.innerHTML =
      `Route: <b>${escapeHtml(result.source)}</b> · Rate: 1 ${escapeHtml(sellSymbol)} ≈ ${rate.toFixed(6)} ${escapeHtml(buySymbol)}<br>` +
      `Slippage: ${escapeHtml(slippage)}%`;
  }

  // If user selected a specific router, try ONLY that one
  if (selectedRouter !== 'auto') {
    try {
      const result = await tryRouter(selectedRouter);
      return showResult(result);
    } catch (e) {
      set('swapQuote', null);
      $('#swapToAmount').value = '';
      quoteBox.innerHTML = `<div class="quote-error">⚠️ ${escapeHtml(selectedRouter)} failed: ${escapeHtml(e.message)}</div>`;
      return;
    }
  }

  // AUTO mode: try all routers in priority order
  const routerOrder = ['kyberswap', '1inch', 'paraswap', 'sushiswap', 'uniswap_v3', 'uniswap_v2'];
  for (const id of routerOrder) {
    try {
      const result = await tryRouter(id);
      return showResult(result);
    } catch (e) {
      errors.push(`${id}: ${e.message}`);
    }
  }

  // No real route — honest error.
  set('swapQuote', null);
  $('#swapToAmount').value = '';
  quoteBox.innerHTML =
    `<div class="quote-error">⚠️ No route available on ${escapeHtml(net.name)} — no swap will happen.</div>` +
    `<div class="quote-error-detail">${escapeHtml(errors.join(' · '))}</div>`;
}

// ── execute swap ──
export async function doSwap() {
  if (!get('unlocked')) { requireUnlock(); return; }
  const amt = $('#swapFromAmount').value;
  if (!amt || parseFloat(amt) <= 0) return toast('Enter amount to swap', 'error');
  const from = $('#swapFrom').value, to = $('#swapTo').value;
  const net = getNetworkById(get('networkId'));
  const quote = get('swapQuote');
  if (!quote) return toast('Get a quote first', 'error');

  if (net.type === 'mainnet') {
    const ok = await confirmTx({
      title: 'MAINNET SWAP!',
      rows: [{ k: 'From', v: `${amt} ${from}` }, { k: 'To', v: to }, { k: 'Network', v: net.name }, { k: 'Route', v: quote.source || '?' }],
      confirmText: 'Swap', danger: true, requireType: 'YA'
    });
    if (!ok) return;
  }

  // sign confirmation — show full swap details before signing
  const signOk = await confirmTx({
    title: '✍️ SIGN SWAP',
    rows: [
      { k: 'Network', v: net.name },
      { k: 'From', v: `${amt} ${from}` },
      { k: 'To', v: `→ ${to}` },
      { k: 'Router', v: quote.source || 'Auto' },
      { k: 'Slippage', v: `${get('slippage') || 0.5}%` }
    ],
    confirmText: 'Sign & Swap',
    cancelText: 'Cancel Sign',
    danger: false
  });
  if (!signOk) return toast('Swap cancelled', 'info');

  if (!quote || quote.simulated || (!quote.built && !quote.uniswap)) {
    return toast('No valid quote — get a route first.', 'error');
  }

  await runTx('swap', $('#btnSwap'), async () => {
    const provider = get('provider');
    const signer = get('signer').connect(provider);
    const userAddr = get('address');

    // ERC-20 approve if needed (shared by all routes)
    if (from !== 'native') {
      const fromDecimals = tokenInfo(from)?.decimals ?? 18;
      const amountWei = ethers.parseUnits(amt, fromDecimals);
      const router = quote.built ? quote.built.routerAddress : quote.uniswap.router;
      const c = new ethers.Contract(from, ERC20_ABI, signer);
      const allowance = await c.allowance(userAddr, router);
      if (allowance < amountWei) {
        toast('Approving token...', 'info');
        const txApprove = await c.approve(router, ethers.MaxUint256);
        const { timedOut: approveTimedOut } = await waitForReceipt(txApprove, { timeoutMs: 90000, label: 'approve confirmation' });
        if (approveTimedOut) {
          toast('Approve sent but not confirmed in time. Re-open Swap and try again once it lands.', 'info');
          return;
        }
      }
    }

    let tx;
    if (quote.built) {
      // KyberSwap aggregator route
      tx = await signer.sendTransaction({
        to: quote.built.routerAddress,
        data: quote.built.data,
        value: from === 'native' ? ethers.parseEther(amt) : 0n,
      });
    } else if (quote.uniswap.kind === 'v3') {
      const u = quote.uniswap;
      tx = await uniswapV3Swap(signer, u.chainId, u.tokenIn, u.tokenOut, u.amountIn, u.amountOutMin, userAddr, u.fee);
    } else {
      const u = quote.uniswap;
      tx = await uniswapV2Swap(signer, u.chainId, u.tokenIn, u.tokenOut, u.amountIn, u.amountOutMin, userAddr);
    }
    toast('Swap tx sent! ⏳', 'info');
    addActivity({ hash: tx.hash, type: 'swap', status: 'pending', ts: Date.now(), detail: `${amt} ${from} → ${to}` });
    const { receipt, timedOut } = await waitForReceipt(tx);
    if (timedOut) {
      // Sent but not confirmed in time. The pending activity entry is left as
      // "pending" (honest) and the button is released — never spin forever.
      toast(`Tx ${String(tx.hash).slice(0, 10)}… sent but still unconfirmed. Track it on the explorer.`, 'info');
      return;
    }
    addActivity({ hash: tx.hash, type: 'swap', status: receipt.status === 1 ? 'success' : 'failed', ts: Date.now(), detail: `${amt} ${from} → ${to}` });
    toast(receipt.status === 1 ? 'Swap confirmed! 🎉' : 'Swap failed!', receipt.status === 1 ? 'success' : 'error');
    emit('refresh');
  });
}

// ═══════════════════════════════════════════════════════════════
// UNISWAP V2 / V3 INTEGRATION
// ═══════════════════════════════════════════════════════════════

// ── Uniswap V2: getAmountsOut quote ──
// Honest guard: the router must have code on this chain, else it is
// skipped (a hardcoded address with no contract must never be used).
export async function uniswapV2Quote(chainId, tokenIn, tokenOut, amountIn) {
  const routerAddr = UNISWAP_V2_ROUTER[chainId];
  if (!routerAddr) throw new Error('Uniswap V2 not available on this chain');
  const provider = get('provider');
  const code = await provider.getCode(routerAddr);
  if (!code || code === '0x') throw new Error('Uniswap V2 router has no code on this chain');
  const router = new ethers.Contract(routerAddr, UNISWAP_V2_ABI, provider);
  const weth = await router.WETH();
  const path = [tokenIn === NATIVE_SENTINEL ? weth : tokenIn,
                 tokenOut === NATIVE_SENTINEL ? weth : tokenOut];
  const amounts = await router.getAmountsOut(amountIn, path);
  return { amounts, router: routerAddr, path };
}

// ── Uniswap V3: exactInputSingle quote (via provider call) ──
// Tries common fee tiers (3000 → 500 → 10000) until one quotes.
export async function uniswapV3Quote(chainId, tokenIn, tokenOut, amountIn, fee = 3000) {
  const quoterAddr = UNISWAP_QUOTER_V3[chainId];
  if (!quoterAddr) throw new Error('Uniswap V3 Quoter not available on this chain');
  const provider = get('provider');
  const code = await provider.getCode(quoterAddr);
  if (!code || code === '0x') throw new Error('Uniswap V3 Quoter has no code on this chain');
  // QuoterV2 ABI (minimal for quoteExactInputSingle)
  const quoterABI = [
    'function quoteExactInputSingle(tuple(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
  ];
  const quoter = new ethers.Contract(quoterAddr, quoterABI, provider);
  const weth = CHAIN_WETH[chainId];
  if (!weth) throw new Error('Uniswap V3: no native token mapping for this chain');
  const fees = [fee, 500, 10000, 100];
  let lastErr;
  for (const f of fees) {
    try {
      const params = {
        tokenIn: tokenIn === NATIVE_SENTINEL ? weth : tokenIn,
        tokenOut: tokenOut === NATIVE_SENTINEL ? weth : tokenOut,
        amountIn,
        fee: f,
        sqrtPriceLimitX96: 0,
      };
      const result = await quoter.quoteExactInputSingle(params);
      return { amountOut: result.amountOut, router: UNISWAP_V3_ROUTER[chainId], fee: f };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Uniswap V3: no pool for any fee tier');
}

// ── Uniswap V2: execute swap ──
export async function uniswapV2Swap(signer, chainId, tokenIn, tokenOut, amountIn, amountOutMin, to, deadline) {
  const routerAddr = UNISWAP_V2_ROUTER[chainId];
  const router = new ethers.Contract(routerAddr, UNISWAP_V2_ABI, signer);
  const weth = await router.WETH();
  const path = [tokenIn === NATIVE_SENTINEL ? weth : tokenIn,
                 tokenOut === NATIVE_SENTINEL ? weth : tokenOut];
  const txDeadline = deadline || Math.floor(Date.now() / 1000) + 60 * 20;
  if (tokenIn === NATIVE_SENTINEL) {
    return router.swapExactETHForTokens(amountOutMin, path, to, txDeadline, { value: amountIn });
  } else if (tokenOut === NATIVE_SENTINEL) {
    return router.swapExactTokensForETH(amountIn, amountOutMin, path, to, txDeadline);
  } else {
    return router.swapExactTokensForTokens(amountIn, amountOutMin, path, to, txDeadline);
  }
}

// ── Uniswap V3: execute swap ──
export async function uniswapV3Swap(signer, chainId, tokenIn, tokenOut, amountIn, amountOutMin, to, fee = 3000) {
  const routerAddr = UNISWAP_V3_ROUTER[chainId];
  const router = new ethers.Contract(routerAddr, UNISWAP_V3_ABI, signer);
  const weth = CHAIN_WETH[chainId];
  if (!weth) throw new Error('Uniswap V3: no native token mapping for this chain');
  const params = {
    tokenIn: tokenIn === NATIVE_SENTINEL ? weth : tokenIn,
    tokenOut: tokenOut === NATIVE_SENTINEL ? weth : tokenOut,
    fee,
    recipient: to,
    amountIn,
    amountOutMinimum: amountOutMin,
    sqrtPriceLimitX96: 0,
  };
  if (tokenIn === NATIVE_SENTINEL) {
    return router.exactInputSingle(params, { value: amountIn });
  }
  return router.exactInputSingle(params);
}

// ── Multi-router quote: KyberSwap → Uniswap V3 → Uniswap V2 ──
// Returns the best REAL quote or throws — never a simulation.
export async function getBestQuote(chainId, tokenIn, tokenOut, amountIn) {
  const slug = KYBER_CHAIN_SLUG[chainId];
  const errors = [];
  // 1. Try KyberSwap
  if (slug) {
    try {
      const kyber = await kyberQuote(slug, tokenIn, tokenOut, amountIn);
      return { source: 'KyberSwap', data: kyber, simulated: false };
    } catch (e) { errors.push(`KyberSwap: ${e.message}`); }
  } else {
    errors.push('KyberSwap: chain not supported');
  }
  // 2. Try Uniswap V3
  try {
    const v3 = await uniswapV3Quote(chainId, tokenIn, tokenOut, amountIn);
    return { source: 'Uniswap V3', data: v3, simulated: false };
  } catch (e) { errors.push(`Uniswap V3: ${e.message}`); }
  // 3. Try Uniswap V2
  try {
    const v2 = await uniswapV2Quote(chainId, tokenIn, tokenOut, amountIn);
    const outAmount = v2.amounts[v2.amounts.length - 1];
    return { source: 'Uniswap V2', data: { ...v2, amountOut: outAmount }, simulated: false };
  } catch (e) { errors.push(`Uniswap V2: ${e.message}`); }
  // 4. No real route — honest failure.
  throw new Error(`No route available: ${errors.join(' · ')}`);
}

// ── get supported DEXes for a chain (real only) ──
export function getSupportedDEXes(chainId) {
  const dexes = [];
  if (KYBER_CHAIN_SLUG[chainId]) dexes.push('KyberSwap');
  if (UNISWAP_V3_ROUTER[chainId]) dexes.push('Uniswap V3');
  if (UNISWAP_V2_ROUTER[chainId]) dexes.push('Uniswap V2');
  return dexes;
}
