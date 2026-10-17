// Submit an ALREADY-DEPLOYED contract to Sourcify v2 (keyless) and poll.
// Usage: node tools/submit-sourcify-rescue.mjs <address> <creationTxHash>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const out = (s) => process.stdout.write(s + '\n');

const ADDR = process.argv[2];
const TX = process.argv[3];
if (!/^0x[0-9a-fA-F]{40}$/.test(ADDR) || !/^0x[0-9a-fA-F]{64}$/.test(TX)) {
  console.error('usage: node tools/submit-sourcify-rescue.mjs <addr> <tx>');
  process.exit(2);
}
const SOLC_LONG = '0.8.37+commit.f401782d';
const here = path.dirname(fileURLToPath(import.meta.url));
const tpl = fs.readFileSync(path.join(here, '..', 'js', 'eip7702-tools.js'), 'utf8');
const RESCUE = tpl.match(/const RESCUE_SOURCE = `([\s\S]*?)`;/)[1];

const stdJsonInput = {
  language: 'Solidity',
  sources: { 'rescue.sol': { content: RESCUE } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  },
};

const SOURCIFY = 'https://sourcify.dev/server';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const res = await fetch(`${SOURCIFY}/v2/verify/1/${ADDR}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    stdJsonInput,
    compilerVersion: SOLC_LONG,
    contractIdentifier: 'rescue.sol:rescue',
    creationTransactionHash: TX,
  }),
});
const body = await res.json().catch(() => ({}));
out(`POST status: ${res.status}`);
out(`POST body: ${JSON.stringify(body).slice(0, 400)}`);

const verdict = (d) => {
  if (d?.contract?.match === 'exact_match') return { ok: true, st: 'exact_match' };
  if (d?.contract?.match === 'partial_match') return { ok: true, st: 'partial_match' };
  return null;
};
let v = verdict(body);
const ticket = body?.verificationId || body?.id;
for (let i = 0; i < 8 && !v && ticket; i++) {
  await sleep(8000);
  const r = await fetch(`${SOURCIFY}/v2/verify/${ticket}`, { headers: { Accept: 'application/json' } });
  const d = await r.json().catch(() => ({}));
  out(`poll ${i + 1}: isJobCompleted=${d?.isJobCompleted}`);
  v = verdict(d);
}
out(v ? (v.ok ? `✅ VERIFIED (${v.st}) — sourcify /v2/contract/1/${ADDR}` : `✖ NOT MATCHED (${v.st})`) : 'check: ' + (ticket ? `GET ${SOURCIFY}/v2/verify/${ticket}` : 'no ticket'));
process.exit(v?.ok ? 0 : 1);
