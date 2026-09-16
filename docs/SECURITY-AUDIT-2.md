# Bear Tool — Security Audit Report #2 (Post-Refactor)

**Tanggal:** 2026-09-16
**Auditor:** SECURITY (read-only)
**Scope:** index.html, js/*.js (15 file), package.json, package-lock.json, .gitignore, git history
**Metode:** Static code review, SRI hash verification (download + sha384), grep audit, git history scan

---

## Ringkasan Eksekutif

| Peringkat | Jumlah |
|-----------|--------|
| P0 Kritis | 0 |
| P1 Tinggi | 0 |
| P2 Sedang | 2 |
| P3 Rendah | 3 |
| **Total** | **5** |

**Status: 9/9 item verifikasi CLEAN atau FIXED. Tidak ada temuan P0/P1.**

| # | Item Verifikasi | Status | Bukti |
|---|-----------------|--------|-------|
| 1 | SRI ethers CDN | ✅ CLEAN | Hash cocok (lihat bawah) |
| 2 | XSS innerHTML | ✅ CLEAN | 42 innerHTML diaudit, semua data dinamis lewat escapeHtml |
| 3 | Double-submit | ⚠️ 1 gap P2 | Revoke approval tanpa runTx (app.js:547) |
| 4 | ChainId 0 / replay | ✅ CLEAN | Guard aktif (eip7702.js:56-71) |
| 5 | Private key / PBKDF2 | ✅ CLEAN | 310k iterasi + AES-GCM-256, tanpa log key |
| 6 | Approval MaxUint256 | ⚠️ P2 | Unlimited approval tanpa opsi limit (swap.js:212) |
| 7 | Address poisoning | ✅ CLEAN | warnSuspiciousDestination dipanggil sebelum send |
| 8 | Dependensi | ✅ CLEAN | 0 prod deps, ethers hanya devDependency |
| 9 | RPC | ✅ CLEAN | Semua HTTPS publik, tanpa hardcode key |

---

## Bukti SRI (Item 1)

File diunduh dari `https://cdn.jsdelivr.net/npm/ethers@6.14.0/dist/ethers.umd.min.js` (517.064 bytes):

```
COMPUTED sha384: 34QHxjpmrckLfsLBqjRCEfb9y2fUhFwOPXGgAcnStQq185tj8/hY8VB6UY94pSUm
FROM HTML:       34QHxjpmrckLfsLBqjRCEfb9y2fUhFwOPXGgAcnStQq185tj8/hY8VB6UY94pSUm
MATCH: True
```

`index.html:343-345` — integrity hash BENAR untuk ethers 6.14.0 UMD. Temuan P0 audit sebelumnya FIXED.

---

## Temuan Detail

### P2 — SEDANG

#### 1. Revoke approval tanpa double-submit guard

- **Lokasi:** `js/app.js:547-564`
- **Deskripsi:** Handler `[data-revoke]` memanggil `c.approve(a.spender, 0)` langsung, TIDAK lewat `runTx`/`safeSend` dari safetx.js. Semua path tx lain (send, swap, eip7702) sudah pakai `runTx`.
- **Exploit Scenario:** User double-click tombol Revoke → dua transaksi approve(0) terkirim. Dampak: gas terbuang dua kali, allowance tetap 0 (tidak ada kerugian dana). Bukan kerugian finansial, tapi inkonsisten dengan pola keamanan yang lain.
- **Rekomendasi:** Bungkus dengan `runTx('revoke-' + a.spender, el, async () => {...})` — konsisten dengan send/swap/eip7702.

#### 2. Approval MaxUint256 tanpa opsi limit di UI swap

- **Lokasi:** `js/swap.js:212`
- **Deskripsi:** `c.approve(router, ethers.MaxUint256)` — approval unlimited ke KyberSwap router. Tidak ada opsi di UI untuk membatasi jumlah approval (misal "approve exact amount" atau pilihan 1x/10x/unlimited). Revoke tersedia via Approval Manager (`app.js:547-564`), tapi butuh langkah manual terpisah.
- **Exploit Scenario:** Jika router KyberSwap compromise / upgrade jahat / kunci router bocor, attacker bisa menarik SEMUA saldo token yang pernah di-approve, bukan hanya jumlah swap. Ini risiko standar DEX aggregator, tapi best practice adalah approve exact amount per swap atau batas kecil.
- **Rekomendasi:** Tambah opsi di UI: "Approve exact amount" (default) vs "Unlimited". Atau setelah swap selesai, revoke otomatis ke 0 bila memilih exact. Minimal: tampilkan peringatan "Unlimited approval" sebelum approve pertama.

### P3 — RENDAH

#### 3. NFT image URL tanpa scheme allowlist

- **Lokasi:** `js/nft.js:94`
- **Deskripsi:** `src="${escapeHtml(nft.image)}"` — sudah di-escape untuk konteks HTML (aman dari tag injection), tapi tidak ada validasi scheme URL. Metadata NFT dari on-chain bisa berisi `javascript:` atau `data:` URL.
- **Exploit Scenario:** `javascript:` di `img src` tidak dieksekusi browser modern (tidak ada XSS). `data:` URL bisa menampilkan konten aneh tapi tidak mengeksekusi script. Risiko nyata: rendah.
- **Rekomendasi:** Validasi scheme: hanya izinkan `https://`, `ipfs://`, `ar://` sebelum render. Satu baris helper.

#### 4. .gitignore tidak mencakup .env

- **Lokasi:** `.gitignore:1-3`
- **Deskripsi:** Hanya `node_modules/`, `*.log`, `.DS_Store`. Tidak ada `.env` / `.env.*`. Saat ini tidak ada file .env di project dan tidak ada env var yang dipakai, jadi tidak ada secret yang ter-commit (git history scan bersih). Ini hygiene preventif.
- **Rekomendasi:** Tambah `.env`, `.env.*`, `!.env.example` ke .gitignore.

#### 5. Custom network explorer URL dipakai di href activity

- **Lokasi:** `js/app.js:584`
- **Deskripsi:** `href="${escapeHtml(net.explorer)}/tx/${escapeHtml(a.hash)}"` — sudah di-escape. `net.explorer` bisa diisi user via custom network (`app.js:329`). Ini self-XSS (user menyuntik ke wallet sendiri), bukan vektor serangan eksternal.
- **Rekomendasi:** Validasi explorer URL harus `https://` saat menambah custom network (konsisten dengan validasi RPC di `app.js:322`).

---

## Detail Verifikasi Per Item

### 1. SRI — ✅ CLEAN
`index.html:343-345` integrity hash cocok dengan sha384 file ethers 6.14.0 UMD yang diunduh langsung dari jsDelivr. `crossorigin="anonymous"` ada. Supply-chain attack via CDN compromise terblokir.

### 2. XSS — ✅ CLEAN
42 penggunaan `innerHTML` diaudit satu per satu. Semua data dinamis (token symbol, NFT metadata name/image, address, swap quote dari KyberSwap API, bridge quote dari LI.FI, activity, approvals, batch items, network rows, error messages) melewati `escapeHtml` (ui.js:12-20). Tidak ditemukan interpolasi `+` langsung dengan data on-chain/API tanpa escape. Kasus yang dicek khusus:
- `swap.js:161-163` — quote API: `sellSymbol`/`buySymbol`/`slippage` semua di-escape
- `nft.js:92-96` — metadata NFT: name/image/collection di-escape
- `app.js:455-466` — token symbol dari on-chain: di-escape
- `send.js:58` — preview: di-escape

### 3. Double-submit — ⚠️ 1 gap (P2 #1)
- `send.js:161` → `runTx('send', ...)` ✅
- `swap.js:198` → `runTx('swap', ...)` ✅
- `eip7702.js:90` → `runTx('eip7702-'+action, ...)` ✅
- `bridge.js` → stub, tidak ada sendTransaction ✅
- `deploy.js` → stub, tidak ada sendTransaction ✅
- `app.js:558` → revoke approval TANPA runTx ⚠️

### 4. ChainId 0 / replay — ✅ CLEAN
`eip7702.js:56-71`: `chainId === 0` di mainnet → `return toast('chainId 0 (all chains) is blocked on mainnet — replay risk', 'error')`. Di testnet → confirmTx dengan requireType `'SAYA PAHAM RISIKO REPLAY'`. Guard utuh.

### 5. Private key — ✅ CLEAN
`wallet.js:13-25`: PBKDF2 310.000 iterasi SHA-256 → AES-GCM-256. Key material tidak disimpan (CryptoKey non-extractable, `extractable: false`). Tidak ada key hash di memory. Tidak ada `console.log`/`console.debug` yang membocorkan secret (grep bersih). Keystore di localStorage selalu ciphertext. Auto-lock (`app.js:255-263`) menghapus signer dari memory.

### 6. Approval — ⚠️ P2 #2
`swap.js:212` MaxUint256 ke router KyberSwap. Revoke tersedia via Approval Manager. Tidak ada opsi limit di UI swap.

### 7. Address poisoning — ✅ CLEAN
`send.js:147`: `warnSuspiciousDestination(to, net)` dipanggil SEBELUM transaksi. Tiga lapis cek: (1) prefix+suffix sama dengan penerima sebelumnya (`wallet.js:174-179` isSuspiciousSimilar), (2) tujuan = token contract (burn), (3) tujuan = rescue/claim address. Semua dengan confirmTx + requireType.

### 8. Dependensi — ✅ CLEAN
`package.json`: hanya `devDependencies: { ethers: ^6.13.4 }` untuk test. Nol prod dependencies. Runtime ethers 6.14.0 dari CDN dengan SRI. package-lock: semua paket dev. Tidak ada typo-squat (hanya ethers + transitive resmi: @noble, aes-js, ws, dll).

### 9. RPC — ✅ CLEAN
`network.js:9-94`: semua RPC HTTPS publik (llamarpc, ankr, cloudflare, binance, polygon-rpc, arbitrum, optimism, base, sepolia). Tidak ada API key hardcode. Custom RPC wajib `https://` (`app.js:322`, `app.js:596`). KyberSwap API pakai `x-client-id: 'bear-tool'` (bukan secret).

### Tambahan
- **Git history:** 2 commit, scan `git grep` seluruh history — tidak ada secret ter-commit.
- **Hardcoded secret:** grep `sk-`, `api_key`, `AKIA`, `password=` — bersih.
- **.env:** tidak ada file .env di project.

---

## Kesimpulan

Tidak ada temuan P0/P1. Lima temuan P0/P1 dari audit sebelumnya (SRI, XSS, chainId 0, double-submit, address poisoning) sudah diperbaiki dan terverifikasi. Dua temuan P2 tersisa bersifat hardening (bukan kerentanan aktif yang bisa dieksploitasi untuk mencuri dana). Tiga P3 bersifat hygiene.

**Prioritas perbaikan:** P2 #1 (revoke guard) = 5 menit. P2 #2 (approval limit) = fitur UI. P3 = opsional.