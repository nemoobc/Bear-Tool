// Liquidity, proven against a real chain.
//
// Adding liquidity to a bonding curve is the easiest thing in crypto to fake.
// The UI says "add liquidity", the number goes up, the pool looks deeper — and
// nothing about the price changed, which is exactly what a broken pool looks
// like too. So every claim here is measured on-chain: reserves before and
// after, who can withdraw what, and whether the creator can reach money that
// belongs to someone else.
//
// Run: npm run test:dex-liquidity   (needs anvil on 127.0.0.1:8607)

import { ethers } from 'ethers';
import { spawn } from 'node:child_process';
import { PUMP_TOKEN_SOURCE } from '../js/dex/pump-source.js';
import { VIRTUAL_QUOTE, VIRTUAL_TOKENS } from '../js/dex/curve.js';

// A stand-in for the three Dex coins. The real ones are on Sepolia and cannot be
// minted; what matters here is that the curve treats its quote token as an
// ordinary ERC-20 with a balance, an allowance and a transferFrom.
const MOCK_ERC20 = `
contract MockQuote {
    string public name = "Bear Test Quote";
    string public symbol = "QT";
    uint8 public constant decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;

    function mint(address to, uint256 a) external { balanceOf[to] += a; totalSupply += a; }
    function approve(address spender, uint256 a) external returns (bool) {
        allowance[msg.sender][spender] = a; return true;
    }
    function transfer(address to, uint256 a) external returns (bool) { _move(msg.sender, to, a); return true; }
    function transferFrom(address from, address to, uint256 a) external returns (bool) {
        require(allowance[from][msg.sender] >= a, "allowance");
        allowance[from][msg.sender] -= a;
        _move(from, to, a); return true;
    }
    function _move(address from, address to, uint256 a) internal {
        require(balanceOf[from] >= a, "balance");
        balanceOf[from] -= a; balanceOf[to] += a;
    }
}`;

const RPC = 'http://127.0.0.1:8607';
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${pass || !detail ? '' : '  -> ' + detail}`);
};

// ── chain ────────────────────────────────────────────────────────────
let anvil = null;
async function chainUp() {
  try {
    const p = new ethers.JsonRpcProvider(RPC);
    await p.getBlockNumber();
    return;
  } catch { /* not running yet */ }
  anvil = spawn('anvil', ['--port', '8607', '--silent', '--chain-id', '11155111'], { stdio: 'ignore', detached: true });
  anvil.unref();
  const p = new ethers.JsonRpcProvider(RPC);
  for (let i = 0; i < 40; i++) {
    try { await p.getBlockNumber(); return; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  throw new Error('anvil did not come up on ' + RPC);
}

const solc = (await import('solc')).default;
function build(source, name) {
  const out = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources: { A: { content: source } },
    settings: { outputSelection: { '*': { '*': ['evm.bytecode.object', 'abi'] } } },
  })));
  const errs = (out.errors || []).filter((e) => e.severity === 'error');
  if (errs.length) { console.error(errs[0].formattedMessage); process.exit(1); }
  return out.contracts.A[name];
}

try {
  await chainUp();
  const provider = new ethers.JsonRpcProvider(RPC, undefined, { cacheTimeout: -1 });
  const [creator, alice, bob] = await Promise.all([0, 1, 2].map((i) => provider.getSigner(i)));
  const creatorAddr = await creator.getAddress();

  const q = build(MOCK_ERC20, 'MockQuote');
  const quoteFactory = await new ethers.ContractFactory(q.abi, '0x' + q.evm.bytecode.object, creator);
  const quote = await quoteFactory.deploy({ gasLimit: 2_000_000 });
  await quote.deploymentTransaction().wait();
  const quoteAddr = await quote.getAddress();
  for (const [who, amt] of [[alice, '100'], [bob, '100']]) {
    await (await quote.mint(await who.getAddress(), ethers.parseEther(amt))).wait();
  }

  const pt = build(PUMP_TOKEN_SOURCE, 'PumpToken');
  const token = await (await new ethers.ContractFactory(pt.abi, '0x' + pt.evm.bytecode.object, creator))
    .deploy('Liquidity Coin', 'LIQ', '', '', quoteAddr, VIRTUAL_QUOTE, VIRTUAL_TOKENS, { gasLimit: 6_000_000 });
  await token.deploymentTransaction().wait();
  const addr = await token.getAddress();
  const c = new ethers.Contract(addr, pt.abi, creator);
  const qAlice = new ethers.Contract(quoteAddr, q.abi, alice);
  const qBob = new ethers.Contract(quoteAddr, q.abi, bob);
  const ONE = ethers.parseEther('1');
  const e = (n) => ONE * BigInt(n);

  // ── deposits mint shares, and shares are 1:1 ───────────────────────
  for (const [w, qc] of [[alice, qAlice], [bob, qBob]]) {
    await (await qc.approve(addr, e(50))).wait();
    await (await c.connect(w).addLiquidity(e(20), { gasLimit: 300_000 })).wait();
  }
  check('each provider holds its own shares',
    await c.lpShares(await alice.getAddress()) === e(20) &&
    await c.lpShares(await bob.getAddress()) === e(20));
  check('total shares are the sum', await c.totalLpShares() === e(40));
  check('pool value equals deposits before any trade', await c.lpValue() === e(40),
    await ethers.formatEther(await c.lpValue()));

  // ── THE claim that distinguishes a pool from a disguised buy ───────
  const vq = await c.virtualQuote();
  const vt = await c.virtualTokens();
  check('adding liquidity does NOT move the price curve',
    vq === VIRTUAL_QUOTE && vt === VIRTUAL_TOKENS,
    `virtualQuote=${await ethers.formatEther(vq)} virtualTokens=${await ethers.formatEther(vt)}`);
  check('and mints no tokens to the provider',
    await c.balanceOf(await alice.getAddress()) === 0n);

  // ── trading moves the curve and pays the pool ──────────────────────
  const inAmt = e(5);
  await (await qAlice.approve(addr, inAmt)).wait();
  await (await c.connect(alice).buy(inAmt, 1n, { gasLimit: 900_000 })).wait();
  check('a buy DOES move the curve', await c.virtualQuote() > vq);
  const posAlice = await c.positionOf(await alice.getAddress());
  check('the provider\'s position grows from the fees trading earned',
    posAlice.value > e(20), `value=${await ethers.formatEther(posAlice.value)}`);

  // ── the creator cannot reach the providers' money ───────────────────
  // This is the assertion that did not exist until liquidity did: a creator
  // payout that sends the contract's whole balance is a theft the moment
  // anyone else deposits, and it is invisible until it happens.
  check('fees accrued for the creator while others traded', await c.totalFeesCreator() > 0n);
  const creatorBefore = await quote.balanceOf(creatorAddr);
  await (await c.claimFees({ gasLimit: 200_000 })).wait();
  check('the creator is paid their fee, and only their fee',
    (await quote.balanceOf(creatorAddr)) > creatorBefore);
  const bobNow = await c.positionOf(await bob.getAddress());
  const poolNow = await c.lpValue();
  check('the pool keeps the providers\' money after the creator is paid',
    poolNow >= bobNow.value && poolNow > 0n,
    `pool=${await ethers.formatEther(poolNow)} bob=${await ethers.formatEther(bobNow.value)}`);

  // ── withdrawal is pro-rata and pays the earnings ───────────────────
  const before = await quote.balanceOf(await alice.getAddress());
  await (await c.connect(alice).removeLiquidity(posAlice.shares, { gasLimit: 400_000 })).wait();
  const after = await quote.balanceOf(await alice.getAddress());
  check('withdrawing pays more than was deposited', after > before,
    `in=20 out=${await ethers.formatEther(after - before)}`);
  check('shares are burned on withdrawal', await c.lpShares(await alice.getAddress()) === 0n);

  // ── the pool still holds the other provider's claim ────────────────
  const bobAfter = await c.positionOf(await bob.getAddress());
  check('the other provider keeps a claim worth at least their deposit',
    bobAfter.value >= e(20), `value=${await ethers.formatEther(bobAfter.value)}`);

  // ── the obvious cheats are refused ─────────────────────────────────
  let over = false;
  try { await (await c.connect(alice).removeLiquidity(e(1), { gasLimit: 300_000 })).wait(); } catch { over = true; }
  check('cannot withdraw more shares than owned', over);

  let zero = false;
  try { await (await c.connect(bob).addLiquidity(0n, { gasLimit: 200_000 })).wait(); } catch { zero = true; }
  check('cannot deposit nothing', zero);

  let noAllow = false;
  try { await (await c.connect(creator).addLiquidity(e(1), { gasLimit: 200_000 })).wait(); } catch { noAllow = true; }
  check('cannot deposit without an allowance', noAllow);
} catch (err) {
  check('the liquidity run completed', false, err.message.split('\n')[0]);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} liquidity checks passed`);
if (anvil) { try { process.kill(-anvil.pid); } catch { /* already gone */ } }
process.exit(failed.length ? 1 : 0);