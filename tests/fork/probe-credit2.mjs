// Probe #2 — where does an ETH credit to a PREFUNDED dev account ever show up?
// (leg3 CI shape: router pays ANVIL_ACCOUNT inside a swap tx; balance reads
// show before − gas exactly, credit missing.) Tries, in order:
//   r1 immediate read    r2 poll 30s    r3 anvil_mine 1 + poll
//   r4 noop tx + poll    r5 anvil_mine 10 + poll
// Plus controls: credit to a FRESH random address, credit to dev account #2.
import { spawn } from 'node:child_process';

const { ethers } = await import('ethers');
globalThis.ethers = ethers;
const fh = await import('./fork-helper.mjs');
const { provider, signer } = await fh.startFork();
const A = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const B = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const log = (s) => console.log(`[P2] ${s}`);
const w = async (txp) => (await txp).wait();
const gasCost = (r) => BigInt(r.gasUsed) * BigInt(r.gasPrice);

const P_SRC = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
contract Pay { function pay(address to) external { (bool ok,) = to.call{value: address(this).balance}(""); require(ok, "x"); } receive() external payable {} }`;
const { abi, bytecode } = await fh.compileSource(P_SRC, 'Pay');
const pay = await new ethers.ContractFactory(abi, bytecode, signer).deploy();
await pay.waitForDeployment();
const payAddr = await pay.getAddress();

async function fundAndPay(label, recipient) {
  await w(signer.sendTransaction({ to: payAddr, value: 10n ** 18n }));
  const before = await provider.getBalance(recipient);
  const r = await w(pay.pay(recipient));
  const gas = gasCost(r);
  // When the recipient IS the tx sender it also pays the gas; everyone else
  // receives the full credit.
  const senderPays = recipient.toLowerCase() === A.toLowerCase();
  const expect = before + 10n ** 18n - (senderPays ? gas : 0n);
  log(`${label}: recipient=${recipient.slice(0, 10)}… before=${before} gas=${gas}`);
  const show = async (stage) => {
    const v = await provider.getBalance(recipient);
    // recipient pays no gas here (the contract call pays), so want = before + 1 ETH
    log(`  ${stage}: bal=${v} ${v === expect ? 'CREDIT OK' : `missing ${expect - v}`}`);
    return v === expect;
  };
  if (await show('r1 immediate')) return;
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) { await new Promise((x) => setTimeout(x, 500)); if (await show(`r2 poll +${((Date.now() - t0) / 1000).toFixed(1)}s`)) return; }
  try { await provider.send('anvil_mine', ['0x1']); } catch {}
  const t1 = Date.now();
  while (Date.now() - t1 < 5000) { await new Promise((x) => setTimeout(x, 500)); if (await show('r3 after mine+poll')) return; }
  // noop tx from A (advances state through a real tx)
  try {
    const c = ethers.Wallet.createRandom().address;
    await w(signer.sendTransaction({ to: c, value: 1n }));
  } catch (e) { log(`  noop tx failed: ${e.message}`); }
  const t2 = Date.now();
  while (Date.now() - t2 < 5000) { await new Promise((x) => setTimeout(x, 500)); if (await show('r4 after noop+poll')) return; }
  try { await provider.send('anvil_mine', ['0xa']); } catch {}
  const t3 = Date.now();
  while (Date.now() - t3 < 5000) { await new Promise((x) => setTimeout(x, 500)); if (await show('r5 after mine10+poll')) return; }
  log(`  ${label}: CREDIT NEVER APPEARED`);
}

await fundAndPay('case-A(prefunded)', A);
await fundAndPay('case-B(prefunded dev2)', B);
await fundAndPay('case-FRESH', ethers.Wallet.createRandom().address);

await fh.stopFork();
process.exit(0);
