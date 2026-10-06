// Bear Tool — tests/discord.test.js
//
// The Discord view (M3) replaced the Approval Manager on the user's order
// ("fitur approvals hapus ganti fitur discord"). Three things here are worth
// a gate that source-pins alone cannot give:
//
//   1. PKCE is computed, not decorated — the challenge MUST be
//      base64url(SHA-256(verifier)) or Discord rejects the exchange with an
//      error the user reads as "login broken".
//   2. The two auth methods keep their different Authorization shapes
//      (OAuth = `Bearer …`, pasted user token = raw). One shared header for
//      both = a token that validates and then 401s on every later call.
//   3. Partial failure stays partial: leave-all reports "left N of M,
//      stopped at X" — a tool that reports success after leaving 3 of 50
//      has taught its user to distrust the other 47.
//
// Everything network-shaped is injected (fetchFn), storage is shimmed
// (Node has no localStorage without a file flag), and navigation is a spy:
// the URL is what matters, not the act of leaving.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ── storage shims (before any call reads them; discord.js touches storage
// only inside functions, so the static import below is safe) ───────────────
function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
  };
}
const local = memStorage();
const sess = memStorage();
Object.defineProperty(globalThis, 'localStorage', { value: local, configurable: true });
Object.defineProperty(globalThis, 'sessionStorage', { value: sess, configurable: true });

const D = await import('../js/discord.js');

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const raw = (p) => readFileSync(path.join(ROOT, p), 'utf8');

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

beforeEach(() => {
  local.clear();
  sess.clear();
});

// ── PKCE ────────────────────────────────────────────────────────────────────
test('pkce: challenge = base64url(SHA-256(verifier)), url-safe, fresh each call', async () => {
  const { verifier, challenge } = await D.pkcePair();
  assert.ok(verifier.length >= 43, `RFC 7636 wants ≥43 chars, got ${verifier.length}`);
  assert.match(verifier, /^[A-Za-z0-9_-]+$/, 'verifier must be url-safe (no +, /, =)');
  assert.match(challenge, /^[A-Za-z0-9_-]+$/, 'challenge must be url-safe');

  // Recompute independently — the gate is the algorithm, not that two
  // calls to the same helper agree with each other.
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  let bin = '';
  for (const b of new Uint8Array(digest)) bin += String.fromCharCode(b);
  const expected = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(challenge, expected, 'challenge must be the S256 of the verifier');

  const again = await D.pkcePair();
  assert.notEqual(again.verifier, verifier, 'verifiers must not repeat');
});

test('oauthAuthorizeUrl carries everything Discord requires', () => {
  const url = D.oauthAuthorizeUrl({
    clientId: '123456789012345678',
    challenge: 'CHAL',
    redirectUri: 'http://localhost:8081/',
    state: 'STATE1',
  });
  const u = new URL(url);
  assert.ok(u.origin === 'https://discord.com' && u.pathname === '/api/v10/oauth2/authorize',
    'authorize endpoint');
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('client_id'), '123456789012345678');
  assert.equal(u.searchParams.get('code_challenge'), 'CHAL');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('state'), 'STATE1');
  assert.equal(u.searchParams.get('redirect_uri'), 'http://localhost:8081/');
  const scopes = u.searchParams.get('scope').split(' ');
  assert.deepEqual(scopes.sort(), ['guilds', 'identify'], 'identify + guilds, both needed for servers');
});

test('redirectUri = origin + pathname (the string the portal must hold)', () => {
  const loc = { origin: 'https://nemoobc.github.io', pathname: '/Bear-Tool/' };
  assert.equal(D.redirectUri(loc), 'https://nemoobc.github.io/Bear-Tool/');
  const loc2 = { origin: 'http://localhost:8081', pathname: '/' };
  assert.equal(D.redirectUri(loc2), 'http://localhost:8081/');
});

// ── token exchange ──────────────────────────────────────────────────────────
test('exchangeCode: form POST to /oauth2/token, auth stored with expiry', async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({
      access_token: 'AT', refresh_token: 'RT', expires_in: 3600, token_type: 'Bearer',
      scope: 'identify guilds',
    });
  };
  await D.exchangeCode({
    clientId: '123456789012345678', code: 'THECODE', verifier: 'V', redirectUri: 'http://localhost:8081/',
  }, fetchFn);

  assert.equal(calls.length, 1, 'exactly one request');
  assert.equal(calls[0].url, 'https://discord.com/api/v10/oauth2/token');
  assert.equal(calls[0].init.method, 'POST');
  assert.match(calls[0].init.headers['Content-Type'], /application\/x-www-form-urlencoded/);
  const sent = new URLSearchParams(calls[0].init.body);
  assert.equal(sent.get('grant_type'), 'authorization_code');
  assert.equal(sent.get('code'), 'THECODE');
  assert.equal(sent.get('code_verifier'), 'V');
  assert.equal(sent.get('client_id'), '123456789012345678');

  const auth = D.readAuth();
  assert.equal(auth.mode, 'oauth');
  assert.equal(auth.access, 'AT');
  assert.equal(auth.refresh, 'RT');
  assert.ok(auth.expires > Date.now(), 'expiry is a real timestamp in the future');
});

test('exchangeCode: Discord says no → the error description survives', async () => {
  const fetchFn = async () => jsonResponse({ error: 'invalid_grant', error_description: 'Invalid code' }, 400);
  await assert.rejects(
    D.exchangeCode({ clientId: '1', code: 'x', verifier: 'v', redirectUri: 'r' }, fetchFn),
    /Invalid code/,
    'the user must read Discord\u2019s reason, not "HTTP 400"'
  );
  assert.equal(D.readAuth(), null, 'a failed exchange stores nothing');
});

test('exchangeCode: 200 without access_token is still a failure', async () => {
  const fetchFn = async () => jsonResponse({ ok: true }, 200);
  await assert.rejects(
    D.exchangeCode({ clientId: '1', code: 'x', verifier: 'v', redirectUri: 'r' }, fetchFn),
    /no access_token/
  );
});

test('refreshOAuth: refresh grant updates the session; no refresh → honest throw', async () => {
  D.writeAuth({ mode: 'oauth', access: 'OLD', refresh: 'RT', expires: Date.now() - 1000 });
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({ access_token: 'NEW', refresh_token: 'RT2', expires_in: 60 });
  };
  await D.refreshOAuth('123456789012345678', fetchFn);
  const sent = new URLSearchParams(calls[0].init.body);
  assert.equal(sent.get('grant_type'), 'refresh_token');
  assert.equal(sent.get('refresh_token'), 'RT');
  const auth = D.readAuth();
  assert.equal(auth.access, 'NEW');
  assert.equal(auth.refresh, 'RT2');
  assert.ok(auth.expires > Date.now());

  D.writeAuth({ mode: 'oauth', access: 'OLD', refresh: null, expires: Date.now() - 1000 });
  await assert.rejects(D.refreshOAuth('1', async () => {
    throw new Error('must not be called');
  }), /log in again/, 'a session with no refresh token cannot be refreshed — say so');
});

// ── login start / redirect return ───────────────────────────────────────────
test('startOAuthLogin: rejects bad Client IDs before touching storage or URL', async () => {
  const nav = () => assert.fail('must not navigate on a bad Client ID');
  await assert.rejects(D.startOAuthLogin('', { nav }), /Client ID first/);
  await assert.rejects(D.startOAuthLogin('abc', { nav }), /numeric ID/);
  await assert.rejects(D.startOAuthLogin('123', { nav }), /numeric ID/, 'too short to be a snowflake');
  assert.equal(local.getItem('bear.discordClientId'), null, 'nothing persisted');
  assert.equal(sess.getItem('bear.discordState'), null, 'no state issued');
});

test('startOAuthLogin: stores verifier+state, persists Client ID, navigates to the URL', async () => {
  const navs = [];
  const loc = { origin: 'http://localhost:8081', pathname: '/' };
  const url = await D.startOAuthLogin('123456789012345678', {
    nav: (u) => navs.push(u), location: loc, session: sess,
  });
  assert.equal(navs.length, 1);
  assert.equal(navs[0], url, 'the returned URL is the navigated URL');
  const u = new URL(url);
  assert.equal(u.searchParams.get('state'), sess.getItem('bear.discordState'));
  assert.ok(sess.getItem('bear.discordVerifier')?.length >= 43, 'verifier survives for the return trip');
  assert.equal(local.getItem('bear.discordClientId'), '123456789012345678');
});

test('finishOAuthRedirect: foreign/absent state is not ours to consume', async () => {
  const fetchFn = async () => assert.fail('no exchange may happen');
  assert.equal(await D.finishOAuthRedirect('', fetchFn, { session: sess }), false, 'no code at all');
  sess.setItem('bear.discordState', 'MINE');
  assert.equal(
    await D.finishOAuthRedirect('?code=THAT&state=SOMEONE_ELSES', fetchFn, { session: sess }),
    false,
    'state mismatch → leave the query alone for whoever it belongs to'
  );
  assert.equal(sess.getItem('bear.discordState'), 'MINE', 'our own state is untouched');
});

test('finishOAuthRedirect: matching state exchanges the code and strips it from the URL', async () => {
  local.setItem('bear.discordClientId', '123456789012345678');
  sess.setItem('bear.discordState', 'S1');
  sess.setItem('bear.discordVerifier', 'V'.repeat(43));
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({ access_token: 'AT', refresh_token: 'RT', expires_in: 60 });
  };
  const replaces = [];
  const loc = { origin: 'http://localhost:8081', pathname: '/' };
  const done = await D.finishOAuthRedirect('?code=C1&state=S1', fetchFn, {
    session: sess, history: { replaceState: (...a) => replaces.push(a) }, location: loc,
  });
  assert.equal(done, true);
  assert.equal(calls.length, 1);
  const sent = new URLSearchParams(calls[0].init.body);
  assert.equal(sent.get('code'), 'C1');
  assert.equal(sent.get('code_verifier'), 'V'.repeat(43));
  assert.equal(sent.get('redirect_uri'), 'http://localhost:8081/');
  assert.equal(sess.getItem('bear.discordState'), null, 'state is single-use');
  assert.equal(replaces.length, 1, 'the one-shot code leaves the address bar');
  assert.equal(D.readAuth().access, 'AT', 'session is live after the return');
});

test('finishOAuthRedirect: return without a stored Client ID fails loudly', async () => {
  sess.setItem('bear.discordState', 'S1');
  sess.setItem('bear.discordVerifier', 'V');
  const fetchFn = async () => assert.fail('no exchange without a Client ID');
  await assert.rejects(
    D.finishOAuthRedirect('?code=C1&state=S1', fetchFn, { session: sess }),
    /Client ID is missing/,
    'a redirect that cannot finish must say why, not half-log-in'
  );
});

// ── session resolution ──────────────────────────────────────────────────────
test('activeAuth: null when disconnected; token mode passes through', async () => {
  assert.equal(await D.activeAuth(), null, 'no stored session → null');
  D.writeAuth({ mode: 'token', access: 'RAW1', refresh: null, expires: null });
  assert.deepEqual(await D.activeAuth(), { mode: 'token', access: 'RAW1' });
});

test('activeAuth: an OAuth token about to expire is refreshed first', async () => {
  D.writeAuth({
    mode: 'oauth', access: 'STALE', refresh: 'RT',
    expires: Date.now() + 10_000, // inside the 30s safety margin
  });
  const fetchFn = async () => jsonResponse({ access_token: 'FRESH', refresh_token: 'RT', expires_in: 60 });
  const auth = await D.activeAuth(fetchFn);
  assert.equal(auth.access, 'FRESH');
  assert.equal(D.readAuth().access, 'FRESH', 'the refreshed token is what future calls see');
});

test('activeAuth: a refresh that fails throws — the caller must not continue on a dead token', async () => {
  D.writeAuth({ mode: 'oauth', access: 'STALE', refresh: 'RT', expires: Date.now() - 1 });
  const fetchFn = async () => jsonResponse({ error: 'invalid_grant' }, 400);
  await assert.rejects(D.activeAuth(fetchFn), /failed|refresh/i);
});

// ── discordFetch: the two Authorization shapes ──────────────────────────────
test('discordFetch: OAuth sends Bearer, pasted token sends it raw', async () => {
  const seen = [];
  const fetchFn = async (url, init) => {
    seen.push(init.headers.Authorization);
    return jsonResponse({ id: '1' });
  };
  D.writeAuth({ mode: 'oauth', access: 'AT1', refresh: null, expires: Date.now() + 3600_000 });
  await D.discordFetch('/users/@me', { fetchFn });
  D.clearAuth();
  D.writeAuth({ mode: 'token', access: 'RAW1' });
  await D.discordFetch('/users/@me', { fetchFn });
  assert.deepEqual(seen, ['Bearer AT1', 'RAW1'],
    'one shared header shape would make one of the two methods fail every call');
});

test('discordFetch: unauthenticated → connect-first; 401 body message survives; 204 → null', async () => {
  await assert.rejects(D.discordFetch('/users/@me'), /connect first/);

  D.writeAuth({ mode: 'token', access: 'RAW' });
  const err = async () => jsonResponse({ message: '401: Unauthorized' }, 401);
  await assert.rejects(D.discordFetch('/users/@me', { fetchFn: err }), /401: Unauthorized/);

  const noContent = async () => jsonResponse(null, 204);
  assert.equal(await D.discordFetch('/users/@me/guilds/1', { method: 'DELETE', fetchFn: noContent }), null);
});

test('discordFetch: body requests are JSON with Content-Type; GETs carry none', async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push(init);
    return jsonResponse({ id: 'c1' });
  };
  D.writeAuth({ mode: 'token', access: 'RAW' });
  await D.discordFetch('/channels/c1/messages', { method: 'POST', body: { content: 'hi' }, fetchFn });
  await D.discordFetch('/users/@me', { fetchFn });
  assert.equal(calls[0].headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].body), { content: 'hi' });
  assert.equal(calls[1].headers['Content-Type'], undefined, 'a GET with a Content-Type invites preflights for nothing');
  assert.equal(calls[1].body, undefined);
});

// ── sendMessage: honest capability boundaries ───────────────────────────────
test('sendMessage: OAuth mode refuses BEFORE any request (no message scope exists)', async () => {
  D.writeAuth({ mode: 'oauth', access: 'AT', refresh: null, expires: Date.now() + 3600_000 });
  const fetchFn = async () => assert.fail('a guaranteed 403 must not be requested');
  await assert.rejects(D.sendMessage('c1', 'hello', fetchFn), /pasted-token/);
});

test('sendMessage: empty and over-limit messages are rejected client-side', async () => {
  D.writeAuth({ mode: 'token', access: 'RAW' });
  const fetchFn = async () => assert.fail('validation failures never reach the network');
  await assert.rejects(D.sendMessage('c1', '   ', fetchFn), /empty/);
  await assert.rejects(D.sendMessage('c1', 'x'.repeat(2001), fetchFn), /2000/);
});

test('sendMessage: token mode POSTs the content to the channel', async () => {
  D.writeAuth({ mode: 'token', access: 'RAW' });
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({ id: 'm1' });
  };
  await D.sendMessage('999', 'hello there', fetchFn);
  assert.equal(calls[0].url, 'https://discord.com/api/v10/channels/999/messages');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), { content: 'hello there' });
});

// ── leave-all: partial stays partial ────────────────────────────────────────
test('leaveAllGuilds: walks every guild, one DELETE each, progress reported', async () => {
  D.writeAuth({ mode: 'token', access: 'RAW' });   // the view is only reachable connected
  const deleted = [];
  const fetchFn = async (url, init) => {
    assert.equal(init.method, 'DELETE', 'leaving is a DELETE of the membership');
    deleted.push(url);
    return jsonResponse(null, 204);
  };
  const guilds = [{ id: '1', name: 'A' }, { id: '2', name: 'B' }, { id: '3', name: 'C' }];
  const progress = [];
  const left = await D.leaveAllGuilds(guilds, (done, total) => progress.push(`${done}/${total}`), fetchFn);
  assert.equal(left, 3);
  assert.deepEqual(deleted, [
    'https://discord.com/api/v10/users/@me/guilds/1',
    'https://discord.com/api/v10/users/@me/guilds/2',
    'https://discord.com/api/v10/users/@me/guilds/3',
  ]);
  assert.deepEqual(progress, ['1/3', '2/3', '3/3']);
});

test('leaveAllGuilds: stops at the first failure and reports the exact partial', async () => {
  D.writeAuth({ mode: 'token', access: 'RAW' });
  const guilds = [{ id: '1', name: 'Alpha' }, { id: '2', name: 'Beta' }, { id: '3', name: 'Gamma' }];
  const fetchFn = async (url) => {
    if (url.endsWith('/2')) return jsonResponse({ message: 'Missing Access' }, 403);
    return jsonResponse(null, 204);
  };
  const err = await D.leaveAllGuilds(guilds, null, fetchFn).then(
    () => assert.fail('a stopped run must throw'),
    (e) => e
  );
  assert.match(err.message, /Left 1 of 3 servers, stopped at "Beta"/,
    'the report names the count AND the server that stopped it');
  assert.equal(err.partial, 1, 'the partial count is machine-readable, not just prose');
});

test('leaveAllGuilds: empty list is a no-op success (0 left, no requests)', async () => {
  const fetchFn = async () => assert.fail('nothing to leave means nothing to call');
  assert.equal(await D.leaveAllGuilds([], null, fetchFn), 0);
});

test('renderDiscord: a session the refresh cannot save explains itself, not just blanks', async () => {
  // The silence this replaces: activeAuth throws → catch(() => null) → the
  // connect form appears and the user is told NOTHING about why they are
  // suddenly logged out. The reason must be IN the painted HTML.
  D.writeAuth({ mode: 'oauth', access: 'STALE', refresh: 'RT', expires: Date.now() - 1 });
  const fetchFn = async () => jsonResponse({ error: 'invalid_grant' }, 400);
  const root = { innerHTML: '' };
  await D.renderDiscord(root, fetchFn);
  assert.match(root.innerHTML, /Connect Discord/, 'the connect form is what paints');
  assert.match(root.innerHTML, /⚠️/,
    'and the failed refresh\u2019s message rides along — never an empty explanation');
  assert.match(root.innerHTML, /invalid_grant|failed/i,
    'the actual reason, not a generic "something went wrong"');
});

// ── source pins: the removal and the slot it left ───────────────────────────
test('the Approvals feature is gone on every surface, Discord holds its slot', () => {
  const html = raw('index.html');
  assert.ok(!existsSync(path.join(ROOT, 'src/views/approval.jsx')), 'approval.jsx must be deleted');
  assert.ok(!html.includes('data-view="approval"'), 'no sidebar item points at the dead view');
  assert.ok(html.includes('data-view="discord"'), 'the sidebar slot is Discord now');

  const app = raw('js/app.js');
  assert.doesNotMatch(app, /view === 'approval'/, 'no dispatch arm opens it');
  assert.doesNotMatch(app, /function scanApprovals/, 'the scanner is gone, not orphaned');
  assert.match(app, /if \(view === 'discord'\)\s*renderDiscord\(\$\('#discordRoot'\)\)/,
    'the view paints');
  assert.match(app, /if \(view === 'settings'\)\s*renderSecurityCenter\(\$\('#securityCenter'\)\)/,
    'the Security Center renders from Settings (its restored home)');

  const i18n = raw('js/i18n.js');
  assert.ok(i18n.includes("'nav.discord'"), 'the nav label has a key');
  assert.ok(!i18n.includes("'nav.approval'"), 'the dead key is removed, not left to rot');
});

test('the Discord view renders before the wallet guard — no address, no dead page', () => {
  const app = raw('js/app.js');
  const discordAt = app.indexOf("if (view === 'discord')");
  const guardAt = app.indexOf("if (!get('address')) return;", discordAt);
  const dappsAt = app.indexOf("if (view === 'dapps')");
  assert.ok(discordAt > -1 && dappsAt > -1, 'both catalogue-style views are dispatched');
  assert.ok(discordAt > dappsAt, 'and sit together, before anything chain-bound');
  const nextGuard = app.indexOf('if (!get(\'address\')) return;', dappsAt);
  assert.ok(discordAt < nextGuard,
    'render BEFORE the address guard — connecting to Discord is not a chain operation');
});
