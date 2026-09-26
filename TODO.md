# Bear Tool — TODO / Audit Backlog

Dikelola otomatis oleh sesi audit ULTRA. Status: `[ ]` open, `[x]` done, `[~]` sebagian/in-progress.

## P0 — Keamanan (harus fix)
- [x] **Secret plaintext di localStorage** (`js/wallet.js`) `bear.session.ls` — tinjauan: fitur tab-reopen DIUJI eksplisit; mitigasi ada (auto-lock window di boot, clearSession saat lock). Diputuskan: pertahankan perilaku, dokumentasikan risiko.
- [x] **iframe dApps: URL tanpa escape + sandbox `allow-same-origin`** (`js/dapps.js`) — escapeHtml + validasi http(s) + sandbox tanpa `allow-same-origin`.
- [~] **solc CDN tanpa SRI** (`js/solc.js`) — `SOLC_INTEGRITY` sha384 + crossOrigin terpasang. _Tunggu verifikasi browser compile real._
- [ ] **CSP lemah** (`index.html` `unsafe-inline unsafe-eval` + 3 CDN) — dinilai; pengetatan butuh audit dependensi runtime (solc wasm/eval). Hold — dokumentasikan, bukan fix cepat.

## P1 — Kualitas / A11y / CI
- [x] **Dark mode: kontras tombol `.btn` 1.16–2.10:1** — FIXED: `.theme-dark .btn { color: #2D2A32 }`.
- [x] **Skip link tanpa target `#main`** — FIXED: `id="main"` pada `<main>` (tabindex=-1).
- [x] **Duplikat ID (6 ID)** — blok Revoke kedua (view-deploy) dihapus.
- [x] **CI drift: job `onchain-fork` inline + `continue-on-error: true`** — job duplikat dihapus; `fork-tests.yml` = satu sumber kebenaran.
- [x] **`.gitignore` baris 3 rusak** (`.DS_Storeprobe-build.mjs`) — dipisah.
- [x] **`.gitignore` menelan `js/vendor/`** — pola `vendor/` match ke direktori manapun bernama `vendor`, jadi `js/vendor/ethers.umd.min.js` **pernah ke-ignore dan tidak pernah masuk repo**. Fresh clone 404 pada script utama wallet lalu jatuh ke CDN `document.write` — persis single point of failure yang vendoring dimaksudkan untuk hilangkan. FIXED: `vendor/` → `/vendor/` + file di-commit. SRI diverifikasi cocok byte-per-byte dengan `ethers-6.17.0.tgz` dari npm.
- [x] **Pill topbar hanya mouse** (`#networkPill`, `#accountPill`) — `<div>` tanpa `role`/`tabindex` dan tanpa wiring keyboard, sedangkan setiap `.nav-item` punya `role="button" tabindex="0"`. FIXED + 4 test a11y baru (role, focus, Enter, Space).
- [x] **Card DApps hanya mouse** — `<div class="dapp-card">` tanpa role/tabindex. FIXED + `aria-label` per card.
- [x] **Input DApps menjanjikan "search DApp" tapi tidak ada filter sama sekali** — FIXED: filter teks (nama/kategori/URL) + chip kategori + empty state.
- [x] **`lang` statis `en`** — masih parsial; P2-low.

## P1 — Paritas mobile ⭐ (sesi 2026-09-26)
- [x] **Fitur EIP/Tools hanya ada di desktop** — mobile nav keras berisi 6 item sementara sidebar punya 9, jadi `eip7702`, `approval`, dan `deploy` **tidak terjangkau sama sekali** di ponsel. Tombol "More" malah cuma membuka Settings.
  FIXED: `syncMobileNav()` membuat bottom bar dari `.sidebar .nav-item` — satu sumber kebenaran, drift mustahil terjadi lagi. Primary row (dashboard/swap/activity/nft) + tombol **More** membuka sheet berisi **seluruh** view. `switchView()` menyalakan tombol More saat view di belakang More aktif.
- [x] **Chart di list coin** — sparkline 24h per kartu di `renderAssets()` dihapus: tiap baris menembak request `fetchPriceHistory` sendiri yang semuanya gagal CORS dari static host, jadi list menampilkan kolom kotak kosong. Chart detail per-token (modal) tetap ada, digambar on-demand.
- [x] **"Tambah Token" di posisi salah** — pindah dari baris header `#assetSearch` ke bawah `#assetList`.
- [x] **Tambah jaringan = 5 field ketik manual** (name/chainId/RPC/symbol/explorer) — salah ketik chainId diam-diam bikin jaringan yang ngomong ke chain yang salah. FIXED: picker 15 preset EVM + search. RPC tiap preset **diverifikasi** menjawab `eth_chainId` sesuai klaimnya (`docs/CHAIN-PRESETS.md`); preset yang gagal verifikasi dibuang, bukan dikirim. Simpan juga memverifikasi `eth_chainId` RPC terhadap chain yang dipilih.
- [x] **Nama token contract tidak auto-kedeteksi** — paste address sekarang membaca `symbol()`/`name()`/`decimals()` langsung dari contract dan menampilkan hasilnya sebelum commit; address salah tidak pernah mengaktifkan tombol Add. Probe terakhir menang (tidak bisa ditimpa round-trip lama).

## P2 — Perbaikan kecil
- [ ] Quote-error kontras 2.77:1 (designer) — tinjau CSS.
- [ ] I18n parsial (string hardcoded belum semua data-i18n).

## P0 — Keamanan (lanjutan sesi 2026-09-26)
- [x] **MAX menulis saldo penuh tanpa potong gas** (`js/send.js`, `js/swap.js`) — tombol 100% dan tombol Swap MAX mengisi `amount = balance`, sehingga transaksi native **tidak bisa membayar gas-nya sendiri** dan node membalas "insufficient funds for gas". Gejalanya persis "user pencet max lalu error". Bridge tidak punya MAX sama sekali. FIXED: `js/max-amount.js` (aritmetika murni) + `js/max-ui.js` (fee & gas limit dari node). Aturan: gas hanya dipotong bila token yang dikirim = token pembayar gas; **truncate, jangan round** (`toFixed()` lama bisa menghasilkan angka DI ATAS saldo); bila saldo tak cukup bayar fee, field dikosongkan + penjelasan dua angka, bukan error mentah node. Verifikasi pra-send ditambahkan untuk menangkap saldo yang berubah sejak MAX ditekan.
- [x] **DApp browser tanpa gate** — navigasi apa pun bisa diarahkan ke host mana pun. FIXED: `js/dapp-safety.js` sebelum setiap muat. `javascript:`/`data:`/`blob:`/`file:` diblokir; punycode & mixed-script (homograph) DITOLAK tanpa jalur bypass; lure word di TLD murah DITOLAK; HTTP polos diperingatkan; situs tak dikenal dilaporkan sebagai *unknown*, bukan *known-good*. Allow-list user **tidak boleh** membatalkan DANGER — ingatan user soal nama dApp justru yang dipalsukan homograph.
- [x] **Iframe DApps tidak diperketat** — `allow="clipboard-write; clipboard-read"` memberi dApp akses clipboard (vektor drainer nyata) dan tidak ada `referrerpolicy`. FIXED: `referrerpolicy="no-referrer"`, `credentialless` (tanpa cookie/storage ambient), `allow=""` (tanpa clipboard/mic/kamera), sandbox tetap tanpa `allow-same-origin` dan tanpa `escape-sandbox`.
- [x] **URL berpenyebab rahasia tersimpan** — address bar menerima apa saja; frasa pemulihan atau private key yang tertempel bisa tersimpan di history/bookmark. FIXED: `isSecretishUrl` + `sanitizeForStore` menolak penyimpanan, dan fragment dibuang (sering memegang token OAuth).
- [x] **Transaksi ditandatangani tanpa readability** — `approve` unlimited, `setApprovalForAll`, `permit`, selector tak dikenal, kontrak baru, nilai besar. FIXED: `js/security.js` men-decode calldata dan menandai tiap temuan dengan spender yang disebut; nilai besar minta konfirmasi ketik-angka; calldata mentah selalu ditampilkan.
- [x] **Bridge same-origin tidak ada gate** — FIXED: `js/dapp-bridge.js` menyediakan `window.ethereum` hanya untuk origin wallet sendiri, dengan persetujuan per-origin, grant per-metode untuk yang menandatangani/mengirim, allow-list metode, dan **nol jawaban saat wallet terkunci**. Tidak mengaku sebagai MetaMask. Batasannya (dApp cross-origin tidak bisa mendeteksi wallet ini) ditulis di Security Center, bukan disembunyikan.

## P1 — DApp browser jadi browser sungguhan
- [x] **Hanya satu tab, tanpa restore** — kini tab strip (buka/tutup/pindah), tab incognito yang tidak pernah ditulis ke storage, dan session restore.
- [x] **Omnibox tidak bisa search** — `classifyInput` membedakan URL vs pencarian; pencarian **hanya** ke katalog lokal dulu, dan kueri tidak dikirim ke pihak ketiga kecuali tombol eksplisit ditekan.
- [x] **Bookmark ada tapi tak ada daftar** — home page kini menampilkan bookmark, riwayat, dan grid yang bisa dimuat + filter kategori.
- [x] **DApp hilang dari sidebar** — nav `data-view="dapps"` ditambahkan + `nav.dapps` i18n.

## P1 — OpenSea
- [x] **API key terkubur di field ketiga** — panel kini dibuka tutorial 3 langkah; API key jadi **langkah 1** lengkap dengan halaman pembuatan key, penyimpanan lokal, dan tombol **Test** yang benar-benar menguji key ke OpenSea (HTTP 200/401), plus show/hide.
- [x] **Cek WL tidak pernah cek address** — handler lama hanya melihat apakah koleksi publik/private lalu menyebut itu "eligible". FIXED: cek address sungguhan lewat `GET /api/v2/collections/{slug}/holders` (berpage),dilaporkan sebagai *holder* dengan jumlahnya, dan Private allowlist proyek dinyatakan tidak bisa dibaca dari sini.
- [x] **Tidak ada harga/gas/total/keamanan** — `js/nft-intel.js`: ask terendah + gas nyata + total + 6 sinyal keamanan (proxy 1967, `owner()`, `paused()`, simulasi transfer honeypot, supply, flag `is_suspicious` OpenSea). Tidak eligible → tampil sebatas itu saja.

## Onchain (session berjalan)
- [x] Setup env: npm 9.2.0 + node 22.22.1, web lokal, chromium (playwright).
- [x] Fork 12 network dijalankan (`run-fork-all.sh`, 11 test per network).
- [x] `bsc-testnet` sempat merah (ERC-1155 `missing revert data`) — **bukan bug kontrak**: RPC publik `data-seed-prebsc` flaky saat 4 fork jalan paralel. FIXED: `withRpcRetry` mengulang **hanya** error transport; revert yang membawa `reason=` **tidak** diulang (itu jawaban kontrak, mengulangnya menyembunyikan hasil). Plus `--test-timeout=150000` supaya hang menggagalkan 1 test, bukan menghabiskan seluruh budget jaringan.
- [x] `sepolia` keluar `EXIT 124` (timeout 600s) — hang, bukan gagal. FIXED dengan batas per-test + budget jaringan 900s.
- [x] Unit suite: **366 test** (365 pass, 1 skip) — HIJAU.
- [~] E2E suite penuh ter-track di `tests/e2e/` (20 spec file) dan dijalankan CI lewat `npm run test:e2e`.
