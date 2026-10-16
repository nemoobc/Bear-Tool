// Bear Tool — tests/dex-r9r6.test.js
// Unit pins for R9 (launch 2.0: socials + atomic dev buy + anti-sniper
// explainer) and R6 ("My fees": the creator slice, claim, claim-all).
//
// The contract side is proven end-to-end in tests/dex-v2-onchain-e2e.mjs;
// these tests pin the JS policy that must hold WITHOUT a chain: what counts
// as a social link, how bps render, which pools deserve a fee card, and that
// every surface that names the fee reads it from the pair.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

// ── R9: the socials link policy ────────────────────────────────
test('a social becomes a link ONLY when it looks like a URL', async () => {
  const { socialHref } = await import('../js/dex/token-page.js');
  assert.equal(socialHref('https://x.com/bearmoon'), 'https://x.com/bearmoon');
  assert.equal(socialHref('http://t.me/bearmoon'), 'http://t.me/bearmoon');
  assert.equal(socialHref('x.com/bearmoon'), 'https://x.com/bearmoon', 'a bare domain is still a domain');
  assert.equal(socialHref('bearmoon.test/roadmap'), 'https://bearmoon.test/roadmap');
  assert.equal(socialHref('x.com/bearmoon?ref=1'), 'https://x.com/bearmoon?ref=1');
  assert.equal(socialHref('join our telegram'), '', 'prose is prose, never a clickable lie');
  assert.equal(socialHref('javascript:alert(1)'), '', 'no scheme games');
  assert.equal(socialHref('data:text/html,hi'), '', 'no data URIs');
  assert.equal(socialHref(''), '');
  assert.equal(socialHref(null), '');
});

test('the token page paints socials into the dedicated slot, escaped', async () => {
  const page = read('js/dex/token-page.js');
  assert.match(page, /id="dexTpSocials"/, 'the token header must carry the socials slot');
  assert.match(page, /paintSocials\(el\('dexTpSocials'\)/, 'the slot is painted from the read');
  assert.match(page, /tc\.twitter\(\)\.catch\(\(\) => ''\)/, 'twitter comes from the token contract, honestly');
  assert.match(page, /escapeHtml\(v\)/, 'the stored text is escaped — it is user input, not markup');
  assert.match(page, /target="_blank" rel="noopener noreferrer"/, 'outbound links open safely');
});

// ── R6: display math that must round the same way everywhere ───
test('pctOfBps renders the trade percent with trailing zeros trimmed', async () => {
  const { pctOfBps } = await import('../js/dex/core.js');
  assert.equal(pctOfBps(0), '0%');
  assert.equal(pctOfBps(10), '0.1%');
  assert.equal(pctOfBps(15), '0.15%');
  assert.equal(pctOfBps(30), '0.3%');
  assert.equal(pctOfBps(-5), '0%', 'a nonsense negative is never shown');
  assert.equal(pctOfBps(NaN), '0%');
});

test('fee chips flip on the pair\'s own bps; 0 keeps the original claim', async () => {
  const { securityChips } = await import('../js/dex/token-page.js');
  const off = securityChips({ hasLaunch: false, feeBps: 0 });
  assert.deepEqual(off.map((c) => c.key), ['dex.sec.fee', 'dex.sec.noOwner'],
    'slice off = the pool claim, exactly as before');
  const on = securityChips({ hasLaunch: false, feeBps: 15 });
  assert.equal(on[0].key, 'dex.sec.feeCreator');
  assert.equal(on[0].params.p, '0.15%');
  assert.equal(on[0].tone, 'dex-badge-safe', 'a fixed, verifiable slice is still a calm fact');
  const readFails = securityChips({ hasLaunch: true, untilSec: 0, ageSec: null, feeBps: 0 });
  assert.ok(readFails.some((c) => c.key === 'dex.sec.fee'), 'unreadable fee = the base formula claim');
});

test('the chip copy fills its placeholders in both languages', async () => {
  const { t } = await import('../js/i18n.js');
  const en = t('dex.sec.feeCreator', { p: '0.1%' });
  assert.ok(en.includes('0.1%') && !en.includes('{{'), `unfilled feeCreator chip: ${en}`);
  const dev = t('dex.launch.devBuy', { q: 'ETH' });
  assert.ok(dev.includes('ETH') && !dev.includes('{{'), `unfilled devBuy label: ${dev}`);
  const prev = t('dex.launch.previewDev', { v: '0.5', q: 'ETH' });
  assert.ok(prev.includes('0.5') && prev.includes('ETH') && !prev.includes('{{'), `unfilled previewDev: ${prev}`);
  const rate = t('dex.pf.fees.rate', { p: '0.15%' });
  assert.ok(rate.includes('0.15%') && !rate.includes('{{'), `unfilled rate: ${rate}`);
});

// ── R6: which pools deserve a card, and what may be summed ─────
test('mineFeeRows keeps only readable, mine, slice-on pools', async () => {
  const { mineFeeRows } = await import('../js/dex/portfolio.js');
  const rows = [
    { ok: true, mine: true, bps: 15, accrued: 1n },
    { ok: true, mine: true, bps: 0, accrued: 0n },   // slice off — no card
    { ok: true, mine: false, bps: 10, accrued: 9n }, // not mine — no card
    { ok: false, mine: true, bps: 30, accrued: 9n }, // read failed — no card
    { ok: true, mine: true, bps: 10, accrued: 0n },  // mine + slice on, nothing accrued yet — card stays
  ];
  assert.deepEqual(mineFeeRows(rows).map((x) => x.bps), [15, 10]);
  assert.deepEqual(mineFeeRows(null), []);
});

test('sumClaimed decodes amounts and skips logs it cannot read', async () => {
  const { sumClaimed } = await import('../js/dex/portfolio.js');
  const { ethers } = await import('ethers');
  const enc = (v) => ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [v]);
  const sum = sumClaimed(ethers, [
    { data: enc(123n) },
    { data: enc(7n) },
    { data: '0xdeadbeef' }, // undecodable: skipped, never guessed
  ]);
  assert.equal(sum, 130n);
  assert.equal(sumClaimed(ethers, []), 0n);
  assert.equal(sumClaimed(ethers, null), 0n);
});

test('the Portfolio ships the fee section and reads it from the chain', async () => {
  const { portfolioHtml } = await import('../js/dex/portfolio.js');
  assert.ok(portfolioHtml().includes('id="dexPfFees"'), 'the fees section has its own slot');
  const src = read('js/dex/portfolio.js');
  assert.match(src, /discoverPools\(\{ scope: 'mine', creator: me/, 'the section reads MY launches from discovery');
  assert.match(src, /creatorFeeBps\(\)/, 'the slice is read from the pair');
  assert.match(src, /totalFeesCreator\(\)/, 'the accrued number is read from the pair, never remembered');
  assert.match(src, /claimFees\(\)/, 'claiming goes through the contract');
  assert.match(src, /data-fees-all/, 'Claim all exists');
  assert.match(src, /new E\.Contract\(x\.r\.pair, BEAR_PAIR_ABI, provider\(\)\)\.totalFeesCreator\(\)/, 'after a claim the pair is re-read — the chain says what remains');
});

// ── R9: the wizard carries the new fields into launch() ────────
test('the launch wizard ships socials, the fee picker, the dev buy and the explainer', async () => {
  const { launchHtml } = await import('../js/dex/launch.js');
  const html = launchHtml();
  for (const id of ['dexCreateTwitter', 'dexCreateTelegram', 'dexCreateWebsite',
    'dexLaunchFee', 'dexLaunchDevBuy', 'dexLaunchEdu', 'dexLaunchFeeWhy']) {
    assert.ok(html.includes(`id="${id}"`), `wizard must ship #${id}`);
  }
  assert.match(html, /<option value="0">/, 'fee: Off is offered');
  assert.match(html, /<option value="10" selected>/, 'fee: the third-of-fee option is the default');
  assert.match(html, /<option value="15">/, 'fee: half-of-fee is offered');
  const src = read('js/dex/launch.js');
  assert.match(src, /twitter, telegram, website,/, 'socials ride the launchTx call');
  assert.match(src, /creatorFeeBps,/, 'the fee choice rides the launchTx call');
  assert.match(src, /devBuyQuote: devBuy && devBuy\.ok/, 'the dev buy rides the same call');
  assert.match(src, /openEdu\('sniper'\)/, 'the explainer opens the sniper topic');
  assert.match(src, /\[name, symbol, image, description, twitter, telegram, website\]/, 'launchTx passes the 7-string meta tuple');
});

// ── the contract surface the JS reads and signs ────────────────
test('bear-source ships the R9/R6 ABI and the fee rules the UI relies on', async () => {
  const m = await import('../js/dex/bear-source.js');
  assert.match(m.BEAR_FACTORY_ABI.join('\n'),
    /launch\(\(string,string,string,string,string,string,string\), uint256, address, uint256, uint256, uint256, uint256, uint256\)/,
    'factory.launch takes the 7-string meta + fee + dev buy');
  const pairAbi = m.BEAR_PAIR_ABI.join('\n');
  for (const frag of ['creator()', 'creatorFeeBps()', 'totalFeesCreator()', 'devBuy(address, uint256)', 'claimFees()', 'FeesClaimed(']) {
    assert.ok(pairAbi.includes(frag), `pair ABI must carry ${frag}`);
  }
  const tokenAbi = m.BEAR_TOKEN_ABI.join('\n');
  for (const frag of ['twitter()', 'telegram()', 'website()']) {
    assert.ok(tokenAbi.includes(frag), `token ABI must carry ${frag}`);
  }
  const src = m.BEAR_SOURCE;
  assert.match(src, /require\(creatorFeeBps_ <= 30, "fee"\)/, 'the fee cap is enforced in the pair constructor');
  assert.match(src, /require\(msg\.sender == factory, "factory"\)/, 'devBuy is factory-only');
  assert.match(src, /require\(msg\.sender == creator, "creator"\)/, 'claimFees is creator-only');
  assert.match(src, /quote\.balanceOf\(address\(this\)\) - totalFeesCreator/, 'reserves() excludes the creator dues');
  assert.match(src, /amountIn \* 997/, 'the trader math is the same 997/1000 as pool-math.js');
  assert.match(src, /setSocials/, 'socials are written once, in the launch transaction');
});

test('the trade sheet names the creator slice when the pair charges one', () => {
  const src = read('js/dex/trade-sheet.js');
  assert.match(src, /creatorFeeBps\(\)/, 'the sheet reads the slice from the pair');
  assert.match(src, /dex\.ts\.feeCreator/, 'the fee line can say where the slice goes');
});
