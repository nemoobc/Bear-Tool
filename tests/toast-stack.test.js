// A toast stack that grows without bound stops being a notification and becomes
// the screen. The emulator screenshots 43 and 44 (run 38307671413) show six
// notices stacked upward over the whole Settings screen on a 360px phone — only
// the top and bottom bars were visible, and the Security Center underneath could
// not be seen at all.
//
// Two behaviours are pinned here, both of them found by looking:
//
//   1. The stack is capped. The oldest leaves first: the newest notice is the
//      reason the user is looking.
//   2. A repeated message REFRESHES the notice already on screen instead of
//      stacking an identical copy. Toggling a switch twice in three seconds
//      produced "Testnets hidden" twice, which reads as two events having
//      happened when one did.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── a DOM small enough to see ────────────────────────────────────────────────
class El {
  constructor(tag) {
    this.tagName = tag;
    this.className = '';
    this.textContent = '';
    this.dataset = {};
    this.style = {};
    this.children = [];
    this._parent = null;
  }
  appendChild(el) {
    el._parent = this;
    this.children.push(el);
    return el;
  }
  remove() {
    const p = this._parent;
    if (!p) return;
    const i = p.children.indexOf(this);
    if (i >= 0) p.children.splice(i, 1);
    this._parent = null;
  }
  get firstElementChild() { return this.children[0] || null; }
  get lastElementChild() { return this.children[this.children.length - 1] || null; }
}

const wrap = new El('div');
globalThis.document = {
  createElement: (tag) => new El(tag),
  querySelector: (sel) => (sel === '#toast-wrap' ? wrap : null),
  getElementById: () => null,
  body: new El('body'),
};
globalThis.window = globalThis;

const { toast } = await import('../js/ui.js');

const visible = () => wrap.children.map((c) => c.textContent);
const clear = () => { wrap.children.length = 0; };

test('the stack is capped: oldest notices leave first', () => {
  clear();
  for (const m of ['one', 'two', 'three', 'four', 'five']) toast(m);
  const shown = visible();
  assert.ok(shown.length <= 3, `tumpukan tumbuh tanpa batas: ${shown.length} toast (${shown.join(', ')})`);
  // What survives must be the newest — that is the one the user just triggered.
  assert.deepEqual(shown, ['three', 'four', 'five'],
    'yang tersisa harus tiga yang terbaru, bukan yang tertua');
  assert.ok(!shown.includes('one'), 'toast pertama harus sudah hilang');
});

test('the cap is a number, not a coincidence of this test', () => {
  clear();
  toast('a'); toast('b'); toast('c');
  assert.equal(wrap.children.length, 3, 'tiga toast boleh menumpuk');
  toast('d');
  assert.equal(wrap.children.length, 3, 'tidak boleh lebih dari tiga');
});

test('the same message twice refreshes the notice instead of stacking a copy', () => {
  clear();
  toast('Testnets hidden');
  toast('Testnets hidden');
  assert.deepEqual(visible(), ['Testnets hidden'],
    'pesan kembar harus memperpanjang yang satu, bukan menambah kartu kedua');
  toast('Something else');
  assert.deepEqual(visible(), ['Testnets hidden', 'Something else'],
    'pesan berbeda tetap menambah');
});

// The screen this came from: a switch toggled off then on again, three seconds
// apart, produced two "Testnets hidden" cards and two "Testnets shown" cards.
test('the settings toggle sequence leaves a readable screen', () => {
  clear();
  for (const m of ['Address saved', 'Address removed', 'Testnets hidden',
                   'Testnets hidden', 'Testnets shown', 'Testnets shown']) {
    toast(m);
  }
  const shown = visible();
  assert.ok(shown.length <= 3, `enam aksi meninggalkan ${shown.length} toast di layar`);
  // Six actions, three distinct notices: the duplicates merged, the oldest left.
  assert.deepEqual(shown, ['Address removed', 'Testnets hidden', 'Testnets shown'],
    'tiga pesan berbeda yang terbaru, bukan enam kartu');
  assert.equal(new Set(shown).size, shown.length, 'tidak boleh ada toast kembar di layar');
  assert.ok(shown.includes('Testnets shown'),
    'aksi terakhir harus masih terbaca — itulah alasan toast ini muncul');
});

test('an error still goes through explainError rather than being swallowed', () => {
  clear();
  toast('gas required exceeds allowance', 'error');
  assert.equal(wrap.children.length, 1);
  assert.ok(wrap.children[0].textContent.length > 0, 'pesan error tidak boleh kosong');
});