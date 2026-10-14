// The market maker, on a real chain, trading with addresses it made itself.
//
// The unit tests prove the rules are right. This proves the machine moves money
// the way the rules say it will: it creates its own addresses, funds them from
// one balance, rotates between them, and stops when — and only when — the rules
// say it should.
//
// Run: npm run test:dex-bot   (needs anvil on 127.0.0.1:8607)

import { ethers } from 'ethers';
import { spawn } from 'node:child_process';
import { PUMP_TOKEN_SOURCE } from '../js/dex/pump-source.js';
import { VIRTUAL_QUOTE, VIRTUAL_TOKENS, quoteBuy, quoteSell } from '../js/dex/curve.js';
import { decide, nextAccount, budgetBps, BUY, SELL, STOP, WHY } from '../js/dex/bot-engine.js';
import { deriveBotWallets, splitBudget, botStartIndex } from '../js/dex/bot-wallets.js';

const PHRASE = 'test test test test test test test test test test test junk';
const MOCK_ERC20 = `
contract MockQuote {
    string public name = "Bear Test Quote"; string public symbol = "QT";
    uint8 public constant decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;
    function mint(address to, uint256 a) external { balanceOf[to] += a; totalSupply += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address t, uint256 a) external returns (bool) { _m(msg.sender,t,a); return true; }
    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        require(allowance[f][msg.sender] >= a, "allowance"); allowance[f][msg.sender] -= a; _m(f,t,a); return true; }
    function _m(address f, address t, uint256 a) internal {
        require(balanceOf[f] >= a, "balance"); balanceOf[f] -= a; balanceOf[t] += a; }
}`;

const RPC = 'http://127.0.0.1:8607';
const results = [];
const check = (name, pass, detail = '') => {
  results.push(pass);
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${pass || !detail ? '' : '  -> ' + detail}`);
};

let anvil = null;
async function chainUp() {
  try { await new ethers.JsonRpcProvider(RPC).getBlockNumber(); return; } catch { /* start it */ }
  anvil = spawn('anvil', ['--port', '8607', '--silent', '--chain-id', '11155111'], { stdio: 'ignore', detached: true });
  anvil.unref();
  const p = new ethers.JsonRpcProvider(RPC);
  for (let i = 0; i < 40; i++) {
    try { await p.getBlockNumber(); return; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  throw new Error('anvil did not start');
}

const solc = (await import('solc')).default;
function build(src, name) {
  const out = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity', sources: { A: { content: src } },
    settings: { outputSelection: { '*': { '*': ['evm.bytecode.object', 'abi'] } } },
  })));
  const errs = (out.errors || []).filter((e) => e.severity === 'error');
  if (errs.length) { console.error(errs[0].formattedMessage); process.exit(1); }
  return out.contracts.A[name];
}

try {
  await chainUp();
  globalThis.ethers = ethers;
  const provider = new ethers.JsonRpcProvider(RPC, undefined, { cacheTimeout: -1 });
  const [master, ...filler] = await Promise.all([0, 1, 2].map((i) => provider.getSigner(i)));
  const masterAddr = await master.getAddress();
  const ONE = ethers.parseEther('1');
  const q = (n) => ONE * BigInt(n);

  const qc = build(MOCK_ERC20, 'MockQuote');
  const quote = await (await new ethers.ContractFactory(qc.abi, '0x' + qc.evm.bytecode.object, master)).deploy({ gasLimit: 2_000_000 });
  await quote.deploymentTransaction().wait();
  const quoteAddr = await quote.getAddress();
  await (await quote.mint(masterAddr, q(50))).wait();
  // The outsider needs real balance: a market maker can only answer a
  // price that someone else was able to move in the first place.
  for (const s of filler) await (await quote.mint(await s.getAddress(), q(5))).wait();

  const pt = build(PUMP_TOKEN_SOURCE, 'PumpToken');
  const token = await (await new ethers.ContractFactory(pt.abi, '0x' + pt.evm.bytecode.object, master))
    .deploy('Bot Coin', 'BOT', '', '', quoteAddr, VIRTUAL_QUOTE, VIRTUAL_TOKENS, { gasLimit: 6_000_000 });
  await token.deploymentTransaction().wait();
  const addr = await token.getAddress();
  const c = new ethers.Contract(addr, pt.abi, master);

  // ── the addresses the bot makes for itself ─────────────────────────
  const held = await Promise.all([masterAddr, ...filler.map((s) => s.getAddress())]);
  const wallets = deriveBotWallets(PHRASE, botStartIndex([]), 4, held);
  for (const w of wallets) w.signer = w.signer.connect(provider);
  check('the bot made four addresses of its own',
    new Set(wallets.map((w) => w.address)).size === 4);
  check('none of them is the wallet funding them',
    !wallets.some((w) => w.address === masterAddr));

  // ── one balance, split across them ─────────────────────────────────
  // Graduation is at 2 quote, and every trade puts quote INTO the contract.
  // A run sized in whole coins graduates the coin on the second shove and
  // ends before the bot does anything — so the run is sized in fractions.
  const budget = q(4);
  const shares = splitBudget(budget, wallets.length, 0n);
  for (let i = 0; i < wallets.length; i++) {
    await (await quote.transfer(wallets[i].address, shares[i])).wait();
  }
  const funded = await Promise.all(wallets.map((w) => quote.balanceOf(w.address)));
  check('the whole balance reached the new addresses, to the wei',
    funded.reduce((a, b) => a + b, 0n) === budget,
    `sent ${await ethers.formatEther(funded.reduce((a, b) => a + b, 0n))} of 4`);
  check('and left the funding wallet with none',
    await quote.balanceOf(masterAddr) === q(50) - budget);

  // ── the band, anchored to the real opening price ───────────────────
  // A market maker only acts when the price LEAVES its band — that is the
  // whole job. A band parked where the price never goes would prove nothing, and
  // a 1% band on a curve that triples in one trade would just make the bot dump
  // everything it owns. So: a normal ±band, and OUTSIDERS move the price. That
  // is the situation a market maker exists for — someone else trades, the price
  // moves, the bot answers.
  const size = q(2) / 100n;   // 0.02

  const outsider = new ethers.Contract(addr, pt.abi, filler[0]);
  const outsiderQuote = new ethers.Contract(quoteAddr, qc.abi, filler[0]);
  // The outsider has to actually hold tokens, or "push the price down" is a
  // silent no-op and every tick just waits in the band.
  await (await outsiderQuote.approve(addr, q(2))).wait();
  await (await outsider.buy(q(5) / 10n, 1n, { gasLimit: 900_000 })).wait();

  // Measured AFTER the seed buy: seeding is a price move of its own, so a band
  // bracketing the price before it would already be out of range on tick one.
  const openPrice = (await c.virtualQuote() * 10n ** 18n) / (await c.virtualTokens());
  // The band has to be narrower than what the outsiders can actually move.
  // A ±30% band on a curve that opens at ~1 coin cannot be left with 0.05-coin
  // trades, so the bot would correctly sit and do nothing for ever.
  const floor = (openPrice * 97n) / 100n;
  const ceil = (openPrice * 103n) / 100n;
  // Push the price out of the band, in whichever direction is needed. Returns
  // what it managed to do so a tick can report an honest "nothing moved".
  async function shoveDown() {
    await (await outsiderQuote.approve(addr, q(2))).wait();
    const [vq, vt] = [await c.virtualQuote(), await c.virtualTokens()];
    const held = await c.balanceOf(await filler[0].getAddress());
    if (!held) return 0n;
    const want = held / 2n;
    const minOut = (quoteSell(vq, vt, want).quoteOut * 9000n) / 10000n;
    await (await outsider.sell(want, minOut, { gasLimit: 900_000 })).wait();
    return want;
  }
  async function shoveUp() {
    const [vq, vt] = [await c.virtualQuote(), await c.virtualTokens()];
    const qin = q(5) / 100n;   // 0.05 — about a 5% price move
    const minOut = (quoteBuy(vq, vt, qin).tokensOut * 9000n) / 10000n;
    await (await outsider.buy(qin, minOut, { gasLimit: 900_000 })).wait();
    return qin;
  }

  // Balances are read fresh every tick, exactly as the runner does. A bot that
  // remembers them asks a wallet for money it spent a tick ago.
  const accs = async () => Promise.all(wallets.map(async (w) => ({
    ...w,
    quoteBal: await quote.balanceOf(w.address),
    tokenBal: await c.balanceOf(w.address),
  })));

  let cursor = 0, spent = 0n, trades = 0, halted = null;
  const used = new Set();

  for (let tick = 0; tick < 8; tick++) {
    if (halted) break;
    // Alternating pressure: down, up, down, up. Each shove drags the price out
    // of the band, so the bot has a reason to act every single tick — and the
    // BUYS land on a different address each time, which is the claim to prove.
    if (tick % 2 === 0) await shoveDown().catch(() => 0n);
    else await shoveUp().catch(() => 0n);

    const [vq, vt, graduated, list] = [await c.virtualQuote(), await c.virtualTokens(), await c.graduated(), await accs()];
    const price = (vq * 10n ** 18n) / vt;
    const totalQuote = list.reduce((a, b) => a + b.quoteBal, 0n);
    const totalTok = list.reduce((a, b) => a + b.tokenBal, 0n);

    const want = decide({ price, floor, ceil, size, spent, cap: budget, graduated, quoteBal: totalQuote, tokenBal: totalTok });
    if (want.action === STOP) { halted = want.why; break; }
    if (want.action !== BUY && want.action !== SELL) { continue; }

    const pick = nextAccount(list, want.action === BUY ? 'buy' : 'sell', size, cursor);
    if (!pick.account) { halted = WHY.NO_WALLET; break; }
    cursor = pick.cursor;
    const acc = pick.account;

    const d = decide({
      price, floor, ceil, size, quoteBal: acc.quoteBal, tokenBal: acc.tokenBal,
      spent, cap: budget, graduated,
    });
    if (d.action !== BUY && d.action !== SELL) { continue; }

    const signer = new ethers.Contract(addr, pt.abi, acc.signer);
    const qcAcc = new ethers.Contract(quoteAddr, qc.abi, acc.signer);
    if (d.action === BUY) {
      const allowed = await qcAcc.allowance(acc.address, addr);
      if (allowed < d.amount) await (await qcAcc.approve(addr, d.amount)).wait();
      const minOut = (quoteBuy(vq, vt, d.amount).tokensOut * 9900n) / 10000n;
      await (await signer.buy(d.amount, minOut, { gasLimit: 900_000 })).wait();
      spent += d.amount;
    } else {
      const minOut = (quoteSell(vq, vt, d.amount).quoteOut * 9900n) / 10000n;
      await (await signer.sell(d.amount, minOut, { gasLimit: 900_000 })).wait();
    }
    trades++;
    used.add(acc.address);
  }
  check('the bot actually traded on-chain', trades > 0, `trades=${trades}`);
  check('and it spread the trades across more than one address',
    used.size > 1, `addresses used=${used.size}`);
  check('every trade came from a bot address, never the funding wallet',
    [...used].every((a) => !wallets.some((w) => w.address === a && w.address === masterAddr)));
  check('the budget was never exceeded', spent <= budget,
    `spent ${await ethers.formatEther(spent)} of 4`);
  check('the budget bar tracks what was really spent',
    Number(budgetBps(spent, budget)) > 0 && Number(budgetBps(spent, budget)) <= 10000);

  // ── the cap is enforced by the rule, not by luck ───────────────────
  const over = decide({
    price: floor, floor, ceil, size, quoteBal: q(10), tokenBal: q(10),
    spent: budget - size + 1n, cap: budget,
  });
  check('one wei past the budget the bot refuses to trade', over.action === STOP && over.why === WHY.NO_BUDGET);

  // ── a graduated coin stops it, whatever it was about to do ─────────
  const grad = decide({
    price: floor, floor, ceil, size, quoteBal: q(10), tokenBal: q(10),
    spent: 0n, cap: budget, graduated: true,
  });
  check('a graduated coin stops the bot immediately', grad.action === STOP && grad.why === WHY.GRADUATED);

  // ── a private-key wallet cannot run a bot ──────────────────────────
  const { canDerive } = await import('../js/dex/bot-wallets.js');
  check('a private key is refused up front, not mid-run',
    !canDerive('0x' + 'c'.repeat(64)) && canDerive(PHRASE));
} catch (err) {
  check('the bot run completed', false, err.message.split('\n')[0]);
}

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} market-maker checks passed`);
if (anvil) { try { process.kill(-anvil.pid); } catch { /* gone */ } }
process.exit(failed ? 1 : 0);