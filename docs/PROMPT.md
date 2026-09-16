# BEAR TOOL — PROMPT LENGKAP (Web Wallet Crypto Cartoon)

> Prompt ini adalah spesifikasi eksekusi penuh untuk membangun **Bear Tool**:
> web wallet crypto self-custody, theme full cartoon, semua network EVM mainnet + testnet,
> fitur lengkap ala MetaMask/OKX + seluruh fitur EIP-7702-TOOL.
> Semua kode DITULIS SENDIRI dari nol — dilarang menyalin dari MetaMask/OKX/EIP-7702-TOOL.
> Referensi hanya untuk belajar pola & fitur.

---

## 1. IDENTITAS

- **Nama**: Bear Tool
- **Mascot**: Beruang kartun (SVG buatan sendiri — bukan comot dari mana pun)
- **Tagline**: "The Cartoon Wallet That Means Business"
- **Target**: Web browser (desktop + mobile), self-custody, non-custodial
- **Stack**: HTML5 + CSS3 + Vanilla JS (ES Modules) + ethers.js v6 (CDN) — TANPA framework

## 2. TEMA FULL CARTOON (WAJIB)

- Palet warna cerah & playful: kuning madu `#FFC93C`, oranye `#FF8A3D`, biru langit `#4ECDC4`,
  merah berry `#FF6B6B`, ungu `#9B5DE5`, hijau mint `#06D6A0`, krem latar `#FFF8E7`
- Border tebal 3-4px warna gelap `#2D2A32` di SEMUA elemen (kartun = outline tegas)
- Bayangan chunky: `box-shadow: 4px 4px 0 #2D2A32` (bukan blur halus)
- Sudut sangat membulat: `border-radius: 16-24px`
- Font: `Fredoka` / `Baloo 2` (Google Fonts) — bulat, playful, tebal
- Tombol: besar, hover "menekan" (translate + shadow mengecil), active state jelas
- Ikon: emoji + SVG kartun, bukan icon font generik
- Background: pola polkadot/awan/gelembung halus, animasi float lembut
- Mascot beruang muncul di: logo, loading, empty state, error state, konfirmasi transaksi
- Micro-interaction: tombol "wiggle" saat hover, kartu "bounce" saat muncul

## 3. ANIMASI (WAJIB)

### 3.1 Logo intro 5 detik (halaman pertama load)
- Fase 1 (0-1s): logo beruang muncul dari tengah, skala 0 → 1 dengan bounce
- Fase 2 (1-2s): mata beruang berkedip, telinga bergoyang
- Fase 3 (2-3s): teks "BEAR TOOL" muncul per huruf (stagger)
- Fase 4 (3-4s): lingkaran warna-warni mengorbit logo
- Fase 5 (4-5s): seluruh intro fade-out, masuk ke halaman utama
- Total TEPAT 5 detik, bisa di-skip dengan klik

### 3.2 Loading spinner (muter²)
- Spinner utama: beruang kecil berputar mengelilingi lingkaran titik-titik
- Spinner sekunder: 3 titik bouncing (untuk tombol)
- Spinner transaksi: animasi "madu menetes" (tema beruang)
- Semua spinner punya `aria-label` + `role="status"`

## 4. FITUR WAJIB (dari riset MetaMask + OKX + EIP-7702-TOOL)

### 4.1 Wallet Management
- Create wallet: generate seed phrase 12/24 kata (BIP-39), tampilkan sekali + wajib konfirmasi
- Import wallet: seed phrase ATAU private key
- Keystore terenkripsi: password → PBKDF2 → AES-GCM, simpan di localStorage
- Multiple accounts: derive dari seed (m/44'/60'/0'/0/0..n), switch account
- Export: private key / seed (wajib password ulang), copy address
- Hapus wallet: konfirmasi ketik "HAPUS"

### 4.2 Network (mainnet + testnet)
| Network | Chain ID | Tipe |
|---|---|---|
| Ethereum | 1 | mainnet |
| BNB Smart Chain | 56 | mainnet |
| Polygon | 137 | mainnet |
| Arbitrum One | 42161 | mainnet |
| OP Mainnet | 10 | mainnet |
| Base | 8453 | mainnet |
| Sepolia | 11155111 | testnet |
| Polygon Amoy | 80002 | testnet |
| Arbitrum Sepolia | 421614 | testnet |
| OP Sepolia | 11155420 | testnet |
| Base Sepolia | 84532 | testnet |
| BSC Testnet | 97 | testnet |
| Custom RPC | any | user-defined |

- Setiap network punya: nama, chainId, RPC list (fallback), explorer URL, native symbol, icon
- Badge jelas MAINNET (merah) vs TESTNET (hijau) — warning saat transaksi mainnet

### 4.3 Dashboard / Portfolio
- Total balance dalam USD (CoinGecko API, fallback manual)
- Daftar aset: native coin + ERC-20 (balance, USD value, 24h change)
- NFT gallery: ERC-721 + ERC-1155 (metadata + image)
- Grafik PnL sederhana (canvas, data dari riwayat)
- Multi-chain aggregation: pilih "Semua Network" → jumlahkan semua balance

### 4.4 Send (ETH & Token)
- Input: alamat tujuan (validasi checksum), jumlah (manual / MAX / USD)
- EIP-1559: maxFeePerGas + maxPriorityFeePerGas, gas selector:
  - Slow / Normal / Fast / Auto (dari estimasi RPC)
- Estimasi gas + preview biaya sebelum konfirmasi
- Konfirmasi kartun: beruang "kamu yakin?" + detail transaksi + tombol besar
- Riwayat: pending (spinner), sukses (✓), gagal (✗) + link explorer

### 4.5 Swap (aggregator)
- Quote dari 0x API (https://api.0x.org/swap/v1/quote) — fallback: quote simulasi
- Input: token dari / token ke, jumlah, slippage (0.1-5%)
- Alur: approval (jika perlu) → swap, satu alur konfirmasi
- Tampilkan: rate, price impact, gas, fee
- Mode: Market / Limit (limit = UI + catatan "butuh relayer")

### 4.6 Bridge (cross-chain)
- UI aggregator: pilih source chain, dest chain, token, jumlah
- Quote dari LI.FI API (https://li.quest/v1/quote) — fallback: simulasi
- Tampilkan: rute, estimasi waktu, fee, gas

### 4.7 EIP-7702 Suite (dari EIP-7702-TOOL — WAJIB)
- **Delegate**: EOA → kontrak implementation (tx type 0x04, authorization list)
  - Input: address kontrak implementation, chainId (0 = semua chain, atau chain spesifik)
  - Tampilkan penjelasan risiko + konfirmasi ketik "DELEGATE"
- **Revoke**: delegasi ke address 0x0 → akun kembali EOA biasa
- **Batch Call**: banyak aksi dalam SATU transaksi atomik (approve + swap, dll)
  - UI: daftar aksi (target, calldata/ABI, value), tambah/hapus, reorder
- **Rescue Atomic**: selamatkan ETH/ERC20/ERC721 dari wallet terkunci
  - Deploy kontrak rescue (sekali), target sign authorization, sponsor bayar gas
- **Claim Airdrop**: klaim + forward reward ke SAFE dalam satu TX atomik
- **Approval Manager**: scan approval ERC-20 (event log + allowance()), revoke self/sponsor
  - Token populer: USDT, USDC, DAI, WETH, WBTC, LINK, UNI, AAVE, SHIB, MATIC, ARB, OP, PEPE, CRV, SNX, SUSHI, COMP, MKR, LDO + custom
  - Mode: populer / menyeluruh (Etherscan API)
- **Wizard Deploy**: deploy ERC-20/721/1155 dari template
  - ERC-20: name, symbol, supply, mintable, burnable, pausable, permit
  - ERC-721: name, symbol, baseURI, mintable, burnable
  - ERC-1155: name, baseURI, mintable, burnable
  - Verifikasi otomatis: Sourcify + Blockscout (jika tersedia)

### 4.8 Security (WAJIB)
- Warning mainnet: konfirmasi ketik "YA" sebelum transaksi mainnet
- Deteksi phishing: daftar domain mencurigakan + warning saat input alamat
- Simulasi transaksi: estimasi balance change sebelum konfirmasi
- Address poisoning: deteksi alamat mirip (prefix/suffix sama) di riwayat
- Private key TIDAK PERNAH keluar browser — semua signing lokal
- Auto-lock: kunci wallet setelah X menit idle (default 5 menit)
- Backup reminder: peringatan berkala untuk backup seed phrase

### 4.9 Settings
- Custom RPC (tambah/hapus network)
- Mata uang: USD / EUR / IDR / CNY
- Bahasa: EN / ID
- Auto-lock timer
- Clear data (hapus semua wallet + settings)

## 5. STRUKTUR FILE

```
Bear-Tool/
├── index.html              # SPA — semua view di satu halaman (tab switching)
├── css/
│   └── cartoon.css         # SEMUA styling tema cartoon (satu file, terorganisir)
├── js/
│   ├── app.js              # entry point, router view, init
│   ├── ui.js               # render helpers, modal, toast, spinner
│   ├── theme.js            # tema, warna, animasi, mascot
│   ├── wallet.js           # create/import/encrypt/decrypt/derive/sign
│   ├── network.js          # daftar network, RPC, switch, custom RPC
│   ├── dashboard.js        # portfolio, balance, NFT, PnL
│   ├── send.js             # send ETH/token, gas, EIP-1559
│   ├── swap.js             # 0x API quote + swap
│   ├── bridge.js           # LI.FI quote + bridge
│   ├── eip7702.js          # delegate/revoke/batch/rescue/claim
│   ├── approval.js         # approval manager scan + revoke
│   ├── deploy.js           # wizard deploy ERC-20/721/1155
│   └── activity.js         # riwayat transaksi
├── assets/
│   ├── bear.svg            # mascot beruang (buatan sendiri)
│   ├── logo.svg            # logo Bear Tool
│   └── icons/              # ikon network, token (SVG)
├── docs/
│   └── PROMPT.md           # file ini
└── README.md
```

## 6. LIBRARY (CDN, versi pin)

- ethers.js v6: `https://cdn.jsdelivr.net/npm/ethers@6.13.4/dist/ethers.umd.min.js`
- Google Fonts: Fredoka + Baloo 2
- TANPA jQuery, TANPA React, TANPA framework lain

## 7. KEAMANAN WAJIB

1. Private key & seed phrase HANYA di memori + localStorage terenkripsi (AES-GCM, PBKDF2 310k iterasi)
2. Semua signing via ethers.js Wallet — key tidak pernah dikirim ke server mana pun
3. RPC calls via HTTPS saja
4. Warning eksplisit: "Ini software self-custody. Kehilangan seed = kehilangan dana. Tidak ada yang bisa membantu."
5. JANGAN log private key / seed ke console
6. Auto-lock default 5 menit
7. Konfirmasi ketik untuk aksi berisiko: mainnet tx, delegate, revoke, hapus wallet

## 8. TEST & VERIFIKASI

- `tests/wallet.test.js` (node): derive address dari seed, sign tx, encrypt/decrypt keystore
- `tests/network.test.js` (node): daftar network valid, chainId unik, RPC format valid
- Manual browser: create → import → switch network → send (testnet) → swap (testnet) → delegate (testnet)
- Lint: `node --check` semua file js
- Verifikasi: semua view render tanpa console error, semua tombol berfungsi

## 9. NON-GOAL (JANGAN DIBUAT)

- Jangan buat backend/server — 100% client-side
- Jangan simpan key di server/cloud
- Jangan integrasi hardware wallet (Ledger/Trezor) di v1
- Jangan buat token sendiri / ICO
- Jangan klaim "audited" — ini tool edukasi + self-use

## 10. KRITERIA SELESAI

- [ ] Tema cartoon konsisten di SEMUA view (border, shadow, warna, font)
- [ ] Logo intro TEPAT 5 detik + bisa skip
- [ ] Loading spinner muter² di semua operasi async
- [ ] Create/import/export/hapus wallet jalan
- [ ] 12+ network mainnet+testnet + custom RPC
- [ ] Dashboard portfolio multi-chain + NFT
- [ ] Send ETH/token EIP-1559 + gas selector
- [ ] Swap aggregator (0x API + fallback)
- [ ] Bridge UI (LI.FI + fallback)
- [ ] EIP-7702: delegate, revoke, batch, rescue, claim, approval manager, wizard deploy
- [ ] Security: mainnet warning, auto-lock, phishing detect, address poisoning detect
- [ ] Settings: custom RPC, currency, language, auto-lock
- [ ] Test node hijau + browser tanpa console error
- [ ] README lengkap

---

## CATATAN IMPLEMENTASI EIP-7702 (ringkas dari riset)

- Tx type 0x04 (set-code): `rlp([chain_id, nonce, max_priority_fee, max_fee, gas_limit, destination, value, data, access_list, authorization_list, y_parity, r, s])`
- `authorization_list = [[chain_id, address, nonce, y_parity, r, s], ...]`
- Delegation indicator: `0xef0100 || address` (23 byte) ditulis ke code EOA
- Revoke: authorization ke `0x0000...0000` → code di-clear
- chainId 0 = valid di semua chain (risiko replay — warning!)
- Self-sponsor: auth nonce = nonce + 1 (karena tx konsumsi nonce dulu)
- Gas per authorization: 25,000 (akun baru)
- Deteksi delegasi: `eth_getCode` → `0xef0100` prefix → `0x${code.slice(8)}` = delegate address
- ethers v6: `wallet.signAuthorization({chainId, address, nonce})` → `authorizationList` di tx
- RPC publik sering TIDAK support type-4 → rekomendasi Alchemy/QuickNode untuk mainnet