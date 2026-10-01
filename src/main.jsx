// Entry React (M2). View di-render DULU, baru app.js lama di-boot: app.js
// mencari #view-* saat start-up dan melempar error kalau null (kontrak E2E).
// flushSync dipakai karena root.render() React 18+ dijadwalkan async — tanpa
// ini import('../js/app.js') bisa menangkap container yang masih kosong.
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import App from './App.jsx';

flushSync(() => {
  createRoot(document.getElementById('app-root')).render(<App />);
});

// Top-level await diblokir target build es2020 (vite.config.js), tapi ini tidak
// mengubah urutan: flushSync di atas sudah menaruh semua #view-* di DOM sebelum
// modul app.js mulai dimuat. Gagal muat = boot gagal, jadi laporkan keras.
//
// App.js menempelkan SELURUH boot-nya di DOMContentLoaded (js/app.js:44) —
// dan dynamic import ini SELALU mengevaluasi modul SETELAH event itu fired:
// deferred module selesai → event → baru chunk datang. Tanpa pemicu di sini
// listener-nya tak pernah dipanggil: shell statis utuh, React ter-render, JS
// interaktif mati SENYAP (nol console error) — CI run 36920331029: 3/65 lolos,
// sisanya timeout 45s, suite menuju 2jam. Sebelum M2 app.js dimuat sebagai
// classic script SEBELUM event, jadi retaknya tak pernah terlihat.
// Dispatch ulang event-nya: app.js satu-satunya pendengar DOMContentLoaded di
// seluruh pohon yang dimuat browser (js/, src/, vendor/, inline index.html —
// digrep, nol lain). Kalau chunk ternyata masih datang saat readyState
// 'loading', event asli nanti yang memanggil — kedua jalur mustahil dobel.
import('../js/app.js').then(() => {
  if (document.readyState !== 'loading') {
    window.dispatchEvent(new Event('DOMContentLoaded'));
  }
}).catch((err) => {
  console.error('Bear Tool: gagal memuat js/app.js — boot terhenti', err);
});
