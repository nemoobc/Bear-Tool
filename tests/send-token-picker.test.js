// The send form's dropdown was empty for eight CI runs before anyone looked at
// a screenshot. `refreshView('send')` lost its only call — `loadSendTokens()` —
// in f7a7ec5, the branch that used to hold it was left as a comment-covered
// void, and nothing else in the app calls that function. The emulator shot
// 40-send-invalid.png shows the result: a Send form whose token choice is "—".
// Eleven Playwright specs timed out waiting for `#sendToken` options to exist.
//
// Two things are pinned here, and the second is why this cannot come back:
//   1. opening the view asks for the list (the regression itself);
//   2. with NO list to show — dashboard still loading, node unreachable — the
//      form still offers the active chain's native coin, because that coin
//      exists whether or not a provider answered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ── a DOM small enough to see ────────────────────────────────────────────────
const els = new Map();
function el(tag = 'div') {
  return {
    tagName: tag, value: '', innerHTML: '', textContent: '', className: '',
    dataset: {}, style: {}, options: [], children: [],
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {}, removeAttribute() {}, appendChild() {}, remove() {},
    addEventListener() {}, removeEventListener() {}, focus() {},
    querySelector: () => null, querySelectorAll: () => [],
    get firstElementChild() { return this.children[0] || null; },
    get lastElementChild() { return this.children[this.children.length - 1] || null; },
  };
}
// <select> sungguhan: menyetel innerHTML memilih opsi pertama. Stub yang hanya
// menyimpan string akan membuat klaim "nilai default = native" mustahil diuji,
// dan klaim itu adalah separuh dari yang perlu dibuktikan.
function selectEl() {
  const e = el('select');
  let html = '';
  Object.defineProperty(e, 'innerHTML', {
    get: () => html,
    set: (v) => {
      html = v;
      const first = /<option[^>]*value="([^"]*)"/.exec(v);
      e.value = first ? first[1] : '';
    },
  });
  return e;
}
globalThis.document = {
  querySelector(sel) {
    if (!els.has(sel)) els.set(sel, sel === '#sendToken' ? selectEl() : el());
    return els.get(sel);
  },
  querySelectorAll: () => [], createElement: el, getElementById: () => null,
  addEventListener() {}, body: el(),
};
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
try {
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { readText: async () => '' } }, configurable: true,
  });
} catch { /* Node yang lebih lama memakai navigator bawaan */ }

const state = await import('../js/state.js');
const send = await import('../js/send.js');

const options = () => {
  const html = document.querySelector('#sendToken').innerHTML;
  return [...html.matchAll(/<option[^>]*value="([^"]*)"[^>]*>([^<]*)</g)].map((m) => ({
    value: m[1], label: m[2],
  }));
};
const reset = () => { document.querySelector('#sendToken').innerHTML = ''; };

// ── 1. regresinya sendiri ───────────────────────────────────────────────────
test('opening the send view asks for its token list', () => {
  const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
  const at = app.indexOf('export function refreshView(view)');
  const body = app.slice(at, app.indexOf('\n}', at));
  const start = body.indexOf("if (view === 'send')");
  assert.ok(start > 0, 'cabang view send tidak ada');
  // Until the NEXT branch — indexOf from 0 would find this same line again and
  // slice an empty string, which is how the first version of this gate passed
  // nothing at all.
  const rest = body.slice(start + 10);
  const branch = rest.slice(0, rest.indexOf("if (view === '"));
  assert.match(branch, /loadSendTokens\(\)/,
    'cabang view send harus memanggil loadSendTokens — tidak ada pemanggil lain');
});

// ── 2. daftar kosong tidak boleh menghasilkan dropdown mati ─────────────────
test('an empty token list still offers the active chain native coin', () => {
  reset();
  state.set('tokens', []);
  state.set('networkId', 'polygon');
  send.loadSendTokens();
  const opts = options();
  assert.ok(opts.length > 0,
    'dropdown mati — inilah yang difoto emulator: pilihan "—" yang tak bisa dikirim');
  const native = opts.find((o) => o.value === 'native');
  assert.ok(native, 'koin native jaringan aktif harus selalu tersedia');
  assert.match(native.label, /POL/, 'simbol harus milik jaringan yang sedang aktif');

  const stored = state.get('tokens');
  assert.equal(stored.length, 1, 'satu jaringan, satu koin native yang ditanam');
  assert.equal(stored[0].address, null);
  // Balance belum pernah dibaca: null makes fmtAmount read UNREADABLE. A 0 here
  // would be a claim the chain never made.
  assert.equal(stored[0].balance, null, 'saldo yang belum dibaca harus null, bukan 0');
});

test('a populated list is not given a second native coin', () => {
  reset();
  state.set('tokens', [
    { address: null, symbol: 'ETH', decimals: 18, balance: '1000', usd: null },
    { address: '0xdead', symbol: 'USDC', decimals: 6, balance: '5', usd: null },
  ]);
  state.set('networkId', 'ethereum');
  send.loadSendTokens();
  const opts = options();
  assert.equal(opts.filter((o) => o.value === 'native').length, 1,
    'native tak boleh diduplikasi saat daftar sudah ada');
  assert.equal(opts.filter((o) => o.value === '0xdead').length, 1, 'token ERC-20 ikut tampil');
  assert.equal(state.get('tokens').length, 2, 'state yang ada tidak boleh ditimpa');
});

// The picker and the label are both fed from the same list, so a list that is
// rendered but never selected would leave the balance label blank forever.
test('the native choice is selected and its balance label is painted', () => {
  reset();
  state.set('tokens', []);
  state.set('networkId', 'ethereum');
  send.loadSendTokens();
  const sel = document.querySelector('#sendToken');
  assert.equal(sel.value, 'native', 'koin native harus terpilih sebagai default');
  assert.equal(document.querySelector('#sendTokenBalance').textContent.length > 0, true,
    'label saldo harus terisi — walau isinya "belum terbaca", kosong bukan jawaban');
});
