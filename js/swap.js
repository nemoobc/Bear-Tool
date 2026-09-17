// ═══════════════════════════════════════════════════════════════
// Bear Tool — swap.js
// Swap & Bridge view: token select, flip, quote (KyberSwap +
// Uniswap V2/V3 Router), slippage wired, approve + execute path.
// Honest simulated fallback when chain unsupported or offline.
// ═══════════════════════════════════════════════════════════════

import { $, toast, confirmTx, escapeHtml, spinnerDots } from './ui.js';
import { get, set, addActivity, requireUnlock, emit } from './state.js';
import { runTx } from './safetx.js';
import { getNetworkById, ERC20_ABI } from './network.js';

const { ethers } = globalThis;

// ── KyberSwap Aggregator constants ──
const KYBER_API = 'https://aggregator-api.kyberswap.com';
const CLIENT_ID = 'bear-tool';
const NATIVE_SENTINEL = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const CACHE_TTL = 30_000;

// ── Uniswap Router V2/V3 constants ──
const UNISWAP_V2_ROUTER = {
  1: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D', // Ethereum
  5: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D', // Goerli
  11155111: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D', // Sepolia
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
const UNISWAP_QUOTER_V3 = {
  1: '0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6',
  11155111: '0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6',
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
    { address: '0xfFf997675846FbDE638e6Be6E0Cee9B40AC2EF02', symbol: 'WETH', decimals: 18 },
    { address: '0x1c7D4B196Cb0C7B01d0686A7A22546cDa02c4e42', symbol: 'USDC', decimals: 6 },
    { address: '0x7169AE3C7586262Ad1AF40B0541bD20043442c3E', symbol: 'USDT', decimals: 6 },
    { address: '0x739ca6D71365a08f584c8FC4e1029045Fa8ABC4B', symbol: 'WETH', decimals: 18 },
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
  // MAX button
  const maxBtn = $('#btnSwapMax');
  if (maxBtn) {
    maxBtn.addEventListener('click', () => {
      const sel = $('#swapFrom');
      const t = get('tokens').find(x => (x.address || 'native') === sel.value);
      if (t) $('#swapFromAmount').value = parseFloat(ethers.formatUnits(t.balance, t.decimals)).toFixed(6);
    });
  }
}

export function loadSwapTokens() {
  const from = $('#swapFrom'), to = $('#swapTo');
  if (!from || !to) return;
  const tokens = get('tokens');
  const opts = tokens.map(t =>
    `<option value="${escapeHtml(t.address || 'native')}">${escapeHtml(t.symbol)}</option>`
  ).join('');
  from.innerHTML = opts;
  to.innerHTML = opts;
  if (from.options.length > 1) to.selectedIndex = 1;
  // update balance displays
  const updateBalance = () => {
    const ft = tokens.find(x => (x.address || 'native') === from.value);
    const tt = tokens.find(x => (x.address || 'native') === to.value);
    const fb = $('#swapFromBalance'), tb = $('#swapToBalance');
    if (fb && ft) fb.textContent = `Balance: ${parseFloat(ethers.formatUnits(ft.balance, ft.decimals)).toFixed(4)}`;
    if (tb && tt) tb.textContent = `Balance: ${parseFloat(ethers.formatUnits(tt.balance, tt.decimals)).toFixed(4)}`;
  };
  from.addEventListener('change', updateBalance);
  to.addEventListener('change', updateBalance);
  updateBalance();
}

export function flipSwap() {
  const from = $('#swapFrom'), to = $('#swapTo');
  const tmp = from.value; from.value = to.value; to.value = tmp;
  $('#swapFromAmount').value = '';
  $('#swapToAmount').value = '';
  $('#swapQuote').classList.add('hidden');
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ── KyberSwap: fetch routes (quote) ──
async function kyberQuote(slug, tokenIn, tokenOut, amountIn) {
  const url = `${KYBER_API}/${slug}/api/v1/routes?tokenIn=${tokenIn}&tokenOut=${tokenOut}&amountIn=${amountIn}`;
  const res = await fetch(url, { headers: { 'x-client-id': CLIENT_ID } });
  if (!res.ok) throw new Error(`KyberSwap quote HTTP ${res.status}`);
  const json = await res.json();
  if (!json.data?.routeSummary) throw new Error('KyberSwap: empty route');
  return json.data; // { routeSummary, routerAddress }
}

// ── KyberSwap: build transaction data ──
async function kyberBuild(slug, routeSummary, sender, recipient, slippageBps) {
  const url = `${KYBER_API}/${slug}/api/v1/route/build`;
  const res = await fetch(url, {
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

// ── simulated fallback (honest, labeled) ──
function simulatedQuote(amt, sellSymbol, buySymbol) {
  const rate = 1 + (Math.random() - 0.5) * 0.02;
  const out = parseFloat(amt) * rate;
  return { simulated: true, rate, out, sellSymbol, buySymbol };
}

// ── get quote (KyberSwap → simulated fallback) ──
export async function getSwapQuote() {
  const amt = $('#swapFromAmount').value;
  if (!amt || parseFloat(amt) <= 0) return;

  const from = $('#swapFrom').value, to = $('#swapTo').value;
  const net = getNetworkById(get('networkId'));
  const slippageBtn = document.querySelector('.slippage-btn.active');
  const slippage = slippageBtn ? slippageBtn.dataset.val : '0.5';
  const quoteBox = $('#swapQuote');
  quoteBox.innerHTML = spinnerDots();
  quoteBox.classList.remove('hidden');

  const sellSymbol = from === 'native' ? net.symbol : (tokenInfo(from)?.symbol ?? '???');
  const buySymbol = to === 'native' ? net.symbol : (tokenInfo(to)?.symbol ?? '???');
  const toDecimals = to === 'native' ? 18 : (tokenInfo(to)?.decimals ?? 18);

  const slug = KYBER_CHAIN_SLUG[net.chainId];
  if (!slug) {
    const sim = simulatedQuote(amt, sellSymbol, buySymbol);
    $('#swapToAmount').value = sim.out.toFixed(6);
    set('swapQuote', sim);
    quoteBox.innerHTML =
      `<div class="simulated-banner">⚠️ SIMULATED — no real swap will happen. Chain not supported by KyberSwap.</div>` +
      `Simulated: 1 ${escapeHtml(sellSymbol)} ≈ ${sim.rate.toFixed(6)} ${escapeHtml(buySymbol)}`;
    return;
  }

  const tokenIn = from === 'native' ? NATIVE_SENTINEL : from;
  const tokenOut = to === 'native' ? NATIVE_SENTINEL : to;
  // amount must respect the SELL token's decimals (ERC-20 ≠ 18)
  const fromDecimals = from === 'native' ? 18 : (tokenInfo(from)?.decimals ?? 18);
  const amountInWei = ethers.parseUnits(amt, fromDecimals).toString();
  const key = cacheKey(slug, tokenIn, tokenOut, amountInWei);
  const now = Date.now();

  try {
    let quoteData;
    if (quoteCache.key === key && now - quoteCache.ts < CACHE_TTL) {
      quoteData = quoteCache.data;
    } else {
      quoteData = await kyberQuote(slug, tokenIn, tokenOut, amountInWei);
      quoteCache = { key, data: quoteData, ts: now };
    }

    const userAddr = get('address');
    const slippageBps = Math.round(parseFloat(slippage) * 100);
    const built = await kyberBuild(slug, quoteData.routeSummary, userAddr, userAddr, slippageBps);

    const outAmount = BigInt(quoteData.routeSummary.amountOut ?? '0');
    const outFormatted = ethers.formatUnits(outAmount, toDecimals);
    const rate = parseFloat(outFormatted) / parseFloat(amt);

    set('swapQuote', { simulated: false, built });

    $('#swapToAmount').value = outFormatted;
    quoteBox.innerHTML =
      `Rate: 1 ${escapeHtml(sellSymbol)} ≈ ${rate.toFixed(6)} ${escapeHtml(buySymbol)}<br>` +
      `Slippage: ${escapeHtml(slippage)}%`;
  } catch (e) {
    console.warn('[BearTool] KyberSwap quote failed:', e.message);
    const sim = simulatedQuote(amt, sellSymbol, buySymbol);
    $('#swapToAmount').value = sim.out.toFixed(6);
    set('swapQuote', sim);
    quoteBox.innerHTML =
      `<div class="simulated-banner">⚠️ SIMULATED — no real swap will happen. ${escapeHtml(e.message)}</div>` +
      `Simulated: 1 ${escapeHtml(sellSymbol)} ≈ ${sim.rate.toFixed(6)} ${escapeHtml(buySymbol)}`;
  }
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
      rows: [{ k: 'From', v: `${amt} ${from}` }, { k: 'To', v: to }, { k: 'Network', v: net.name }],
      confirmText: 'Swap', danger: true, requireType: 'YA'
    });
    if (!ok) return;
  }

  if (quote.simulated) {
    return toast('⚠️ SIMULATED — no real swap will happen. Chain not supported or API offline.', 'info');
  }

  await runTx('swap', $('#btnSwap'), async () => {
    const provider = get('provider');
    const signer = get('signer').connect(provider);
    const userAddr = get('address');
    const router = quote.built.routerAddress;

    // ERC-20 approve if needed
    if (from !== 'native') {
      const fromDecimals = tokenInfo(from)?.decimals ?? 18;
      const amountWei = ethers.parseUnits(amt, fromDecimals);
      const c = new ethers.Contract(from, ERC20_ABI, signer);
      const allowance = await c.allowance(userAddr, router);
      if (allowance < amountWei) {
        toast('Approving token...', 'info');
        const txApprove = await c.approve(router, ethers.MaxUint256);
        await txApprove.wait();
      }
    }

    // execute swap transaction
    const tx = await signer.sendTransaction({
      to: router,
      data: quote.built.data,
      value: from === 'native' ? ethers.parseEther(amt) : 0n,
    });
    toast('Swap tx sent! ⏳', 'info');
    addActivity({ hash: tx.hash, type: 'swap', status: 'pending', ts: Date.now(), detail: `${amt} ${from} → ${to}` });
    const receipt = await tx.wait();
    addActivity({ hash: tx.hash, type: 'swap', status: receipt.status === 1 ? 'success' : 'failed', ts: Date.now(), detail: `${amt} ${from} → ${to}` });
    toast(receipt.status === 1 ? 'Swap confirmed! 🎉' : 'Swap failed!', receipt.status === 1 ? 'success' : 'error');
    emit('refresh');
  });
}

// ═══════════════════════════════════════════════════════════════
// UNISWAP V2 / V3 INTEGRATION
// ═══════════════════════════════════════════════════════════════

// ── Uniswap V2: getAmountsOut quote ──
export async function uniswapV2Quote(chainId, tokenIn, tokenOut, amountIn) {
  const routerAddr = UNISWAP_V2_ROUTER[chainId];
  if (!routerAddr) throw new Error('Uniswap V2 not available on this chain');
  const provider = get('provider');
  const router = new ethers.Contract(routerAddr, UNISWAP_V2_ABI, provider);
  const path = [tokenIn === NATIVE_SENTINEL ? await router.WETH() : tokenIn,
                 tokenOut === NATIVE_SENTINEL ? await router.WETH() : tokenOut];
  const amounts = await router.getAmountsOut(amountIn, path);
  return { amounts, router: routerAddr, path };
}

// ── Uniswap V3: exactInputSingle quote (via provider call) ──
export async function uniswapV3Quote(chainId, tokenIn, tokenOut, amountIn, fee = 3000) {
  const quoterAddr = UNISWAP_QUOTER_V3[chainId];
  if (!quoterAddr) throw new Error('Uniswap V3 Quoter not available on this chain');
  const provider = get('provider');
  // QuoterV2 ABI (minimal for quoteExactInputSingle)
  const quoterABI = [
    'function quoteExactInputSingle(tuple(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
  ];
  const quoter = new ethers.Contract(quoterAddr, quoterABI, provider);
  const params = {
    tokenIn: tokenIn === NATIVE_SENTINEL ? '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' : tokenIn,
    tokenOut: tokenOut === NATIVE_SENTINEL ? '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' : tokenOut,
    amountIn,
    fee,
    sqrtPriceLimitX96: 0,
  };
  const result = await quoter.quoteExactInputSingle(params);
  return { amountOut: result.amountOut, router: UNISWAP_V3_ROUTER[chainId] };
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
  const params = {
    tokenIn: tokenIn === NATIVE_SENTINEL ? '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' : tokenIn,
    tokenOut: tokenOut === NATIVE_SENTINEL ? '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' : tokenOut,
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

// ── Multi-router quote: try KyberSwap → Uniswap V3 → Uniswap V2 → simulated ──
export async function getBestQuote(chainId, tokenIn, tokenOut, amountIn) {
  const slug = KYBER_CHAIN_SLUG[chainId];
  // 1. Try KyberSwap
  if (slug) {
    try {
      const kyber = await kyberQuote(slug, tokenIn, tokenOut, amountIn);
      return { source: 'KyberSwap', data: kyber, simulated: false };
    } catch {}
  }
  // 2. Try Uniswap V3
  try {
    const v3 = await uniswapV3Quote(chainId, tokenIn, tokenOut, amountIn);
    return { source: 'Uniswap V3', data: v3, simulated: false };
  } catch {}
  // 3. Try Uniswap V2
  try {
    const v2 = await uniswapV2Quote(chainId, tokenIn, tokenOut, amountIn);
    const outAmount = v2.amounts[v2.amounts.length - 1];
    return { source: 'Uniswap V2', data: { ...v2, amountOut: outAmount }, simulated: false };
  } catch {}
  // 4. Simulated fallback
  return { source: 'Simulated', data: null, simulated: true };
}

// ── get supported DEXes for a chain ──
export function getSupportedDEXes(chainId) {
  const dexes = [];
  if (KYBER_CHAIN_SLUG[chainId]) dexes.push('KyberSwap');
  if (UNISWAP_V3_ROUTER[chainId]) dexes.push('Uniswap V3');
  if (UNISWAP_V2_ROUTER[chainId]) dexes.push('Uniswap V2');
  return dexes.length ? dexes : ['Simulated'];
}
