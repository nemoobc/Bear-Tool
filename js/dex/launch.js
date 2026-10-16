// Bear Tool — js/dex/launch.js
// The launch wizard (v2): ONE transaction creates everything.
//
// The curve is gone. Launching now means BearFactory deploys the token, opens
// its BearPair against the chosen quote coin, seeds both sides, hands the
// leftover supply to the creator, and locks the creator's LP — all inside
// factory.launch(), one transaction through the shared Dex spine (sendDexTx).
// The quote coin must be approved first; ensureAllowanceTx approves exactly
// what the launch will pull, and only when the chain says the allowance is
// short.
//
// The wizard carries no deploy machinery of its own: the factory IS the
// deployer, so nothing is compiled in the browser, and the token address is
// read back out of the Launched event — never assumed.
import {
  t, $, toast, escapeHtml, fmtTok, withTxButton, openEdu,
  QUOTE_PRESETS, quoteBy, provider, ethersLib, sendDexTx, needSigner, isAddr, dexChainOk,
} from './core.js';
import { openModal } from '../ui.js';
import { parseAmount, ensureAllowanceTx } from './swap.js';
import { factoryAddress, deployFactory } from './factory.js';
import { BEAR_FACTORY_ABI } from './bear-source.js';
import { quotePerToken } from './pool-list.js';
import { rememberLaunchedToken } from './tokens.js';

// Symbol for whichever quote ERC-20 is selected, falling back to the first
// preset. The pool is quoted in this token, not the chain's native coin, so
// every unit shown on the launch screen names it.
function quoteSymFor(addr) {
  const q = quoteBy(addr);
  return (q && q.symbol) || QUOTE_PRESETS[0].symbol;
}

// Images: the user may upload a big file (10 MB), but a data URI can NEVER go
// on-chain as-is — the constructor calldata explodes the deploy gas past what
// the wallet can pay. So: accept a big upload, then DOWNSCALE it in the
// browser, re-encoding at lower size/quality until the data URI fits an
// on-chain budget. What lands on-chain is always deployable.
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB — what we accept
const ONCHAIN_IMAGE_MAX_PX = 512;          // start here
const ONCHAIN_MAX_BYTES = 12 * 1024;       // hard cap on the stored data URI
const ONCHAIN_QUALITY_START = 0.72;

const LOCK_CHOICES = [7, 30, 90, 365]; // days
// Quick supply presets: the field alone read as "no supply choice" (report
// 2026-10-16). Values keep the 80%-to-the-pool ratio the form ships with.
const SUPPLY_PRESETS = [1_000_000, 10_000_000, 100_000_000, 1_000_000_000];
const supplyPresetLabel = (n) => (n >= 1_000_000_000 ? `${n / 1_000_000_000}B` : `${n / 1_000_000}M`);

export function launchHtml() {
  const lockOpts = LOCK_CHOICES
    .map((d) => `<option value="${d * 86400}"${d === 30 ? ' selected' : ''}>${escapeHtml(t('dex.lp.lockDays', { n: String(d) }))}</option>`)
    .join('');
  const needFactory = !isAddr(factoryAddress());
  return `
    <div class="dex-create">
      <div class="field-label">${escapeHtml(t('dex.create.title'))}</div>
      <div class="small mb-8">${escapeHtml(t('dex.launch.hint'))}</div>

      ${needFactory ? `
      <div class="card mb-8">
        <div class="small">${escapeHtml(t('dex.launch.needFactory'))}</div>
        <button type="button" class="btn btn-secondary btn-block mt-8" id="dexLaunchDeployFactory">${escapeHtml(t('dex.launch.deployFactory'))}</button>
      </div>` : ''}

      <div class="launch-stepper" id="launch-stepper" role="tablist" aria-label="${escapeHtml(t('dex.create.title'))}">
        <button type="button" class="launch-step launch-step-active" data-step="1" role="tab" aria-selected="true">
          <span class="launch-step-num">1</span><span class="launch-step-lbl">${escapeHtml(t('launch.step.one'))}</span>
        </button>
        <button type="button" class="launch-step launch-step-disabled" data-step="2" role="tab" aria-selected="false" disabled>
          <span class="launch-step-num">2</span><span class="launch-step-lbl">${escapeHtml(t('launch.step.two'))}</span>
        </button>
        <button type="button" class="launch-step launch-step-disabled" data-step="3" role="tab" aria-selected="false" disabled>
          <span class="launch-step-num">3</span><span class="launch-step-lbl">${escapeHtml(t('launch.step.three'))}</span>
        </button>
      </div>

      <div class="launch-step-panel launch-step-panel-active" id="launch-step-1">
        <div class="dex-create-top">
        <div class="dex-create-preview">
          <img id="dexCreateImg" alt="" />
          <input id="dexCreateFile" type="file" accept="image/*" class="sr-file"
                 aria-label="${escapeHtml(t('dex.create.pickImage'))}">
          <div id="dexCreateImgEmpty" class="small">${escapeHtml(t('dex.create.noImage'))}</div>
          <div id="dexCreateImgNote" class="small dex-img-note" role="status"></div>
        </div>
        <div class="dex-create-fields">
          <label class="field-label" for="dexCreateName">${escapeHtml(t('dex.create.name'))}</label>
          <input id="dexCreateName" class="input" maxlength="32" placeholder="Bear Moon">
          <label class="field-label mt-8" for="dexCreateSymbol">${escapeHtml(t('dex.create.symbol'))}</label>
          <input id="dexCreateSymbol" class="input" maxlength="12" placeholder="BMOON">
          <label class="field-label mt-8" for="dexCreateDesc">${escapeHtml(t('dex.create.desc'))}</label>
          <textarea id="dexCreateDesc" class="textarea" rows="2" maxlength="200"
                    placeholder="${escapeHtml(t('dex.create.descPh'))}"></textarea>
        </div>
      </div>

      <div class="dex-create-fields mt-8">
        <label class="field-label" for="dexCreateTwitter">${escapeHtml(t('dex.create.twitter'))}</label>
        <input id="dexCreateTwitter" class="input" maxlength="80" placeholder="x.com/…">
        <label class="field-label mt-8" for="dexCreateTelegram">${escapeHtml(t('dex.create.telegram'))}</label>
        <input id="dexCreateTelegram" class="input" maxlength="80" placeholder="t.me/…">
        <label class="field-label mt-8" for="dexCreateWebsite">${escapeHtml(t('dex.create.website'))}</label>
        <input id="dexCreateWebsite" class="input" maxlength="80" placeholder="example.com">
        <div class="small mt-8">${escapeHtml(t('dex.create.socialsWhy'))}</div>
      </div>
        <div class="launch-step-actions mt-8">
          <button type="button" class="btn btn-primary btn-block" id="launchStep1Next">${escapeHtml(t('launch.button.next'))}</button>
        </div>
        <div id="launchStep1Error" class="small mt-8" role="status"></div>
      </div>

      <div class="launch-step-panel hidden" id="launch-step-2">
        <div class="dex-create-fields mt-8">
          <label class="field-label" for="dexCreateQuote">${escapeHtml(t('dex.create.quote'))}</label>
        <select id="dexCreateQuote" class="input" aria-describedby="dexCreateQuoteWhy">
          ${QUOTE_PRESETS.map((q, i) => `<option value="${escapeHtml(q.address)}"${i === 0 ? ' selected' : ''}>${escapeHtml(q.symbol)} — ${escapeHtml(q.name)}</option>`).join('')}
        </select>
        <div class="small mt-8" id="dexCreateQuoteWhy">${escapeHtml(t('dex.create.quoteWhy'))}</div>
      </div>

      <div class="dex-create-fields mt-8">
        <label class="field-label" for="dexLaunchSupply">${escapeHtml(t('dex.launch.supply'))}</label>
        <input id="dexLaunchSupply" class="input" inputmode="numeric" autocomplete="off" value="1000000000">
        <div class="dex-tabstrip mt-8" id="dexLaunchSupplyPresets" role="group" aria-label="${escapeHtml(t('dex.launch.supplyPresets'))}">
          ${SUPPLY_PRESETS.map((n) => `<button type="button" class="dex-tab" data-supply="${n}" aria-pressed="${n === 1_000_000_000}">${supplyPresetLabel(n)}</button>`).join('')}
        </div>
        <label class="field-label mt-8" for="dexLaunchTokens">${escapeHtml(t('dex.launch.poolTokens'))}</label>
        <input id="dexLaunchTokens" class="input" inputmode="numeric" autocomplete="off" value="800000000">
        <label class="field-label mt-8" for="dexLaunchQuoteIn" id="dexLaunchQuoteLabel"></label>
        <input id="dexLaunchQuoteIn" class="input" inputmode="decimal" autocomplete="off" placeholder="0.5">
        <label class="field-label mt-8" for="dexLaunchLock">${escapeHtml(t('dex.launch.lock'))}</label>
        <select id="dexLaunchLock" class="input">${lockOpts}</select>
        <label class="field-label mt-8" for="dexLaunchFee">${escapeHtml(t('dex.launch.feeLabel'))}</label>
        <select id="dexLaunchFee" class="input" aria-describedby="dexLaunchFeeWhy">
          <option value="0">${escapeHtml(t('dex.launch.feeOff'))}</option>
          <option value="10" selected>${escapeHtml(t('dex.launch.feeThird'))}</option>
          <option value="15">${escapeHtml(t('dex.launch.feeHalf'))}</option>
        </select>
        <div class="small mt-8" id="dexLaunchFeeWhy">${escapeHtml(t('dex.launch.feeWhy'))}</div>
        <label class="field-label mt-8" for="dexLaunchDevBuy" id="dexLaunchDevBuyLabel">${escapeHtml(t('dex.launch.devBuy', { q: quoteSymFor(QUOTE_PRESETS[0].address) }))}</label>
        <input id="dexLaunchDevBuy" class="input" inputmode="decimal" autocomplete="off" placeholder="0">
        <div class="small mt-8">${escapeHtml(t('dex.launch.devBuyWhy'))}</div>
        <div class="dex-ts-inforow small mt-8">
          <div>${escapeHtml(t('dex.launch.antiSniper'))}</div>
          <button type="button" class="dex-edu" id="dexLaunchEdu" aria-label="${escapeHtml(t('dex.edu.sniper.title'))}">?</button>
        </div>
        <div class="small mt-8" id="dexLaunchPreview"></div>
      </div>
        <div class="launch-step-actions mt-8">
          <button type="button" class="btn btn-secondary" id="launchStep2Back">${escapeHtml(t('launch.button.back'))}</button>
          <button type="button" class="btn btn-primary" id="launchStep2Next">${escapeHtml(t('launch.button.next'))}</button>
        </div>
        <div id="launchStep2Error" class="small mt-8" role="status"></div>
      </div>

      <div class="launch-step-panel hidden" id="launch-step-3">
        <div class="dex-create-fields mt-8 launch-summary">
          <div class="small mt-8"><strong>${escapeHtml(t('launch.preview.openingPrice'))}</strong> <span id="launchSumPrice">–</span></div>
          <div class="small mt-8"><strong>${escapeHtml(t('launch.preview.pair'))}</strong> <span id="launchSumPair">–</span></div>
          <div class="small mt-8"><strong>${escapeHtml(t('launch.preview.creatorTokens'))}</strong> <span id="launchSumKeep">–</span></div>
          <div class="small mt-8"><strong>${escapeHtml(t('launch.preview.gasEst'))}</strong> <span id="launchSumGas">–</span></div>
        </div>
        <div class="launch-step-actions mt-8">
          <button type="button" class="btn btn-secondary" id="launchStep3Back">${escapeHtml(t('launch.button.back'))}</button>
          <button type="button" class="btn btn-primary btn-block" id="launchStep3Review">${escapeHtml(t('launch.button.reviewLaunch'))}</button>
        </div>
        <div id="launchStep3Error" class="small mt-8" role="status"></div>
        <div class="launch-badges small mt-8">
          <span class="launch-badge launch-badge-fair">${escapeHtml(t('launch.badge.fairLaunch'))}</span>
          <span class="launch-badge launch-badge-anti">${escapeHtml(t('launch.badge.antiSniper'))}</span>
        </div>
      </div>
      <div id="dexCreateStatus" class="small mt-8" role="status"></div>
    </div>`;
}

/**
 * The whole launch, as one call: approve the quote if the chain says the
 * allowance is short, run factory.launch, then read the token address back
 * out of the Launched event — never assumed, always from the receipt.
 * Returns { ok, token }; token is '' when the tx confirmed but the event
 * could not be parsed (the launch still happened — the UI only skips the
 * redirect). Exported so the anvil e2e drives the exact path the button runs.
 */
export async function launchTx({
  name, symbol, image = '', description = '',
  twitter = '', telegram = '', website = '',
  supply, quote, tokensForPool, quoteForPool, lockDuration = 0,
  creatorFeeBps = 0, devBuyQuote = 0n, signer,
}) {
  const s = signer || needSigner();
  if (!s) return { ok: false, token: '' };
  const E = ethersLib();
  const f = factoryAddress();
  if (!E || !provider() || !isAddr(f)) return { ok: false, token: '' };
  // The approve covers the seed plus the optional dev buy — both are pulled
  // by the factory inside the one launch transaction.
  const appr = await ensureAllowanceTx({ token: quote, spender: f, amount: quoteForPool + BigInt(devBuyQuote || 0), owner: s.address, signer: s });
  if (!appr.ok) return { ok: false, token: '' };
  const c = new E.Contract(f, BEAR_FACTORY_ABI, s);
  const rc = await sendDexTx(
    () => c.launch(
      [name, symbol, image, description, twitter, telegram, website],
      supply, quote, tokensForPool, quoteForPool, lockDuration,
      creatorFeeBps, devBuyQuote || 0,
    ),
    t('dex.create.launch'),
  );
  if (!rc) return { ok: false, token: '' };
  let token = '';
  for (const log of rc.logs || []) {
    try {
      const parsed = c.interface.parseLog(log);
      if (parsed && parsed.name === 'Launched') { token = parsed.args[1]; break; }
    } catch { /* not ours */ }
  }
  return { ok: true, token };
}

// `onLaunched(address)` fires after a token is live, so the view can open its
// page directly — a fresh launch should land on the token, not back on a list
// the user then has to find it in.
export function bindLaunch(host, onLaunched) {
  const status = $('#dexCreateStatus', host);
  const fileEl = $('#dexCreateFile', host);
  const imgEl = $('#dexCreateImg', host);
  const imgEmpty = $('#dexCreateImgEmpty', host);
  let image = '';

  // Downscale + re-encode until the data URI fits the on-chain byte budget.
  // Tries shrinking the square and lowering JPEG quality in turn; returns a
  // data URI under ONCHAIN_MAX_BYTES (or the smallest we could reach).
  const toOnchainImage = (src) => new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => {
      const base = Math.min(im.width || ONCHAIN_IMAGE_MAX_PX, im.height || ONCHAIN_IMAGE_MAX_PX);
      let best = '';
      for (const px of [ONCHAIN_IMAGE_MAX_PX, 384, 256, 192, 128]) {
        const side = Math.min(px, base);
        const cv = document.createElement('canvas');
        cv.width = side; cv.height = side;
        const ctx = cv.getContext('2d');
        const crop = Math.min(im.width, im.height);
        // centre-crop to a square so every token has a square face
        ctx.drawImage(im, (im.width - crop) / 2, (im.height - crop) / 2, crop, crop, 0, 0, side, side);
        for (const q of [ONCHAIN_QUALITY_START, 0.6, 0.5, 0.4, 0.3]) {
          let out = '';
          try { out = cv.toDataURL('image/jpeg', q); } catch { break; }
          if (out.length <= ONCHAIN_MAX_BYTES) { resolve(out); return; }
          best = out;
        }
      }
      resolve(best); // smallest attempt, still shown so the user sees a face
    };
    im.onerror = () => reject(new Error('decode'));
    im.src = src;
  });

  fileEl.addEventListener('change', async () => {
    const f = fileEl.files && fileEl.files[0];
    if (!f) return;
    if (f.size > MAX_UPLOAD_BYTES) return toast(t('dex.create.imageBig', { mb: '10' }), 'error');
    if (!/^image\//.test(f.type)) return toast(t('dex.create.imageType'), 'error');
    const r = new FileReader();
    r.onload = async () => {
      try {
        const full = String(r.result || '');
        // Show the original immediately, then swap in the compressed one.
        imgEl.src = full; imgEl.hidden = false; imgEmpty.hidden = true;
        image = await toOnchainImage(full);
        imgEl.src = image;
        const kb = Math.round((image.length * 0.75) / 1024);
        const note = $('#dexCreateImgNote', host);
        if (note) note.textContent = t('dex.create.imageStored', { kb: String(kb) });
      } catch {
        return toast(t('dex.create.imageType'), 'error');
      }
    };
    r.readAsDataURL(f);
  });

  // Deploy-the-factory affordance: only when this chain has none yet. The
  // button then owns its busy state through withTxButton, like every other
  // action in the Dex.
  const facBtn = $('#dexLaunchDeployFactory', host);
  if (facBtn) {
    facBtn.addEventListener('click', () => withTxButton(facBtn, t('dex.launch.deployingFactory'), async () => {
      const addr = await deployFactory();
      if (!addr) return;
      const card = facBtn.closest('.card');
      if (card) card.remove();
      toast(t('dex.launch.factoryDeployed', { addr: `${String(addr).slice(0, 10)}…` }));
    }));
  }

  const quoteEl = $('#dexCreateQuote', host);
  const quoteLabelEl = $('#dexLaunchQuoteLabel', host);
  const supplyEl = $('#dexLaunchSupply', host);
  const tokensEl = $('#dexLaunchTokens', host);
  const quoteInEl = $('#dexLaunchQuoteIn', host);
  const lockEl = $('#dexLaunchLock', host);
  const prevEl = $('#dexLaunchPreview', host);
  const feeEl = $('#dexLaunchFee', host);
  const devBuyEl = $('#dexLaunchDevBuy', host);
  const devBuyLabelEl = $('#dexLaunchDevBuyLabel', host);
  const eduBtn = $('#dexLaunchEdu', host);
  eduBtn?.addEventListener('click', () => openEdu('sniper'));

  const paintQuoteLabel = () => {
    const sym = quoteSymFor(quoteEl.value);
    quoteLabelEl.textContent = t('dex.launch.poolQuote', { sym });
    if (devBuyLabelEl) devBuyLabelEl.textContent = t('dex.launch.devBuy', { q: sym });
  };

  // A live read of the launch maths: the opening price the pool will show,
  // and how many tokens the creator keeps. Honest bigint floors — the same
  // rule the pair applies when it opens.
  const refreshPreview = () => {
    if (!prevEl) return;
    const dec = (quoteBy(quoteEl.value) || {}).decimals ?? 18;
    const s = parseAmount(supplyEl.value, 18);
    const tk = parseAmount(tokensEl.value, 18);
    const q = parseAmount(quoteInEl.value, dec);
    if (!s.ok || !tk.ok || !q.ok || tk.value > s.value) { prevEl.textContent = ''; return; }
    const dev = devBuyEl && devBuyEl.value.trim() ? parseAmount(devBuyEl.value, dec) : null;
    const devBit = dev && dev.ok && dev.value > 0n
      ? ` · ${t('dex.launch.previewDev', { v: fmtTok(dev.value, dec, 6), q: quoteSymFor(quoteEl.value) })}`
      : '';
    prevEl.textContent = t('dex.launch.preview', {
      price: fmtTok(quotePerToken(q.value, tk.value, 18), dec, 6),
      q: quoteSymFor(quoteEl.value),
      keep: fmtTok(s.value - tk.value, 18, 0),
    }) + devBit;
  };

  quoteEl.addEventListener('change', () => { paintQuoteLabel(); refreshPreview(); });
  for (const el of [supplyEl, tokensEl, quoteInEl, devBuyEl].filter(Boolean)) el.addEventListener('input', refreshPreview);

  // Supply presets: one tap sets the supply AND keeps the 80% pool seed — a
  // preset that left pool tokens above the supply would fail the form's own
  // validation and read as broken, not quick (report 2026-10-16).
  const presetRow = $('#dexLaunchSupplyPresets', host);
  const paintPresets = () => {
    if (!presetRow || !supplyEl) return;
    const cur = String(supplyEl.value || '').replace(/[^0-9]/g, '');
    for (const b of presetRow.querySelectorAll('[data-supply]')) {
      b.setAttribute('aria-pressed', String(b.dataset.supply === cur));
    }
  };
  presetRow?.addEventListener('click', (ev) => {
    const btn = ev.target && ev.target.closest ? ev.target.closest('[data-supply]') : null;
    if (!btn) return;
    const supply = Number(btn.dataset.supply);
    if (!Number.isFinite(supply) || supply <= 0) return;
    supplyEl.value = String(supply);
    if (tokensEl) tokensEl.value = String(Math.floor(supply * 0.8));
    for (const el of [supplyEl, tokensEl].filter(Boolean)) el.dispatchEvent(new Event('input', { bubbles: true }));
    paintPresets();
  });
  supplyEl?.addEventListener('input', paintPresets);
  paintPresets();
  paintQuoteLabel();
  refreshPreview();

  // ── 3-step wizard ────────────────────────────────────────────────
  let step = 1;
  const stepPanels = ['launch-step-1', 'launch-step-2', 'launch-step-3'];
  const stepBtns = document.querySelectorAll('.launch-step');
  const showStep = (n) => {
    step = n;
    stepPanels.forEach((id, i) => {
      const el = $(id, host);
      if (el) el.hidden = i + 1 !== n;
    });
    stepBtns.forEach((b, i) => {
      b.classList.toggle('launch-step-active', i + 1 === n);
      b.classList.toggle('launch-step-disabled', i + 1 !== n);
      b.setAttribute('aria-selected', String(i + 1 === n));
      b.disabled = i + 1 !== n;
    });
    const err = $(`launch-step-${n}Error`, host);
    if (err) err.textContent = '';
    if (n === 3) paintStep3Summary();
  };

  const clearErr = (id) => { const e = $(id, host); if (e) e.textContent = ''; };
  const setErr = (id, msg) => { const e = $(id, host); if (e) e.textContent = msg; };

  const validSymbol = (s) => /^[A-Z0-9]{1,12}$/.test(s || '');

  const paintStep3Summary = () => {
    const dec = (quoteBy(quoteEl.value) || {}).decimals ?? 18;
    const s = parseAmount(supplyEl.value, 18);
    const tk = parseAmount(tokensEl.value, 18);
    const q = parseAmount(quoteInEl.value, dec);
    const price = s.ok && tk.ok && q.ok && tk.value > 0n ? fmtTok(quotePerToken(q.value, tk.value, 18), dec, 6) : '–';
    const pair = s.ok && tk.ok ? `${fmtTok(tk.value, 18, 0)} ${quoteSymFor(quoteEl.value)} · ${q.ok ? fmtTok(q.value, dec, 6) : '–'} ${quoteSymFor(quoteEl.value)}` : '–';
    const keep = s.ok && tk.ok ? fmtTok(s.value - tk.value, 18, 0) : '–';
    $(`launchSumPrice`, host).textContent = price;
    $(`launchSumPair`, host).textContent = pair;
    $(`launchSumKeep`, host).textContent = keep;
    $(`launchSumGas`, host).textContent = '–'; // gas ditetapkan saat transaksi dikirim (withTxButton)
  };

  $('#launchStep1Next', host).addEventListener('click', () => {
    clearErr('launchStep1Error');
    const name = $('#dexCreateName', host).value.trim();
    let symbol = $('#dexCreateSymbol', host).value.trim().toUpperCase();
    if (!name) { setErr('launchStep1Error', t('launch.error.required')); return; }
    if (!symbol) { setErr('launchStep1Error', t('launch.error.required')); return; }
    if (!validSymbol(symbol)) { setErr('launchStep1Error', t('launch.error.invalidSymbol')); return; }
    $('#dexCreateSymbol', host).value = symbol;
    showStep(2);
  });

  $('#launchStep2Back', host).addEventListener('click', () => { clearErr('launchStep2Error'); showStep(1); });

  $('#launchStep2Next', host).addEventListener('click', () => {
    clearErr('launchStep2Error');
    if (!dexChainOk()) { setErr('launchStep2Error', t('dex.gate.needSepolia')); return; }
    if (!isAddr(factoryAddress())) { setErr('launchStep2Error', t('dex.launch.needFactory')); return; }
    const dec = (quoteBy(quoteEl.value) || {}).decimals ?? 18;
    const supply = parseAmount(supplyEl.value, 18);
    const tokensForPool = parseAmount(tokensEl.value, 18);
    const quoteForPool = parseAmount(quoteInEl.value, dec);
    if (!supply.ok || !tokensForPool.ok || !quoteForPool.ok
      || tokensForPool.value > supply.value || quoteForPool.value <= 0n) {
      setErr('launchStep2Error', t('dex.launch.badAmounts')); return;
    }
    const devBuyRaw = (devBuyEl && devBuyEl.value.trim()) || '';
    if (devBuyRaw) {
      const devBuy = parseAmount(devBuyRaw, dec);
      if (!devBuy.ok || devBuy.value <= 0n) { setErr('launchStep2Error', t('dex.launch.badDevBuy')); return; }
    }
    showStep(3);
  });

  $('#launchStep3Back', host).addEventListener('click', () => { clearErr('launchStep3Error'); showStep(2); });

  $('#launchStep3Review', host).addEventListener('click', async () => {
    clearErr('launchStep3Error');
    if (!dexChainOk()) { setErr('launchStep3Error', t('dex.gate.needSepolia')); return; }
    const signer = needSigner();
    if (!signer) return;
    const name = $('#dexCreateName', host).value.trim();
    const symbol = $('#dexCreateSymbol', host).value.trim();
    const description = $('#dexCreateDesc', host).value.trim();
    const twitter = ($('#dexCreateTwitter', host)?.value || '').trim();
    const telegram = ($('#dexCreateTelegram', host)?.value || '').trim();
    const website = ($('#dexCreateWebsite', host)?.value || '').trim();
    const quote = quoteEl.value || (QUOTE_PRESETS[0] && QUOTE_PRESETS[0].address);
    const dec = (quoteBy(quote) || {}).decimals ?? 18;
    const supply = parseAmount(supplyEl.value, 18);
    const tokensForPool = parseAmount(tokensEl.value, 18);
    const quoteForPool = parseAmount(quoteInEl.value, dec);
    const creatorFeeBps = feeEl ? (Number(feeEl.value) || 0) : 0;
    const devBuyRaw = (devBuyEl && devBuyEl.value.trim()) || '';
    const devBuy = devBuyRaw ? parseAmount(devBuyRaw, dec) : null;
    const lockDuration = Number(lockEl.value) || 0;
    const devBuyQuote = devBuy && devBuy.ok ? devBuy.value : 0n;

    const priceEl = $('#launchSumPrice', host);
    const keepEl = $('#launchSumKeep', host);
    const price = priceEl ? priceEl.textContent : '–';
    const keep = keepEl ? keepEl.textContent : '–';

    const html = `
      <div class="launch-confirm-modal">
        <div class="small mb-8">${escapeHtml(t('launch.confirm.title'))}</div>
        <div class="small mb-8">${escapeHtml(t('launch.confirm.body'))}</div>
        <div class="card mb-8">
          <div class="small mt-8">${escapeHtml(name)} · ${escapeHtml(symbol)}</div>
          <div class="small mt-8">${t('launch.preview.openingPrice')}: <span>${escapeHtml(price)}</span></div>
          <div class="small mt-8">${t('launch.preview.creatorTokens')}: <span>${escapeHtml(keep)}</span></div>
          <div class="small mt-8">${t('launch.preview.pair')}: ${escapeHtml(quoteSymFor(quote))}</div>
          <div class="small mt-8">${t('launch.label.lock')}: ${String(Math.round(lockDuration / 86400))} hari</div>
          <div class="small mt-8">${t('launch.label.creatorFee')}: ${creatorFeeBps} bps</div>
        </div>
        <div class="launch-confirm-actions mt-8">
          <button type="button" class="btn btn-secondary" id="launchConfirmCancel">${escapeHtml(t('launch.confirm.cancel'))}</button>
          <button type="button" class="btn btn-danger" id="launchConfirmOk">${escapeHtml(t('launch.confirm.confirm'))}</button>
        </div>
      </div>`;
    let resolveConfirm;
    const confirmed = new Promise((r) => { resolveConfirm = r; });
    const close = () => { try { closeModal(); } catch { /* already closed */ } };
    openModal(html, { wide: false });
    $('#launchConfirmCancel', host)?.addEventListener('click', () => { close(); resolveConfirm(false); }, { once: true });
    $('#launchConfirmOk', host)?.addEventListener('click', () => { close(); resolveConfirm(true); }, { once: true });
    const ok = await confirmed;
    if (!ok) return;

    const btn = $('#launchStep3Review', host);
    return withTxButton(btn, t('dex.create.sending'), async () => {
      status.textContent = t('dex.launch.sending');
      const res = await launchTx({
        name, symbol, image, description,
        twitter, telegram, website,
        supply: supply.value,
        quote,
        tokensForPool: tokensForPool.value,
        quoteForPool: quoteForPool.value,
        lockDuration,
        creatorFeeBps,
        devBuyQuote: devBuy && devBuy.ok ? devBuy.value : 0n,
        signer,
      });
      if (!res.ok) { return; }
      status.textContent = t('dex.launch.done');
      if (res.token) rememberLaunchedToken({ address: res.token, name, symbol, image });
      if (res.token && onLaunched) onLaunched(res.token);
    });
  });

  showStep(1);
}
