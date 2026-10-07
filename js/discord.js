// ═══════════════════════════════════════════════════════════════
// discord.js — the Discord view (M3): connect, servers, leave, talk.
//
// Replaces the Approval Manager the user asked to remove. Two connect
// methods, because both halves of the original ask need a different one:
//
//   1. LOGIN WITH DISCORD (OAuth2 authorization code + PKCE, PUBLIC
//      client). Discord's docs: "If your app does not have a backend
//      server, enable Public Client in the Discord Developer Portal"
//      (discord.com/developers/docs, accessed 2026-10-06) — the token
//      exchange then works WITHOUT a client_secret, so the only value
//      the user ever supplies is the public Client ID. Stored as
//      bear.discordClientId; tokens as bear.discordAuth.
//   2. PASTE USER TOKEN — instant, no portal, and the only method that
//      can POST messages: Discord exposes no user-message scope to
//      OAuth, so #sendMessage refuses in OAuth mode with that exact
//      reason instead of burning a request on a guaranteed 403.
//
// All calls go straight to discord.com/api/v10 from the browser: their
// CORS preflight echoes our Origin with Authorization allowed and
// POST/GET/PATCH/DELETE permitted (measured 2026-10-06 — see docs/
// research note in M3 commit). No proxy, no key, no server.
//
// Token storage: localStorage (same trust model as bear.openseaKey).
// The paste path never leaves the device; logout wipes the key.
// ═══════════════════════════════════════════════════════════════

import { $, escapeHtml, toast, openModal, closeModal } from './ui.js';

export const DISCORD_API = 'https://discord.com/api/v10';
const AUTH_KEY = 'bear.discordAuth';
const CLIENT_ID_KEY = 'bear.discordClientId';
const STATE_KEY = 'bear.discordState';     // sessionStorage: OAuth CSRF
const SCOPES = 'identify guilds';
const LEAVE_ALL_DELAY_MS = 300;            // polite pacing on bulk leave
const MAX_MESSAGE = 2000;                  // Discord's own limit

// ── storage ─────────────────────────────────────────────────────
export function readAuth() {
  try { return JSON.parse(localStorage.getItem(AUTH_KEY) || 'null'); }
  catch { return null; }
}
export function writeAuth(auth) {
  localStorage.setItem(AUTH_KEY, JSON.stringify(auth));
}
export function clearAuth() {
  try { localStorage.removeItem(AUTH_KEY); } catch { /* private mode */ }
}
export function getClientId() {
  try { return localStorage.getItem(CLIENT_ID_KEY) || ''; } catch { return ''; }
}
export function setClientId(id) {
  const v = String(id || '').trim();
  if (v) localStorage.setItem(CLIENT_ID_KEY, v);
  else localStorage.removeItem(CLIENT_ID_KEY);
}

// ── PKCE ────────────────────────────────────────────────────────
function base64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function pkcePair() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

export function oauthAuthorizeUrl({ clientId, challenge, redirectUri, state }) {
  const p = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    scope: SCOPES,
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return `${DISCORD_API}/oauth2/authorize?${p.toString()}`;
}

// The exact string Discord requires in the portal's Redirects list.
// `loc` is injectable so tests can assert the form without a browser;
// the typeof fallback keeps the paint path alive on a non-browser host
// (a crash inside connectHtml would hide the real error it carries).
export function redirectUri(loc = (typeof location !== 'undefined' ? location : { origin: '', pathname: '' })) {
  return loc.origin + loc.pathname;
}

// Discord's portal only accepts redirect hosts it can place globally (a
// full domain name) or loopback (localhost / 127.0.0.1 / ::1), over
// http(s). Serving the app from a LAN IP (http://192.168.1.9:5173/) or
// a non-web scheme makes EVERY authorize attempt die on Discord's own
// page with "invalid oauth2:redirect_uri" — it never reaches this app,
// so the fix has to happen before the user clicks Login.
// Returns a human-readable reason, or '' when the origin can work.
export function oauthRejectsOrigin(loc = (typeof location !== 'undefined' ? location : null)) {
  if (!loc || !loc.origin) return '';
  if (!/^https?:\/\//.test(loc.origin)) {
    return `${loc.origin} is not an http(s) origin — Discord can only redirect to http(s) URLs.`;
  }
  const host = (loc.hostname || '').replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return '';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return `You are on an IP address (${host}) — Discord redirects only accept localhost or a full domain. Open this app via http://localhost:<port>/ instead.`;
  }
  if (!host.includes('.')) {
    return `\"${host}\" is not a full domain name — Discord redirects only accept localhost or a full domain.`;
  }
  return '';
}

async function tokenRequest(payload, fetchFn = fetch) {
  const res = await fetchFn(`${DISCORD_API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(payload).toString(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const why = body.error_description || body.error || `HTTP ${res.status}`;
    throw new Error(`Discord token exchange failed: ${why}`);
  }
  if (!body.access_token) throw new Error('Discord token exchange returned no access_token');
  return body;
}

export async function exchangeCode({ clientId, code, verifier, redirectUri: ruri }, fetchFn = fetch) {
  const body = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: ruri,
    client_id: clientId,
    code_verifier: verifier,
  }, fetchFn);
  writeAuth({
    mode: 'oauth',
    access: body.access_token,
    refresh: body.refresh_token || null,
    expires: body.expires_in ? Date.now() + body.expires_in * 1000 : null,
    scope: body.scope || SCOPES,
  });
  return body;
}

export async function refreshOAuth(clientId, fetchFn = fetch) {
  const auth = readAuth();
  if (!auth?.refresh) throw new Error('Discord session expired — log in again');
  const body = await tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: auth.refresh,
    client_id: clientId,
  }, fetchFn);
  writeAuth({
    ...auth,
    access: body.access_token,
    refresh: body.refresh_token || auth.refresh,
    expires: body.expires_in ? Date.now() + body.expires_in * 1000 : null,
  });
  return body;
}

/**
 * Finish an OAuth redirect if this page load IS one: ?code=…&state=…
 * with the state this browser created. Returns true when a session was
 * stored (the caller may re-route to the Discord view). A redirect with
 * a state we never issued is not ours to consume — false, query left
 * alone for whoever it belongs to.
 */
export async function finishOAuthRedirect(search, fetchFn = fetch, env = {}) {
  const q = new URLSearchParams(search ?? (typeof location !== 'undefined' ? location.search : ''));
  if (!q.get('code') || !q.get('state')) return false;
  const store = env.session ?? (typeof sessionStorage !== 'undefined' ? sessionStorage : null);
  let expected = null;
  try { expected = store?.getItem(STATE_KEY) ?? null; } catch { /* private mode */ }
  if (!expected || q.get('state') !== expected) return false;
  try { store?.removeItem(STATE_KEY); } catch { /* private mode */ }
  const clientId = getClientId();
  if (!clientId) throw new Error('Discord Client ID is missing — set it in the Discord view');
  await exchangeCode({
    clientId,
    code: q.get('code'),
    verifier: await storedOrFreshVerifier(store),
    redirectUri: redirectUri(env.location ?? location),
  }, fetchFn);
  // Strip the one-shot code from the address bar (it is single use, but a
  // lingering credential in history is still a credential).
  (env.history ?? history).replaceState(null, '', (env.location ?? location).pathname);
  return true;
}

// PKCE verifier survival across the redirect: sessionStorage.
const VERIFIER_KEY = 'bear.discordVerifier';
async function storedOrFreshVerifier(store = typeof sessionStorage !== 'undefined' ? sessionStorage : null) {
  try { return store?.getItem(VERIFIER_KEY) || ''; }
  catch { return ''; }
}

/**
 * Kick off "Login with Discord". Stores verifier+state, then navigates.
 * `nav` is injectable: the navigation itself is not what tests should
 * assert (the URL is, via oauthAuthorizeUrl).
 */
export async function startOAuthLogin(clientId, env = {}) {
  const id = String(clientId || '').trim();
  if (!id) throw new Error('Enter your Discord application Client ID first');
  if (!/^\d{17,20}$/.test(id)) throw new Error('Client ID must be the numeric ID from the Discord Developer Portal');
  const { verifier, challenge } = await pkcePair();
  const state = base64url(crypto.getRandomValues(new Uint8Array(16)));
  const store = env.session ?? (typeof sessionStorage !== 'undefined' ? sessionStorage : null);
  try {
    store?.setItem(STATE_KEY, state);
    store?.setItem(VERIFIER_KEY, verifier);
  } catch { throw new Error('Session storage is unavailable — cannot start the login safely'); }
  if (!store) throw new Error('Session storage is unavailable — cannot start the login safely');
  setClientId(id);
  const url = oauthAuthorizeUrl({
    clientId: id, challenge, redirectUri: redirectUri(env.location ?? location), state,
  });
  (env.nav ?? ((u) => { location.href = u; }))(url);
  return url;
}

// ── authenticated API ───────────────────────────────────────────
/**
 * A valid session, refreshed if the OAuth token has expired. Returns
 * { mode, access } — mode decides how the Authorization header is built
 * (OAuth = `Bearer …`, a pasted user token = the raw token, which is
 * how Discord authenticates those).
 */
export async function activeAuth(fetchFn = fetch) {
  const auth = readAuth();
  if (!auth?.access) return null;
  if (auth.mode === 'oauth' && auth.expires && auth.expires < Date.now() + 30_000) {
    await refreshOAuth(getClientId(), fetchFn);   // throws honestly on failure
    return activeAuth(fetchFn);
  }
  return { mode: auth.mode, access: auth.access };
}

export async function discordFetch(path, { method = 'GET', body, fetchFn = fetch } = {}) {
  const auth = await activeAuth(fetchFn);
  if (!auth) throw new Error('Not connected to Discord — connect first');
  const headers = {
    Authorization: auth.mode === 'oauth' ? `Bearer ${auth.access}` : auth.access,
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetchFn(DISCORD_API + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j?.message) msg = j.message + (j.retry_after ? ` (retry in ${j.retry_after}s)` : '');
    } catch { /* non-JSON body — keep the status */ }
    throw new Error(`Discord ${method} ${path} failed: ${msg}`);
  }
  if (res.status === 204) return null;
  return res.json().catch(() => null);
}

export const fetchMe = (fetchFn) => discordFetch('/users/@me', { fetchFn });
export const fetchGuilds = (fetchFn) => discordFetch('/users/@me/guilds', { fetchFn });
export const leaveGuild = (id, fetchFn) =>
  discordFetch(`/users/@me/guilds/${id}`, { method: 'DELETE', fetchFn });
export const fetchChannels = (guildId, fetchFn) =>
  discordFetch(`/guilds/${guildId}/channels`, { fetchFn });

export async function sendMessage(channelId, content, fetchFn = fetch) {
  const text = String(content || '').trim();
  if (!text) throw new Error('Message is empty');
  if (text.length > MAX_MESSAGE) throw new Error(`Discord limits messages to ${MAX_MESSAGE} characters`);
  const auth = await activeAuth(fetchFn);
  if (auth?.mode === 'oauth') {
    // No user-message scope exists in Discord's OAuth surface. Saying so is
    // the honest answer; a request would come back 403 anyway.
    throw new Error('Sending messages needs the pasted-token connect — OAuth has no message scope');
  }
  return discordFetch(`/channels/${channelId}/messages`, { method: 'POST', body: { content }, fetchFn });
}

/**
 * Leave every guild the account is in. Stops at the first failure and
 * reports exactly how many left — partial success is reported as
 * partial, never as "done".
 */
export async function leaveAllGuilds(guilds, onProgress, fetchFn = fetch) {
  const list = Array.isArray(guilds) ? guilds : [];
  let left = 0;
  for (const g of list) {
    try {
      await leaveGuild(g.id, fetchFn);
      left++;
      if (onProgress) onProgress(left, list.length, g);
      await new Promise((r) => setTimeout(r, LEAVE_ALL_DELAY_MS));
    } catch (e) {
      const err = new Error(`Left ${left} of ${list.length} servers, stopped at "${g.name || g.id}": ${e.message}`);
      err.partial = left;
      throw err;
    }
  }
  return left;
}

// ── view ────────────────────────────────────────────────────────
let discordRoot = null;

const modeBadge = (mode) => mode === 'oauth'
  ? '<span class="badge">OAuth (login)</span>'
  : '<span class="badge">User token (pasted)</span>';

function connectHtml(note = '') {
  const cid = getClientId();
  // Discord rejects some origins on ITS side before this app ever sees an
  // error — surface that here, next to the button that would fail.
  const originProblem = oauthRejectsOrigin();
  const loginDisabled = originProblem ? ' disabled' : '';
  const originWarn = originProblem
    ? `<div class="warn-box small mb-8" id="discordOriginWarn" role="alert">⚠️ ${escapeHtml(originProblem)}</div>`
    : '';
  return `
    <div class="card">
      <div class="card-title">Connect Discord</div>
      <p class="small mb-8">Two ways in. <b>Login with Discord</b> is the official flow — create an
      application at <span class="mono">discord.com/developers</span>, copy its <b>Client ID</b>
      (public, never a secret), and register this exact Redirect URI
      (OAuth2 → Redirects — must match <b>character for character, including the trailing slash</b>):</p>
      <p class="small mono mb-8" id="discordRedirect">${escapeHtml(redirectUri())}</p>
      ${originWarn}
      <div class="field">
        <label for="discordClientId">Client ID</label>
        <input class="input mono" id="discordClientId" inputmode="numeric" placeholder="123456789012345678" value="${escapeHtml(cid)}">
      </div>
      <div class="discord-connect-actions">
        <button type="button" class="btn btn-primary" id="btnDiscordLogin"${loginDisabled}>Login with Discord</button>
        <button type="button" class="btn btn-ghost" id="btnDiscordCopyRedirect">Copy redirect URI</button>
      </div>
      <hr class="discord-hr">
      <div class="field">
        <label for="discordToken">Or paste a user token</label>
        <input class="input mono" id="discordToken" type="password" autocomplete="off" placeholder="token (keeps this device only)">
      </div>
      <button type="button" class="btn" id="btnDiscordConnect">Connect with token</button>
      <div id="discordStatus" class="small dim mt-16">${escapeHtml(note)}</div>
    </div>`;
}

function profileHtml(me, auth) {
  const avatar = me.avatar
    ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=64`
    : 'https://cdn.discordapp.com/embed/avatars/0.png';
  return `
    <div class="card">
      <div class="card-title">Connected ${modeBadge(auth.mode)}</div>
      <div class="discord-me">
        <img class="discord-avatar" src="${escapeHtml(avatar)}" alt="" width="48" height="48">
        <div>
          <div class="discord-me-name">${escapeHtml(me.global_name || me.username || 'unknown')}</div>
          <div class="small dim mono">@${escapeHtml(me.username || '')} · id ${escapeHtml(me.id)}</div>
        </div>
        <div class="discord-me-actions">
          <button type="button" class="btn btn-ghost" id="btnDiscordRefresh">Refresh</button>
          <button type="button" class="btn btn-ghost" id="btnDiscordLogout">Log out</button>
        </div>
      </div>
      <div id="discordStatus" class="small dim mt-8"></div>
    </div>`;
}

function guildHtml(g, mode) {
  const icon = g.icon
    ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=64`
    : 'https://cdn.discordapp.com/embed/avatars/1.png';
  const owner = g.owner ? ' · owner' : '';
  return `
    <div class="discord-guild" data-guild="${escapeHtml(g.id)}">
      <img class="discord-guild-icon" src="${escapeHtml(icon)}" alt="" width="40" height="40">
      <div class="discord-guild-main">
        <div class="discord-guild-name">${escapeHtml(g.name || g.id)}<span class="small dim">${owner}</span></div>
        <div class="discord-guild-actions">
          <a class="btn btn-ghost btn-sm" href="https://discord.com/channels/${escapeHtml(g.id)}" target="_blank" rel="noopener noreferrer">Open</a>
          <button type="button" class="btn btn-ghost btn-sm" data-guild-channels="${escapeHtml(g.id)}">Channels</button>
          <button type="button" class="btn btn-danger btn-sm" data-guild-leave="${escapeHtml(g.id)}" data-guild-name="${escapeHtml(g.name || g.id)}">Leave</button>
        </div>
      </div>
    </div>`;
}

export async function renderDiscord(root, fetchFn = fetch) {
  discordRoot = root;
  if (!root) return;
  // A refresh that fails is a REASON, not a null: swallowing it would show
  // the connect form with no explanation — the exact silence every other
  // view in this app refuses to ship.
  let auth = null;
  let sessionError = null;
  try {
    auth = await activeAuth(fetchFn);
  } catch (e) {
    sessionError = e;      // stale OAuth the refresh could not save
  }
  if (!auth) {
    // The reason is painted INTO the form — a swallowed refresh error that
    // only updates an element the caller may not have is the same silence
    // as no error at all.
    root.innerHTML = connectHtml(sessionError ? `⚠️ ${sessionError.message}` : '');
    return;
  }
  let me = null;
  let guilds = [];
  try {
    [me, guilds] = await Promise.all([fetchMe(fetchFn), fetchGuilds(fetchFn)]);
  } catch (e) {
    root.innerHTML = connectHtml();
    const st = $('#discordStatus');
    if (st) st.textContent = `⚠️ ${e.message}`;
    return;
  }
  const status = guilds.length ? '' : 'No servers on this account.';
  root.innerHTML = `
    ${profileHtml(me, auth)}
    <div class="card mt-16">
      <div class="card-title">Servers (${guilds.length})</div>
      <div class="discord-guild-actions mb-8">
        <button type="button" class="btn btn-danger ${guilds.length > 1 ? '' : 'hidden'}" id="btnDiscordLeaveAll">Leave all ${guilds.length} servers</button>
      </div>
      <div id="discordGuildList">${guilds.map((g) => guildHtml(g, auth.mode)).join('') ||
        '<p class="small dim">No servers.</p>'}</div>
      <div id="discordStatus" class="small dim mt-8">${escapeHtml(status)}</div>
    </div>`;
}

function say(msg, type = 'info') {
  // Defensive on purpose: renderDiscord's error path runs this, and a
  // reason that crashes before it can be shown is no reason at all
  // (also what lets the paint path be unit-tested outside a browser).
  let st = null;
  try { st = $('#discordStatus'); } catch { /* no DOM (test host) */ }
  if (st) st.textContent = msg;
  if (type === 'error') {
    try { toast(msg, 'error'); } catch { /* no DOM — text still stands */ }
  }
}

function confirmLeave(ids, label) {
  const many = ids.length > 1;
  openModal(`
    <button class="modal-close" type="button" data-close-modal>✕</button>
    <div class="tx-confirm">
      <h3>${many ? 'Leave ALL servers?' : 'Leave this server?'}</h3>
      <p class="small">${many
        ? `You will leave <b>${ids.length} servers</b>. Rejoining needs a fresh invite.`
        : `You will leave <b>${escapeHtml(label)}</b>. Rejoining needs a fresh invite.`}</p>
      <div class="tx-actions">
        <button type="button" class="btn btn-ghost" data-close-modal>Cancel</button>
        <button type="button" class="btn btn-danger" id="btnDiscordLeaveConfirm">${many ? 'Leave all' : 'Leave'}</button>
      </div>
    </div>`);
  $('#btnDiscordLeaveConfirm').onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      if (many) {
        const list = await fetchGuilds();
        const left = await leaveAllGuilds(list, (done, total) => say(`Left ${done}/${total}…`));
        // The count comes from the RUN, not from what was on screen when the
        // dialog opened — a list that changed mid-run must not be reported.
        say(`Left ${left} servers.`);
      } else {
        await leaveGuild(ids[0]);
        say(`Left ${label}.`);
      }
      closeModal();
      if (discordRoot) await renderDiscord(discordRoot);
    } catch (err) {
      btn.disabled = false;
      say(err.message, 'error');
    }
  };
}

/**
 * Delegated listeners for everything the view paints. Bound ONCE from
 * app.js — innerHTML swaps replace the nodes, never this binding.
 */
export function bindDiscordPanel(deps = {}) {
  const root = () => discordRoot;
  document.addEventListener('click', async (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;

    if (t.id === 'btnDiscordCopyRedirect') {
      try {
        await navigator.clipboard.writeText(redirectUri());
        toast('Redirect URI copied — paste it in the Discord portal', 'success');
      } catch { toast('Copy failed — select the URI manually', 'error'); }
      return;
    }

    if (t.id === 'btnDiscordLogin') {
      const cid = $('#discordClientId')?.value || '';
      const fn = deps.startOAuthLogin || startOAuthLogin;
      t.disabled = true;
      try {
        await fn(cid);
      } catch (err) {
        t.disabled = false;
        say(err.message, 'error');
      }
      return;
    }

    if (t.id === 'btnDiscordConnect') {
      const token = $('#discordToken')?.value?.trim();
      if (!token) { say('Paste a token first', 'error'); return; }
      t.disabled = true;
      try {
        writeAuth({ mode: 'token', access: token, refresh: null, expires: null });
        await fetchMe();                       // validates before trusting it
        toast('Connected', 'success');
        if (root()) await renderDiscord(root());
      } catch (err) {
        clearAuth();
        say(err.message, 'error');
      } finally {
        t.disabled = false;
      }
      return;
    }

    if (t.id === 'btnDiscordLogout') {
      clearAuth();
      toast('Disconnected from Discord', 'success');
      if (root()) await renderDiscord(root());
      return;
    }

    if (t.id === 'btnDiscordRefresh') {
      if (root()) await renderDiscord(root());
      return;
    }

    if (t.id === 'btnDiscordLeaveAll') {
      const list = await fetchGuilds().catch(() => null);
      if (!list?.length) { say('No servers to leave', 'error'); return; }
      confirmLeave(list.map((g) => g.id), '');
      return;
    }

    const leaveId = t.dataset?.guildLeave;
    if (leaveId) {
      confirmLeave([leaveId], t.dataset.guildName || leaveId);
      return;
    }

    const chanGuild = t.dataset?.guildChannels;
    if (chanGuild) {
      const guildEl = t.closest('.discord-guild');
      const existing = guildEl?.querySelector('.discord-guild-channels');
      if (existing) { existing.remove(); return; }
      t.disabled = true;
      try {
        const chans = await fetchChannels(chanGuild);
        const text = chans.filter((c) => c.type === 0 || c.type === 5)   // text/announcement
          .map((c) => `<button type="button" class="discord-chan mono" data-chan-select="${escapeHtml(c.id)}"># ${escapeHtml(c.name || c.id)}</button>`).join('');
        const box = document.createElement('div');
        box.className = 'discord-guild-channels mt-8';
        box.innerHTML = `${text || '<p class="small dim">No text channels.</p>'}
          <div class="discord-send ${text ? '' : 'hidden'}">
            <span class="small dim" id="discordChanPick">Pick a channel</span>
            <input class="input" id="discordMsg" placeholder="Message (token connect only)" maxlength="2000">
            <button type="button" class="btn btn-sm" data-chan-send="${escapeHtml(chanGuild)}">Send</button>
          </div>`;
        guildEl.appendChild(box);
      } catch (err) {
        say(err.message, 'error');
      } finally {
        t.disabled = false;
      }
      return;
    }

    const chanPick = t.dataset?.chanSelect;
    if (chanPick) {
      const box = t.closest('.discord-guild-channels');
      box?.querySelectorAll('.discord-chan').forEach((c) => c.classList.toggle('active', c === t));
      if (box) box.dataset.channel = chanPick;
      const label = box?.querySelector('#discordChanPick');
      if (label) label.textContent = t.textContent.trim();
      return;
    }

    const sendBtn = t.dataset?.chanSend;
    if (sendBtn) {
      const box = t.closest('.discord-guild-channels');
      const target = box?.dataset?.channel;
      const input = box?.querySelector('#discordMsg');
      if (!target) { say('Pick a channel first', 'error'); return; }
      try {
        await sendMessage(target, input?.value || '');
        if (input) input.value = '';
        toast('Message sent', 'success');
      } catch (err) {
        say(err.message, 'error');
      }
      return;
    }
  });
}
