// ═══════════════════════════════════════════════════════════════
// security-center.js — the settings page where all of it is visible.
//
// Most wallets bury this. MetaMask, Coinbase and Rabby all surface sessions and
// approvals somewhere, but a user who cannot see which sites can reach their
// wallet has no way to notice that something else can. Everything the browser
// and the bridge enforce gets a row here, and every row says what it does.
//
// The "what this cannot do" block is not a disclaimer, it is the useful part:
// a user who thinks a cross-origin dApp can silently reach the wallet will
// behave differently from one who knows it cannot.
// ═══════════════════════════════════════════════════════════════

import { $, escapeHtml, toast } from './ui.js';
import {
  listSites, removeSite, clearSites,
  listBlocked, addBlockedHost, removeBlockedHost,
  listTrusted, addTrustedHost, removeTrustedHost,
  clearBrowsingData, revokePermission,
} from './dapp-sessions.js';
import { ALLOWED_METHODS, CONFIRMED_METHODS, BIG_VALUE_WEI } from './security.js';

const row = (label, value) =>
  `<div class="sec-row"><span class="sec-k">${escapeHtml(label)}</span><span class="sec-v">${value}</span></div>`;

function sitesBlock() {
  const sites = listSites();
  if (!sites.length) {
    return '<p class="small dim sec-empty">No site is connected. A page must be granted access before it can see anything.</p>';
  }
  return sites.map((s) => `
    <div class="sec-item" data-origin="${escapeHtml(s.origin)}">
      <div class="sec-item-main">
        <div class="sec-item-t">${escapeHtml(s.name || s.origin)}</div>
        <div class="sec-item-s mono">${escapeHtml(s.origin)}${s.at ? ' · since ' + new Date(s.at).toLocaleDateString() : ''}</div>
        ${s.perms.length
          ? `<div class="sec-perms">${s.perms.map((m) => `
              <span class="sec-perm">${escapeHtml(m)}
                <button class="sec-x" data-revoke-perm="${escapeHtml(m)}" data-origin="${escapeHtml(s.origin)}"
                        aria-label="Revoke ${escapeHtml(m)}" title="Revoke">×</button></span>`).join('')}</div>`
          : '<div class="sec-perms small dim">Reads only. No signing or sending has been authorised.</div>'}
      </div>
      <button class="btn btn-sm btn-danger" data-disconnect="${escapeHtml(s.origin)}">Disconnect</button>
    </div>`).join('');
}

function listBlock(title, list, kind, hint) {
  return `
    <div class="sec-sub">
      <div class="sec-sub-t">${escapeHtml(title)} <span class="small dim">(${list.length})</span></div>
      <p class="small dim">${escapeHtml(hint)}</p>
      ${list.length ? `<div class="sec-chips">${list.map((h) => `
        <span class="sec-chip">${escapeHtml(h)}
          <button class="sec-x" data-rm-${kind}="${escapeHtml(h)}" aria-label="Remove ${escapeHtml(h)}">×</button></span>`).join('')}</div>`
        : '<p class="small dim sec-empty">Nothing on this list.</p>'}
      <div class="sec-add">
        <input class="input input-sm" id="secAdd${kind}" placeholder="example.com" spellcheck="false" autocomplete="off" aria-label="Host to add">
        <button class="btn btn-sm btn-secondary" data-add="${kind}">Add</button>
      </div>
    </div>`;
}

export function renderSecurityCenter(container) {
  if (!container) return;
  const blocked = listBlocked();
  const trusted = listTrusted();

  container.innerHTML = `
    <div class="sec-block">
      <h4 class="sec-h">Token approvals</h4>
      <p class="small dim">An approval you have already granted keeps working until it is revoked on
      chain — revoking a permission here is not the same thing. The scanner at the top of this very
      view reads every live allowance straight from the chain and lets you set it back to zero.</p>
    </div>

    <div class="sec-block">
      <h4 class="sec-h">What a dApp can and cannot reach</h4>
      <p class="small dim">Stated plainly, because guessing wrong here is what makes people
      over-trust a page or under-use the wallet.</p>
      ${row('dApp page', 'Runs in its own origin: no cookies, no storage, no referrer, no clipboard, no camera or mic.')}
      ${row('Reads your balance', '<strong>Needs permission</strong> — per site, revocable below.')}
      ${row('Signs a message', '<strong>Needs a second, separate grant</strong>, per method.')}
      ${row('Moves funds', 'Your own actions — Send, Swap, Bridge, Rescue, Batch — always show a confirmation with the details first, and never run automatically. <strong>A dApp page is different</strong>: it asks once for the methods it needs, and after that grant it can call them without asking you again. Revoke it below to force the question to come back.')}
      ${row('A cross-origin dApp detecting this wallet', '<strong>Not possible.</strong> No page on another site can see this wallet. Injection needs a native wrapper, a proxy or an extension — a web page cannot do it.')}
    </div>

    <div class="sec-block">
      <h4 class="sec-h">Connected sites</h4>
      <div id="secSites">${sitesBlock()}</div>
      <button class="btn btn-sm btn-danger" id="secDisconnectAll"${listSites().length ? '' : ' disabled'}>Disconnect all</button>
    </div>

    <div class="sec-block">
      <h4 class="sec-h">Site lists</h4>
      ${listBlock('Blocked', blocked, 'blocked', 'Never loaded, and there is no way to proceed past the warning. Use this for sites you have reported.')}
      ${listBlock('Trusted', trusted, 'trusted', 'Clears the "nobody has checked this site" warning. It cannot clear a homograph, a punycode host or a blocked scheme — those are refused regardless.')}
    </div>

    <div class="sec-block">
      <h4 class="sec-h">Before a signature</h4>
      <p class="small dim">Every signing or spending call from a dApp is scanned before you
      confirm it, and anything these detectors flag is shown in that confirmation with the
      reason. They read public calldata — no third party, no upload, no telemetry. They are
      decoders and heuristics, so they can miss something; that is why the raw calldata is shown
      alongside them rather than instead of them.</p>
      <p class="small dim">They do <strong>not</strong> run on transactions you start yourself from
      Send, Swap, Bridge, Deploy or the 7702 tools — those have their own confirmations with the
      decoded details, and this scanner is specific to the dApp path.</p>
      ${row('Unlimited approval', 'Look for the spender in the confirmation. This is the step that empties wallets.')}
      ${row('Operator grant (setApprovalForAll)', 'Check whether an <span class="mono">operator</span> address is being authorised — it can take any NFT you own.')}
      ${row('Off-chain permit', 'An <span class="mono">approve</span> in a signature, not a transaction: authorises a spender now, spends later.')}
      ${row('Unreadable selector', 'Raw hex in the confirmation means nothing decoded it. Do not guess.')}
      ${row('First-time contract', 'A destination you have never transacted with before.')}
      ${row(`Value above ${(Number(BIG_VALUE_WEI) / 1e18).toFixed(0)} native unit`, 'Treat any large transfer as final. It cannot be reversed.')}
      ${row('Methods exposed to a page', `${ALLOWED_METHODS.size} allowed, ${CONFIRMED_METHODS.size} of which always need confirmation.`)}
    </div>

    <div class="sec-block">
      <h4 class="sec-h">Browsing data</h4>
      <p class="small dim">Clearing this forgets tabs, history and bookmarks. It does <strong>not</strong>
      disconnect a site — those are different intentions, and one should not quietly undo the other.</p>
      <button class="btn btn-sm btn-secondary" id="secClearData">Clear tabs, history and bookmarks</button>
    </div>

    <div class="sec-block">
      <h4 class="sec-h">Stored keys</h4>
      <p class="small dim">The OpenSea key is a public read key, kept in this browser only. It is never
      sent to any Bear Tool server, because there is no Bear Tool server. A wallet key is never
      stored here at all.</p>
      <div id="secKeyRow">${keyRow()}</div>
      <button class="btn btn-sm btn-secondary" id="secClearKey">Forget the saved key</button>
    </div>`;

  wire(container);
}

function keyRow() {
  let k = '';
  try { k = localStorage.getItem('bear.openseaKey') || ''; } catch { /* private mode */ }
  return row('OpenSea API key', k ? 'Saved in this browser' : 'None saved');
}

function refreshSites(container) {
  const box = container.querySelector('#secSites');
  if (box) box.innerHTML = sitesBlock();
  const all = container.querySelector('#secDisconnectAll');
  if (all) all.disabled = !listSites().length;
}

function wire(container) {
  container.querySelectorAll('[data-disconnect]').forEach((b) => {
    b.addEventListener('click', () => {
      removeSite(b.dataset.disconnect);
      toast('Disconnected ' + b.dataset.disconnect, 'info');
      renderSecurityCenter(container);
    });
  });

  container.querySelectorAll('[data-revoke-perm]').forEach((b) => {
    b.addEventListener('click', () => {
      revokePermission(b.dataset.origin, b.dataset.revokePerm);
      toast('Revoked ' + b.dataset.revokePerm, 'info');
      renderSecurityCenter(container);
    });
  });

  container.querySelector('#secDisconnectAll')?.addEventListener('click', () => {
    clearSites();
    toast('Every site disconnected', 'info');
    renderSecurityCenter(container);
  });

  const hookList = (kind, add, remove) => {
    container.querySelectorAll(`[data-rm-${kind}]`).forEach((b) => {
      b.addEventListener('click', () => {
        remove(b.dataset['rm' + kind[0].toUpperCase() + kind.slice(1)]);
        renderSecurityCenter(container);
      });
    });
    container.querySelector(`[data-add="${kind}"]`)?.addEventListener('click', () => {
      const input = container.querySelector(`#secAdd${kind}`);
      const v = (input?.value || '').trim();
      if (!v) return;
      add(v);
      input.value = '';
      toast(kind === 'blocked' ? 'Blocked ' + v : 'Marked ' + v + ' as trusted', 'info');
      renderSecurityCenter(container);
    });
    container.querySelector(`#secAdd${kind}`)?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); container.querySelector(`[data-add="${kind}"]`)?.click(); }
    });
  };
  hookList('blocked', addBlockedHost, removeBlockedHost);
  hookList('trusted', addTrustedHost, removeTrustedHost);

  container.querySelector('#secClearData')?.addEventListener('click', () => {
    clearBrowsingData();
    toast('Browsing data cleared. Connected sites were left alone.', 'info');
    renderSecurityCenter(container);
  });

  container.querySelector('#secClearKey')?.addEventListener('click', () => {
    try { localStorage.removeItem('bear.openseaKey'); } catch { /* private mode */ }
    globalThis.__OPENSEA_API_KEY = '';
    const k = $('#openSeaApiKey');
    if (k) k.value = '';
    toast('Saved key forgotten', 'info');
    renderSecurityCenter(container);
  });
}
