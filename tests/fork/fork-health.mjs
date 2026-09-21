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
  const provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${port}`);
  const wallet = new ethers.Wallet(
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    provider
  );
  await wallet.estimateGas({
    to: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    value: 1n,
  });
  clearTimeout(timer);
  process.exit(0);
} catch (e) {
  console.error('unhealthy:', (e?.shortMessage || e?.message || String(e)).slice(0, 160));
  process.exit(1);
}
