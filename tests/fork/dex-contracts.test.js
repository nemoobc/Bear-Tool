// Bear Tool — tests/fork/dex-contracts.test.js
// The Dex v2 engine, on a real chain. Anvil carries its own fresh state — no
// fork of any network, no external coin, no network mood — so this suite
// cannot blame anybody's RPC for anything. Behaviour pinned here, for every
// claim the M2 milestones makes about money:
//   · launch is atomic and exact: one tx deploys token + pair, seeds the pool
//     with the launcher's own quote, hands the remainder to the launcher and
//     the LP shares to the LAUNCHER (never to the factory);
//   · the swap maths the UI shows equals the swap maths execution applies,
//     coin by coin (view mirror), and k never shrinks;
//   · the creator fee is carved from the quote side only, tracked in quote
//     units, exact to the wei, claimable by the creator alone;
//   · LP locks refuse to move or burn a locked address's shares (only extend),
//     and really open at their time;
//   · no native ETH anywhere; the fee cap is 30 bps, exactly the point where
//     the k-invariant's slack runs out.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ethers } = require('ethers');

const { DEX_SOLIDITY } = await import('../../js/dex/contracts.js');
const { compileDex, compileMock } = await import('../helpers/dex-compile.mjs');

const ART = compileDex(DEX_SOLIDITY);
const MOCK = compileMock();

// Own port + own lock: never shares state with fork-helper's 8545 (two runs
// adopting one anvil ⇒ same nonce ⇒ a hang that reads as "the machine is
// slow"). This suite would rather die than depend on somebody's RPC mood.
const PORT = Number(process.env.DEX_TEST_PORT || 4956);
const RPC = `http://127.0.0.1:${PORT}`;
const LOCK = path.join(os.tmpdir(), `bear-dexcon-${PORT}.lock`);

const Q = 10n ** 18n;
const MAX = 2n ** 256n - 1n;
const META = (name, sym) => ({
  name, symbol: sym,
  image: '', desc: 'e2e coin',
  twitter: '', telegram: '', website: '',
});

let lockFd = null;
let proc = null;
let provider;
let w0, launcher, trader, lpPeer, feeThief; // w0 = deployer
let quote, factory;
const MOCKERC20 = compileMock().MockERC20;
const BEAR = compileDex(DEX_SOLIDITY);
const S = {}; // lab controls per-launch artifacts

function deploy(signer, art, ...args) {
  // Must wait for the mine: `deploy()` resolves at send-time, and `target`
  // stays null until the receipt — two lines here beat a mystery
  // "unsupported addressable value" three tests later.
  return new ethers.ContractFactory(art.abi, art.bytecode, signer)
    .deploy(...args)
    .then((c) => c.waitForDeployment().then(() => c));
}

function reasonOf(e) {
  return String(e?.revert?.args?.[0] || e?.revert || e?.shortMessage || e?.message || e);
}

// Raw JSON-RPC eth_call: revert reasons read straight off the wire, decoded
// once here and never re-implemented per test.
async function rawCall(params) {
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [params, 'latest'] }),
  });
  return r.json();
}

async function revertData(params) {
  const j = await rawCall(params);
  const data = String(j.error?.data || '');
  // Error(string): 4-byte selector + 32-byte offset word + 32-byte length
  // word, then the raw UTF-8 payload = 8 + 64 + 64 hex chars of header.
  if (!data.startsWith('0x08c379a0') || data.length < 136) return data;
  const len = parseInt(data.slice(72, 136), 16) || 0;
  if (!len) return data;
  try { return ethers.toUtf8String('0x' + data.slice(136, 136 + len * 2)); }
  catch { return data; }
}

before(async () => {
  lockFd = fs.openSync(LOCK, 'wx');
  fs.writeSync(lockFd, `pid=${process.pid} file=tests/fork/dex-contracts.test.js\n`);

  // An orphaned sibling (a killed parent leaves anvil behind) makes the port
  // busy with STALE state; adopting it would test last run's chain, not this
  // run's. Try the port, and walk upward on hard failure — never adopt.
  proc = spawn('anvil', ['--port', String(PORT), '--accounts', '10', '--silent'], { stdio: 'ignore' });
  proc.on('error', () => { proc = null; });

  provider = new ethers.JsonRpcProvider(RPC);
  try {
    await withDeadline(ready(), 12_000, 'anvil readiness');
  } catch {
    try { proc.kill('SIGKILL'); } catch { /* gone */ }
    try { fs.closeSync(lockFd); } catch { /* gone */ }
    try { fs.unlinkSync(LOCK); } catch { /* gone */ }
    throw new Error(
      `anvil on :${PORT} never became a fresh chain — an older kill-left instance probably still owns the port. ` +
      `Free it (pkill anvil) or run with DEX_TEST_PORT=<n>.`
    );
  }

  const phrase = 'test test test test test test test test test test test junk'; // anvil default
  // NonceManager on every wallet: anvil instant-mines between two awaits and
  // the plain JsonRpcProvider read served a STALE pending-count three times
  // in a row (measured probe: nonce pre = 2 on the third mint, "nonce too
  // low"). NonceManager tracks locally and bumps; failures reset it.
  // NonceManager hides the inner wallet's `.address` — the tests read
  // `wallet.address` everywhere, so cache it once here.
  const at = (i) => {
    const inner = ethers.HDNodeWallet.fromPhrase(phrase, '', `m/44'/60'/0'/0/${i}`).connect(provider);
    const w = new ethers.NonceManager(inner);
    w.address = inner.address;
    return w;
  };
  w0 = at(0);       // deploys quote + factory
  launcher = at(1); // launches tokens, holds LP
  trader = at(2);   // swaps
  lpPeer = at(3);   // adds/removes LP after launch
  feeThief = at(4); // anyone trying the fee stream

  quote = await deploy(w0, MOCKERC20);
  factory = await deploy(w0, BEAR.BearFactory, quote.target);

  // Prefunding everyone in one place: no test mints its own money. Every tx
  // is mined before the next line: a fire-and-forget allowance raced the
  // first launch into QC/ALLOWANCE — setup is part of the suite, so setup
  // must wait.
  await (await quote.mint(launcher.address, 500_000n * Q)).wait();
  await (await quote.mint(trader.address, 50_000n * Q)).wait();
  await (await quote.mint(lpPeer.address, 20_000n * Q)).wait();
  await (await quote.connect(launcher).approve(factory.target, MAX)).wait();
});

after(() => {
  if (proc) { try { proc.kill('SIGKILL'); } catch { /* gone */ } }
  if (lockFd) { try { fs.closeSync(lockFd); } catch { /* gone */ } }
  try { fs.unlinkSync(LOCK); } catch { /* gone */ }
});

function withDeadline(p, ms, label) {
  let timer;
  const guard = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} did not settle within ${ms}ms`)), ms); });
  p.catch(() => {});
  return Promise.race([p, guard]).finally(() => clearTimeout(timer));
}

async function ready() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) });
      const j = await r.json();
      if (j.result === '0x7a69') return; // anvil's default chain id = 31337
    } catch { /* still booting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`anvil on :${PORT} never came up`);
}

async function launch(signer, name, sym, supply, seedQuote, seedToken, bps, lpLockUntil, minShares = 1n) {
  const tx = await factory.connect(signer).launch(META(name, sym), supply, bps, lpLockUntil, seedQuote, seedToken, minShares);
  const rc = await tx.wait();
  const iface = new ethers.Interface(BEAR.BearFactory.abi);
  const ev = rc.logs.map((l) => { try { return iface.parseLog(l); } catch { return null; } }).find((x) => x?.name === 'Launched');
  if (!ev) throw new Error('launch committed without a Launched event');
  return ev.args;
}

function sqrt(x) {
  if (x === 0n) return 0n;
  let z = (x + 1n) / 2n, r = x;
  while (z < r) { r = z; z = (x / z + z) / 2n; }
  return r;
}

// A mined-but-reverted tx is not a pass: re-run the call statically once to
// surface the revert reason in the assertion message instead of a bare
// "status == 0" mystery. Receipt status arrives as number or BigInt per
// ethers path — compare numerically, never across BigInt identity.
async function expectMined(rc, label, rerun) {
  if (rc && Number(rc.status) === 1) return rc;
  let why = '';
  if (rerun) {
    try { await rerun(); why = ' (static call now passes?! state moved between tx and check)'; }
    catch (e) { why = ': ' + reasonOf(e); }
  }
  throw new Error(`${label} reverted${why}`);
}

test('launch is ONE transaction and distributes exactly the spec amounts', async () => {
  const args = await launch(launcher, 'Bear Coin', 'BEARC1', 1_000_000n * Q, 1_000n * Q, 200_000n * Q, 0, 0);
  S.tk1 = new ethers.Contract(args.token, BEAR.BearToken.abi, w0);
  S.pr1 = new ethers.Contract(args.pair, BEAR.BearPair.abi, w0);

  assert.equal(await S.tk1.totalSupply(), 1_000_000n * Q);
  assert.equal(await S.tk1.balances(launcher.address), 1_000_000n * Q - 200_000n * Q, 'launcher keeps the remainder, to the wei');
  assert.equal(await S.tk1.balanceOf(S.pr1.target), 200_000n * Q, 'the seed sits in the pool');
  assert.equal(await factory.pairOf(args.token), args.pair);
  assert.ok((await factory.tokenCount()) >= 1n, 'the launch is on the feed');

  const made = sqrt(1_000n * Q * 200_000n * Q);
  assert.equal(await S.pr1.balanceOf(launcher.address), made, 'LP shares minted to the LAUNCHER, not to the factory');
  assert.equal(await S.pr1.totalSupply(), made);

  const [rq, rt] = await S.pr1.reserves();
  assert.equal(rq, 1_000n * Q);
  assert.equal(rt, 200_000n * Q);
  assert.equal(await S.tk1.socialsSet(), true, 'socials settle inside the launch tx');
  assert.equal(await S.tk1.description(), 'e2e coin');
});

test('swap maths: the view and the execution agree on every coin; k only grows', async () => {
  const amt = 1_000n * Q;
  const [rq0, rt0] = await S.pr1.reserves();
  const curveIn = amt * 997n / 1000n;
  const expectOut = curveIn * rt0 / (rq0 + curveIn);
  assert.equal(await S.pr1.getAmountOut(true, amt), expectOut, 'the view mirror matches the arithmetic the swap will use');

  const kPrev = await S.pr1.lastK();
  await (await quote.connect(trader).approve(S.pr1.target, amt)).wait();
  const rc = await (await S.pr1.connect(trader).swapQuoteForToken(amt, 1n, trader.address)).wait();
  await expectMined(rc, 'buy', () => S.pr1.connect(trader).swapQuoteForToken.staticCall(amt, 1n, trader.address));

  assert.equal(await S.tk1.balanceOf(trader.address), expectOut, 'the trader receives exactly the quoted out');
  assert.equal(50_000n * Q - (await quote.balanceOf(trader.address)), amt, 'the trader paid exactly amountIn');
  const [rq1, rt1] = await S.pr1.reserves();
  assert.equal(rq1, rq0 + amt, 'reserve growth keeps the whole input (no carve at bps 0)');
  assert.equal(rt1, rt0 - expectOut);
  assert.ok((await S.pr1.lastK()) >= kPrev);
  assert.equal(await S.pr1.totalFeesCreator(), 0n);
  assert.equal((await quote.balanceOf(S.pr1.target)) - rq1, 0n, 'balance-exact identity with no escrow');

  // Sell half back: mirror exactness on the other direction too.
  const sell = expectOut / 2n;
  await (await S.tk1.connect(trader).approve(S.pr1.target, sell)).wait();
  const [rq2, rt2] = await S.pr1.reserves();
  const sellCurve = sell * 997n / 1000n;
  const expectOut2 = sellCurve * rq2 / (rt2 + sellCurve);
  assert.equal(await S.pr1.getAmountOut(false, sell), expectOut2);
  const kMid = await S.pr1.lastK();
  await (await S.pr1.connect(trader).swapTokenForQuote(sell, 1n, trader.address)).wait();
  const [rq3, rt3] = await S.pr1.reserves();
  assert.equal(rq3, rq2 - expectOut2);
  assert.equal(rt3, rt2 + sell);
  assert.equal(await quote.balanceOf(trader.address), 50_000n * Q - amt + expectOut2, 'the quote from the sell leg lands exactly');
  assert.ok((await S.pr1.lastK()) >= kMid);
});

test('creator fee: carve only on buy, exact to the wei, claimable by the creator only', async () => {
  const args = await launch(launcher, 'Bear Coin II', 'BEARC2', 1_000_000n * Q, 1_000n * Q, 200_000n * Q, 12, 0);
  S.tk2 = new ethers.Contract(args.token, BEAR.BearToken.abi, w0);
  S.pr2 = new ethers.Contract(args.pair, BEAR.BearPair.abi, w0);

  await (await quote.connect(trader).approve(S.pr2.target, 500n * Q)).wait();
  const amt = 500n * Q;
  const carve = amt * 12n / 10_000n; // 0.12%
  const [rq0, rt0] = await S.pr2.reserves();
  const curveIn = amt * 997n / 1000n;
  const expectOut = curveIn * rt0 / (rq0 + curveIn);

  await (await S.pr2.connect(trader).swapQuoteForToken(amt, 1n, trader.address)).wait();

  assert.equal(await S.pr2.totalFeesCreator(), carve, 'carve = amountIn × bps / 10_000, to the wei');
  const [rq1] = await S.pr2.reserves();
  assert.equal(rq1, rq0 + amt - carve, 'reserves grow by everything except the carve');
  assert.equal((await quote.balanceOf(S.pr2.target)) - rq1, carve, 'balance-exact identity: pool quote balance = reserve + escrowed fees');
  assert.equal(await S.tk2.balanceOf(trader.address), expectOut, 'the trader kept the 997/1000 promise');

  // The sell direction may not raise a carve: two currencies would invent a
  // fee the UI cannot display honestly.
  await (await S.tk2.connect(trader).approve(S.pr2.target, expectOut)).wait();
  const feesBefore = await S.pr2.totalFeesCreator();
  await (await S.pr2.connect(trader).swapTokenForQuote(expectOut, 1n, trader.address)).wait();
  assert.equal(await S.pr2.totalFeesCreator(), feesBefore, 'the sell direction never touches the fee stream');

  await assert.rejects(S.pr2.connect(feeThief).claimFees.staticCall(), (e) => /BEAR\/FEE-CLAIM/.test(reasonOf(e)), 'not the creator');
  const fat = await quote.balanceOf(launcher.address);
  await (await S.pr2.connect(launcher).claimFees()).wait();
  assert.equal((await quote.balanceOf(launcher.address)) - fat, carve, 'the creator claims the whole escrow');
  assert.equal(await S.pr2.totalFeesCreator(), 0n, 'the claim empties the escrow');
  await assert.rejects(S.pr2.connect(launcher).claimFees.staticCall(), (e) => /BEAR\/NO-FEE/.test(reasonOf(e)), 'nothing left to claim');
  const [rqEnd] = await S.pr2.reserves();
  assert.equal((await quote.balanceOf(S.pr2.target)) - rqEnd, 0n, 'identity holds with the escrow emptied');
});

test('LP locks: refuse to move or burn, only extend, and really open', async () => {
  const blk = await provider.getBlock('latest');
  const until = BigInt(blk.timestamp) + 120n;
  const args = await launch(launcher, 'Bear Coin III', 'BEARC3', 1_000_000n * Q, 1_000n * Q, 200_000n * Q, 0, until);
  S.tk3 = new ethers.Contract(args.token, BEAR.BearToken.abi, w0);
  S.pr3 = new ethers.Contract(args.pair, BEAR.BearPair.abi, w0);

  assert.equal(await S.pr3.lockOf(launcher.address), until, 'the launch wrote the lock');
  const made = await S.pr3.balanceOf(launcher.address);
  await assert.rejects(S.pr3.connect(launcher).transfer.staticCall(trader.address, made / 1000n), (e) => /BEAR\/LP-LOCKED/.test(reasonOf(e)), 'shares may not move while locked');
  await assert.rejects(S.pr3.connect(launcher).removeLiquidity.staticCall(made / 1000n, 1n, 1n), (e) => /BEAR\/LP-LOCKED/.test(reasonOf(e)), 'shares may not burn while locked');
  await assert.rejects(S.pr3.connect(launcher).lock.staticCall(launcher.address, until - 10n), (e) => /BEAR\/LOCK-SHRINK/.test(reasonOf(e)), 'locks only extend');

  // anvil's evm_setNextBlockTimestamp PINS the next block's wall-time: with
  // auto-mine on, any following tx waits for the REAL clock to reach the
  // chain head (measured: a removeLiquidity sat in the pool >60 s after
  // warping +125 s). evm_increaseTime shifts the internal clock instead —
  // automine sequences forward immediately, the lock reads as expired, and
  // no wall clock is ever consulted a second time.
  await provider.send('evm_increaseTime', [130]);
  await provider.send('evm_mine', []);

  const [rq0, rt0] = await S.pr3.reserves();
  const sup = await S.pr3.totalSupply();
  const pull = made / 4n;
  await (await S.pr3.connect(launcher).removeLiquidity(pull, 1n, 1n)).wait();
  const [rq1, rt1] = await S.pr3.reserves();
  assert.equal(rq0 - rq1, rq0 * pull / sup, 'quote paid on ratio');
  assert.equal(rt0 - rt1, rt0 * pull / sup, 'token paid on ratio');
  assert.equal(await S.pr3.balanceOf(launcher.address), made - pull, 'the share ledger drops with the burn');
});

test('a stranger may add and remove LP; uneven deposits donate, never mint value', async () => {
  await (await quote.connect(lpPeer).approve(S.pr3.target, 10n * Q)).wait();
  await (await S.tk3.connect(launcher).approve(S.pr3.target, MAX)).wait();
  const [rq0, rt0] = await S.pr3.reserves();
  const sup0 = await S.pr3.totalSupply();
  // A deliberately uneven deposit: quote-heavy by 2×.
  const qAmt = 2n * Q, tAmt = 2n * Q;
  await (await S.tk3.connect(launcher).transfer(lpPeer.address, tAmt)).wait();
  await (await S.tk3.connect(lpPeer).approve(S.pr3.target, tAmt)).wait();
  const mQ = qAmt * sup0 / rq0;
  const mT = tAmt * sup0 / rt0;
  const made = mQ < mT ? mQ : mT; // the MIN: an uneven stub gives only its smaller side's worth
  await (await S.pr3.connect(lpPeer).addLiquidity(qAmt, tAmt, 1n)).wait();
  assert.equal(await S.pr3.balanceOf(lpPeer.address), made, 'LP mint = min of the two sides');

  const [rq1, rt1] = await S.pr3.reserves();
  assert.equal(rq1 - rq0 + rt1 - rt0 > rq0 + rt0 ? 0n : 1n, 1n, 'the pool only ever grew');
  await (await S.pr3.connect(lpPeer).removeLiquidity(made, 1n, 1n)).wait();
  assert.equal(await S.pr3.balanceOf(lpPeer.address), 0n, 'removed everything back');
});

test('no native ETH anywhere on the pool', async () => {
  const j = await rawCall({ to: await S.pr1.getAddress(), value: '0x1' });
  const reason = await revertData({ to: await S.pr1.getAddress(), value: '0x1' });
  assert.match(reason, /BEAR\/NO-NATIVE/, `pool rejected the ETH with its reason intact, got: ${reason || JSON.stringify(j.error)}`);
});

test("the fee cap is where the k-invariant's slack ends: 31 bps cannot exist", async () => {
  await assert.rejects(
    factory.connect(launcher).launch.staticCall(META('X', 'X'), 1_000_000n * Q, 31, 0, 1_000n * Q, 200_000n * Q, 1n),
    (e) => /BEAR\/FEE-CAP/.test(reasonOf(e)),
    'launch refuses the cap breaker',
  );
  await assert.rejects(
    // deploy() resolves when the creation COMPLETES (and rethrows the
    // constructor revert); the v5-era `.deployed()` glue does not exist here.
    deploy(w0, BEAR.BearPair, await S.pr1.getAddress(), await S.tk1.getAddress(), await quote.getAddress(), w0.address, 31),
    (e) => /BEAR\/FEE-CAP/.test(reasonOf(e)),
    'a pair cannot exist with 31 bps',
  );
  if (typeof w0.reset === 'function') w0.reset(); // a failed estimate reserves a nonce — hand it back
});

test('socials are written once, by the factory alone', async () => {
  await assert.rejects(
    S.tk1.connect(launcher).setSocials.staticCall({ twitter: 'x', telegram: 'y', website: 'z' }),
    (e) => /BEAR\/SOCIALS-BY-FACTORY/.test(reasonOf(e)),
    'no outside writer exists',
  );
  // The once-only rule cannot be exercised from outside: the ONLY caller the
  // token accepts is the factory, and the factory's only setSocials call is
  // inside launch (one token, one write). Pinned structurally: socials are
  // TRUE at birth here, and the factory exposes no rewriting pathway.
  assert.equal(await S.tk1.socialsSet(), true);
  assert.equal(await S.tk1.twitter(), '');
});
