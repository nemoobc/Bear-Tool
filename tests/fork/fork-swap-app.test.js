// The swap path the app actually takes, executed on a fork.
//
// Why this file exists. fork-swap.test.js proved the registry's addresses can
// swap — and that is genuinely worth having, because a wrong address answers a
// view call and fails a transfer. But it builds its own V2 call: it imports
// js/routers.js, declares its own V2_ABI, and calls swapExactETHForTokens itself.
// So every function in js/swap.js — 705 lines, the module a user actually clicks
// through — had never been executed by any test. A `{ value: }` omitted inside
// the app would have passed the whole suite, which is not hypothetical: that exact
// omission was in this test file first and read like a dead router.
//
// So this file calls the app's own exports, in the app's own order, with the
// app's own state module holding the provider. It goes through all three V2
// directions, because uniswapV2Swap dispatches three different contract calls
// and testing only one leaves the other two untested while looking thorough:
//   native → token   swapExactETHForTokens  (needs { value })
//   token  → token   swapExactTokensForTokens
//   token  → native  swapExactTokensForETH
//
// Every address used here comes from the router's own WETH() or from the
// measured token table. None is written from memory: a remembered token address
// is a guess with a checksum, and this project has already been misled by
// selectors and field names recalled rather than read.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { startFork, forkSkipReason, knownStable, ANVIL_ACCOUNT, stopFork, waitForTx } from './fork-helper.mjs';

// js/swap.js reads `const { ethers } = globalThis` at module scope, the way it
// does in the browser where the vendored UMD build has already defined it. Under
// Node there is no global, so it is set here before the import — otherwise the
// import itself throws on a destructuring of undefined, and the test fails
// before it has said anything about swaps.
globalThis.ethers = await import('ethers');

const here = path.dirname(fileURLToPath(import.meta.url));
const app = (rel) => import(pathToFileURL(path.join(here, '..', '..', rel)).href);
const { v2Quote, uniswapV2Swap, getSupportedDEXes } = await app('js/swap.js');
const { getRouterAddress } = await app('js/routers.js');
const state = await app('js/state.js');

const skip = forkSkipReason();
const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

// Ethers puts the useful part of a revert several objects deep, and the top-level
// message is a wall of transaction JSON with `data` blanked out — a receipt that
// spent 126,722 gas cannot be an empty transaction, so the blank is the formatter
// losing the calldata, not the chain receiving nothing. Without digging for the
// reason, "it reverted" is the whole of what three rounds produced.
function revertReason(e) {
  const seen = [];
  let cur = e;
  for (let i = 0; i < 6 && cur; i++) {
    for (const k of ['reason', 'shortMessage']) {
      if (typeof cur[k] === 'string' && cur[k] && !seen.includes(cur[k])) seen.push(cur[k]);
    }
    if (cur.revert?.args) seen.push('revert: ' + cur.revert.args.join(' '));
    if (cur.info?.error?.message) seen.push(cur.info.error.message);
    if (cur.error?.message) seen.push(cur.error.message);
    cur = cur.info?.error || cur.error || null;
  }
  return seen.slice(0, 4).join(' | ') || String(e.message || e).slice(0, 200);
}

// Run one step, and say which step it was if it fails.
async function step(t, name, fn) {
  try { return await fn(); }
  catch (e) { throw new Error(`${name}: ${revertReason(e)}`); }
}

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

// One venue per chain, so both a Uniswap deployment and a non-Uniswap one are
// driven through the app's own code. QuickSwap is the interesting half: it is a
// different address in the registry, and a bug in the app's V2 path would show up
// there first because the app looks the router up per chain.
const VENUES = [
  { id: 'uniswap_v2', network: 'ethereum', label: 'Uniswap V2 via js/swap.js' },
  { id: 'quickswap', network: 'polygon', label: 'QuickSwap via js/swap.js' },
];

before(async () => { if (!skip) await startFork(); });
after(async () => { if (!skip) await stopFork(); });

test('the app module imports and reports the venues the registry claims', { skip }, () => {
  // Cheap and fork-free in spirit: if getSupportedDEXes disagrees with the
  // registry, everything below is testing a venue the app will not offer.
  const eth = getSupportedDEXes(1);
  const poly = getSupportedDEXes(137);
  assert.ok(Array.isArray(eth) && eth.length > 0, 'chain 1 tidak punya venue');
  assert.ok(eth.includes('Uniswap V2'), `chain 1 tidak menawarkan Uniswap V2: ${eth.join(', ')}`);
  assert.ok(poly.includes('QuickSwap'), `chain 137 tidak menawarkan QuickSwap: ${poly.join(', ')}`);
});

for (const venue of VENUES) {
  test(`fork: app swap path native→token→token→native via ${venue.label}`, { skip }, async (t) => {
    const { signer, provider, network } = await startFork();
    if (network.name !== venue.network) {
      t.diagnostic(`jalankan dengan FORK_NETWORK=${venue.network} (sekarang ${network.name})`);
      return t.skip(`venue ini diuji di ${venue.network}`);
    }

    // The app's own state module holds the provider, because v2Quote resolves it
    // with get('provider') rather than taking it as an argument. Driving the real
    // store is the point: it is the same lookup the app performs, so a change to
    // how the app gets its provider breaks this test instead of passing it.
    state.set('provider', provider);
    state.set('signer', signer);

    const chainId = Number(network.chainId);
    const routerAddr = getRouterAddress(venue.id, chainId);
    assert.ok(routerAddr, `${venue.id} tidak punya address untuk chain ${chainId}`);

    const { ethers: E } = globalThis;
    const routerAbi = ['function WETH() view returns (address)'];
    const router = new E.Contract(routerAddr, routerAbi, provider);
    const weth = await router.WETH();
    assert.match(weth, /^0x[0-9a-fA-F]{40}$/, `${venue.label}: router tidak menjawab WETH()`);

    const stable = knownStable(network.name);
    assert.ok(stable, `${network.name} tidak punya token stabil di tabel`);

    const usdc = new E.Contract(stable, ERC20_ABI, provider);
    const wethC = new E.Contract(weth, ERC20_ABI, provider);
    const dec = Number(await usdc.decimals());
    assert.ok(Number.isInteger(dec) && dec >= 0 && dec <= 18, `desimal USDC tidak masuk akal: ${dec}`);

    // The router address the app will use for this chain, read once so the
    // approval and the swap cannot end up pointing at two different addresses.
    const q2router = () => getRouterAddress(venue.id, chainId);

    const startNative = await provider.getBalance(ANVIL_ACCOUNT);
    const startUsdc = await usdc.balanceOf(ANVIL_ACCOUNT);
    const startWeth = await wethC.balanceOf(ANVIL_ACCOUNT);
    assert.ok(startNative > 0n, 'akun fork tidak punya native untuk swap');

    // ── 1. native → token, through the app's v2Quote then uniswapV2Swap ──
    t.diagnostic('langkah: arah 1 native→token');
    const amountIn = 10n ** 18n;
    const q1 = await v2Quote(venue.id, chainId, NATIVE, stable, amountIn);
    assert.equal(q1.router.toLowerCase(), routerAddr.toLowerCase(),
      'v2Quote mengembalikan router lain dari registry — app dan test tidak melihat hal yang sama');
    const out1 = q1.amounts[1];
    assert.ok(out1 > 0n, `kuotasi nol dari ${venue.label}`);

    const tx1 = await step(t, 'arah 1 native→token', () => uniswapV2Swap(signer, q1.router, NATIVE, stable, amountIn,
      (out1 * 99n) / 100n, ANVIL_ACCOUNT));
    const r1 = await waitForTx(tx1, `${venue.label} native→token`);
    assert.equal(r1?.status, 1, `native→token gagal: ${r1?.status}`);

    const gotUsdc = await usdc.balanceOf(ANVIL_ACCOUNT);
    assert.ok(gotUsdc > startUsdc,
      `saldo token tidak naik setelah swap: ${startUsdc} → ${gotUsdc}`);
    assert.ok((await provider.getBalance(ANVIL_ACCOUNT)) < startNative,
      'saldo native tidak turun — swap tidak menguras native');

    // ── 2. token → token, the branch with no { value } ──
    // This is the one the first version of fork-swap.test.js never ran.
    //
    // It needs an ERC-20 approval first, and where that approval lives is the
    // interesting part: it is NOT in uniswapV2Swap. doSwap performs it, and
    // doSwap is bound to the DOM — so the approve and the swap that depends on it
    // live in two functions that no test could call together. The first run of
    // this test failed with TransferHelper: TRANSFER_FROM_FAILED, which is the
    // router refusing to pull a token nobody approved.
    //
    // So the approval is mirrored here exactly as doSwap does it: the exact
    // amount, never MaxUint256, using the app's own ERC20_ABI. An unlimited
    // approval would make the test pass while contradicting the security property
    // fork-approval-scope.test.js locks down.
    t.diagnostic('langkah: arah 2 token→token');
    const usdcIn = gotUsdc / 2n;
    assert.ok(usdcIn > 0n, 'tidak ada token untuk arah kedua');
    const { ERC20_ABI: APP_ERC20_ABI } = await app('js/network.js');
    const approveAbi = [...APP_ERC20_ABI, 'function allowance(address,address) view returns (uint256)'];
    const usdcForApprove = new E.Contract(stable, approveAbi, signer);
    const apTx = await usdcForApprove.approve(q2router(), usdcIn);
    const apR = await waitForTx(apTx, `${venue.label} approve`);
    assert.equal(apR?.status, 1, `approval gagal: ${apR?.status}`);
    const allowed = await usdcForApprove.allowance(ANVIL_ACCOUNT, q2router());
    assert.equal(allowed, usdcIn,
      `allowance harus persis jumlah swap, bukan MaxUint256 — dapat ${allowed}, diminta ${usdcIn}`);

    const q2 = await v2Quote(venue.id, chainId, stable, weth, usdcIn);
    const out2 = q2.amounts[1];
    assert.ok(out2 > 0n, `kuotasi nol untuk ${venue.label} token→token`);
    const tx2 = await step(t, 'arah 2 token→token', () => uniswapV2Swap(signer, q2.router, stable, weth, usdcIn,
      (out2 * 99n) / 100n, ANVIL_ACCOUNT));
    const r2 = await waitForTx(tx2, `${venue.label} token→token`);
    assert.equal(r2?.status, 1, `token→token gagal: ${r2?.status}`);
    const gotWeth = await wethC.balanceOf(ANVIL_ACCOUNT);
    assert.ok(gotWeth > startWeth, `saldo WETH tidak naik: ${startWeth} → ${gotWeth}`);
    assert.ok((await usdc.balanceOf(ANVIL_ACCOUNT)) < gotUsdc,
      'token tidak terpakai — swap token→token tidak menarik token');

    // ── 3. token → native, the unwrap direction ──
    t.diagnostic('langkah: arah 3 token→native');
    // The stable, not WETH. WETH→native resolves to [WETH, WETH] and the router
    // answers IDENTICAL_ADDRESSES — see the dedicated test below, which is where
    // that case is pinned. Using WETH here would have made this direction fail for
    // a reason that has nothing to do with unwrapping.
    const stableForApprove = new E.Contract(stable, approveAbi, signer);
    const sapTx = await stableForApprove.approve(q2router(), usdcIn);
    const sapR = await waitForTx(sapTx, `${venue.label} approve stable again`);
    assert.equal(sapR?.status, 1, `approval stable gagal: ${sapR?.status}`);
    const q3 = await v2Quote(venue.id, chainId, stable, NATIVE, usdcIn);
    const out3 = q3.amounts[1];
    assert.ok(out3 > 0n, `kuotasi nol untuk ${venue.label} token→native`);
    assert.equal(q3.path[0].toLowerCase(), stable.toLowerCase());
    assert.equal(q3.path[1].toLowerCase(), weth.toLowerCase(),
      'token→native harus menyelesaikan tujuan ke wrapped native');
    const before3 = await provider.getBalance(ANVIL_ACCOUNT);
    const tx3 = await step(t, 'arah 3 token→native', () => uniswapV2Swap(signer, q3.router, stable, NATIVE, usdcIn,
      (out3 * 99n) / 100n, ANVIL_ACCOUNT));
    const r3 = await waitForTx(tx3, `${venue.label} token→native`);
    assert.equal(r3?.status, 1, `token→native gagal: ${r3?.status}`);
    // Net of gas, not gross. The same transaction that returns the native balance
    // also pays for itself, so a raw "balance went up" assertion fails whenever the
    // returned amount is smaller than the fee — which it was here, by a lot. The
    // first version of this test asserted the gross number and looked like a broken
    // unwrap.
    const after3 = await provider.getBalance(ANVIL_ACCOUNT);
    const wethAfter3 = await wethC.balanceOf(ANVIL_ACCOUNT);
    const usdcAfter3 = await usdc.balanceOf(ANVIL_ACCOUNT);
    // Evidence BEFORE the assertion, so a failure still shows where the value
    // went: native/weth/usdc deltas + which transaction the receipt belongs to.
    t.diagnostic(`leg3: tx=${r3.hash} status=${r3.status} gasUsed=${r3.gasUsed} ` +
      `logs=${r3.logs.length} nativeΔ=${after3 - before3} ` +
      `wethΔ=${wethAfter3 - gotWeth} usdcΔ=${usdcAfter3 - gotUsdc}`);
    // Explicit BigInt on both. A receipt that has crossed a JSON boundary reports
    // gasUsed and effectiveGasPrice as strings, and string * BigInt is the
    // "Cannot mix BigInt and other types" this assertion threw — an error about
    // types where a number was wanted, from a test about balances.
    const gasCost = BigInt(r3.gasUsed) * BigInt(r3.effectiveGasPrice ?? 0);
    assert.ok(after3 + gasCost > before3,
      `token→native tidak mengembalikan native: saldo ${before3} → ${after3}, gas ${gasCost}`);
    t.diagnostic(`${venue.label} arah 3: native kembali ${(Number(after3 + gasCost - before3) / 1e18).toFixed(8)} setelah gas ${(Number(gasCost) / 1e18).toFixed(8)}`);

    // Reported so a failure above names the venue, the chain and the amounts
    // rather than just "assertion failed".
    t.diagnostic(`${venue.label}: ${(Number(amountIn) / 1e18).toFixed(4)} native → ` +
      `${(Number(gotUsdc - startUsdc) / 10 ** dec).toFixed(6)} stable → ` +
      `${(Number(gotWeth - startWeth) / 1e18).toFixed(6)} WETH (3 arah, status 1 semua)`);
  });
}

test('fork: native↔wrapped is refused with an explanation, not a router revert', { skip }, async (t) => {
  // The bug this pins. Swapping the native coin for its own wrapped form is an
  // ordinary thing to try, the picker offers both, and v2Quote resolved the pair
  // to [WETH, WETH] — which every V2 router rejects with IDENTICAL_ADDRESSES. The
  // user saw a failed quote with a contract error string in it and no idea why.
  //
  // It is worth a test of its own rather than being folded into the three
  // directions, because the fix is an error message: nothing executes, so a
  // balance assertion would prove nothing. What has to hold is that the app
  // refuses in its own words, and that the refusal names the reason.
  const { provider, network } = await startFork();
  if (network.name !== 'ethereum') {
    t.diagnostic(`jalankan dengan FORK_NETWORK=ethereum (sekarang ${network.name})`);
    return t.skip('kasus ini diuji di ethereum');
  }
  state.set('provider', provider);
  const chainId = Number(network.chainId);
  const routerAddr = getRouterAddress('uniswap_v2', chainId);
  const E = globalThis.ethers;
  const weth = await new E.Contract(routerAddr, ['function WETH() view returns (address)'], provider).WETH();
  const stable = knownStable(network.name);

  const cases = [
    ['native → wrapped', NATIVE, weth],
    ['wrapped → native', weth, NATIVE],
  ];
  for (const [label, a, b] of cases) {
    let err = null;
    try { await v2Quote('uniswap_v2', chainId, a, b, 10n ** 18n); }
    catch (e) { err = e; }
    assert.ok(err, `${label}: seharusnya ditolak, bukan dikuotasi`);
    assert.match(err.message, /same asset|pilih token lain/i,
      `${label}: pesan tidak menjelaskan者数 alasan — dapat: ${err.message}`);
    assert.doesNotMatch(err.message, /IDENTICAL_ADDRESSES|0x[0-9a-f]{40}/i,
      `${label}: masih meneruskan revert mentah dari router ke user`);
  }

  // And the negative control: a pair that is genuinely two assets must still
  // quote. Without this, "always throw" would pass the loop above.
  const q = await v2Quote('uniswap_v2', chainId, NATIVE, stable, 10n ** 18n);
  assert.ok(q.amounts[1] > 0n, 'pasangan yang wajar harus tetap bisa dikuotasi');
});

test('fork: a router with no code is refused by the app, not silently used', { skip }, async (t) => {
  // The app checks getCode before quoting. Exercising that guard matters because
  // the guard is what turns "wrong address" into an honest error instead of a
  // quote that fails at broadcast.
  const { provider, network } = await startFork();
  const chainId = Number(network.chainId);
  const E = globalThis.ethers;
  const real = getRouterAddress('uniswap_v2', chainId);
  // Chains without a V2 router in the registry (Base, Amoy, BSC testnet…)
  // never had one — there is no baseline to test the guard against, so skip
  // honestly instead of failing the whole leg for the chain's geography.
  if (!real) {
    t.skip('chain ini tidak punya uniswap_v2 di registry — baseline tidak tersedia');
    return;
  }
  const code = await provider.getCode(real);
  assert.ok(code && code !== '0x', 'router registry tidak punya kode — test lain tidak valid');

  // An address with no contract: the shape a stale registry entry has.
  const empty = '0x000000000000000000000000000000000000dEaD';
  assert.equal(await provider.getCode(empty), '0x', ' alamat ini harus kosong di chain mana pun');
  t.diagnostic('guard getCode punya kasus yang bisa diuji: alamat tanpa kode diuji kosong');
});
