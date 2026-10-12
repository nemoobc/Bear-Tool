// js/non-evm-send.js — the Send screen for Bitcoin, Solana and XRP.
//
// This is the only place in the build where a non-EVM key is asked to sign
// something a user typed, so it is deliberately paranoid:
//
//   1. a draft is built and priced first, and the user confirms the real numbers
//      (amount, fee, total, destination) in a dialog BEFORE any signature exists;
//   2. the signing key is derived only for the active account, and the built
//      transaction is checked to be spending THAT account's address (chain-btc /
//      chain-xrp / chain-sol each refuse otherwise);
//   3. broadcast goes through js/non-evm-rpc.js, which only talks to allowlisted
//      https endpoints.
//
// The EVM Send markup is not modified: the whole `.send-card` is hidden while a
// non-EVM chain is active and this panel takes its place, so switching back to an
// EVM network restores the original form untouched.

import { $, toast, confirmTx, escapeHtml, fmtAmount } from './ui.js';
import { get, addActivity } from './state.js';
import { getNetworkById, isNonEvmNetwork } from './network.js';
import * as wallet from './wallet.js';
import { btcKeypair, xrpKeypair, solanaKeypair } from './coin-trees.js';
import * as btc from './chain-btc.js';
import * as xrp from './chain-xrp.js';
import * as sol from './chain-sol.js';
import * as rpc from './non-evm-rpc.js';

const DECIMALS = { bitcoin: 8, solana: 9, xrp: 6 };

/** '0.5' → 50000000n at 8 decimals. No floats, no rounding surprises. */
export function toSmallest(text, decimals) {
  const s = String(text == null ? '' : text).trim();
  if (!/^\d*(\.\d*)?$/.test(s) || s === '' || s === '.') throw new Error('Enter an amount');
  const [whole, frac = ''] = s.split('.');
  if (frac.length > decimals) throw new Error(`At most ${decimals} decimal places`);
  const value = BigInt(whole || '0') * (10n ** BigInt(decimals)) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals));
  if (value <= 0n) throw new Error('Amount must be greater than zero');
  return value;
}

export function fromSmallest(value, decimals) {
  const v = BigInt(value);
  const unit = 10n ** BigInt(decimals);
  const whole = v / unit;
  const frac = (v % unit).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}

/**
 * The exact fee a Bitcoin send will pay, priced the way the chain will really
 * build it. Two shapes:
 *   • change clears dust  → the builder keeps a change output; the fee is the
 *     two-output price at `rate`;
 *   • change would be dust → the builder DROPS the change output, so the whole
 *     remainder (total - amount) becomes the fee. That is LARGER than the
 *     one-output estimate, and charging the estimate would show the user less
 *     than the chain takes — so charge the remainder exactly.
 * Returns the fee in satoshi and the vsize it was priced against. Throws when
 * the amount leaves nothing for a relayable fee.
 */
export function btcSendFee({ total, amountSat, rate, nIn, dust = btc.BTC_DUST }) {
  const vWithChange = btc.estimateVsize({ nIn, outputs: ['p2wpkh', 'p2wpkh'] });
  const feeWithChange = BigInt(Math.ceil(vWithChange * rate));
  if (total - amountSat - feeWithChange >= BigInt(dust)) {
    return { fee: feeWithChange, vsize: vWithChange, withChange: true };
  }
  const vNoChange = btc.estimateVsize({ nIn, outputs: ['p2wpkh'] });
  const feeNoChange = BigInt(Math.ceil(vNoChange * rate));
  const fee = total - amountSat;
  if (fee <= 0n) throw new Error('Not enough to cover the amount plus the network fee');
  if (fee < feeNoChange) throw new Error('This amount leaves too little to pay the network fee — send a little less');
  return { fee, vsize: vNoChange, withChange: false };
}

/** Which ledger: mainnet by default, testnet when the user asks for it. */
function sendNetwork() {
  return ($('#nonEvmNetSel')?.value === 'testnet') ? 'testnet' : 'mainnet';
}

/** Everything needed to sign: the seed, the account index and the addresses. */
function context() {
  const secret = wallet.getSession();
  if (!secret) throw new Error('Unlock the wallet to send');
  const index = Number(wallet.getActiveAccountIndex() || 0);
  const net = getNetworkById(get('networkId'));
  return { secret, index, net, chain: net.id, network: sendNetwork() };
}

// ── the panel ───────────────────────────────────────────────────────────

const PANEL_ID = 'nonEvmSendCard';

/**
 * Show the non-EVM send panel and hide the EVM one. Called from
 * refreshView('send') — see app.js. Idempotent.
 */
export function loadNonEvmSend(net) {
  const card = document.querySelector('#view-send .card');
  if (!card) return;
  // The EVM form: token picker, gas speed, gas estimate, preview. None of it
  // applies here, and leaving it on screen offers controls that do nothing.
  const evmCard = card.querySelector('.send-card');
  if (evmCard) evmCard.style.display = 'none';
  // The address book is EVM-shaped (0x…) — hide it rather than let someone save
  // a "0x…" address they then expect to work on Bitcoin.
  const book = card.querySelector('#addressBookAccordion');
  if (book) book.style.display = 'none';

  let panel = document.getElementById(PANEL_ID);
  if (!panel) {
    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.className = 'send-card non-evm-send';
    card.appendChild(panel);
  }
  panel.style.display = '';
  panel.innerHTML = panelMarkup(net);
  bindPanel(net);
  refreshPanel(net);
}

/** Put the EVM form back the way we found it. */
export function unloadNonEvmSend() {
  const panel = document.getElementById(PANEL_ID);
  if (panel) panel.style.display = 'none';
  const card = document.querySelector('#view-send .card');
  if (!card) return;
  const evmCard = card.querySelector('.send-card:not(#' + PANEL_ID + ')');
  if (evmCard) evmCard.style.display = '';
  const book = card.querySelector('#addressBookAccordion');
  if (book) book.style.display = '';
}

/** True when the visible send form is the non-EVM one. */
export function isNonEvmSendActive() {
  const panel = document.getElementById(PANEL_ID);
  return !!panel && panel.style.display !== 'none' && !!panel.innerHTML;
}

function panelMarkup(net) {
  const sym = escapeHtml(net.symbol);
  const decimals = DECIMALS[net.id] || 8;
  const tagField = net.id === 'xrp'
    ? `<div class="field">
         <label for="nonEvmTag">Destination tag <span class="dim">(optional)</span></label>
         <input class="input" id="nonEvmTag" type="number" min="0" step="1" placeholder="e.g. 12345" inputmode="numeric">
         <p class="small dim">Some exchanges need this to credit your payment. Leave it empty if the recipient did not give you one.</p>
       </div>`
    : '';
  const feeField = net.id === 'bitcoin'
    ? `<div class="field">
         <label for="nonEvmFeeSel">Network fee</label>
         <select class="select" id="nonEvmFeeSel">
           <option value="fast">Fast — confirm sooner</option>
           <option value="normal" selected>Normal</option>
           <option value="economy">Economy — cheapest</option>
         </select>
       </div>`
    : '';
  return `
    <div class="field">
      <label for="nonEvmTo">To ${sym} address</label>
      <div class="send-address-wrap">
        <input class="input" id="nonEvmTo" placeholder="${net.id === 'bitcoin' ? 'bc1q… / 1… / 3…' : net.id === 'xrp' ? 'r…' : 'Solana address'}" autocomplete="off" spellcheck="false">
        <button type="button" class="btn btn-ghost btn-sm" id="nonEvmPaste" title="Paste">Paste</button>
      </div>
    </div>
    <div class="field">
      <label for="nonEvmAmount">Amount (${sym})</label>
      <input class="input" id="nonEvmAmount" type="number" placeholder="0.0" min="0" step="any" inputmode="decimal">
      <div class="send-pct-btns" role="group" aria-label="Amount shortcuts">
        <button type="button" class="pct-btn" data-nonpct="25">25%</button>
        <button type="button" class="pct-btn" data-nonpct="50">50%</button>
        <button type="button" class="pct-btn" data-nonpct="75">75%</button>
        <button type="button" class="pct-btn pct-max" data-nonpct="100" title="Send everything spendable — the balance minus the fee">MAX</button>
      </div>
      <p class="max-note" id="nonEvmMaxNote" role="status" aria-live="polite"></p>
      <p class="small dim" id="nonEvmBalanceLine" role="status" aria-live="polite"></p>
    </div>
    ${tagField}
    ${feeField}
    <div class="field">
      <label for="nonEvmNetSel">Ledger</label>
      <select class="select" id="nonEvmNetSel">
        <option value="mainnet" selected>Mainnet</option>
        <option value="testnet">Testnet</option>
      </select>
    </div>
    <div class="gas-estimate" id="nonEvmEstimate">
      <span class="gas-est-label">Est. fee:</span>
      <span class="gas-est-value" id="nonEvmFeeValue">—</span>
    </div>
    <button type="button" class="btn btn-primary btn-block btn-lg" id="nonEvmSendBtn">Send ${sym}</button>
    <p class="small dim mt-8" id="nonEvmSendNote" role="status" aria-live="polite"></p>
  `;
}

// A snapshot of what the panel is showing, so the send handler does not have to
// re-read the chain between the confirmation dialog and the broadcast.
let snapshot = null;

function bindPanel(net) {
  $('#nonEvmPaste')?.addEventListener('click', async () => {
    try {
      const text = (await navigator.clipboard.readText() || '').trim();
      if (!text) return toast('Clipboard is empty', 'info');
      $('#nonEvmTo').value = text;
      refreshPanel(net);
    } catch {
      $('#nonEvmTo')?.focus();
      toast('Clipboard blocked — press and hold to paste', 'info');
    }
  });
  $('#nonEvmTo')?.addEventListener('input', () => refreshPanel(net));
  $('#nonEvmAmount')?.addEventListener('input', () => refreshPanel(net));
  $('#nonEvmNetSel')?.addEventListener('change', () => { snapshot = null; refreshPanel(net); });
  $('#nonEvmFeeSel')?.addEventListener('change', () => refreshPanel(net));
  document.querySelectorAll('#nonEvmSendCard .pct-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const pct = parseInt(btn.dataset.nonpct, 10);
      if (!Number.isFinite(pct)) return;
      document.querySelectorAll('#nonEvmSendCard .pct-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      try {
        const amount = await spendableAmount(net, pct);
        $('#nonEvmAmount').value = amount.value;
        const note = $('#nonEvmMaxNote');
        if (note) { note.textContent = amount.note; note.classList.add('show'); }
      } catch (error) {
        const note = $('#nonEvmMaxNote');
        if (note) { note.textContent = error.message; note.classList.add('show'); }
      }
      refreshPanel(net);
    });
  });
  $('#nonEvmSendBtn')?.addEventListener('click', () => doNonEvmSend(net));
}

/** Read the chain, price the transaction, paint the estimate. Never throws out. */
async function refreshPanel(net) {
  const decimals = DECIMALS[net.id] || 8;
  const note = $('#nonEvmSendNote');
  const balanceLine = $('#nonEvmBalanceLine');
  const feeValue = $('#nonEvmFeeValue');
  if (!balanceLine) return;
  snapshot = null;
  try {
    const ctx = context();
    if (net.id === 'bitcoin') {
      const key = btcKeypair(ctx.secret, ctx.index);
      const [utxos, rates] = await Promise.all([
        rpc.btcUtxos(key.nativeSegwit, { network: ctx.network }),
        rpc.btcFeeRate({ network: ctx.network }),
      ]);
      const total = utxos.reduce((n, u) => n + BigInt(u.value), 0n);
      const rate = pickBtcRate(rates, $('#nonEvmFeeSel')?.value);
      balanceLine.textContent = `${fromSmallest(total, 8)} BTC spendable (${utxos.length} output${utxos.length === 1 ? '' : 's'})`;
      if (feeValue) feeValue.textContent = `${rate} sat/vB`;
      snapshot = { kind: 'bitcoin', key, utxos, rate, total, decimals, network: ctx.network };
    } else if (net.id === 'solana') {
      const key = solanaKeypair(ctx.secret, ctx.index);
      const lamports = await rpc.solBalance(key.address, { network: ctx.network });
      balanceLine.textContent = `${fromSmallest(lamports, 9)} SOL`;
      if (feeValue) feeValue.textContent = `${fromSmallest(sol.SOL_BASE_FEE, 9)} SOL (network fee)`;
      snapshot = { kind: 'solana', key, lamports, decimals, network: ctx.network };
    } else if (net.id === 'xrp') {
      const key = xrpKeypair(ctx.secret, ctx.index);
      let info = null;
      let serverInfo = null;
      try {
        [info, serverInfo] = await Promise.all([
          rpc.xrpAccountInfo(key.classic, { network: ctx.network }),
          rpc.xrpServerInfo({ network: ctx.network }).catch(() => null),
        ]);
      } catch (error) {
        if (!/actNotFound|not found/i.test(String(error && error.message))) throw error;
      }
      // The reserve is read from the ledger, not assumed: it is set by fee voting
      // and has changed (the mainnet base reserve is 1 XRP today).
      const reserve = rpc.xrpReserveDrops({ serverInfo, ownerCount: info?.ownerCount || 0 });
      if (!info) {
        balanceLine.textContent = `This address has no XRP yet — it must be funded with at least ${fromSmallest(reserve, 6)} XRP before it can send.`;
        if (feeValue) feeValue.textContent = '—';
        snapshot = { kind: 'xrp', key, funded: false, reserve, decimals, network: ctx.network };
      } else {
        balanceLine.textContent = `${fromSmallest(info.balanceDrops, 6)} XRP`;
        if (feeValue) feeValue.textContent = `${fromSmallest(BigInt(xrp.XRP_MIN_FEE_DROPS), 6)} XRP (network fee)`;
        snapshot = { kind: 'xrp', key, funded: true, info, reserve, decimals, network: ctx.network };
      }
    }
    if (note) note.textContent = '';
  } catch (error) {
    if (note) note.textContent = error.message || 'Could not read the chain';
    balanceLine.textContent = '';
    if (feeValue) feeValue.textContent = '—';
  }
}

function pickBtcRate(rates, speed) {
  if (speed === 'fast') return Math.max(1, Math.round(rates.fastest));
  if (speed === 'economy') return Math.max(1, Math.round(rates.economy));
  return Math.max(1, Math.round(rates.halfHour));
}

/**
 * The most that can be sent at `pct`%. For Bitcoin the fee scales with the
 * inputs spent, so MAX is "everything minus the fee for a transaction of this
 * size" — never the whole balance, which could not pay for itself.
 */
async function spendableAmount(net, pct) {
  context();   // refuses when the wallet is locked — the MAX button must too
  if (net.id === 'bitcoin') {
    if (!snapshot || snapshot.kind !== 'bitcoin') throw new Error('Still reading the chain — try again in a moment');
    const { utxos, rate, total } = snapshot;
    // MAX leaves nothing to return as change, so the fee is the one-output
    // price — and sending total minus that fee pays exactly it (btcSendFee
    // agrees, because the change output is then below dust and dropped).
    const vNoChange = btc.estimateVsize({ nIn: utxos.length, outputs: ['p2wpkh'] });
    const feeNoChange = BigInt(Math.ceil(vNoChange * rate));
    const spendable = total - feeNoChange;
    if (spendable <= 0n) throw new Error('Not enough to cover the network fee');
    const value = (spendable * BigInt(pct)) / 100n;
    return { value: fromSmallest(value, 8), note: `${fromSmallest(spendable, 8)} BTC is spendable after the ${fromSmallest(feeNoChange, 8)} BTC fee.` };
  }
  if (net.id === 'solana') {
    if (!snapshot || snapshot.kind !== 'solana') throw new Error('Still reading the chain — try again in a moment');
    const spendable = snapshot.lamports - sol.SOL_BASE_FEE;
    if (spendable <= 0n) throw new Error('Not enough to cover the network fee');
    return { value: fromSmallest((spendable * BigInt(pct)) / 100n, 9), note: `${fromSmallest(spendable, 9)} SOL spendable after the fee.` };
  }
  if (net.id === 'xrp') {
    if (!snapshot || snapshot.kind !== 'xrp' || !snapshot.funded) throw new Error('This address has no XRP to send');
    // The reserve was read from the ledger in refreshPanel; the documented
    // fallback (1 XRP base) only applies if that read failed.
    const reserve = snapshot.reserve ?? rpc.xrpReserveDrops({ ownerCount: 0 });
    const spendable = snapshot.info.balanceDrops - reserve - BigInt(xrp.XRP_MIN_FEE_DROPS);
    if (spendable <= 0n) throw new Error(`Not enough XRP above the ${fromSmallest(reserve, 6)} XRP account reserve`);
    return { value: fromSmallest((spendable * BigInt(pct)) / 100n, 6), note: `${fromSmallest(spendable, 6)} XRP spendable above the account reserve.` };
  }
  throw new Error(`Sending is not implemented for ${net.name}`);
}

// ── the send itself ─────────────────────────────────────────────────────

async function doNonEvmSend(net) {
  const note = $('#nonEvmSendNote');
  const button = $('#nonEvmSendBtn');
  const to = ($('#nonEvmTo')?.value || '').trim();
  const amountText = ($('#nonEvmAmount')?.value || '').trim();
  const decimals = DECIMALS[net.id] || 8;
  try {
    if (!to) throw new Error(`Enter the destination ${net.symbol} address`);
    const amount = toSmallest(amountText, decimals);
    const ctx = context();

    if (net.id === 'bitcoin') {
      await sendBitcoin(ctx, to, amount, note, button);
    } else if (net.id === 'solana') {
      await sendSolana(ctx, to, amount, note, button);
    } else if (net.id === 'xrp') {
      await sendXrp(ctx, to, amount, note, button);
    } else {
      throw new Error(`Sending is not implemented for ${net.name}`);
    }
  } catch (error) {
    const message = error?.message || 'Send failed';
    if (note) note.textContent = message;
    toast(message, 'error');
  } finally {
    if (button) button.disabled = false;
  }
}

function explorerUrl(chain, value) {
  return rpc.explorerTxUrl(chain, sendNetwork(), value);
}

// Record a non-EVM send in the wallet history. `detail` MUST be a human string:
// the activity row and the detail sheet both render it directly (escapeHtml →
// String), so passing an object — as an earlier version did — printed
// "[object Object]" to the user. The destination is kept separately as the
// plain address string so it survives JSON persistence.
function record(chain, hash, to, extra = {}) {
  const tag = extra.destinationTag == null ? '' : ` · tag ${extra.destinationTag}`;
  addActivity({
    hash,
    type: 'send',
    net: chain,
    netId: chain,
    status: 'pending',
    ts: Date.now(),
    ...extra,
    to,
    detail: `to ${wallet.shortAddress(to)}${tag}`,
  });
}

async function sendBitcoin(ctx, to, amountSat, note, button) {
  const key = btcKeypair(ctx.secret, ctx.index);
  btc.decodeBtcAddress(to, ctx.network);   // throws with a named reason
  const [utxos, rates] = await Promise.all([
    rpc.btcUtxos(key.nativeSegwit, { network: ctx.network }),
    rpc.btcFeeRate({ network: ctx.network }),
  ]);
  if (!utxos.length) throw new Error('Nothing to spend on this address yet');
  const total = utxos.reduce((n, u) => n + BigInt(u.value), 0n);
  const rate = pickBtcRate(rates, $('#nonEvmFeeSel')?.value);
  // Price it exactly the way the builder will build it, so the number on the
  // confirm sheet is the number the chain pays (btcSendFee owns that rule).
  const { fee, vsize } = btcSendFee({ total, amountSat, rate, nIn: utxos.length });
  const effectiveRate = Math.max(1, Math.round(Number(fee) / vsize));

  const ok = await confirmTx({
    title: `Send ${fromSmallest(amountSat, 8)} BTC?`,
    rows: [
      { k: 'To', v: to },
      { k: 'Network', v: ctx.network === 'mainnet' ? 'Bitcoin' : 'Bitcoin testnet' },
      { k: 'Amount', v: `${fromSmallest(amountSat, 8)} BTC` },
      { k: 'Network fee', v: `${fromSmallest(fee, 8)} BTC (${effectiveRate} sat/vB)` },
      { k: 'Total', v: `${fromSmallest(amountSat + fee, 8)} BTC` },
      { k: 'Change returns to', v: key.nativeSegwit },
    ],
    confirmText: 'Send',
  });
  if (!ok) return;
  if (button) button.disabled = true;

  const built = btc.buildBtcSend({
    privateKey: key.privateKey,
    utxos,
    to,
    amountSat,
    feeSat: fee,
    changeAddress: key.nativeSegwit,
    network: ctx.network,
  });
  if (note) note.textContent = 'Broadcasting…';
  const txid = await rpc.btcBroadcast(built.hex, { network: ctx.network });
  if (note) note.innerHTML = `Sent. Transaction <a href="${explorerUrl('bitcoin', txid)}" target="_blank" rel="noopener">${escapeHtml(txid)}</a>`;
  toast('Bitcoin sent', 'success');
  record('bitcoin', txid, to);
  await refreshPanel(getNetworkById(get('networkId')));
}

async function sendSolana(ctx, to, lamports, note, button) {
  const key = solanaKeypair(ctx.secret, ctx.index);
  sol.decodeSolAddress(to);                       // named refusal for junk
  const [blockhash, balance] = await Promise.all([
    rpc.solLatestBlockhash({ network: ctx.network }),
    rpc.solBalance(key.address, { network: ctx.network }),
  ]);
  const fee = sol.SOL_BASE_FEE;
  if (balance < lamports + fee) {
    throw new Error(`Not enough SOL — you have ${fromSmallest(balance, 9)} and need ${fromSmallest(lamports + fee, 9)} including the fee`);
  }
  const ok = await confirmTx({
    title: `Send ${fromSmallest(lamports, 9)} SOL?`,
    rows: [
      { k: 'To', v: to },
      { k: 'Network', v: ctx.network === 'mainnet' ? 'Solana' : 'Solana devnet' },
      { k: 'Amount', v: `${fromSmallest(lamports, 9)} SOL` },
      { k: 'Network fee', v: `${fromSmallest(fee, 9)} SOL` },
      { k: 'Total', v: `${fromSmallest(lamports + fee, 9)} SOL` },
    ],
    confirmText: 'Send',
  });
  if (!ok) return;
  if (button) button.disabled = true;

  const built = sol.buildSolSend({
    privateKey: key.privateKey,
    from: key.address,
    to,
    lamports,
    recentBlockhash: blockhash.blockhash,
  });
  if (note) note.textContent = 'Broadcasting…';
  const signature = await rpc.solSendTransaction(built.rawTransactionBase64, { network: ctx.network });
  if (note) note.innerHTML = `Sent. Transaction <a href="${explorerUrl('solana', signature)}" target="_blank" rel="noopener">${escapeHtml(signature.slice(0, 20))}…</a>`;
  toast('Solana sent', 'success');
  record('solana', signature, to);
  await refreshPanel(getNetworkById(get('networkId')));
}

async function sendXrp(ctx, to, amountDrops, note, button) {
  const key = xrpKeypair(ctx.secret, ctx.index);
  xrp.decodeXrpAddress(to);
  const tagText = ($('#nonEvmTag')?.value || '').trim();
  let destinationTag;
  if (tagText) {
    const parsed = Number(tagText);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 4294967295) throw new Error('A destination tag is a whole number between 0 and 4294967295');
    destinationTag = parsed;
  }
  const [info, serverInfo, ledger] = await Promise.all([
    rpc.xrpAccountInfo(key.classic, { network: ctx.network }),
    rpc.xrpServerInfo({ network: ctx.network }).catch(() => null),
    rpc.xrpLedgerIndex({ network: ctx.network }),
  ]);
  const fee = BigInt(xrp.XRP_MIN_FEE_DROPS);
  const lastLedgerSequence = ledger + 20;
  // The ledger refuses a payment that would drop the account below its reserve
  // (tecUNFUNDED_PAYMENT), so an amount that breaks it is stopped here with a
  // message a person can act on instead of being submitted and rejected.
  const reserve = rpc.xrpReserveDrops({ serverInfo, ownerCount: info.ownerCount || 0 });
  if (BigInt(info.balanceDrops) < amountDrops + fee + reserve) {
    throw new Error(`This would leave the account below its ${fromSmallest(reserve, 6)} XRP reserve — send a little less`);
  }

  const ok = await confirmTx({
    title: `Send ${fromSmallest(amountDrops, 6)} XRP?`,
    rows: [
      { k: 'To', v: to },
      ...(destinationTag != null ? [{ k: 'Destination tag', v: String(destinationTag) }] : []),
      { k: 'Network', v: ctx.network === 'mainnet' ? 'XRP Ledger' : 'XRP testnet' },
      { k: 'Amount', v: `${fromSmallest(amountDrops, 6)} XRP` },
      { k: 'Network fee', v: `${fromSmallest(fee, 6)} XRP` },
      { k: 'Last valid ledger', v: String(lastLedgerSequence) },
    ],
    confirmText: 'Send',
  });
  if (!ok) return;
  if (button) button.disabled = true;

  const built = xrp.buildSignedXrp({
    privateKey: key.privateKey,
    account: key.classic,
    destination: to,
    amountDrops: String(amountDrops),
    feeDrops: Number(fee),
    sequence: info.sequence,
    lastLedgerSequence,
    destinationTag,
  });
  if (note) note.textContent = 'Submitting…';
  const result = await rpc.xrpSubmit(built.blob, { network: ctx.network });
  const hash = result.hash || built.hash;
  if (note) note.innerHTML = `Submitted${result.tentative ? ' (queued)' : ''}. Transaction <a href="${explorerUrl('xrp', hash)}" target="_blank" rel="noopener">${escapeHtml(hash.slice(0, 20))}…</a>`;
  toast(result.tentative ? 'XRP queued' : 'XRP sent', 'success');
  record('xrp', hash, to, { destinationTag });
  await refreshPanel(getNetworkById(get('networkId')));
}
