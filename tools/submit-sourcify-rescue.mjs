// Submit the mainnet rescue contract to Sourcify v2 (keyless) and poll.
// Usage: node tools/submit-sourcify-rescue.mjs <address> <creationTxHash>
import fs from 'node:fs';
import path from 'node:path';

const ADDR = process.argv[2];
const TX = process.argv[3];
if (!/^0x[0-9a-fA-F]{40}$/.test(ADDR) || !/^0x[0-9a-fA-F]{64}$/.test(TX)) {
  console.error('usage: node tools/submit-sourcify-rescue.mjs <addr> <tx>');
  process.exit(2);
}
const SOLC_LONG = '0.8.37+commit.f401782d';
const tpl = fs.readFileSync(path.join(new URL('..', import.meta.url).pathname, 'js', 'eip7702-tools.js'), 'utf8');
const RESCUE = tpl.match(/const RESCUE_SOURCE = \`([\s\S]*?)\`;/)[1];

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
console.log('POST status:', res.status);
console.log('POST body:', JSON.stringify(body).slice(0, 400));

const verdict = (d) => {
  const st = d?.status ?? d?.verification?.status;
  if (st === 'perfect' || st === 'partial') return { ok: true, st };
  if (st && st.match === true) return { ok: true, st: st.status || 'match' };
  if (st === 'false' || st === 'failed' || st === 'not_matched') return { ok: false, st };
  return null;
};
let v = verdict(body);
for (let i = 0; i < 6 && !v; i++) {
  await sleep(8000);
  const ticket = body?.verificationId || body?.id;
  if (!ticket) break;
  const r = await fetch(`${SOURCIFY}/v2/verify/${ticket}`, { headers: { Accept: 'application/json' } });
  const d = await r.json().catch(() => ({}));
  console.log(`poll ${i + 1}: status=${r.status} ${JSON.stringify(d).slice(0, 260)}`);
  v = verdict(d);
}
console.log(v ? (v.ok ? `✅ VERIFIED (${v.st})` : `✖ NOT MATCHED (${v.st})`) : '⏳ no terminal verdict');
process.exit(v?.ok ? 0 : 1);
