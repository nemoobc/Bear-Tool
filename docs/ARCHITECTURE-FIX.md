# Bear Tool — Architecture Fix (Total Overhaul)

> **Status**: DRAFT — menunggu approval DEV
> **Date**: 2026-09-16
> **Scope**: Bug fix + refactor modul + realisasi 7 fitur stub + keamanan + test plan
> **Constraint**: Vanilla JS ESM + ethers v6 CDN, NO framework, NO build step, GitHub Pages static

---

## DAFTAR MASALAH (audit lengkap dari kode)

### BUG KRITIS
| # | Masalah | Lokasi | Dampak |
|---|---------|--------|--------|
| B1 | `spinnerDots()` dipanggil di app.js:594 & 659 tapi TIDAK di-import dari ui.js | app.js baris 10 (import) | **ReferenceError** → swap & bridge langsung crash |
| B2 | `loadNfts()` hanya tampilkan native balance, bukan NFT sungguhan | app.js:441-453 | NFT gallery kosong/salah informasi |
| B3 | Harga USD = `null` di semua token (loadDashboard baris 399/408) | app.js:398-408 | Total balance selalu "$0.00" |
| B4 | `spinnerBear()` dipanggil di scanApprovals tapi baris 815 = OK (di-import) | app.js:815 | OK, tidak bug |
| B5 | `fmtUsd(null)` → "$0.00" tapi bukan error — cosmetic | ui.js:122-124 | Total balance tidak informatif |

### FITUR STUB (simulasi/toast-only)
| # | Fungsi | Baris | Status | yang seharusnya |
|---|--------|-------|--------|----------------|
| S1 | `doSwap()` | 638 | toast("requires relayer") | Quote → approve → execute via 0x API |
| S2 | `doBridge()` | 676 | toast("requires impl") | Quote → execute via LI.FI API |
| S3 | `executeBatch()` | 788 | toast("requires 7702 impl") | Atomic batch via EIP-7702 authorization |
| S4 | `doRescue()` | 797 | toast("see docs") | Deploy rescue contract + authorize + execute |
| S5 | `doClaim()` | 806 | toast("see docs") | Claim airdrop + forward atomically |
| S6 | `doDeploy()` | 923 | toast("needs templates") | Compile & deploy ERC-20/721/1155 bytecode |
| S7 | `loadNfts()` | 449 | menampilkan native balance | Enumerate on-chain NFT + fetch metadata |

### FITUR TIDAK AKTIF
| # | Masalah | Lokasi |
|---|---------|--------|
| F1 | `wallet.isSuspiciousSimilar()` ada tapi TIDAK dipakai di `doSend()` | app.js:512-563 |
| F2 | Settings `currency` tidak dipakai — `fmtUsd` selalu USD | ui.js:122-125 |
| F3 | Settings `lang` tidak dipakai — semua teks hardcoded English | index.html + app.js |
| F4 | Tidak ada gas estimator real — `doSend` pakai feeData mentah tanpa preview biaya | app.js:539-542 |
| F5 | Tidak ada double-submit protection — tombol bisa diklik berulang | semua do* functions |
| F6 | Tidak ada global error boundary — unhandled promise = silent fail | seluruh app |

---

## ALTERNATIF DESAIN

### A — Monolith Refactor (modul terpisah, shared state via module singleton)

**Deskripsi**: Refactor app.js jadi beberapa file modul (send.js, swap.js, bridge.js, dll). State tetap di app.js tapi diekspos via export. Setiap fitur = 1 file. Hapus semua stub, ganti dengan implementasi real.

**Pro**:
- Simple mental model — state central, logic terpisah
- Tidak perlu build step, langsung jalan di browser
- File size terkontrol (~100-200 baris per modul)
- Mudah debug karena setiap fitur isolasi file

**Kontra**:
- Import cycle risk (modul A impor modul B impor modul A)
- State management manual — harus hati-hati dengan referensi
- Setiap modul perlu akses state yang sama

**Risiko**: Import cycle bisa dicegah dengan dependency tree yang bersih (state di atas, features di bawah).

### B — Event Bus Architecture (state + event-driven dispatch)

**Deskripsi**: State terpusat, fitur berkomunikasi via CustomEvent/EventEmitter. Setiap fitur subscribe event dan emit hasil.

**Pro**:
- Loose coupling antar modul
- Extensible (tambah fitur = tambah listener)
- State changes bisa diobservasi

**Kontra**:
- Over-engineered untuk vanilla JS tanpa framework
- Debugging sulit (event flow tidak visible)
- Lebih banyak boilerplate
- Tidak ada framework event typing

**Risiko**: Complexity tidak sepadan dengan value untuk project seukuran ini.

---

## PILIHAN: A — Monolith Refactor

**Alasan**: Project ini vanilla JS tanpa build step. State central dengan modul terpisah adalah pendekatan paling pragmatis. Event bus over-engineered untuk wallet client-side. Yang dibutuhkan = kode yang jelas per fitur, bukan abstraksi arsitektural.

---

## DESAIN LENGKAP

### 1. ARSITEKTUR MODUL — Struktur File Baru

```
Bear-Tool/
├── index.html                    # UI stays (add data-i18n attrs)
├── css/cartoon.css               # + skeleton loading CSS + animated counter CSS
├── js/
│   ├── app.js                    # REFACTORED: state + router + boot (ONLY orchestrator)
│   ├── state.js                  # NEW: centralized state + pub/sub event emitter
│   ├── ui.js                     # EXPANDED: +spinnerDots export (already there, fix import)
│   ├── wallet.js                 # UNCHANGED (solid)
│   ├── network.js                # UNCHANGED (solid)
│   ├── theme.js                  # UNCHANGED (solid)
│   ├── send.js                   # NEW: extract from app.js, +gas estimator, +poisoning warning
│   ├── swap.js                   # NEW: extract + real 0x API integration
│   ├── bridge.js                 # NEW: extract + real LI.FI integration
│   ├── eip7702.js                # NEW: extract + batch/rescue/claim real implementations
│   ├── deploy.js                 # NEW: extract + minimal bytecode templates
│   ├── nft.js                    # NEW: on-chain ERC-721 enumeration + metadata fetch
│   ├── price.js                  # NEW: CoinGecko/DexScreener price polling + cache
│   ├── i18n.js                   # NEW: EN/ID translations + t() helper
│   └── safetx.js                 # NEW: double-submit guard + error boundary + gas preview
├── contracts/
│   ├── BatchExecutor.sol         # NEW: minimal EIP-7702 batch contract source
│   ├── RescueContract.sol        # NEW: minimal rescue contract source
│   └── README.md                 # NEW: contract audit + deployment notes
├── tests/
│   ├── wallet.test.js            # EXISTING (keep)
│   ├── network.test.js           # EXISTING (keep)
│   ├── price.test.js             # NEW: price service unit tests
│   ├── i18n.test.js              # NEW: i18n unit tests
│   ├── send.test.js              # NEW: address validation + poisoning detection tests
│   └── e2e-checklist.md          # NEW: manual browser test checklist
└── docs/
    ├── PROMPT.md                 # EXISTING (keep)
    └── ARCHITECTURE-FIX.md       # THIS FILE
```

### 2. STATE MANAGEMENT — `js/state.js`

```js
// Singleton state + simple pub/sub
const state = { /* same shape as current app.js state */ };
const listeners = new Map();

export function get(key) { return key ? state[key] : { ...state }; }
export function set(key, value) {
  state[key] = value;
  (listeners.get(key) || []).forEach(fn => fn(value, key));
}
export function on(key, fn) {
  if (!listeners.has(key)) listeners.set(key, []);
  listeners.get(key).push(fn);
}
export function off(key, fn) {
  const arr = listeners.get(key);
  if (arr) listeners.set(key, arr.filter(f => f !== fn));
}
```

**Key/Value pairs**:
- `unlocked` → boolean
- `signer` → ethers.Wallet
- `address` → string
- `networkId` → string
- `provider` → ethers.JsonRpcProvider
- `tokens` → Token[]
- `activity` → Activity[]
- `settings` → { currency, lang, autoLock, rpc }
- `swapQuote` → object | null
- `bridgeQuote` → object | null
- `batch` → BatchItem[]
- `approvals` → Approval[]
- `pendingTx` → Set<string> (double-submit guard)

**Why**: Separates concern state dari logic. Setiap modul impor state.js, bukan import state dari app.js. Eliminates circular dependency risk.

### 3. FITUR REAL — Implementasi per Modul

#### 3.1 `js/price.js` — Harga USD (P0)

**Sumber**: CoinGecko free API (`/api/v3/simple/price`) + fallback DexScreener (`/tokens/v1/...`).

**Alur**:
```
loadDashboard() → fetchAllPrices(tokenAddresses) → update state.tokens[].usd
                  ↓ (try CoinGecko first)
                  ↓ (on failure → try DexScreener)
                  ↓ (on failure → usd = null, render "—")
```

**CoinGecko mapping** (chain → CoinGecko platform):
| chainId | platform_id |
|---------|-------------|
| 1 | ethereum |
| 56 | binance-smart-chain |
| 137 | polygon_pos |
| 42161 | arbitrum-one |
| 10 | optimistic-ethereum |
| 8453 | base |

**DexScreener fallback** (per-token): `https://api.dexscreener.com/tokens/v1/{chainId}/{tokenAddress}`

**Caching**:
- In-memory: price cache Map<address, { price, ts }>
- TTL: 60 seconds
- localStorage: `bear.priceCache` (survive page reload, 5-min max age)

**Error handling**:
- CoinGecko rate limit (429) → backoff 10s → try DexScreener
- Network error → cache hit? use cache : usd = null
- Partial failure → show known prices, unknown = "—"

**API contract**:
```js
// Export
export async function fetchAllPrices(tokens, networkChainId, coinGeckoPlatform)
// tokens: [{address, symbol, decimals}]
// Returns: Map<address, number|null> (usd price per token)

export function getPriceFromCache(address)
// Returns: number|null (from cache, null if expired)

export function clearPriceCache()
```

**CoinGecko free tier limits**: 10-30 calls/min. Strategy:
1. Batch ETH + all known ERC-20 per chain in one call (using `vs_currencies=usd`)
2. Known native coins: `ethereum, binancecoin, polygon-ecosystem-token` — hardcoded symbol→id map
3. Known ERC-20: CoinGecko ID list in POPULAR_TOKENS (extend token data with `coingeckoId`)

#### 3.2 `js/swap.js` — Swap Real (P0)

**API**: 0x Swap API v2 (`https://swap.okx.com/api/v5/dex/swap/approve-transaction`)

**Catatan penting**: 0x API v1 (`api.0x.org`) requires API key since 2023. Two paths:
1. **OKX DEX API** (no key needed for quotes, rate-limited)
2. **0x with user-provided key** (settings input field)
3. **Simulated fallback** (clearly labeled)

**Alur Swap**:
```
User inputs amount → getSwapQuote()
  → Check: is native→ERC20 or ERC20→native or ERC20→ERC20?
  → Call quote API
  → Display: rate, price impact, estimated gas (in USD), minimum received
  → User clicks "Swap"
  → doSwap():
     1. If source is ERC20: check allowance
     2. If allowance < sellAmount: do approve tx first → wait → then swap
     3. Execute swap transaction
     4. Wait for receipt → update activity
```

**API calls**:
- Quote: `GET /swap/v1/quote?buyToken={}&sellToken={}&sellAmount={}&chainId={}`
- Approve: `GET /swap/v1/allowance?token={}&chainId={}` (check)
- Swap: `POST /swap/v1/swap` → returns `{ to, data, value }` → sendTransaction

**Fallback strategy**:
- If 0x API fails → try OKX DEX API → if all fail → show simulated quote with **clear red banner**: "⚠️ SIMULATED — No real swap will happen. Connect an API key in Settings for live quotes."

**Export**:
```js
export async function getSwapQuote(fromToken, toToken, amount, chainId)
// Returns: { rate, buyAmount, gasEstimateUsd, priceImpact, source, provider }
// source: '0x' | 'simulated'

export async function executeSwap(state, quote)
// Returns: { txHash, status }
```

#### 3.3 `js/bridge.js` — Bridge Real (P0)

**API**: LI.FI API (`https://li.quest/v1/`)

**LI.FI free tier**: No API key required for basic quotes, rate-limited.

**Alur Bridge**:
```
User selects fromChain → toChain → token → amount
  → getBridgeRoute()
  → LI.FI /quote endpoint
  → Display: route steps, estimated time, fee, gas
  → User clicks "Bridge"
  → executeBridge():
     1. If LI.FI returns transaction request → sendTransaction
     2. If simulated → show warning
```

**API calls**:
- Quote: `GET /v1/quote?fromChain={}&toChain={}&fromToken={}&toToken={}&fromAmount={}`
- Routes: `GET /v1/quote?...&sort=fastest`

**Fallback**: If LI.FI fails → simulated route with red banner.

**Export**:
```js
export async function getBridgeRoute(fromChainId, toChainId, token, amount)
// Returns: { routes[], source }

export async function executeBridge(state, route)
// Returns: { txHash, status }
```

#### 3.4 `js/nft.js` — NFT Enumeration Real (P1)

**Approach**: On-chain enumeration via ERC-721 Enumerable + metadata from tokenURI.

**Alur**:
```
loadNfts() →
  1. Scan POPULAR_NFT_CONTRACTS[chainId] (curated list, ~5-10 per chain)
  2. For each contract: call balanceOf(address)
  3. If balance > 0: call tokenOfOwnerByIndex for each
  4. Fetch tokenURI → IPFS/arweave gateway → parse metadata JSON
  5. Display: image (with fallback placeholder) + name
  6. Timeout per NFT: 5s → skip if too slow
```

**Known NFT contracts per chain**:
| chainId | contracts |
|---------|-----------|
| 1 | OpenSea Collections (top 10) |
| 8453 | Zora, Base Nouns |

**Caveat**: Without an indexer (Alchemy/QuickNode NFT API), we can only scan known contracts. Unknown NFTs won't appear. **UI must state this limitation clearly**.

**Fallback**: If RPC doesn't support `tokenOfOwnerByIndex` → show message: "Connect Alchemy/QuickNode for full NFT enumeration."

**Export**:
```js
export async function enumerateNfts(address, chainId, provider)
// Returns: NftItem[] { contractAddress, tokenId, name, image, collection }

export const POPULAR_NFT_CONTRACTS = { /* per chain */ }
```

#### 3.5 `js/eip7702.js` — Batch / Rescue / Claim (P1-P2)

**Kenyataan pahit**: EIP-7702 batch/rescue/claim membutuhkan **implementation contract** yang sudah di-deploy. Tanpa contract → tidak bisa execute.

**Strategi yang JUJUR**:

**A. Batch Call (P1)**:
- Require: user punya alamat implementation contract (atau deploy sendiri)
- UI: input field "Implementation contract address" (selain delegate address)
- Flow:
  1. Encode batch calls: `abi.encodePacked(calls)` → `executeBatch(address[] targets, bytes[] data, uint256[] values)`
  2. User sign EIP-7702 authorization → implementation contract
  3. Send tx with `authorizationList` + batch calldata
- **Fallback**: If no implementation → show clear info box: "Batch requires a 7702-compatible implementation contract. Deploy one or use an existing one."
- **Contract**: Minimal `BatchExecutor.sol` (delegatecall to targets in single tx) — source provided in `contracts/`

**B. Rescue Atomic (P2)**:
- Requires: target signs EIP-7702 authorization to rescue contract
- Flow: deploy rescue contract once → target sign auth → execute
- **Fallback**: "Rescue requires target wallet cooperation + 7702-compatible rescue contract."
- **Contract**: `RescueContract.sol` (pulls ETH/ERC20/ERC721 to safe address)

**C. Claim Airdrop (P2)**:
- Similar pattern: sign authorization → claim token → forward to safe
- **Fallback**: "Claim requires 7702 implementation. Not available without on-chain contract."

**D. Delegate/Revoke (P0 — already real!)**:
- Current `doEip7702('delegate')` and `doEip7702('revoke')` at app.js:701-746 are **already implemented correctly** — they use `signAuthorization` + `sendTransaction` with `authorizationList`.
- No changes needed except extracting to `js/eip7702.js`.

**Contract templates** (in `contracts/`):

```solidity
// BatchExecutor.sol — minimal EIP-7702 batch implementation
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract BatchExecutor {
    struct Call {
        address target;
        bytes data;
        uint256 value;
    }

    function executeBatch(Call[] calldata calls) external payable returns (bytes[] memory) {
        bytes[] memory results = new bytes[](calls.length);
        for (uint256 i = 0; i < calls.length; i++) {
            (bool ok, bytes memory result) = calls[i].target.call{value: calls[i].value}(calls[i].data);
            require(ok, "call failed");
            results[i] = result;
        }
        return results;
    }

    // Fallback: accept ETH
    receive() external payable {}
}

// RescueContract.sol — atomic rescue via EIP-7702
contract RescueContract {
    function rescueETH(address safe) external payable {
        payable(safe).transfer(msg.value);
    }

    function rescueERC20(address token, address safe, uint256 amount) external {
        require(IERC20(token).transfer(safe, amount), "transfer failed");
    }

    function rescueERC721(address token, address safe, uint256 tokenId) external {
        require(IERC720(token).safeTransferFrom(address(this), safe, tokenId), "transfer failed");
    }

    receive() external payable {}
}
```

#### 3.6 `js/deploy.js` — Deploy Wizard Real (P1)

**Strategi**: Embedded minimal Solidity bytecode templates.

**Approach**: Compile-time hardcoded bytecode (pre-compiled Solidity → raw hex) for:
- ERC-20 (minimal: name, symbol, decimals, totalSupply, mint to deployer)
- ERC-721 (minimal: name, symbol, baseURI, safeMint to deployer)
- ERC-1155 (minimal: name, baseURI, mint to deployer)

**How**: Use Solidity compiler to produce bytecode → embed as hex strings in JS. User fills name/symbol → constructor args encoded → prepend to bytecode → deployTransaction.

**Constructor encoding**:
- ERC-20: `abi.encode(name, symbol, decimals, totalSupply)`
- ERC-721: `abi.encode(name, symbol, baseURI)`
- ERC-1155: `abi.encode(name, baseURI)`

**Fallback (saat bytecode belum ready)**: Show modal with Remix link: "Open in Remix → compile → deploy manually. Or use the contract templates in contracts/ directory."

**Export**:
```js
export const BYTECODE = {
  erc20: '0x6080604052...',  // minimal ERC-20
  erc721: '0x6080604052...', // minimal ERC-721
  erc1155: '0x6080604052...' // minimal ERC-1155
};

export function buildDeployTx(standard, { name, symbol, decimals, supply, baseUri })
// Returns: { data, value: 0 }
```

**Requirement**: Compile contracts once → extract bytecode → embed. A build script `scripts/compile-bytecode.js` (Node.js) will:
1. Compile Solidity with solcjs
2. Extract creation bytecode
3. Write to `js/bytecodes.js`

**Timeline**: P1 — requires running solcjs compilation once.

#### 3.7 Address Poisoning Warning (P0)

**Di `send.js` → `doSend()`**:

```js
import { isSuspiciousSimilar } from './wallet.js';

// Inside doSend, after address validation:
for (const prev of state.activity) {
  if (prev.type === 'send' && isSuspiciousSimilar(prev.detail.to, to)) {
    const ok = await confirmTx({
      title: '⚠️ ADDRESS POISONING WARNING!',
      rows: [
        { k: 'Warning', v: 'This address looks similar to a previous recipient. This is a common scam.' },
        { k: 'Target', v: wallet.shortAddress(to) },
        { k: 'Similar to', v: wallet.shortAddress(prev.detail.to) }
      ],
      confirmText: 'I understand the risk',
      danger: true, requireType: 'UNDERSTAND'
    });
    if (!ok) return;
  }
}
```

**Enhancement**: Extend `isSuspiciousSimilar` to also check against **known phishing addresses** (hardcoded list of ~20 common scam addresses).

#### 3.8 Gas Estimator + Fee Breakdown (P0)

**Di `send.js` → `updateSendPreview()`**:

```js
// After address validation, before rendering preview:
const provider = state.provider;
const feeData = await provider.getFeeData();
const gasLimit = tokenSel === 'native'
  ? 21000n
  : await estimateERC20TransferGas(token, to, amount);

const baseFee = feeData.gasPrice;
const priorityFee = feeData.maxPriorityFeePerGas || 2n * 1000000000n; // 2 gwei default

// Gas multiplier per speed
const multiplier = { slow: 0.9, normal: 1.0, fast: 1.2, auto: 1.0 }[gasSpeed];
const effectiveGasPrice = baseFee * multiplier + priorityFee;

const gasCostWei = gasLimit * effectiveGasPrice;
const gasCostEth = ethers.formatEther(gasCostWei);
const gasCostUsd = gasCostEth * (state.tokens[0]?.usd || 0);

// Render in sendPreview:
// "Gas: ~0.003 ETH ($5.42) · Total: 0.1 ETH + 0.003 ETH"
```

**Export**:
```js
export async function estimateGasDetailed(provider, from, to, value, data, gasSpeed)
// Returns: { gasLimit, gasPrice, gasCostWei, gasCostEth, gasCostUsd, breakdown }

export function renderGasPreview(gas, amount, tokenSymbol, nativeSymbol)
// Returns: HTML string for sendPreview
```

#### 3.9 `js/i18n.js` — Internationalization (P1)

**Approach**: Key-based translations, `data-i18n` attributes on HTML elements.

**Structure**:
```js
const TRANSLATIONS = {
  en: {
    'dashboard.title': 'Dashboard',
    'dashboard.total': 'Total Balance',
    'dashboard.no_assets': 'Connect or create a wallet to see your assets.',
    'send.title': 'Send',
    'send.to': 'To address',
    'send.amount': 'Amount',
    'send.confirm': 'Send',
    'send.max': 'MAX',
    'send.gas': 'Gas speed',
    'send.preview': 'Sending {{amount}} to {{address}}',
    'send.invalid_addr': 'Invalid destination address',
    'send.poisoning_warn': 'Address Poisoning Warning',
    'send.mainnet_confirm': 'MAINNET TRANSACTION!',
    'swap.title': 'Swap',
    'swap.get_quote': 'Get Quote',
    'swap.simulated': '⚠️ SIMULATED — No real swap will happen.',
    'bridge.title': 'Bridge',
    'bridge.get_route': 'Get Route',
    'bridge.simulated': '⚠️ SIMULATED route.',
    'eip7702.title': 'EIP-7702 — Smart EOA',
    'eip7702.delegate': 'Delegate',
    'eip7702.revoke': 'Revoke',
    'eip7702.batch': 'Batch Call (atomic)',
    'eip7702.rescue': 'Rescue Atomic',
    'eip7702.claim': 'Claim Airdrop',
    'deploy.title': 'Wizard Deploy',
    'deploy.deploy': 'Deploy Contract',
    'approval.title': 'Approval Manager',
    'approval.scan': 'Scan Approvals',
    'settings.title': 'Settings',
    'settings.currency': 'Currency',
    'settings.language': 'Language',
    'settings.auto_lock': 'Auto-lock (minutes)',
    'settings.save': 'Save Settings',
    'settings.clear': 'Clear all data',
    'common.loading': 'Loading...',
    'common.error': 'Error: {{message}}',
    'common.confirm': 'Confirm',
    'common.cancel': 'Cancel',
    'welcome.title': 'Welcome to Bear Tool! 🍯',
    'welcome.desc': 'Self-custody wallet. Your keys never leave this browser.',
    'welcome.create': '🐻 Create Wallet',
    'welcome.import': '📥 Import',
    'unlock.title': 'Welcome back! 🐻',
    'unlock.button': 'Unlock',
    'locked.title': 'Auto-locked 🔒',
    'locked.msg': 'Auto-locked after {{minutes}} minutes of inactivity',
    // ... ~80 more keys
  },
  id: {
    'dashboard.title': 'Dasbor',
    'dashboard.total': 'Saldo Total',
    'dashboard.no_assets': 'Hubungkan atau buat dompet untuk melihat aset.',
    'send.title': 'Kirim',
    'send.to': 'Alamat tujuan',
    'send.amount': 'Jumlah',
    'send.confirm': 'Kirim',
    'send.max': 'MAKS',
    'send.gas': 'Kecepatan gas',
    'send.preview': 'Mengirim {{amount}} ke {{address}}',
    'send.invalid_addr': 'Alamat tujuan tidak valid',
    'send.poisoning_warn': 'Peringatan Address Poisoning',
    'send.mainnet_confirm': 'TRANSAKSI MAINNET!',
    'swap.title': 'Tukar',
    'swap.get_quote': 'Dapatkan Kutipan',
    'swap.simulated': '⚠️ SIMULASI — Tukar nyata tidak akan terjadi.',
    'bridge.title': 'Bridge',
    'bridge.get_route': 'Dapatkan Rute',
    'bridge.simulated': '⚠️ Rute SIMULASI.',
    'eip7702.title': 'EIP-7702 — EOA Cerdas',
    'eip7702.delegate': 'Delegasi',
    'eip7702.revoke': 'Cabut',
    'eip7702.batch': 'Panggilan Batch (atomik)',
    'eip7702.rescue': 'Selamatkan Atomik',
    'eip7702.claim': 'Klaim Airdrop',
    'deploy.title': 'Wizard Deploy',
    'deploy.deploy': 'Deploy Kontrak',
    'approval.title': 'Manajer Persetujuan',
    'approval.scan': 'Pindai Persetujuan',
    'settings.title': 'Pengaturan',
    'settings.currency': 'Mata Uang',
    'settings.language': 'Bahasa',
    'settings.auto_lock': 'Kunci otomatis (menit)',
    'settings.save': 'Simpan Pengaturan',
    'settings.clear': 'Hapus semua data',
    'common.loading': 'Memuat...',
    'common.error': 'Kesalahan: {{message}}',
    'common.confirm': 'Konfirmasi',
    'common.cancel': 'Batal',
    'welcome.title': 'Selamat Datang di Bear Tool! 🍯',
    'welcome.desc': 'Dompet self-custody. Kunci Anda tidak pernah keluar dari browser ini.',
    'welcome.create': '🐻 Buat Dompet',
    'welcome.import': '📥 Impor',
    'unlock.title': 'Selamat Datang Kembali! 🐻',
    'unlock.button': 'Buka Kunci',
    'locked.title': 'Terkunci otomatis 🔒',
    'locked.msg': 'Terkunci otomatis setelah {{minutes}} menit tidak aktif',
  }
};
```

**API**:
```js
export function t(key, params = {})
// Returns: translated string, interpolates {{param}} from params

export function setLang(lang)
// Updates lang, re-renders all [data-i18n] elements

export function getLang()
// Returns current lang from settings

export function applyTranslations()
// Scans all [data-i18n] elements, sets textContent = t(key)
```

**HTML changes** (index.html):
```html
<!-- Before -->
<div class="card-title">🐻 My Assets</div>
<!-- After -->
<div class="card-title" data-i18n="dashboard.assets">🐻 My Assets</div>
```

**Dynamic content** (app.js render functions):
```js
// Instead of hardcoded strings:
$('#totalBalance').textContent = fmtUsd(totalUsd);
// Use:
$('#balanceSub').textContent = t('dashboard.network_info', { network: net.name, address: wallet.shortAddress(state.address) });
```

#### 3.10 Animated Balance Counter + Skeleton Loading (P2)

**Balance Counter** (`js/ui.js` expansion):
```js
export function animateValue(element, from, to, duration = 800) {
  const start = performance.now();
  const update = (now) => {
    const progress = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic
    const current = from + (to - from) * eased;
    element.textContent = fmtUsd(current);
    if (progress < 1) requestAnimationFrame(update);
  };
  requestAnimationFrame(update);
}
```

**Skeleton Loading** (CSS + JS):
```css
/* Add to cartoon.css */
.skeleton {
  background: linear-gradient(90deg, var(--cream) 25%, var(--honey)40 50%, var(--cream) 75%);
  background-size: 200% 100%;
  animation: skeleton-shimmer 1.5s infinite;
  border-radius: 8px;
  border: 2px solid var(--ink);
}
@keyframes skeleton-shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
.skeleton-line { height: 16px; margin-bottom: 8px; }
.skeleton-circle { width: 40px; height: 40px; border-radius: 50%; }
.skeleton-hero { height: 60px; width: 200px; margin: 0 auto; }
```

```js
// js/ui.js
export function skeletonAsset(count = 3) {
  return Array(count).fill(`
    <div class="asset-row">
      <div class="skeleton skeleton-circle"></div>
      <div class="asset-info">
        <div class="skeleton skeleton-line" style="width:60%"></div>
        <div class="skeleton skeleton-line" style="width:40%"></div>
      </div>
      <div class="asset-balance">
        <div class="skeleton skeleton-line" style="width:80px"></div>
        <div class="skeleton skeleton-line" style="width:60px"></div>
      </div>
    </div>
  `).join('');
}
```

### 4. KEAMANAN — Review & Enhancements

#### 4.1 Key Handling (SUDAH BAIK — Pertahankan)
- PBKDF2 310k iterations + AES-GCM 256-bit ✓
- Key derived per-decrypt (tidak cached di memori) ✓
- Random salt + IV per encryption ✓
- No key logging to console ✓

**Enhancement**: Tambah password strength indicator saat create wallet:
```js
function passwordStrength(pw) {
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score++;
  if (/[0-9]/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  return score; // 0-5 → very weak to strong
}
```

#### 4.2 EIP-7702 Risk Mitigation
- **Chain ID validation**: Warn when chainId = 0 (all-chain replay)
- **Implementation verification**: Before delegate, fetch code at implementation address, verify it starts with `0xef0100` prefix or is a known contract
- **Revocation reminder**: Show "Last delegated X days ago" with revoke button prominent
- **Trusted implementations list**: Hardcoded list of known-audited implementations (empty for now, user must input manually)
- **Mainnet guard**: Already exists (confirmTx with "DELEGATE" type-to-confirm) ✓

#### 4.3 Mainnet Guard Enhancement
Current: Only doSend and doEip7702 have mainnet confirmation.
**Fix**: Add mainnet confirmation to **all** financial operations:
- doSwap ✓ (already has)
- doBridge (add)
- executeBatch ✓ (already has)
- doDeploy ✓ (already has)
- doRescue (add)
- doClaim (add)

#### 4.4 Anti-Phishing
```js
const PHISHING_DOMAINS = [
  'metamask.io', // legitimate but often spoofed → check for subdomains
  // Add known phishing domains
];

function checkPhishing(url) {
  try {
    const u = new URL(url);
    // Flag if contains wallet names as subdomain
    if (/metamask|metamaks|metmask/i.test(u.hostname) && u.hostname !== 'metamask.io') return true;
    // Flag common patterns
    if (/[0-9]{4,}/.test(u.hostname) && u.protocol === 'http:') return true;
  } catch {}
  return false;
}
```

#### 4.5 Double-Submit Protection
```js
// In safetx.js
const pendingTxs = new Set();

export async function safeSend(key, fn) {
  if (pendingTxs.has(key)) {
    toast('Transaction already in progress...', 'info');
    return null;
  }
  pendingTxs.add(key);
  try {
    return await fn();
  } finally {
    pendingTxs.delete(key);
  }
}

// Usage:
$('#btnSend').addEventListener('click', () => safeSend('send', doSend));
$('#btnSwap').addEventListener('click', () => safeSend('swap', doSwap));
```

#### 4.6 Error Boundary
```js
// In safetx.js
export function withErrorBoundary(fn, context = 'operation') {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      console.error(`[BearTool] ${context} failed:`, e);
      toast(`${context} failed: ${e.message}`, 'error');
      // Log to activity for debugging
      addActivity({
        hash: 'error-' + Date.now(),
        type: 'error',
        status: 'failed',
        ts: Date.now(),
        detail: `${context}: ${e.message}`
      });
      return null;
    }
  };
}

// Usage:
const doSendSafe = withErrorBoundary(doSend, 'Send');
```

### 5. CSS ADDITIONS — `css/cartoon.css` Additions

```css
/* ── Skeleton Loading ── */
.skeleton {
  background: linear-gradient(90deg, var(--cream) 25%, rgba(255,201,60,0.15) 50%, var(--cream) 75%);
  background-size: 200% 100%;
  animation: skeleton-shimmer 1.5s infinite;
  border-radius: 8px;
  border: 2px solid var(--ink);
}
@keyframes skeleton-shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
.skeleton-line { height: 16px; margin-bottom: 8px; }
.skeleton-circle { width: 40px; height: 40px; border-radius: 50%; }
.skeleton-hero { height: 60px; width: 200px; margin: 0 auto; border-radius: 12px; }

/* ── Gas Preview ── */
.gas-preview {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px;
  padding: 10px;
  background: var(--cream);
  border: 2px solid var(--ink);
  border-radius: 10px;
  font-size: 0.85rem;
  margin: 8px 0;
}
.gas-preview .k { opacity: 0.6; }
.gas-preview .v { font-weight: 600; text-align: right; }

/* ── Poisoning Warning ── */
.poisoning-warning {
  background: #FFE3E3;
  border: var(--border);
  border-left: 8px solid var(--berry);
  border-radius: 12px;
  padding: 14px;
  margin: 12px 0;
  animation: warning-pulse 2s infinite;
}
@keyframes warning-pulse {
  0%, 100% { border-left-color: var(--berry); }
  50% { border-left-color: var(--orange); }
}

/* ── Simulated Banner ── */
.simulated-banner {
  background: var(--berry);
  color: var(--white);
  padding: 8px 14px;
  border-radius: 8px;
  font-size: 0.8rem;
  font-weight: 700;
  text-align: center;
  border: 2px solid var(--ink);
}

/* ── Balance Counter ── */
.balance-hero .total {
  font-size: 2.4rem;
  font-weight: 700;
  transition: color 0.3s;
}
.balance-hero .total.loading {
  color: transparent;
  background: linear-gradient(90deg, var(--ink) 25%, var(--orange) 50%, var(--ink) 75%);
  background-size: 200% 100%;
  animation: skeleton-shimmer 1.5s infinite;
  -webkit-background-clip: text;
}

/* ── Password Strength ── */
.pw-strength {
  height: 4px;
  border-radius: 2px;
  margin-top: 4px;
  transition: width 0.3s, background 0.3s;
}
.pw-strength.weak { width: 20%; background: var(--berry); }
.pw-strength.fair { width: 40%; background: var(--orange); }
.pw-strength.good { width: 60%; background: var(--honey); }
.pw-strength.strong { width: 80%; background: var(--mint); }
.pw-strength.excellent { width: 100%; background: var(--sky); }
```

### 6. API/SERVICE INTEGRATION SUMMARY

| Service | URL | Auth | Rate Limit | Fallback |
|---------|-----|------|------------|----------|
| CoinGecko | `api.coingecko.com/api/v3/simple/price` | None | ~30/min | DexScreener |
| DexScreener | `api.dexscreener.com/tokens/v1/{chain}/{addr}` | None | Unknown | null |
| 0x Swap | `api.0x.org/swap/v1/quote` | API key (optional) | Unknown | Simulated |
| OKX DEX | `www.okx.com/api/v5/dex/swap/approve-transaction` | None | Unknown | Simulated |
| LI.FI | `li.quest/v1/quote` | None | Unknown | Simulated |
| RPC providers | Per network (llamarpc, ankr, cloudflare) | None | Varies | Fallback RPC |

**All external calls wrapped in**:
```js
async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error('Request timed out');
    throw e;
  }
}
```

### 7. TEST PLAN

#### 7.1 Unit Tests (node:test — bisa jalan di Termux)

**Existing (keep)**:
- `tests/wallet.test.js` — 10 tests ✓
- `tests/network.test.js` — 10 tests ✓

**New tests**:

**`tests/price.test.js`** (~6 tests):
- `fetchAllPrices: returns price map for known tokens`
- `fetchAllPrices: handles CoinGecko failure, tries DexScreener`
- `fetchAllPrices: returns null prices when all APIs fail`
- `getPriceFromCache: returns cached price within TTL`
- `getPriceFromCache: returns null after TTL expiry`
- `clearPriceCache: empties the cache`

**`tests/i18n.test.js`** (~5 tests):
- `t(): returns English string for known key`
- `t(): interpolates {{param}} placeholders`
- `t(): returns key itself when translation missing`
- `setLang/getLang: roundtrip`
- `t(): returns Indonesian string when lang=id`

**`tests/send.test.js`** (~5 tests):
- `isSuspiciousSimilar: catches poisoning (from wallet.js, re-export test)`
- `estimateGasDetailed: returns valid gas estimate for native send`
- `safeSend: prevents double-submit`
- `withErrorBoundary: catches and logs errors`
- `passwordStrength: scores correctly`

**`tests/swap.test.js`** (~3 tests):
- `getSwapQuote: returns simulated quote when API unavailable`
- `buildSwapCalldata: encodes approve + swap correctly`
- `validateSwapParams: rejects zero amounts`

Total new: ~19 tests. Grand total: ~39 tests.

**Run**: `npm test` (node --test tests/*.test.js)

#### 7.2 E2E Browser Checklist (`tests/e2e-checklist.md`)

Manual checklist (karena tidak ada Playwright di Termux tanpa display):

```
WALLET:
□ Create wallet → see 12 words → confirm word #1 → dashboard loads
□ Import wallet (private key) → correct address shown
□ Import wallet (seed phrase) → correct address shown
□ Switch account → new address in topbar
□ Export secret → shows private key
□ Auto-lock after 5 min → unlock modal appears
□ Lock button → locked immediately

NETWORK:
□ Switch to Sepolia → testnet badge shown
□ Switch to Ethereum mainnet → mainnet badge shown
□ Add custom network → appears in list
□ Remove custom network → disappears

DASHBOARD:
□ Native balance loads (ETH on Sepolia)
□ Token balances load (USDC on Sepolia)
□ USD prices load (or "—" shown if API fails)
□ NFT section shows (or limitation message)
□ Balance animates on load

SEND:
□ Invalid address → error toast
□ Gas preview shows before sending
□ Gas speed selector changes preview
□ MAX button fills full balance
□ Address poisoning warning for similar addresses
□ Mainnet confirmation for mainnet send
□ Transaction appears in activity

SWAP:
□ Loading spinner shown while fetching quote
□ Quote displays rate + gas estimate
□ Simulated quote clearly labeled
□ Flip button swaps tokens
□ Slippage selector works

BRIDGE:
□ Loading spinner shown while fetching route
□ Route displays steps + time + fee
□ Simulated route clearly labeled
□ Chain selectors work

EIP-7702:
□ Delegate on testnet works (requires Alchemy/QuickNode)
□ Delegate shows implementation in status
□ Revoke clears delegation
□ Batch: add/remove actions works
□ Batch: execute shows "needs implementation" (honest)
□ Rescue: shows "needs contract" (honest)
□ Claim: shows "needs implementation" (honest)

APPROVAL:
□ Scan approvals on Ethereum (popular tokens)
□ Shows unlimited approvals with warning badge
□ Revoke button works
□ Custom token input toggle works

DEPLOY:
□ Standard selector changes extra fields
□ Deploy on testnet sends transaction (or shows contract template info)

ACTIVITY:
□ Transactions appear after send/swap/delegate
□ Status updates from pending → success/failed
□ Explorer link works

SETTINGS:
□ Currency selector saves
□ Language selector saves (after i18n implemented)
□ Auto-lock value saves
□ Custom RPC adds to network
□ Clear data → confirm "HAPUS" → wallet deleted

GENERAL:
□ No console errors on any view
□ Mobile responsive (sidebar collapses)
□ Intro animation 5 seconds + skippable
□ Toast notifications appear for errors/success
□ Modal open/close works
```

### 8. EDGE CASES & ERROR HANDLING

| Edge Case | Where | Handling |
|-----------|-------|----------|
| RPC timeout/failure | All network calls | `getProvider` tries RPCs in order (already exists). Add retry with exponential backoff (3 attempts, 1s/2s/4s) |
| CoinGecko rate limit | price.js | Backoff 10s → try DexScreener → cache fallback |
| 0x API requires key | swap.js | Detect 401/403 → show "API key required" message → offer simulated mode |
| LI.FI unavailable | bridge.js | Fallback to simulated with clear banner |
| NFT tokenURI 404 | nft.js | Show placeholder image + "Metadata unavailable" |
| EIP-7702 RPC unsupported | eip7702.js | Detect via `eth_sendTransaction` error → "RPC does not support type-4 transactions" |
| Gas estimation fails | send.js | Use 21000 (native) or 65000 (ERC-20) as fallback gas limit |
| User clicks Send twice | safetx.js | Double-submit guard blocks second click |
| Password wrong (3+ times) | app.js | After 3 failures → "Wrong password. Account will be locked in 2 more attempts." |
| Browser storage full | wallet.js | Catch QuotaExceededError → "Storage full. Cannot save keystore." |
| Invalid contract address in deploy | deploy.js | Validate checksum address before send |
| Network chainId mismatch | swap.js/bridge.js | Check `quote.chainId === state.networkId` before executing |

### 9. ERROR HANDLING STRATEGY PER LAYER

```
┌─────────────────────────────────────────────────┐
│  UI Layer (ui.js)                                │
│  → toast(error.message, 'error')                 │
│  → render error state in DOM                     │
├─────────────────────────────────────────────────┤
│  Feature Layer (send.js, swap.js, etc.)          │
│  → withErrorBoundary wrapping                    │
│  → returns { error, data } instead of throw      │
├─────────────────────────────────────────────────┤
│  Service Layer (price.js, APIs)                  │
│  → fetchWithTimeout with abort controller        │
│  → retry with backoff (network errors only)      │
│  → cache fallback                                │
├─────────────────────────────────────────────────┤
│  Network Layer (network.js)                      │
│  → RPC fallback chain (already exists)           │
│  → add retry wrapper                             │
├─────────────────────────────────────────────────┤
│  Global (app.js)                                 │
│  → window.addEventListener('unhandledrejection')│
│  → log to activity + toast                       │
└─────────────────────────────────────────────────┘
```

### 10. SCALABILITY CONSIDERATIONS

| Aspect | Current | Fix | Scale Limit |
|--------|---------|-----|-------------|
| RPC calls | N+1 (token balance loop) | Parallel with `Promise.allSettled` | ~50 tokens max per chain (OK for now) |
| Price fetch | Not implemented | Batched CoinGecko call | 250 tokens per CoinGecko call |
| NFT enumeration | None | Scan known contracts only | ~10 contracts × ~20 NFTs = 200 max |
| Activity storage | localStorage (100 cap) | Keep cap, compress old entries | 100 entries = ~50KB |
| State size | Single object | Module singleton | <1MB in memory |
| Bundle size | Single app.js (998 lines) | Split to ~10 modules (~100-200 lines each) | Still well under 50KB total |

**NOT scaling concerns (deliberate)**:
- No service worker (GitHub Pages, no backend to cache)
- No IndexedDB (localStorage is sufficient for wallet data)
- No WebSocket (HTTP polling is fine for price/quote)
- No code splitting (no build step = no dynamic imports)

### 11. RISIKO & ASUMSI

| # | Asumsi | Risiko | Mitigasi |
|---|--------|--------|----------|
| A1 | CoinGecko free API cukup untuk price polling | Rate limit atau downtime | DexScreener fallback + cache 5min |
| A2 | 0x API v1 still works (with key) | API deprecated entirely | OKX DEX API as alt + simulated mode |
| A3 | LI.FI API free tier still works | API requires key now | Simulated fallback |
| A4 | ethers v6 `signAuthorization` works in browser | RPC compatibility issue | Already tested in current code |
| A5 | ERC-721 contracts support `tokenOfOwnerByIndex` | Many NFTs use non-enumerable | Scan known enumerable contracts only |
| A6 | Pre-compiled bytecode works across EVM chains | Different EVM versions | Use minimal opcodes only |
| A7 | Users have Alchemy/QuickNode for 7702 on mainnet | Public RPCs don't support type-4 | Clear error message + guidance |
| A8 | Termux Node.js version supports all test features | node:test API differences | Test on Node 18+ |
| A9 | CoinGecko chain ID mapping correct | Tokens don't map 1:1 | Manual mapping + manual fallback |
| A10 | localStorage sufficient for all data | User exceeds quota | QuotaExceededError handling |

### 12. URUTAN IMPLEMENTASI (Dependency Graph)

```
FASE 0 — CRITICAL FIX (hari 1)
├── Fix B1: Add spinnerDots to import di app.js (1 menit)
└── Test: npm run check → pass

FASE 1 — INFRASTRUCTURE (hari 1-2)
├── Create js/state.js (state management)
├── Create js/safetx.js (double-submit + error boundary)
├── Refactor app.js → import state.js, extract view logic
├── Create js/i18n.js (translations EN/ID)
├── Add data-i18n attributes ke index.html
└── Test: npm run verify → pass

FASE 2 — CORE FEATURES P0 (hari 2-4)
├── Create js/price.js (CoinGecko + DexScreener + cache)
├── Integrate price.js ke loadDashboard()
├── Create js/send.js (extract + gas estimator + poisoning warning)
├── Create js/swap.js (0x API + simulated fallback)
├── Create js/bridge.js (LI.FI + simulated fallback)
├── Create tests/price.test.js
├── Create tests/send.test.js
├── Create tests/swap.test.js
└── Test: npm test → all green

FASE 3 — EIP-7702 & ADVANCED (hari 4-6)
├── Create js/eip7702.js (extract + batch/rescue/claim honest stubs)
├── Create js/deploy.js (extract + bytecode templates)
├── Create contracts/BatchExecutor.sol + RescueContract.sol
├── Create scripts/compile-bytecode.js (requires solcjs)
└── Test: manual browser test on Sepolia

FASE 4 — POLISH P1 (hari 6-7)
├── Create js/nft.js (on-chain enumeration)
├── Integrate nft.js ke loadDashboard()
├── Add skeleton loading CSS + animated balance
├── Add i18n ke dynamic content
├── Create tests/i18n.test.js
└── Test: npm test → all green

FASE 5 — FINAL (hari 7-8)
├── Add global error handler (unhandledrejection)
├── Update index.html scripts to load new modules
├── Create tests/e2e-checklist.md
├── Run full manual E2E checklist
├── Update README.md
└── Final: npm run verify + manual E2E → all pass
```

---

## NON-GOAL (TIDAK DIBUAT)

| Item | Alasan |
|------|--------|
| Backend/server | 100% client-side — ini prinsip utama |
| Hardware wallet (Ledger/Trezor) | Out of scope v1, complex USB integration |
| WebSocket real-time | HTTP polling cukup untuk use case ini |
| IndexedDB | localStorage suffice for wallet data |
| Code splitting/dynamic imports | No build step, static hosting |
| Social login/SSO | Contradicts self-custody principle |
| Fiat on-ramp | Requires payment processor integration (costly) |
| Multi-chain aggregation dashboard | "Semua Network" view = complex re-architecture, defer to v2 |
| PnL chart | Canvas chart library = overhead, defer to v2 |
| Custom token logo/icon | Needs external image service, defer to v2 |
| Smart contract verification (Sourcify) | Nice-to-have but adds complexity, defer to v2 |
| EIP-7702 batch/rescue/claim REAL execution | Requires deployed implementation contract — provide honest stubs + contract source for self-deployment |

---

## FILE CHANGE SUMMARY

| File | Action | Lines Est. | Description |
|------|--------|-----------|-------------|
| `js/state.js` | CREATE | ~40 | Centralized state + pub/sub |
| `js/safetx.js` | CREATE | ~60 | Double-submit guard + error boundary + gas preview |
| `js/price.js` | CREATE | ~150 | CoinGecko/DexScreener polling + cache |
| `js/send.js` | CREATE | ~200 | Send logic + gas estimator + poisoning warning |
| `js/swap.js` | CREATE | ~180 | 0x API + simulated fallback |
| `js/bridge.js` | CREATE | ~130 | LI.FI + simulated fallback |
| `js/eip7702.js` | CREATE | ~250 | Delegate/revoke/batch/rescue/claim |
| `js/deploy.js` | CREATE | ~120 | Deploy wizard + bytecode embed |
| `js/nft.js` | CREATE | ~150 | On-chain NFT enumeration |
| `js/i18n.js` | CREATE | ~200 | EN/ID translations + t() helper |
| `js/app.js` | REFACTOR | ~600→400 | Extract features, import new modules |
| `js/ui.js` | EXPAND | ~129→180 | +animateValue +skeletonAsset +skeletonNft |
| `css/cartoon.css` | EXPAND | ~594→650 | +skeleton +gas-preview +poisoning +simulated |
| `index.html` | MODIFY | ~341→380 | +data-i18n attrs +script new modules |
| `contracts/BatchExecutor.sol` | CREATE | ~30 | Minimal batch contract |
| `contracts/RescueContract.sol` | CREATE | ~40 | Minimal rescue contract |
| `contracts/README.md` | CREATE | ~20 | Audit notes + deployment guide |
| `scripts/compile-bytecode.js` | CREATE | ~50 | Solidity → bytecode compiler script |
| `tests/price.test.js` | CREATE | ~80 | Price service tests |
| `tests/send.test.js` | CREATE | ~70 | Send validation tests |
| `tests/swap.test.js` | CREATE | ~50 | Swap validation tests |
| `tests/i18n.test.js` | CREATE | ~60 | i18n tests |
| `tests/e2e-checklist.md` | CREATE | ~100 | Manual browser test checklist |

**Total new code**: ~1,860 lines across 13 new files
**Total modified code**: ~400 lines across 3 existing files
**Grand total**: ~2,260 lines

---

## RINGKASAN (15 POIN)

1. **spinnerDots BUG FIX**: Tambah ke import di app.js baris 10 — ReferenceError hilang seketika (1 menit)
2. **State management**: Buat `state.js` singleton — elimina circular dependency, clear data ownership per modul
3. **Modulasi**: app.js (998 baris) → 10 modul terpisah (~100-200 baris masing-masing) — maintainable & debuggable
4. **Harga USD**: CoinGecko polling + DexScreener fallback + cache 60s — balance不再是 "$0.00"
5. **Swap real**: 0x API quote + approve + execute — dengan simulated fallback yang jujur (labeled)
6. **Bridge real**: LI.FI quote + execute — dengan simulated fallback yang jujur
7. **NFT real**: On-chain enumeration via `tokenOfOwnerByIndex` + `tokenURI` — dengan limitation disclosure
8. **EIP-7702 honest**: Batch/rescue/claim tetap stubs tapi dengan penjelasan JUJUR + contract source code untuk self-deploy
9. **Deploy wizard**: Minimal embedded bytecode (ERC-20/721/1155) — compile via solcjs script
10. **Address poisoning**: `isSuspiciousSimilar()` dipanggil di `doSend()` + confirmation dialog
11. **Gas estimator**: Fee breakdown sebelum send — gas limit × gas price × multiplier per speed = USD preview
12. **i18n EN/ID**: ~80 translation keys — `data-i18n` attrs + `t()` helper — settings `lang` jadi fungsional
13. **Skeleton loading + animated counter**: CSS shimmer + JS `requestAnimationFrame` counter — polish visual
14. **Double-submit + error boundary**: `safeSend()` guard + `withErrorBoundary()` wrapper — prevent crashes
15. **39 tests (node:test)**: 20 existing + 19 new — unit test semua service layer, manual E2E checklist untuk browser
