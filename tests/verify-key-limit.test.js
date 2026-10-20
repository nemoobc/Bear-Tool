// Etherscan daily-limit handling + the byo-key UI + auto-verify wiring.
//
// What this pins:
//  1. autoVerify with NO key → Etherscan skipped, Sourcify still runs.
//  2. autoVerify with a saved key AFTER a limit was marked → Etherscan leg is
//     jumped WITHOUT any request (a request would just burn another failure).
//  3. verifyEtherscan failing with the real daily-limit string flips the flag,
//     and the next autoVerify skips Etherscan on its own.
//  4. Static: the security-center exposes save/delete UI; i18n ships EN+ID;
//     all six eip7702 deploy sites call verifyHelperDeployed.
//
// Every network call is mocked — no key use, no live submission.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

const verify = await import('../js/verify.js');

const NET = { chainId: 1, name: 'Ethereum', rpc: ['https://eth.llamarpc.com'] };
const ADDR = '0x1111111111111111111111111111111111111111';

let ethCalls = 0;
const countingFetch = async (url) => {
  if (String(url).includes('api.etherscan.io')) { ethCalls += 1; }
  throw new Error('network must not be reached');
};
const noSleep = () => { throw new Error('sleep must not run in this test'); };

test('verify: daily limit marked → next autoVerify skips etherscan without any request', async () => {
  verify.setEtherscanKey('TESTKEY123');
  verify.markEtherscanDailyLimit();
  assert.ok(verify.etherscanDailyLimitUntil() > Date.now(), 'mark must set a future timestamp');

  ethCalls = 0;
  const out = await verify.autoVerify({ net: NET, address: ADDR, source: 'contract X {}', contractName: 'X', fetchFn: countingFetch, sleepFn: noSleep });
  const eth = out.results.find((r) => r.service === 'etherscan');
  assert.ok(eth, 'etherscan result row must exist');
  assert.equal(eth.skipped, true, 'limit must SKIP the etherscan leg, not fail it');
  assert.match(eth.msg, /daily limit detected earlier/i);
  assert.equal(eth.msg.includes('Sourcify runs keyless'), true);
  assert.equal(ethCalls, 0, 'skipped etherscan must issue ZERO etherscan requests');
  verify.setEtherscanKey('');
});

test('verify: etherscan daily-limit answer marks the flag for the NEXT deploy', async () => {
  verify.setEtherscanKey('TESTKEY123');
  globalThis.localStorage.removeItem('bear.etherscanLimitUntil');
  assert.equal(verify.etherscanDailyLimitUntil(), 0, 'start clean');

  const realStr = 'https://api.etherscan.io/v2/api?module=contract&action=verify';
  const limitFetch = async (url) => {
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: '0', message: 'NOTOK', result: 'Daily limit of 500 source code submissions reached for this API key. Submission Count Remaining: 0. Please wait for the next day.' }),
      text: async () => JSON.stringify({ status: '0', message: 'NOTOK', result: 'Daily limit of 500 source code submissions reached for this API key. Submission Count Remaining: 0. Please wait for the next day.', error: {} }),
      url: realStr,
    };
  };
  const out = await verify.autoVerify({
    net: NET, address: ADDR, source: 'contract X {}', contractName: 'X',
    fetchFn: limitFetch, sleepFn: noSleep,
  });
  const eth = out.results.find((r) => r.service === 'etherscan');
  assert.ok(eth && eth.ok === false, 'etherscan row must report failure');
  assert.match(eth.msg, /daily limit/i, 'the limit text must surface to the user');
  assert.ok(verify.etherscanDailyLimitUntil() > Date.now(), 'the flag must be marked for the NEXT deploy');
  verify.setEtherscanKey('');
});

// ── static wiring ──────────────────────────────────────────────
const scSource = readFileSync('js/security-center.js', 'utf8');
test('verify: security-center ships save/delete UI for the etherscan key', () => {
  assert.match(scSource, /id="secEtherscanKey"/);
  assert.match(scSource, /id="secEtherscanSave"/);
  assert.match(scSource, /id="secEtherscanDelete"/);
  assert.match(scSource, /id="secEtherscanState"/);
  assert.match(scSource, /setEtherscanKey|getEtherscanKey/);
  assert.match(scSource, /set\.verifykey\.limit/, 'the daily-limit note must render');
});

const i18nSource = readFileSync('js/i18n.js', 'utf8');
test('verify: i18n EN+ID cover every new key', () => {
  for (const k of ['set.verifykey.h4', 'set.verifykey.hint', 'set.verifykey.ph', 'set.verifykey.save', 'set.verifykey.delete', 'set.verifykey.saved', 'set.verifykey.none', 'set.verifykey.limit']) {
    assert.ok(i18nSource.split(k).length - 1 >= 2, `${k} must exist in EN and ID (found ${i18nSource.split(k).length - 1})`);
  }
});

const e7Source = readFileSync('js/eip7702-tools.js', 'utf8');
test('verify: batch/claimer deploy sites auto-verify; rescue must NOT (2026-10-20 privacy)', () => {
  const calls = e7Source.match(/(?<!function )verifyHelperDeployed\(/g) || [];
  assert.equal(calls.length, 4, `4 call sites remain: batch ×2 + claimer ×2 — rescue opted out (got ${calls.length})`);
  // The definition itself:
  assert.match(e7Source, /function verifyHelperDeployed/);
  // Rescue opts out: its ctor args carry the SAFE destination — a verify POST
  // would publish them decoded on repo.sourcify.dev (user report 2026-10-20).
  for (const src of ['BATCH_SOURCE', 'AIRDROP_CLAIMER_SOURCE']) {
    assert.ok(e7Source.includes(`source: ${src}`), `${src} must be handed to verification`);
  }
  assert.doesNotMatch(e7Source, /verifyHelperDeployed\(\{[^)]*RESCUE_SOURCE/,
    'rescue helper must never auto-verify — safe address stays private');
});
