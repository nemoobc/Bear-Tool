// NFT detection — the gallery only scanned a curated mainnet list, so a
// wallet's own deployment (and every non-mainnet chain) could never appear:
// "deployed an NFT and it isn't detected". These tests pin the three
// detection sources (curated + registry + manual import), the bounded
// event-log fallback for non-enumerable collections, and an empty state that
// says how many contracts were actually scanned.
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';

globalThis.ethers = ethers;

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => readFileSync(path.join(root, p), 'utf8');

const { nftScanTargets, LOG_CHUNK, chunkBlockRange, decodeNftLog, scanEventTokenIds } =
  await import('../js/nft.js');

const OWNER = '0x1111111111111111111111111111111111111111';
const A1 = '0x2222222222222222222222222222222222222222';
const A2 = '0x3333333333333333333333333333333333333333';
const A3 = '0x4444444444444444444444444444444444444444';

test('scan targets: registry + imported contracts appear on ANY chain (erc721/erc1155 only)', () => {
  const registry = [
    { address: A1, chainId: 137, standard: 'erc721', name: 'My NFT' },
    { address: A2, chainId: 137, standard: 'erc1155', name: 'Multi' },
    { address: A3, chainId: 137, standard: 'erc20', name: 'Fungible' },
    { address: '0x5555555555555555555555555555555555555555', chainId: 1, standard: 'erc721', name: 'Wrong chain' },
  ];
  const imported = [{ address: A1.toLowerCase(), name: 'dup-of-registry' }];
  const targets = nftScanTargets(137, registry, imported);
  const addrs = targets.map((t) => t.address.toLowerCase());

  assert.ok(addrs.includes(A1.toLowerCase()), 'registry erc721 must be scanned');
  assert.ok(addrs.includes(A2.toLowerCase()), 'registry erc1155 must be scanned');
  assert.ok(!addrs.includes(A3.toLowerCase()), 'erc20 must NOT be scanned as an NFT');
  assert.ok(
    !addrs.includes('0x5555555555555555555555555555555555555555'),
    'entries from another chain must not leak in'
  );
  assert.strictEqual(
    addrs.filter((a) => a === A1.toLowerCase()).length,
    1,
    'same address from registry and import must dedupe to one scan'
  );
  const importedTarget = targets.find((t) => t.address.toLowerCase() === A1.toLowerCase());
  assert.strictEqual(importedTarget.source, 'imported', 'import entries keep an identifiable source');
});

test('scan targets: curated mainnet list still included on chain 1', () => {
  const targets = nftScanTargets(1, [], []);
  assert.ok(targets.length >= 4, 'the four curated mainnet collections remain');
  assert.ok(
    targets.some((t) => t.address === '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D'),
    'Bored Ape Yacht Club stays in the scan'
  );
});

test('log chunks stay under the 50000-block RPC ceiling and tile the range', () => {
  assert.ok(LOG_CHUNK < 50000, 'chunk size must sit under the -32701 range limit');
  const chunks = chunkBlockRange(0, 200000);
  assert.ok(chunks.length >= 5, 'range is split into several calls');
  for (const c of chunks) assert.ok(c.to - c.from + 1 <= LOG_CHUNK, `chunk ${JSON.stringify(c)} too wide`);
  assert.strictEqual(chunks[0].from, 0, 'first chunk starts at the requested block');
  assert.strictEqual(chunks.at(-1).to, 200000, 'last chunk reaches the requested block');
  for (let i = 1; i < chunks.length; i++) {
    assert.strictEqual(chunks[i].from, chunks[i - 1].to + 1, 'chunks are contiguous, no gaps or overlaps');
  }
});

test('event scan: bounded getLogs calls with the right Transfer filter and owner topic', async () => {
  const calls = [];
  const provider = {
    async getLogs(filter) {
      calls.push(filter);
      if (calls.length === 1) {
        // a fresh ERC-721 mint to the owner: tokenId indexed in topics[3]
        return [{
          topics: [
            ethers.id('Transfer(address,address,uint256)'),
            ethers.zeroPadValue('0x', 32),
            ethers.zeroPadValue(OWNER, 32),
            ethers.zeroPadValue('0x2a', 32),
          ],
          data: '0x',
        }];
      }
      return [];
    },
  };
  const latest = 1_000_000;
  const tokenIds = await scanEventTokenIds(provider, A1, OWNER, 'erc721', latest - 100_000, latest, {
    maxChunks: 3,
  });

  assert.strictEqual(calls.length, 3, 'maxChunks caps how many getLogs fire');
  assert.strictEqual(calls[0].toBlock, latest, 'scanning starts from the latest block (fresh deploys)');
  assert.strictEqual(calls[0].topics[0], ethers.id('Transfer(address,address,uint256)'), 'Transfer topic filter');
  assert.strictEqual(calls[0].topics[2], ethers.zeroPadValue(OWNER, 32), 'only logs TO the owner');
  for (const f of calls) {
    assert.ok(f.toBlock - f.fromBlock + 1 <= LOG_CHUNK, 'every request stays under the range ceiling');
  }
  assert.deepStrictEqual(tokenIds, ['42'], 'indexed tokenId decoded from topics');
});

test('log decode: erc721 reads the indexed topic, erc1155 reads data', () => {
  const log721 = {
    topics: [
      ethers.id('Transfer(address,address,uint256)'),
      ethers.zeroPadValue('0x', 32),
      ethers.zeroPadValue(OWNER, 32),
      ethers.zeroPadValue('0x7b', 32),
    ],
    data: '0x',
  };
  assert.strictEqual(decodeNftLog(log721, 'erc721'), '123');

  const log1155 = {
    topics: [
      ethers.id('TransferSingle(address,address,address,uint256,uint256)'),
      ethers.zeroPadValue('0x', 32),
      ethers.zeroPadValue(OWNER, 32),
      ethers.zeroPadValue(OWNER, 32),
    ],
    data: '', // replaced below with (value, id)
  };
  // ERC-1155 data = (uint256 value, uint256 id): id is the SECOND word
  log1155.data = ethers.concat([ethers.zeroPadValue('0x09', 32), ethers.zeroPadValue('0x05', 32)]);
  assert.strictEqual(decodeNftLog(log1155, 'erc1155'), '5');
});

test('loadNfts wires all three sources and the import control', () => {
  const nftJs = src('js/nft.js');
  const nftJsx = src('src/views/nft.jsx');
  assert.match(nftJs, /listDeployed\(\s*'token'/, 'registry-deployed tokens are scan targets');
  assert.match(nftJs, /nftImports/, 'manually imported collections persist in state');
  assert.match(nftJs, /nftScanTargets\(/, 'loadNfts goes through the merged target list');
  assert.match(nftJs, /scanEventTokenIds\(|event.*fallback/i, 'non-enumerable collections fall back to logs');
  assert.match(nftJsx, /id="nftImportAddr"/, 'import address input exists in the view');
  assert.match(nftJsx, /id="btnNftImport"/, 'import button exists in the view');
  assert.match(nftJs, /btnNftImport/, 'the import button is bound in nft.js');
});

test('empty state reports how many collections were scanned', () => {
  const nftJs = src('js/nft.js');
  assert.match(
    nftJs,
    /scanned/i,
    'the empty gallery must state that N collections were scanned — "no NFT" alone hides undetected contracts'
  );
  assert.match(nftJs, /NFT not found|holds no NFT/, 'keeps the honest not-found phrasing');
});
