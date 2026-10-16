// Bear Tool — tests/dex-v2-onchain-e2e.mjs
// REAL end-to-end of the DEX V2 contracts (js/dex/bear-source.js) on a
// throwaway anvil chain: factory.launch (token+pool+seed+lock in ONE tx) →
// buy → sell → addLiquidity → lock enforcement → time travel → removeLiquidity
// → full drain (nothing stranded) → re-seed after drain → createPool for an
// existing token → duplicate pool refused → native ETH refused everywhere.
//
// This is the maturity gate for docs/DEX-V2.md's contract layer. The math the
// UI will show (js/dex/pool-math.js) must agree with these contracts to the
// last wei, so every expected number here is computed in JS with the same
// floor rules and compared against the chain's answer.
import { spawn } from 'node:child_process';
import { ethers } from 'ethers';
import { bigSqrt, getAmountOut } from '../js/dex/pool-math.js';

const PORT = 8609;
const ANVIL = ['--port', String(PORT), '--silent', '--chain-id', '11155111'];

function startAnvil() {
  const p = spawn('anvil', ANVIL);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('anvil did not start')), 15000);
    p.on('exit', (c) => { clearTimeout(t); reject(new Error('anvil exited ' + c)); });
    (async () => {
      const url = `http://127.0.0.1:${PORT}`;
      for (let i = 0; i < 60; i++) {
        try {
          // cacheTimeout -1: before/after reads either side of a tx must never
          // come back from a stale cache — that made every delta check lie.
          const pr = new ethers.JsonRpcProvider(url, undefined, { cacheTimeout: -1, staticNetwork: true });
          await pr.getBlockNumber();
          clearTimeout(t); resolve({ p, provider: pr }); return;
        } catch { await new Promise((r) => setTimeout(r, 300)); }
      }
      clearTimeout(t); reject(new Error('anvil never answered'));
    })();
  });
}

const solcJs = await import('../js/solc.js');
const { BEAR_SOURCE, BEAR_FACTORY_ABI, BEAR_PAIR_ABI, BEAR_TOKEN_ABI } = await import('../js/dex/bear-source.js');
const solc = (await import('solc')).default;

// Same standard-JSON input the app sends (js/solc.js builds it); the npm solc
// compiles it here so the test proves the shipped source, not a copy.
function compileBear() {
  const input = solcJs.buildStandardJsonInput(BEAR_SOURCE, 'BearFactory');
  const o = JSON.parse(solc.compile(JSON.stringify(input)));
  const errs = (o.errors || []).filter((e) => e.severity === 'error');
  if (errs.length) throw new Error('solc: ' + errs.map((e) => e.formattedMessage).join('\n'));
  const all = o.contracts['BearFactory.sol'];
  const art = (n) => ({ abi: all[n].abi, bytecode: '0x' + all[n].evm.bytecode.object });
  return { token: art('BearToken'), pair: art('BearPair'), factory: art('BearFactory') };
}

// The expected numbers come from the SAME module the swap panel will use
// (js/dex/pool-math.js, imported at the top) instead of a copy that could
// drift: if the panel's math ever stops matching the chain, this goes red.

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`  ok  ${name}`);
  else { failures++; console.log(`  FAIL ${name} ${extra}`); }
}

/** Expect a rejected tx; returns the decoded revert text for the needle test.
 * Do NOT pass an explicit gasLimit to these calls: an explicit limit makes
 * ethers send instead of estimating, and the node's send-time rejection
 * carries no revert reason — the needle test would lose its teeth. */
async function refusal(fn) {
  try { const tx = await fn(); if (tx && tx.wait) await tx.wait(); return { rejected: false, text: '' }; }
  catch (e) {
    const parts = [e?.shortMessage, e?.message, e?.revert ? JSON.stringify(e.revert) : '', e?.info?.error?.message].filter(Boolean);
    return { rejected: true, text: parts.join(' | ') };
  }
}

const V = 10n ** 18n;
const SUPPLY = 1_000_000n * V;
const TOKENS_FOR_POOL = 800_000n * V;
const QUOTE_FOR_POOL = 100n * V;
const LOCK_30D = 30n * 86400n;

const { p, provider } = await startAnvil();
try {
  console.log('DEX V2 end-to-end on anvil (Sepolia chain-id 11155111)');
  const bear = compileBear();
  const [creator, trader, outsider] = await Promise.all([0, 1, 2].map((i) => provider.getSigner(i)));
  const creatorAddr = await creator.getAddress();
  const traderAddr = await trader.getAddress();
  const outsiderAddr = await outsider.getAddress();

  // --- the app seams: the same compiler injection, ethers global and state
  // map the browser fills. Installed once — deployFactory below and the
  // discovery reads at the end both run through them.
  const ls = new Map();
  globalThis.localStorage = {
    getItem: (k) => (ls.has(k) ? ls.get(k) : null),
    setItem: (k, v) => ls.set(k, String(v)),
    removeItem: (k) => ls.delete(k),
  };
  globalThis.ethers = ethers;
  const state = await import('../js/state.js');
  const factoryJs = await import('../js/dex/factory.js');
  solcJs.injectCompiler({ compile: (json) => solc.compile(json) });
  state.set('networkId', 'sepolia');
  state.set('network', { id: 'sepolia', chainId: 11155111 });
  state.set('provider', provider);

  // --- quote coin: a BearToken deployed directly (proves the token artifact) ---
  const quote = await new ethers.ContractFactory(bear.token.abi, bear.token.bytecode, creator)
    .deploy('Test Quote', 'TQ', '', 'quote for v2 e2e', 1_000_000n * V, { gasLimit: 2_000_000 });
  await quote.deploymentTransaction().wait();
  const quoteAddr = await quote.getAddress();
  await (await quote.transfer(traderAddr, 200n * V)).wait();

  // --- factory: deployed through the APP's own path (js/dex/factory.js) ---
  // compile → tx → remember, with a signer handed in through the same state
  // the wallet fills. What the user's tap will run is what runs here.
  // The state signer is a Wallet in the app (wallet.js builds them from the
  // keystore); anvil's default mnemonic key #0 belongs to creator — same
  // account, and a Wallet `connect()` works where a JsonRpcSigner refuses.
  state.set('signer', new ethers.Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', provider));
  state.set('unlocked', true);
  const factoryAddr = await factoryJs.deployFactory();
  check('deployFactory deploys through the app path', /^0x[0-9a-fA-F]{40}$/.test(String(factoryAddr || '')),
    `got=${factoryAddr}`);
  check('deployFactory remembers the factory', factoryJs.factoryAddress() === String(factoryAddr).toLowerCase());
  check('the remembered factory has code on chain', (await provider.getCode(factoryAddr)) !== '0x');
  const factory = new ethers.Contract(factoryAddr, bear.factory.abi, creator);
  const fIface = new ethers.Interface(bear.factory.abi);

  // --- launch: token + pool + seed + 30-day LP lock in ONE tx ---
  const meta = ['Bear Moon', 'BMOON', 'data:image/svg+xml;utf8,<svg></svg>', 'v2 test coin'];
  await (await quote.approve(factoryAddr, QUOTE_FOR_POOL)).wait();
  const launchTx = await factory.launch(meta, SUPPLY, quoteAddr, TOKENS_FOR_POOL, QUOTE_FOR_POOL, LOCK_30D, { gasLimit: 9_000_000 });
  const launchRc = await launchTx.wait();
  check('launch tx succeeds', launchRc.status === 1);

  const launchedLog = launchRc.logs.map((l) => { try { return fIface.parseLog(l); } catch { return null; } }).find((l) => l && l.name === 'Launched');
  check('Launched event emitted', Boolean(launchedLog));
  const tokenAddr = launchedLog.args.token;
  const poolAddr = launchedLog.args.pair;
  check('Launched carries creator, quote', launchedLog.args.creator === creatorAddr && launchedLog.args.quote === quoteAddr);

  const token = new ethers.Contract(tokenAddr, bear.token.abi, creator);
  const pool = new ethers.Contract(poolAddr, bear.pair.abi, creator);
  check('token metadata round-trips', await token.name() === 'Bear Moon' && await token.symbol() === 'BMOON'
    && await token.image() === meta[2] && await token.description() === meta[3]);
  check('token supply fixed', await token.totalSupply() === SUPPLY);
  check('creator keeps the leftover supply', await token.balanceOf(creatorAddr) === SUPPLY - TOKENS_FOR_POOL);
  check('pool holds the seed token side', await token.balanceOf(poolAddr) === TOKENS_FOR_POOL);
  check('pool holds the seed quote side', await quote.balanceOf(poolAddr) === QUOTE_FOR_POOL);
  check('factory registry points at the pool', await factory.pairFor(tokenAddr) === poolAddr);
  check('pool wires token/quote/factory', await pool.token() === tokenAddr && await pool.quote() === quoteAddr && await pool.factory() === factoryAddr);

  const expectedShares = bigSqrt(QUOTE_FOR_POOL * TOKENS_FOR_POOL);
  check('initial LP shares = sqrt(quote*token)', await pool.totalSupply() === expectedShares, `chain=${await pool.totalSupply()} want=${expectedShares}`);
  check('all initial LP shares go to the creator', await pool.balanceOf(creatorAddr) === expectedShares);

  const launchBlock = await provider.getBlock(launchRc.blockNumber);
  check('LP locked for exactly lockDuration', await pool.lockedUntil(creatorAddr) === BigInt(launchBlock.timestamp) + LOCK_30D);

  // --- buy: quote -> token, output must equal the JS mirror to the wei ---
  await (await quote.connect(trader).approve(poolAddr, 50n * V)).wait();
  const [q0, t0] = await pool.reserves();
  const buyIn = 10n * V;
  const wantBuy = getAmountOut(buyIn, q0, t0);
  const beforeBuy = await token.balanceOf(traderAddr);
  await (await pool.connect(trader).swapQuoteForToken(buyIn, wantBuy, { gasLimit: 300_000 })).wait();
  const gotBuy = (await token.balanceOf(traderAddr)) - beforeBuy;
  check('buy output = offchain mirror (floor)', gotBuy === wantBuy, `chain=${gotBuy} want=${wantBuy}`);
  const [q1, t1] = await pool.reserves();
  check('reserves move on buy', q1 === q0 + buyIn && t1 === t0 - wantBuy);
  check('k grows on buy (fee stays in pool)', q1 * t1 > q0 * t0);

  // slippage guard: same trade with minOut one wei above the true quote reverts
  await (await quote.connect(trader).approve(poolAddr, 1n * V)).wait();
  const slip = await refusal(() => pool.connect(trader).swapQuoteForToken(1n * V, t1));
  check('minOut one wei too high is refused', slip.rejected && /slippage/.test(slip.text), slip.text.slice(0, 120));

  // --- sell: token -> quote ---
  const sellIn = gotBuy / 4n;
  const wantSell = getAmountOut(sellIn, t1, q1);
  const beforeSell = await quote.balanceOf(traderAddr);
  await (await token.connect(trader).approve(poolAddr, sellIn)).wait();
  await (await pool.connect(trader).swapTokenForQuote(sellIn, wantSell, { gasLimit: 300_000 })).wait();
  const gotSell = (await quote.balanceOf(traderAddr)) - beforeSell;
  check('sell output = offchain mirror (floor)', gotSell === wantSell, `chain=${gotSell} want=${wantSell}`);
  const [q2, t2] = await pool.reserves();
  check('reserves move on sell', q2 === q1 - wantSell && t2 === t1 + sellIn);

  // --- addLiquidity: proportional shares, floor to the smaller side ---
  const addQuote = 5n * V;
  const addToken = 50_000n * V;
  const wantShares = ((addQuote * (await pool.totalSupply())) / q2) < ((addToken * (await pool.totalSupply())) / t2)
    ? (addQuote * (await pool.totalSupply())) / q2
    : (addToken * (await pool.totalSupply())) / t2;
  await (await quote.connect(trader).approve(poolAddr, addQuote)).wait();
  await (await token.connect(trader).approve(poolAddr, addToken)).wait();
  const sharesBefore = await pool.balanceOf(traderAddr);
  await (await pool.connect(trader).addLiquidity(addQuote, addToken, wantShares, { gasLimit: 400_000 })).wait();
  const sharesGot = (await pool.balanceOf(traderAddr)) - sharesBefore;
  check('addLiquidity shares = offchain mirror', sharesGot === wantShares, `chain=${sharesGot} want=${wantShares}`);

  // --- lock enforcement: creator cannot move or burn LP before the date ---
  const move = await refusal(() => pool.transfer(traderAddr, 1n));
  check('locked LP transfer refused', move.rejected && /locked/.test(move.text), move.text.slice(0, 120));
  const burn = await refusal(() => pool.removeLiquidity(1n, 0n, 0n));
  check('locked LP burn refused', burn.rejected && /locked/.test(burn.text), burn.text.slice(0, 120));

  // --- time travel past the lock: shares move again ---
  await provider.send('evm_increaseTime', [Number(LOCK_30D) + 60]);
  await provider.send('evm_mine', []);
  await (await pool.transfer(traderAddr, 1n)).wait();
  check('LP moves after the lock expires', await pool.balanceOf(traderAddr) === sharesBefore + sharesGot + 1n);

  // --- removeLiquidity: trader exits fully, numbers must match the mirror ---
  const [q3, t3] = await pool.reserves();
  const ts3 = await pool.totalSupply();
  const traderShares = await pool.balanceOf(traderAddr);
  const wantQuoteOut = traderShares * q3 / ts3;
  const wantTokenOut = traderShares * t3 / ts3;
  const qBefore = await quote.balanceOf(traderAddr);
  const tBefore = await token.balanceOf(traderAddr);
  await (await pool.connect(trader).removeLiquidity(traderShares, wantQuoteOut, wantTokenOut, { gasLimit: 400_000 })).wait();
  check('removeLiquidity returns the mirror amounts',
    (await quote.balanceOf(traderAddr)) - qBefore === wantQuoteOut
    && (await token.balanceOf(traderAddr)) - tBefore === wantTokenOut);

  // --- creator drains the rest: pool must empty exactly, nothing stranded ---
  const creatorShares = await pool.balanceOf(creatorAddr);
  await (await pool.connect(creator).removeLiquidity(creatorShares, 0n, 0n, { gasLimit: 400_000 })).wait();
  const [qEnd, tEnd] = await pool.reserves();
  check('full drain empties the pool to the wei', qEnd === 0n && tEnd === 0n, `q=${qEnd} t=${tEnd}`);
  check('LP supply is zero after the drain', await pool.totalSupply() === 0n);

  // --- a drained pool can be seeded again (never bricked) ---
  const reseedQuote = 2n * V;
  const reseedToken = 4_000n * V;
  await (await quote.approve(poolAddr, reseedQuote)).wait();
  await (await token.approve(poolAddr, reseedToken)).wait();
  await (await pool.addLiquidity(reseedQuote, reseedToken, 1n, { gasLimit: 400_000 })).wait();
  check('re-seed after drain works (sqrt again)', await pool.totalSupply() === bigSqrt(reseedQuote * reseedToken));

  // --- createPool for an EXISTING token; duplicate refused ---
  const ext = await new ethers.ContractFactory(bear.token.abi, bear.token.bytecode, creator)
    .deploy('Extra Token', 'EXT', '', '', 500_000n * V, { gasLimit: 2_000_000 });
  await ext.deploymentTransaction().wait();
  const extAddr = await ext.getAddress();
  await (await ext.approve(factoryAddr, 100_000n * V)).wait();
  await (await quote.approve(factoryAddr, 10n * V)).wait();
  const poolTx = await factory.createPool(extAddr, quoteAddr, 100_000n * V, 10n * V, { gasLimit: 6_000_000 });
  const poolRc = await poolTx.wait();
  const poolLog = poolRc.logs.map((l) => { try { return fIface.parseLog(l); } catch { return null; } }).find((l) => l && l.name === 'PoolCreated');
  check('createPool emits PoolCreated', Boolean(poolLog));
  const extPoolAddr = poolLog.args.pair;
  const extPool = new ethers.Contract(extPoolAddr, bear.pair.abi, creator);
  check('existing-token pool seeded', await extPool.totalSupply() === bigSqrt(10n * V * 100_000n * V));
  check('registry holds the second pool too', await factory.pairFor(extAddr) === extPoolAddr);
  const dup = await refusal(() => factory.createPool(extAddr, quoteAddr, 1n, 1n));
  check('second pool for the same token refused', dup.rejected && /exists/.test(dup.text), dup.text.slice(0, 120));

  // --- guards: only the factory seeds; native ETH is refused everywhere ---
  const fakeInit = await refusal(() => extPool.connect(outsider).mintInitial(outsiderAddr, 0n));
  check('mintInitial is factory-only', fakeInit.rejected && /factory/.test(fakeInit.text), fakeInit.text.slice(0, 120));
  const ethToPool = await refusal(() => outsider.sendTransaction({ to: poolAddr, value: 1n }));
  check('native ETH to the pool refused', ethToPool.rejected && /gas only/.test(ethToPool.text), ethToPool.text.slice(0, 120));
  const ethToFactory = await refusal(() => outsider.sendTransaction({ to: factoryAddr, value: 1n }));
  check('native ETH to the factory refused', ethToFactory.rejected && /gas only/.test(ethToFactory.text), ethToFactory.text.slice(0, 120));
  const ethToToken = await refusal(() => outsider.sendTransaction({ to: tokenAddr, value: 1n }));
  check('native ETH to a token refused', ethToToken.rejected && /gas only/.test(ethToToken.text), ethToToken.text.slice(0, 120));

  // --- discovery reads both births back from the factory's own logs ---
  // (the localStorage stub and the state bootstrap above serve this section
  // too — pools.js reads the provider through the same state map)
  const poolsJs = await import('../js/dex/pools.js');
  poolsJs.setFactoryAddress(factoryAddr);

  const found = await poolsJs.discoverPools({});
  check('discovery finds both pools from the factory logs', found.ok && found.pools.length === 2,
    `ok=${found.ok} n=${found.pools.length} reason=${found.reason || ''}`);
  const low = (a) => String(a).toLowerCase();
  const rowA = (found.pools || []).find((r) => low(r.address) === low(tokenAddr));
  const rowE = (found.pools || []).find((r) => low(r.address) === low(extAddr));
  check('a discovery row carries pair, quote and creator', Boolean(rowA)
    && low(rowA.pair) === low(poolAddr) && low(rowA.quote) === low(quoteAddr) && low(rowA.creator) === low(creatorAddr));
  check('the second pool appears too (PoolCreated path)', Boolean(rowE) && low(rowE.pair) === low(extPoolAddr));

  // Scope 'mine': the creator's own launches only — the second pool was
  // created by the same wallet here, so both must match; an outsider gets none.
  const mine = await poolsJs.discoverPools({ scope: 'mine', creator: creatorAddr });
  const theirs = await poolsJs.discoverPools({ scope: 'mine', creator: outsiderAddr });
  check('scope mine filters on the indexed creator topic', mine.ok && mine.pools.length === 2 && theirs.ok && theirs.pools.length === 0,
    `mine=${(mine.pools || []).length} theirs=${(theirs.pools || []).length}`);

  const filled = await poolsJs.fillMeta(found.pools);
  const filledA = (filled || []).find((r) => low(r.address) === low(tokenAddr));
  const filledE = (filled || []).find((r) => low(r.address) === low(extAddr));
  check('fillMeta reads name/symbol from the real token contracts',
    filledA?.name === 'Bear Moon' && filledA?.symbol === 'BMOON'
    && filledE?.name === 'Extra Token' && filledE?.symbol === 'EXT',
    `A="${filledA?.name}/${filledA?.symbol}" E="${filledE?.name}/${filledE?.symbol}"`);

  // --- the surfaces' shared read layer (js/dex/pool-data.js) ---
  const poolData = await import('../js/dex/pool-data.js');
  const ps = await poolData.poolState(poolAddr);
  check('poolState reads the live reserves, quote first', ps.ok
    && low(ps.quote) === low(quoteAddr) && low(ps.token) === low(tokenAddr)
    && ps.quoteReserve > 0n && ps.tokenReserve > 0n,
    `ok=${ps.ok} reason=${ps.reason || ''}`);
  const dr = await pool.reserves();
  check('poolState reserves equal the contract\'s own read',
    ps.ok && ps.quoteReserve === BigInt(dr[0]) && ps.tokenReserve === BigInt(dr[1])
    && ps.supply === BigInt(await pool.totalSupply()));

  const ti = await poolData.tokenInfo(tokenAddr, creatorAddr);
  check('tokenInfo reads name/symbol/decimals/balance from the real token',
    ti.ok && ti.name === 'Bear Moon' && ti.symbol === 'BMOON' && ti.decimals === 18
    && ti.balance === BigInt(await token.balanceOf(creatorAddr)),
    `ok=${ti.ok} name=${ti.name}`);

  const pos = await poolData.lpPosition(poolAddr, creatorAddr);
  const sharesDirect = BigInt(await pool.balanceOf(creatorAddr));
  const totalDirect = BigInt(await pool.totalSupply());
  const lockDirect = BigInt(await pool.lockedUntil(creatorAddr));
  check('lpPosition mirrors the pair itself (shares, lock, floored value)', pos.ok
    && pos.shares === sharesDirect && pos.lockedUntil === lockDirect
    && pos.quoteShare === (sharesDirect * BigInt(dr[0])) / totalDirect
    && pos.tokenShare === (sharesDirect * BigInt(dr[1])) / totalDirect,
    `ok=${pos.ok} reason=${pos.reason || ''}`);

  const al = await poolData.allowanceOf(quoteAddr, traderAddr, poolAddr);
  check('allowanceOf mirrors the quote token\'s allowance',
    al.ok && al.allowance === BigInt(await quote.allowance(traderAddr, poolAddr)));

  const psBad = await poolData.poolState('0x0000000000000000000000000000000000000000');
  check('a pool that is not there refuses instead of showing zeros',
    psBad.ok === false && Boolean(psBad.reason), `ok=${psBad.ok}`);

  // --- the app's swap path (js/dex/swap.js) on the live pool ---
  // Deterministic: zero the trader's allowance first, so "approve exactly the
  // trade" is tested from a known chain state, not from leftovers of the M1
  // checks above. The state signer is a Wallet — the shape the app fills.
  const swapJs = await import('../js/dex/swap.js');
  const traderWallet = new ethers.Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', provider);
  await (await quote.connect(trader).approve(poolAddr, 0)).wait();

  const buyAmt = 5n * V;
  const appr = await swapJs.ensureAllowanceTx({ token: quoteAddr, spender: poolAddr, amount: buyAmt, owner: traderAddr, signer: traderWallet });
  check('ensureAllowanceTx approves exactly the amount when the chain says there is none',
    appr.ok && appr.approved === true, JSON.stringify(appr));
  const again = await swapJs.ensureAllowanceTx({ token: quoteAddr, spender: poolAddr, amount: buyAmt, owner: traderAddr, signer: traderWallet });
  const allowNow = await quote.allowance(traderAddr, poolAddr);
  check('and does NOT approve again when the allowance is already there (asked, not assumed)',
    again.ok && again.approved === false && BigInt(allowNow) === buyAmt, `approved=${again.approved} allow=${allowNow}`);

  const rBefore = await pool.reserves();
  const qBuy = swapJs.swapQuote({ quoteReserve: BigInt(rBefore[0]), tokenReserve: BigInt(rBefore[1]), direction: 'buy', amountIn: buyAmt });
  check('the engine quotes the live pool', qBuy.ok === true, `reason=${qBuy.reason || ''}`);
  const tokBefore = await token.balanceOf(traderAddr);
  const rcBuy = await swapJs.swapTx({ pair: poolAddr, direction: 'buy', amountIn: buyAmt, minOut: qBuy.minOut, signer: traderWallet });
  const rAfter = await pool.reserves();
  const tokAfter = await token.balanceOf(traderAddr);
  check('swapTx(buy) moves the reserves by exactly the input, and out by exactly the quote',
    Boolean(rcBuy) && BigInt(rAfter[0]) === BigInt(rBefore[0]) + buyAmt
    && BigInt(rAfter[1]) === BigInt(rBefore[1]) - qBuy.amountOut,
    `reserves ${rBefore} -> ${rAfter}`);
  check('…and the trader holds exactly the quoted output', tokAfter - tokBefore === qBuy.amountOut);

  // Sell half of it straight back — the other direction, same path.
  const sellAmt = qBuy.amountOut / 2n;
  const qSell = swapJs.swapQuote({ quoteReserve: BigInt(rAfter[0]), tokenReserve: BigInt(rAfter[1]), direction: 'sell', amountIn: sellAmt });
  await (await token.connect(trader).approve(poolAddr, 0)).wait();
  const sellAppr = await swapJs.ensureAllowanceTx({ token: tokenAddr, spender: poolAddr, amount: sellAmt, owner: traderAddr, signer: traderWallet });
  const rcSell = await swapJs.swapTx({ pair: poolAddr, direction: 'sell', amountIn: sellAmt, minOut: qSell.minOut, signer: traderWallet });
  const rEnd = await pool.reserves();
  check('swapTx(sell) mirrors it: quote out by the quote, token back by the input',
    sellAppr.ok && Boolean(rcSell)
    && BigInt(rEnd[0]) === BigInt(rAfter[0]) - qSell.amountOut
    && BigInt(rEnd[1]) === BigInt(rAfter[1]) + sellAmt,
    `reserves ${rAfter} -> ${rEnd}`);

  // --- the app's liquidity path (js/dex/lp.js) on the live pool ---
  // Same discipline as the swap path: the previews are pure, and they must
  // equal what the pair actually mints and burns, to the wei. The trader here
  // is a plain wallet with a small token bag, so the deposit is small enough
  // to pass on both sides — the math is scale-free.
  const lpJs = await import('../js/dex/lp.js');
  const lpSup0 = BigInt(await pool.totalSupply());
  const lpAddQ = 2n * 10n ** 16n; // 0.02 quote
  const lpAddT = (lpAddQ * BigInt(rEnd[1])) / BigInt(rEnd[0]); // the exact live ratio
  const lpAddPrev = lpJs.addPreview({ quoteIn: lpAddQ, tokenIn: lpAddT, quoteReserve: BigInt(rEnd[0]), tokenReserve: BigInt(rEnd[1]), supply: lpSup0 });
  check('addPreview predicts mintable shares on live reserves', lpAddPrev.ok === true, `reason=${lpAddPrev.reason || ''}`);
  const lpShares0 = BigInt(await pool.balanceOf(traderAddr));
  const lpRcAdd = await lpJs.addLiquidityTx({ pair: poolAddr, quoteToken: quoteAddr, token: tokenAddr, quoteAmount: lpAddQ, tokenAmount: lpAddT, minShares: lpAddPrev.minShares, signer: traderWallet });
  const lpShares1 = BigInt(await pool.balanceOf(traderAddr));
  const lpR = await pool.reserves();
  check('addLiquidityTx mints exactly the preview (shares, both reserves, supply)',
    Boolean(lpRcAdd)
    && lpShares1 - lpShares0 === lpAddPrev.shares
    && BigInt(lpR[0]) === BigInt(rEnd[0]) + lpAddQ
    && BigInt(lpR[1]) === BigInt(rEnd[1]) + lpAddT
    && BigInt(await pool.totalSupply()) === lpSup0 + lpAddPrev.shares,
    `shares +${lpShares1 - lpShares0} vs preview ${lpAddPrev.shares}`);

  const lpRemSh = (lpShares1 - lpShares0) / 2n;
  const lpSup1 = BigInt(await pool.totalSupply());
  const lpRemPrev = lpJs.removePreview({ shares: lpRemSh, quoteReserve: BigInt(lpR[0]), tokenReserve: BigInt(lpR[1]), supply: lpSup1 });
  const lpQb = await quote.balanceOf(traderAddr);
  const lpTb = await token.balanceOf(traderAddr);
  const lpRcRem = await lpJs.removeLiquidityTx({ pair: poolAddr, shares: lpRemSh, minQuote: lpRemPrev.minQuote, minToken: lpRemPrev.minToken, signer: traderWallet });
  const lpR2 = await pool.reserves();
  check('removeLiquidityTx burns exactly the preview (shares, both payouts, supply)',
    Boolean(lpRcRem)
    && (await quote.balanceOf(traderAddr)) - lpQb === lpRemPrev.quoteOut
    && (await token.balanceOf(traderAddr)) - lpTb === lpRemPrev.tokenOut
    && BigInt(lpR2[0]) === BigInt(lpR[0]) - lpRemPrev.quoteOut
    && BigInt(lpR2[1]) === BigInt(lpR[1]) - lpRemPrev.tokenOut
    && BigInt(await pool.totalSupply()) === lpSup1 - lpRemSh,
    `out ${lpRemPrev.quoteOut}/${lpRemPrev.tokenOut}`);

  // Lock: the remaining shares go under a real lock, and the CONTRACT — not
  // the UI — is what refuses the exit while it runs.
  const lpLockRc = await lpJs.lockSharesTx({ pair: poolAddr, durationSecs: 60, signer: traderWallet });
  const lpLockNow = BigInt(await pool.lockedUntil(traderAddr));
  const lpWallNow = BigInt(Math.floor(Date.now() / 1000));
  check('lockSharesTx sets lockedUntil into the future', Boolean(lpLockRc) && lpLockNow >= lpWallNow + 55n, `lock=${lpLockNow} now=${lpWallNow}`);
  const lockedMove = await refusal(() => pool.connect(trader).transfer(outsiderAddr, 1n));
  check('a locked LP cannot move shares until the lock expires', lockedMove.rejected && /locked/.test(lockedMove.text), lockedMove.text.slice(0, 120));
  const lockedExit = await refusal(() => pool.connect(trader).removeLiquidity(1n, 0n, 0n));
  check('and cannot pull liquidity out either', lockedExit.rejected && /locked/.test(lockedExit.text), lockedExit.text.slice(0, 120));

  // --- the app's launch path (js/dex/launch.js): ONE call, one tx ---
  // The wizard's whole tx flow lives in launchTx(): approve the quote if the
  // chain says so, then factory.launch, then read the token back out of the
  // Launched event — never assumed. This proves the exact path the button
  // runs, with the wizard's own signer shape (a plain wallet).
  const launchJs = await import('../js/dex/launch.js');
  const creatorWallet = new ethers.Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', provider);
  const creatorWalletAddr = await creatorWallet.getAddress();
  const appLock = 90n * 86400n;
  const appRes = await launchJs.launchTx({
    name: 'App Bear', symbol: 'APB', image: '', description: 'via the app path',
    supply: SUPPLY, quote: quoteAddr, tokensForPool: 600_000n * V, quoteForPool: 3n * V,
    lockDuration: appLock, signer: creatorWallet,
  });
  check('launchTx succeeds and returns the token read from the receipt',
    appRes.ok && /^0x[0-9a-fA-F]{40}$/.test(String(appRes.token)), `ok=${appRes.ok} token=${appRes.token}`);

  const appToken = new ethers.Contract(appRes.token, bear.token.abi, provider);
  const appPoolAddr = await factory.pairFor(appRes.token);
  const appPool = new ethers.Contract(appPoolAddr, bear.pair.abi, provider);
  check('the one call seated the pool exactly as asked',
    BigInt(await quote.balanceOf(appPoolAddr)) === 3n * V
    && BigInt(await appToken.balanceOf(appPoolAddr)) === 600_000n * V,
    `quote=${await quote.balanceOf(appPoolAddr)} token=${await appToken.balanceOf(appPoolAddr)}`);
  check('leftover supply went to the launch signer',
    BigInt(await appToken.balanceOf(creatorWalletAddr)) === SUPPLY - 600_000n * V,
    `kept=${await appToken.balanceOf(creatorWalletAddr)}`);
  check('the creator LP arrived locked for the chosen duration',
    BigInt(await appPool.lockedUntil(creatorWalletAddr)) >= BigInt(Math.floor(Date.now() / 1000)) + appLock - 60n,
    `lock=${await appPool.lockedUntil(creatorWalletAddr)}`);
  check('token metadata round-trips through the app path',
    await appToken.name() === 'App Bear' && await appToken.symbol() === 'APB');
  const discoApp = await (await import('../js/dex/pools.js')).discoverPools({ scope: 'all', limit: 10 });
  check('discovery finds the app-launched pool too',
    discoApp.ok && discoApp.pools.some((x) => x.address.toLowerCase() === appRes.token.toLowerCase()),
    `ok=${discoApp.ok} found=${discoApp.pools.length}`);

  // --- "beli lagi": a second buy is never a dead end ---
  // The user's own words ("…gabisa beli lagi") named a UI freeze, but the
  // chain-level twin deserves its own proof too: the earlier exact approve was
  // fully spent, so buying AGAIN must grant a fresh exact amount and move the
  // pool again — the same two calls the sheet runs under its CTA.
  const uBuy = 4n * V;
  await (await quote.connect(trader).approve(poolAddr, 0)).wait();
  const apprAgain = await swapJs.ensureAllowanceTx({ token: quoteAddr, spender: poolAddr, amount: uBuy, owner: traderAddr, signer: traderWallet });
  const rBuyA = await pool.reserves();
  const qBuyA = swapJs.swapQuote({ quoteReserve: BigInt(rBuyA[0]), tokenReserve: BigInt(rBuyA[1]), direction: 'buy', amountIn: uBuy });
  const tokABefore = await token.balanceOf(traderAddr);
  const rcBuyA = await swapJs.swapTx({ pair: poolAddr, direction: 'buy', amountIn: uBuy, minOut: qBuyA.minOut, signer: traderWallet });
  const rBuyB = await pool.reserves();
  check('buy #2 with a fresh exact approve succeeds and moves the pool',
    apprAgain.ok && apprAgain.approved === true && qBuyA.ok === true && Boolean(rcBuyA)
    && BigInt(rBuyB[0]) === BigInt(rBuyA[0]) + uBuy
    && BigInt(rBuyB[1]) === BigInt(rBuyA[1]) - qBuyA.amountOut,
    `approved=${apprAgain.approved} reserves ${rBuyA} -> ${rBuyB}`);
  check('…and the second buy credited exactly the second quote',
    (await token.balanceOf(traderAddr)) - tokABefore === qBuyA.amountOut);

  // --- M8: the holder scan against a chain it did not write --------------
  // The unit tests drive the scanner over stubs; THIS is the proof over real
  // history: every balance the scan derives from raw Transfer logs must equal
  // the token's own balanceOf to the wei, and the sums must land exactly on
  // supply — the only shape the holder card is allowed to render.
  const holdersJs = await import('../js/dex/holders.js');
  const cacheMem = { _s: new Map(), getItem(k) { return this._s.has(k) ? this._s.get(k) : null; }, setItem(k, v) { this._s.set(k, String(v)); } };
  const scan = await holdersJs.scanHolders({ E: ethers, provider, token: tokenAddr, cache: cacheMem, supply: SUPPLY });
  check('holder scan completes on real history (mint seen, sums on supply)',
    scan.done === true && scan.mintSeen === true,
    `done=${scan.done} mint=${scan.mintSeen} low=${scan.low} reason=${scan.reason || ''}`);
  const balOf = async (a) => BigInt(await token.balanceOf(a));
  const cBal = await balOf(creatorAddr);
  const tBal = await balOf(traderAddr);
  const pBal = await balOf(poolAddr);
  check('scan balances equal balanceOf to the wei (creator, trader, pool)',
    (scan.balances.get(creatorAddr.toLowerCase()) || 0n) === cBal
    && (scan.balances.get(traderAddr.toLowerCase()) || 0n) === tBal
    && (scan.balances.get(poolAddr.toLowerCase()) || 0n) === pBal,
    `scan=${scan.balances.get(creatorAddr.toLowerCase())}/${scan.balances.get(traderAddr.toLowerCase())}/${scan.balances.get(poolAddr.toLowerCase())} chain=${cBal}/${tBal}/${pBal}`);
  check('scan sums land exactly on the token supply',
    holdersJs.sumOf(scan.balances) === BigInt(SUPPLY), `sum=${holdersJs.sumOf(scan.balances)} supply=${SUPPLY}`);
  const scanRows = holdersJs.holderRows(scan.balances, BigInt(SUPPLY), { exclude: [poolAddr], limit: 50 });
  const expectedHeads = (cBal > 0n ? 1 : 0) + (tBal > 0n ? 1 : 0);
  check('holder rows exclude the pool, count the true wallets, lead with the biggest',
    scanRows.count === expectedHeads
    && scanRows.rows.every((r) => r.addr !== poolAddr.toLowerCase())
    && (scanRows.rows.length === 0 || scanRows.rows[0].amount === (cBal > tBal ? cBal : tBal)),
    `count=${scanRows.count} expected=${expectedHeads}`);
  const dayStat = await holdersJs.pool24h({ E: ethers, provider, pair: poolAddr, blocks: 7200 });
  check('24h volume folds the pair\'s own Swap logs (ok, volume and trades real)',
    dayStat.ok === true && dayStat.volQuote > 0n && dayStat.trades > 0,
    `ok=${dayStat.ok} vol=${dayStat.volQuote} trades=${dayStat.trades} reason=${dayStat.reason || ''}`);
} catch (e) {
  failures++;
  console.error('  ERROR', e && (e.shortMessage || e.message) || String(e));
  if (e && e.revert) console.error('  revert=', e.revert);
} finally {
  try { p.kill(); } catch { /* already gone */ }
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall DEX V2 end-to-end checks passed');
process.exit(failures ? 1 : 0);
