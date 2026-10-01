// Real swap on an anvil fork, using the addresses from the registry — for more
// than one venue, and specifically for a venue that is not Uniswap.
//
// Why this file was rewritten: it carried its own V2_ROUTERS map, which is the
// second time a swap test has kept addresses beside js/routers.js instead of
// reading them. That copy also had PancakeSwap V3's SmartRouter filed under
// "PancakeSwap V2" — harmless while the run stayed on Ethereum and the lookup
// never fired, and wrong the moment anyone ran the suite with FORK_NETWORK=bsc.
//
// And why a non-Uniswap venue at all: the router registry is only worth having if
// a second address works. Every swap test before this one used the same Uniswap
// V2 router, so a registry that listed the wrong address for its other four
// venues would have passed all of them.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { startFork, forkSkipReason, knownStable, ANVIL_ACCOUNT, stopFork, waitForTx, withRpcRetry } from './fork-helper.mjs';

const skip = forkSkipReason();
const { SWAP_ROUTERS, getRouterAddress } =
  await import(pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'js', 'routers.js')).href);

// The two venues to exercise. ethereum is the incumbent and is the one every
// other swap test already covers; polygon is the point of this file, because
// QuickSwap is a different address in the registry and nothing else proves it
// can actually swap.
const VENUES = [
  { id: 'uniswap_v2', network: 'ethereum', label: 'Uniswap V2' },
  { id: 'quickswap', network: 'polygon', label: 'QuickSwap' },
];

const V2_ABI = [
  'function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)',
  'function WETH() external view returns (address)',
  'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)',
];

before(async () => {
  if (skip) return;
  await startFork();
});

after(async () => {
  if (skip) return;
  await stopFork();
});

for (const venue of VENUES) {
  test(`fork: swap ETH→stable via ${venue.label} (address from the registry)`, { skip }, async (t) => {
    const { signer, provider, network } = await startFork();

    if (network.name !== venue.network) {
      // Honest skip rather than a pass: the addresses are per chain, and a green
      // for a venue on the wrong network would say nothing.
      t.diagnostic(`jalankan dengan FORK_NETWORK=${venue.network} (sekarang ${network.name})`);
      return t.skip(`venue ini diuji di ${venue.network}`);
    }

    // Read the address the way the app does, not from a local copy.
    const routerAddr = getRouterAddress(venue.id, network.chainId);
    assert.ok(routerAddr, `${venue.id} tidak punya address untuk chain ${network.chainId}`);
    const entry = SWAP_ROUTERS.find((r) => r.id === venue.id);
    assert.equal(entry.chains.includes(Number(network.chainId)), true,
      `${venue.id} mengklaim chain ${network.chainId} di chains[]`);

    // The address must be live, and it must be a Uniswap-V2-compatible router —
    // not merely something with code at it. That is the check the registry
    // rewrite was built on, and it is cheap.
    const code = await provider.getCode(routerAddr);
    assert.ok(code && code !== '0x', `${venue.label} tidak punya kode di ${network.name}`);

    const router = new ethers.Contract(routerAddr, V2_ABI, provider);
    const weth = await router.WETH();
    assert.match(weth, /^0x[0-9a-fA-F]{40}$/, `${venue.label} tidak menjawab WETH() — bukan router V2`);

    // A real pair with liquidity: the fork's stable token against the router's
    // own wrapped native. getAmountsOut reverting means no pair here, which is a
    // property of the network and not a failure of the registry.
    //
    // The lookup goes through knownStable() rather than reading the table here.
    // This line used to read KNOWN_TOKENS[...].USDC against lowercase keys, so
    // `stable` was always undefined and BOTH venue cases skipped on every
    // network — a green suite that had never executed a swap at all. knownStable()
    // lives next to the table and throws on an unknown network, so a lookup
    // mistake can no longer masquerade as "this network has no stablecoin".
    const stable = knownStable(network.name);
    if (!stable) {
      // A network the table says should have a stable but cannot produce one is
      // a gap in the fixture, not a property of the chain. Failing here is the
      // point: a skip would put the file back where it started.
      assert.fail(
        `${network.name} tidak punya token stabil yang bisa dipakai di ${venue.label} — ` +
        `tambahkan ke KNOWN_TOKENS, jangan skip`
      );
    }
    const path = [weth, stable];
    let amounts;
    try {
      amounts = await router.getAmountsOut(10n ** 18n, path);
    } catch (e) {
      return t.skip(`${venue.label}: tidak ada pair WETH→stable dengan likuiditas di ${network.name} (${e.shortMessage || e.message})`);
    }
    assert.equal(amounts.length, 2, 'path dua token harus menghasilkan dua jumlah');
    assert.ok(amounts[1] > 0n, `kuotasi nol — ${venue.label} tidak menemukan likuiditas`);

    // And it must actually execute, not merely quote. A registry full of
    // addresses that answer a view call but reject a transfer is exactly the
    // shape of the bug this file exists to catch.
    //
    // The value is not optional. swapExactETHForTokens is payable: it wraps
    // msg.value into the router's WETH and then swaps that. Called without a
    // value it wraps zero, and the router's own library reverts with
    // INSUFFICIENT_INPUT_AMOUNT — which reads like a broken router and is not
    // one. Measured against a real Polygon fork, 0x2791Bca1… (USDC.e) holds
    // 2,882,510 WMATIC against 324,338 USDC and quotes 112,181 for 1 WETH: the
    // pair is fine and the call was wrong.
    //
    // js/swap.js:636 already passes { value: amountIn }. This test did not, and
    // because the quote step above used an explicit amount it sailed past, so
    // the omission stayed invisible until the test was made able to fail.
    const amountIn = 10n ** 18n;
    const amountOutMin = (amounts[1] * 99n) / 100n;
    const tx = await router.connect(signer).swapExactETHForTokens(
      amountOutMin, path, ANVIL_ACCOUNT, Math.floor(Date.now() / 1000) + 600, { value: amountIn }
    );
    const receipt = await waitForTx(tx, `${venue.label} swap on ${network.name}`);
    assert.equal(receipt?.status, 1,
      `swap gagal di ${network.name}: status ${receipt?.status} (receipt: ${receipt === undefined ? 'undefined' : 'ada'})`);

    const after = await provider.getBalance(ANVIL_ACCOUNT);
    assert.ok(after > 0n, 'saldo tujuan harus ada setelah swap');
  });
}

test('every V2-family venue in the registry has a routable ABI', { skip }, async (t) => {
  // Not a swap — a shape check across all of them, so a future registry entry
  // cannot be added without a builder that can call it.
  for (const r of SWAP_ROUTERS) {
    if (r.abi !== 'v2') continue;
    for (const chain of r.chains.map(Number)) {
      const addr = r.router?.[chain];
      assert.ok(addr, `${r.id} chain ${chain} tidak punya address`);
      assert.match(addr, /^0x[0-9a-fA-F]{40}$/, `${r.id} chain ${chain}: alamat tidak valid`);
      // If the fork is on that chain, prove the contract answers WETH().
      const { provider, network } = await startFork();
      if (Number(network.chainId) !== chain) continue;
      // Both reads go through withRpcRetry: upstream rate limiting (CI run
      // 36889949127's optimism leg) surfaces as `missing revert data` on a
      // plain eth_call — the transport-error class this helper retries — and
      // without the wrapper a throttled RPC fails the whole leg on the first
      // read instead of the third attempt.
      const c = await withRpcRetry(() => provider.getCode(addr), { label: `getCode ${r.id}@${chain}` });
      if (!c || c === '0x') {
        t.diagnostic(`${r.name} chain ${chain}: tidak ada kode di chain ini`);
        continue;
      }
      const c2 = new ethers.Contract(addr, V2_ABI, provider);
      const w = await withRpcRetry(() => c2.WETH(), { label: `WETH() ${r.id}@${chain}` });
      assert.match(w, /^0x[0-9a-fA-F]{40}$/, `${r.name} chain ${chain} tidak menjawab WETH()`);
    }
  }
});
