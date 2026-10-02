// fork-health.mjs — state-health gate for an anvil fork.
// blockNumber answering proves NOTHING (stale/pruned forks still answer).
// This runs the exact operation tests need: estimateGas of a 1-wei send
// from anvil's funded account. Exit 0 = healthy, 1 = broken/pruned.
// Usage: node tests/fork/fork-health.mjs <port>
import { ethers } from 'ethers';

const port = process.argv[2];
if (!port) { console.error('usage: fork-health.mjs <port>'); process.exit(2); }

const TIMEOUT_MS = 20000;
const timer = setTimeout(() => { console.error('health probe timed out'); process.exit(1); }, TIMEOUT_MS);

try {
  // No 250ms response cache: test reads must see their own writes.
  const provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${port}`, undefined, { cacheTimeout: -1 });
  const wallet = new ethers.Wallet(
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    provider
  );
  // 1-wei send to the DEAD address, not anvil account 1. That dev account
  // carries an EIP-7702 delegation on several forked chains (sepolia: delegate
  // 0xca11…c11, the multicall3, with no payable fallback) — a 1-wei call with
  // empty calldata then REVERTS on chain state that is perfectly healthy, and
  // the gate answered "DOWN sepolia" four attempts running: in CI
  // 36983252072, and reproducible on the dev machine (estimateGas → code 3
  // "execution reverted", balance 10000 intact). The dead address has no code
  // on any chain, so a revert here now means what it says: this fork cannot
  // execute.
  await wallet.estimateGas({
    to: '0x000000000000000000000000000000000000dEaD',
    value: 1n,
  });
  // 2. Touch state that lives UPSTREAM of anvil's dev prefunds: resolving
  // account 1's code forces a fetch against the pinned block — the exact
  // operation a stale/pruned fork fails ("missing trie node") while still
  // answering blockNumber, which is the whole reason this gate exists. The
  // send to dEaD alone would pass on a fork whose upstream is already gone.
  await provider.getCode('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
  clearTimeout(timer);
  process.exit(0);
} catch (e) {
  console.error('unhealthy:', (e?.shortMessage || e?.message || String(e)).slice(0, 160));
  process.exit(1);
}
