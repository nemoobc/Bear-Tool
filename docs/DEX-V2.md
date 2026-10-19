# DEX V2 — "Bear Exchange" (spesifikasi + desain + threat model)

> Status: SPEC — ditulis SEBELUM kode (alur: think → spec → threat-model → plan → bangun).
> Order user 2026-10-15: "fitur dex rombak ulang semua dengan fitur lengkap dan buat sendiri jangan comot pump.fun".
> Pengganti: launchpad pump.fun-style (bonding curve virtual + graduation). Dokumen ini = satu sumber kebenaran arah dex.

## 1. MASALAH

Dex sekarang adalah klon pump.fun: kurva bonding `x*y=k` dengan **virtual reserves**, "graduation", fee
creator ala pump, feed coin meme. Order sebelumnya membangun ini secara sadar ("The flow is pump.fun's").
Order baru: **rombak ulang semua, fitur lengkap, ORISINAL — bukan comot pump.fun.**

Ambigu lama (dua mesin: V2 pools + bonding curve, dua "ETH", pair global) dijawab dengan MENGHAPUS pools.
Sekarang dijawab dengan arah sebaliknya tapi tetap satu mesin: **pools = satu-satunya mesin. Tidak ada curve sama sekali.**

## 2. SPESIFIKASI PERILAKU

### 2.1 Prinsip produk
- **SATU mesin: pool AMM dengan reserve NYATA** (`x*y=k` biasa, bukan virtual). Semua trading lewat pool.
- **Quote = salah satu coin ERC-20 milik Dex** (3 preset: Bear ETH/USDT/USDC) — order lama dipertahankan
  ("coin native eth itu buat gas fee aja only"). Pool = (TOKEN ↔ QUOTE), **satu quote per token**
  (dua quote = dua harga = ambiguitas). Tanpa router, tanpa pair global state. ETH native ditolak kontrak.
- **Launch = SATU transaksi**: factory deploy token + pair + seed + lock atomik. Token langsung tradeable.
- **Lock LP = fitur kelas satu** (anti-rug built-in): creator mengunci LP shares 30/90/365 hari atau permanen.
  Shares terkunci tak bisa transfer/burn sampai waktunya — terlihat transparan di halaman token.
- Semua angka di layar = DIBACA dari kontrak hidup. Kontrak tak terbaca → bilang tak terbaca, bukan nol palsu.
- Semua aksi = transaksi nyata dengan sheet **cancel + confirm** (pola gate deploy yang sudah ada).

### 2.2 Permukaan fitur (tabs + halaman)
| # | Surface | Isi |
|---|---------|-----|
| 1 | **Swap** | Beli/jual token lewat pool; quote real dari reserve; minOut wajib (default slippage, cap); MAX; fee 0.3% tampil |
| 2 | **Pools** | Daftar semua pool dari event factory (per chain); reserve, harga, fee, volume; bikin pool utk token existing (advanced) |
| 3 | **Liquidity** | Add/remove LP per pool; LP = ERC-20 ("BLP"); posisi user (shares, nilai, % pool); lock dari launch tampil di sini; auto-isi rasio reserve, peringatan miring dalam uang, estimasi APR fee dari volume 24 jam (label perkiraan), urutan approve dinamai di sheet konfirmasi |
| 4 | **Launch** | Wizard: metadata (nama/ticker/gambar/deskripsi) + supply + harga & likuiditas awal (quote) + durasi lock → **SATU tx** `factory.launch` (token+pool+seed+lock atomik). Gunakan approve quote dulu; tanpa sheet ganda tiap tx tetap punya cancel+confirm |
| 5 | **Token page** | Chart candle rentang 1m/5m/1h/1d — bucket waktu dari event swap yang sudah dibaca (ganti rentang = 0 RPC; jam sepi tanpa candle, celah = fakta), tape trade, buy/sell, info pool + status lock + creator |
| 6 | **Portfolio** | Token milikmu + posisi LP + nilai; aksi: remove LP, buka pool |
| 7 | **Bot** | Market maker lama (address turunan seed) diadaptasi ke pool — beli/jual berkala sampai dihentikan/saldo habis |
| 8 | **Feed & delete** | Feed = daftar pool/token (home); delete coin = tombstone permanen (fix user 2026-10-15) tetap berlaku |

### 2.3 Aturan & batasan
- **Sepolia-only v1** + gate chain tetap (satu klik pindah ke Sepolia).
- Tanpa migrasi coin PumpToken lama (testnet; coin lama tidak muncul di registry baru).
- Kontrak ditulis sendiri (bukan fork Uniswap/pump); 3 kontrak: `BearToken`, `BearPair`, `BearFactory`.
- Fee swap 0.3% (997/1000) — dibagi dari fee yang SAMA: default 100% ke pool (LP); sejak R6/R9 koin bisa mengarahkan potongan TETAP ke kreatornya (0/10/15 bps dari volume — dipilih saat launch, immutable; math trader tidak berubah). Tidak ada protocol fee; tanpa owner/pause/saklar fee.
- Pembulatan: selalu floor ke arah pool (kontrak) dan JS memakai rumus floor yang SAMA (parity test).
- i18n EN+ID penuh untuk semua string baru; style cartoon konsisten; a11y (label, focus, aria).

### 2.4 Error yang harus tertangani
- Kontrak/pool tak terbaca → pesan jelas, bukan angka nol.
- Slippage: minOut tak terpenuhi → tx revert → pesan "harga bergerak" + nilai aktual.
- Token bukan buatan factory di createPool → validasi minimal (transfer return check), pesan jelas.
- Lock aktif → transfer/burn LP ditolak kontrak → UI menampilkan sampai kapan.
- Chain bukan Sepolia → semua kontrol inert + gate (pola lama).
- Gas estimation gagal → berhenti dengan pesan bernama (pola deploy gate).

### 2.5 Non-goal v1
- Multi-chain dex (factory deploy per chain dsb.) — nanti.
- Router multi-hop (token A ↔ token B lewat ETH) — v1 hanya direct (TOKEN↔ETH).
- Audit pihak ketiga formal — testnet; dicatat sebagai risiko diterima.
- Migrasi/pembacaan coin PumpToken lama.

## 3. THREAT MODEL (sebelum desain — surface finansial)

```
ASET    : ETH di pool + LP shares + integritas harga + fee LP
AKTOR   : MEV/sandwich bot (anonim), token nakal (ERC-20 aneh), creator rug (tarik LP mendadak), user salah input
JALUR   : (a) swap tanpa minOut → sandwich; (b) token non-standar (fee-on-transfer/reentrancy) → state rusak;
          (c) removeLiquidity mendadak → exit scam; (d) lock bypass → LP lolos saat lock; (e) math fee/rounding → drain;
          (f) reentrancy via callback token; (g) spam token murah → banjir feed
DAMPAK  : P0 = dana pool/users; P1 = harga dimanipulasi; P2 = spam; P3 = kosmetik
MITIGASI: minOut wajib di UI (default 0.5-1%, tak 0; cap max) • nonReentrant semua mutasi + CEI
          • invariant k' ≥ k dicek setelah swap (floor fee → pool) • lock: hanya owner shares, tidak ada unlock awal,
          transfer/burn terhadap lock dicek di kontrak • launch hanya token factory kami; createPool validasi transfer-return
          • JS↔kontrak math parity test (fuzz tabel) • feed scope + tombstone utk spam
SISA    : testnet-only → dana nyata minim; audit pihak ketiga = non-goal v1 (disetujui lewat dokumen ini)
```

## 4. ARSITEKTUR

### 4.1 Kontrak (Solidity, compile in-browser via solc pipeline yang ada — satu source string, tiga artifact)
- `BearToken` — ERC-20 penuh: name/symbol/decimals 18, supply TETAP saat deploy (mint penuh ke deployer = factory),
  metadata string (image data-URI, description) di constructor + socials (twitter/telegram/website) ditulis SEKALI
  oleh factory (`setSocials`, factory-only, di tx launch yang sama); tanpa owner, tanpa mint lanjutan.
- `BearPair` — pool: reserve = **quote ERC-20 (immutable)** + token (immutable); `addLiquidity` / `removeLiquidity`
  (pull kedua sisi dari msg.sender, shares = sqrt utk provider pertama, proporsional setelahnya);
  `swapQuoteForToken(amountIn, minOut)` / `swapTokenForQuote(amountIn, minOut)`; `getAmountOut` view;
  LP = ERC-20 (`Bear LP`/`BLP`) dengan `lockShares(until)` — cek lock di transfer/burn; `nonReentrant`;
  invariant `k' ≥ k` dicek pasca-swap; **tanpa `receive()`** — ETH native ditolak (gas-only, order user dipertahankan);
  fee kreator: `creatorFeeBps` (0..30, immutable) + `creator` + `totalFeesCreator`; potongan `amount×bps/10000` diambil
  dari sisi quote penerimaan pool saat swap (dibagi dari fee, bukan tambahan — trader tetap 997/1000); `claimFees()`
  creator-only (pull) + event `FeesClaimed`; `reserves()` = saldo − fee belum diklaim (net); `devBuy(buyer, quoteIn)`
  factory-only = beli pertama atomik di tx launch.
- `BearFactory` — `launch(meta7, quote, tokensForPool, quoteForPool, lockUntil, creatorFeeBps, devBuyIn)` SATU TX: deploy token + pair,
  `setSocials` + transferFrom quote (seed + dev buy; creator approve dulu) + supply token ke pair, `pair.mintInitial(creator, …, lockUntil)`
  (sekali, factory-only, lock atomik), dev buy opsional dibelikan di tx yang sama, sisa supply → creator; `createPool(token, quote, …)` utk token existing;
  `pairFor[token]` unik (satu pair per token); registry lewat event `Launched` / `PoolCreated` (source of truth = chain).

### 4.2 JS (js/dex/ — ganti pump modules)
- `core.js` (pertahankan + rapikan), `pool-math.js` (pengganti curve.js — murni, parity dgn kontrak),
  `pools.js` (scan event factory: `Launched`/`PoolCreated` → daftar pool + meta cache + create pool), `swap.js`, `launch.js` (pengganti create.js),
  `liquidity.js`, `portfolio.js` (baru), `bot*.js` (adaptasi), `history.js`/`chart.js` (sumber event baru),
  `tokens.js`→feed (daftar token/pool), `index.js` (routes: pools | swap | launch | portfolio + halaman coin/pool).
- Hapus: `curve.js`, `pump-source.js` dan panel yang tak wired (tanpa fitur zombie).

### 4.3 Bukti wajib (per milestone)
- M1 kontrak + anvil e2e: launch → buy → sell → add/remove LP → lock (transfer awal = HARUS revert; setelah warp = ok) → fee accrual → tanpa dana terdampar → k monoton.
- M2 math parity JS↔kontrak (tabel fuzz lewat anvil read).
- M3-M5 unit + view + interaction tests (pola suite dex sekarang).
- M6 e2e latih: anvil full journey + fase emulator baru + playwright spec; soak nav.
- M7 audit-full + red-team kontrak (sad-path: sandwich/minOut, reentrancy, lock bypass, drain) → APK.

## 5. MILESTONE (ladder aktif, tiap M punya bukti exit 0)

| M | Isi | Bukti |
|---|-----|-------|
| M1 ✅ | Pondasi dex v3 dari 0: `core.js` (gerbang engine chain) + `index.js` (status jujur network/wallet/engine, nol alamat tetap jalan) | render ke-0 tanpa crash + state gate (2026-10-17) |
| M2 ✅ | Kontrak + anvil: 3 artifact (`BearToken`/`BearPair`/`BearFactory`) satu source `contracts.js`; ABI ui = potongancompiler-paritet (canon pin); pair swap floor-kontrak; NO-NATIVE di pair | `node --test tests/dex-contracts.test.js tests/dex-abi.test.js` + sha `aa1b7ed` |
| M3 ✅ | Trade sheet: paste alamat pair → baca live → quote `getAmountOut` (view mirror) → sheet 2 langkah (approve EXAKT → swap) + pita slippage fix + creator fee; jalur `safetx` waitForReceipt | `node --test tests/dex-swap.test.js` + sha `85f4d65` |
| M4 ✅ | Pools + LP: `pools.js` (scan event `Launched` factory, `poolState` live, preview mint/burn = aturan kontrak persis — sqrt Newton + MIN rasio-lantai; `addLiqData`/`removeLiqData`; ingat factory per chain) + kartu pool + panel LP (posisi saya, approvals kaki-EXAKT dua sisi, gate kunci live) + `BEAR_FACTORY_ABI` canon + 10 tes baru (pools 7, view 2, abi 1); **unit 1550 (1547 pass / 0 fail / 3 skip), check 270 file OK, dist gate 4/4, build ✓** (2026-10-18) | `node --test tests/dex-pools.test.js tests/dex-swap.test.js tests/dex-abi.test.js` |
| M5a ✅ | Launch wizard: `launch.js` (data layer launch + event `Launched`) + wiring kartu launch `index.js` + guard `decodeLaunched` `pools.js` + i18n id/EN + css + 9 tes `tests/dex-launch.test.js` | **CI Auto-Test 39220443573 SUCCESS — 223 E2E passed (33.3m), unit+audit+E2E semua hijau** (2026-10-19), sha `3dab4e3` |
| M5b ✅ | Halaman token (7 string publik + socialsSet + totalSupply) + chart/tape dari event `Swap` | unit 7/7 + CI 3-run SUCCESS (Fork unichain+worldchain hijau, `b09d448`, 2026-10-19) |
| M6 ✅ | Bot (engine v3 tanpa konsep graduated + wallets derive/split + runner band-standar) + feed tokens.js + tombstone list.js + wiring + i18n 58×2 + css + 12 tes | unit 1575/0 + check 280 file + dist gate; **CI 3-run SUCCESS** (Fork rerun hijau — foundryup flake GitHub 500, bukan kode), sha `3443bcb` (2026-10-19) |
| M7 | Audit + red-team + APK (`~/storage/documents/Bear-Tool-<sha>.apk`, tanda tangan pinned) | audit-full CLEAN, APK terkirim |

## 6. ESTIMASI (dari angka nyata)

- js/dex sekarang: **4151 baris / 14 file** + **17 file test**. Target v2: ~4800-5500 baris / ~13 file + 3 file kontrak.
- Test: rewrite ~14, keep ~3 (delete/wiring pola), tambah e2e baru. Total = **XL** → wajib milestone (pecah di atas).
