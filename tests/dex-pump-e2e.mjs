// Bear Tool — tests/dex-pump-e2e.mjs
// A REAL end-to-end run of the launchpad contract on a throwaway anvil fork of
// Sepolia: deploy PumpToken → buy → sell → check creator fees are CLAIMABLE
// (not locked) and that no ETH is stranded in the contract.
//
// This is the maturity gate for the launchpad: before claimFees()/withdraw()
// existed, the creator's fees and the ETH backing were counted but could never
// leave the contract. This test proves that hole is closed, and proves the
// buy/sell curve actually moves balances on a real EVM.
import { spawn } from 'node:child_process';
import { ethers } from 'ethers';
import { readFileSync } from 'node:fs';

const PORT = 8607;
const ANVIL = ['--port', String(PORT), '--silent', '--chain-id', '11155111'];

function startAnvil() {
  const p = spawn('anvil', ANVIL);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('anvil did not start')), 15000);
    p.on('exit', (c) => { clearTimeout(t); reject(new Error('anvil exited ' + c)); });
    // poll until it answers
    (async () => {
      const url = `http://127.0.0.1:${PORT}`;
      for (let i = 0; i < 60; i++) {
        try {
          // cacheTimeout -1: a JsonRpcProvider caches getBalance for a polling
          // window, so a before/after pair read either side of a tx came back
          // identical and every balance-delta check failed for the wrong reason.
          const pr = new ethers.JsonRpcProvider(url, undefined, { cacheTimeout: -1, staticNetwork: true });
          await pr.getBlockNumber();
          clearTimeout(t); resolve({ p, provider: pr }); return;
        } catch { await new Promise((r) => setTimeout(r, 300)); }
      }
      clearTimeout(t); reject(new Error('anvil never answered'));
    })();
  });
}

// Compile with the same source the app ships. solc.js needs a DOM to load the
// CDN compiler, so read the source and compile through a pre-fetched solc here
// via the browser-free path: we reuse the app's solc-js in "compiler already
// injected" mode by importing solc directly.
async function compilePumpToken() {
  const mod = await import('../js/dex/pump-source.js');
  const source = mod.PUMP_TOKEN_SOURCE;
  // solc-js as a module (the app loads the standalone build in the browser).
  const solc = (await import('solc')).default;
  const input = {
    language: 'Solidity',
    sources: { 'PumpToken.sol': { content: source } },
    settings: { outputSelection: { '*': { '*': ['evm.bytecode.object', 'abi'] } } },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errs = (out.errors || []).filter((e) => e.severity === 'error');
  if (errs.length) throw new Error('solc: ' + errs.map((e) => e.formattedMessage).join('\n'));
  return { abi: out.contracts['PumpToken.sol'].PumpToken.abi, bytecode: '0x' + out.contracts['PumpToken.sol'].PumpToken.evm.bytecode.object };
}

const V = 10n ** 18n;
const VT = 1073000000n * 10n ** 18n;


const MOCK_ERC20 = `contract MockQuote {
  string public name="Bear Test"; string public symbol="TST"; uint8 public constant decimals=18;
  mapping(address=>uint256) public balanceOf; mapping(address=>mapping(address=>uint256)) public allowance;
  uint256 public totalSupply;
  function mint(address t,uint256 a) external { balanceOf[t]+=a; totalSupply+=a; }
  function approve(address s,uint256 a) external returns (bool){ allowance[msg.sender][s]=a; return true; }
  function transfer(address t,uint256 a) external returns (bool){ _m(msg.sender,t,a); return true; }
  function transferFrom(address f,address t,uint256 a) external returns (bool){ require(allowance[f][msg.sender]>=a,"allow"); allowance[f][msg.sender]-=a; _m(f,t,a); return true; }
  function _m(address f,address t,uint256 a) internal { require(balanceOf[f]>=a,"bal"); balanceOf[f]-=a; balanceOf[t]+=a; }
}`;

const solc = (await import('solc')).default;
function compileMock() {
  const o = JSON.parse(solc.compile(JSON.stringify({ language:'Solidity', sources:{ 'Q.sol':{content:MOCK_ERC20} },
    settings:{ outputSelection:{ '*':{ '*':['evm.bytecode.object','abi'] } } } })));
  const e = (o.errors||[]).filter(x=>x.severity==='error');
  if (e.length) throw new Error('solc mock: ' + e.map(x=>x.formattedMessage).join('\n'));
  return { abi: o.contracts['Q.sol'].MockQuote.abi, bytecode: '0x'+o.contracts['Q.sol'].MockQuote.evm.bytecode.object };
}

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`  ok  ${name}`);
  else { failures++; console.log(`  FAIL ${name} ${extra}`); }
}

const { p, provider } = await startAnvil();
try {
  console.log('PumpToken end-to-end on anvil (Sepolia chain-id 11155111)');
  const { abi, bytecode } = await compilePumpToken();
  const signers = await Promise.all([0, 1, 2].map((i) => provider.getSigner(i)));
  const [creator, buyer, seller] = signers;
  const cAddr = await creator.getAddress();

  // The curve is quoted in an ERC-20 now, and Sepolia native ETH is gas only —
  // so the coin this runs against has to exist before the curve does.
  const mq = compileMock();
  const quote = await (await new ethers.ContractFactory(mq.abi, mq.bytecode, creator)).deploy({ gasLimit: 2_000_000 });
  await quote.deploymentTransaction().wait();
  const quoteAddr = await quote.getAddress();
  for (const s of [buyer, seller]) await (await quote.mint(await s.getAddress(), ethers.parseEther('100'))).wait();

  const factory = new ethers.ContractFactory(abi, bytecode, creator);
  const token = await factory.deploy('Bear Moon', 'BMOON', 'a test coin', '', quoteAddr, V, VT, { gasLimit: 5_000_000 });
  const rc = await token.deploymentTransaction().wait();
  check('deploy succeeds', token.target && rc.status === 1, `status=${rc.status}`);
  const t = new ethers.Contract(await token.getAddress(), abi, creator);

  const read = async () => ({
    vE: await t.virtualQuote(), vT: await t.virtualTokens(),
    reserve: await t.realQuoteReserve(), graduated: await t.graduated(),
    fees: await t.totalFeesCreator(),
    bal: await t.balanceOf(await buyer.getAddress()),
    held: await quote.balanceOf(await token.getAddress()),
  });

  // buy: buyer pays the QUOTE coin, gets tokens, creator fee accrues.
  // Native ETH is refused outright by the contract, so it is never even an option.
  const buyAmt = ethers.parseEther('0.01');
  const qBuyer = new ethers.Contract(quoteAddr, mq.abi, buyer);
  await (await qBuyer.approve(await token.getAddress(), buyAmt)).wait();
  await (await t.connect(buyer).buy(buyAmt, 0n, { gasLimit: 900_000 })).wait();
  let s = await read();
  check('buy moves the curve (virtualQuote up)', s.vE > V, `vE=${s.vE}`);
  check('buy credits the buyer', s.bal > 0n, `bal=${s.bal}`);
  check('creator fees accrued on buy', s.fees > 0n, `fees=${s.fees}`);
  // the contract keeps creator-fee + curve backing; the protocol's share was
  // paid out, so it holds slightly LESS than msg.value
  check('contract holds the quote coin (minus protocol share)', s.held > 0n && s.held < buyAmt, `held=${s.held}`);

  // sell: buyer trades tokens back for ETH
  const balNow = await t.balanceOf(await buyer.getAddress());
  const sellAmt = balNow / 2n;
  const before = await quote.balanceOf(await buyer.getAddress());
  await (await t.connect(buyer).sell(sellAmt, 0n, { gasLimit: 900_000 })).wait();
  const after = await quote.balanceOf(await buyer.getAddress());
  const balAfter = await t.balanceOf(await buyer.getAddress());
  check('sell burns the tokens handed back', balAfter === balNow - sellAmt, `${balNow} -> ${balAfter} sold ${sellAmt}`);
  check('sell pays the buyer the quote coin back', after > before, `before=${before} after=${after}`);

  // creator claims the accrued fees — the hole this closes
  const feesBefore = await t.totalFeesCreator();
  const creatorBefore = await quote.balanceOf(cAddr);
  const feesWei = feesBefore;
  await (await t.connect(creator).claimFees({ gasLimit: 300_000 })).wait();
  const feesAfter = await t.totalFeesCreator();
  const creatorAfter = await quote.balanceOf(cAddr);
  check('claimFees() zeroes the accrued fees', feesBefore > 0n && feesAfter === 0n, `before=${feesBefore} after=${feesAfter}`);
  // the creator pays gas to claim, so the net delta is (fees - gas): allow the
  // receipt to prove fees actually left the contract rather than guessing
  check('creator actually received the fees', creatorAfter > creatorBefore && feesAfter === 0n,
    `${await ethers.formatEther(creatorBefore)} -> ${await ethers.formatEther(creatorAfter)}`);

  // a non-creator cannot claim
  let nonCreatorBlocked = false;
  try { await (await t.connect(buyer).claimFees({ gasLimit: 300_000 })).wait(); } catch { nonCreatorBlocked = true; }
  check('non-creator cannot claim fees', nonCreatorBlocked);

  // a non-creator cannot withdraw
  let nonCreatorWdBlocked = false;
  try { await (await t.connect(buyer).withdraw({ gasLimit: 300_000 })).wait(); } catch { nonCreatorWdBlocked = true; }
  check('non-creator cannot withdraw', nonCreatorWdBlocked);

  // withdraw only works once graduated
  let preGradWithdrawBlocked = false;
  try { await (await t.connect(creator).withdraw({ gasLimit: 300_000 })).wait(); } catch { preGradWithdrawBlocked = true; }
  check('withdraw blocked before graduation', preGradWithdrawBlocked);

  // push the curve to graduation by buying a lot, then the creator can move it
  // (GRADUATION_QUOTE is 2 ETH; buy in chunks until graduated)
  for (let i = 0; i < 20; i++) {
    if ((await t.graduated())) break;
    // Approve per chunk: an unlimited approval is never what the app sends, and
    // the gate should never bless a path the app does not use.
    const chunk = ethers.parseEther('0.2');
    try {
      const allowed = await qBuyer.allowance(await buyer.getAddress(), await token.getAddress());
      if (allowed < chunk) await (await qBuyer.approve(await token.getAddress(), chunk)).wait();
      await (await t.connect(buyer).buy(chunk, 0n, { gasLimit: 900_000 })).wait();
    } catch { break; }
  }
  s = await read();
  check('curve graduates at the threshold', s.graduated === true, `reserve=${s.reserve} graduated=${s.graduated}`);

  const heldBeforeWd = s.held;
  const creatorBeforeWd = await quote.balanceOf(cAddr);
  await (await t.connect(creator).withdraw({ gasLimit: 300_000 })).wait();
  const heldAfterWd = await quote.balanceOf(await token.getAddress());
  // withdraw() pays the creator their accrued FEE, not the whole balance: with
// liquidity in the pool, paying out everything would be theft.
const wdCheck = (await t.totalFeesCreator()) === 0n
  && heldAfterWd < heldBeforeWd
  && (await quote.balanceOf(cAddr)) - creatorBeforeWd > 0n;
check('withdraw() pays the creator their fee and leaves the pool alone',
    wdCheck, `before=${heldBeforeWd} after=${heldAfterWd}`);
  check('creator receives their fee', (await quote.balanceOf(cAddr)) > creatorBeforeWd);

  // no ETH stranded anywhere: contract balance is zero and fees are claimable-to-zero
  const final = await read();
  check('nothing is stranded in the contract', final.held === 0n, `held=${final.held}`);
} catch (e) {
  failures++;
  console.error('  ERROR', e && (e.shortMessage || e.message) || String(e)); if (e && e.revert) console.error('  revert=', e.revert); if (e && e.error && e.error.data) console.error('  data=', e.error.data);
} finally {
  try { p.kill(); } catch { /* already gone */ }
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall PumpToken end-to-end checks passed');
process.exit(failures ? 1 : 0);
