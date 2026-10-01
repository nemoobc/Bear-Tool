// tests/helpers/app-source.mjs
//
// Sumber statis "markup halaman" untuk test. M2 memindahkan semua
// <section class="view"> dari index.html ke src/views/*.jsx, jadi halaman =
// index.html + ke-10 view, disusun dalam urutan dokumen asli (sama dengan
// urutan render <App/>) supaya slice id="view-A" … id="view-B" tetap berarti
// "rentang A sampai B" seperti saat markup masih satu file.
//
// Nama atribut JSX dikembalikan ke ejaan HTML (className → class, htmlFor →
// for, komentar {…} → <!-- … -->, <input … /> → <input …>). Normalisasi hanya
// MENGEMBALIKAN EJAAN: id, isi, jumlah atribut dan urutannya tidak disentuh,
// jadi asersi yang menulis pola HTML tetap bermakna sama persis — bukan
// melemah, bukan menguat. (style="…" dirender React sebagai object JSX dan
// tidak diputar balik; tidak ada test yang meng-grep ejaan style inline.)
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

// Urutan dokumen index.html HEAD = urutan view di src/App.jsx.
const VIEW_ORDER = ['dashboard', 'send', 'swap', 'bridge', 'approval', 'deploy', 'activity', 'nft', 'dapps', 'settings'];

export function jsxToHtmlSpelling(src) {
  return src
    .replace(/\{\s*\/\*/g, '<!--')
    .replace(/\*\s*\}/g, '-->')
    .replace(/\bclassName="/g, 'class="')
    .replace(/\bhtmlFor="/g, 'for="')
    .replace(/\bautoComplete="/g, 'autocomplete="')
    .replace(/\bspellCheck="/g, 'spellcheck="')
    .replace(/\breadOnly(=|>)/g, 'readonly$1')
    .replace(/\bstrokeWidth="/g, 'stroke-width="')
    .replace(/\bstrokeLinecap="/g, 'stroke-linecap="')
    .replace(/\bstrokeLinejoin="/g, 'stroke-linejoin="')
    .replace(/(<input\b[^>]*?)\s*\/>/g, '$1>');
}

/** index.html + seluruh section view, urutan dokumen, ejaan HTML. */
export function appSource() {
  const viewsDir = path.join(ROOT, 'src', 'views');
  const present = readdirSync(viewsDir).filter((f) => f.endsWith('.jsx'));
  const missing = VIEW_ORDER.filter((v) => !present.includes(`${v}.jsx`));
  if (missing.length) throw new Error(`src/views kehilangan view: ${missing.join(', ')}`);
  const views = VIEW_ORDER
    .map((v) => readFileSync(path.join(viewsDir, `${v}.jsx`), 'utf8'))
    .join('\n');
  return readFileSync(path.join(ROOT, 'index.html'), 'utf8') + '\n' + jsxToHtmlSpelling(views);
}
