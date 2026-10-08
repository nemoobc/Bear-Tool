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


test('finishOAuthRedirect: OUR state + error bounce → loud message, not silence', async () => {
  const fetchFn = async () => assert.fail('an error bounce must never hit the token endpoint');
  sess.setItem('bear.discordState', 'S1');
  const replaces = [];
  await assert.rejects(
    D.finishOAuthRedirect('?error=access_denied&state=S1', fetchFn, {
      session: sess,
      history: { replaceState: (...a) => replaces.push(a) },
      location: { origin: 'http://localhost:8081', pathname: '/' },
    }),
    /cancelled/,
    'access_denied reads as a cancellation, not a raw code'
  );
  assert.equal(sess.getItem('bear.discordState'), null, 'our state is consumed exactly once');
  assert.equal(replaces.length, 1, 'the error query is stripped from the address bar');

  // An error wearing someone ELSE's state stays untouched — same rule as codes.
  sess.setItem('bear.discordState', 'MINE');
  assert.equal(
    await D.finishOAuthRedirect('?error=access_denied&state=SOMEONE_ELSES', fetchFn, { session: sess }),
    false, 'foreign errors are left alone'
  );
  assert.equal(sess.getItem('bear.discordState'), 'MINE', 'our state survives');
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

test('finishOAuthRedirect: a FRESH browser finishes with the SHIPPED Client ID', async () => {
  // The old expectation ("no stored id → fail loudly") died when the user
  // asked for the id to ship in the app (2026-10-07, "ga perlu aku input
  // manual"): an empty field is no longer an error state, it is the default.
  // What still holds: the exchange carries THAT id, never an empty one.
  sess.setItem('bear.discordState', 'S1');
  sess.setItem('bear.discordVerifier', 'V'.repeat(43));
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({ access_token: 'AT', refresh_token: 'RT', expires_in: 60 });
  };
  const done = await D.finishOAuthRedirect('?code=C1&state=S1', fetchFn, {
    session: sess,
    history: { replaceState: () => {} },
    location: { origin: 'http://localhost:8081', pathname: '/' },
  });
  assert.equal(done, true, 'the redirect completes without any manual id entry');
  assert.equal(new URLSearchParams(calls[0].init.body).get('client_id'), '1557488535903404154');
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

test('discordFetch: unauthenticated → connect-first; 401 is human-mapped; other body messages survive; 204 → null', async () => {
  await assert.rejects(D.discordFetch('/users/@me'), /connect first/);

  D.writeAuth({ mode: 'token', access: 'RAW' });
  // 401: Discord's machine word ("Unauthorized") matches errors.js's contract
  // rule and used to surface as "This wallet is not allowed to do that."
  // (user report 2026-10-07) — so discordFetch translates it at the source.
  const err401 = async () => jsonResponse({ message: '401: Unauthorized' }, 401);
  await assert.rejects(D.discordFetch('/users/@me', { fetchFn: err401 }), /refused this token \(401\)/);

  // A status outside the map still passes Discord's own words through.
  const err400 = async () => jsonResponse({ message: 'Invalid Form Body' }, 400);
  await assert.rejects(D.discordFetch('/users/@me', { fetchFn: err400 }), /Invalid Form Body/);

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

test('Discord refuses some origins BEFORE the user clicks Login', () => {
  // 2026-10-07, user report: "invalid oauth2:redirect_uri" straight from
  // discord.com — the portal only accepts loopback or a full domain over
  // http(s), and the app was happily showing a Login button that could
  // never come back.
  const loc = (origin, hostname) => ({ origin, pathname: '/', hostname });
  assert.equal(D.oauthRejectsOrigin(loc('http://localhost:5173', 'localhost')), '');
  assert.equal(D.oauthRejectsOrigin(loc('http://127.0.0.1:8081', '127.0.0.1')), '');
  assert.equal(D.oauthRejectsOrigin(loc('https://nemoobc.github.io', 'nemoobc.github.io')), '');
  assert.match(D.oauthRejectsOrigin(loc('http://192.168.1.9:5173', '192.168.1.9')), /IP address/);
  assert.match(D.oauthRejectsOrigin(loc('http://termux-box:5173', 'termux-box')), /full domain/);
  assert.match(D.oauthRejectsOrigin(loc('capacitor://localhost', 'localhost')), /http\(s\)/);

  // The connect sheet wires the verdict to the button that would fail.
  const src = raw('js/discord.js');
  assert.match(src, /const originProblem = oauthRejectsOrigin\(\)/, 'the sheet asks');
  assert.match(src, /id="btnDiscordLogin"\$\{loginDisabled\}/, 'and disables Login when refused');
  assert.match(src, /discordOriginWarn.*role="alert"/s, 'with a visible warning, not a silent dead button');
  assert.match(src, /including the trailing slash/, 'the portal instruction names the usual mismatch');
  assert.match(src, /Public Client/, 'the PKCE-only exchange is unusable until the portal toggle is on');
});

// ── in-app chat + invite join (2026-10-07: "full fitur tanpa buka aplikasi Discord") ──
test('parseInviteCode takes every shape users paste, refuses the rest', () => {
  assert.equal(D.parseInviteCode('discord.gg/abc-123'), 'abc-123');
  assert.equal(D.parseInviteCode('https://discord.gg/abc-123'), 'abc-123');
  assert.equal(D.parseInviteCode('http://www.discord.gg/abc-123'), 'abc-123');
  assert.equal(D.parseInviteCode('https://discord.com/invite/abc-123'), 'abc-123');
  assert.equal(D.parseInviteCode('https://discordapp.com/invite/abc-123'), 'abc-123');
  assert.equal(D.parseInviteCode('  abc123  '), 'abc123');
  assert.equal(D.parseInviteCode(''), '');
  assert.equal(D.parseInviteCode('https://example.com/invite/x'), '', 'foreign host, no code');
  assert.equal(D.parseInviteCode('not a link!'), '');
});

test('joinInvite POSTs as the signed-in user; junk never reaches the wire', async () => {
  local.setItem('bear.discordAuth', JSON.stringify({ mode: 'token', access: 'TOK' }));
  const calls = [];
  const fetchFn = async (url, init) => { calls.push({ url, init }); return jsonResponse({ id: 'G1', name: 'New Server' }); };
  const g = await D.joinInvite('https://discord.gg/my-serv', fetchFn);
  assert.equal(g.name, 'New Server');
  assert.equal(calls[0].url, `${D.DISCORD_API}/invites/my-serv`);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'TOK', 'token connect authenticates raw');
  calls.length = 0;
  await assert.rejects(D.joinInvite('https://example.com/x', fetchFn), /discord\.gg/);
  assert.equal(calls.length, 0, 'a bad paste must not fire a request');
});

test('fetchMessages clamps the limit Discord accepts (1..100)', async () => {
  local.setItem('bear.discordAuth', JSON.stringify({ mode: 'token', access: 'TOK' }));
  const calls = [];
  const fetchFn = async (url) => { calls.push(url); return jsonResponse([]); };
  await D.fetchMessages('C1', { limit: 999 }, fetchFn);
  await D.fetchMessages('C1', { limit: 0 }, fetchFn);
  await D.fetchMessages('C1', {}, fetchFn);
  assert.equal(calls[0], `${D.DISCORD_API}/channels/C1/messages?limit=100`);
  assert.equal(calls[1], `${D.DISCORD_API}/channels/C1/messages?limit=50`);
  assert.equal(calls[2], `${D.DISCORD_API}/channels/C1/messages?limit=50`);
});

test('message bodies are escaped text — a stranger\'s markup never reaches the DOM', () => {
  const evil = D.messagesHtml([{ content: '<img src=x onerror=alert(1)> hi', author: { username: 'evil' }, timestamp: '2026-10-07T00:00:00Z' }]);
  assert.ok(!evil.includes('<img src=x'), 'raw tags stay inert');
  assert.ok(evil.includes('&lt;img'), 'content arrives escaped');
  // Discord returns NEWEST first; the pane must read top-down.
  const two = D.messagesHtml([{ content: 'newer' }, { content: 'older' }]);
  assert.ok(two.indexOf('older') < two.indexOf('newer'), 'oldest at the top, newest last');
  assert.match(D.messagesHtml([{ content: '', embeds: [{}] }]), /\[embed\]/, 'embed-only rows say so');
  assert.match(D.messagesHtml([]), /No messages yet/, 'an empty channel is honest');
});

test('the guild row never hands the user to the installed Discord app', () => {
  const src = raw('js/discord.js');
  const guild = src.slice(src.indexOf('function guildHtml'), src.indexOf('// ── chat: read'));
  assert.ok(!guild.includes('discord.com/channels'), 'the external guild link is gone');
  assert.match(guild, /data-guild-chat=/, 'Chat opens the in-app pane instead');
  assert.match(src, /id="discordInvite"/, 'the invite field is on the Servers card');
});

test('the shipped Client ID is the default — no manual entry needed', () => {
  assert.equal(D.getClientId(), '1557488535903404154', 'fresh browser falls back to the bundled id');
  D.setClientId('999');
  assert.equal(D.getClientId(), '999', 'a pasted custom id still wins');
  D.setClientId('');
  assert.equal(D.getClientId(), '1557488535903404154', 'clearing restores the default, not an empty field');
});

// ── the wallet sentence must never answer a Discord problem ────────────────
// User report 2026-10-07: the Discord view showed "This wallet is not allowed
// to do that." Root cause: Discord's own words ("401: Unauthorized",
// "unauthorized_client") matched errors.js's bare `unauthorized` rule, which
// exists for OWNABLE/contract reverts. Fix lives at the source (discordReason
// / exchange) — these tests pin BOTH halves: the thrown text, and the
// humanizer's verdict over it.
test('a Discord 401 is human at the source — machine words never leave', async () => {
  D.writeAuth({ mode: 'token', access: 'RAW1', refresh: null, expires: null });
  const fetchFn = async () => ({ ok: false, status: 401, json: async () => ({ message: '401: Unauthorized' }) });
  await assert.rejects(
    D.discordFetch('/users/@me', { fetchFn }),
    (e) => /refused this token \(401\)/.test(e.message) && !/unauthorized/i.test(e.message),
    'the thrown text is words a person wrote'
  );
});

test('explainError cannot dress a Discord failure as "This wallet is not allowed"', async () => {
  const { explainError } = await import('../js/errors.js');
  for (const fetchFn of [
    async () => ({ ok: false, status: 401, json: async () => ({ message: '401: Unauthorized' }) }),
    async () => ({ ok: false, status: 403, json: async () => ({ message: 'Missing Access' }) }),
  ]) {
    D.writeAuth({ mode: 'token', access: 'RAW1', refresh: null, expires: null });
    let thrown = null;
    try { await D.discordFetch('/users/@me', { fetchFn }); } catch (e) { thrown = e; }
    assert.ok(thrown, 'the request failed');
    const say = explainError(thrown, 'discord-regression');
    assert.ok(!/wallet is not allowed/i.test(say), `humanizer leaked the wallet sentence: ${say}`);
  }
});

test('an unauthorized_client exchange points at the portal fix, not at a wallet', async () => {
  const fetchFn = async () => ({
    ok: false, status: 400,
    json: async () => ({ error: 'unauthorized_client', error_description: 'Invalid "client_id"' }),
  });
  await assert.rejects(
    D.exchangeCode({ clientId: '1557488535903404154', code: 'C1', verifier: 'V'.repeat(43) }, fetchFn),
    /Public Client/,
    'the fix (portal toggle) is named in the error'
  );
});

// ── pasted-token hygiene (user picked "check the token" path, 2026-10-07) ──
test('normalizeToken: strips the shapes a human actually pastes', () => {
  const RAW = 'x'.repeat(70);
  assert.equal(D.normalizeToken(`Bearer ${RAW}`), RAW, 'DevTools prefix');
  assert.equal(D.normalizeToken(`Bot ${RAW}`), RAW, 'bot prefix');
  assert.equal(D.normalizeToken(`  "${RAW}"  `), RAW, 'quoted copy');
  assert.equal(D.normalizeToken(RAW), RAW, 'already clean');
  assert.equal(D.normalizeToken('   '), '', 'blank stays blank');
});

test('tokenLooksWrong: a URL fragment or label never reaches the API', () => {
  assert.equal(D.tokenLooksWrong(''), 'Paste a token first');
  assert.ok(D.tokenLooksWrong('x y').includes('spaces'), 'multi-word paste');
  assert.match(D.tokenLooksWrong('short'), /50\+/, 'a clipped piece is called out');
  assert.match(D.tokenLooksWrong('https://discord.com/channels/1/2'), /characters/, 'a URL is not a token');
  assert.equal(D.tokenLooksWrong('x'.repeat(70)), '', 'a real token passes');
});

// ── OAuth access token pasted into the user-token field (report 2026-10-08) ─
// The user's paste was an OAuth2 access token: it passes /users/@me and
// /users/@me/guilds (identify + guilds scopes) and 401s on channels — the
// connect looked healthy until the first click. Introspection separates the
// two kinds in one request.
test('looksLikeOAuthToken: introspection says which kind of token was pasted', async () => {
  assert.equal(await D.looksLikeOAuthToken('t', async () => jsonResponse({ application: { id: 'A' } })),
    true, 'an OAuth access token introspects as 200');
  assert.equal(await D.looksLikeOAuthToken('t', async () => jsonResponse({ message: '401: Unauthorized' }, 401)),
    false, 'a user session token is turned away');
  assert.equal(await D.looksLikeOAuthToken('t', async () => { throw new Error('network down'); }),
    false, 'network trouble accuses nobody');
});

test('a FAILED exchange still strips the one-shot code from the address bar', async () => {
  // Live browser test 2026-10-08: state was consumed, but ?code= stayed
  // pinned in the URL after the exchange 400'd — a dead credential riding
  // every reload.
  sess.setItem('bear.discordState', 'S-STRIP');
  sess.setItem('bear.discordVerifier', 'V'.repeat(43));
  let replaced = null;
  const fetchFn = async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant', error_description: 'Invalid "code" in request.' }) });
  await assert.rejects(
    D.finishOAuthRedirect('?code=deadbeef&state=S-STRIP', fetchFn, {
      session: sess,
      history: { replaceState: (_a, _b, p) => { replaced = p; } },
      location: { origin: 'http://localhost:8081', pathname: '/' },
    }),
    /exchange failed/,
    'the failure is still reported loudly'
  );
  assert.equal(replaced, '/', 'the query was stripped even though the exchange threw');
  assert.equal(sess.getItem('bear.discordState'), null, 'state consumed');
});
