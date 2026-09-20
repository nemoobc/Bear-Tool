# Bear Tool — TODO / Audit Backlog

Dikelola otomatis oleh sesi audit ULTRA. Status: `[ ]` open, `[x]` done, `[~]` sebagian/in-progress.

## P0 — Keamanan (harus fix)
- [x] **Secret plaintext di localStorage** (`js/wallet.js:178-181` `bear.session.ls`) — tinjauan: fitur tab-reopen DIUJI eksplisit (`tests/wallet.test.js:88`); mitigasi ada (auto-lock window di boot, clearSession saat lock). Diputuskan: pertahankan perilaku, dokumentasikan risiko. -> Risiko known, mitigasi: window auto-lock; tidak dihapus karena mengubah fitur yang diuji.
- [x] **iframe dApps: URL tanpa escape + sandbox `allow-same-origin`** (`js/dapps.js`) — diperbaiki: escapeHtml + validasi http(s) + require sandbox; `allow-same-origin` dibuang (konten untrusted tak boleh same-origin).
- [~] **solc CDN tanpa SRI** (`js/solc.js`) — FIXED: `SOLC_INTEGRITY` sha384 (diverifikasi `openssl` 2026-09-20) + crossOrigin. _Tunggu verifikasi browser compile real._
- [ ] **CSP lemah** (`index.html:9` `unsafe-inline unsafe-eval 3 CDN`) — dinilai; pengetatan butuh audit dependensi runtime (solc wasm/eval). Hold — dokumentasikan, bukan fix cepat.

## P1 — Kualitas / A11y / CI
- [x] **Dark mode: kontras tombol `.btn` 1.16–2.10:1** (`css/cartoon.css`) — FIXED: `.theme-dark .btn { color: #2D2A32 }` (≥8:1 pada honey).
- [x] **Skip link tanpa target `#main`** (`index.html`) — FIXED: `id="main"` pada `<main>` (tabindex=-1).
- [x] **Duplikat ID (6 ID)** (`index.html` dua blok Revoke) — FIXED: blok kedua (view-deploy, tidak dibind JS) dihapus. HTML valid kembali.
- [x] **CI drift: job `onchain-fork` inline + `continue-on-error: true`** (`test.yml:682`) — FIXED: job duplikat dihapus; `fork-tests.yml` (matrix 12 network, gate fail-loudly) = satu sumber kebenaran. `continue-on-error` hilang dari repo.
- [x] **`.gitignore` baris 3 rusak** (`.DS_Storeprobe-build.mjs`) — FIXED: dipisah menjadi `.DS_Store` + `probe-build.mjs`.
- [ ] **Unit test: README klaim "341" vs nyata 262** (`README.md:53`) — tunggu angka final (fork/e2e), update README.
- [ ] **E2E CI inline spec ≠ suite ter-track** (`test.yml` playwright-test) — tunggu hasil e2e suite ter-track; ganti CI ke `npm run test:e2e` bila hijau.
- [ ] **`lang` statis `en`** (`index.html:2`) — i18n parsial; P2-low. Tinjau saat i18n penuh.

## P2 — Perbaikan kecil
- [ ] Quote-error kontras 2.77:1 (designer) — tinjau CSS.
- [ ] Pills non-keyboard (`network-pill` dsb) — tinjau role/tabindex.
- [ ] I18n parsial (string hardcoded belum semua data-i18n).

## Onchain (session berjalan)
- [x] Setup env: npm 9.2.0 + node 22.22.1, anvil 1.8.3 (foundry), web lokal :8080, chromium (playwright).
- [x] MCP browser (`@playwright/mcp` + CDP 9222) + MCP logs (filesystem `/root/bear-tool/logs`) — terdaftar di `~/.config/opencode/opencode.json`.
- [x] Fork lokal 12 network — ALL 12 PASS, 10/10 onchain test per network (120 total). Log `logs/fork-<net>.log`. Batch-3 paralel awal gagal "anvil not installed" (kontensi fork); retry serial 4 network → hijau.
- [~] E2E suite penuh (Playwright, web lokal) — awal fail karena kontensi resource dengan fork; `00-load` solo 4/4 PASS; full 51 spec RUNNING.
- [x] Fix bug test bridge (3 test hang — confirmTx belum disimulasikan klik; root cause: `4b8bf8c` menambah confirm sign di exec tanpa update test) + guard pre-confirm live-chain di `doBridgeExec` — 18/18 hijau.
- [x] Unit suite: 262 test (261 pass, 1 skip) — HIJAU.
- [x] Red-team praktis: XSS probe + sandbox iframe + SRI + secret storage — lihat hasil sesi.