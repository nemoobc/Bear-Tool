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
import('../js/app.js').catch((err) => {
  console.error('Bear Tool: gagal memuat js/app.js — boot terhenti', err);
});
