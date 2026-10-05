// Bear Tool — token-list.test.js
// The curated coin list is a table of ADDRESSES a wallet will one day send
// funds to/through. A wrong character in an address is not a typo — it is a
// different contract or no contract at all. (Research 2026-10-05 found LI.FI's
// own Sepolia LINK entry off by one character: checksum failed, getCode=0x0.)
//
// So every entry in POPULAR_TOKENS is pinned here against the one property the
// app cannot check by itself at rest: EIP-55 checksum validity + sane decimals,
// plus the per-chain uniqueness the picker assumes when it keys rows by address.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';

const net = await import('../js/network.js');

test('every curated token address is EIP-55 checksum valid', () => {
  for (const [chainId, list] of Object.entries(net.POPULAR_TOKENS)) {
    for (const t of list) {
      assert.equal(t.address, ethers.getAddress(t.address),
        `chain ${chainId} ${t.symbol}: '${t.address}' is not a checksum-valid address`);
    }
  }
});

test('every curated token has sane decimals (1–18) and a symbol', () => {
  for (const [chainId, list] of Object.entries(net.POPULAR_TOKENS)) {
    for (const t of list) {
      assert.ok(Number.isInteger(t.decimals) && t.decimals >= 1 && t.decimals <= 18,
        `chain ${chainId} ${t.symbol}: decimals ${t.decimals} out of range`);
      assert.ok(t.symbol && typeof t.symbol === 'string',
        `chain ${chainId}: entry without a symbol`);
    }
  }
});

test('no chain lists the same address twice', () => {
  for (const [chainId, list] of Object.entries(net.POPULAR_TOKENS)) {
    const seen = new Set(list.map(t => t.address.toLowerCase()));
    assert.equal(seen.size, list.length, `chain ${chainId} has duplicate addresses`);
  }
});

test('a chain never offers two tokens with the same label', () => {
  // USDC.e reads on-chain as USDC — listing native USDC AND the .e bridge next
  // to each other shows two identical rows pointing at different contracts.
  for (const [chainId, list] of Object.entries(net.POPULAR_TOKENS)) {
    const labels = list.map(t => t.symbol.toLowerCase());
    assert.equal(new Set(labels).size, labels.length,
      `chain ${chainId} has duplicate labels: ${labels.join(', ')}`);
  }
});

test('every chainId in the list belongs to a network the wallet ships', () => {
  const known = new Set(net.NETWORKS.map(n => n.chainId));
  for (const chainId of Object.keys(net.POPULAR_TOKENS)) {
    assert.ok(known.has(Number(chainId)),
      `POPULAR_TOKENS[${chainId}] has no matching NETWORKS entry — a coin list for a chain the wallet cannot connect to`);
  }
});
