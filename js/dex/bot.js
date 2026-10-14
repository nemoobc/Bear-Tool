// ═══════════════════════════════════════════════════════════════
// Bear Tool — js/dex/bot.js
// The market maker: fill it once, it runs.
//
// The flow, in the order it happens:
//   1. put a balance in            → the bot splits it across addresses it makes
//   2. it makes its own addresses  → derived from your already-unlocked seed
//   3. it trades, and keeps going  → until you stop it, the balance runs out,
//                                    or the coin graduates
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
import { sendDexTx, provider, ethersLib, dexChainOk, fmtTok, ERC20_ABI } from './core.js';
import { PUMP_ABI } from './pump-source.js';
import { quoteBuy, quoteSell, fmtEth } from './curve.js';
import { decide, nextAccount, budgetBps, bandUsable, stopReason, BUY, SELL, STOP, WHY } from './bot-engine.js';
import { canDerive, botStartIndex, deriveBotWallets, splitBudget } from './bot-wallets.js';

const SLIPPAGE_BPS = 100n; // 1%, the same default the manual buy uses
const CFG = (addr) => `bear.dex.bot.${addr}`;

// ── the runner ───────────────────────────────────────────────────────
// One bot. Its whole public surface is `state()` and `subscribe()` — the rest
// stays private so nothing can poke the loop from a panel that has been torn
// down.
let R = null;
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
export function bindBot(host, token) {
  const cfg = loadCfg(token.address);
  for (const [id, key] of [
    ['dexBotFloorPct', 'floorPct'], ['dexBotCeilPct', 'ceilPct'], ['dexBotSize', 'size'],
    ['dexBotBudget', 'budget'], ['dexBotWallets', 'wallets'], ['dexBotSeconds', 'seconds'],
  ]) {
    const el = $('#' + id, host);
    if (el) el.value = cfg[key];
    el?.addEventListener('change', () => saveCfg(token.address, { [key]: el.value }));
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
  startBtn?.addEventListener('click', () => start(token).catch((e) => say(String(e.message || e))));

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
    if (!s.on || s.address !== token.address) {
      if (R && R.address !== token.address) return;
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
    if (spentEl) spentEl.textContent = `${t('dex.bot.spent')} ${fmtEth(s.spent, 4)} / ${fmtEth(s.cap, 4)}`;
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
  if (R && R.address === token.address) body.hidden = false;
}

// ── start ────────────────────────────────────────────────────────────
export async function start(token) {
  if (!dexChainOk()) { toast(t('dex.bot.wrongChain'), 'error'); return; }
  if (R) { toast(t('dex.bot.alreadyRunning'), 'error'); return; }

  const E = ethersLib();
  const cfg = loadCfg(token.address);

  let floorPct, ceilPct, sizeWei, budgetWei;
  try {
    floorPct = BigInt(Math.round(Number(cfg.floorPct)));
    ceilPct = BigInt(Math.round(Number(cfg.ceilPct)));
    sizeWei = E.parseUnits(String(cfg.size || '0'), 18);
    budgetWei = E.parseUnits(String(cfg.budget || '0'), 18);
  } catch { return toast(t('dex.bot.badNumber'), 'error'); }

  // Everything that would make the bot useless is refused BEFORE the user is
  // asked to unlock anything or fund anything. A bot that unlocks the wallet,
  // creates four addresses, spends gas moving coins to them, and then never
  // trades is the worst outcome this panel could produce.
  const curve = await readCurve(token.address);
  if (!curve.ok) return toast(t('dex.bot.unreadable'), 'error');
  if (floorPct >= ceilPct) return toast(t('dex.bot.badBand'), 'error');
  if (budgetWei <= 0n) return toast(t('dex.bot.noBudget'), 'error');
  if (sizeWei <= 0n) return toast(t('dex.bot.badNumber'), 'error');
  if (sizeWei > budgetWei) return toast(t('dex.bot.sizeOverBudget'), 'error');

  const floor = (curve.price * floorPct) / 100n;
  const ceil = (curve.price * ceilPct) / 100n;
  if (!bandUsable(floor, ceil)) return toast(t('dex.bot.badBand'), 'error');

  const secret = getSession();
  if (!secret) return toast(t('dex.bot.locked'), 'error');
  if (!canDerive(secret)) return toast(t('dex.bot.seedRequired'), 'error');

  const master = token.signer;
  if (!master) return toast(t('dex.bot.locked'), 'error');
  const masterAddr = await master.getAddress();

  const ok = await confirmTx({
    title: t('dex.bot.confirmTitle'),
    rows: [
      { k: t('dex.bot.budget'), v: fmtEth(budgetWei, 4) + ' ' + t('dex.bot.truthShort') },
      { k: t('dex.bot.size'), v: cfg.size },
      { k: t('dex.bot.floor'), v: floorPct + '%' },
      { k: t('dex.bot.ceil'), v: ceilPct + '%' },
      { k: t('dex.bot.wallets'), v: String(cfg.wallets) },
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
  const E2 = ethersLib();
  const net = provider();
  for (const w of wallets) w.signer = w.signer.connect(net);

  const quoteAddr = curve.quoteToken;
  const quote = new E.Contract(quoteAddr, ERC20_ABI, master);
  const shares = splitBudget(budgetWei, wallets.length, 0n);

  // Fund first, ask second. If the funding cannot happen there is no point
  // announcing a running bot, and the user is not left watching a live-looking
  // panel with nothing behind it.
  for (let i = 0; i < wallets.length; i++) {
    if (shares[i] <= 0n) continue;
    const sent = await sendDexTx(
      () => quote.transfer(wallets[i].address, shares[i]),
      t('dex.bot.funding', { n: String(i + 1), of: String(wallets.length) }),
    );
    if (!sent) { stop(t('dex.bot.fundFailed')); return; }
  }

  R = {
    address: token.address, signer: master, quoteAddr,
    wallets, balances: new Map(), cursor: 0, spent: 0n, cap: budgetWei,
    trades: 0, halted: null, lastNote: t('dex.bot.running'),
    floor, ceil, size: sizeWei, seconds: cfg.seconds,
    timer: null, stopped: false,
  };
  publish();
  schedule(0);
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
  const cs = new E.Contract(cur.address, PUMP_ABI, p);

  const [vq, vt, graduated] = await Promise.all([cs.virtualQuote(), cs.virtualTokens(), cs.graduated()]);
  const price = vt > 0n ? (vq * 10n ** 18n) / vt : 0n;

  // Balances are read fresh every tick. A bot that remembers balances asks a
  // wallet for money it spent an hour ago, and then fails forever.
  const accs = [];
  const qc = new E.Contract(cur.quoteAddr, ERC20_ABI, p);
  for (const w of cur.wallets) {
    const [qb, tb] = await Promise.all([qc.balanceOf(w.address), cs.balanceOf(w.address)]);
    const row = { ...w, quoteBal: qb, tokenBal: tb };
    cur.balances.set(w.address, row);
    accs.push(row);
  }

  // Decide with the aggregate view to learn WHAT is wanted, then pick a wallet
  // that can actually pay, then re-decide for that wallet. Splitting it this
  // way keeps every rule in decide() and leaves the two files free to disagree
  // about nothing.
  const want = decide({
    price, floor: cur.floor, ceil: cur.ceil, size: cur.size,
    spent: cur.spent, cap: cur.cap, graduated: Boolean(graduated),
    quoteBal: accs.reduce((a, b) => a + b.quoteBal, 0n),
    tokenBal: accs.reduce((a, b) => a + b.tokenBal, 0n),
  });
  if (want.action === STOP && stopReason(want.why)) { halt(want.why); return; }

  const side = want.action === BUY ? 'buy' : 'sell';
  const { account } = nextAccount(accs, side, cur.size, cur.cursor);
  if (!account) { note(t('dex.bot.why.noWallet')); return; }

  const d = decide({
    price, floor: cur.floor, ceil: cur.ceil, size: cur.size,
    quoteBal: account.quoteBal, tokenBal: account.tokenBal,
    spent: cur.spent, cap: cur.cap, graduated: Boolean(graduated),
  });
  if (d.action === STOP) { if (stopReason(d.why)) halt(d.why); return; }
  if (d.action !== BUY && d.action !== SELL) { note(''); return; }

  // The cursor advances only on a trade, so a HOLD-heavy run does not spin
  // through wallets and make the "next address" readout meaningless.
  cur.cursor = (cur.balances.size ? accs.indexOf(account) + 1 : 0) % accs.length;

  const signer = new E.Contract(cur.address, PUMP_ABI, account.signer);
  const quote = new E.Contract(cur.quoteAddr, ERC20_ABI, account.signer);

  if (d.action === BUY) {
    // Allowance is granted only when it is short, and only for this trade —
    // never unlimited.
    const allowed = await quote.allowance(account.address, cur.address).catch(() => 0n);
    if (allowed < d.amount) {
      const approved = await sendDexTx(
        () => quote.approve(cur.address, d.amount),
        t('dex.bot.approving', { sym: t('dex.bot.quoteShort') }),
      );
      if (!approved) return;
    }
    const q = quoteBuy(vq, vt, d.amount);
    const minOut = (q.tokensOut * (10_000n - SLIPPAGE_BPS)) / 10_000n;
    const sent = await sendDexTx(() => signer.buy(d.amount, minOut), t('dex.bot.buying'));
    if (!sent) return;
    cur.spent += d.amount;
    cur.trades += 1;
    note(t('dex.bot.bought', { amt: fmtEth(d.amount, 4), addr: account.address }));
  } else {
    const q = quoteSell(vq, vt, d.amount);
    const minOut = (q.quoteOut * (10_000n - SLIPPAGE_BPS)) / 10_000n;
    const sent = await sendDexTx(() => signer.sell(d.amount, minOut), t('dex.bot.selling'));
    if (!sent) return;
    cur.trades += 1;
    note(t('dex.bot.sold', { amt: fmtTok(d.amount, 18, 2), addr: account.address }));
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
async function readCurve(address) {
  try {
    const E = ethersLib();
    const cs = new E.Contract(address, PUMP_ABI, provider());
    const [vq, vt, quoteToken] = await Promise.all([cs.virtualQuote(), cs.virtualTokens(), cs.quoteToken()]);
    if (!vt || vt === 0n) return { ok: false };
    return { ok: true, price: (vq * 10n ** 18n) / vt, quoteToken };
  } catch { return { ok: false }; }
}

/** The live bot, or null. Used by tests and by the topbar indicator. */
export function botState() { return state(); }
