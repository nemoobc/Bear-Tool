# Bear Tool — E2E Report

**Tanggal**: 2026-09-16
**Tester**: TESTER (all-rounder)
**Metode**: Unit gate + probe headless (Node 24, tanpa browser) + probe API real
**Kode produksi**: TIDAK diubah. Hanya menambah `tests/e2e-probe.test.js` (probe) + folder `tests/e2e-shots/`.

---

## 1. GATE UNIT TEST — `npm run verify`

| Item | Hasil |
|---|---|
| `npm run check` (syntax semua js/*.js) | ✅ PASS |
| `node --test tests/*.test.js` | ✅ PASS |
| Total test | **22/22 hijau** (0 fail, 0 skip) |
| Exit code | 0 |

Bukti: `npm run verify` → `tests 22, pass 22, fail 0`.

---

## 2. KETERBATASAN E2E BROWSER — JUJUR

**E2E browser TIDAK bisa jalan di Termux karena:**
- `which chromium google-chrome` → **tidak ada** (tidak ada browser Chromium terpasang).
- `npx playwright --version` → **`playwright: not found`** (paket tidak terpasang; install butuh unduhan browser ~150MB+ dan dependensi sistem yang tidak tersedia di Termux tanpa root).
- `node_modules` hanya berisi `ethers` + dependensinya — **tidak ada jsdom/puppeteer/playwright**.

**Yang dilakukan sebagai pengganti (jujur, bukan berlagak):**
1. **Probe modul headless** (`tests/e2e-probe.test.js`, 9 test) — menguji logika wallet import/unlock, intro 5s, double-submit lock, EIP-7702 chainId guard, i18n EN/ID, dengan stub DOM minimal.
2. **Probe API real** — memanggil KyberSwap, LI.FI, CoinGecko langsung dari Node untuk membuktikan endpoint mana yang real vs simulated.
3. **Code review** — membaca alur `app.js`/`send.js`/`swap.js`/`bridge.js`/`eip7702.js`/`deploy.js`/`nft.js`/`theme.js`/`i18n.js` untuk memverifikasi perilaku yang tidak bisa diuji headless.

**TIDAK ADA screenshot** (`tests/e2e-shots/` kosong) karena tidak ada browser untuk menangkap gambar. Bukti = output console probe (di bawah).

---

## 3. HASIL PER LANGKAH

| # | Langkah | Hasil | Bukti |
|---|---|---|---|
| 1 | `index.html` load tanpa error konsol | ⚠️ **TIDAK TERUJI (browser)** | Tidak ada browser. Syntax check semua JS PASS (`npm run check`). CDN ethers 6.14.0 + SRI sha384 terpasang (index.html:343-345). |
| 2 | Intro 5 detik → lewat/skip → dashboard render | ✅ **PASS (code review + probe)** | `theme.js:40` `setTimeout(finish, 5000)`; skip click handler `theme.js:23`; `app.js:39` `runIntro(() => { showUnlockModal/showWelcomeModal })`. Probe: intro tidak selesai sebelum 5s. |
| 3 | Wallet unlock (import mnemonic 12 kata) → balance & address | ⚠️ **BUG DITEMUKAN** | Import mnemonic OK (`wallet.importWallet` → address valid). **TAPI `wallet.unlockWallet` GAGAL untuk wallet hasil import seed phrase** — `wallet.js:130` `new ethers.Wallet(secret)` memperlakukan seed phrase sebagai private key → `invalid BytesLike value`. App.js punya workaround (`app.js:240` bikin Wallet langsung dari secret), jadi UI mungkin jalan, tapi API wallet.js rusak. Balance display butuh RPC live (tidak diuji headless). |
| 4 | Load token: dashboard token list + harga USD | ✅ **PASS (API real)** | CoinGecko native price: **HTTP 200, ETH = $2396.70** (real). DexScreener fallback: HTTP 200 tapi array kosong untuk USDC (tidak ada pair — harga token ERC-20 bisa tetap '—' bila CoinGecko rate-limit + DexScreener kosong). `price.js` punya cache 5 menit. |
| 5 | Send flow: form valid → preview → tombol disable double-submit | ✅ **PASS (probe)** | `safetx.js:43` `runTx` lock: probe membuktikan panggilan kedua diblokir (`calls == 1`). Preview + gas estimate `send.js:34-60`. |
| 6 | Swap flow: quote KyberSwap | ✅ **REAL (API)** | KyberSwap `aggregator-api.kyberswap.com/ethereum/api/v1/routes` → **HTTP 200, code 0**, `amountOut = 2394370988` (≈2394.37 USDC untuk 1 ETH), router `0x6131B5fae19EA4f9D964eAc0408E4408b66337b5`. `swap.js:73-99` memakai API real; fallback simulated hanya bila chain tidak didukung (KYBER_CHAIN_SLUG hanya 6 chain) atau API offline. |
| 7 | Bridge flow: LI.FI quote | ❌ **SIMULATED (2 bug)** | **Bug 1**: `bridge.js:49` tidak mengirim `fromAddress` → LI.FI balas **HTTP 400** `querystring must have required property 'fromAddress'` → selalu jatuh ke simulated. **Bug 2**: walau `fromAddress` ditambah, LI.FI `/quote` mengembalikan **objek route tunggal** (`{id, tool, action}`), bukan `{routes:[...]}` — `bridge.js:54` membaca `q.routes?.[0]` → `undefined` → tetap simulated. |
| 8 | EIP-7702 panel: chainId guard | ✅ **PASS (probe + code)** | `eip7702.js:50-71`: default = active chain; chainId 0 diblokir di mainnet (`toast('chainId 0 ... blocked on mainnet')`); di testnet butuh konfirmasi ketik `SAYA PAHAM RISIKO REPLAY`. Probe membuktikan blokir mainnet. |
| 9 | NFT load | ⚠️ **REAL on-chain (best effort)** | `nft.js:56-82` enumerasi on-chain 4 kontrak populer (BAYC/MAYC/Azuki/Doodles) via `tokenOfOwnerByIndex` + `tokenURI` + metadata IPFS/Arweave. Bila kosong → pesan jujur "Full gallery needs an indexer". Tidak diuji headless (butuh RPC + wallet dengan NFT). |
| 10 | Deploy wizard | ⚠️ **STUB (jujur)** | `deploy.js:47` `toast('Deploy wizard needs contract templates (Solidity bytecode)...')` — form lengkap (standard/name/symbol/extra fields) tapi eksekusi = stub. |
| 11 | Theme toggle → persist | ⚠️ **TIDAK ADA TOGGLE THEME** | `theme.js` hanya intro animation + mascot helper. **Tidak ada tombol toggle theme** di index.html/settings. Tidak ada yang bisa diuji. |
| 12 | i18n toggle EN/ID | ✅ **PASS (probe)** | `i18n.js`: `setLang('id')` → `nav.dashboard` = "Dasbor", `nav.send` = "Kirim", `settings.language` = "Bahasa"; persist ke `localStorage['bear.lang']`. Probe membuktikan. |

---

## 4. ERROR CONSOLE YANG DITANGKAP

Tidak ada browser → tidak ada console browser. Yang tertangkap dari probe:

```
[wallet.unlockWallet] invalid BytesLike value (argument="value",
  value="0x<seed phrase 12 kata>", code=INVALID_ARGUMENT)
  → js/wallet.js:130 (new ethers.Wallet(secret))
```

---

## 5. TEMUAN / BUG

| # | Severity | Temuan | Lokasi | Saran fix |
|---|---|---|---|---|
| B1 | **P1** | `unlockWallet` gagal untuk wallet hasil import seed phrase (memperlakukan phrase sebagai private key) | `js/wallet.js:130` | Deteksi `accounts[idx].path === 'imported'` + secret berisi spasi → pakai `ethers.Wallet.fromPhrase(secret)`; simpan flag `isPhrase` di accounts saat import. |
| B2 | **P1** | Bridge selalu simulated: `fromAddress` tidak dikirim ke LI.FI | `js/bridge.js:49` | Tambah `&fromAddress=${get('address')}` ke URL quote. |
| B3 | **P1** | Bridge simulated walau API 200: shape response LI.FI salah dibaca (`q.routes?.[0]` vs objek route tunggal) | `js/bridge.js:54-55` | Baca `q.id/q.tool/q.action` langsung (LI.FI `/quote` = objek tunggal), atau pakai endpoint `/advanced/routes` yang mengembalikan `{routes:[...]}`. |
| B4 | **P2** | DexScreener fallback mengembalikan array kosong untuk USDC mainnet → harga token bisa '—' walau API hidup | `js/price.js:103-110` | Tambah fallback kedua (mis. CoinGecko retry dengan delay, atau 1inch price API). |
| B5 | **P3** | Tidak ada theme toggle sama sekali (langkah 11 tidak bisa diuji) | `index.html` / `js/theme.js` | Tambah toggle di Settings + persist `bear.theme` di localStorage. |

---

## 6. KESIMPULAN — REAL vs SIMULATED

| Fitur | Status |
|---|---|
| Wallet create/import/encrypt/decrypt | ✅ REAL (22 unit test + probe) |
| Wallet unlock (import phrase) | ❌ **BUG** (B1) |
| Harga USD (CoinGecko) | ✅ REAL |
| Harga token ERC-20 (DexScreener fallback) | ⚠️ Sebagian (B4) |
| Send (preview, gas, double-submit lock) | ✅ REAL (logika; eksekusi butuh RPC) |
| Swap quote | ✅ **REAL KyberSwap** (6 chain: ethereum/optimism/bnb/polygon/base/arbitrum) |
| Bridge quote | ❌ **SIMULATED** (B2+B3 — LI.FI tidak pernah dipakai benar) |
| EIP-7702 delegate/revoke | ✅ REAL (signAuthorization; butuh RPC type-4) |
| EIP-7702 batch/rescue/claim | ⚠️ STUB jujur (butuh implementation contract) |
| NFT gallery | ✅ REAL on-chain (best effort, 4 kontrak mainnet) |
| Deploy wizard | ⚠️ STUB jujur (butuh bytecode template) |
| i18n EN/ID | ✅ REAL |
| Theme toggle | ❌ TIDAK ADA |

---

## 7. BUKTI PROBE (output console)

```
✔ E2E-probe: import 12-word mnemonic → address + balance display path
    unlockWallet(imported phrase) FAILED: invalid BytesLike value ... (BUG B1)
✔ E2E-probe: intro 5s timer + skip wiring
✔ E2E-probe: runTx double-submit lock blocks re-entry
✔ E2E-probe: EIP-7702 chainId guard logic
✔ E2E-probe: i18n toggle EN → ID changes labels
✔ E2E-probe: KyberSwap quote API returns real route (ETH→USDC, mainnet)
    KyberSwap: amountOut = 2394370988 | router = 0x6131B5fae19EA4f9D964eAc0408E4408b66337b5
✔ E2E-probe: LI.FI quote API — current bridge.js call (no fromAddress) fails → simulated fallback
    LI.FI without fromAddress: querystring must have required property 'fromAddress'
✔ E2E-probe: LI.FI quote API works when fromAddress is added
    LI.FI with fromAddress: tool = layerswap | action.fromToken.symbol = ETH
    bridge.js reads q.routes?.[0] → SHAPE MISMATCH (routes undefined) → simulated fallback
✔ E2E-probe: CoinGecko native price API works (dashboard USD)
    CoinGecko ETH USD: 2396.7
ℹ tests 9, pass 9, fail 0
```

---

## 8. SELAIN (yang TIDAK teruji)

- Render DOM nyata, CSS, layout, interaksi klik di browser (tidak ada browser).
- Error console browser (tidak ada browser).
- Balance/address tampil di dashboard (butuh RPC live + browser).
- NFT on-chain nyata (butuh wallet dengan NFT).
- Eksekusi transaksi nyata (send/swap/bridge/deploy) — butuh wallet dengan dana + RPC.
- Screenshot (tidak ada browser).