// Bear Tool — js/dex/create.js
// The launchpad's Create Token panel. Lives in js/dex/ (user order: the
// launchpad is part of the Dex, not a sibling folder) and is its own module
// (user order: "jangan di satuin").
//
// The flow is pump.fun's, on Sepolia, with real transactions:
//   1. drop an IMAGE  — a launchpad coin with a blank face is a joke; the
//      picture is read to a data URI and stored on-chain as metadata;
//   2. name / ticker / description;
//   3. see the bonding curve you are about to trade on (real maths, curve.js);
//   4. Launch → compile PumpToken in-browser (solc) → gas → confirm → deploy.
// Nothing is broadcast until the user signs.
import { t } from '../i18n.js';
import { get, set } from '../state.js';
import { getNetworkById, getProvider, getGasPrice } from '../network.js';
import { $, toast, escapeHtml, confirmTx } from '../ui.js';
import { waitForReceipt, receiptVerdict } from '../safetx.js';
import { compileContract } from '../solc.js';
import {
  quoteBuy, graduationProgress, spotPrice, fmtEth,
  VIRTUAL_ETH, VIRTUAL_TOKENS, GRADUATION_ETH, FEE_TOTAL_BPS,
} from './curve.js';
import { PUMP_TOKEN_SOURCE, PUMP_ABI } from './pump-source.js';
import { rememberLaunchedToken } from './tokens.js';

const MAX_IMAGE_BYTES = 128 * 1024; // a data URI has to fit in the constructor
const chainOk = () => (getNetworkById(get('networkId'))?.chainId === 11155111);

export function createHtml() {
  return `
    <div class="dex-create">
      <div class="field-label">${escapeHtml(t('dex.create.title'))}</div>
      <div class="small mb-8">${escapeHtml(t('dex.create.hint'))}</div>

      <div class="dex-create-top">
        <div class="dex-create-preview">
          <img id="dexCreateImg" alt="" />
          <input id="dexCreateFile" type="file" accept="image/*" class="sr-file"
                 aria-label="${escapeHtml(t('dex.create.pickImage'))}">
          <div id="dexCreateImgEmpty" class="small">${escapeHtml(t('dex.create.noImage'))}</div>
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

      <div class="dex-create-curve">
        <div class="small"><strong>${escapeHtml(t('dex.create.curve'))}</strong></div>
        <canvas id="dexCreateCurve" height="90"></canvas>
        <div id="dexCreateCurveInfo" class="small"></div>
      </div>

      <button id="dexCreateGo" type="button" class="btn btn-primary btn-block mt-8">${escapeHtml(t('dex.create.launch'))}</button>
      <div id="dexCreateStatus" class="small mt-8"></div>
    </div>`;
}

export function bindCreate(host) {
  const status = $('#dexCreateStatus', host);
  const fileEl = $('#dexCreateFile', host);
  const imgEl = $('#dexCreateImg', host);
  const imgEmpty = $('#dexCreateImgEmpty', host);
  let image = '';

  fileEl.addEventListener('change', () => {
    const f = fileEl.files && fileEl.files[0];
    if (!f) return;
    if (f.size > MAX_IMAGE_BYTES) return toast(t('dex.create.imageBig'), 'error');
    if (!/^image\//.test(f.type)) return toast(t('dex.create.imageType'), 'error');
    const r = new FileReader();
    r.onload = () => {
      image = String(r.result || '');
      imgEl.src = image;
      imgEl.hidden = false;
      imgEmpty.hidden = true;
    };
    r.readAsDataURL(f);
  });

  // A live peek at the curve you are about to buy on — honest maths from
  // curve.js, drawn before you spend anything.
  drawCurve($('#dexCreateCurve', host));
  const infoEl = $('#dexCreateCurveInfo', host);
  if (infoEl) {
    // The toLocaleString options object is built BEFORE the t() call on
    // purpose: the i18n placeholder-checker parses object literals inside a
    // t(key, {...}) argument as {{params}}, so an inline
    // { maximumFractionDigits: 0 } would look like a missing placeholder.
    const open = Number(spotPrice(VIRTUAL_ETH, VIRTUAL_TOKENS)) / 1e18; // tokens per ETH
    const openText = open.toLocaleString('en-US', { maximumFractionDigits: 0 });
    const gradText = fmtEth(GRADUATION_ETH);
    infoEl.textContent = t('dex.create.curveInfo', { open: openText, grad: gradText });
  }

  $('#dexCreateGo', host).addEventListener('click', async () => {
    if (!chainOk()) return toast(t('dex.gate.needSepolia'), 'error');
    if (!get('unlocked') || !get('signer')) return toast(t('dex.needWallet'), 'error');
    const name = $('#dexCreateName', host).value.trim();
    const symbol = $('#dexCreateSymbol', host).value.trim();
    const desc = $('#dexCreateDesc', host).value.trim();
    if (!name) return toast(t('dex.create.needName'), 'error');
    if (!symbol) return toast(t('dex.create.needSymbol'), 'error');

    const btn = $('#dexCreateGo', host);
    btn.disabled = true;
    status.textContent = t('dex.create.compiling');
    try {
      const compiled = await compileContract(PUMP_TOKEN_SOURCE, 'PumpToken', {
        onStatus: (m) => { status.textContent = m; },
      });
      const E = globalThis.ethers;
      const net = getNetworkById(get('networkId'));
      const provider = await getProvider(net.chainId);
      const signer = get('signer').connect(provider);
      const factory = new E.ContractFactory(compiled.abi, compiled.bytecode, signer);
      const args = [name, symbol, desc, image, VIRTUAL_ETH, VIRTUAL_TOKENS];
      const deployTx = await factory.getDeployTransaction(...args);
      let gasEstimate;
      try {
        gasEstimate = await provider.estimateGas({ ...deployTx, from: get('address') });
      } catch (e) {
        throw new Error(t('dex.create.gasFail') + ': ' + (e?.shortMessage || e?.message || String(e)));
      }
      const gasPrice = await getGasPrice(provider);
      const cost = gasEstimate * gasPrice;

      const ok = await confirmTx({
        title: t('dex.create.confirmTitle', { name }),
        rows: [
          { k: t('dex.create.name'), v: `${name} (${symbol})` },
          { k: t('cf.network'), v: net.name },
          { k: t('dex.create.fee'), v: `${FEE_TOTAL_BPS / 100}% on every trade` },
          { k: t('dex.create.gradAt'), v: fmtEth(GRADUATION_ETH) + ' ' + net.symbol },
          { k: t('cf.transactions'), v: '1' },
          { k: t('dex.create.cost'), v: gasPrice > 0n
            ? `${E.formatEther(cost)} ${net.symbol} (${gasEstimate} gas)`
            : 'unknown' },
        ],
        confirmText: t('cf.confirm'),
        gasWei: cost,
        valueWei: 0,
      });
      if (!ok) { status.textContent = ''; btn.disabled = false; return; }

      status.textContent = t('dex.create.deploying');
      const contract = await factory.deploy(...args);
      const rc = receiptVerdict(await waitForReceipt(contract.deployTransaction, { label: t('dex.create.launch') }));
      if (rc.kind !== 'success') {
        status.textContent = rc.kind === 'failed' ? t('dex.tx.failed') : t('dex.tx.pending', { hash: String(rc.hash || '').slice(0, 10) });
        btn.disabled = false;
        return;
      }
      const addr = await contract.getAddress();
      // The live token list is how you get back to a coin you launched, so a
      // successful deploy registers it there immediately.
      rememberLaunchedToken({ address: addr, name, symbol, image });
      status.innerHTML = `${escapeHtml(t('dex.create.live', { addr }))} `;
      const a = window.document.createElement('a');
      a.href = `${String(net.explorer || '').replace(/\/$/, '')}/address/${addr}`;
      a.target = '_blank'; a.rel = 'noopener';
      a.textContent = t('dex.create.explore');
      status.appendChild(a);
      toast(t('dex.create.done', { symbol }), 'success');
      btn.disabled = false;
    } catch (e) {
      status.textContent = (e && (e.shortMessage || e.message)) || String(e);
      btn.disabled = false;
    }
  });
}

// The curve a buyer walks: price climbs as ETH pours in. Simulated with the
// SAME quote math the contract uses (buy after buy against the moving
// reserves), then plotted from spotPrice — so the picture cannot promise a
// shape the chain will not deliver.
function drawCurve(canvas) {
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width = canvas.clientWidth || 320;
  const h = canvas.height = 90;
  ctx.clearRect(0, 0, w, h);

  // Walk cumulative buys up to the graduation line and record the token's
  // price IN ETH. That is ETH-per-token (vE/vT) and it RISES as buyers pour
  // ETH in — the shape a launchpad chart is expected to have. (spotPrice is
  // the reciprocal, tokens-per-ETH, and falls — plotting it draws a curve
  // that goes the wrong way and looks broken.)
  const prices = [];
  let ve = VIRTUAL_ETH;
  let vt = VIRTUAL_TOKENS;
  const steps = 60;
  for (let i = 0; i <= steps; i++) {
    prices.push(Number(ve) / Number(vt)); // ETH wei per token wei
    const add = GRADUATION_ETH / BigInt(steps);
    const q = quoteBuy(ve, vt, add);
    ve = q.nextVirtualEth;
    vt = q.nextVirtualTokens;
  }
  const max = Math.max(...prices, 1e-12);
  const y = (p) => h - (p / max) * (h - 8) - 4;

  // fill under the curve for weight
  ctx.beginPath();
  ctx.moveTo(0, h);
  prices.forEach((p, i) => ctx.lineTo((i / (prices.length - 1)) * w, y(p)));
  ctx.lineTo(w, h);
  ctx.closePath();
  ctx.fillStyle = 'rgba(232,150,60,0.18)';
  ctx.fill();

  // the line itself
  ctx.beginPath();
  prices.forEach((p, i) => {
    const x = (i / (prices.length - 1)) * w;
    if (i === 0) ctx.moveTo(x, y(p)); else ctx.lineTo(x, y(p));
  });
  ctx.strokeStyle = '#E8963C';
  ctx.lineWidth = 2;
  ctx.stroke();
}

export { PUMP_ABI };
