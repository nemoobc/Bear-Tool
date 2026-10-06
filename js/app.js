// ═══════════════════════════════════════════════════════════════
// Bear Tool — app.js (entry point, slim orchestrator)
// Boot, router, topbar, wallet lifecycle modals, dashboard,
// discord, activity, settings. Feature logic lives in modules:
// send.js / swap.js / bridge.js / eip7702.js / deploy.js / nft.js.
// ═══════════════════════════════════════════════════════════════

// Impor PALING AWAL disengaja: collector memasang hook error +
// pembungkus fetch sebelum modul lain dieksekusi, sehingga kegagalan
// boot pun ikut tertangkap (auto-report → tools/debug-relay.mjs,
// senyap bila relay tak ada).
import './debug-collector.js';

import { POPULAR_TOKENS, ERC20_ABI,
         NETWORKS, getAllNetworks, getNetworkById, getProvider, getDelegation,
         addCustomNetwork, removeCustomNetwork, getCustomNetworks, CHAIN_PRESETS,
         applyRpcOverrides, providerEndpoint, detectNetworkType } from './network.js';
import { resolveSlug, checkEligibility, nftIntel, collectionAsk, contractSafety, costBreakdown, renderCost, renderSignals } from './nft-intel.js';
import * as wallet from './wallet.js';
import { $, $all, toast, openModal, closeModal, spinner, confirmTx, promptPassword,
         fmtAmount, fmtUsd, fmtTime, fmtTimeShort, escapeHtml, animateValue, titleCase } from './ui.js';
import { runIntro, initTheme } from './theme.js';
import { get, set, on, setUnlockHandler, addActivity, loadActivity,
         reconcileActivity, activityMatchesSymbol, getCustomTokens, persistCustomToken } from './state.js';
import { fetchAllPrices, fetchPriceHistory, fetchOHLC, ensureUsdRate, clearUsdRate, isRateLimit, fitCandles } from './price.js';
import { bindSendEvents, loadSendTokens } from './send.js';
import { bindSwapEvents, loadSwapTokens } from './swap.js';
import { bindBridgeEvents, loadBridgeChains } from './bridge.js';
import { loadEip7702 } from './eip7702.js';
import { checkAllNetworks, summarize, STATUS as EIP7702_STATUS } from './eip7702-support.js';
import { bindEip7702ToolsEvents } from './eip7702-tools.js';
import { bindDeployEvents } from './deploy.js';
import { loadNfts } from './nft.js';
import { cancelOrder, fulfillBasicOrder, getOrderStatusOnChain } from './opensea.js';
import { t, setLang, applyTranslations } from './i18n.js';
import { renderDapps, POPULAR_DAPPS } from './dapps.js';
import { dappBrowserOnLock } from './dapp-browser.js';
import { renderSecurityCenter } from './security-center.js';
import { renderDiscord, bindDiscordPanel, finishOAuthRedirect } from './discord.js';
// scanTransaction finally has a caller. It has been written and tested since
// before the Security Center existed, and nothing invoked it — which is why
// that panel had to be rewritten to say the checks are not applied.
import { scanTransaction } from './security.js';
import { createProvider, announceLock, announceAccounts, disconnectOrigin, PROVIDER_FLAG } from './dapp-bridge.js';
import { siteAllowed } from './dapp-sessions.js';
import { startUpdateGuard } from './update-guard.js';
import { checkWL, getMintEstimate, getHighestOffer, getListings, getOffers, cancelListing, listNft, parseOpenSeaInput } from './opensea-api.js';

const { ethers } = globalThis;

// ── boot ──
window.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  setUnlockHandler(showUnlockModal);
  // A "Login with Discord" return lands here (redirect URI = this page) on
  // whatever view was last open. Finish the exchange, strip the one-shot
  // code, then take the user to the view that started it. The no-?code case
  // is a two-parameter URLSearchParams check and returns immediately.
  finishOAuthRedirect().then((done) => {
    if (done) {
      toast('Connected to Discord', 'success');
      switchView('discord');
    }
  }).catch((e) => toast(e.message, 'error'));
  on('refresh', async () => {
    if (!get('address')) return;
    // Awaited: the swap form's balance line and the token lists read the
    // snapshot loadDashboard() writes when it finishes. Fire-and-forget let a
    // successful swap keep showing the PRE-swap balance until a manual refresh
    // (live report, 2026-10-03).
    await loadDashboard();
    if ($('#view-activity').classList.contains('active')) renderActivity();
    if ($('#view-swap')?.classList.contains('active')) loadSwapTokens();
  });
  // Unlocking repaints whatever the user is actually looking at.
  //
  // Every path that sets an address — create, import, unlock, switch account,
  // and the session restore at boot — called loadDashboard() and nothing else.
  // So any view opened while locked stayed blank, and it stayed blank AFTER the
  // unlock too: the view became active, refreshView() bailed out on the missing
  // address, and no unlock path ever re-ran the render for the active view. The
  // dashboard is skipped because each of those call sites already loads it.
  on('address', (addr) => { if (addr) repaintActiveView(); });
  // Re-apply stored per-network RPC overrides before anything builds a
  // provider, or the wallet quietly talks to the public endpoint.
  try { applyRpcOverrides(); } catch { /* a corrupt store must not block boot */ }
  syncMobileNav();
  // The intro is dismissed FIRST, before anything that can throw.
  //
  // A single null.addEventListener in bindViews() once killed the entire module:
  // the TypeError aborted app.js, so runIntro() was never reached, its 2s safety
  // timer was never armed, and the splash stayed on top at z-index 9999 eating
  // every click. The app looked fine in the DOM and was completely unusable —
  // the worst possible failure, because nothing on screen says anything is
  // wrong.
  //
  // So the order matters, and a bind that throws must not be able to strand
  // anyone here. The CSS carries a matching last-resort animation, so even a
  // total failure to load this module still frees the screen.
  try { armIntroDismissal(); } catch { /* the CSS animation is the backstop */ }
  try { bindNav(); } catch (e) { console.error('[BearTool] nav binding failed:', e); }
  try { bindTopbar(); } catch (e) { console.error('[BearTool] topbar binding failed:', e); }
  try { bindViews(); } catch (e) { console.error('[BearTool] view binding failed:', e); }

  // M4 activity: boot-only reconcile left a stuck row pending until the next
  // reload/network switch — settle pending rows while the app stays open.
  setInterval(() => {
    if (!get('unlocked') || !get('provider')) return;
    const pending = (get('activity') || []).some((a) => a && a.status === 'pending' && a.hash);
    if (!pending) return;
    reconcileActivity(get('provider')).then((r) => {
      if (r.settled || r.failed) { emit('activity'); renderActivity(); }
    }).catch(() => { /* honest state stays pending */ });
  }, 45000);
  // Balance auto-refresh: back-to-visible + a 60s tick while the dashboard is
  // on screen (see refreshDashboardBalance for the gates).
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshDashboardBalance();
  });
  setInterval(refreshDashboardBalance, 60000);
  initTheme();
  // The provider must exist before any page can ask, and it answers "locked"
  // on its own until the user signs in — so installing it early is safe.
  installBridge();

  // A refresh must not dump the user back into the password box. The address
  // is not a secret (it is already public on-chain), so restore it and render
  // the app read-only. The password is only needed to SIGN — every signing
  // path already calls requireUnlock(). The decrypted key is never persisted.
  const restored = restoreReadOnlyAccount();
  const boot = () => {
    // Secure-context guard. Web Crypto (crypto.subtle) is only exposed on HTTPS
    // and on localhost. Served over plain HTTP from any other origin the app
    // still LOOKS fine but every keystore operation dies with
    // "Cannot read properties of undefined (reading 'importKey')" — a silent,
    // unexplainable failure. Say so up front instead.
    if (!window.crypto?.subtle) {
      const insecure = location.protocol === 'http:'
        && !['localhost', '127.0.0.1', '::1', ''].includes(location.hostname);
      toast(
        insecure
          ? '⚠️ Insecure context: this page is not HTTPS and not localhost, so Web Crypto is unavailable — the wallet cannot create, import or unlock. Serve over HTTPS or use http://localhost.'
          : '⚠️ Web Crypto (crypto.subtle) is unavailable in this browser context — wallet features are disabled.',
        'error'
      );
      console.warn('[BearTool] crypto.subtle unavailable; secure context required for wallet operations.');
    }
    // Session secret survives a refresh (sessionStorage) and a tab reopen
    // (localStorage fallback, within the auto-lock window): restore the signer
    // and stay unlocked. Lock / auto-lock clears both copies.
    const sessionSecret = wallet.getSession();
    if (sessionSecret) {
      try {
        // A true refresh keeps the sessionStorage copy (always fresh). A
        // tab-reopen restore comes from localStorage — only trust it within
        // the auto-lock window, so closing the tab can't leave the wallet
        // unlocked forever. "Never" (0) falls back to a 24h cap.
        if (!wallet.hasSessionStorage()) {
          const ts = wallet.getSessionTs();
          const minutes = get('settings').autoLock;
          const maxAge = (minutes > 0 ? minutes : 24 * 60) * 60 * 1000;
          if (ts && Date.now() - ts > maxAge) {
            wallet.clearSession();
            throw new Error('Session expired');
          }
        }
        const signer = wallet.signerFromSecret(sessionSecret);
        set('signer', signer);
        set('address', signer.address);
        set('unlocked', true);
        updateTopbar();
        loadDashboard();
        startAutoLock();
        return;
      } catch { wallet.clearSession(); }
    }
    if (restored) { updateTopbar(); loadDashboard(); }
    else if (wallet.getKeystore()) showUnlockModal();
    else showWelcomeModal();
  };
  // The 5s logo intro is a first-impression flourish, not a refresh tax.
  let seen = false;
  try { seen = sessionStorage.getItem('bear.introSeen') === '1'; } catch { /* private mode */ }
  if (seen) {
    const intro = document.getElementById('intro');
    intro?.remove();
    boot();
  } else {
    try { sessionStorage.setItem('bear.introSeen', '1'); } catch { /* ignore */ }
    runIntro(boot);
  }
  window.addEventListener('unhandledrejection', (e) => {
    console.error('[BearTool] unhandled rejection:', e.reason);
    toast('Unexpected error: ' + (e.reason?.message || 'unknown'), 'error');
  });
  window.addEventListener('error', (e) => {
    console.error('[BearTool] uncaught error:', e.message, e.filename, e.lineno);
    toast('Unexpected error: ' + e.message, 'error');
  });

  // ── token search ──
  document.getElementById('tokenSearchInput')?.addEventListener('input', () => {
    if (window._assetTokens) renderAssets(window._assetTokens);
  });

  // ── custom token add ──
  // Paste a contract address and the token identifies itself: name, symbol and
  // decimals are read straight off the contract and shown before you commit, so
  // a wrong paste is obvious instead of silently landing in the asset list as an
  // unlabelled row.
  document.getElementById('btnAddCustomToken')?.addEventListener('click', () => {
    const currentChain = get('networkId') ? (getNetworkById(get('networkId'))?.chainId || 1) : 1;
    openModal(`
      <button class="modal-close" type="button" data-close-modal>✕</button>
      <h2>Add Custom Token</h2>
      <div class="field"><label for="customTokenAddr">Contract Address</label>
        <input class="input" id="customTokenAddr" placeholder="0x... paste an ERC-20 address" autocomplete="off" spellcheck="false"></div>
      <div id="tokenDetect" style="display:none">
        <div class="asset-row" style="border-left:8px solid var(--mint)">
          <div class="net-logo" id="tdIcon" style="font-size:20px">🪙</div>
          <div class="asset-info">
            <div class="asset-name" id="tdSymbol">—</div>
            <div class="asset-symbol" id="tdName">—</div>
          </div>
          <span class="badge" id="tdDecimals">—</span>
        </div>
        <p class="dim small" id="tdNote" style="margin-top:8px"></p>
      </div>
      <!-- There was a Chain ID input here and it was a lie. detect() reads
           through get('provider') - the CURRENT network - so typing a different
           chain re-ran the same probe against the same node and then saved the
           number that was typed alongside a name and decimals read from a
           different chain. The result was a token whose metadata belonged to one
           network and whose chainId said another, with nothing on screen saying
           so. The network is a fact, not a setting: it is shown, not chosen. -->
      <p class="small dim" id="tdNetwork" style="margin:0 0 10px"></p>
      <button class="btn btn-primary btn-block" id="btnConfirmAddToken" disabled>Add Token</button>
    `);

    const addrEl = document.getElementById('customTokenAddr');
    const netEl = document.getElementById('tdNetwork');
    const activeChainId = () => getNetworkById(get('networkId'))?.chainId || currentChain;
    const activeNetName = () => getNetworkById(get('networkId'))?.name || 'this network';
    if (netEl) netEl.textContent = 'Network: ' + activeNetName() + ' (chain ' + activeChainId() + ')';
    const box = document.getElementById('tokenDetect');
    const saveBtn = document.getElementById('btnConfirmAddToken');
    const ERC20 = [
      'function symbol() view returns (string)',
      'function name() view returns (string)',
      'function decimals() view returns (uint8)',
      'function balanceOf(address) view returns (uint256)'
    ];
    // Latest probe wins, so a fast paste-then-edit cannot be overwritten by an
    // older, slower RPC round-trip.
    let probeSeq = 0;

    const reset = () => { box.style.display = 'none'; saveBtn.disabled = true; };

    const detect = async () => {
      const addr = addrEl.value.trim();
      if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) { reset(); return; }
      const provider = get('provider');
      if (!provider) { reset(); return; }
      const mine = ++probeSeq;
      box.style.display = '';
      document.getElementById('tdSymbol').textContent = 'Detecting…';
      document.getElementById('tdName').textContent = '';
      document.getElementById('tdDecimals').textContent = '';
      document.getElementById('tdNote').textContent = 'Reading name, symbol and decimals from the contract…';
      try {
        const c = new ethers.Contract(addr, ERC20, provider);
        // symbol()/name() are optional on some tokens — resolve each defensively.
        const soft = async (fn, fb) => { try { return await fn(); } catch { return fb; } };
        const [sym, nm, dec] = await Promise.all([
          soft(() => c.symbol(), null), soft(() => c.name(), null), soft(() => c.decimals(), 18),
        ]);
        if (mine !== probeSeq) return; // a newer paste won
        if (sym == null && nm == null) {
          reset();
          document.getElementById('tdNote').textContent = 'No ERC-20 name/symbol found at that address on this network.';
          return;
        }
        document.getElementById('tdIcon').textContent = '🪙';
        document.getElementById('tdSymbol').textContent = sym || nm || 'Unknown';
        document.getElementById('tdName').textContent = [nm, sym].filter(Boolean).join(' · ') || '—';
        document.getElementById('tdDecimals').textContent = `${dec} decimals`;
        // Say which network was read, and what to do if it is the wrong one.
        // The old wording offered a control that could not change the answer.
        document.getElementById('tdNote').textContent =
          'Read from ' + activeNetName() + ' (chain ' + activeChainId() + '). '
          + 'Not the token you expected? Switch network first, then paste it again.';
        saveBtn.disabled = false;
        saveBtn.dataset.sym = sym || nm || '';
        saveBtn.dataset.dec = String(dec);
      } catch (e) {
        if (mine !== probeSeq) return;
        reset();
        document.getElementById('tokenDetect').style.display = '';
        document.getElementById('tdNote').textContent = explainError(e, 'Reading that contract');
      }
    };

    // 'paste' covers the common case; 'input' also catches typing/autofill.
    addrEl.addEventListener('paste', () => setTimeout(detect, 0));
    addrEl.addEventListener('input', detect);
    // Switching networks underneath an open modal used to leave a token probed
    // on the old chain looking valid on the new one. Re-probe instead.
    on('networkId', () => { if (!saveBtn.disabled || addrEl.value.trim()) detect(); });

    saveBtn?.addEventListener('click', async () => {
      const addr = addrEl.value.trim();
      // The chain the token was actually read on - never a typed number.
      const chainId = activeChainId();
      if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) return toast('Invalid contract address', 'error');
      const provider = get('provider');
      if (!provider) return toast('Wallet not ready', 'error');
      try {
        const c = new ethers.Contract(addr, ERC20, provider);
        const [sym, dec, bal] = await Promise.all([
          c.symbol().catch(() => saveBtn.dataset.sym || '?'),
          c.decimals().catch(() => Number(saveBtn.dataset.dec) || 18),
          c.balanceOf(get('address') || ethers.ZeroAddress),
        ]);
        const tokens = get('tokens') || [];
        if (tokens.some(t => t.address?.toLowerCase() === addr.toLowerCase())) return toast('Token already added', 'info');
        tokens.push({ address: addr, symbol: sym, decimals: Number(dec), balance: bal.toString(), chainId, usd: null });
        set('tokens', tokens);
        // Persist the typed facts — state.tokens alone dies on refresh.
        persistCustomToken({ address: addr, symbol: sym, decimals: Number(dec), chainId });
        closeModal();
        toast(`✅ ${sym} added!`, 'success');
        if (window._assetTokens) renderAssets(tokens);
      } catch (e) { toast('Failed to fetch token: ' + (e?.message || 'unknown'), 'error'); }
    });
  });

  // ── offline detection ──
  const offlineBanner = document.getElementById('offlineBanner');
  const updateOnline = () => {
    if (navigator.onLine) {
      offlineBanner?.classList.add('hidden');
    } else {
      offlineBanner?.classList.remove('hidden');
    }
  };
  window.addEventListener('online', updateOnline);
  window.addEventListener('offline', updateOnline);
  updateOnline();

  // ── copy-to-clipboard ──
  document.addEventListener('click', async (e) => {
    if (e.target.closest('[data-opensea]')) {
      const btn = e.target.closest('[data-opensea]');
      const { contractAddress, tokenId, chainId } = btn.dataset;
      const selNet = get('networkId') || chainId || 1;
      try {
        if (btn.dataset.opensea === 'cancel') cancelOrder(btn, [window.__openSeaOrderHash || '0x' + '00'.repeat(32)], selNet);
        else if (btn.dataset.opensea === 'fulfill') fulfillBasicOrder(btn, window.__openSeaTestOrder, selNet);
        else toast('OpenSea ' + btn.dataset.opensea + ': butuh order hash (List via OpenSea API dulu)', 'info');
      } catch (err) { toast('OpenSea: ' + (err?.message || err), 'error'); }
      return;
    }

    const btn = e.target.closest('.copy-btn');
    if (!btn) return;
    const text = btn.dataset.copy;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      btn.classList.add('copied');
      toast('Copied!', 'success');
      setTimeout(() => btn.classList.remove('copied'), 1500);
    } catch {
      toast('Copy failed', 'error');
    }
  });

  // A tab open across a rebuild keeps the old bundle in memory; without
  // this the user retests a fix and still sees the old bug (phantom
  // regressions). Polls the served index.html; banners, never auto-reloads.
  startUpdateGuard();
});

// ── settings ──
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('bear.settings') || '{}');
    set('settings', { ...get('settings'), ...s });
  } catch {}
  // Restore persisted network selection (saved when user switches networks)
  try {
    const saved = localStorage.getItem('bear.networkId');
    if (saved) set('networkId', saved);
  } catch {}
  setLang(get('settings').lang || 'en');
  applyTranslations();
}
function saveSettings() {
  localStorage.setItem('bear.settings', JSON.stringify(get('settings')));
}

// ── nav ──
function bindNav() {
  // .nav-item is a <div role="button" tabindex="0"> — it must also respond
  // to Enter/Space, not just click (WCAG 2.1.1 keyboard).
  const activateNav = (item) => {
    const view = item.dataset.view;
    // Swap and Bridge share one nav button: the FIRST click opens Swap;
    // clicking it again from EITHER side of the pair offers the choice. The old
    // check only looked at #view-swap, so pressing Swap while Bridge was active
    // skipped the chooser and yanked the user straight back into Swap (live
    // report, 2026-10-03: "klik bridge, pencet swap, harusnya muncul 2 pilihan
    // lagi").
    const onSwapSide = $('#view-swap')?.classList.contains('active')
      || $('#view-bridge')?.classList.contains('active');
    if (view === 'swap' && onSwapSide) {
      showSwapBridgeChooser();
      return;
    }
    switchView(view);
  };
  // sidebar nav
  $all('.nav-item').forEach(item => {
    item.addEventListener('click', () => activateNav(item));
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        activateNav(item);
      }
    });
  });
  // mobile bottom nav — items are generated by syncMobileNav() before this runs.
  $all('.mobile-nav-item[data-view]').forEach(item => {
    item.addEventListener('click', () => activateNav(item));
  });
  // dashboard quick actions
  $all('.quick-action-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.view) switchView(btn.dataset.view);
    });
  });
  // Receive replaced the Swap shortcut on home — the address + copy live here.
  $('#quickReceive')?.addEventListener('click', () => {
    const net = getNetworkById(get('networkId'));
    showReceiveModal(get('address'), net?.symbol || '');
  });
}

// ── mobile nav, generated from the sidebar ──
// The bottom bar used to be a hand-written list of 6 buttons while the sidebar
// had 9, so EIP-7702, Discord and Tools were reachable on desktop and simply
// did not exist on a phone. Building it from the sidebar makes that class of
// drift impossible: add a view to the sidebar and mobile gets it too.
//
// Five slots, in the order the user named them, and no "More" — a sixth button
// whose contents you had to guess was the wrong trade for a thumb. Reachability
// of the views that no longer fit is preserved WITHOUT the sheet, and each
// route is listed in REACHABLE_ON_MOBILE below so the next person editing this
// can see at a glance that nothing became unreachable.
const MOBILE_PRIMARY = ['dashboard', 'activity', 'swap', 'dapps', 'settings'];

/**
 * Every sidebar view, and how a phone still gets to it now that the bottom bar
 * is five fixed slots. Keep this honest: a view with no route here is a view
 * that exists on desktop and not on mobile, which is the exact bug this bar
 * was rebuilt to remove.
 */
const REACHABLE_ON_MOBILE = {
  send: 'Dashboard quick action',
  deploy: 'Dashboard quick action (Tools)',
  nft: 'Dashboard quick action',
  bridge: 'Second press of Swap',
  discord: 'Dashboard quick action (Discord)',
};

function syncMobileNav() {
  const bar = $('#mobileNav');
  if (!bar) return;
  const items = [...$all('.sidebar .nav-item')].map((el) => {
    const label = el.querySelector('[data-i18n]');
    return {
      view: el.dataset.view,
      label: (label?.textContent || '').trim(),
      icon: el.querySelector('.icon')?.innerHTML || '',
      i18n: label?.dataset.i18n || '',
    };
  }).filter((i) => i.view);
  if (!items.length) return;

  const primary = MOBILE_PRIMARY.filter((v) => items.some((i) => i.view === v));

  // The label span needs its own data-i18n key. It had none, so the key read
  // from the sidebar was collected into `i18n` and then thrown away, and
  // applyTranslations() - which works by scanning [data-i18n] - had nothing to
  // find. The result was a bar that stayed English while the sidebar beside it
  // turned Indonesian, which on a phone is the only nav most people ever see.
  // The initial text is translated here too, so the bar is right on first paint
  // rather than only after applyTranslations runs.
  const cell = (i, active) => {
    const text = i.i18n ? t(i.i18n) : (i.label || i.view);
    return `<button class="mobile-nav-item${active ? ' active' : ''}" data-view="${escapeHtml(i.view)}"
      aria-label="${escapeHtml(text)}">${i.icon ? `<span class="icon">${i.icon}</span>` : ''}<span${i.i18n ? ` data-i18n="${escapeHtml(i.i18n)}"` : ''}>${escapeHtml(text)}</span></button>`;
  };

  bar.innerHTML = primary
    .map((v) => cell(items.find((i) => i.view === v), v === 'dashboard'))
    .join('');
  // Re-apply translations so the generated labels follow the active language.
  applyTranslations?.();
}

function switchView(view) {
  $all('.nav-item').forEach(i => i.classList.remove('active'));
  $all('.mobile-nav-item').forEach(i => i.classList.remove('active'));
  // Bridge lives behind the Swap nav button, so Swap stays highlighted there.
  const navView = view === 'bridge' ? 'swap' : view;
  const sidebarItem = $(`.nav-item[data-view="${navView}"]`);
  const mobileItem = $(`.mobile-nav-item[data-view="${navView}"]`);
  if (sidebarItem) sidebarItem.classList.add('active');
  if (mobileItem) mobileItem.classList.add('active');
  // A view with no bottom-bar button is reached from the Dashboard or from
  // Settings, so no bar item lights up for it. That is honest: the bar is not
  // broken, the view simply is not one of the five.
  $all('.view').forEach(v => v.classList.remove('active'));
  $('#view-' + view).classList.add('active');
  refreshView(view);
}

// Second click on the Swap nav item — pick between same-chain swap and bridge.
function showSwapBridgeChooser() {
  openModal(`
    <button class="modal-close" type="button" data-close-modal>✕</button>
    <div class="tx-confirm">
      <img src="assets/bear.svg" alt="Bear Tool">
      <div class="question">Swap or Bridge?</div>
    </div>
    <div class="quick-actions" style="grid-template-columns:1fr 1fr">
      <button class="quick-action-btn" id="chooseSwap">
        <span class="qa-icon"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg></span>
        <span class="qa-label">Swap</span>
      </button>
      <button class="quick-action-btn" id="chooseBridge">
        <span class="qa-icon"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg></span>
        <span class="qa-label">Bridge</span>
      </button>
    </div>
  `);
  $('#chooseSwap').onclick = () => { closeModal(); switchView('swap'); };
  $('#chooseBridge').onclick = () => { closeModal(); switchView('bridge'); };
}

export function refreshView(view) {
  // The dApp catalogue is a hardcoded list (POPULAR_DAPPS) and needs no wallet.
  //
  // It used to sit below the address guard, which made an empty page out of it.
  // Measured on the deployed site, no wallet: the view was active and displayed,
  // #dappsContainer had an innerHTML of length 0, #dappGrid was never created,
  // and the console was completely silent — no error, no lock prompt, nothing to
  // tell the user why the DApps screen was blank. Browsing a catalogue of links
  // is not a wallet operation, so it is rendered before the guard.
  if (view === 'dapps') renderDapps($('#dappsContainer'));
  // The Discord view talks to Discord, not to the chain: like the dApp
  // catalogue it renders before the address guard, or a locked wallet shows
  // an empty page with no way to connect.
  if (view === 'discord') renderDiscord($('#discordRoot'));
  if (!get('address')) return;
  if (view === 'dashboard') loadDashboard();
  if (view === 'send') loadSendTokens();
  if (view === 'swap') loadSwapTokens();
  if (view === 'bridge') loadBridgeChains();
  if (view === 'deploy') { loadEip7702(); bindOpenSeaPanel(); }
  if (view === 'nft') loadNfts();
  if (view === 'activity') renderActivity();
  // The Security Center is back in Settings (M3) — its documented original
  // home, and the only home left once Approvals was removed. It lives in a
  // collapsed <details>, which is what fixes the reason it left: an expanded
  // six-section block made Settings 2500px and buried the delete button.
  if (view === 'settings') renderSecurityCenter($('#securityCenter'));

}

/**
 * Re-render the view the user is actually looking at.
 *
 * Called on unlock, because every path that sets an address — create, import,
 * unlock, switch account, session restore at boot — loaded the dashboard and
 * nothing else. A view opened while locked therefore stayed blank, and it stayed
 * blank after the unlock too: it was already active, refreshView() had bailed on
 * the missing address, and nothing re-ran it. The dashboard is excluded because
 * each of those call sites already loads it.
 *
 * Exported so a test can drive it. It reads the active view from the DOM rather
 * than from a variable, which is the same source of truth switchView() uses to
 * decide what is visible — the two cannot drift.
 */
export function repaintActiveView() {
  const active = $('.view.active')?.id?.replace(/^view-/, '');
  if (!active || active === 'dashboard') return false;
  refreshView(active);
  return true;
}

// ── dApp bridge ──────────────────────────────────────────────────────────
// window.ethereum, for pages served from this wallet's own origin. See
// dapp-bridge.js for why a cross-origin dApp can never see it, and
// Settings → Security for what the user is told.
let bearProvider = null;

// Run the transaction detectors over a dApp's request. security.js has had
// scanTransaction — unlimited approval, operator grant, off-chain permit,
// unreadable selector, first-time contract, large value — written and tested
// since before this existed, and nothing ever called it. The Security Center was
// rewritten to admit that; this is the other half, which is to actually run it.
function scanSignCall(method, params) {
  try {
    const tx = Array.isArray(params) ? (params[0] || {}) : {};
    const known = (get('tokens') || []).map((t) => t.address).filter(Boolean);
    // scanTransaction returns { risk, findings, approval } — an object, not a
    // list. Returning it whole and then calling .find() on it is the kind of
    // mistake the browser test exists to catch: it threw "findings.find is not
    // a function" the first time a dApp actually sent a transaction.
    const r = scanTransaction({
      to: tx.to,
      data: tx.data,
      value: tx.value ?? 0,
      knownContracts: known,
    });
    return Array.isArray(r?.findings) ? r.findings : [];
  } catch {
    // A detector that throws must not become a way to block signing.
    return [];
  }
}

// Describe what is being asked for, in words, before anyone signs it.
function describeSignCall(method, params) {
  const p = Array.isArray(params) ? (params[0] || {}) : {};
  const rows = [{ k: 'Method', v: method }];
  if (method === 'personal_sign') {
    let text = '';
    try { text = String(typeof p === 'string' ? p : (p && p.message) || ''); } catch { /* not a string */ }
    rows.push({ k: 'Message', v: text ? text.slice(0, 160) : '(binary)' });
  } else if (String(method).startsWith('eth_signTypedData')) {
    rows.push({ k: 'Typed data', v: typeof p === 'string' ? p.slice(0, 160) + '…' : JSON.stringify(p).slice(0, 160) + '…' });
  } else {
    if (p.to) rows.push({ k: 'To', v: String(p.to) });
    if (p.value && BigInt(p.value) > 0n) rows.push({ k: 'Value', v: formatNativeValue(p.value) });
    if (p.data && p.data !== '0x') rows.push({ k: 'Calldata', v: String(p.data).slice(0, 74) + '…' });
    else rows.push({ k: 'Calldata', v: 'none — a plain transfer' });
  }
  return rows;
}

function formatNativeValue(wei) {
  try { return ethers.formatEther(BigInt(wei)) + ' native'; } catch { return String(wei); }
}

function installBridge() {
  if (globalThis[PROVIDER_FLAG]) return bearProvider;
  bearProvider = createProvider({
    origin: location.origin,
    getAddress: () => get('address'),
    isUnlocked: () => !!get('unlocked'),
    getChainId: () => get('networkId') || 1,
    onRequest: async ({ method, params, kind, origin }) => {
      if (kind === 'consent') {
        return confirmTx({
          title: '🔗 Connect this site?',
          rows: [
            { k: 'Site', v: origin },
            { k: 'Gets', v: method === 'eth_requestAccounts' ? 'your address (read-only)' : String(method) },
          ],
          confirmText: 'Connect',
        });
      }
      if (kind === 'permission') {
        return confirmTx({
          title: '⚠️ Authorise ' + method + '?',
          danger: method === 'eth_sendTransaction',
          rows: [
            { k: 'Site', v: origin },
            { k: 'Method', v: method },
            { k: 'Grant', v: 'Stays until you revoke it in Settings → Security' },
          ],
          confirmText: 'Authorise',
        });
      }
      if (kind === 'sign') {
        // A signing or spending call, confirmed every time. This is where the
        // detectors that already exist in security.js finally run: they were
        // written, tested and never called from anywhere, while the Security
        // Center described them as "applied to every transaction".
        const findings = scanSignCall(method, params);
        const worst = findings.find((f) => f.level === 'fail') || findings.find((f) => f.level === 'warn');
        const okToSign = await confirmTx({
          title: worst ? (worst.level === 'fail' ? '🚨 ' : '⚠️ ') + method + '?' : '✍️ ' + method + '?',
          danger: !!(worst && worst.level === 'fail'),
          rows: [
            { k: 'Site', v: origin },
            ...describeSignCall(method, params),
            ...(findings.length
              ? [{ k: 'Flags', v: findings.map((f) => `${f.level.toUpperCase()}: ${f.title}`).join(' · ') }]
              : []),
            ...(worst ? [{ k: 'Why', v: worst.detail }] : []),
          ],
          confirmText: worst && worst.level === 'fail' ? 'Send anyway' : 'Confirm',
          cancelText: 'Cancel',
          // Money line for spending calls: the request's own tx object
          // carries value + calldata, so the dialog can price what the site
          // is asking for (user, 2026-10-06). Read-only signs add no row.
          ...(method === 'eth_sendTransaction' && Array.isArray(params) && params[0]
            ? { tx: { to: params[0].to, data: params[0].data, value: params[0].value } }
            : {}),
        });
        if (!okToSign) return null;
      }
      // Plain calls: hand the request to the node the wallet is already using.
      const provider = get('provider');
      if (!provider) throw new Error('No RPC provider.');
      return provider.send(method, ...params);
    },
  });
  globalThis[PROVIDER_FLAG] = bearProvider;
  if (!globalThis.ethereum) globalThis.ethereum = bearProvider;
  // The browser toolbar calls this to cut a site off. Defined here because this
  // is the only place that holds both the provider and the session store.
  window.__bearDisconnectSite = (origin) => {
    disconnectOrigin(bearProvider, origin);
    toast('Disconnected ' + origin, 'info');
  };
  return bearProvider;
}

function bridgeLocked() {
  if (bearProvider) announceLock(bearProvider);
  // A site that was waved through earlier in this session does not get a
  // free pass just because the wallet was locked and reopened.
  dappBrowserOnLock();
}

function bridgeAccounts() {
  if (bearProvider) announceAccounts(bearProvider, get('address'));
}

// ── OpenSea panel (WL check + Accept Top Offer + Coin Price) ──
function bindOpenSeaPanel() {
  if (window._osPanelBound) return;
  window._osPanelBound = true;
  const status = () => $('#openSeaStatus');

  // OpenSea API v2 answers 401 to keyless browser requests (the same URL
  // returns 200 from curl), so the key has to come from somewhere. The api
  // module already reads globalThis.__OPENSEA_API_KEY; wire the field to it and
  // remember it. Stored in localStorage like the rest of the settings — this is
  // a public read key, never a wallet secret.
  const keyInput = $('#openSeaApiKey');
  if (keyInput) {
    let saved = '';
    try { saved = localStorage.getItem('bear.openseaKey') || ''; } catch { /* private mode */ }
    keyInput.value = saved;
    globalThis.__OPENSEA_API_KEY = saved;
    keyInput.addEventListener('change', () => {
      const v = keyInput.value.trim();
      globalThis.__OPENSEA_API_KEY = v;
      try {
        if (v) localStorage.setItem('bear.openseaKey', v);
        else localStorage.removeItem('bear.openseaKey');
      } catch { /* private mode */ }
      if (keyInput) paintKeyState(v);
    });
  }

  // The guide above needs honest feedback about the key, otherwise "wajib" is
  // just a word: whether one is saved, and whether OpenSea actually accepts it.
  // The test is a real authenticated request — a local check could not tell the
  // difference between a valid key and a revoked one.
  const keyState = $('#openSeaKeyState');
  function paintKeyState(key) {
    if (keyState) keyState.textContent = key ? t('os.key.saved') : t('os.key.none');
  }
  paintKeyState((keyInput?.value || '').trim());

  $('#btnRevealOsKey')?.addEventListener('click', () => {
    if (!keyInput) return;
    const showing = keyInput.type === 'text';
    keyInput.type = showing ? 'password' : 'text';
    $('#btnRevealOsKey').setAttribute('aria-pressed', String(!showing));
  });

  $('#btnTestOsKey')?.addEventListener('click', async () => {
    if (!keyInput) return;
    const key = keyInput.value.trim();
    if (!key) { if (keyState) keyState.textContent = t('os.key.none'); return; }
    if (keyState) keyState.textContent = t('os.key.testing');
    try {
      // limit=1 keeps the probe small; a 200/401 split is the whole answer.
      const res = await fetch('https://api.opensea.io/api/v2/collections/cryptopunks?limit=1', {
        headers: { 'x-api-key': key, accept: 'application/json' },
      });
      if (keyState) {
        keyState.textContent = res.ok ? t('os.key.ok') : t('os.key.bad', { code: res.status });
        keyState.classList.toggle('dim', res.ok);
        keyState.classList.toggle('key-bad', !res.ok);
      }
    } catch {
      if (keyState) keyState.textContent = '⚠️ Offline / request failed.';
    }
  });

  // Check WL — collection from the contract field (OpenSea link / slug /
  // contract address, auto-parsed) + wallet from the new address field,
  // falling back to the active wallet. No hardcoded collection.
  // Drop intel: is this address actually eligible, what would it cost, and is
  // anything about the contract a red flag. Every number is labelled with where
  // it came from, and a private project allowlist is reported as unknowable
  // rather than guessed.
  $('#btnCheckWL')?.addEventListener('click', async () => {
    const statusEl = status(); if (!statusEl) return;
    const input = $('#openSeaContract')?.value?.trim();
    const addr = $('#openSeaWlAddress')?.value?.trim() || get('address');
    const chainId = getNetworkById(get('networkId'))?.chain || 'ethereum';
    if (!input) return statusEl.textContent = 'Isi link OpenSea / slug / address kontrak dulu.';
    if (!addr) return statusEl.textContent = 'Wallet belum terhubung — isi "Wallet for WL check" manual.';
    statusEl.textContent = 'Menganalisis koleksi…';
    try {
      const r = await resolveSlug(input, chainId);
      const verdict = await checkEligibility({ slug: r.slug, address: addr });

      const head = `<div class="intel-head"><strong>${escapeHtml(r.slug)}</strong>`
        + `<span class="small mono">${escapeHtml(wallet.shortAddress(addr))}</span></div>`;

      if (verdict.error) {
        statusEl.innerHTML = head + `<p class="intel-verdict intel-warn">⚠️ ${escapeHtml(verdict.error)}</p>`;
        return;
      }

      if (!verdict.eligible) {
        // Not a holder: the user asked for "kalau ga elig yaudah" — so say so
        // briefly, with the reason, and stop. No cost, no safety theatre.
        statusEl.innerHTML = head
          + `<p class="intel-verdict intel-fail">✖ Tidak eligible — alamat ini bukan holder koleksi.</p>`
          + `<p class="small dim">${escapeHtml(verdict.note)}</p>`;
        return;
      }

      // Eligible → gather the rest.
      statusEl.textContent = 'Eligible — menghitung biaya & memeriksa kontrak…';
      const intel = r.contract ? await nftIntel({ contract: r.contract, tokenId: r.input?.tokenId, chain: chainId }).catch(() => null) : null;
      const ask = r.slug ? await collectionAsk({ slug: r.slug, chain: chainId }).catch(() => ({ lowest: null })) : { lowest: null };
      const gasWei = await estimateMintGas(r.contract, addr).catch(() => 0n);
      const ethUsd = await ethPriceUsd().catch(() => null);
      const cost = costBreakdown({
        askEth: ask.lowest?.price ?? 0,
        gasWei,
        ethUsd,
      });
      const safety = r.contract
        ? await contractSafety(get('provider'), r.contract, { intel }).catch((e) => ({
            signals: [{ level: 'warn', label: 'Pemeriksaan gagal', detail: String(e?.message || e).slice(0, 120) }],
            verdict: 'unknown',
            note: 'Tidak bisa menyelesaikan pemeriksaan.',
          }))
        : { signals: [], verdict: 'unknown', note: 'Butuh address kontrak untuk memeriksa keamanan.' };

      const hold = intel?.estimatedUsd != null
        ? `Estimasi nilai item: ${escapeHtml(fmtUsd(intel.estimatedUsd))}`
        : '';

      statusEl.innerHTML = head
        + `<p class="intel-verdict intel-pass">✔ Eligible — alamat ini holder`
          + `${verdict.holds > 1 ? ' (' + verdict.holds + ' item)' : ''}.</p>`
        + `<p class="small dim">${escapeHtml(verdict.note)}</p>`
        + (hold ? `<p class="small">${hold}</p>` : '')
        + `<h4 class="intel-h">Biaya</h4>${renderCost(cost)}`
        + `<h4 class="intel-h">Keamanan kontrak</h4>`
          + `<ul class="intel-signals">${renderSignals(safety.signals)}</ul>`
          + `<p class="small dim">${escapeHtml(safety.note)}</p>`;
    } catch (e) {
      statusEl.textContent = '⚠️ ' + explainError(e, 'Eligibility check');
    }
  });

  // Real gas for one mint, from the wallet's own provider. A bare estimateGas
  // against a mint() we cannot know the arguments of is not honest, so when the
  // ABI is not available the estimate is 0 and the UI says so rather than
  // inventing a number.
  async function estimateMintGas(contract, from) {
    const provider = get('provider');
    if (!provider || !contract) return 0n;
    try {
      const iface = new ethers.Interface(['function mint(uint256 quantity)']);
      const data = iface.encodeFunctionData('mint', [1]);
      const gas = await provider.estimateGas({ from, to: contract, data });
      const fee = await provider.getFeeData();
      const price = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
      return gas * BigInt(price);
    } catch {
      return 0n;   // shown as "—" / 0 in the breakdown, never faked
    }
  }

  async function ethPriceUsd() {
    const net = getNetworkById(get('networkId'));
    const prices = await fetchAllPrices([net?.symbol || 'ETH']);
    const p = prices?.[net?.symbol || 'ETH'];
    return Number.isFinite(Number(p)) ? Number(p) : null;
  }

  // List NFT
  $('#btnOpenSeaList')?.addEventListener('click', async () => {
    const s = status(); if (!s) return;
    const contract = $('#openSeaContract')?.value?.trim();
    const tokenId = $('#openSeaTokenId')?.value?.trim();
    const price = $('#openSeaPrice')?.value?.trim();
    if (!contract || !tokenId || !price) return s.textContent = 'Fill contract, token ID, and price.';
    s.textContent = 'Listing...';
    try {
      const net = getNetworkById(get('networkId'));
      await listNft({ contractAddress: contract, tokenId, price, chainId: net?.chainId || 1 });
      s.textContent = '✅ Listing submitted!';
    } catch (e) { s.textContent = '⚠️ ' + explainError(e, 'Listing'); }
  });
  // Cancel listing
  $('#btnOpenSeaCancel')?.addEventListener('click', async () => {
    const s = status(); if (!s) return;
    const contract = $('#openSeaContract')?.value?.trim();
    const tokenId = $('#openSeaTokenId')?.value?.trim();
    if (!contract || !tokenId) return s.textContent = 'Fill contract and token ID to cancel.';
    s.textContent = 'Cancelling...';
    try {
      const net = getNetworkById(get('networkId'));
      await cancelListing({ contractAddress: contract, tokenId, chainId: net?.chainId || 1 });
      s.textContent = '✅ Listing cancelled!';
    } catch (e) { s.textContent = '⚠️ ' + explainError(e, 'Cancelling the listing'); }
  });
  // Accept top offer — needs contract (+token ID); a full asset link works too
  $('#btnAcceptTopOffer')?.addEventListener('click', async () => {
    const s = status(); if (!s) return;
    const input = $('#openSeaContract')?.value?.trim();
    const tokenId = $('#openSeaTokenId')?.value?.trim();
    const parsed = parseOpenSeaInput(input || '');
    const contract = parsed?.contract || input;
    if (!contract || !tokenId) return s.textContent = 'Isi kontrak (atau link asset) + token ID dulu.';
    s.textContent = 'Finding top offer...';
    try {
      const result = await getHighestOffer({ contract, tokenId });
      s.textContent = result?.price ? `Top offer: $${result.price} — ready to accept.` : 'No active offers found.';
    } catch { s.textContent = '⚠️ Could not fetch offers.'; }
  });
}

// ── topbar ──
function bindTopbar() {
  $('#btnHome').addEventListener('click', () => {
    switchView('dashboard');
  });
  // The pills are divs (role="button", tabindex="0" in index.html) so they need
  // the same Enter/Space wiring the sidebar nav items get above — otherwise
  // they are mouse-only and unreachable by keyboard.
  const pillKey = (el, open) => el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  });
  $('#networkPill').addEventListener('click', showNetworkModal);
  $('#accountPill').addEventListener('click', showAccountModal);
  pillKey($('#networkPill'), showNetworkModal);
  pillKey($('#accountPill'), showAccountModal);
}

// ── auto-detect EIP-7702 delegation (M4): top-line badge driven by the
// topbar (boot / unlock / network switch / account switch). Unknown (RPC
// error) stays hidden — reporting "EOA" when the check failed would be a lie.
let delegationBadgeKey = '';
async function updateDelegationBadge() {
  const el = $('#delegationBadge');
  if (!el) return;
  const addr = get('address');
  const netId = get('networkId');
  if (!addr || !netId) { el.hidden = true; el.dataset.state = ''; return; }
  const key = netId + ':' + addr;
  if (key === delegationBadgeKey && el.dataset.state) return;
  try {
    const net = getNetworkById(netId);
    const provider = await getProvider(net.chainId);
    const delegate = await getDelegation(provider, addr);
    if (netId + ':' + get('address') !== key) return; // stale race → next tick
    delegationBadgeKey = key;
    el.dataset.state = delegate ? 'delegated' : 'eoa';
    el.hidden = false;
    el.className = 'delegation-badge ' + (delegate ? 'delegated' : 'eoa');
    el.textContent = delegate ? `7702 ${delegate.slice(0, 10)}…` : 'EOA';
    el.title = delegate ? `Delegated to ${delegate}` : 'Plain EOA (no delegation)';
  } catch {
    el.hidden = true; el.dataset.state = ''; delegationBadgeKey = '';
  }
}

// Exported: walletconnect.js repaints the pill after a dApp-driven chain
// switch, so the topbar and the chain the dApp was told agree.
export function updateTopbar() {
  const net = getNetworkById(get('networkId'));
  const pill = $('#networkPill');
  pill.className = 'network-pill ' + (net?.type || 'mainnet');
  const netLogoEl = pill.querySelector('.net-logo');
  if (netLogoEl) netLogoEl.innerHTML = getNetworkLogo(net?.name, 18);
  else {
    const logoWrap = document.createElement('span');
    logoWrap.className = 'net-logo';
    logoWrap.innerHTML = getNetworkLogo(net?.name, 18);
    pill.prepend(logoWrap);
  }
  // Remove the old .dot span if present
  const oldDot = pill.querySelector('.dot');
  if (oldDot) oldDot.remove();
  $('#networkName').textContent = net?.name || '?';
  // Prefer the wallet name the user set at create/import time; fall back to the
  // short address for legacy accounts saved before names existed.
  const addr = get('address');
  let label = '';
  if (addr) {
    let name = '';
    try {
      const accounts = wallet.getAccounts() || [];
      name = accounts[wallet.getActiveAccountIndex()]?.name || '';
    } catch { /* storage unavailable */ }
    label = name || wallet.shortAddress(addr);
    if (!get('unlocked')) label = '🔒 ' + label;
  }
  $('#accountShort').textContent = label || 'Not connected';
  updateDelegationBadge();
}

// ── welcome / unlock modals ──
function showWelcomeModal() {
  openModal(`
    <div class="welcome-full">
      <div class="welcome-logo">
        <img src="assets/bear.svg" alt="Bear Tool" style="width:80px;height:80px">
      </div>
      <h1 class="welcome-title">Bear Tool</h1>
      <p class="welcome-sub">Self-custody wallet</p>
      <div class="welcome-actions">
        <button class="btn btn-primary btn-lg btn-block" id="wCreate">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Create Wallet
        </button>
        <button class="btn btn-secondary btn-lg btn-block" id="wImport">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Import Wallet
        </button>
      </div>
    </div>
  `, { fullscreen: true });
  $('#wCreate').onclick = () => { closeModal(); showCreateModal(); };
  $('#wImport').onclick = () => { closeModal(); showImportModal(); };
}

function showUnlockModal() {
  openModal(`
    <button class="modal-close" type="button" data-close-modal>✕</button>
    <div class="tx-confirm">
      <img src="assets/bear.svg" alt="Bear Tool">
      <div class="question">${escapeHtml(t('unlock.title'))}</div>
      <div class="field">
        <label for="unlockPw">Password</label>
        <input class="input" id="unlockPw" type="password">
      </div>
      <button class="btn btn-primary btn-block" id="unlockBtn">${escapeHtml(t('unlock.button'))}</button>
    </div>
  `, { wide: true });
  const pw = $('#unlockPw');
  pw.focus();
  const doUnlock = async () => {
    try {
      const { signer, secret } = await wallet.unlockSession(pw.value);
      set('signer', signer);
      set('address', signer.address);
      set('unlocked', true);
      wallet.saveSession(secret);
      pw.value = '';
      closeModal();
      toast('Wallet unlocked! 🐻', 'success');
      updateTopbar();
      loadDashboard();
      startAutoLock();
    } catch (e) {
      toast('Wrong password: ' + e.message, 'error');
    }
  };
  $('#unlockBtn').onclick = doUnlock;
  pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') doUnlock(); });
}

function showCreateModal() {
  openModal(`
    <h2>🐻 Create Wallet</h2>
    <div class="field">
      <label for="createName">Wallet (optional)</label>
      <input class="input" id="createName" type="text" maxlength="40">
    </div>
    <div class="field">
      <label for="createPw">Password (min 8 chars)</label>
      <input class="input" id="createPw" type="password">
    </div>
    <div class="field">
      <label for="createPw2">Repeat password</label>
      <input class="input" id="createPw2" type="password">
    </div>
    <div class="danger-box">⚠️ You will see your seed phrase ONCE. Write it down. Anyone with it controls your funds.</div>
    <button class="btn btn-primary btn-block btn-lg" id="createBtn">Create</button>
    <button class="btn btn-ghost btn-block mt-8" id="createBack" type="button">Back</button>
  `, { wide: true });
  // Back out to the welcome screen. openModal replaces the sheet in place, so
  // this is a plain re-open — no closeModal() first, or the overlay would blink
  // closed and open again.
  $('#createBack').onclick = () => { showWelcomeModal(); };
  $('#createBtn').onclick = async () => {
    const p1 = $('#createPw').value, p2 = $('#createPw2').value;
    if (p1.length < 8) return toast('Password too short (min 8)', 'error');
    if (p1 !== p2) return toast('Passwords do not match', 'error');
    try {
      const res = await wallet.createWallet(p1, $('#createName').value);
      $('#createPw').value = ''; $('#createPw2').value = '';
      showSeedPhrase(res.mnemonic, res.address);
    } catch (e) { toast('Error: ' + e.message, 'error'); }
  };
}

function showSeedPhrase(mnemonic, address) {
  const words = mnemonic.split(' ');

  // TIGA posisi acak harus dikonfirmasi, bukan satu. Versi lamaieb 取 satu
  // indeks dari tiga lalu memakai hanya itu — `indices[0]`/`indices[1]`
  // dihitung lalu dibuang, jadi verifikasi cuma 1 dari 12 kata. anyone yang
  // kebetulan melihat satu kata bisa lolos. Tiga posisi, tiga klik.
  const ask = [];
  while (ask.length < 3) {
    const r = Math.floor(Math.random() * words.length);
    if (!ask.includes(r)) ask.push(r);
  }

  let qPos = 0;                 // pertanyaan ke berapa (0-based)
  const done = [];              // kata yang sudah benar, urutan dijawab
  let busy = false;             // kunci klik ganda saat transisi

  const answer = () => words[ask[qPos]];

  // Tiga pilihan: satu benar + dua dari mnemonic lain, posisi benar diacak
  // ulang tiap pertanyaan supaya tidak selalu di slot yang sama.
  const rollChoices = () => {
    const correct = answer();
    const pool = [];
    while (pool.length < 2) {
      const w = words[Math.floor(Math.random() * words.length)];
      if (w !== correct && !pool.includes(w)) pool.push(w);
    }
    const c = [...pool];
    c.splice(Math.floor(Math.random() * 3), 0, correct);
    return c;
  };

  // Tidak ada tombol ✕ lagi. Dulu ada, dan menutupnya membiarkan wallet
  // ter-generate tapi tidak pernah `saveSession` — seed hilang, tidak ada error,
  // tidak ada jalan pulih. Sekarang satu-satunya jalan keluar yang aman:
  // konfirmasi lengkap, atau "Start over" yang mengulang dari awal dengan
  // wallet BARU (wallet terlantar tidak pernah disimpan, jadi tidak menggantung).
  openModal(`
    <h2>🔑 Your Seed Phrase</h2>
    <div class="danger-box">Write these 12 words DOWN. Never share them. Never type them into any website.</div>
    <div class="card" style="box-shadow:none;background:var(--cream)">
      <div class="seed-words">${words.map((w, i) => `<div class="seed-word"><b>${i + 1}.</b><span>${escapeHtml(w)}</span></div>`).join('')}</div>
    </div>
    <button class="copy-btn btn btn-ghost btn-block mt-8" data-copy="${escapeHtml(mnemonic)}"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy seed phrase</button>
    <div class="field">
      <p class="question-label" id="seedQLabel">Select word #${ask[qPos] + 1} to confirm</p>
      <div class="seed-choices" id="seedChoices" role="group" aria-labelledby="seedQLabel"></div>
    </div>
    <p class="small text-center" id="seedProg">Confirmation 1 of 3</p>
    <button class="btn btn-primary btn-block" id="seedDone" disabled>I saved it</button>
    <button class="btn btn-ghost btn-block mt-8" id="seedRestart">Back</button>
  `, { wide: true });

  const paint = () => {
    $('#seedChoices').innerHTML = rollChoices()
      .map(w => `<button class="btn btn-ghost seed-choice-btn" data-word="${escapeHtml(w)}">${escapeHtml(w)}</button>`)
      .join('');
    $('#seedQLabel').textContent = `Select word #${ask[qPos] + 1} to confirm`;
    $('#seedProg').textContent = `Confirmation ${qPos + 1} of 3`;
  };
  paint();

  // Delegasi, bukan listener per tombol: paint() mengganti innerHTML, jadi
  // listener yang menempel di tombol lama akan hilang bersama tombolnya.
  $('#seedChoices').addEventListener('click', (e) => {
    const btn = e.target.closest('.seed-choice-btn');
    if (!btn || busy) return;
    if (btn.dataset.word === answer()) {
      busy = true;
      btn.classList.add('correct');
      done.push(btn.dataset.word);
      $('#seedDone').disabled = done.length < 3;
      if (done.length < 3) {
        setTimeout(() => { qPos++; busy = false; paint(); }, 420);
      } else {
        setTimeout(() => { busy = false; }, 420);
      }
    } else {
      // Salah: tandai merah, lalu ACAK ULANG pilihan untuk pertanyaan yang
      // sama. Pertanyaannya tidak berubah, cuma susunan jawabannya.
      btn.classList.add('wrong');
      $all('#seedChoices .seed-choice-btn').forEach(b => { if (b !== btn) b.disabled = true; });
      // busy is set here for the same reason it is on the correct branch: the
      // 620ms reshuffle is async, and without it a second tap on the same wrong
      // button queued a second repaint and a second toast on top of the first.
      // The button is re-enabled below because it is the one the user has to
      // press again — the guard, not the disabled attribute, is what stops the
      // repeat.
      busy = true;
      toast('Wrong word — same spot, fresh options.', 'error');
      setTimeout(() => { busy = false; paint(); }, 620);
    }
  });

  $('#seedRestart').onclick = () => {
    // Balik ke form create. Wallet lama tidak pernah disimpan (tidak ada
    // saveSession di jalur ini) jadi tidak ada yang menggantung di belakang.
    showCreateModal();
  };

  $('#seedDone').onclick = () => {
    if (done.length < 3) return;
    set('signer', ethers.Wallet.fromPhrase(mnemonic));
    set('address', address);
    set('unlocked', true);
    wallet.saveSession(mnemonic);
    closeModal();
    toast('Wallet created! 🐻', 'success');
    updateTopbar();
    loadDashboard();
    startAutoLock();
  };
}

function showImportModal() {
  openModal(`
    <h2>📥 Import Wallet</h2>
    <div class="field">
      <label for="importName">Wallet (optional)</label>
      <input class="input" id="importName" type="text" maxlength="40">
    </div>
    <div class="field">
      <label for="importSecret">Paste Seed Phrase Or Private Key</label>
      <textarea class="textarea" id="importSecret"></textarea>
    </div>
    <div class="field">
      <label for="importPw">New password</label>
      <input class="input" id="importPw" type="password">
    </div>
    <div class="danger-box">⚠️ Never import a seed phrase on a website you don't trust. This tool is 100% client-side.</div>
    <button class="btn btn-primary btn-block btn-lg" id="importBtn">Import</button>
    <button class="btn btn-ghost btn-block mt-8" id="importBack" type="button">Back</button>
  `, { wide: true });
  // Back out to the welcome screen. openModal replaces the sheet in place, so
  // this is a plain re-open — no closeModal() first, or the overlay would blink
  // closed and open again.
  $('#importBack').onclick = () => { showWelcomeModal(); };
  $('#importBtn').onclick = async () => {
    const secret = $('#importSecret').value.trim();
    const pw = $('#importPw').value;
    if (!secret) return toast('Enter seed phrase or private key', 'error');
    if (pw.length < 8) return toast('Password too short (min 8)', 'error');
    try {
      const res = await wallet.importWallet(secret, pw, $('#importName').value);
      set('signer', new ethers.Wallet(secret.startsWith('0x') ? secret : ethers.Wallet.fromPhrase(secret).privateKey));
      set('address', res.address);
      set('unlocked', true);
      wallet.saveSession(secret);
      $('#importSecret').value = ''; $('#importPw').value = '';
      closeModal();
      toast('Wallet imported! 🐻', 'success');
      updateTopbar();
      loadDashboard();
      startAutoLock();
    } catch (e) { toast('Import failed: ' + e.message, 'error'); }
  };
}

// ── auto-lock ──
let lockTimer = null;
function startAutoLock() {
  clearTimeout(lockTimer);
  const minutes = get('settings').autoLock;
  if (!(minutes > 0)) return; // 0 = Never auto-lock
  lockTimer = setTimeout(() => {
    set('unlocked', false);
    set('signer', null);
    wallet.clearSession();
    toast('Auto-locked 🔒', 'info');
    showUnlockModal();
  }, minutes * 60 * 1000);
}
function resetLock() {
  if (get('unlocked')) startAutoLock();
}
['click', 'keydown', 'mousemove'].forEach(ev =>
  window.addEventListener(ev, resetLock, { passive: true })
);


// ── network modal ──
/**
 * The single writer of settings.testnet. One switch shows it — the one in
 * Settings — and it reads back from here rather than from its own last-known
 * value (the original bug: the knob moved, the setting stayed, only a Save
 * made them agree).
 *
 * Hiding testnets can strand the app on a chain that nothing lists any more, so
 * the move off a testnet happens first and the toast says so, rather than
 * leaving the wallet pointing at a network that has just been filtered away.
 *
 * @param {boolean} on
 * @param {() => void} [redraw] re-render whatever is showing the filtered list
 */
function setTestnetVisible(on, redraw) {
  const settings = get('settings');
  settings.testnet = on;
  set('settings', { ...settings });
  saveSettings();

  if (!on) {
    // Look the active chain up in the UNFILTERED list. getNetworkById() and
    // getAllNetworks() already hide testnets the moment this is off, so they
    // would report the active chain as Ethereum and skip the move.
    const active = [...NETWORKS, ...getCustomNetworks()].find((n) => n.id === get('networkId'));
    if (active?.type === 'testnet') {
      set('networkId', 'ethereum');
      localStorage.setItem('bear.networkId', 'ethereum');
      updateTopbar();
      if (get('address')) loadDashboard();
      toast('Testnets hidden — moved to Ethereum', 'info');
      syncTestnetSwitches();
      redraw?.();
      return;
    }
  }
  toast(on ? 'Testnets shown' : 'Testnets hidden', 'success');
  syncTestnetSwitches();
  redraw?.();
}

/** The Settings switch shows the stored setting, never its own last-known value. */
function syncTestnetSwitches() {
  const on = (get('settings') || {}).testnet !== false;
  for (const el of [$('#setTestnet')]) {
    if (el && el.checked !== on) el.checked = on;
  }
}

function showNetworkModal() {
  const nets = getAllNetworks();
  const html = `
    <button class="modal-close" type="button" data-close-modal>✕</button>
    <h2>🌐 Networks</h2>
    <div class="field" style="margin-bottom:12px">
      <input class="input" id="netSearchInput" type="text" placeholder="🔍 Search networks..." style="width:100%">
    </div>
    <div id="netListMainnet">
      <div class="mb-8"><span class="badge badge-mainnet">MAINNET</span></div>
      ${nets.filter(n => n.type === 'mainnet').map(n => netRow(n)).join('')}
    </div>
    <div id="netListTestnet">
      <div class="mb-8 mt-16">
        <span class="badge badge-testnet">TESTNET</span>
      </div>
      <!-- The testnet switch lives in Settings only (removed from here
           2026-10-04: one toggle per setting, reported as a duplicate of the
           Settings on/off). The list below simply follows settings.testnet —
           flip it in Settings and reopen this picker. -->
      ${nets.filter(n => n.type === 'testnet').map(n => netRow(n)).join('')}
    </div>
    <hr class="mt-16 mb-16">
    <button class="btn btn-secondary btn-block" id="addNetBtn">+ Add Custom Network</button>
  `;
  openModal(html);
  applyTranslations();

  // network search
  // Remove a custom network. Never the active one without moving off it first:
  // deleting the chain you are standing on would leave the app pointing at a
  // network that no longer exists in any list.
  $all('[data-remove-net]').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = b.dataset.removeNet;
      if (id === get('networkId')) {
        return toast('Switch to another network first, then remove this one', 'error');
      }
      const list = getCustomNetworks();
      const net = list.find((x) => x.id === id);
      removeCustomNetwork(id);
      toast(`${net?.name || 'Network'} removed`, 'success');
      showNetworkModal();
    });
  });

  const searchInput = $('#netSearchInput');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      const q = searchInput.value.toLowerCase().trim();
      $all('[data-net]').forEach(el => {
        const name = (el.querySelector('.asset-name')?.textContent || '').toLowerCase();
        const chainId = (el.querySelector('.asset-symbol')?.textContent || '').toLowerCase();
        el.style.display = (!q || name.includes(q) || chainId.includes(q)) ? '' : 'none';
      });
      // hide section headers if all rows hidden
      const mainnetRows = document.querySelectorAll('#netListMainnet [data-net]');
      const testnetRows = document.querySelectorAll('#netListTestnet [data-net]');
      const mainnetVisible = [...mainnetRows].some(r => r.style.display !== 'none');
      const testnetVisible = [...testnetRows].some(r => r.style.display !== 'none');
      document.querySelector('#netListMainnet .mb-8').style.display = mainnetVisible ? '' : 'none';
      document.querySelector('#netListTestnet .mb-8').style.display = testnetVisible ? '' : 'none';
    });
    searchInput.focus();
  }
  $('#addNetBtn').onclick = showAddNetworkModal;
  $all('[data-net]').forEach(el => el.addEventListener('click', () => {
    // The network you are standing on is not a destination: re-selecting it
    // used to re-run the whole switch (toast "Network switched" + dashboard
    // reload) for a network that never changed.
    if (el.dataset.netCurrent !== undefined) {
      toast('Already on this network', 'info');
      return;
    }
    activateNetwork(el.dataset.net);
  }));
  // Bridge source chain decides WHERE the tx runs, so picking one switches
  // the wallet with it (user, 2026-10-06: "aku ganti jaringan di bridge, ga
  // auto ganti jaringan, jadi harus ganti manual"). The select node itself
  // survives loadBridgeChains' option rewrites — binding once is enough.
  // close: false — the bridge modal stays open on the new chain.
  $('#bridgeFromChain')?.addEventListener('change', (e) =>
    activateNetwork(e.target.value, { close: false }));
}

// Switch the wallet's active network — ONE chokepoint for every entry
// point (modal rows, bridge source chain). Same id → no-op: a picker that
// re-selects the current network must not toast "switched" or reload the
// dashboard. `close: false` keeps the caller's modal open (the bridge
// source picker must not close the bridge).
export function activateNetwork(id, { close = true } = {}) {
  if (id == null || id === '') return false;
  if (String(id) === String(get('networkId'))) return false;
  set('networkId', id);
  localStorage.setItem('bear.networkId', id);
  if (close) closeModal();
  toast('Network switched', 'success');
  updateTopbar();
  if (get('address')) loadDashboard();
  return true;
}

function netRow(n) {
  const isCurrent = n.id === get('networkId');
  const active = isCurrent
    ? 'style="border-left:8px solid var(--mint)" data-net-current="1" aria-disabled="true"'
    : '';
  // A custom network is the only kind the user put there themselves, so it is
  // the only kind they can take away. removeCustomNetwork() existed and was
  // never called from anywhere: add a network, get it forever, with no control
  // anywhere in the app that removes it.
  // The remove control REPLACES the mainnet/testnet tag on a custom row rather
  // than sitting beside it. At 282px the row has room for the name, one line of
  // subtitle, and exactly one trailing control: the button cost the subtitle
  // 56px, which wrapped "Chain 987654 - UJI" onto two lines and made the row
  // 78px against 63px for every built-in. The tag is also the redundant half -
  // you added this network yourself, and its chain id is already in the
  // subtitle, so what the row actually needed was a way to take it away.
  const tail = n.custom
    ? `<button class="btn-icon net-remove" data-remove-net="${escapeHtml(n.id)}"
         aria-label="Remove ${escapeHtml(n.name)}" title="Remove this network">✕</button>`
    : isCurrent
      // The section header already says MAINNET/TESTNET, so the current row
      // spends its one trailing slot answering the real question: why nothing
      // happens when I tap this.
      ? `<span class="badge">✓ Current</span>`
      : `<span class="badge ${n.type === 'mainnet' ? 'badge-mainnet' : 'badge-testnet'}">${escapeHtml(titleCase(n.type))}</span>`;
  return `<div class="asset-row" data-net="${escapeHtml(n.id)}" ${active}>
    <div class="net-logo">${getNetworkLogo(n.name, 32)}</div>
    <div class="asset-info"><div class="asset-name">${escapeHtml(n.name)}</div>
      <div class="asset-symbol">Chain ${escapeHtml(String(n.chainId))} · ${escapeHtml(n.symbol)}</div></div>
    ${tail}
  </div>`;
}

// ── add network: pick a chain, don't type one ──
// Was five free-text fields (name, chainId, RPC, symbol, explorer) where a typo
// in chainId silently produced a network that talks to the wrong chain. Now the
// common EVM chains are one-tap presets whose RPCs were verified to answer
// eth_chainId with the id claimed (docs/CHAIN-PRESETS.md). The fields stay
// editable afterwards for a private RPC, but they arrive pre-filled.
function showAddNetworkModal() {
  const presets = CHAIN_PRESETS;
  const rowFor = (p) => `
    <div class="asset-row asset-clickable chain-preset" role="button" tabindex="0"
         data-name="${escapeHtml(p.name)}" data-chain="${p.chainId}" data-type="${p.type}"
         data-symbol="${escapeHtml(p.symbol)}" data-rpc="${escapeHtml(p.rpc[0])}"
         data-explorer="${escapeHtml(p.explorer || '')}" data-icon="${escapeHtml(p.icon || '🛰️')}">
      <div class="net-logo" style="font-size:20px">${escapeHtml(p.icon || '🛰️')}</div>
      <div class="asset-info">
        <div class="asset-name">${escapeHtml(p.name)}</div>
        <div class="asset-symbol">Chain ${p.chainId} · ${escapeHtml(p.symbol)}</div>
      </div>
      <span class="badge ${p.type === 'mainnet' ? 'badge-mainnet' : 'badge-testnet'}">${escapeHtml(titleCase(p.type))}</span>
    </div>`;

  openModal(`
    <button class="modal-close" type="button" data-close-modal>✕</button>
    <h2>➕ Add Network</h2>
    <p class="dim small">Pick a chain — the fields fill themselves in. Or paste any RPC link and we detect the chain for you.</p>
    <div class="field"><input class="input" id="cnSearch" type="text" placeholder="🔍 Search ${presets.length} chains by name or chain ID..." autocomplete="off"></div>
    <button class="btn btn-secondary btn-block" id="cnCustomBtn" type="button">🔗 Enter a custom RPC link</button>
    <div id="cnPresetList" style="max-height:38vh;overflow-y:auto">
      <div id="cnMainnetWrap">
        <div class="mb-8"><span class="badge badge-mainnet">MAINNET</span></div>
        <div id="cnMainnet">${presets.filter(p => p.type === 'mainnet').map(rowFor).join('')}</div>
      </div>
      <div id="cnTestnetWrap">
        <div class="mb-8 mt-16"><span class="badge badge-testnet">TESTNET</span></div>
        <div id="cnTestnet">${presets.filter(p => p.type === 'testnet').map(rowFor).join('')}</div>
      </div>
      <p id="cnNoMatch" class="small text-center" style="display:none">No chain matches that search.</p>
    </div>
    <div id="cnForm" style="display:none">
      <hr class="mt-16 mb-16">
      <div class="asset-row" style="border-left:8px solid var(--mint)">
        <div class="net-logo" id="cnIcon" style="font-size:20px">🛰️</div>
        <div class="asset-info">
          <div class="asset-name" id="cnNameLabel">—</div>
          <div class="asset-symbol" id="cnChainLabel">—</div>
        </div>
      </div>
      <div class="field mt-16"><label for="cnRpc">RPC URL</label><input class="input" id="cnRpc" placeholder="https://..." autocomplete="off" spellcheck="false"></div>
      <div class="field" id="cnNameField" style="display:none"><label for="cnName">Network name</label><input class="input" id="cnName" placeholder="e.g. My Local Node" autocomplete="off" maxlength="40"></div>
      <div class="small" id="cnDetect" style="min-height:1.2em"></div>
      <div class="danger-box">⚠️ Custom RPC = you trust this provider with your address and balance data.</div>
      <button class="btn btn-primary btn-block" id="cnSave">Add Network</button>
    </div>
  `);

  let picked = null;
  let custom = false;          // pasted an RPC instead of choosing a preset
  let detectTimer = null;
  let detectSeq = 0;           // ignore a probe that a newer keystroke superseded
  const form = $('#cnForm');
  const show = () => { if (picked || custom) form.style.display = ''; };

  // Ask the endpoint what chain it is, then name it from the catalogue. A
  // pasted link is the only route by which an unknown chainId can arrive, and a
  // typo there is exactly what sends a wallet to the wrong chain — so the id
  // always comes from the node, never from what the user typed.
  const detectFrom = async (url) => {
    const seq = ++detectSeq;
    const out = $('#cnDetect');
    if (!isSafeRpcUrl(url)) { out.textContent = ''; return; }
    out.textContent = 'Detecting chain…';
    try {
      const res = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      });
      const json = await res.json();
      if (seq !== detectSeq) return;               // a newer paste won
      const chainId = json?.result != null ? parseInt(json.result, 16) : null;
      if (!Number.isFinite(chainId)) throw new Error('no chain id');
      const known = presets.find((p) => Number(p.chainId) === chainId);
      picked = known
        ? { name: known.name, chainId, type: known.type, symbol: known.symbol,
            rpc: [url], explorer: known.explorer, icon: known.icon, color: '#9B5DE5', decimals: 18 }
        : { name: '', chainId, type: detectNetworkType(chainId, url), symbol: 'ETH', rpc: [url],
            explorer: '', icon: '🛰️', color: '#9B5DE5', decimals: 18 };
      $('#cnIcon').textContent = picked.icon;
      $('#cnNameLabel').textContent = known ? picked.name : `Chain ${chainId}`;
      $('#cnChainLabel').textContent = known
        ? `Chain ${chainId} · ${picked.symbol}`
        : `Chain ${chainId} · not in the catalogue`;
      if (known) {
        out.textContent = `✅ Detected ${known.name} (chain ${chainId})`;
        $('#cnNameField').style.display = 'none';
        $('#cnName').value = '';
      } else {
        // Unknown chain: the number is known, the name is not. Let the user
        // name it rather than inventing a label that will be wrong later.
        out.textContent = `✅ Detected chain ${chainId} — not in the catalogue, name it below`;
        $('#cnNameField').style.display = '';
        $('#cnName').focus();
      }
      $all('.chain-preset').forEach((r) => { r.style.borderLeft = ''; });
    } catch {
      if (seq !== detectSeq) return;
      out.textContent = '⚠️ Could not reach that RPC';
      picked = null;
    }
  };

  $('#cnCustomBtn').onclick = () => {
    custom = true; picked = null;
    show();
    $('#cnRpc').focus();
  };
  $('#cnRpc').addEventListener('input', (e) => {
    if (!custom) return;
    clearTimeout(detectTimer);
    const url = e.target.value.trim();
    detectTimer = setTimeout(() => detectFrom(url), 600);
  });

  const pick = (el) => {
    const d = el.dataset;
    custom = false;
    clearTimeout(detectTimer); detectSeq++;   // drop any probe still in flight
    picked = {
      name: d.name, chainId: Number(d.chain), type: d.type, symbol: d.symbol,
      rpc: [d.rpc], explorer: d.explorer, icon: d.icon, color: '#9B5DE5', decimals: 18
    };
    $('#cnNameField').style.display = 'none';
    $('#cnName').value = '';
    $('#cnDetect').textContent = '';
    $('#cnIcon').textContent = d.icon;
    $('#cnNameLabel').textContent = d.name;
    $('#cnChainLabel').textContent = `Chain ${d.chain} · ${d.symbol}`;
    $('#cnRpc').value = d.rpc;
    $all('.chain-preset').forEach((r) => { r.style.borderLeft = ''; });
    el.style.borderLeft = '8px solid var(--mint)';
    show();
  };

  $all('.chain-preset').forEach((el) => {
    el.addEventListener('click', () => pick(el));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(el); }
    });
  });

  $('#cnSearch')?.addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase().trim();
    let any = false;
    for (const [wrapId, listId] of [['#cnMainnetWrap', '#cnMainnet'], ['#cnTestnetWrap', '#cnTestnet']]) {
      let vis = 0;
      $(listId).querySelectorAll('.chain-preset').forEach((r) => {
        const hit = !q || r.dataset.name.toLowerCase().includes(q) || r.dataset.chain.includes(q);
        r.style.display = hit ? '' : 'none';
        if (hit) vis++;
      });
      $(wrapId).style.display = vis ? '' : 'none';
      any = any || vis > 0;
    }
    $('#cnNoMatch').style.display = any ? 'none' : '';
  });

  $('#cnSave').onclick = async () => {
    // The two failure modes here used to be reported with the wrong words, and
    // the name check ran after the lock was dropped. Both are fixed together:
    // the name is the only thing that makes an unknown chain identifiable in the
    // network list, so it is checked up front with the lock held, and the
    // "nothing picked" message now distinguishes "you skipped the form" from
    // "your pasted RPC did not answer" instead of telling the user to pick a
    // chain they had already picked.
    if (!picked) {
      return toast(custom
        ? 'That RPC did not answer eth_chainId — check the URL and try again'
        : 'Pick a chain first', 'error');
    }
    let displayName = picked.name;
    if (custom && !displayName) {
      displayName = $('#cnName').value.trim();
      if (!displayName) return toast('Name the network before adding it', 'error');
    }
    const rpc = $('#cnRpc').value.trim();    // The shared rule, not an inline /^https:\/\// test. That regex was here and
    // it was wrong twice: it refused http://localhost:8545, so a node on this
    // same machine — a perfectly normal thing to point a wallet at — was
    // impossible to add, while it waved through anything else beginning with
    // https://. isSafeRpcUrl is the tested version of the same question and it
    // allows loopback deliberately, and only loopback, over http.
    if (!isSafeRpcUrl(rpc)) {
      return toast('Use https:// — or http:// for a local node (localhost / 127.0.0.1)', 'error');
    }
    // Prove the endpoint really is the chain that was picked before saving it.
    const btn = $('#cnSave');
    btn.disabled = true; btn.textContent = 'Checking RPC…';
    try {
      const res = await fetch(rpc, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      });
      const json = await res.json();
      const got = json?.result != null ? parseInt(json.result, 16) : null;
      if (got !== picked.chainId) {
        return toast(`RPC reports chain ${got ?? 'unknown'}, expected ${picked.chainId}`, 'error');
      }
    } catch {
      return toast('Could not reach that RPC', 'error');
    } finally {
      btn.disabled = false; btn.textContent = 'Add Network';
    }
    // An unknown chain has no catalogue name, so the one the user typed is used.
    if (custom && !picked.name) picked.name = displayName;
    addCustomNetwork({ ...picked, rpc: [rpc] });
    closeModal();
    toast(`${picked.name} added!`, 'success');
    showNetworkModal();
  };
}

// ── account modal ──
function showAccountModal() {
  if (!get('unlocked')) return showUnlockModal();
  const accounts = wallet.getAccounts();
  const idx = wallet.getActiveAccountIndex();
  openModal(`
    <button class="modal-close" type="button" data-close-modal>✕</button>
    <h2>🐻 Accounts</h2>
    ${accounts.map((a, i) => `
      <div class="asset-row ${i === idx ? 'active' : ''}" data-acc="${i}">
        <div class="asset-icon"><img class="asset-bear" src="assets/bear.svg" alt="" aria-hidden="true"></div>
        <div class="asset-info">
          <div class="asset-name">${escapeHtml(a.name || `Account ${i + 1}`)}</div>
          <div class="mono">${escapeHtml(a.address)}</div>
        </div>
        <button class="acc-del-btn" type="button" data-del-acc="${i}" title="Remove this wallet from the list" aria-label="Remove ${escapeHtml(a.name || `Account ${i + 1}`)} from the list">🗑</button>
      </div>`).join('')}
    <button class="btn btn-secondary btn-block mt-8" id="addAccBtn">+ Add Account</button>
    <button class="btn btn-ghost btn-block mt-8" id="exportBtn">📤 Export Secret</button>
    <button class="btn btn-danger btn-block mt-8" id="lockBtn">🔒 Lock</button>
  `);
  $all('[data-acc]').forEach(el => el.addEventListener('click', async () => {
    const i = Number(el.dataset.acc);
    const pw = await promptPassword('Unlock to switch account');
    if (!pw) return;
    try {
      // Derive the requested account WITHOUT switching to it first. The old order
      // wrote the new active index and then asked for the password, so cancelling
      // the prompt or mistyping it left localStorage on an account the topbar was
      // not showing — and the next unlock signed with that other one. Nothing in
      // the UI said the displayed address and the signing address had diverged.
      const signer = await wallet.unlockWallet(pw, i);
      // The password is proven; only now does the choice become the active one.
      wallet.setActiveAccount(i);
      set('signer', signer);
      set('address', signer.address);
      closeModal();
      toast('Switched account', 'success');
      updateTopbar();
      loadDashboard();
    } catch { toast('Wrong password', 'error'); }
  }));
  $all('[data-del-acc]').forEach(el => el.addEventListener('click', async (e) => {
    // The 🗑 sits INSIDE the row: stop the click here or removing a wallet
    // would also fire the row's switch handler underneath it.
    e.stopPropagation();
    const i = Number(el.dataset.delAcc);
    const accs = wallet.getAccounts();
    const target = accs[i];
    if (!target) return;
    if (accs.length <= 1) return toast('Cannot delete the last wallet', 'error');
    const name = target.name || `Account ${i + 1}`;
    const ok = await confirmTx({
      title: `Remove ${name} from the list?`,
      rows: [
        { k: 'Wallet', v: name },
        { k: 'Address', v: target.address },
        { k: 'Keys stay yours', v: 'Your recovery phrase still controls this address — copy it first if the wallet holds funds.' },
      ],
      confirmText: 'Remove',
      danger: true,
    });
    if (!ok) return;
    const pw = await promptPassword('Enter password to remove this wallet');
    if (!pw) return;
    const wasActive = i === wallet.getActiveAccountIndex();
    let removed;
    try {
      removed = await wallet.deleteAccount(i, pw);
    } catch (err) {
      // deleteAccount rejects BEFORE it splices, so nothing was written and
      // the list on screen is still true — leave the modal alone.
      toast(err?.message || 'Could not remove wallet', 'error');
      return;
    }
    // Past this point the list HAS changed, so the UI must be repointed at it
    // no matter what happens next. A modal left holding the old indexes lets a
    // switch land on the wrong account, and an unlock failure used to jump
    // straight to the catch, skipping every refresh below.
    if (wasActive) {
      try {
        const signer = await wallet.unlockWallet(pw, wallet.getActiveAccountIndex());
        set('signer', signer);
        set('address', signer.address);
        loadDashboard();
      } catch (e) {
        // The delete cannot be undone, and a signer for an account that is no
        // longer on the list must never be kept: the next sign would use a key
        // the UI no longer shows. Drop it — the next signing action asks for
        // the password again — and fall through so the list is still re-read.
        console.warn('[BearTool] re-unlock after delete failed:', e?.message || e);
        set('signer', null);
        set('unlocked', false);
      }
    }
    toast(`Removed ${name} — ${wallet.shortAddress(removed.address)}`, 'success');
    updateTopbar();
    syncHomeWalletName();
    showAccountModal();
  }));
  $('#addAccBtn').onclick = async () => {
    const pw = await promptPassword('Enter password to derive new account');
    if (!pw) return;
    try {
      const addr = await wallet.deriveNextAccount(pw);
      toast('Account added: ' + wallet.shortAddress(addr), 'success');
      showAccountModal();
    } catch (err) {
      // deriveNextAccount already names the failure: a wrong password, or a
      // wallet with no HD tree (a private-key import) that cannot derive at
      // all. Printing "Wrong password" for the second case sent people back to
      // retype a password that was right.
      toast(err?.message || 'Could not add account', 'error');
    }
  };
  $('#exportBtn').onclick = async () => {
    const pw = await promptPassword('Enter password to export');
    if (!pw) return;
    try {
      const secret = await wallet.exportSecret(pw);
      // The phrase alone never says which account's key it is for — show the
      // ACTIVE account's private key beside it (live request 2026-10-03: "di
      // export wallet tambahin nampilin private key"). Derived with the same
      // signerFromSecret() the app signs with, and shown only when the result
      // really belongs to the active account: a silently wrong key would send
      // a backup to a wallet that is not theirs.
      let pk = null;
      try {
        const idx = wallet.getActiveAccountIndex();
        const w = wallet.signerFromSecret(secret, idx);
        const want = (wallet.getAccounts()[idx] || {}).address;
        if (want && w.address.toLowerCase() === String(want).toLowerCase()) pk = w.privateKey;
      } catch { /* fall through — the modal says the key was not derived */ }
      const isPkOnly = /^0x[a-fA-F0-9]{64}$/.test(secret);
      openModal(`
        <button class="modal-close" type="button" data-close-modal>✕</button>
        <h2>📤 Your Secret</h2>
        <div class="danger-box">Never share this. Anyone with it controls your funds.</div>
        ${isPkOnly ? '' : `
        <div class="small mt-8">Seed phrase</div>
        <div class="card" style="box-shadow:none"><div class="mono">${escapeHtml(secret)}</div></div>
        <button class="copy-btn btn btn-ghost btn-block mt-8" data-copy="${escapeHtml(secret)}"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy seed phrase</button>`}
        ${pk ? `
        <div class="small mt-8">Private key — active account</div>
        <div class="card" style="box-shadow:none"><div class="mono">${escapeHtml(pk)}</div></div>
        <button class="copy-btn btn btn-ghost btn-block mt-8" data-copy="${escapeHtml(pk)}"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy private key</button>`
        : `<div class="small mt-8">⚠️ Private key could not be derived for the active account.</div>`}
        <button class="btn btn-primary btn-block" type="button" data-close-modal>Close</button>
      `);
    } catch { toast('Wrong password', 'error'); }
  };
  $('#lockBtn').onclick = () => {
    set('unlocked', false); set('signer', null);
    // A page holding an account list must be told the wallet went dark.
    bridgeLocked();
    wallet.clearSession();
    closeModal();
    toast('Locked 🔒', 'info');
    showUnlockModal();
  };
}

// ── dashboard ──
// Restore the active account address (public, non-secret) from the saved
// account list so a refresh lands on a usable read-only app instead of the
// password prompt. Returns null when there is nothing to restore.
function restoreReadOnlyAccount() {
  try {
    if (!wallet.getKeystore()) return null;
    const accounts = wallet.getAccounts();
    if (!Array.isArray(accounts) || !accounts.length) return null;
    const idx = wallet.getActiveAccountIndex();
    const addr = accounts[idx]?.address || accounts[0]?.address;
    if (!addr || !wallet.isValidAddress(addr)) return null;
    set('address', addr);
    return addr;
  } catch { return null; }
}

// ── home hero label ───────────────────────────────────────────────────────
// The wallet name above the balance hero — the home screen's "whose box is
// this?" label. Reads the account list (non-secret), never an address. One
// source for BOTH moments that can change it: a full dashboard load and a
// delete from the account switcher, which shifts rows with no reload at all
// (a label left behind beside a changed list is a name the wallet no longer
// has).
function syncHomeWalletName() {
  try {
    const accounts = wallet.getAccounts() || [];
    const idx = wallet.getActiveAccountIndex();
    const acct = accounts[idx] || {};
    const el = $('#homeWalletName');
    if (el) el.textContent = (acct.name || 'Account').trim();
  } catch { /* name is cosmetic — skip */ }
}

async function loadDashboard(opts = {}) {
  if (!get('address')) return;
  const net = getNetworkById(get('networkId'));
  // Network name only. The wallet address lives in the Receive modal — it is
  // not shown (or copyable) from the home screen any more.
  $('#balanceSub').textContent = net.name;

  // Wallet name above the balance hero — same writer as a post-delete refresh
  // (syncHomeWalletName above), so the label cannot drift from the list.
  syncHomeWalletName();

  const assetList = $('#assetList');
  if (!assetList) return;
  // Soft mode (auto-refresh ticks): keep the current rows on screen until the
  // new snapshot lands — a spinner flash every minute is worse than a balance
  // that is seconds old.
  const soft = opts.soft === true;
  if (!soft) assetList.innerHTML = spinner(64, 'Loading assets...');
  // 24h price sparkline for the native asset — CoinGecko auto-pair
  // (native → auto chain id), cached by fetchPriceHistory. Cosmetic only.
  renderHeroSpark(net).catch(() => { /* cosmetic — never blocks */ });
  try {
    const provider = await getProvider(net.chainId);
    // A dashboard that STARTED before a network switch must not install its
    // provider AFTER the switch landed: CI 36997713895 amoy lost this race by
    // milliseconds — the import-time ethereum dashboard's set('provider')
    // overwrote the amoy one, so verifySpendable quoted a balance from real
    // ETHEREUM (0.00), refused the send, and the sign dialog never opened
    // (trace: eth_getBalance + fee batch hit ethereum-rpc.publicnode.com while
    // networkId was 'amoy'). Same class of staleness as the token-list guard
    // below; re-check which network this snapshot actually belongs to.
    if (get('networkId') !== net.id) return;
    set('provider', provider);
    const balance = await provider.getBalance(get('address'));
    const native = {
      address: null, symbol: net.symbol, decimals: net.decimals,
      balance: balance.toString(), usd: null
    };
    const tokens = [native];
    // List every popular token for the chain — including ones the user holds
    // 0 of — so the dashboard is a usable coin list, not an empty screen for
    // a fresh wallet. Balance is filled from the chain; failures fall back to 0.
    const popular = POPULAR_TOKENS[net.chainId] || [];
    // Custom tokens the user added (persisted by state.js) join the SAME
    // balance pipeline: the list used to be rebuilt from native +
    // POPULAR_TOKENS alone, so an added token vanished on every refresh
    // (user, 2026-10-06: "token yang ku add tiba-tiba hilang").
    const custom = getCustomTokens(net.chainId).filter(
      (c) => !popular.some((p) => p.address.toLowerCase() === c.address.toLowerCase()));
    const list = [...popular, ...custom];
    const results = await Promise.allSettled(list.map(async (t) => {
      const c = new ethers.Contract(t.address, ERC20_ABI, provider);
      const bal = await c.balanceOf(get('address'));
      return { address: t.address, symbol: t.symbol, decimals: t.decimals, balance: bal.toString(), usd: null };
    }));
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') tokens.push(r.value);
      else tokens.push({
        address: list[i].address, symbol: list[i].symbol,
        decimals: list[i].decimals, balance: '0', usd: null
      });
    });
    // Same staleness guard as the provider above: the balanceOf batch can take
    // seconds, and a switch landing mid-flight must not be overwritten with a
    // token list (and provider render) built for the OLD network.
    if (get('networkId') !== net.id) return;
    set('tokens', tokens);
    // USD prices (CoinGecko → DexScreener → cache)
    try {
      const prices = await fetchAllPrices(tokens, net.chainId);
      tokens.forEach(t => {
        const p = prices.get(t.address || 'native');
        if (p !== undefined && p !== null) t.usd = p;
      });
    } catch {}
    renderAssets(tokens);
    // Auto-detect logos from CoinGecko for tokens outside the manual map,
    // then re-render once — but only if this is still the active token list
    // (a network switch may have replaced it while the fetch was in flight).
    ensureTokenLogos(tokens).then(() => {
      if (window._assetTokens === tokens) renderAssets(tokens);
    });
    // not awaited on purpose (NFT scan is slow) — but its rejection must be
    // handled here, or a null element becomes a global "Unexpected error" toast.
    // Skipped on soft ticks: a balance refresh must not re-run the slow scan.
    if (!soft) loadNfts().catch((e) => console.warn('[BearTool] NFT scan failed:', e?.message || e));
    // M5-HERO: coin price panel removed per user request
  } catch (e) {
    console.warn('[BearTool] asset list failed:', e);
    // Contract above: a SOFT tick never clears the screen. One flaky RPC on a
    // 60s auto-refresh used to replace the whole coin list with an error
    // paragraph — the list stayed empty until the next tick succeeded. The
    // rows on display are seconds old and still true; keep them and log.
    if (!soft) {
      assetList.innerHTML = `<p class="small text-center">${escapeHtml(explainError(e, 'Reading your assets'))}</p>`;
    }
  }
}

// ── balance auto-refresh (live: "saldo ngga auto refresh") ──
// Two triggers, one gate: the tab becoming visible again (the usual "sent
// from another app, came back, balance is old" case) and a gentle 60s tick.
// Both refuse to run for a locked wallet, a hidden tab, or a view nobody is
// looking at — an idle phone must not poll the chain forever. Wired in the
// DOMContentLoaded handler at the top of this file (the visibilitychange
// listener and the 60s setInterval sit there, before boot() is even defined) —
// not in boot() — so importing this module under Node installs no timers or
// listeners.
function currentView() {
  return (document.querySelector('.view.active')?.id || 'view-dashboard').replace(/^view-/, '');
}
async function refreshDashboardBalance() {
  if (!get('unlocked') || !get('address')) return;
  if (document.hidden) return;
  if (currentView() !== 'dashboard') return;
  try {
    await loadDashboard({ soft: true });
  } catch { /* best-effort: the next tick tries again */ }
}

// USD value of what the user actually holds (amount × unit price).
// The home total and each asset row must show this, NOT the token's unit
// price — summing unit prices made the portfolio total nonsense ($0.99 for
// 1 ETH) and made the rows read like a price ticker.
function holdingUsd(t) {
  if (t.usd === null || t.usd === undefined) return 0;
  let amt = 0;
  try { amt = Number(ethers.formatUnits(t.balance || '0', t.decimals ?? 18)); }
  catch { amt = 0; }
  if (!Number.isFinite(amt)) amt = 0;
  return amt * t.usd;
}

// ── CoinGecko token logos (auto-detect, cached 24h) ──
// The manual SVG map covers the popular tokens; anything else asks CoinGecko
// search once per symbol and caches the result so the list stays fast.
// The cache + mark rendering now live in js/token-logo.js so the dashboard and
// the Swap/Bridge pickers cannot drift apart. Re-exported here because several
// call sites in this file still use the old local names.
import { tokenLogoHTML, getCachedLogo, cacheLogo, guardTokenLogos, readLogoCache as loadLogoCache, logoKeyFor, getNetworkLogo } from './token-logo.js';
import { explainError } from './errors.js';
const MANUAL_LOGO_SYMS = new Set(['eth', 'ether', 'usdc', 'usdt', 'dai', 'wbtc', 'link', 'uni', 'aave', 'reth', 'cbeth', 'wsteth', 'frax']);

async function fetchCoinGeckoLogo(sym) {
  const url = `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(sym)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const data = await res.json();
    const coins = Array.isArray(data?.coins) ? data.coins : [];
    const hit = coins.find(c => (c.symbol || '').toLowerCase() === String(sym).toLowerCase() && c.large);
    return hit?.large || null;
  } catch { return null; }
  finally { clearTimeout(timer); }
}
// Fetch + cache logos for tokens not covered by the manual SVG map.
// Never throws — logo failures just leave the default SVG in place.
async function ensureTokenLogos(tokens) {
  const missing = (tokens || []).filter(t =>
    t.symbol && !MANUAL_LOGO_SYMS.has(t.symbol.toLowerCase()) && !getCachedLogo(logoKeyFor(t))
  );
  await Promise.allSettled(missing.map(async (t) => {
    const url = await fetchCoinGeckoLogo(t.symbol);
    if (url) cacheLogo(logoKeyFor(t), url);
  }));
}

function renderAssets(tokens) {
  const assetList = $('#assetList');
  if (!assetList) return;
  const totalUsd = tokens.reduce((s, t) => s + holdingUsd(t), 0);
  animateValue($('#totalBalance'), totalUsd, { duration: 600, formatter: fmtUsd });
  if (!tokens.length) {
    assetList.innerHTML = '<p class="small text-center">No assets found.</p>';
    $('#assetSearch').style.display = 'none';
    return;
  }
  // Show search if > 3 tokens
  $('#assetSearch').style.display = tokens.length > 3 ? '' : 'none';
  // Takes the whole token, not the ticker: the mark is filed under the contract
  // so a counterfeit ticker cannot pick up the real project's logo.
  const getLogo = (t) => tokenLogoHTML(t.symbol, 32, { address: t.address });
  // Store tokens for filtering
  window._assetTokens = tokens;
  const filter = ($('#tokenSearchInput')?.value || '').toLowerCase();
  const filtered = filter ? tokens.filter(t => (t.symbol || '').toLowerCase().includes(filter)) : tokens;
  assetList.innerHTML = filtered.map((t, i) => `
    <div class="asset-row asset-clickable" data-token-idx="${i}" data-symbol="${escapeHtml(t.symbol || '')}" data-address="${escapeHtml(t.address || '')}" data-decimals="${t.decimals || 18}" data-balance="${escapeHtml(t.balance || '0')}" data-usd="${t.usd ?? ''}">
      <div class="token-icon-svg">${getLogo(t)}</div>
      <div class="asset-info">
        <div class="asset-name">${escapeHtml(t.symbol)}</div>
        <div class="asset-symbol">${t.address ? escapeHtml(wallet.shortAddress(t.address)) : 'Native'}</div>
      </div>
      <div class="asset-balance">
        <div class="amount">${escapeHtml(fmtAmount(t.balance, t.decimals))}</div>
        <div class="usd">${t.usd != null && !Number.isNaN(Number(t.usd)) ? escapeHtml(fmtUsd(holdingUsd(t))) : '—'}</div>
      </div>
      <div class="asset-arrow"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg></div>
    </div>`).join('');
  if (filtered.length === 0) {
    assetList.innerHTML = '<p class="small text-center">No tokens match your search.</p>';
  }
  // The per-asset 24h sparkline was removed from the coin list: it fetched a
  // CoinGecko history call for every row, all of which failed CORS from a plain
  // static host, so the list rendered a column of empty boxes. The detail modal
  // (token-chart) still draws a real chart on demand.
  // CoinGecko images can 404/expire. guardTokenLogos does this, and it does it
  // with the symbol: the <img> carries data-mark-fallback, and the handler swaps
  // in the generated mark for THAT token — the hand-tuned disc for ETH, the two
  // letters for anything else. The loop this replaced passed an empty symbol, so
  // a dead remote logo degraded the row to a "?" disc, throwing away the mark
  // the rest of the file renders perfectly well. It also attached a second error
  // handler to the same element, both trying to replace it.
  guardTokenLogos(assetList);
  // Click handlers
  $all('.asset-clickable').forEach(el => {
    el.addEventListener('click', () => showTokenActions(el));
  });
}

function showTokenActions(el) {
  const symbol = el.dataset.symbol;
  const address = el.dataset.address;
  const decimals = parseInt(el.dataset.decimals) || 18;
  const balance = el.dataset.balance;
  // Known price (even 0.00) → show the number; unknown → '—'. data-usd=""
  // marks unknown, so a legitimate 0 is not mistaken for "no price".
  const usdRaw = el.dataset.usd;
  const usd = (usdRaw === '' || usdRaw == null || Number.isNaN(Number(usdRaw))) ? null : Number(usdRaw);
  const net = getNetworkById(get('networkId'));
  // Holding value (what the user owns) vs unit price (price of 1 token)
  let holding = 0;
  try { holding = Number(ethers.formatUnits(balance || '0', decimals)) * (usd ?? 0); } catch { holding = 0; }
  if (!Number.isFinite(holding)) holding = 0;

  // The transactions of THIS token on THIS network, newest first. Rows written
  // before the symbol field existed match through their detail string (see
  // activityMatchesSymbol), so old history is not lost from this list — and
  // the network rule is the Activity view's own (currentNetworkActivity), so
  // the coin modal and the Activity feature can no longer disagree
  // (user, 2026-10-06).
  loadActivity();
  const tokenActs = currentNetworkActivity().filter((a) => activityMatchesSymbol(a, symbol));
  // Native ETH rows record symbol "ETH"; a native-coin send on another chain
  // still carries the chain symbol in detail, so no special case is needed.
  const contractBlock = address
    ? `<span class="tm-addr-k">Contract</span>
       <span class="tm-addr-v mono">${escapeHtml(address)}</span>
       <button class="copy-btn" type="button" data-copy="${escapeHtml(address)}" title="Copy contract address" aria-label="Copy contract address"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>`
    : `<span class="tm-addr-k">Contract</span><span class="tm-addr-v">Native asset — no contract</span>`;

  // One renderer for list and modal (token-logo.js): the modal used to carry
  // its own getLogoSVG map with 13 hardcoded symbols, so a BNB/POL/cached
  // logo that the list showed turned into a peach initial disc here — the
  // reported "logo disappears when I press the coin". tokenLogoHTML takes the
  // contract so a cached mark cannot be reached through a counterfeit ticker.
  openModal(`
    <div class="token-modal-header">
      <div class="token-modal-icon">${tokenLogoHTML(symbol, 48, { address })}</div>
      <div class="token-modal-info">
        <div class="token-modal-symbol">${escapeHtml(symbol)}</div>
        <div class="token-modal-balance">${escapeHtml(fmtAmount(balance, decimals))} ${escapeHtml(symbol)}</div>
        <div class="token-modal-usd">${usd != null ? escapeHtml(fmtUsd(holding)) : '—'}</div>
        ${usd != null ? `<div class="small" style="opacity:0.7">@ ${escapeHtml(fmtUsd(usd))} / ${escapeHtml(symbol)}</div>` : ''}
      </div>
    </div>
    <div class="token-modal-addr">${contractBlock}</div>
    <div class="token-modal-chart" id="tokenChart">
      <div class="chart-timeframes" id="chartTimeframes">
        <!-- Ranges CoinGecko keyless can actually DISTINGUISH (measured
             2026-10-06: 1d→30min, 7d→4h, 30d→4h, 365d→4d). The old 5m/1h
             buttons all fetched days=1 → identical candles every time
             (user: "candle nya sama semua"). -->
        <button class="chart-tf-btn active" data-tf="24h">24h</button>
        <button class="chart-tf-btn" data-tf="7d">7d</button>
        <button class="chart-tf-btn" data-tf="30d">30d</button>
        <button class="chart-tf-btn" data-tf="1y">1y</button>
      </div>
      <canvas id="tokenPriceChart" width="340" height="160"></canvas>
      <div class="chart-price-label" id="chartPriceLabel"></div>
    </div>
    <div class="token-modal-actions">
      <button class="token-action-btn" id="tokenSend">
        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
        Send
      </button>
      <button class="token-action-btn" id="tokenReceive">
        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>
        Receive
      </button>
      <button class="token-action-btn" id="tokenSwap">
        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
        Swap
      </button>
      <button class="token-action-btn" id="tokenHistory">
        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        History
      </button>
    </div>
    <div class="token-modal-txs">
      <h3>Transactions</h3>
      ${tokenActs.length ? tokenActs.map((a, i) => `
        <button class="token-modal-tx" type="button" data-tx-idx="${i}">
          <span class="tm-tx-line"><strong>${escapeHtml(a.type || 'tx')}</strong> · ${escapeHtml(a.status || '')}</span>
          ${a.detail ? `<span class="tm-tx-detail">${escapeHtml(a.detail)}</span>` : ''}
          <span class="tm-tx-time">${escapeHtml(fmtTime(a.ts))}</span>
        </button>`).join('') : '<p class="small dim">No transactions for this token yet.</p>'}
    </div>
    <div class="token-modal-footer">
      <button class="btn btn-ghost btn-block" type="button" data-close-modal>Close</button>
    </div>
  `, { fullscreen: true });

  // Store for action handlers
  window._tokenModalSymbol = symbol;
  window._tokenModalAddress = address;

  // A cached CoinGecko <img> can be dead; guardTokenLogos swaps it for the
  // generated mark instead of leaving a broken-image icon in the header.
  guardTokenLogos($('#modalBox'));

  // A transaction row opens the same full record the Activity view uses:
  // the local row first, then the on-chain truth (block, status, gas, fee).
  // openModal rewrites the same #modalBox, so this IS a navigation, not a
  // modal stacked on a modal.
  document.querySelectorAll('.token-modal-tx').forEach(b => {
    b.addEventListener('click', () => showActivityDetail(tokenActs[Number(b.dataset.txIdx)]));
  });

  // Draw the chart for whichever range button is active (24h at open) —
  // the initial draw and the highlighted button could disagree before.
  drawMiniChart({ symbol, address, timeframe: document.querySelector('.chart-tf-btn.active')?.dataset.tf || '24h' });

  // Timeframe buttons
  document.querySelectorAll('.chart-tf-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.chart-tf-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      drawMiniChart({ symbol, address, timeframe: btn.dataset.tf });
    });
  });

  // Action handlers
  $('#tokenSend').onclick = () => { closeModal(); switchView('send'); };
  $('#tokenReceive').onclick = () => { const s = window._tokenModalSymbol; closeModal(); showReceiveModal(get('address'), s); };
  $('#tokenSwap').onclick = () => { closeModal(); switchView('swap'); };
  $('#tokenHistory').onclick = () => { closeModal(); switchView('activity'); };
}

function showReceiveModal(address, symbol) {
  const addr = address || get('address');
  let qrSvg = '';
  try {
    if (typeof qrcode === 'function') {
      const qr = qrcode(0, 'M');
      qr.addData(addr);
      qr.make();
      qrSvg = qr.createSvgTag(4, 8);
    }
  } catch { /* QR unavailable — address is still shown below */ }
  openModal(`
    <button class="modal-close" type="button" data-close-modal>✕</button>
    <h2>Receive ${escapeHtml(symbol)}</h2>
    ${qrSvg ? `<div class="receive-qr text-center mb-16" role="img" aria-label="QR code for ${escapeHtml(symbol)}">${qrSvg}</div>` : ''}
    <div class="text-center mb-16">
      <div class="mono" style="font-size:0.85rem;word-break:break-all;padding:12px;background:var(--cream);border-radius:10px;border:2px solid var(--ink)">${escapeHtml(addr)}</div>
    </div>
    <button class="copy-btn btn btn-primary btn-block" data-copy="${escapeHtml(addr)}">Copy Address</button>
  `);
}

// ── Candlestick chart with range support ──────────────────────
// Draws OHLC candles for the range the API can distinguish: 24h/7d/30d/1y
// (CoinGecko keyless granularity measured 2026-10-06 — see fetchOHLC).
// Falls back to pseudo-candles from price history, range passed through.
const CHART_TF_DAYS = { '24h': 1, '7d': 7, '30d': 30, '1y': 365 };

async function drawMiniChart({ symbol, address, timeframe = '24h' }) {
  const canvas = document.getElementById('tokenPriceChart');
  if (!canvas) return;
  const w = canvas.width;
  const h = canvas.height;
  const pad = { top: 12, bottom: 20, left: 4, right: 4 };
  const chartW = w - pad.left - pad.right;
  const chartH = h - pad.top - pad.bottom;

  const paintBase = () => {
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#FFF8F0';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#E8E0D8';
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + (chartH / 4) * i;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(w - pad.right, y);
      ctx.stroke();
    }
  };
  const paintMessage = (msg) => {
    const ctx = canvas.getContext('2d');
    paintBase();
    ctx.fillStyle = '#8A8178';
    ctx.font = '12px Arial';
    ctx.textAlign = 'center';
    ctx.fillText(msg, w / 2, h / 2);
  };

  paintMessage(`Loading ${timeframe} chart…`);

  const days = CHART_TF_DAYS[timeframe] || 1;
  let candles = [];
  // A rate limit is NOT "this coin has no chart" — say which one it is, or the
  // modal lies about someone's coin exactly when the data does exist.
  let rateLimited = false;
  try {
    const chainId = getNetworkById(get('networkId'))?.chainId;
    candles = await fetchOHLC({ address, chainId, days });
  } catch (e) {
    rateLimited = isRateLimit(e);
    candles = [];
  }

  if (!canvas.isConnected || document.getElementById('tokenPriceChart') !== canvas) return;

  if (!candles.length || candles.length < 2) {
    paintMessage(rateLimited ? `Rate-limited — try again in a minute` : `No ${timeframe} data`);
    return;
  }

  // Merge down to ~60 candles WITHOUT dropping data: the old stride filter
  // (i % step === 0) threw away every skipped candle's open/high/low, so the
  // picture lied about the range it claimed to show.
  const display = fitCandles(candles, 60);

  const allHigh = Math.max(...display.map(c => c.high));
  const allLow = Math.min(...display.map(c => c.low));
  const range = allHigh - allLow || 1;
  const candleW = Math.max(2, (chartW / display.length) - 1);
  const gap = chartW / display.length;

  const ctx = canvas.getContext('2d');
  paintBase();

  // Price labels (high / mid / low)
  ctx.fillStyle = '#8A8178';
  ctx.font = '9px monospace';
  ctx.textAlign = 'right';
  const fmtPrice = (v) => v >= 1 ? v.toFixed(2) : v >= 0.01 ? v.toFixed(4) : v.toFixed(6);
  ctx.fillText(fmtPrice(allHigh), w - 2, pad.top + 8);
  ctx.fillText(fmtPrice(allLow), w - 2, h - pad.bottom - 2);
  ctx.fillText(fmtPrice((allHigh + allLow) / 2), w - 2, pad.top + chartH / 2 + 4);

  // Time axis: start / middle / end of the drawn range, so "24h" vs "1y"
  // is readable off the picture instead of guessed (user: "chart time itu
  // ga akurat"). Range-aware format: clock for 24h, day for 7d/30d, month
  // + year for 1y.
  const fmtChartTime = (t) => {
    const d = new Date(t);
    if (days <= 1) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (days >= 365) return d.toLocaleDateString([], { month: 'short', year: '2-digit' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  };
  ctx.fillStyle = '#8A8178';
  ctx.font = '9px monospace';
  const timeY = h - 6;
  ctx.textAlign = 'left';
  ctx.fillText(fmtChartTime(display[0].time), pad.left + 1, timeY);
  ctx.textAlign = 'center';
  ctx.fillText(fmtChartTime(display[Math.floor(display.length / 2)].time), w / 2, timeY);
  ctx.textAlign = 'right';
  ctx.fillText(fmtChartTime(display[display.length - 1].time), w - pad.right - 1, timeY);

  // Draw candles
  display.forEach((c, i) => {
    const x = pad.left + i * gap + gap / 2;
    const isUp = c.close >= c.open;
    const color = isUp ? '#22C55E' : '#EF4444';
    const wickX = Math.round(x);
    const bodyTop = pad.top + chartH - ((Math.max(c.open, c.close) - allLow) / range) * chartH;
    const bodyBot = pad.top + chartH - ((Math.min(c.open, c.close) - allLow) / range) * chartH;
    const wickTop = pad.top + chartH - ((c.high - allLow) / range) * chartH;
    const wickBot = pad.top + chartH - ((c.low - allLow) / range) * chartH;

    // Wick
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.moveTo(wickX, wickTop);
    ctx.lineTo(wickX, wickBot);
    ctx.stroke();

    // Body
    const bodyH = Math.max(1, bodyBot - bodyTop);
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(x - candleW / 2), Math.round(bodyTop), Math.round(candleW), Math.round(bodyH));
  });

  // Current price line (dashed)
  const last = display[display.length - 1];
  const lastY = pad.top + chartH - ((last.close - allLow) / range) * chartH;
  ctx.setLineDash([4, 3]);
  ctx.strokeStyle = '#FF6B35';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad.left, lastY);
  ctx.lineTo(w - pad.right, lastY);
  ctx.stroke();
  ctx.setLineDash([]);

  // Current price dot
  ctx.beginPath();
  ctx.arc(w - pad.right, lastY, 3, 0, Math.PI * 2);
  ctx.fillStyle = '#FF6B35';
  ctx.fill();
  ctx.strokeStyle = '#FFF8F0';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Price label overlay
  const label = document.getElementById('chartPriceLabel');
  if (label) {
    const pctChange = display.length >= 2 ? ((last.close - display[0].open) / display[0].open * 100) : 0;
    const sign = pctChange >= 0 ? '+' : '';
    label.textContent = `${fmtPrice(last.close)} (${sign}${pctChange.toFixed(2)}%)`;
    label.style.color = pctChange >= 0 ? '#22C55E' : '#EF4444';
  }
}

// ── view wiring ──
function bindViews() {
  bindSendEvents();
  bindSwapEvents();
  bindBridgeEvents();
  bindEip7702ToolsEvents();
  bindDeployEvents();

    // Anything that binds one element must tolerate its absence. A single
    // null.addEventListener threw here once, and because this runs during module
    // evaluation it aborted the whole of app.js: no provider, no nav, and the
    // splash left sitting on top at z-index 9999 eating every click. The page
    // looked alive in the DOM and was completely unusable. One missing element
    // must never be able to take the wallet down.
    const on = (sel, ev, fn) => $(sel)?.addEventListener(ev, fn);

    // Discord: ONE document-level delegated listener for everything the
    // view repaints (innerHTML swaps replace nodes, never this binding).
    bindDiscordPanel();
    on('#btn7702Check', 'click', runEip7702Check);
    // "Delete results" (live request: muncul setiap selesai scan) — wipes the
    // EIP-7702 check output from the panel, then hides itself until the next
    // scan produces output again. It does NOT touch the debug log; that ring
    // is dev tooling (js/debug-collector.js) and is not this button's job.
    on('#btnClearEipResults', 'click', () => {
      const out = $('#eip7702Results');
      if (out) out.innerHTML = '';
      const el = $('#btnClearEipResults');
      if (el) el.hidden = true;
      toast('Results deleted', 'success');
    });

  // There is no Save button on this page any more, and every control here is
  // applied the moment it is touched. That is not a preference: the Save button
  // used to be the only way to apply the language and the auto-lock, so when the
  // page was reorganised and the button went with it, those two became dead
  // controls — a dropdown that changed nothing on screen. A form field is
  // saved; a preference in a wallet is not a form.
  $('#setLang')?.addEventListener('change', (e) => {
    setLang(e.target.value);
    applyTranslations();
    const s = get('settings');
    s.lang = e.target.value;
    set('settings', { ...s });
    saveSettings();
    // The bottom bar is generated, so it needs the new labels rebuilt, not just
    // the static ones rescanned.
    syncMobileNav();
  });
  $('#setCurrency')?.addEventListener('change', async (e) => {
    const s = get('settings');
    s.currency = e.target.value;
    set('settings', { ...s });
    saveSettings();
    // Only the RATE is currency-specific now. Prices are cached in USD, so
    // throwing the price cache away meant re-asking CoinGecko for every token in
    // the wallet just to change how a number was spelled. The rate is one
    // request and the dashboard redraw is instant.
    clearUsdRate();
    await ensureUsdRate();
    // Re-render the numbers in place. Without this the balance keeps showing the
    // old currency until something else happens to refresh it, which is the
    // same "the control moved and nothing changed" failure as the Save button.
    renderAssets(get('tokens') || []);
    if (get('address')) loadDashboard();
  });
  $('#setAutoLock')?.addEventListener('change', (e) => {
    const minutes = Number(e.target.value);
    const s = get('settings');
    s.autoLock = Number.isFinite(minutes) ? minutes : 5;
    set('settings', { ...s });
    saveSettings();
    startAutoLock();
    toast('Auto-lock set to ' + (minutes === 0 ? 'never' : minutes + ' min'), 'success');
  });
  // The testnet switch, in Settings — the only copy (the picker duplicate was
  // removed 2026-10-04: one toggle per setting). It goes through
  // setTestnetVisible, so this is the single control for the setting.
  $('#setTestnet')?.addEventListener('change', (e) => {
    setTestnetVisible(e.target.checked);
  });
  // NFT auto-detect keys (Settings → NFT auto-detect). Read back on bind,
  // trimmed on change, never echoed anywhere else — BYO credentials that
  // only ride along the two NFT requests they authorise. Empty key = the
  // gallery's on-chain scan, unchanged (js/nft-detect.js contract).
  for (const [sel, key] of [['#setNftKeyOpenSea', 'nftKeyOpenSea'], ['#setNftKeyAlchemy', 'nftKeyAlchemy']]) {
    const inp = $(sel);
    if (!inp) continue;
    inp.value = get(key) || '';
    inp.addEventListener('change', (e) => set(key, e.target.value.trim()));
  }
  // One delete, in the Safety group, where the consequences are spelled out
  // beside it. It used to also sit at the very bottom of the page below the
  // whole Security Center, so a destructive action appeared twice on one screen
  // and the second copy was a long scroll past six other sections.
  $('#btnClearAllData')?.addEventListener('click', clearAllData);
  // The custom RPC field is no longer on this page, and its handler went with
  // it rather than being left as dead code: a control wired to a field that is
  // not there is a claim the app cannot keep.
  // Auto-lock is a dropdown — reflect the saved value (not the HTML default)
  const autoLockEl = $('#setAutoLock');
  if (autoLockEl) autoLockEl.value = String(get('settings').autoLock ?? 5);
  // The testnet switch, from the stored setting rather than from the markup.
  // A switch that boots showing "on" while the setting says "off" is a control
  // that will be flipped by someone who was told the opposite.
  syncTestnetSwitches();
}

// ── EIP-7702 capability check (Settings) ──
// Not a preference — Settings is where you go to FIND OUT things about this
// wallet, and "which of these chains will carry a set-code transaction" is one
// of them. Every answer on screen carries the endpoint that gave it, because
// "Ethereum: yes" is only useful if you can see WHICH Ethereum RPC said so and
// go use it.

const EIP7702_LABEL = {
  [EIP7702_STATUS.SUPPORT]: '✓ SUPPORT',
  [EIP7702_STATUS.UNSUPPORTED]: '✕ NO',
  [EIP7702_STATUS.UNKNOWN]: '? UNCHECKED',
  [EIP7702_STATUS.OFFLINE]: '? OFFLINE',
};

function escAttr(s) {
  // URLs and names reach an href/src attribute; escapeHtml alone leaves a
  // quote intact in an attribute context.
  return escapeHtml(s).replace(/"/g, '&quot;');
}

function renderEip7702Results(results) {
  const out = $('#eip7702Results');
  if (!out) return;
  const s = summarize(results);
  const head = `<p class="small dim" id="eip7702Summary">${s.support} of ${s.total} networks support EIP-7702`
    + (s.unknown + s.offline ? ` · ${s.unknown + s.offline} could not be measured` : '')
    + (s.unsupported ? ` · ${s.unsupported} do not` : '') + '</p>';
  out.innerHTML = head + results.map((r) => {
    const n = r.network;
    const cls = r.status === EIP7702_STATUS.SUPPORT ? 'ok'
      : r.status === EIP7702_STATUS.UNSUPPORTED ? 'no' : 'q';
    // Only endpoints that said YES get a link: a URL that would reject the
    // transaction is not something to hand someone as a remedy.
    const links = r.rpcs
      .filter((x) => x.status === EIP7702_STATUS.SUPPORT)
      .map((x) => `<a class="eip7702-rpc" href="${escAttr(x.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(x.url)}</a>`)
      .join('');
    return `<div class="eip7702-row">
      <div class="eip7702-head">
        <span class="eip7702-net">${escapeHtml(n.icon || '⬡')} ${escapeHtml(n.name)}</span>
        <span class="eip7702-pill eip7702-${cls}" data-status="${r.status}">${EIP7702_LABEL[r.status] || r.status}</span>
        <span class="small dim">${escapeHtml(r.detail || '')}</span>
      </div>
      ${links ? `<div class="eip7702-links">${links}</div>` : ''}
    </div>`;
  }).join('');
}

async function runEip7702Check() {
  const out = $('#eip7702Results');
  const btn = $('#btn7702Check');
  const clearBtn = $('#btnClearEipResults');
  if (!out) return;
  if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
  // Hidden while running; the success path reveals it (live request: "setiap
  // selesai scan nanti muncul tombol [hapus hasil cek]"). A failed scan leaves
  // it hidden — an error line is not check output, so there is nothing to
  // delete then.
  if (clearBtn) clearBtn.hidden = true;
  out.innerHTML = spinner(64, 'Asking every network…');
  let scanned = false;
  try {
    // Custom networks the user added count as networks too — they were told
    // the app supports them, so they get asked the same question.
    const all = [...NETWORKS, ...getCustomNetworks()];
    const results = await checkAllNetworks(all, {
      onResult: (_r, done) => renderEip7702Results(done),
      timeoutMs: 6000,
    });
    // `scanned` means "≥1 network was really asked", not "the call did not
    // throw": checkAllNetworks returns one result per network it walked, and
    // an empty walk is no scan — no output on screen to delete, so the button
    // stays hidden (it used to be revealed unconditionally, because this flag
    // was a literal `true`).
    scanned = Array.isArray(results) && results.length > 0;
  } catch (e) {
    out.innerHTML = `<p class="small text-center">${escapeHtml(explainError(e, 'Checking support'))}</p>`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Check all networks'; }
    if (clearBtn) clearBtn.hidden = !scanned;
  }
}

// ── activity ──
// The rows this view is allowed to show: recorded on the network you are
// standing on — one filter for EVERY activity surface, so renderActivity and
// the per-coin modal can no longer disagree (user, 2026-10-06: "activity di
// list coin sama fitur activity ga sama"). Rows written before netId existed
// have no network to attribute to; showing them everywhere is exactly the
// "mainnet and testnet history in one list" report (same day). They stay in
// storage untouched — only the views stopped showing them.
function currentNetworkActivity() {
  const activeId = get('networkId');
  // …and per WALLET, same doctrine: two wallets sharing a network must not
  // share one list (user, 2026-10-06: "pake 2 wallet tx nya nyatu"). Rows
  // carry their sending wallet from birth (state.js addActivity); a row
  // without an addr has no wallet to claim and stays in storage, out of
  // view — the exact treatment netId-less rows already get above.
  const me = get('address');
  return (get('activity') || []).filter((a) => a && a.netId === activeId && a.addr === me);
}

function renderActivity() {
  loadActivity();
  const list = $('#activityList');
  if (!list) return;
  const visible = currentNetworkActivity();
  if (!visible.length) {
    list.innerHTML = `<div class="empty-state">
      <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
      <p>No transactions yet</p>
    </div>`;
    return;
  }
  // Activity icon mapping
  const actIcon = (type) => {
    const t = (type || '').toLowerCase();
    if (t.includes('send')) return 'send';
    if (t.includes('receive')) return 'receive';
    if (t.includes('swap')) return 'swap';
    if (t.includes('bridge')) return 'bridge';
    if (t.includes('approve')) return 'approve';
    if (t.includes('7702') || t.includes('delegate') || t.includes('revoke')) return 'delegate';
    if (t.includes('rescue') || t.includes('claim') || t.includes('deploy') || t.includes('helper')) return 'deploy';
    return 'send';
  };
  const actSvg = (type) => {
    const cls = actIcon(type);
    const svgs = {
      send: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>',
      receive: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>',
      swap: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
      bridge: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 17h20"/><path d="M4 12V7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v5"/><circle cx="12" cy="17" r="3"/></svg>',
      approve: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
      deploy: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>',
      delegate: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>'
    };
    return `<div class="activity-icon ${cls}">${svgs[cls] || svgs.send}</div>`;
  };
  const rowHTML = (a, i) => `
    <div class="activity-item activity-item--openable" role="button" tabindex="0"
         data-act-index="${i}">
      ${actSvg(a.type)}
      <div class="activity-details">
        <div class="activity-action">${escapeHtml(titleCase(a.type))} — ${escapeHtml(titleCase(a.status))}</div>
        <div class="activity-meta">${escapeHtml(a.detail)} · ${escapeHtml(fmtTimeShort(a.ts))}</div>
      </div>
    </div>`;
  // data-act-index maps straight to visible[i].
  list.innerHTML = visible.map(rowHTML).join('');
  // Tapping a row opens the full record. There is deliberately no explorer link
  // inside the row: role="button" makes the whole subtree presentational, so a
  // nested <a> loses its role while staying in the tab order (a link announced
  // as a button), and an aria-label here would replace the row's own amount,
  // status and timestamp in the accessibility tree. The detail sheet carries
  // the Explorer link instead, where it has a real label to sit on.
  const openRow = (row) => {
    if (!row) return;
    showActivityDetail(visible[Number(row.dataset.actIndex)]);
  };
  $all('.activity-item--openable').forEach(row => {
    row.addEventListener('click', () => openRow(row));
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openRow(row); }
    });
  });
}

// Full history for one activity row: what was recorded locally, then what the
// chain says. The two are complementary — the local record knows what the user
// intended, the chain knows what actually happened (gas, block, nonce), and a
// mismatch between them is exactly what someone reads this panel to find.
async function showActivityDetail(a) {
  if (!a) return;
  // The row's own network, not whatever happens to be active: a sepolia row
  // opened while standing on mainnet used to get mainnet's explorer link and
  // mainnet's provider ("Not found on Ethereum"). Legacy rows without netId
  // fall back to the active network — nothing else is known about them.
  const activeId = get('networkId');
  const rowNetId = a.netId || activeId;
  const net = getNetworkById(rowNetId);
  const row = (k, v, mono = false) =>
    `<div class="dsig-row"><div class="dsig-k">${escapeHtml(k)}</div><div class="dsig-v${mono ? ' mono' : ''}">${v}</div></div>`;
  const val = (v) => escapeHtml(v == null || v === '' ? '—' : String(v));

  const local = [
    row('Action', escapeHtml(titleCase(a.type) || '—')),
    row('Status', escapeHtml(titleCase(a.status) || '—')),
    row('Detail', escapeHtml(a.detail || '—')),
    row('Time', escapeHtml(fmtTime(a.ts))),
    a.hash ? row('Tx hash', `${escapeHtml(a.hash)}
      <button class="copy-btn" data-copy="${escapeHtml(a.hash)}" title="Copy hash" aria-label="Copy transaction hash"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>`, true) : '',
    net?.explorer && a.hash ? row('Explorer', `<a href="${escapeHtml(net.explorer)}/tx/${escapeHtml(a.hash)}" target="_blank" rel="noopener">View on explorer ↗</a>`) : '',
  ].join('');

  openModal(`
    <button class="modal-close" type="button" data-close-modal aria-label="Close">✕</button>
    <h2>Transaction history</h2>
    <div class="dsig-list">${local}</div>
    <div id="actChain">${spinner(40, 'Reading chain…')}</div>
  `, { wide: true });

  const box = $('#actChain');
  const hasHash = a.hash && a.hash.startsWith('0x');
  if (!hasHash) { box.innerHTML = `<p class="small dim">No transaction hash recorded for this entry.</p>`; return; }
  let provider;
  if (rowNetId === activeId) {
    provider = get('provider');
  } else {
    // Off-network row: read it from ITS chain, not the active one.
    provider = await getProvider(net.chainId).catch(() => null);
  }
  if (!provider) {
    box.innerHTML = `<p class="small dim">Connect a network to read this transaction from the chain.</p>`;
    return;
  }
  try {
    const [tx, receipt] = await Promise.all([
      provider.getTransaction(a.hash),
      provider.getTransactionReceipt(a.hash).catch(() => null),
    ]);
    if (!tx && !receipt) { box.innerHTML = `<p class="small dim">Not found on ${escapeHtml(net?.name || 'this network')} yet — it may still be pending.</p>`; return; }
    const gasPrice = tx?.gasPrice ?? 0n;
    const used = receipt?.gasUsed ?? 0n;
    const fee = used * (receipt?.effectiveGasPrice ?? gasPrice);
    // Block timestamp is the honest "when it actually landed", unlike the local
    // record's ts, which is only when the user pressed send.
    const blk = receipt?.blockNumber ? await provider.getBlock(receipt.blockNumber).catch(() => null) : null;
    const sym = net?.symbol || 'ETH';
    // data-copy carries the real value, so the existing global handler does the
    // clipboard work — no bespoke listener needed for these two.
    const copyable = (v) => v
      ? `<span class="mono">${escapeHtml(v)}</span> <button class="copy-btn" data-copy="${escapeHtml(v)}" title="Copy" aria-label="Copy address"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>`
      : '—';
    const chain = [
      receipt ? row('Block', val(receipt.blockNumber)) : '',
      blk?.timestamp ? row('Confirmed at', val(fmtTime(blk.timestamp * 1000))) : '',
      receipt ? row('Status', receipt.status === 1 ? '✅ Success' : '❌ Reverted') : '',
      row('From', copyable(tx?.from)),
      row('To', copyable(tx?.to)),
      tx ? row('Value', escapeHtml(ethers.formatEther(tx.value)) + ' ' + escapeHtml(sym)) : '',
      row('Nonce', val(tx?.nonce)),
      row('Gas used', receipt ? val(used.toString()) : '—'),
      receipt ? row('Gas price', val(ethers.formatUnits(receipt.effectiveGasPrice ?? gasPrice, 'gwei')) + ' gwei') : '',
      receipt ? row('Fee paid', escapeHtml(ethers.formatEther(fee)) + ' ' + escapeHtml(sym)) : '',
    ].filter(Boolean).join('');
    box.innerHTML = `<h3 class="mb-8">On chain</h3><div class="dsig-list">${chain}</div>`;
  } catch (e) {
    console.warn('[BearTool] chain read failed:', e);
    box.innerHTML = `<p class="small" style="color:var(--danger)">${escapeHtml(explainError(e, 'Reading the chain'))}</p>`;
  }
}

// ── settings ──
/**
 * Is this RPC URL safe to put in front of a signing wallet?
 *
 * https is required for anything remote, because a transaction signed here is
 * broadcast in clear over plain HTTP to whatever answers — that is not a
 * theoretical risk, it is the transaction. Loopback is exempt because the
 * traffic never leaves the machine, and because it is the only way the app's
 * own fork workflow (run-fork-all.sh and its anvils on localhost) can be used
 * through the UI at all. The previous rule demanded https unconditionally,
 * which silently threw away "Custom RPC added for Ethereum" and left the
 * balance at zero with no clue why.
 */
export function isSafeRpcUrl(url) {
  const s = String(url || '').trim();
  if (/^https:\/\//i.test(s)) return true;
  if (!/^http:\/\//i.test(s)) return false;
  let host;
  try { host = new URL(s).hostname.toLowerCase(); } catch { return false; }
  return host === 'localhost'
    || host === '127.0.0.1'
    || host === '::1'
    || host === '[::1]'
    || host.endsWith('.localhost');
}

/**
 * Point the wallet at the current network's first RPC again.
 *
 * Two things hold on to the old endpoint: the provider, and any live signer —
 * an ethers Wallet carries its own provider reference, so leaving it alone
 * means the next transaction is signed and broadcast to the RPC the user just
 * replaced. Both are rebuilt here, and a failure leaves the wallet locked
 * rather than half-migrated.
 */
async function reconnectRpc() {
  const net = getNetworkById(get('networkId'));
  if (!net) return;
  try {
    const provider = await getProvider(net.chainId);
    // Switch may have been superseded while getProvider probed its RPCs —
    // installing a provider for a network that is no longer active strands
    // every later call on the wrong chain (CI amoy: verify ran against
    // ethereum, balance 0.00, send refused, no dialog).
    if (get('networkId') !== net.id) return;
    set('provider', provider);
    if (get('unlocked')) {
      const secret = wallet.getSession();
      if (secret) {
        const signer = wallet.signerFromSecret(secret);
        set('signer', signer);
        set('address', signer.address);
      } else {
        set('unlocked', false);
        set('signer', null);
      }
    }
    updateTopbar();
    if (get('address')) loadDashboard();
    // A row left 'pending' by a closed tab must be settled against the chain
    // before the history is shown, or a finished transfer reads as in-flight
    // forever. Fire-and-forget: the view already rendered, and a node that
    // cannot answer must not block the dashboard.
    reconcileActivity(get('provider')).then((r) => {
      if (r.settled || r.failed) { emit('activity'); renderActivity(); }
    }).catch(() => { /* the honest state is 'pending', not a guess */ });
  } catch (e) {
    toast('Could not connect to the new RPC: ' + (e?.message || e), 'error');
  }
}

function clearAllData() {
  openModal(`
    <button class="modal-close" type="button" data-close-modal>✕</button>
    <h2>🗑️ Delete Wallet?</h2>
    <div class="danger-box">This deletes ALL wallets, settings, and activity from this browser. Irreversible!</div>
    <div class="flex gap-8" style="justify-content:center">
      <button class="btn btn-danger btn-lg" id="clearBtn">Delete Wallet</button>
      <button class="btn btn-ghost btn-lg" type="button" data-close-modal>No</button>
    </div>
  `);
  $('#clearBtn').onclick = () => {
    wallet.clearKeystore();
    wallet.clearSession();
    localStorage.removeItem('bear.settings');
    localStorage.removeItem('bear.activity');
    localStorage.removeItem('bear.customNetworks');
    localStorage.removeItem('bear.lang');
    localStorage.removeItem('bear.priceCache');
    set('unlocked', false); set('signer', null); set('address', null);
    closeModal();
    toast('All data cleared.', 'info');
    showWelcomeModal();
  };
}

// ── address book ──
function loadAddressBook() {
  try {
    return JSON.parse(localStorage.getItem('bear.addressBook') || '[]');
  } catch { return []; }
}
function saveAddressBook(list) {
  localStorage.setItem('bear.addressBook', JSON.stringify(list));
}
function renderAddressBook() {
  const list = loadAddressBook();
  const el = $('#addressBookList');
  if (!el) return;
  if (!list.length) {
    el.innerHTML = '<p class="small text-center">No saved addresses yet.</p>';
    return;
  }
  el.innerHTML = list.map((item, i) => `
    <div class="ab-item">
      <div class="token-icon default">${(item.label || '?').slice(0, 2).toUpperCase()}</div>
      <div class="ab-item-info">
        <div class="ab-item-label">${escapeHtml(item.label)}</div>
        <div class="ab-item-address">${escapeHtml(wallet.shortAddress(item.address))}</div>
      </div>
      <div class="ab-item-actions">
        <button class="copy-btn" data-copy="${escapeHtml(item.address)}" title="Copy" aria-label="Copy address"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
        <button class="copy-btn ab-delete" data-idx="${i}" title="Delete" aria-label="Delete this backup"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
    </div>`).join('');
  // Delete handlers
  el.querySelectorAll('.ab-delete').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx);
      const ab = loadAddressBook();
      ab.splice(idx, 1);
      saveAddressBook(ab);
      renderAddressBook();
      toast('Address removed', 'info');
    });
  });
}
function initAddressBook() {
  renderAddressBook();
  $('#btnAddAddress')?.addEventListener('click', () => {
    const label = $('#abLabel').value.trim();
    const address = $('#abAddress').value.trim();
    if (!label || !address) return toast('Label and address required', 'error');
    if (!wallet.isValidAddress(address)) return toast('Invalid address', 'error');
    const ab = loadAddressBook();
    ab.push({ label, address });
    saveAddressBook(ab);
    $('#abLabel').value = '';
    $('#abAddress').value = '';
    renderAddressBook();
    toast('Address saved', 'success');
  });
}

// init activity
loadActivity();
initAddressBook();
// Hero sparkline — 24h native price from CoinGecko, auto-paired to the
// chain's native coin id (no manual symbol→id map to maintain). Cosmetic:
// an empty canvas or a missing element must never block the dashboard.
async function renderHeroSpark(net) {
  const canvas = $('#heroSpark');
  if (!canvas || !net) return;
  // fetchPriceHistory now surfaces a rate limit as a named error (price.js);
  // the sparkline is cosmetic, so a throw must never reach the dashboard.
  let history;
  try {
    history = await fetchPriceHistory({ address: null, chainId: net.chainId });
  } catch { return; }
  if (!Array.isArray(history) || history.length < 2) return;
  const w = canvas.clientWidth || 200;
  const h = 40;
  const min = Math.min(...history);
  const max = Math.max(...history);
  const range = (max - min) || 1;
  const step = w / (history.length - 1);
  const points = history.map((v, i) => {
    const x = (i * step).toFixed(1);
    const y = (h - 2 - ((v - min) / range) * (h - 6)).toFixed(1);
    return `${x},${y}`;
  }).join(' ');
  const last = history[history.length - 1];
  const first = history[0];
  const up = last >= first;
  canvas.innerHTML = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" width="100%" height="${h}" role="img" aria-label="24h price trend"><polyline points="${points}" fill="none" stroke="${up ? '#1B8F4E' : '#D64545'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
