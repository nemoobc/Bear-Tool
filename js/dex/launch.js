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
  t, $, toast, escapeHtml, fmtTok, withTxButton,
  QUOTE_PRESETS, quoteBy, provider, ethersLib, sendDexTx, needSigner, isAddr, dexChainOk,
} from './core.js';
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

      <div class="dex-create-top">
        <div class="dex-create-preview">
          <img id="dexCreateImg" alt="" />
          <input id="dexCreateFile" type="file" accept="image/*" class="sr-file"
                 aria-label="${escapeHtml(t('dex.create.pickImage'))}">
          <div id="dexCreateImgEmpty" class="small">${escapeHtml(t('dex.create.noImage'))}</div>
          <div id="dexCreateImgNote" class="small dex-img-note"></div>
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
        <label class="field-label" for="dexCreateQuote">${escapeHtml(t('dex.create.quote'))}</label>
        <select id="dexCreateQuote" class="input" aria-describedby="dexCreateQuoteWhy">
          ${QUOTE_PRESETS.map((q, i) => `<option value="${escapeHtml(q.address)}"${i === 0 ? ' selected' : ''}>${escapeHtml(q.symbol)} — ${escapeHtml(q.name)}</option>`).join('')}
        </select>
        <div class="small mt-8" id="dexCreateQuoteWhy">${escapeHtml(t('dex.create.quoteWhy'))}</div>
      </div>

      <div class="dex-create-fields mt-8">
        <label class="field-label" for="dexLaunchSupply">${escapeHtml(t('dex.launch.supply'))}</label>
        <input id="dexLaunchSupply" class="input" inputmode="numeric" autocomplete="off" value="1000000000">
        <label class="field-label mt-8" for="dexLaunchTokens">${escapeHtml(t('dex.launch.poolTokens'))}</label>
        <input id="dexLaunchTokens" class="input" inputmode="numeric" autocomplete="off" value="800000000">
        <label class="field-label mt-8" for="dexLaunchQuoteIn" id="dexLaunchQuoteLabel"></label>
        <input id="dexLaunchQuoteIn" class="input" inputmode="decimal" autocomplete="off" placeholder="0.5">
        <label class="field-label mt-8" for="dexLaunchLock">${escapeHtml(t('dex.launch.lock'))}</label>
        <select id="dexLaunchLock" class="input">${lockOpts}</select>
        <div class="small mt-8" id="dexLaunchPreview"></div>
      </div>

      <button id="dexCreateGo" type="button" class="btn btn-primary btn-block mt-8">${escapeHtml(t('dex.create.launch'))}</button>
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
  supply, quote, tokensForPool, quoteForPool, lockDuration = 0, signer,
}) {
  const s = signer || needSigner();
  if (!s) return { ok: false, token: '' };
  const E = ethersLib();
  const f = factoryAddress();
  if (!E || !provider() || !isAddr(f)) return { ok: false, token: '' };
  const appr = await ensureAllowanceTx({ token: quote, spender: f, amount: quoteForPool, owner: s.address, signer: s });
  if (!appr.ok) return { ok: false, token: '' };
  const c = new E.Contract(f, BEAR_FACTORY_ABI, s);
  const rc = await sendDexTx(
    () => c.launch([name, symbol, image, description], supply, quote, tokensForPool, quoteForPool, lockDuration),
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

  const paintQuoteLabel = () => {
    quoteLabelEl.textContent = t('dex.launch.poolQuote', { sym: quoteSymFor(quoteEl.value) });
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
    prevEl.textContent = t('dex.launch.preview', {
      price: fmtTok(quotePerToken(q.value, tk.value, 18), dec, 6),
      q: quoteSymFor(quoteEl.value),
      keep: fmtTok(s.value - tk.value, 18, 0),
    });
  };

  quoteEl.addEventListener('change', () => { paintQuoteLabel(); refreshPreview(); });
  for (const el of [supplyEl, tokensEl, quoteInEl]) el.addEventListener('input', refreshPreview);
  paintQuoteLabel();
  refreshPreview();

  $('#dexCreateGo', host).addEventListener('click', () => {
    if (!dexChainOk()) return toast(t('dex.gate.needSepolia'), 'error');
    const name = $('#dexCreateName', host).value.trim();
    const symbol = $('#dexCreateSymbol', host).value.trim();
    const description = $('#dexCreateDesc', host).value.trim();
    if (!name) return toast(t('dex.create.needName'), 'error');
    if (!symbol) return toast(t('dex.create.needSymbol'), 'error');
    const quote = quoteEl.value || (QUOTE_PRESETS[0] && QUOTE_PRESETS[0].address);
    const dec = (quoteBy(quote) || {}).decimals ?? 18;
    const supply = parseAmount(supplyEl.value, 18);
    const tokensForPool = parseAmount(tokensEl.value, 18);
    const quoteForPool = parseAmount(quoteInEl.value, dec);
    if (!supply.ok || !tokensForPool.ok || !quoteForPool.ok
      || tokensForPool.value > supply.value || quoteForPool.value <= 0n) {
      return toast(t('dex.launch.badAmounts'), 'error');
    }
    if (!isAddr(factoryAddress())) return toast(t('dex.launch.needFactory'), 'error');
    const signer = needSigner();
    if (!signer) return;
    const btn = $('#dexCreateGo', host);
    return withTxButton(btn, t('dex.create.sending'), async () => {
      status.textContent = t('dex.launch.sending');
      const res = await launchTx({
        name, symbol, image, description,
        supply: supply.value,
        quote,
        tokensForPool: tokensForPool.value,
        quoteForPool: quoteForPool.value,
        lockDuration: Number(lockEl.value) || 0,
        signer,
      });
      if (!res.ok) { status.textContent = ''; return; }
      status.textContent = t('dex.launch.done');
      // Remember it locally, so the feed paints it the moment it opens — the
      // chain stays the authority, this is only the instant copy.
      if (res.token) rememberLaunchedToken({ address: res.token, name, symbol, image });
      if (res.token && onLaunched) onLaunched(res.token);
    });
  });
}
