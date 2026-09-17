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
