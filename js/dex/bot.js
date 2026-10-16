// ═══════════════════════════════════════════════════════════════
// Bear Tool — js/dex/bot.js
// The market maker: fill it once, it runs.
//
// The flow, in the order it happens:
//   1. put a balance in            → the bot splits it across addresses it makes
//   2. it makes its own addresses  → derived from your already-unlocked seed
//   3. it trades, and keeps going  → until you stop it or the balance runs out
//
// It trades the POOL (BearPair), not the retired curve (DEX-V2 M5c): every
// buy and sell is the same swap the manual TradeSheet runs — swapQuote for
// the numbers, ensureAllowanceTx + swapTx for the transactions — so the bot
// and the button can never disagree about what a trade is. Each derived
// address is funded with the quote coin AND a small native gas drip: a
// wallet holding tokens but no ETH cannot send its own approve.
//
// No time limit and no expiry. A bot that quietly stops after half an hour is
// worse than one that never starts, because the user finds out from a price.
//
// ── The loop outlives the page ─────────────────────────────────────────
// The runner is a module-level singleton and keeps no reference to any DOM
// node. Panels subscribe to it and unsubscribe when torn down. A bot wired to
// the coin page's lifetime would die the moment the user opened another coin —
// which would look exactly like a bug, and would happen silently.
// ═══════════════════════════════════════════════════════════════

import { t } from '../i18n.js';
import { getAccounts, getSession } from '../wallet.js';
import { $, toast, escapeHtml, confirmTx } from '../ui.js';
import { sendDexTx, provider, ethersLib, dexChainOk, fmtTok, ERC20_ABI, get, withTxButton } from './core.js';
import { poolState } from './pool-data.js';
import { swapQuote, swapTx, ensureAllowanceTx } from './swap.js';
import { decide, nextAccount, budgetBps, bandUsable, stopReason, BUY, SELL, STOP, WHY } from './bot-engine.js';
import { canDerive, botStartIndex, deriveBotWallets, splitBudget } from './bot-wallets.js';

const SLIPPAGE_BPS = 100n; // 1% — wider than the manual 0.5%: the bot cannot re-quote after a revert
const CFG = (addr) => `bear.dex.bot.${addr}`;

// ── the runner ───────────────────────────────────────────────────────
// One bot. Its whole public surface is `state()` and `subscribe()` — the rest
// stays private so nothing can poke the loop from a panel that has been torn
// down.
let R = null;
// A start in progress. `if (R)` guards the RUNNING bot, but R is not assigned
// until after the pool read, the confirm sheet, the address derivation and the
// funding transfers — a window of several seconds in which a second click passed
// the guard, queued a second confirm, and paid for a second round of funding.
// The second run then overwrote R, orphaning the first runner, which was already
// holding a live timer and kept trading against an object the UI could not see.
let starting = false;
const subs = new Set();

const idle = {
  on: false, address: null, spent: 0n, cap: 0n, trades: 0, wallets: 0,
  cursor: 0, halted: null, lastNote: null,
};

function publish() { for (const fn of subs) { try { fn(state()); } catch { /* a broken panel must not stop the bot */ } } }

function state() {
  if (!R) return idle;
  return {
    on: true, address: R.address, spent: R.spent, cap: R.cap,
    trades: R.trades, wallets: R.wallets.length, cursor: R.cursor,
    halted: R.halted, lastNote: R.lastNote, floor: R.floor, ceil: R.ceil,
  };
}

function subscribe(fn) { subs.add(fn); fn(state()); return () => subs.delete(fn); }

// ── config ───────────────────────────────────────────────────────────
function loadCfg(address) {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(CFG(address)) || '{}'); } catch { /* corrupt → defaults */ }
  return {
    floorPct: clamp(saved.floorPct ?? 90, 1, 1000),
    ceilPct: clamp(saved.ceilPct ?? 110, 1, 1000),
    size: String(saved.size ?? '0.01'),
    budget: String(saved.budget ?? ''),
    wallets: clamp(saved.wallets ?? 4, 1, 20),
    seconds: clamp(saved.seconds ?? 30, 5, 3600),
    ...saved,
  };
}
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number(n) || lo));
function saveCfg(address, patch) {
  try { localStorage.setItem(CFG(address), JSON.stringify({ ...loadCfg(address), ...patch })); } catch { /* private mode */ }
}

// ── html ─────────────────────────────────────────────────────────────
export function botHtml() {
  return `
    <section class="dex-bot" id="dexBot">
      <button type="button" class="dex-bot-toggle" id="dexBotToggle" aria-expanded="false" aria-controls="dexBotBody">
        <span>${escapeHtml(t('dex.bot.title'))}</span>
        <span class="small">${escapeHtml(t('dex.bot.hint'))}</span>
      </button>

      <div id="dexBotBody" class="dex-bot-body" hidden>
        <p class="small dex-bot-truth">${escapeHtml(t('dex.bot.truth'))}</p>

        <div class="dex-bot-grid">
          ${field('dexBotFloorPct', t('dex.bot.floor'), 'number', 1, 1000, 1, '')}
          ${field('dexBotCeilPct', t('dex.bot.ceil'), 'number', 1, 1000, 1, '')}
          ${field('dexBotSize', t('dex.bot.size'), 'number', 0, null, 'any', t('dex.bot.sizeHint'))}
          ${field('dexBotBudget', t('dex.bot.budget'), 'number', 0, null, 'any', t('dex.bot.budgetHint'))}
          ${field('dexBotWallets', t('dex.bot.wallets'), 'number', 1, 20, 1, t('dex.bot.walletsHint'))}
          ${field('dexBotSeconds', t('dex.bot.seconds'), 'number', 5, 3600, 5, t('dex.bot.secondsHint'))}
        </div>

        <div class="dex-bot-actions">
          <button id="dexBotStart" type="button" class="btn btn-primary">${escapeHtml(t('dex.bot.start'))}</button>
          <button id="dexBotStop" type="button" class="btn btn-secondary" hidden>${escapeHtml(t('dex.bot.stop'))}</button>
        </div>

        <div id="dexBotMeter" hidden>
          <div class="dex-bot-meter-head small">
            <span id="dexBotMeterText">${escapeHtml(t('dex.bot.spent'))} 0</span>
            <span id="dexBotTrades">${escapeHtml(t('dex.bot.trades'))} 0</span>
          </div>
          <div class="dex-card-curve" id="dexBotBarHost" role="progressbar"
               aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"
               aria-label="${escapeHtml(t('dex.bot.budget'))}">
            <div class="dex-card-curve-fill" id="dexBotBarFill" style="width:0%"></div>
          </div>
          <div class="small mt-8" id="dexBotAddrs"></div>
        </div>

        <div class="small mt-8" id="dexBotStatus" role="status" aria-live="polite"></div>
        <div class="small dex-bot-log" id="dexBotLog"></div>
      </div>
    </section>`;
}

function field(id, label, type, min, max, step, hint) {
  return `<label class="field-label" for="${id}">${escapeHtml(label)}</label>
    <input id="${id}" class="input" type="${type}"${min != null ? ` min="${min}"` : ''}${max != null ? ` max="${max}"` : ''}
           step="${step}"${hint ? ` placeholder="${escapeHtml(hint)}"` : ''}>`;
}

// ── bind ─────────────────────────────────────────────────────────────
export function bindBot(host, ctx) {
  // ctx = { address, pair, quote, qSym, qd, td, symbol } — the pool this panel
  // trades and the quote's decimals for every amount it prints.
  const { address, qd = 18 } = ctx || {};
  const cfg = loadCfg(address);
  for (const [id, key] of [
    ['dexBotFloorPct', 'floorPct'], ['dexBotCeilPct', 'ceilPct'], ['dexBotSize', 'size'],
    ['dexBotBudget', 'budget'], ['dexBotWallets', 'wallets'], ['dexBotSeconds', 'seconds'],
  ]) {
    const el = $('#' + id, host);
    if (el) el.value = cfg[key];
    el?.addEventListener('change', () => saveCfg(address, { [key]: el.value }));
  }

  const toggle = $('#dexBotToggle', host);
  const body = $('#dexBotBody', host);
  const startBtn = $('#dexBotStart', host);
  const stopBtn = $('#dexBotStop', host);
  const statusEl = $('#dexBotStatus', host);
  const logEl = $('#dexBotLog', host);
  const meterEl = $('#dexBotMeter', host);

  toggle?.addEventListener('click', () => {
    body.hidden = !body.hidden;
    toggle.setAttribute('aria-expanded', String(!body.hidden));
  });
  stopBtn?.addEventListener('click', () => stop(t('dex.bot.stoppedByUser')));
  // Starting funds several addresses one tx at a time — a button that looks
  // untouched through all of it is the dead-button bug the shared tx-button
  // exists to kill. The dots own the button until the last tx settles.
  startBtn?.addEventListener('click', () => withTxButton(startBtn, t('dex.bot.starting'), async () => {
    await start(ctx).catch((e) => say(String(e.message || e)));
  }));

  const say = (msg, kind = '') => {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.className = 'small mt-8' + (kind ? ' ' + kind : '');
  };
  const log = (line) => {
    if (!logEl || !R) return;
    const at = new Date().toLocaleTimeString();
    logEl.textContent = [`${at} ${line}`, ...logEl.textContent.split('\n').filter(Boolean)].slice(0, 40).join('\n');
  };

  // The panel only LISTENS. Leaving the page unsubscribes and the bot keeps
  // trading; coming back repaints from the live state rather than restarting.
  const off = subscribe((s) => {
    if (!s.on || s.address !== address) {
      if (R && R.address !== address) return;
      startBtn.hidden = s.on; stopBtn.hidden = !s.on; meterEl.hidden = !s.on;
      return;
    }
    startBtn.hidden = true; stopBtn.hidden = false; meterEl.hidden = false;

    const pct = Number(budgetBps(s.spent, s.cap)) / 100;
    const fill = $('#dexBotBarFill', host);
    const bar = $('#dexBotBarHost', host);
    if (fill) fill.style.width = Math.min(100, pct) + '%';
    // The screen-reader value is derived from the same number the bar uses, so
    // the two can never disagree — a full bar announced as half-full is a bug
    // only one of the two would ever report.
    if (bar) bar.setAttribute('aria-valuenow', String(Math.round(pct)));

    const spentEl = $('#dexBotMeterText', host);
    if (spentEl) spentEl.textContent = `${t('dex.bot.spent')} ${fmtTok(s.spent, qd, 4)} / ${fmtTok(s.cap, qd, 4)}`;
    const trEl = $('#dexBotTrades', host);
    if (trEl) trEl.textContent = `${t('dex.bot.trades')} ${s.trades}`;

    const addrEl = $('#dexBotAddrs', host);
    if (addrEl) {
      addrEl.textContent = t('dex.bot.addrs', { n: String(s.wallets), next: String(s.cursor + 1) });
    }

    if (s.halted) say(t('dex.bot.halted', { why: t('dex.bot.why.' + s.halted) }), 'is-error');
    else if (s.lastNote) say(s.lastNote);
  });

  const onTeardown = () => off();
  host.addEventListener('dex:teardown', onTeardown, { once: true });

  // Build the panel from whatever the live state says, including a bot that was
  // started on another screen.
  if (R && R.address === address) body.hidden = false;
}

// ── start ────────────────────────────────────────────────────────────
export async function start(ctx) {
  const { address, pair, quote: quoteAddr, qSym = '', qd = 18, td = 18 } = ctx || {};
  if (!dexChainOk()) { toast(t('dex.bot.wrongChain'), 'error'); return; }
  if (R) { toast(t('dex.bot.alreadyRunning'), 'error'); return; }
  if (starting) { toast(t('dex.bot.alreadyRunning'), 'error'); return; }
  starting = true;
  try {

  const E = ethersLib();
  const cfg = loadCfg(address);

  let floorPct, ceilPct, sizeWei, budgetWei;
  try {
    floorPct = BigInt(Math.round(Number(cfg.floorPct)));
    ceilPct = BigInt(Math.round(Number(cfg.ceilPct)));
    sizeWei = E.parseUnits(String(cfg.size || '0'), qd);
    budgetWei = E.parseUnits(String(cfg.budget || '0'), qd);
  } catch { return toast(t('dex.bot.badNumber'), 'error'); }

  // Everything that would make the bot useless is refused BEFORE the user is
  // asked to unlock anything or fund anything. A bot that unlocks the wallet,
  // creates four addresses, spends gas moving coins to them, and then never
  // trades is the worst outcome this panel could produce.
  const pool = await readPool(pair);
  if (!pool.ok) return toast(t('dex.bot.unreadable'), 'error');
  if (floorPct >= ceilPct) return toast(t('dex.bot.badBand'), 'error');
  if (budgetWei <= 0n) return toast(t('dex.bot.noBudget'), 'error');
  if (sizeWei <= 0n) return toast(t('dex.bot.badNumber'), 'error');
  if (sizeWei > budgetWei) return toast(t('dex.bot.sizeOverBudget'), 'error');

  const floor = (pool.price * floorPct) / 100n;
  const ceil = (pool.price * ceilPct) / 100n;
  if (!bandUsable(floor, ceil)) return toast(t('dex.bot.badBand'), 'error');

  const secret = getSession();
  if (!secret) return toast(t('dex.bot.locked'), 'error');
  if (!canDerive(secret)) return toast(t('dex.bot.seedRequired'), 'error');

  // The signer lives in app state, NOT on the coin. The token object handed to
  // this panel is the coin's metadata — address, name, symbol, creator — and it
  // has no signer on it, so reading one from there returned undefined every
  // single time and the bot refused to start with "the wallet is locked" even
  // with the wallet open. That failure is invisible to every gate that drives
  // the engine directly, which is how it survived a green on-chain run.
  const master = get('signer');
  if (!master) return toast(t('dex.bot.locked'), 'error');
  // A keystore signer is a plain ethers.Wallet with NO provider — every send
  // through it dies with "missing provider" (the same bug the dApp send branch
  // documents). Connect it once, up front: the funding and the gas drip below
  // both send from it.
  const net = provider();
  const masterC = master.connect(net);
  const masterAddr = await masterC.getAddress();
  const gasDrip = E.parseEther('0.002');

  const ok = await confirmTx({
    title: t('dex.bot.confirmTitle'),
    rows: [
      { k: t('dex.bot.budget'), v: fmtTok(budgetWei, qd, 4) + ' ' + qSym },
      { k: t('dex.bot.size'), v: cfg.size },
      { k: t('dex.bot.floor'), v: floorPct + '%' },
      { k: t('dex.bot.ceil'), v: ceilPct + '%' },
      { k: t('dex.bot.wallets'), v: String(cfg.wallets) },
      { k: t('dex.bot.gasRow'), v: E.formatUnits(gasDrip, 18) + ' ETH × ' + String(cfg.wallets) },
    ],
    confirmText: t('dex.bot.start'),
    danger: true,
    valueWei: 0n,
  });
  if (!ok) return;

  // The accounts already in the app are passed as exclusions, not just as a
  // starting index: an account whose path cannot be parsed would otherwise let
  // the bot derive onto a wallet the user spends from.
  const mine = [masterAddr, ...getAccounts().map((a) => a.address)].filter(Boolean);
  let wallets;
  try {
    wallets = deriveBotWallets(secret, botStartIndex(getAccounts()), cfg.wallets, mine);
  } catch (e) {
    const key = e.message === 'seedRequired' ? 'seedRequired' : e.message === 'noFreeAddresses' ? 'deriveFailed' : 'deriveFailed';
    return toast(t('dex.bot.' + key), 'error');
  }

  // A derived wallet is pure key maths — it has no network attached, so every
  // call through it throws "missing provider". Attaching the Dex's provider is
  // what turns it into something that can actually send a transaction.
  for (const w of wallets) w.signer = w.signer.connect(net);

  const quote = new E.Contract(quoteAddr, ERC20_ABI, masterC);
  const shares = splitBudget(budgetWei, wallets.length, 0n);

  // Fund first, ask second. If the funding cannot happen there is no point
  // announcing a running bot, and the user is not left watching a live-looking
  // panel with nothing behind it. Gas first: a derived address holding quote
  // but no ETH cannot send its own approve or swap — the old bot funded quote
  // only, which is why it could never actually trade.
  for (let i = 0; i < wallets.length; i++) {
    const gasSent = await sendDexTx(
      () => masterC.sendTransaction({ to: wallets[i].address, value: gasDrip }),
      t('dex.bot.fundingGas', { n: String(i + 1), of: String(wallets.length) }),
    );
    // stop() does nothing when R is still null, which it is here — the failure
    // happens BEFORE the runner exists. So the explanation has to be given here,
    // where the user can act on it: k of n addresses are funded, the rest are
    // not, and the panel looking untouched would hide that.
    if (!gasSent) {
      toast(t('dex.bot.fundFailed'), 'error');
      return;
    }
    if (shares[i] <= 0n) continue;
    const sent = await sendDexTx(
      () => quote.transfer(wallets[i].address, shares[i]),
      t('dex.bot.funding', { n: String(i + 1), of: String(wallets.length) }),
    );
    if (!sent) {
      toast(t('dex.bot.fundFailed'), 'error');
      return;
    }
  }

  R = {
    address, pair, signer: masterC, quoteAddr, qd, td, qSym,
    wallets, balances: new Map(), cursor: 0, spent: 0n, cap: budgetWei,
    trades: 0, halted: null, lastNote: t('dex.bot.running'),
    floor, ceil, size: sizeWei, seconds: cfg.seconds,
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
  try {
    await oneTick();
  } catch {
    // A tick that throws (a dropped RPC call, a reverted estimate) must not end
    // an unattended bot. The next tick is the retry.
  }
  if (!R || R.stopped) return;
  const cur = R;
  schedule(cur.seconds * 1000);
}

async function oneTick() {
  const cur = R;
  const E = ethersLib();
  const p = provider();

  // The pool, read fresh every tick — the same seam the token page reads.
  const ps = await poolState(cur.pair);
  if (!ps.ok || !ps.tokenReserve || ps.tokenReserve === 0n) return; // next tick retries
  const { quoteReserve, tokenReserve } = ps;
  const price = (quoteReserve * 10n ** 18n) / tokenReserve;
  // The configured size is a QUOTE figure; the sell leg is denominated in
  // TOKENS and is sized to be worth the same, so the band is symmetric in VALUE.
  // Handing the engine the same number for both sides made each sell ~10^12 too
  // small to unwind a buy, which turned a two-sided bot into a one-way drain.
  const sizeOut = price > 0n ? (cur.size * 10n ** 18n) / price : 0n;

  // Balances are read fresh every tick. A bot that remembers balances asks a
  // wallet for money it spent an hour ago, and then fails forever.
  const accs = [];
  const qc = new E.Contract(cur.quoteAddr, ERC20_ABI, p);
  const tc = new E.Contract(cur.address, ERC20_ABI, p);
  for (const w of cur.wallets) {
    const [qb, tb] = await Promise.all([qc.balanceOf(w.address), tc.balanceOf(w.address)]);
    const row = { ...w, quoteBal: qb, tokenBal: tb };
    cur.balances.set(w.address, row);
    accs.push(row);
  }

  // Decide with the aggregate view to learn WHAT is wanted, then pick a wallet
  // that can actually pay, then re-decide for that wallet. Splitting it this
  // way keeps every rule in decide() and leaves the two files free to disagree
  // about nothing. Pools never graduate — that stop rule simply never fires.
  const want = decide({
    price, floor: cur.floor, ceil: cur.ceil, size: cur.size, sizeOut,
    spent: cur.spent, cap: cur.cap, graduated: false,
    quoteBal: accs.reduce((a, b) => a + b.quoteBal, 0n),
    tokenBal: accs.reduce((a, b) => a + b.tokenBal, 0n),
  });
  if (want.action === STOP && stopReason(want.why)) { halt(want.why); return; }

  const side = want.action === BUY ? 'buy' : 'sell';
  const { account } = nextAccount(accs, side, want.action === BUY ? cur.size : sizeOut, cur.cursor);
  if (!account) { note(t('dex.bot.why.noWallet')); return; }

  const d = decide({
    price, floor: cur.floor, ceil: cur.ceil, size: cur.size, sizeOut,
    quoteBal: account.quoteBal, tokenBal: account.tokenBal,
    spent: cur.spent, cap: cur.cap, graduated: false,
  });
  if (d.action === STOP) { if (stopReason(d.why)) halt(d.why); return; }
  if (d.action !== BUY && d.action !== SELL) { note(''); return; }

  // The cursor advances only on a trade, so a HOLD-heavy run does not spin
  // through wallets and make the "next address" readout meaningless.
  cur.cursor = (cur.balances.size ? accs.indexOf(account) + 1 : 0) % accs.length;

  if (d.action === BUY) {
    // The quote moves to the PAIR: approve exactly this trade, only when the
    // allowance is short — the same ensureAllowanceTx the manual sheet runs.
    const a = await ensureAllowanceTx({ token: cur.quoteAddr, spender: cur.pair, amount: d.amount, owner: account.address, signer: account.signer });
    if (!a.ok) return;
    const q = swapQuote({ quoteReserve, tokenReserve, direction: 'buy', amountIn: d.amount, slippageBps: Number(SLIPPAGE_BPS) });
    if (!q.ok) return;
    const sent = await swapTx({ pair: cur.pair, direction: 'buy', amountIn: d.amount, minOut: q.minOut, signer: account.signer });
    if (!sent) return;
    cur.spent += d.amount;
    cur.trades += 1;
    note(t('dex.bot.bought', { amt: fmtTok(d.amount, cur.qd, 4), addr: account.address }));
  } else {
    // The token moves to the pair this time: allowance on the TOKEN.
    const a = await ensureAllowanceTx({ token: cur.address, spender: cur.pair, amount: d.amount, owner: account.address, signer: account.signer });
    if (!a.ok) return;
    const q = swapQuote({ quoteReserve, tokenReserve, direction: 'sell', amountIn: d.amount, slippageBps: Number(SLIPPAGE_BPS) });
    if (!q.ok) return;
    const sent = await swapTx({ pair: cur.pair, direction: 'sell', amountIn: d.amount, minOut: q.minOut, signer: account.signer });
    if (!sent) return;
    cur.trades += 1;
    note(t('dex.bot.sold', { amt: fmtTok(d.amount, cur.td, 2), addr: account.address }));
  }
  publish();
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

function note(msg) { if (!R) return; R.lastNote = msg; publish(); }

export function stop(msg) {
  if (!R) return;
  clearTimeout(R.timer);
  R.stopped = true;
  const was = R;
  R = null;
  was.lastNote = msg || t('dex.bot.stopped');
  publish();
  if (msg) toast(msg, 'success');
}

// ── reads ────────────────────────────────────────────────────────────
/** The pool this panel trades: reserves live, price = quote per token (1e18). */
async function readPool(pair) {
  try {
    const ps = await poolState(pair);
    if (!ps.ok || !ps.tokenReserve || ps.tokenReserve === 0n) return { ok: false };
    return { ok: true, price: (ps.quoteReserve * 10n ** 18n) / ps.tokenReserve };
  } catch { return { ok: false }; }
}

/** The live bot, or null. Used by tests and by the topbar indicator. */
export function botState() { return state(); }
