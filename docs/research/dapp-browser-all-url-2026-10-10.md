# dApp browser — "all URLs in-app, wallet on any web" riset

Tanggal: 2026-10-10. Konteks: permintaan user — buktikan native dApp browser membuka
SEMUA URL website **in-app** (bukan browser eksternal) dan connect wallet bekerja
di web apa pun, seperti MetaMask Mobile / wallet lain. Metode: audit kode internal +
standar EIP-1193 (https://eips.ethereum.org/EIPS/eip-1193, diambil 2026-10-10) +
perbandingan perilaku MetaMask. Semua klaim rantai-bukti file:baris.

## 1. Keputusan & hasil

| Klaim | Status | Bukti |
|---|---|---|
| Semua http/https kebuka in-app, tanpa allowlist | ✅ TERBUKTI | `open()` hanya tolak URL kosong, sisanya `loadUrl` di WebView sendiri (line 215-244 BearDappBrowserPlugin.java, diuji `open()` path) |
| Non-http(s) ditolak di gerbang native | ✅ DITAMBAH | guard scheme http/https di `open()` Java + mirror `openNativeDapp` JS (`js/native-dapp.js`), diuji E2E 4 bentuk berbahaya |
| Read-only RPC (balance/call/block) jalan seperti MetaMask | ✅ DITAMBAH | `NATIVE_READ_METHODS` forward ke ethers provider (`js/native-dapp.js`), deadline 20s, diuji fixture #2 + situs eksternal |
| Sign (personal_sign, typed data) jalan dengan modal wallet | ✅ TERBUKTI | `askUser()` + `confirmTx` (4 cabang), diuji E2E fixture #2 |
| Provider EIP-1193 lengkap | ✅ TERBUKTI | `request/on/removeListener/enable/send/sendAsync` + events + EIP-6963 (`js/native-provider.js`), unit-tested |
| Tidak ada lompatan ke browser eksternal di native | ✅ TERBUKTI by construction | native = WebView penuh; fallback eksternal hanya ada di web-mode iframe (`frameable:false`, `js/dapp-browser.js`) yang TIDAK dipakai native |

## 2. "Bisa diakses apa aja" — matrix URL (fakta kode)

| Bentuk URL | Perilaku native `open()` | Catatan |
|---|---|---|
| `https://…` | ✅ `loadUrl` in-app, provider diinjeksi 3× (start/commit/finish) | fixture #1/#2 + `https://example.com` live E2E |
| `http://…` | ✅ in-app (debug build: cleartext diizinkan) | produksi cleartext tetap diblokir (`src/debug/AndroidManifest.xml:21`) |
| `javascript:…` | ❌ DITOLAK (sebelumnya BUG: dieksekusi di view) | guard baru, diuji |
| `data:…` | ❌ DITOLAK (sebelumnya dimuat) | guard baru, diuji |
| `file:…` | ❌ DITOLAK | guard baru, diuji |
| `wc:…` | ❌ DITOLAK di native open (pairing via box WalletConnect di web-mode; native belum punya address bar) | diuji |
| URL kosong | ❌ `url required` | sudah sejak awal |

`in-app` = WebView milik app (package `com.nemoobc.beartool`), bukan intent browser
eksternal, bukan iframe. Tidak ada `Intent.ACTION_VIEW` di jalur open native
(verifikasi kode: satu-satunya `loadUrl`).

## 3. Connect wallet "di semua web" — surface RPC (perbandingan MetaMask)

MetaMask Mobile menginjeksi `InpageBridgeWeb3.js` ke dapp WebView dan menjawab:
eth_chainId, eth_accounts, eth_requestAccounts, personal_sign, eth_signTypedData_v4,
eth_sendTransaction, wallet_switchEthereumChain, plus READ methods diteruskan ke
node aktif. Bear Tool native sekarang paritas penuh pada set tersebut:

| Method | Bear Tool native | Modal | Catatan |
|---|---|---|---|
| `eth_chainId` / `net_version` | ✅ | — | jawab dari network wallet |
| `eth_accounts` | ✅ | — | kosong sampai origin di-approve (privacy) |
| `eth_requestAccounts` | ✅ | ✅ Connect? | session-level consent (per origin) |
| `personal_sign` | ✅ | ✅ Sign message? | chain mismatch tetap ditolak |
| `eth_signTypedData_v4` | ✅ | ✅ Sign typed data? | guard chain + EIP-712 signer |
| `eth_sendTransaction` | ✅ | ✅ Send transaction? | guard chain mismatch (tidak sign di chain beda) |
| `wallet_switchEthereumChain` | ✅ | — | jawab null bila sudah di chain itu, 4902 kalau beda |
| READ (eth_blockNumber, eth_getBalance, eth_call, eth_getTransactionReceipt, eth_getCode, eth_getLogs, dh.) | ✅ **baru** | — | forward ke ethers provider, deadline 20s, error node diteruskan |
| lain-lain | ❌ 4200 | — | jujur "not supported yet" |

Privasi/session: `connectedOrigins` per origin (full URL), revisi halaman tidak
re-prompt, tutup app = bersih (sama dengan MetaMask session semantics).

## 4. Provider EIP-1193 — compliance check (spec 2026-10-10)

| Requirement | Status |
|---|---|
| `request(args): Promise<unknown>` | ✅ `js/native-provider.js` |
| `on` / `removeListener` (EventEmitter-style) | ✅ + `off` |
| events: connect, disconnect, chainChanged, accountsChanged, message | ✅ (emit + handler `__bearNativeNotify`) |
| Error codes 4001 / 4100 / 4200 / 4900 / 4901 | ✅ 4001 (reject), 4200 (unsupported), 4900 (no provider), 4902 (EIP-3326), 4100 via empty-accounts |
| EIP-6963 announce | ✅ `eip6963:announceProvider` + `requestProvider` |
| Legacy `enable` (EIP-1102), `send`, `sendAsync` | ✅ kompat |
| `selectedAddress`, `chainId` properties | ✅ diperbarui saat request selesai |

Penyimpangan disengaja: `isMetaMask: false` — jangan berbohong soal siapa yang
menandatangani (dokumentasi in-code + test `native-dapp-proxy.test.js`).

## 5. Temuan bug yang diperbaiki dalam riset ini

1. **GAP keamanan**: `open()` menerima `javascript:`/`data:`/`file:` → `loadUrl`.
   Dampak: script execution di view / konten lokal tak ter-server.
   Fix: guard native + mirror JS + detektor + E2E 4 bentuk.
2. **GAP fungsional**: read RPC (`eth_getBalance` dsb.) semua 4200 → dapp nyata
   yang baca state lewat `window.ethereum` gagal (MetaMask meneruskan ke node).
   Fix: whitelist `NATIVE_READ_METHODS` forward + deadline + error propagate.

## 6. Yang BELUM dites (SELAIN) — jujur

- Dapp eksternal kompleks nyata (Uniswap/OpenSea ui) belum dijalankan E2E di
  emulator — yang dibuktikan: situs https eksternal nyata (example.com) + RPC
  live + semua fixture. Situs berat = risiko flake CI, bukan blokir fungsional.
- `eth_sendTransaction` onchain penuh (broadcast + receipt) = milestone M2 arc,
  belum E2E onchain (unit + modal sudah).
- `wallet_addEthereumChain` tidak diimplementasikan (menolak: tidak pernah
  menginstal rpcUrls dapp — kebijakan WalletConnect yang sama).
- Events chainChanged/accountsChanged **dari wallet ke halaman** lewat
  `__bearNativeNotify` ada mekanismenya, alur trigger penuh (ganti network saat
  dapp terbuka) belum diuji E2E.
- Browser UI (address bar, bookmark) masih toolbox 2 tombol (back/close) —
  open URL E2E via hook setara kartu katalog, bukan address bar.

## 7. Referensi

- EIP-1193 spec: https://eips.ethereum.org/EIPS/eip-1193 (diambil 2026-10-10)
- MetaMask Mobile: `InpageBridgeWeb3.js` + `BrowserTab.tsx` (kloning arsitektur,
  dikutip di header `js/native-provider.js` / `js/native-dapp.js`)
- MetaMask Connect (alternatif SDK): https://docs.metamask.io/wallet/concepts/dapp/