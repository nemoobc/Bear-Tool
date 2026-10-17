// Verify an ALREADY-DEPLOYED mainnet contract offline: identify the repo
// source that reproduces it, by dispatcher selector + deployed-bytecode compare.
// Usage: node tools/verify-mainnet-rescue.mjs <address> <creationTxHash>
// Output = process.stdout (CLI tool, not app code).
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const out = (s) => process.stdout.write(s + '\n');

const ADDR = (process.argv[2] || '').trim();
const TX = (process.argv[3] || '').trim();
if (!/^0x[0-9a-fA-F]{40}$/.test(ADDR) || !/^0x[0-9a-fA-F]{64}$/.test(TX)) {
  console.error('usage: node tools/verify-mainnet-rescue.mjs <address> <creationTxHash>');
  process.exit(2);
}

const RPCS = ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org'];
const here = path.dirname(fileURLToPath(import.meta.url));
const tpl = fs.readFileSync(path.join(here, '..', 'js', 'eip7702-tools.js'), 'utf8');
const extractSource = (name) => {
  const m = tpl.match(new RegExp(`const ${name} = \\\`([\\s\\S]*?)\\\`;`));
  if (!m) throw new Error(`${name} not found in eip7702-tools.js`);
  return m[1];
};
const RESCUE = extractSource('RESCUE_SOURCE');

async function rpc(method, params) {
  let last;
  for (const url of RPCS) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const j = await r.json();
      if (j && j.result !== undefined) return j.result;
      last = new Error(JSON.stringify(j).slice(0, 120));
    } catch (e) { last = e; }
  }
  throw last;
}
const code = await rpc('eth_getCode', [ADDR, 'latest']);
const runtime = code.replace(/^0x/, '');
out(`onchain runtime: ${runtime.length / 2} bytes`);

// CBOR metadata tail (solidity ≥0.8.2): last 2 bytes = big-endian length.
const buf = Buffer.from(runtime, 'hex');
const dlen = buf.readUInt16BE(buf.length - 2);
const rawMeta = buf.subarray(buf.length - 2 - dlen, buf.length - 2);
const ver = (rawMeta.toString('latin1').match(/[0-9]+\.[0-9]+\.[0-9]+\+commit\.[0-9a-f]+/) || [])[0];
out(`metadata tail: ${dlen} bytes, compiler:${ver || ' (tidak tertulis — pakai repo SOLC)'}`);
const metaDump = path.join(here, '..', 'vendor', 'last-meta.cbor');
fs.writeFileSync(metaDump, rawMeta);
out(`metadata blob: ${metaDump}`);

// Dispatcher selectors on chain — the identity fingerprint.
const onchainSel = [...runtime.matchAll(/8063([0-9a-f]{8})/g)].map((m) => m[1]);
out(`onchain selectors: ${onchainSel.join(', ')}`);

// Compile the repo source with the vendored solc (same loader as
// tests/deploy-contracts.test.js BEAR_SOLC part).
const SOLC_FILE = path.join(here, '..', 'vendor', 'soljson-0.8.37.js');
const sandbox = { console, setTimeout, clearTimeout, process, Buffer, __dirname: '.', module: {}, exports: {} };
sandbox.global = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(SOLC_FILE, 'utf8'), sandbox, { filename: 'soljson-0.8.37.js' });
await new Promise((resolve, reject) => {
  const t0 = Date.now();
  const iv = setInterval(() => {
    if (typeof sandbox.Module?.cwrap === 'function') { clearInterval(iv); resolve(); }
    else if (Date.now() - t0 > 120000) { clearInterval(iv); reject(new Error('solc runtime never became ready')); }
  }, 100);
});
const raw = sandbox.Module.cwrap('solidity_compile', 'string', ['string', 'number']);

function compileWith(name, source, opts) {
  const input = {
    language: 'Solidity',
    sources: { [`${name}.sol`]: { content: source } },
    settings: {
      optimizer: { enabled: !!opts.optimizer, runs: opts.runs || 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.deployedBytecode.object'] } },
    },
  };
  const compiled = JSON.parse(raw(JSON.stringify(input), 1));
  const errs = (compiled.errors || []).filter((e) => e.severity === 'error');
  if (errs.length) throw new Error(`compile ${name}: ${errs[0].formattedMessage.slice(0, 200)}`);
  return compiled.contracts?.[`${name}.sol`]?.[name];
}

let verdict = null;
for (const opts of [{ optimizer: true, runs: 200 }, { optimizer: false }]) {
  const c = compileWith('rescue', RESCUE, opts);
  const deployed = (c.evm?.deployedBytecode?.object || '').replace(/^0x/, '');
  let i = 0;
  while (i < deployed.length && i < runtime.length && deployed[i] === runtime[i]) i++;
  const prefix = Math.floor(i / 2);
  const sizeEq = deployed.length / 2 === runtime.length / 2;
  out(`rescue optimizer=${opts.optimizer} → deployed ${deployed.length / 2} B, prefix sama ${prefix} B, ukuran sama: ${sizeEq}`);
  if (sizeEq) { verdict = opts; break; }
}
out(verdict
  ? `✅ IDENTITY: repo RESCUE_SOURCE reproduces ${ADDR} (optimizer=${verdict.optimizer}${verdict.runs ? ' runs=' + verdict.runs : ''}) — modul immutables.`
  : '✖ no repo template matched the deployed bytecode');
process.exit(verdict ? 0 : 1);
