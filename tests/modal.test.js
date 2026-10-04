// Bear Tool — modal lifecycle tests (deterministic, no network)
// Drives the real js/ui.js openModal/closeModal against a tiny DOM stub.
// Verifies: fullscreen classes are (re)applied on every open and cleared on
// close, so a welcome → normal modal transition never inherits fullscreen.
// Also checks the CSS contract (100dvh box, zero overlay padding) textually.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ── tiny DOM stub (single element per selector, classList recording) ──
function makeClassList() {
  const set = new Set();
  return {
    add: (...names) => { for (const name of names) set.add(name); },
    remove: (...names) => { for (const name of names) set.delete(name); },
    toggle: (name, force) => {
      const want = force === undefined ? !set.has(name) : !!force;
      if (want) set.add(name); else set.delete(name);
      return want;
    },
    contains: (name) => set.has(name),
  };
}

function makeEl() {
  return {
    innerHTML: '', textContent: '', value: '', disabled: false,
    dataset: {}, style: {}, tabIndex: 0, focus() {},
    classList: makeClassList(),
    setAttribute() {}, removeAttribute() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
    appendChild() {}, remove() {},
  };
}

const overlay = makeEl();
const box = makeEl();
globalThis.document = {
  querySelector: (sel) => (sel === '#modalOverlay' ? overlay : sel === '#modalBox' ? box : null),
  querySelectorAll: () => [],
  getElementById: (id) => (id === 'modalOverlay' ? overlay : id === 'modalBox' ? box : null),
  createElement: makeEl,
  addEventListener() {},
  body: makeEl(),
};
globalThis.matchMedia = () => ({ matches: false });
globalThis.performance = { now: () => 0 };

const { openModal, closeModal } = await import('../js/ui.js');

test('modal: normal open adds no welcome-screen anywhere', () => {
  openModal('<h2>Hi</h2>');
  assert.equal(overlay.classList.contains('welcome-screen'), false);
  assert.equal(box.classList.contains('welcome-screen'), false);
  assert.equal(overlay.classList.contains('open'), true);
  closeModal();
  assert.equal(overlay.classList.contains('open'), false);
});

test('modal: fullscreen welcome applied on open, cleared on close', () => {
  openModal('<div class="welcome-full">Bear</div>', { fullscreen: true });
  assert.equal(overlay.classList.contains('welcome-screen'), true);
  assert.equal(box.classList.contains('welcome-screen'), true);
  assert.equal(box.innerHTML.includes('welcome-full'), true, 'innerHTML must hold welcome content');
  closeModal();
  assert.equal(overlay.classList.contains('welcome-screen'), false, 'close must clear overlay class');
  assert.equal(box.classList.contains('welcome-screen'), false, 'close must clear box class');
});

test('modal: fullscreen state never leaks into the next normal modal', () => {
  openModal('<div class="welcome-full">Bear</div>', { fullscreen: true });
  closeModal();
  openModal('<h2>Unlock</h2>');
  assert.equal(box.classList.contains('welcome-screen'), false, 'normal modal must not inherit fullscreen');
  assert.equal(overlay.classList.contains('welcome-screen'), false, 'normal overlay must not inherit fullscreen');
  assert.equal(overlay.classList.contains('open'), true);
  closeModal();
});

test('modal: repeated welcome open is idempotent (classes set exactly once)', () => {
  openModal('<div class="welcome-full">Bear</div>', { fullscreen: true });
  openModal('<div class="welcome-full">Bear again</div>', { fullscreen: true });
  assert.equal(overlay.classList.contains('welcome-screen'), true);
  assert.equal(box.classList.contains('welcome-screen'), true);
  closeModal();
});

test('modal: legacy close (bypasses closeModal) still cannot leak fullscreen', () => {
  openModal('<div class="welcome-full">Bear</div>', { fullscreen: true });
  // inline modal-close buttons only strip .open — no closeModal() call
  overlay.classList.remove('open');
  openModal('<h2>Token actions</h2>');
  assert.equal(box.classList.contains('welcome-screen'), false, 'open path must retoggle stale classes');
  assert.equal(overlay.classList.contains('welcome-screen'), false, 'overlay must not stay fullscreen');
  assert.equal(overlay.classList.contains('open'), true);
  closeModal();
});

test('css: fullscreen uses explicit class, dynamic viewport height, no overlay padding', () => {
  const css = readFileSync(new URL('../css/cartoon.css', import.meta.url), 'utf8');
  assert.ok(css.includes('.modal.welcome-screen'), 'box rule must use explicit .welcome-screen');
  assert.ok(css.includes('.modal-overlay.welcome-screen {'), 'overlay rule must exist');
  assert.ok(!css.includes('.modal:has(.welcome-full)'), ':has() dependency must be gone');
  const block = css.slice(css.indexOf('.modal.welcome-screen {'), css.indexOf('.modal.welcome-screen .welcome-full'));
  assert.ok(block.includes('100dvh'), 'box must use dynamic viewport height');
  assert.ok(block.includes('max-height: none'), '85vh cap must be neutralized');
  assert.ok(block.includes('overflow-y: auto'), 'short screens must scroll, not clip actions');
  const overlayBlock = css.slice(css.indexOf('.modal-overlay.welcome-screen {'), css.indexOf('}', css.indexOf('.modal-overlay.welcome-screen {')));
  assert.ok(overlayBlock.includes('padding: 0'), 'overlay padding must be 0 only for fullscreen');
});

test('css: token chart box never shrinks in the fullscreen flex modal', () => {
  // Live bug: the token modal is a fixed-height flex column (.modal.welcome-screen).
  // With a long tx history every section shrinks, and .token-modal-chart is the
  // only child with overflow:hidden → its automatic min-size is 0 → the box is
  // squeezed to a sliver and the canvas is clipped. User sees "chart ilang".
  const css = readFileSync(new URL('../css/cartoon.css', import.meta.url), 'utf8');
  const start = css.indexOf('.token-modal-chart {');
  assert.ok(start !== -1, '.token-modal-chart rule must exist');
  const chartRule = css.slice(start, css.indexOf('}', start));
  assert.ok(/flex:\s*0 0 auto|flex-shrink:\s*0/.test(chartRule),
    `chart box must opt out of flex shrink, got: ${chartRule.trim()}`);
  // Every sibling section in the fullscreen modal keeps its size too.
  const gStart = css.indexOf('.modal.welcome-screen .token-modal-header,');
  assert.ok(gStart !== -1, 'fullscreen section group must exist');
  const groupRule = css.slice(gStart, css.indexOf('}', gStart));
  assert.ok(/flex-shrink:\s*0/.test(groupRule),
    `fullscreen modal sections must not shrink, got: ${groupRule.trim()}`);
});

test('css: active account card is colored, first card clears the close float', () => {
  // Live report: "pemilihan wallet harusnya dikasih warna — putih semua, user
  // bingung pas switch" + "3 kotak presisi tapi 1 kotaknya ngga". The modal's
  // ✕ is float:right / 44px (see .receive-qr comment), so the FIRST block row
  // is shortened by exactly that — 264px → 220px on a 360px screen.
  const css = readFileSync(new URL('../css/cartoon.css', import.meta.url), 'utf8');
  const aStart = css.indexOf('.asset-row.active');
  assert.ok(aStart !== -1, '.asset-row.active rule must exist (active wallet = colored)');
  const activeRule = css.slice(aStart, css.indexOf('}', aStart));
  assert.ok(activeRule.includes('var(--honey)'), `active card must be filled honey, got: ${activeRule.trim()}`);
  assert.ok(activeRule.includes('box-shadow'), `active card must get depth, got: ${activeRule.trim()}`);
  const rStart = css.indexOf('.asset-row {');
  assert.ok(rStart !== -1, '.asset-row rule must exist');
  const rowRule = css.slice(rStart, css.indexOf('}', rStart));
  assert.ok(/clear:\s*(both|right)/.test(rowRule),
    `asset rows must clear the modal ✕ float so the first card keeps full width, got: ${rowRule.trim()}`);
});
