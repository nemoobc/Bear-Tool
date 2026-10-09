// tests/pull-refresh.test.js — main-screen pull-to-refresh.
// The gesture is pure event math, so it is driven against a fake window/
// document: which starts fire a refresh, which must not, and that the same
// 'refresh' pipeline the rest of the app uses is what actually reloads the
// dashboard. The visual part (indicator position, easing) is pinned by the
// CSS gate below — there is no browser here to screenshot it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initPullRefresh, PULL_REFRESH_THRESHOLD } from '../js/pull-refresh.js';

function fakeEnv({ scrollY = 0, modalOpen = false } = {}) {
  const winListeners = {};
  const mkEl = (tag) => ({
    tag,
    className: '',
    style: {},
    children: [],
    classList: (() => {
      const s = new Set();
      return {
        add: (...c) => c.forEach((x) => s.add(x)),
        remove: (...c) => c.forEach((x) => s.delete(x)),
        contains: (c) => s.has(c),
        toggle: (c, f) => (f ? s.add(c) : s.delete(c)),
      };
    })(),
    setAttribute() {},
    appendChild(c) { this.children.push(c); return c; },
    remove() {},
    closest() { return null; },
  });
  const doc = {
    body: mkEl('body'),
    documentElement: mkEl('html'),
    createElement: mkEl,
    querySelector: (sel) => (modalOpen && sel === '.modal.open' ? {} : null),
  };
  const win = {
    scrollY,
    addEventListener: (t, fn) => { (winListeners[t] = winListeners[t] || []).push(fn); },
    removeEventListener: (t, fn) => { winListeners[t] = (winListeners[t] || []).filter((f) => f !== fn); },
  };
  const fire = (type, ev) => (winListeners[type] || []).forEach((fn) => fn(ev));
  const mkEv = (x, y, target = { closest: () => null }) => ({
    touches: [{ clientX: x, clientY: y }],
    target,
    cancelable: true,
    prevented: false,
    preventDefault() { this.prevented = true; },
  });
  return { win, doc, fire, mkEv, winListeners };
}

// A full legal pull: from the top, vertical, well past the threshold.
function pullFull(env, fromY = 100, toY = 100 + (PULL_REFRESH_THRESHOLD / 0.5) + 40) {
  env.fire('touchstart', env.mkEv(200, fromY));
  env.fire('touchmove', env.mkEv(200, toY));
  env.fire('touchend', env.mkEv(200, toY));
}

test('pull past the threshold at the top fires exactly one refresh', () => {
  const env = fakeEnv();
  let calls = 0;
  initPullRefresh({ win: env.win, doc: env.doc, onRefresh: () => { calls += 1; } });
  pullFull(env);
  assert.equal(calls, 1, 'one release past threshold = one refresh');
});

test('threshold is a real number in thumb territory', () => {
  assert.ok(PULL_REFRESH_THRESHOLD >= 50 && PULL_REFRESH_THRESHOLD <= 120,
    `threshold ${PULL_REFRESH_THRESHOLD}px should be reachable by a thumb`);
});

test('a short pull (below threshold) does not refresh', () => {
  const env = fakeEnv();
  let calls = 0;
  initPullRefresh({ win: env.win, doc: env.doc, onRefresh: () => { calls += 1; }, threshold: 72 });
  env.fire('touchstart', env.mkEv(200, 100));
  env.fire('touchmove', env.mkEv(200, 140)); // 40px finger = 20px visible
  env.fire('touchend', env.mkEv(200, 140));
  assert.equal(calls, 0, 'a peek pull must not reload the wallet');
});

test('pulling while scrolled down does not refresh', () => {
  const env = fakeEnv({ scrollY: 300 });
  let calls = 0;
  initPullRefresh({ win: env.win, doc: env.doc, onRefresh: () => { calls += 1; } });
  pullFull(env);
  assert.equal(calls, 0, 'mid-page drag is normal scrolling, not PTR');
});

// The live probe (2026-10-09) proved this layout scrolls <body>, not html:
// overflow-x: hidden on html,body severs viewport propagation, window.scrollY
// stays 0 forever — a scrollY-only guard would happily refresh mid-page.
test('pulling while scrolled down INSIDE body-scroller does not refresh', () => {
  const env = fakeEnv(); // win.scrollY stays 0 — the layout's own trap
  env.doc.body.scrollTop = 300;
  let calls = 0;
  initPullRefresh({ win: env.win, doc: env.doc, onRefresh: () => { calls += 1; } });
  pullFull(env);
  assert.equal(calls, 0, 'body.scrollTop is "down the page" just like window.scrollY');
});

test('documentElement scroller is read too', () => {
  const env = fakeEnv();
  env.doc.scrollingElement = { scrollTop: 250 };
  let calls = 0;
  initPullRefresh({ win: env.win, doc: env.doc, onRefresh: () => { calls += 1; } });
  pullFull(env);
  assert.equal(calls, 0, 'the standard html scroller must also block the gesture');
});

test('a mostly-horizontal drag is a back-swipe, not a refresh', () => {
  const env = fakeEnv();
  let calls = 0;
  initPullRefresh({ win: env.win, doc: env.doc, onRefresh: () => { calls += 1; } });
  env.fire('touchstart', env.mkEv(50, 200));
  env.fire('touchmove', env.mkEv(260, 230)); // dx=210 ≫ dy=30
  env.fire('touchend', env.mkEv(260, 230));
  assert.equal(calls, 0, 'side swipes must not reload');
});

test('a gesture that starts on a control is left alone', () => {
  const env = fakeEnv();
  let calls = 0;
  initPullRefresh({ win: env.win, doc: env.doc, onRefresh: () => { calls += 1; } });
  const button = { closest: (sel) => (sel.includes('button') ? button : null) };
  env.fire('touchstart', env.mkEv(200, 100, button));
  env.fire('touchmove', env.mkEv(200, 400));
  env.fire('touchend', env.mkEv(200, 400));
  assert.equal(calls, 0, 'no pull-to-refresh stolen from taps on buttons');
});

test('an open modal blocks the gesture', () => {
  const env = fakeEnv({ modalOpen: true });
  let calls = 0;
  initPullRefresh({ win: env.win, doc: env.doc, onRefresh: () => { calls += 1; } });
  pullFull(env);
  assert.equal(calls, 0, 'a confirm sheet must never be dismissed by a pull');
});

test('the gesture cancels the browser rubber-band while pulling', () => {
  const env = fakeEnv();
  initPullRefresh({ win: env.win, doc: env.doc, onRefresh: () => {} });
  env.fire('touchstart', env.mkEv(200, 100));
  const move = env.mkEv(200, 300);
  env.fire('touchmove', move);
  assert.equal(move.prevented, true,
    'touchmove must be preventDefault-ed or Chrome double-scrolls under the disc');
});

test('a refresh already in flight swallows the next pull', async () => {
  const env = fakeEnv();
  let calls = 0;
  let release;
  initPullRefresh({
    win: env.win,
    doc: env.doc,
    onRefresh: () => { calls += 1; return new Promise((r) => { release = r; }); },
  });
  pullFull(env);
  pullFull(env); // impatient second pull while loadDashboard is still running
  assert.equal(calls, 1, 'never two overlapping dashboard loads');
  release();
  await new Promise((r) => setTimeout(r, 700)); // let MIN_SPIN lapse
  pullFull(env);
  assert.equal(calls, 2, 'after the first finishes, the gesture works again');
});

test('touchcancel mid-pull aborts without refreshing', () => {
  const env = fakeEnv();
  let calls = 0;
  initPullRefresh({ win: env.win, doc: env.doc, onRefresh: () => { calls += 1; } });
  env.fire('touchstart', env.mkEv(200, 100));
  env.fire('touchmove', env.mkEv(200, 400));
  env.fire('touchcancel', env.mkEv(200, 400));
  env.fire('touchend', env.mkEv(200, 400));
  assert.equal(calls, 0, 'a cancelled gesture must not fire on release');
});

// ── wiring & style gates (source of truth lives in app.js / cartoon.css) ──
const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../css/cartoon.css', import.meta.url), 'utf8');
const src = readFileSync(new URL('../js/pull-refresh.js', import.meta.url), 'utf8');

test('app.js boots the pull-refresh next to the scroll-top FAB', () => {
  assert.match(app, /import \{ initPullRefresh \} from '\.\/pull-refresh\.js';/,
    'entry point must import the module');
  assert.match(app, /try \{ initPullRefresh\(\); \}/,
    'boot must init it inside the same throw-proof guard style as the other bindings');
});

test('pull-refresh goes through the single refresh pipeline', () => {
  assert.match(src, /emit\('refresh'\)/,
    'the default handler must emit the event every other refresh path uses');
  assert.match(app, /on\('refresh', async \(\) => \{/,
    "app.js must keep owning the 'refresh' listener (loadDashboard)");
});

test('Chrome native pull-to-refresh is retired at the root', () => {
  assert.match(css, /html, body \{[^}]*overscroll-behavior-y: none;/s,
    'without this, Android Chrome reloads the SPA on top of our gesture');
});

test('the indicator has a home: show / thumb-follow / spinning states', () => {
  assert.match(css, /\.pull-refresh \{[^}]*position: fixed;/s, 'fixed overlay');
  assert.match(css, /\.pull-refresh\.pull \{ transition: none; \}/s,
    'while pulling the disc must track the finger without easing');
  assert.match(css, /\.pull-refresh\.go \.pr-spin \{ animation: pr-spin/s,
    'the committed refresh must visibly spin');
});
