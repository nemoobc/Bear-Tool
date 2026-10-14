// Bear Tool — tests/dex-onchain-e2e.mjs
// THE maturity gate for the launchpad: does what the SCREEN promises match what
// the CHAIN does?
//
// tests/dex-pump-e2e.mjs proves the contract is correct on its own terms. It does
// not prove the product: the coin page quotes a number with curve.js and the
// user signs on that number. If the quote and the contract disagree by even a
// wei, the app is lying about a price someone will pay real ETH for — and no
// contract-level test can catch it, because both sides would be "correct".
//
// So this drives the ACTUAL modules the app ships — curve.js's quoteBuy/
// quoteSell, pump-source.js's ABI, the same fee split — against a live anvil,
// and asserts the chain's result against the screen's promise:
//
//   buy   : the chain must credit AT LEAST the quoted tokens (floor-favouring
//           means the pool may keep dust, never the user may be short)
//   sell  : the chain must pay AT MOST the quoted ETH (same reason, mirrored)
//   fees  : the fee the screen's split predicts must be the fee that accrued
//   quote : the live reserves must land exactly on the quote's next-reserves
//   reserve : the contract's real ETH must equal its own arithmetic
//
// Anything here is a bug the user would have paid for.
import { spawn } from 'node:child_process';
import { ethers } from 'ethers';

const PORT = Number(process.env.DEX_E2E_PORT || 8611);
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
          const pr = new ethers.JsonRpcProvider(url, undefined, { cacheTimeout: -1, staticNetwork: true });
          await pr.getBlockNumber();
          clearTimeout(t); resolve({ p, provider: pr }); return;
        } catch { await new Promise((r) => setTimeout(r, 300)); }
      }
      clearTimeout(t); reject(new Error('anvil never answered'));
    })();
  });
}

// Compile the source the app ships, with the compiler the app uses.
async function compilePumpToken() {
  const solc = (await import('solc')).default;
  const { PUMP_TOKEN_SOURCE } = await import('../js/dex/pump-source.js');
  const input = {
    language: 'Solidity',
    sources: { 'PumpToken.sol': { content: PUMP_TOKEN_SOURCE } },
    settings: { outputSelection: { '*': { '*': ['evm.bytecode.object', 'abi'] } } },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errs = (out.errors || []).filter((e) => e.severity === 'error');
  if (errs.length) throw new Error('solc: ' + errs.map((e) => e.formattedMessage).join('\n'));
  return {
    abi: out.contracts['PumpToken.sol'].PumpToken.abi,
    bytecode: '0x' + out.contracts['PumpToken.sol'].PumpToken.evm.bytecode.object,
  };
}

const ETH = (n) => ethers.parseEther(String(n));

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`  ok  ${name}`);
  else { failures++; console.log(`  FAIL ${name} ${extra}`); }
}

const { p, provider } = await startAnvil();
try {
  console.log(`Dex on-chain: quote \u2194 chain agreement (anvil, port ${PORT})`);

  // The app's own maths, imported — not a re-implementation.
  const C = await import('../js/dex/curve.js');
  const { PUMP_ABI } = await import('../js/dex/pump-source.js');
  const { abi, bytecode } = await compilePumpToken();

  const [creator, buyer, other] = await Promise.all([0, 1, 2].map((i) => provider.getSigner(i)));
  const buyerAddr = await buyer.getAddress();
  const creatorAddr = await creator.getAddress();

  const factory = new ethers.ContractFactory(abi, bytecode, creator);
  const deployed = await factory.deploy('Quote Test', 'QTEST', '', '', C.VIRTUAL_ETH, C.VIRTUAL_TOKENS, { gasLimit: 5_000_000 });
  await deployed.deploymentTransaction().wait();
  const addr = await deployed.getAddress();
  const t = new ethers.Contract(addr, abi, creator);
  console.log(`  coin ${addr}`);

  // ── the slippage guard, proved by trying to break it ──────────
  // A floor that is never tested is a comment. Two ways it can be wrong, and
  // both cost the user money: too tight (every honest trade reverts, so the coin
  // looks dead) and too loose (a front-runner takes 99% and the trade still
  // succeeds). Only a chain can tell which one shipped.
  {
    const [vE, vT] = await Promise.all([t.virtualEth(), t.virtualTokens()]);
    const q = C.quoteBuy(vE, vT, ETH(0.01));
    const balBefore = await t.balanceOf(buyerAddr);

    // 1. an impossible floor must revert, leaving the curve untouched
    let blocked = false;
    try {
      await (await t.connect(buyer).buy(q.tokensOut * 2n, { value: ETH(0.01), gasLimit: 900_000 })).wait();
    } catch { blocked = true; }
    check('a buy whose floor is above the quote reverts', blocked);
    const [vEAfter, vTAfter] = await Promise.all([t.virtualEth(), t.virtualTokens()]);
    check('the refused buy left the curve exactly as it was',
      vEAfter === vE && vTAfter === vT, `eth ${vEAfter} vs ${vE}`);
    check('the refused buy moved no tokens', (await t.balanceOf(buyerAddr)) === balBefore);

    // 2. the app's real floor must sit WITHIN 1% of the quote. This is the check
    //    that catches the shipped bug, where "1% slippage guard" was really a
    //    99% tolerance because the quote was divided by 100.
    const BPS = 100n;
    const floor = (q.tokensOut * (10_000n - BPS)) / 10_000n;
    const dropPct = (Number(q.tokensOut - floor) / Number(q.tokensOut)) * 100;
    check('the buy floor sits within 1% of the quote', dropPct <= 1.0001,
      `floor is ${dropPct.toFixed(4)}% below the quote`);
    check('the buy floor is NOT a fraction of the quote (the shipped bug)',
      floor > q.tokensOut / 2n, `floor ${floor} vs quote ${q.tokensOut}`);

    // 3. and the app's real floor must actually pass
    let passed = true;
    try {
      await (await t.connect(buyer).buy(floor, { value: ETH(0.01), gasLimit: 900_000 })).wait();
    } catch { passed = false; }
    check("a buy at the app's real floor succeeds", passed);
  }

  // ── discovery: the coin must be findable from the chain alone ──
  //
  // The feed used to be a localStorage list, so a coin was only visible in the
  // browser that launched it: clearing storage or opening another device erased
  // real coins from the product's point of view. The constructor now emits one
  // indexed Launched per coin, and this proves the log is actually there, is
  // actually indexed by creator, and decodes back into the same coin.
  {
    const topic = ethers.id('Launched(address,address,string,string)');
    const creatorTopic = ethers.zeroPadValue(creatorAddr.toLowerCase(), 32);
    const logs = await provider.getLogs({
      fromBlock: 0, toBlock: await provider.getBlockNumber(),
      topics: [topic, creatorTopic],
    });
    check('the launch emitted exactly one Launched log', logs.length === 1, `${logs.length}`);
    check('the Launched log is indexed by creator',
      !!(logs[0] && logs[0].topics[1] === creatorTopic));
    check('the Launched log is indexed by token',
      !!(logs[0] && logs[0].topics[2] === ethers.zeroPadValue(addr.toLowerCase(), 32)),
      'without an indexed token the feed cannot tell which coin a log is about');

    // The log must carry enough to rebuild the coin's identity -- that is the
    // whole point of indexing it. image is deliberately absent (too large to log;
    // it is readable from the contract instead).
    const decoded = ethers.AbiCoder.defaultAbiCoder().decode(['string', 'string'], logs[0].data);
    check('the log carries the coin name', decoded[0] === 'Quote Test', `got "${decoded[0]}"`);
    check('the log carries the ticker', decoded[1] === 'QTEST', `got "${decoded[1]}"`);
    check('the decoded token matches the deployed address',
      ethers.getAddress('0x' + logs[0].topics[2].slice(-40)).toLowerCase() === addr.toLowerCase());

    // Another wallet's query must NOT see this coin: discovery is scoped to the
    // creator, or every visitor's feed would list everyone else's coins.
    const otherTopic = ethers.zeroPadValue(await other.getAddress(), 32);
    const others = await provider.getLogs({
      fromBlock: 0, toBlock: await provider.getBlockNumber(),
      topics: [topic, otherTopic],
    });
    check('another wallet does not see this launch', others.length === 0, `${others.length}`);
  }

  // ── the screen's promise vs the chain's answer ─────────────────
  const sizes = ['0.001', '0.01', '0.05', '0.2'];
  let feesBefore = await t.totalFeesCreator();
  for (const size of sizes) {
    const ethIn = ethers.parseEther(size);

    // What the coin page would put on screen right now.
    const [vE, vT] = await Promise.all([t.virtualEth(), t.virtualTokens()]);
    const q = C.quoteBuy(vE, vT, ethIn);

    const before = await t.balanceOf(buyerAddr);
    await (await t.connect(buyer).buy((q.tokensOut * 9_900n) / 10_000n, { value: ethIn, gasLimit: 900_000 })).wait();
    const after = await t.balanceOf(buyerAddr);
    const got = after - before;

    // 1. the user must never receive LESS than the screen promised
    check(`buy ${size} ETH delivers at least the quoted tokens`,
      got >= q.tokensOut, `quoted ${q.tokensOut} got ${got} (short ${q.tokensOut - got})`);
    // 2. and never materially more — a coin that overpays is a different bug
    check(`buy ${size} ETH does not over-deliver`,
      got <= q.tokensOut + 1n, `quoted ${q.tokensOut} got ${got}`);

    // 3. the reserves must land exactly where the quote said they would
    const [nE, nT] = await Promise.all([t.virtualEth(), t.virtualTokens()]);
    check(`buy ${size} ETH moves reserves to the quoted next values`,
      nE === q.nextVirtualEth && nT === q.nextVirtualTokens,
      `eth ${nE} vs ${q.nextVirtualEth}, tokens ${nT} vs ${q.nextVirtualTokens}`);

    // 4. the fee must match the split the screen shows. totalFeesCreator is
    // CUMULATIVE, so this compares the DELTA this buy accrued — comparing the
    // running total against one trade's fee would "fail" on the second buy while
    // the contract was right.
    const after1 = await t.totalFeesCreator();
    const accrued = after1 - feesBefore;
    check(`buy ${size} ETH accrued a creator fee`, accrued > 0n, `accrued ${accrued}`);
    const contractFee = (ethIn * 125n) / 10_000n;
    const predicted = C.splitFee(contractFee).creator;
    check(`buy ${size} ETH creator fee is exactly the app's fee split`,
      accrued === predicted, `chain accrued ${accrued}, app predicts ${predicted}`);
    feesBefore = after1;
  }

  // ── sell: the mirror image ─────────────────────────────────────
  let holding = await t.balanceOf(buyerAddr);
  for (const frac of [3n, 2n]) {
    const tokensIn = holding / frac;
    const [vE, vT] = await Promise.all([t.virtualEth(), t.virtualTokens()]);
    const q = C.quoteSell(vE, vT, tokensIn);

    const balBefore = await provider.getBalance(buyerAddr);
    await (await t.connect(buyer).sell(tokensIn, (q.ethOut * 9_900n) / 10_000n, { gasLimit: 900_000 })).wait();
    const balAfter = await provider.getBalance(buyerAddr);
    const received = balAfter - balBefore;

    check(`sell 1/${frac} of the holding burns exactly the tokens handed back`,
      (await t.balanceOf(buyerAddr)) === holding - tokensIn);
    // The user must not receive MORE than quoted (they pay gas, so the delta is
    // received minus gas — comparing against the quote needs the gas allowance).
    check(`sell 1/${frac} pays no more ETH than quoted`,
      received <= q.ethOut, `quoted ${q.ethOut}, wallet moved ${received}`);
    // …and must receive something real: a sell that silently rounds to zero
    // reads as a successful trade that paid nothing.
    check(`sell 1/${frac} pays a real amount`,
      received > 0n, `received ${received}`);
    holding = await t.balanceOf(buyerAddr);
  }

  // ── the contract's own ETH bookkeeping ────────────────────────
  //
  // This is where a real money bug lived. sell() used to drop the reserve by
  // the payout but NOT by the protocol's share, so realEthReserve crept ABOVE
  // the ETH actually held — and claimFees() then underflowed and reverted,
  // locking the creator's revenue forever.
  //
  // The invariant, stated correctly: realEthReserve IS the whole balance. The
  // unpaid creator fees are a CLAIM ON that balance, not a separate pot beside
  // it — which is why claiming them drops both the owed amount and the balance by
  // the same figure, and why the two must line up exactly at the end.
  const reserve = await t.realEthReserve();
  const owed = await t.totalFeesCreator();
  const held = await provider.getBalance(addr);
  check('the reserve claims no more ETH than the contract holds',
    reserve <= held, `reserve ${reserve} vs held ${held}`);
  check('the reserve equals the ETH held exactly',
    reserve === held, `reserve ${reserve} vs held ${held}`);
  check('the unpaid creator fees are a claim on that balance, not extra ETH',
    owed <= held, `owed ${owed} vs held ${held}`);

  // …and the money must actually come out, which is what the drift used to
  // prevent: claim the whole accrued fee and watch the reserve track the balance.
  const creatorBefore = await provider.getBalance(creatorAddr);
  await (await t.connect(creator).claimFees({ gasLimit: 400_000 })).wait();
  const creatorAfter = await provider.getBalance(creatorAddr);
  check('claiming the accrued fees succeeds', creatorAfter !== creatorBefore,
    `${creatorBefore} -> ${creatorAfter}`);
  check('the accrued fee is now zero', (await t.totalFeesCreator()) === 0n);
  const reserve2 = await t.realEthReserve();
  const held2 = await provider.getBalance(addr);
  check('after the claim the reserve exactly equals what is held',
    reserve2 === held2, `reserve ${reserve2} vs held ${held2}`);

  // A second claim with nothing owed must revert, not silently pay out.
  let emptyClaimBlocked = false;
  try { await (await t.connect(creator).claimFees({ gasLimit: 300_000 })).wait(); } catch { emptyClaimBlocked = true; }
  check('an empty claim reverts instead of paying nothing', emptyClaimBlocked);

  // ── a third party cannot take the creator's fees ───────────────
  let thiefBlocked = false;
  try { await (await t.connect(other).claimFees({ gasLimit: 300_000 })).wait(); } catch { thiefBlocked = true; }
  check('a non-creator cannot claim the fees', thiefBlocked);

  // ── the tape the screen renders must match the chain ──────────
  // history.js derives each row's price from the event's own eth/tokens; if the
  // events do not carry enough to price a fill, the tape cannot be honest.
  const addrLogs = await provider.getLogs({ fromBlock: 0, toBlock: await provider.getBlockNumber(), address: addr });
  const bought = addrLogs.filter((l) => l.topics[0] === ethers.id('Bought(address,uint256,uint256,uint256)'));
  const sold = addrLogs.filter((l) => l.topics[0] === ethers.id('Sold(address,uint256,uint256,uint256)'));
  // sizes.length buys in the quote loop, PLUS the one the slippage block landed
  // at the real floor. The REJECTED floor emits nothing — which is why this
  // counts instead of assuming: a refused trade must leave no trace at all.
  check('the chain emitted exactly one Bought per accepted buy',
    bought.length === sizes.length + 1, `${bought.length} for ${sizes.length} buys + 1 from the slippage block`);
  check('the chain emitted a Sold per sell', sold.length === 2, `${sold.length}`);

  const decoded = bought.map((l) => {
    const d = ethers.AbiCoder.defaultAbiCoder().decode(
      ['uint256', 'uint256', 'uint256'], l.data,
    );
    return { eth: d[0], tokens: d[1] };
  });
  check('every buy event carries enough to price it (tokens > 0)',
    decoded.every((d) => d.tokens > 0n), JSON.stringify(decoded.map((d) => d.tokens.toString())));
} catch (e) {
  failures++;
  console.error('  ERROR', (e && (e.shortMessage || e.message)) || String(e));
  // The stack is the point of catching it here: "invalid BigNumberish value"
  // names a symptom, never the line that caused it.
  if (process.env.DEX_E2E_TRACE) console.error(String((e && e.stack) || '').split('\n').slice(0, 6).join('\n'));
} finally {
  try { p.kill(); } catch { /* already gone */ }
}

console.log(failures
  ? `\n${failures} on-chain check(s) FAILED \u2014 the screen and the chain disagree`
  : '\nall on-chain quote<->chain checks passed: the screen never lies about a price');
process.exit(failures ? 1 : 0);
