// Bear Tool — js/dex/bot.js
// M6: the market maker, adapted to the pool engine (DEX-V2 §2.2 #7).
//
// One bot, one pair, funded once:
//   1. the user sets band + size + budget + wallet count on the panel,
//   2. the bot derives its own addresses from the unlocked seed
//      (m/44'/60'/0'/0/<n>, past every account the app already holds),
//   3. gets funded: gas drip + a split of the quote budget per wallet,
//   4. then trades forever: BUY below the band, SELL above it, rotate wallets,
//      until the user stops it — or the engine's stop rules fire
//      (budget spent, no funded wallet left, nothing to sell, band unusable).
//
// Every trade is the SAME two-leg dance the manual trade sheet runs: approve
// EXACT (approveData of THIS trade's size), then swap (swapData). The bot
// never re-derives constant-product math in JS — out comes from the pair's
// own getAmountOut view; bot and chain cannot disagree by a wei.
//
// The runner is a module-level singleton with NO DOM references. Panels
// subscribe and unsubscribe with the paint; the bot keeps trading.

import { t } from '../i18n.js';
import { confirmTx, escapeHtml } from '../ui.js';
import { get } from '../state.js';
import { getNetworkById } from '../network.js';
import { getAccounts, getSession } from '../wallet.js';
import {
  approveData, isAddress, parseAmount, pairContract, slippageMinOut,
  swapData, tokenContract,
} from './swap.js';
import { dexChainOk } from './core.js';
import { waitForReceipt, receiptVerdict } from '../safetx.js';
import { decide, nextAccount, budgetBps, bandUsable, stopReason, BUY, SELL, STOP, WHY } from './bot-engine.js';
import { canDerive, botStartIndex, deriveBotWallets, splitBudget } from './bot-wallets.js';

export { WHY };
export { canDerive, botStartIndex, deriveBotWallets, splitBudget };

export const SLIP_BPS = 100n; // 1% — wider than the manual default: the bot cannot watch a revert and re-quote
const CFG = (pair) => `bear.dex.bot.${pair}`;
const esc = (x) => escapeHtml(String(x));

// ── the runner ───────────────────────────────────────────────────────
let R = null;         // the RUNNING bot; null when idle or halted-clean
let starting = false; // guards a second click during the multi-transaction start
const subs = new Set();

const idle = {
  on: false, pair: null, spent: 0n, cap: 0n, trades: 0, wallets: 0,
  cursor: 0, halted: null, lastNote: null, floor: 0n, ceil: 0n,
  spentH: '0', capH: '0',
};

function publish() {
  for (const fn of subs) { try { fn(state()); } catch { /* a broken panel must not stop the bot */ } }
}

function state() {
  if (!R) return idle;
  return {
    // A halted bot is DONE, not running: the panel must show the Start
    // button again the moment the reason is on screen — the old runner
    // kept `on` true through the halt window and hid the restart door.
    on: !R.stopped, pair: R.pair, spent: R.spent, cap: R.cap, trades: R.trades,
    wallets: R.wallets.length, cursor: R.cursor, halted: R.halted,
    lastNote: R.lastNote, floor: R.floor, ceil: R.ceil,
    // The meter speaks the user's dialect, not the chain's: wei here would
    // read as a countdown to nowhere. Human units, computed where the
    // decimals are known.
    spentH: fmtRaw(R.spent, R.qDec), capH: fmtRaw(R.cap, R.qDec),
  };
}

export function subscribe(fn) { subs.add(fn); fn(state()); return () => subs.delete(fn); }
export function botState() { return state(); }
export function running() { return { on: !!R, starting, pair: R?.pair ?? null }; }

// ── config: per pair, persisted, clamped ─────────────────────────────
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number(n) || lo));
function loadCfg(pair) {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(CFG(pair)) || '{}'); } catch { /* corrupt → defaults */ }
  return {
    floorPct: clamp(saved.floorPct ?? 90, 1, 1000),
    ceilPct: clamp(saved.ceilPct ?? 110, 1, 1000),
    size: String(saved.size ?? '0.01'),
    budget: String(saved.budget ?? ''),
    wallets: clamp(saved.wallets ?? 4, 1, 20),
    seconds: clamp(saved.seconds ?? 30, 5, 3600),
  };
}
function saveCfg(pair, patch) {
  if (!isAddress(pair)) throw new Error('dex/bot: pair');
  try { localStorage.setItem(CFG(pair), JSON.stringify({ ...loadCfg(pair), ...patch })); } catch { /* private mode */ }
}
export { loadCfg, saveCfg };

// ── reads ────────────────────────────────────────────────────────────
/** Live reserves + price (quote per token, 1e18 scale), straight off the pair. */
export async function readBand(providerLike, pairAddress) {
  if (!isAddress(pairAddress)) {
    const e = new Error('dex/bot: pair'); e.why = 'bad'; throw e;
  }
  const pair = pairContract(pairAddress, providerLike);
  const [qRes, tRes] = await pair.reserves();
  const tokenRes = BigInt(tRes);
  if (tokenRes === 0n) {
    const e = new Error('dex/bot: empty'); e.why = 'empty'; throw e;
  }
  const quoteRes = BigInt(qRes);
  return { quoteRes, tokenRes, price: (quoteRes * 10n ** 18n) / tokenRes };
}

// ── html ─────────────────────────────────────────────────────────────
function field(cfgKey, key, hintKey, min, max, step) {
  return `<label class="field-label" for="dexBot_${cfgKey}">${esc(t(key))}</label>
    <input id="dexBot_${cfgKey}" class="dex-input" type="number" data-cfg="${cfgKey}"
      ${min != null ? `min="${min}"` : ''} ${max != null ? `max="${max}"` : ''} step="${step}">
    ${hintKey ? `<p class="dex-t-hint">${esc(t(hintKey))}</p>` : ''}`;
}

/** The bot's panel: per-pair config behind a details-style toggle. */
export function botStubHtml() {
  return `
    <section class="dex-bot" id="dexBot" data-dex-bot>
      <button type="button" class="dex-bot-toggle" id="dexBotToggle" aria-expanded="false" aria-controls="dexBotBody">
        <span>${esc(t('dex.bot.title'))}</span>
        <span class="small">${esc(t('dex.bot.hint'))}</span>
      </button>
      <div id="dexBotBody" class="dex-bot-body" hidden>
        <p class="dex-t-hint dex-bot-truth">${esc(t('dex.bot.truth'))}</p>
        <label class="dex-k" for="dexBotPair">${esc(t('dex.bot.pair'))}</label>
        <input id="dexBotPair" class="dex-input" placeholder="0x…" spellcheck="false" aria-label="${esc(t('dex.bot.pair'))}">
        <div class="dex-bot-grid">
          ${field('floorpct', 'dex.bot.floor', 'dex.bot.floorHint', 1, 1000, '1')}
          ${field('ceilpct', 'dex.bot.ceil', 'dex.bot.ceilHint', 1, 1000, '1')}
          ${field('size', 'dex.bot.size', 'dex.bot.sizeHint', null, null, '0.01')}
          ${field('budget', 'dex.bot.budget', 'dex.bot.budgetHint', null, null, '10')}
          ${field('wallets', 'dex.bot.wallets', 'dex.bot.walletsHint', 1, 20, '1')}
          ${field('seconds', 'dex.bot.seconds', 'dex.bot.secondsHint', 5, 3600, '5')}
        </div>
        <div class="dex-actions">
          <button type="button" class="dex-btn" id="dexBotStart">${esc(t('dex.bot.start'))}</button>
          <button type="button" class="dex-btn" id="dexBotStop" hidden>${esc(t('dex.bot.stop'))}</button>
        </div>
        <div id="dexBotMeter" hidden>
          <div class="dex-bot-meter-head small">
            <span id="dexBotMeterText">${esc(t('dex.bot.spent'))} 0</span>
            <span id="dexBotTrades">${esc(t('dex.bot.trades'))} 0</span>
          </div>
          <div class="dex-bot-bar" id="dexBotBarHost" role="progressbar" aria-valuemin="0"
               aria-valuemax="100" aria-valuenow="0" aria-label="${esc(t('dex.bot.budget'))}">
            <div class="dex-bot-bar-fill" id="dexBotBarFill" style="width:0%"></div>
          </div>
          <p class="dex-t-hint" id="dexBotAddrs"></p>
        </div>
        <p class="dex-row small" id="dexBotStatus" role="status" aria-live="polite"></p>
        <div class="dex-bot-log small" id="dexBotLog" aria-live="off"></div>
      </div>
    </section>`;
}

/** Bind the panel to the runner. panel needs the user's dialect numbers.
 *  Returns an unsubscribe (the paint calls it when the card dies). */
export function bindBot(host, ctx = {}) {
  if (!host || typeof host.querySelector !== 'function' || typeof host.querySelectorAll !== 'function') return () => {};
  const pairEl = host.querySelector('#dexBotPair');
  const startBtn = host.querySelector('#dexBotStart');
  const stopBtn = host.querySelector('#dexBotStop');
  const statusEl = host.querySelector('#dexBotStatus');
  const logEl = host.querySelector('#dexBotLog');
  const meterEl = host.querySelector('#dexBotMeter');
  const saveKey = isAddress(String(ctx.pair)) ? String(ctx.pair) : '';
  let cfgSaved = saveKey ? loadCfg(saveKey) : null;

  if (pairEl && ctx.pair) pairEl.value = String(ctx.pair);
  for (const inp of host.querySelectorAll('[data-cfg]')) {
    const key = inp.dataset.cfg;
    if (cfgSaved && cfgSaved[key] !== undefined) inp.value = cfgSaved[key];
    inp?.addEventListener('change', () => {
      if (saveKey) {
        const p = pairEl?.value?.trim() || saveKey;
        if (isAddress(p)) saveCfg(p, { [key]: inp.value });
      }
    });
  }

  host.querySelector('#dexBotToggle')?.addEventListener('click', () => {
    const body = host.querySelector('#dexBotBody');
    if (!body) return;
    body.hidden = !body.hidden;
    host.querySelector('#dexBotToggle')?.setAttribute('aria-expanded', String(!body.hidden));
  });
  stopBtn?.addEventListener('click', () => stop(t('dex.bot.stoppedByUser')));
  startBtn?.addEventListener('click', async () => {
    const pair = String(host.querySelector('#dexBotPair')?.value ?? '').trim();
    const raw = {};
    for (const inp of host.querySelectorAll('[data-cfg]')) raw[inp.dataset.cfg] = inp.value;
    try {
      startBtn.disabled = true;
      await start({ pair, ...raw });
      say(t('dex.bot.started'), '');
    } catch (e) {
      say(String(e.shortMessage || e.message || e).slice(0, 140), 'err');
    } finally {
      startBtn.disabled = false;
    }
  });

  function say(msg, kind = '') {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.className = 'dex-row small' + (kind ? ` ${kind}` : '');
  }
  const log = (line) => {
    if (!logEl || !line) return;
    const at = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    logEl.textContent = [`${at} ${line}`, ...String(logEl.textContent).split('\n').filter(Boolean)].splice(0, 40).join('\n');
  };

  // The panel only LISTENS. Leaving the page unsubscribes; the bot keeps trading.
  const un = subscribe((s) => {
    // The three buttons are OPTIONAL: the bot card is not on every page, and
    // a page without it has no #dexBotStart / #dexBotStop / #dexBotMeter.
    // subscribe() calls this callback straight away, so an unguarded write
    // threw "Cannot set properties of null (setting 'hidden')" the moment
    // the panel was bound — the Android E2E caught it as an uncaught error.
    // Every other read below is already guarded; these three were not.
    if (startBtn) startBtn.hidden = s.on;
    if (stopBtn) stopBtn.hidden = !s.on;
    if (meterEl) meterEl.hidden = !s.on;
    const pct = Number(budgetBps(s.spent, s.cap)) / 100;
    const fill = host.querySelector('#dexBotBarFill');
    const bar = host.querySelector('#dexBotBarHost');
    if (fill) fill.style.width = `${Math.min(100, pct)}%`;
    if (bar) bar.setAttribute('aria-valuenow', String(Math.round(pct)));
    const spentEl = host.querySelector('#dexBotMeterText');
    if (spentEl) spentEl.textContent = `${t('dex.bot.spent')} ${s.spentH} / ${s.capH}`;
    const trEl = host.querySelector('#dexBotTrades');
    if (trEl) trEl.textContent = `${t('dex.bot.trades')} ${s.trades}`;
    const addrEl = host.querySelector('#dexBotAddrs');
    if (addrEl) addrEl.textContent = t('dex.bot.addrs', { n: String(s.wallets), next: String(s.cursor + 1) });
    if (s.halted) say(t('dex.bot.halted', { why: t(`dex.bot.why.${s.halted}`) }), 'err');
    else if (s.lastNote) { say(s.lastNote); log(s.lastNote); }
  });
  const teardown = () => { un(); host.removeEventListener('dex:teardown', teardown); };
  host.addEventListener('dex:teardown', teardown, { once: true });
  return un;
}

// ── start ────────────────────────────────────────────────────────────
/* Guards run before unlock, before derive, before gas: a bot that burns gas
 * funding four wallets and then never trades is the worst thing this panel
 * could produce. Every too-late refusal is moved here, before the first send. */
export async function start(p = {}) {
  // A self-halted run is still R for 8s so the panel can show the reason —
  // but starting again must not wait out that window.
  if (R?.stopped) { clearTimeout(R.timer); R = null; publish(); }
  if (R) throw new Error(t('dex.bot.alreadyRunning'));
  if (starting) throw new Error(t('dex.bot.alreadyRunning'));

  const pair = String(p.pair ?? '').trim();
  if (!isAddress(pair)) throw new Error('dex/bot: pair');
  if (!dexChainOk(getNetworkById(get('networkId'))?.chainId)) throw new Error(t('dex.bot.wrongChain'));

  const provider = get('provider');
  if (!provider) throw new Error(t('dex.engine.off'));
  const master = get('signer')?.connect?.(provider) ?? get('signer');
  if (!master) throw new Error(t('dex.bot.locked'));
  const secret = getSession();
  if (!secret) throw new Error(t('dex.bot.locked'));
  if (!canDerive(secret)) throw new Error(t('dex.bot.seedRequired'));

  starting = true;
  try {
    // contracts settle their OWN decimals — the panel's fields are hints only.
    const qC = tokenContract(await pairContract(pair, provider).quote(), provider);
    const tC = tokenContract(await pairContract(pair, provider).token(), provider);
    const [qSym, qDec, tSym, tDec] = await Promise.all([
      qC.symbol().then(String), qC.decimals().then(Number),
      tC.symbol().then(String), tC.decimals().then(Number),
    ]);

    let floorPct, ceilPct, sizeWei, budgetWei;
    try {
      floorPct = BigInt(Math.round(Number(clamp(p.floorPct ?? 90, 1, 1000))));
      ceilPct = BigInt(Math.round(Number(clamp(p.ceilPct ?? 110, 1, 1000))));
      sizeWei = parseAmount(String(p.size ?? '0'), qDec).value;      // the buy leg spends QUOTE
      budgetWei = parseAmount(String(p.budget ?? '0'), qDec).value;  // the budget is QUOTE
    } catch { throw new Error(t('dex.bot.badNumber')); }

    const band = await readBand(provider, pair);
    if (!bandUsable((band.price * floorPct) / 100n, (band.price * ceilPct) / 100n)) throw new Error(t('dex.bot.badBand'));
    if (budgetWei <= 0n) throw new Error(t('dex.bot.noBudget'));
    if (sizeWei <= 0n) throw new Error(t('dex.bot.badNumber'));
    const floor = (band.price * floorPct) / 100n;
    const ceil = (band.price * ceilPct) / 100n;

    const nWallets = clamp(p.wallets ?? 4, 1, 20);
    const seconds = clamp(p.seconds ?? 30, 5, 3600);
    const gasDrip = globalThis.ethers.parseEther('0.002');
    if (sizeWei > budgetWei) throw new Error(t('dex.bot.sizeOverBudget'));

    const okC = await confirmTx({
      title: t('dex.bot.confirmTitle'),
      rows: [
        { k: t('dex.bot.budget'), v: fmtRaw(budgetWei, qDec) + ' ' + qSym },
        { k: t('dex.bot.size'), v: fmtRaw(sizeWei, qDec) + ' ' + qSym },
        { k: t('dex.bot.floor'), v: `${floorPct}%` },
        { k: t('dex.bot.ceil'), v: `${ceilPct}%` },
        { k: t('dex.bot.wallets'), v: String(nWallets) },
        { k: t('dex.bot.gasRow'), v: `0.002 × ${nWallets}` },
      ],
      confirmText: t('dex.bot.start'),
      danger: true,
    });
    if (!okC) return;

    const mine = [get('address'), ...getAccounts().map((a) => a?.address)].filter(Boolean).map((a) => String(a).toLowerCase());
    let wallets;
    try {
      wallets = deriveBotWallets(secret, botStartIndex(getAccounts()), nWallets, mine);
    } catch (e) {
      throw new Error(e.message === 'seedRequired' ? t('dex.bot.seedRequired') : t('dex.bot.deriveFailed'));
    }
    for (const w of wallets) w.signer = w.signer.connect(provider);

    const shares = splitBudget(budgetWei, wallets.length, 0n);
    const masterQC = qC.connect(master);
    // gas FIRST — a wallet holding quote but no native coin cannot send its
    // own approve or swap; the swap would burn nothing but time.
    for (let i = 0; i < wallets.length; i++) {
      const g = await master.sendTransaction({ to: wallets[i].address, value: gasDrip })
        .then((sent) => waitForReceipt(sent, { label: `dex bot gas ${i + 1}` }))
        .then((v) => receiptVerdict(v)?.ok);
      if (!g) throw new Error(t('dex.bot.fundFailed'));
      if (shares[i] > 0n) {
        const s = await masterQC.transfer(wallets[i].address, shares[i])
          .then((sent) => waitForReceipt(sent, { label: `dex bot fund ${i + 1}` }))
          .then((v) => receiptVerdict(v)?.ok);
        if (!s) throw new Error(t('dex.bot.fundFailed'));
      }
    }

    R = {
      pair, quoteAddr: qC.target, tokenAddr: tC.target,
      qSym, tSym, qDec, tDec, wallets, balances: new Map(), cursor: 0,
      spent: 0n, cap: budgetWei, trades: 0, halted: null,
      lastNote: t('dex.bot.running'), floor, ceil, size: sizeWei, seconds,
      timer: null, stopped: false,
    };
    publish();
    schedule(0);
  } finally {
    starting = false;
  }
}

// ── the loop ─────────────────────────────────────────────────────────
function schedule(ms) {
  if (!R || R.stopped) return;
  clearTimeout(R.timer);
  R.timer = setTimeout(tick, ms);
}

async function tick() {
  if (!R || R.stopped) return;
  try { await oneTick(); } catch { /* a dropped RPC or a revert must not end an unattended bot — the next tick is the retry */ }
  if (!R || R.stopped) return;
  schedule(R.seconds * 1000);
}

async function oneTick() {
  const cur = R;
  const provider = get('provider');
  const surface = pairContract(cur.pair, provider);
  const [qRes, tRes] = await surface.reserves();
  const tokenRes = BigInt(tRes);
  if (tokenRes === 0n) return; // an empty pool is a hold; the next tick retries
  const price = (BigInt(qRes) * 10n ** 18n) / tokenRes;
  const sizeOut = price > 0n ? (cur.size * 10n ** 18n) / price : 0n;

  const qc = tokenContract(cur.quoteAddr, provider);
  const tc = tokenContract(cur.tokenAddr, provider);
  const accs = [];
  for (const w of cur.wallets) {
    const [qb, tb] = await Promise.all([qc.balanceOf(w.address), tc.balanceOf(w.address)]);
    accs.push({ ...w, quoteBal: BigInt(qb), tokenBal: BigInt(tb) });
    cur.balances.set(w.address, accs[accs.length - 1]);
  }

  const want = decide({
    price, floor: cur.floor, ceil: cur.ceil, size: cur.size, sizeOut,
    spent: cur.spent, cap: cur.cap,
    quoteBal: accs.reduce((a, b) => a + b.quoteBal, 0n),
    tokenBal: accs.reduce((a, b) => a + b.tokenBal, 0n),
  });
  if (want.action === STOP) {
    if (stopReason(want.why)) halt(want.why);
    return;
  }
  const side = want.action === BUY ? 'buy' : 'sell';
  const pick = nextAccount(accs, side, want.action === BUY ? cur.size : sizeOut, cur.cursor);
  if (!pick.account) { note(t('dex.bot.why.noWallet')); return; }
  const d = decide({
    price, floor: cur.floor, ceil: cur.ceil, size: cur.size, sizeOut,
    quoteBal: pick.account.quoteBal, tokenBal: pick.account.tokenBal,
    spent: cur.spent, cap: cur.cap,
  });
  if (d.action === STOP) { if (stopReason(d.why)) halt(d.why); return; }
  if (d.action !== BUY && d.action !== SELL) { note(''); return; }
  cur.cursor = pick.cursor; // advances only on a real decision

  const selling = d.action === SELL;
  const out = BigInt(await surface.getAmountOut(!selling, d.amount));
  const minOut = slippageMinOut(out, SLIP_BPS);
  if (out <= 0n || minOut <= 0n) return;

  const spender = selling ? cur.tokenAddr : cur.quoteAddr;
  const spendC = tokenContract(spender, pick.account.signer);
  const allowance = await spendC.allowance(pick.account.address, cur.pair);
  if (BigInt(allowance) < d.amount) {
    const ok = await send(pick.account.signer, spender, approveData(spender, cur.pair, d.amount));
    if (!ok) return;
  }
  const data = swapData(!selling, d.amount, minOut, pick.account.address);
  const sent = await send(pick.account.signer, cur.pair, data);
  if (!sent) return;
  if (d.action === BUY) cur.spent += d.amount;
  cur.trades += 1;
  note(d.action === BUY
    ? t('dex.bot.bought', { addr: String(pick.account.address).slice(0, 8), amt: `${fmtRaw(d.amount, cur.qDec)} ${cur.qSym}` })
    : t('dex.bot.sold', { addr: String(pick.account.address).slice(0, 8), amt: `${fmtRaw(d.amount, cur.tDec)} ${cur.tSym}` }));
}

async function send(signer, to, data) {
  try {
    const sentTx = await signer.sendTransaction({ to, data });
    const v = receiptVerdict(await waitForReceipt(sentTx, { label: 'dex bot' }));
    return !!v?.ok;
  } catch { return false; }
}

function halt(why) {
  const r = stopReason(why);
  if (!r) return;
  clearTimeout(R.timer);
  R.stopped = true;
  R.halted = r;
  publish();
  setTimeout(() => { if (R && R.stopped) { R = null; publish(); } }, 8000);
}

function note(msg) { if (R) { R.lastNote = msg; publish(); } }

export function stop(msg) {
  if (!R) return;
  clearTimeout(R.timer);
  R.stopped = true;
  const was = R;
  was.lastNote = msg || t('dex.bot.stopped');
  R = null;
  publish();
}

const fmtRaw = (v, d) => globalThis.ethers.formatUnits(v, d);
// (the one helper above is deliberately tiny: everything else this file needs
// is either here or in the modules it names.)