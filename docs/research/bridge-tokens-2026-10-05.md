# RISET: Bridge Router & Token Canonical untuk Bear-Tool

```
RISET     : (A) LI.FI API quote ERC-20 + approval flow, (B) router bridge alternatif selain LI.FI,
            (C) token canonical per chain dengan sumber resmi
TUJUAN    : keputusan integrasi — endpoint quote ERC-20 mana yang dipakai, bagaimana approval
            dibangun di sisi wallet client-side, router cadangan mana yang layak, dan token
            mana yang boleh masuk tabel token Bear-Tool (address tanpa sumber = DILARANG)
SCOPE     : read-only; tidak ada kode Bear-Tool yang diubah; Aptos dilewati; testnet tanpa
            token resmi ditulis "no curated list"; tidak membahas harga API berbayar
            (tidak ditemukan dalam sumber yang diperiksa)
Akses     : SELURUH sumber & probe live diakses/dijalankan 2026-10-05
```

---

## BAGIAN A — LI.FI API (quote ERC-20 + approval)

### Sumber

**S1 — Indeks dokumentasi LI.FI (llms.txt)**
- URL     : https://docs.li.fi/llms.txt
- Tgl     : 2026-10-05
- Tipe    : docs resmi (score 5/5)
- Isi     : daftar halaman API resmi (`/v1/quote`, `/v1/chains`, `/v1/tokens`, status, contracts,
            error-codes, rate-limits); catatan "All LI.FI APIs do not require API key";
            tertulis "Without API key 200 requests/2 hours".
- Kelemahan: indeks, bukan halaman aturan; angka rate limit-nya bertentangan dengan halaman
  rate-limits resmi (lihat KONFLIK-1).

**S2 — Get a quote for a token transfer**
- URL     : https://docs.li.fi/api-reference/get-a-quote-for-a-token-transfer
- Tgl     : 2026-10-05
- Tipe    : docs resmi (5/5)
- Isi     : parameter `fromChain, toChain, fromToken, toToken, fromAmount, fromAddress, toAddress,
            slippage, ...`; native token diwakili `0x0000000000000000000000000000000000000000`.
- Kelemahan: tidak merinci urutan approval (ada di S3).

**S3 — Approvals workflow**
- URL     : https://docs.li.fi/agents/workflows/approvals
- Tgl     : 2026-10-05
- Tipe    : docs resmi (5/5)
- Isi     : approval dibangun dari `quote.estimate.approvalAddress` (spender); cek allowance
            on-chain sebelum kirim `approve`; USDT-style token butuh reset allowance ke 0 dulu;
            estimasi gas approval muncul sebagai `gasCosts[].type = APPROVE`.
- Kelemahan: halaman "agents/workflows" — contoh berbahasa agent, kontrak parameternya di S6.

**S4 — Rate limits**
- URL     : https://docs.li.fi/api-reference/rate-limits
- Tgl     : 2026-10-05
- Tipe    : docs resmi (5/5)
- Isi     : tanpa API key: `GET /quote` 75 request / 2 jam; API key menaikkan limit; API key
            tidak boleh diekspos di client.
- Kelemahan: tidak mencantumkan limit per-endpoint lain selain /quote.

**S5 — Error codes**
- URL     : https://docs.li.fi/api-reference/error-codes
- Tgl     : 2026-10-05
- Tipe    : docs resmi (5/5)
- Isi     : kode error LI.FI (termasuk 1002 "no available quote", 1011 enum/validasi).
- Kelemahan: daftar, bukan perilaku runtime.

**S6 — OpenAPI resmi (file diunduh ke tmpres/lifi-openapi.yaml, 418 KB)**
- URL     : https://docs.li.fi/openapi.yaml
- Tgl     : 2026-10-05
- Tipe    : spec resmi (5/5)
- Isi     : `security: []` pada semua endpoint (keyless); field response quote:
  `estimate.approvalAddress`, `estimate.skipApproval`, `estimate.feeCosts[]`,
  `estimate.gasCosts[]`, `tx.{chainId,to,data,value}`, `executionDuration`, `tool`,
  `includedSteps[]`. **TIDAK ada endpoint approval/transaction** (grep `approve` hanya
  menemukan field `approvalAddress`, `skipApproval`, dan tipe `APPROVE` yang ditandai
  "reserved"); field `unapprovedAmount` tidak ada di schema.
- Kelemahan: spec bisa beda dengan implementasi (dicek ulang lewat probe S7/S8).

**S7 — Probe live quote ERC-20**
- URL     : GET https://li.quest/v1/quote?fromChain=1&toChain=42161&fromToken=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48&toToken=0xaf88d065e77c8cC2239327C5EDb3A432268e5831&fromAmount=10000000&fromAddress=…&toAddress=…&slippage=0.005
- Tgl     : 2026-10-05
- Tipe    : probe live (5/5)
- Isi     : HTTP 200; `estimate.approvalAddress = 0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE`
            (LI.FI diamond, sama dengan `diamondAddress` di /v1/chains);
            `estimate.skipApproval` TIDAK muncul; `transactionRequest.value = "0x0"`;
            `tx.chainId = 1`; `feeCosts[]` included=true (LIFI Fixed Fee 0.0025);
            `executionDuration = 2` menit; `tool = across`;
            `includedSteps = [protocol/feeCollection, cross/across]`.
            Header: `ratelimit-limit: 71` sisa dari 75 (`ratelimit-remaining: 71`,
            `ratelimit-reset: 7166` detik).
- Kelemahan: satu pasangan chain/token — pola umum diverifikasi dengan pembanding S8.

**S8 — Probe live quote native (pembanding)**
- URL     : GET https://li.quest/v1/quote (fromToken/toToken = 0x000…000)
- Tgl     : 2026-10-05
- Tipe    : probe live (5/5)
- Isi     : `skipApproval: true`, `tx.value = 0x16345785d8a0000` (non-zero) → pembeda
            ERC-20 vs native ada di 2 field: `skipApproval` dan `value`.
- Kelemahan: — .

**S9 — Probe live rate limit header**
- URL     : GET https://li.quest/v1/quote dan https://li.quest/v1/chains
- Tgl     : 2026-10-05
- Tipe    : probe live (5/5)
- Isi     : `/quote` → `ratelimit-limit: 75`, `ratelimit-remaining: 71`, `ratelimit-reset: 7156`;
            `/chains` → `ratelimit-limit: 100`, `ratelimit-reset: 60`.
- Kelemahan: snapshot sesaat; limit bisa berubah sewaktu-waktu.

**S10 — Probe live daftar chain**
- URL     : GET https://li.quest/v1/chains?chainTypes=EVM
- Tgl     : 2026-10-05
- Tipe    : probe live (5/5)
- Isi     : 70 chain EVM. Tiap entri punya `diamondAddress` (= approval spender) dan
            `nativeToken.address = 0x000…000`.
- Kelemahan: hanya EVM (chainTypes=EVM).

**S11 — Probe live testnet & route testnet→testnet**
- URL     : GET https://li.quest/v1/quote?fromChain=97|80002 ; 11155111→421614, 84532→11155420, 11155111→84532
- Tgl     : 2026-10-05
- Tipe    : probe live (5/5)
- Isi     : `fromChain=97` dan `80002` → HTTP 400 `{"message":"/fromChain must be equal to one
            of the allowed values…","code":1011}`; route testnet→testnet → HTTP 404 code 1002
            "No available quotes" (tidak ada likuiditas).
- Kelemahan: kegagalan route bisa berubah bila LI.FI menambah likuiditas testnet.

### A1 — Parameter persis `/v1/quote` (ERC-20 vs native)

| Parameter | ERC-20 | Native |
|---|---|---|
| `fromChain`, `toChain` | chain ID | chain ID |
| `fromToken`, `toToken` | alamat kontrak ERC-20 (EIP-55) | `0x0000000000000000000000000000000000000000` |
| `fromAmount` | integer base unit (mis. USDC 6 desimal → `10000000` = 10 USDC) | sama |
| `fromAddress`, `toAddress` | alamat wallet | sama |
| `slippage` | desimal (0.005 = 0.5%) | sama |
| metode | `GET https://li.quest/v1/quote` | sama |

Bukti: S2 (parameter), S7/S8 (probe), S6 (schema).

### A2 — Flow APPROVAL

1. **Tidak ada endpoint approval.** OpenAPI (S6) tidak memuat endpoint `approve/transaction`
   apa pun — approval transaction harus dibangun sendiri oleh wallet/app.
2. `GET /v1/quote` dengan ERC-20 mengembalikan `estimate.approvalAddress` = spender yang harus
   di-approve (S7; nilainya sama dengan `diamondAddress` chain di S10).
3. **Bila allowance kurang**: quote tetap diberikan (S7 tidak punya field sisa allowance;
   `unapprovedAmount` tidak ada di schema S6). App WAJIB membaca on-chain
   `allowance(owner, spender)` lalu mengirim `approve(spender, amount)` sebelum tx swap.
4. **Reset dulu untuk token tipe USDT**: kalau allowance lama > 0 tapi salah, kirim
   `approve(spender, 0)` dulu, baru `approve(spender, amount)` (S3).
5. `estimate.skipApproval: true` HANYA muncul untuk native (S8) → bisa dipakai cabang if.
6. `gasCosts[].type = "APPROVE"` ditandai "reserved" di spec (S6) → jangan diandalkan untuk
   memutuskan perlu approval; putuskan dari `skipApproval` + `allowance()` on-chain.
7. Setelah tx approve terkonfirmasi (receipt status 1), ulangi `GET /v1/quote` (quote punya
   masa berlaku singkat; `executionDuration` menit — S7), lalu kirim `tx` dari response:
   kirim `value = tx.value`, ke `tx.to`, data `tx.data`, chain `tx.chainId`.

### A3 — Field response yang harus divalidasi

| Field | Cek |
|---|---|
| `tx.chainId` | == `fromChain` yang diminta (S7: 1) |
| `tx.to`, `tx.data` | wajib ada, `to` = kontrak (LI.FI diamond/deposit) |
| `tx.value` | `0x0` untuk ERC-20 (S7); non-zero untuk native (S8) |
| `estimate.skipApproval` | absen/false untuk ERC-20 → wajib cek allowance; `true` untuk native |
| `estimate.approvalAddress` | ada & valid address untuk ERC-20 (S7) |
| `estimate.feeCosts[].included` | true = fee sudah termasuk dalam amount (S7) |
| `executionDuration`, `tool`, `includedSteps` | tampil ke user (transparansi) |
| HTTP 404 + code 1002 | "No available quotes" → tawarkan chain/token lain (S11) |
| HTTP 400 + code 1011 | parameter di luar enum chain → jangan kirim chain itu (S11) |
| `fromAmount`/`toAmount` | bandingkan implied rate dengan harga pasar, slippage tolerance |

### A4 — Rate limit / keyless

- **Keyless**: `security: []` di seluruh OpenAPI + pernyataan resmi (S6, S1) → aman untuk
  client-side Termux tanpa API key.
- **Limit live 2026-10-05 (S9)**: `/quote` = **75 request / 2 jam** (reset ~7156 s),
  `/chains` = 100 request / 60 detik.
- Halaman rate-limits (S4) = 75/2 jam → **dukung angka live**; angka 200/2 jam di llms.txt
  (S1) dianggap stale (lihat KONFLIK-1).
- API key opsional hanya untuk limit lebih tinggi; **jangan taruh API key di client** (S4).

### A5 — Daftar chain LI.FI (probe `/v1/chains?chainTypes=EVM`, 70 chain)

70 chain ID: 1, 10, 14, 25, 30, 40, 50, 56, 88, 100, 122, 130, 137, 143, 146, 196, 204, 232,
252, 288, 324, 480, 747, 988, 999, 1088, 1135, 1329, 1337, 1480, 1625, 1672, 1776, 1868, 2020,
2741, 2818, 4217, 4326, 4663, 5000, 5031, 5042, 8217, 8453, 9745, 13371, 16661, 33139, 34443,
42161, 42170, 42220, 42793, 43111, 43114, 57073, 59144, 60808, 80094, 81457, 84532, 98866,
421614, 534352, 747474, 3586256, 5042002, 11155111, 11155420.

| Chain target | ID | Status LI.FI (2026-10-05) |
|---|---|---|
| Avalanche C-Chain | 43114 | ✅ ada |
| Linea | 59144 | ✅ ada |
| Scroll | 534352 | ✅ ada |
| Sonic | 146 | ✅ ada |
| Celo | 42220 | ✅ ada |
| Gnosis | 100 | ✅ ada |
| Mantle | 5000 | ✅ ada |
| Blast | 81457 | ✅ ada |
| Polygon zkEVM | 1101 | ❌ TIDAK ada (padahal llms.txt menyebut — KONFLIK-2) |
| zkSync Era | 324 | ✅ ada |
| Taiko | 167000 | ❌ tidak ada |
| Moonbeam | 1284 | ❌ tidak ada |
| Unichain | 130 | ✅ ada |
| World Chain | 480 | ✅ ada |
| Ethereum | 1 | ✅ |
| OP / Arbitrum / BNB / Polygon / Base | 10/42161/56/137/8453 | ✅ |
| Testnet | 11155111, 421614, 11155420, 84532 | ✅ ada (tapi route testnet→testnet 404, S11) |
| Testnet | 80002, 97 | ❌ ditolak 400 code 1011 (S11) — padahal ada di `BRIDGE_ROUTERS` |

---

## BAGIAN B — Router bridge alternatif (selain LI.FI)

### Sumber

**S12 — Socket docs: Get API access**
- URL     : https://docs.socket.tech/integrate/get-api-access
- Tgl     : 2026-10-05
- Tipe    : docs resmi (4/5)
- Isi     : 3 endpoint (quote/tx/status); `public-backend.socket.tech` untuk akses publik
            tanpa auth (shared rate limit), `backend.socket.tech` butuh domain whitelist.
- Kelemahan: halaman docs kadang tidak menyebut format native token (diambil dari probe S13).

**S13 — Probe live Socket**
- URL     : GET https://public-backend.socket.tech/v3/swap/quote?userOps=tx&originChainId=1&destinationChainId=42161&inputToken=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48&outputToken=0xaf88d065e77c8cC2239327C5EDb3A432268e5831&inputAmount=…&userAddress=…&receiverAddress=…&slippage=0.5
- Tgl     : 2026-10-05
- Tipe    : probe live (5/5)
- Isi     : HTTP 200 keyless; ERC-20 mengembalikan blok `approval: {spenderAddress
            = 0x50c4E75a512F2A14A7b304787Adf79C4531A5909, amount, tokenAddress, userAddress}`;
            `txData.object.value = '0'`. Native HARUS pakai `0xeeee…eeee` (proxy address),
            `0x0` → HTTP 400 "inputToken must be a valid EVM address for chain 1".
            `backend.socket.tech` tanpa whitelist → HTTP 403.
- Kelemahan: public endpoint = rate limit bersama, tanpa SLA.

**S14 — Squid docs**
- URL     : https://docs.squidrouter.com/getting-started/readme
- Tgl     : 2026-10-05
- Tipe    : docs resmi (5/5)
- Isi     : base `https://v2.api.squidrouter.com/v2/`; header `x-integrator-id` wajib;
            "Squid issues Integrator IDs on a limited basis upon review".
- Kelemahan: — .

**S15 — Probe live Squid**
- URL     : GET https://v2.api.squidrouter.com/v2/… (tanpa & dengan header dummy)
- Tgl     : 2026-10-05
- Tipe    : probe live (5/5)
- Isi     : tanpa header → 400 `{"message":"x-integrator-id header is missing"}`;
            header dummy → 401 `{"message":"Integrator ID is invalid"}`.
- Kelemahan: — .

**S16 — Symbiosis docs + Swagger**
- URL     : https://docs.symbiosis.finance/developer-tools/symbiosis-api.md ; Swagger: https://api.symbiosis.finance/crosschain/docs/
- Tgl     : 2026-10-05
- Tipe    : docs resmi (5/5)
- Isi     : base `https://api.symbiosis.finance/crosschain/`; flow approve menuju
            `metaRouterGateway`; JS SDK sudah deprecated → pakai REST API.
- Kelemahan: contoh di docs tidak selalu sinkron dengan versi v1/v2 live.

**S17 — Probe live Symbiosis**
- URL     : GET /v1/chains ; /v1/tokens ; /health-check ; GET /v2/quote
- Tgl     : 2026-10-05
- Tipe    : probe live (5/5)
- Isi     : `/v1/chains` 200 → 60 chain (termasuk 1101 Polygon zkEVM & 167000 Taiko);
            `/v1/tokens` 200 → 224 token; `/health-check` 200 `OK`; `/v2/quote` → 422
            validation error (bukan 401/403) → **keyless**.
- Kelemahan: 422 berarti format request contoh docs belum cocok — perlu baca schema v2.

**S18 — Wormhole (Standard Relayer)**
- URL     : https://relayer.wormhole.com/v1/quote (probe) + https://wormhole.com/docs/protocol/infrastructure/relayers/executor-vs-sr/ (docs)
- Tgl     : 2026-10-05
- Tipe    : probe live + docs resmi (5/5)
- Isi     : probe `relayer.wormhole.com/v1/quote` → **HTTP 522** (origin mati) — konsisten
            dengan catatan di `js/routers.js`; docs resmi kini memuat "Standard Relayer →
            Executor Migration" dan endpoint baru `POST /v0/quote` pada
            `https://executor-testnet.labsapis.com` (testnet) — model relayer lama
            digeser ke framework Executor.
- Kelemahan: tidak ditemukan dokumen yang secara eksplisit menyatakan "relayer.wormhole.com
  deprecated" (klaim: indikasi kuat, bukan terbukti tertulis).

**S19 — Owlto docs + API live**
- URL     : https://docs.owlto.finance/llms.txt ; https://docs.owlto.finance/integration-guides/api/overview.md ; Swagger: https://owlto.finance/bridge_api/v1/swagger/doc.json
- Tgl     : 2026-10-05
- Tipe    : docs resmi + probe (5/5)
- Isi     : base `https://owlto.finance/api/bridge_api/v1/{API}`; 3 endpoint:
            `get_all_pair_infos` (POST), `get_build_tx`, `get_receipt`; **probe POST tanpa
            auth → HTTP 200** dengan `pair_infos` (from/to chain id, token address, decimals,
            min/max) → keyless.
- Kelemahan: hanya bridge jembatan (bukan swap aggregator lintas token); swagger `info`
  kosong (dokumentasi tipis).

**S20 — Jumper (bukan API terpisah)**
- URL     : https://docs.jumper.xyz/faq ; https://github.com/lifinance/jumper-docs
- Tgl     : 2026-10-05
- Tipe    : docs resmi (5/5)
- Isi     : FAQ resmi: "Is Jumper powered by LI.FI? **Yes.** Jumper uses LI.FI infrastructure
            for cross-chain routing and execution." Repo docs berada di organisasi
            `lifinance`. Repo frontend `jumperexchange/jumper-exchange` sudah ARCHIVED
            (pindah repo privat).
- Kelemahan: — .

**S21 — deBridge DLN / Across / Synapse (probe)**
- URL     : https://api.dln.trade/v1/chainPairs ; https://across.to/api/get-quote (POST) ; https://synapseprotocol.com/ (redirect)
- Tgl     : 2026-10-05
- Tipe    : probe live (4/5)
- Isi     : deBridge → HTTP 400 body nginx 150 byte (identik dengan bukti lama di
            `js/routers.js`); Across → 404 NOT_FOUND; Synapse → 301.
- Kelemahan: kegagalan endpoint yang saya tebak ≠ bukti tidak ada API; docs resmi masing-masing
  belum dibuka (lihat SUMBER TAMB).

### Tabel perbandingan router

| Router | Endpoint | Keyless? | Docs resmi | Bukti live 2026-10-05 | Verdict |
|---|---|---|---|---|---|
| **LI.FI** | `GET li.quest/v1/quote` | ✅ ya | docs.li.fi | 200 ERC-20 + native (S7/S8) | **PRIMER** — 70 chain, schema lengkap, `approvalAddress` bawaan |
| **Socket/Bungee** | `GET public-backend.socket.tech/v3/swap/quote` | ✅ ya (shared rate) | docs.socket.tech | 200 + blok `approval` (S13) | **FALLBACK-1** — satu-satunya alternatif keyless dengan approval info terstruktur |
| **Symbiosis** | `GET api.symbiosis.finance/crosschain/v1/*` | ✅ ya | docs.symbiosis.finance | chains 60, tokens 224, quote 422 (S17) | **FALLBACK-2 + sumber token** (satu-satunya sumber untuk 1101 & 167000) |
| **Owlto** | `POST owlto.finance/api/bridge_api/v1/get_all_pair_infos` | ✅ ya | docs.owlto.finance | 200 tanpa auth (S19) | Opsional — bridge saja, cocok untuk stablecoin bridge murah |
| **Jumper** | — (frontend) | — | docs.jumper.xyz | "powered by LI.FI" (S20) | **REDUNDAN** — wrapper UI LI.FI, bukan router terpisah |
| **Squid** | `v2.api.squidrouter.com/v2/*` | ❌ wajib `x-integrator-id` (dibatasi review) | docs.squidrouter.com | 400/401 (S15) | **SKIP** — onboarding partnership |
| **Wormhole** | `relayer.wormhole.com/v1/quote` | ? | wormhole.com/docs (Executor) | **522** (S18) | **SKIP** — endpoint lama mati, model pindah ke Executor |
| **deBridge DLN** | `api.dln.trade/v1/*` | ? | — | 400 nginx (S21) | **SKIP** — endpoint tak terbukti jalan |
| **Across** | `across.to/api/get-quote` | ? | — | 404 (S21) | **SKIP** (endpoint publik tidak ditemukan) |
| **Synapse** | — | ? | — | 301 (S21) | **SKIP** |

**Rekomendasi Bagian B**: cukup **LI.FI (primer) + Socket public (fallback)**, dengan
**Symbiosis** opsional karena sudah terbukti memberi token/chain coverage untuk chain yang
tidak didukung LI.FI. Router lain tidak menambah cakupan yang LI.FI+Socket belum punya,
dengan biaya integrasi (auth/id masing-masing) lebih besar daripada manfaatnya.

---

## BAGIAN C — Token canonical per chain (sumber resmi + verifikasi on-chain)

### Metode (wajib baca sebelum memakai tabel)

1. **Kandidat** hanya dari sumber berikut: Circle (penerbit USDC resmi), LI.FI `/v1/tokens`
   (aggregator token list resmi), Symbiosis `/v1/tokens`, Chainlink docs (LINK).
2. **Verifikasi on-chain 2026-10-05** dengan ethers 6.17.0:
   `eth_getCode` (kontrak harus ada) → `decimals()` → `symbol()` → validasi **EIP-55 checksum**
   (`ethers.getAddress(addr) === addr`).
3. **Status**:
   - `OK` = kontrak ada, decimals cocok dengan klaim sumber, checksum valid, symbol cocok.
   - `SYMBOL_DIFF` = kontrak ada & decimals cocok, tetapi symbol on-chain beda dari label
     sumber (aman dipakai, tampilkan symbol on-chain).
   - `no curated list` = sumber resmi tidak memuat token untuk chain itu (address DILARANG dikarang).
4. RPC dipakai (semua publik): `eth.llamarpc.com` (1), `mainnet.optimism.io` (10),
   `bsc-dataseed.binance.org` (56), `rpc.gnosischain.com` (100), `polygon-rpc.com` /
   `polygon-bor-rpc.publicnode.com` / `polygon.drpc.org` (137), `mainnet.base.org` (8453),
   `arb1.arbitrum.io/rpc` (42161), `zkevm-rpc.com` (1101), `rpc.mainnet.taiko.xyz` (167000),
   `worldchain-mainnet.g.alchemy.com/public` (480),
   `polygon-amoy-bor-rpc.publicnode.com` (80002), `ethereum-sepolia-rpc.publicnode.com` (11155111).
   (Catatan: `rpc-amoy.polygon.technology` sudah DNS-mati → ganti publicnode.)

### Sumber

**S22 — Circle: USDC contract addresses**
- URL     : https://developers.circle.com/stablecoins/usdc-contract-addresses
- Tgl     : 2026-10-05
- Tipe    : docs resmi penerbit (5/5)
- Isi     : USDC mainnet: Arbitrum `0xaf88d065…e5831`, Avalanche `0xB97EF9Ef…48a6E`,
            Base `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, Celo `0xcebA9300…2118C`,
            Cronos `0x3D7F2C478aAfdB65542BCB44bCeeC05849999d2D`, Ethereum `0xA0b86991…6eB48`,
            Linea `0x176211869cA2b568f2A7D4EE941E073a821EE1ff`, OP `0x0b2C639c…9Ff85`,
            Polygon `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359`, Sonic `0x29219dd4…38894`,
            Unichain `0x078D782b…57AD6`, World Chain `0x79A02482A880bCE3F13e09Da970dC34db4CD24d1`,
            ZKsync `0x1d17CBcF…538D4`; testnet: Sepolia `0x1c7D4B19…C7238`, Arb Sepolia
            `0x75faf114…6AA4d`, Base Sepolia `0x036CbD53…DC7e`, OP Sepolia `0x5fd84259…30D7`,
            Polygon Amoy `0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582`.
            **TIDAK ada** USDC untuk BSC(56), Gnosis(100), Mantle(5000), Scroll(534352),
            Blast(81457), Polygon zkEVM(1101), Taiko(167000), Moonbeam(1284).
- Kelemahan: hanya USDC; stablecoin lain bukan ranah Circle.

**S23 — LI.FI token list**
- URL     : GET https://li.quest/v1/tokens?chains=… (respons disimpan tmpres/lifi_tokens.json)
- Tgl     : 2026-10-05
- Tipe    : API resmi aggregator (4/5)
- Isi     : 21 chain diterima (1101/167000/1284/80002/97 ditolak 400) → 8.512 entri token;
            dipakai sebagai kandidat lalu diverifikasi on-chain.
- Kelemahan: label symbol bisa beda dari symbol on-chain (terbukti, lihat KONFLIK-5).

**S24 — Symbiosis token list**
- URL     : GET https://api.symbiosis.finance/crosschain/v1/tokens
- Tgl     : 2026-10-05
- Tipe    : API resmi vendor (4/5)
- Isi     : 224 token; satu-satunya sumber kandidat untuk 1101 (USDC/USDC.e/WETH) & 167000 (WETH).
- Kelemahan: vendor aggregator, bukan penerbit token — makanya status verifikasi tetap on-chain.

**S25 — Chainlink: LINK token contracts**
- URL     : https://docs.chain.link/resources/link-token-contracts
- Tgl     : 2026-10-05
- Tipe    : docs resmi penerbit (5/5)
- Isi     : Ethereum `0x514910771AF9Ca656af840dff83E8264EcF986CA` (18);
            **Sepolia `0x779877A7B0D9E8603169DdbD7836e478b4624789` (18)**;
            BNB testnet `0x84b9B910527Ad5C03A9Ca831909E21e236EA7b06` (18);
            Arbitrum Sepolia `0xb1D4538B4571d411F07960EF2838Ce337FE1E80E`;
            Base Sepolia `0xE4aB69C077896252FAFBD49EFD26B5D171A32410`.
- Kelemahan: halaman panjang (perlu grep); hanya token LINK.

**S26 — Moonbeam docs (GAGAL diakses)**
- URL     : https://docs.moonbeam.network/ ; cadangan: GitHub https://api.github.com/repos/moonbeam-foundation/moonbeam-docs/git/trees/master?recursive=1
- Tgl     : 2026-10-05
- Tipe    : docs resmi + GitHub repo resmi (5/5)
- Isi     : domain docs.moonbeam.network **tidak terjangkau dari jaringan riset ini**
            (curl code 000, webfetch transport error); repo resmi `moonbeam-docs`
            (default branch `master`, push terakhir 2026-06-29) berisi 1.397 file dan
            **tidak ada satu pun file yang memuat path `usdc`/`token-list`/`contract-addresses`**.
- Kelemahan: kegagalan akses = ketiadaan bukti, bukan bukti ketiadaan → status Moonbeam
  dinyatakan `no curated list` (bukan "tidak ada USDC").

**S27 — BNB Chain docs (tidak menemukan daftar token testnet)**
- URL     : https://docs.bnbchain.org/bnb-smart-chain/developers/recipes/transfer-tokens/ (404) ; https://docs.bnbchain.org/developers/Smart%20Contract/erc20/ (404)
- Tgl     : 2026-10-05
- Tipe    : docs resmi (3/5)
- Isi     : path docs yang dicoba mengembalikan 404; tidak ditemukan halaman berisi alamat
            ERC-20 testnet (97) yang diterbitkan BNB Chain; LI.FI juga menolak 97 (S11),
            Circle tidak menerbitkan USDC di 97 (S22).
- Kelemahan: baru 2 path dicoba — klaim "no curated list" berdasarkan ketiadaan sumber,
  bukan pernyataan resmi.

### Tabel token (97 baris — 89 OK, 8 SYMBOL_DIFF; verifikasi on-chain 2026-10-05)

| chain | label sumber | address (EIP-55) | dec (sumber) | dec (on-chain) | status | sumber |
|---|---|---|---|---|---|---|
| 10 | DAI | `0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1` | 18 | 18 | OK | LI.FI /v1/tokens |
| 10 | USDC | `0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85` | 6 | 6 | OK | LI.FI /v1/tokens+Circle |
| 10 | USDC.e | `0x7F5c764cBc14f9669B88837ca1490cCa17c31607` | 6 | 6 | SYMBOL_DIFF | LI.FI /v1/tokens |
| 10 | USDT | `0x94b008aA00579c1307B0EF2c499aD98a8ce58e58` | 6 | 6 | OK | LI.FI /v1/tokens |
| 10 | WETH | `0x4200000000000000000000000000000000000006` | 18 | 18 | OK | LI.FI /v1/tokens |
| 25 | DAI | `0xF2001B145b43032AAF5Ee2884e456CCd805F677D` | 18 | 18 | OK | LI.FI /v1/tokens |
| 25 | USDC | `0x3D7F2C478aAfdB65542BCB44bCeeC05849999d2D` | 6 | 6 | OK | LI.FI /v1/tokens+Circle |
| 25 | USDC.e | `0xc21223249CA28397B4B6541dfFaEcC539BfF0c59` | 6 | 6 | SYMBOL_DIFF | LI.FI /v1/tokens |
| 25 | USDT | `0x66e428c3f67a68878562e79A0234c1F83c208770` | 6 | 6 | OK | LI.FI /v1/tokens |
| 25 | WBTC | `0x062E66477Faf219F25D27dCED647BF57C3107d52` | 8 | 8 | OK | LI.FI /v1/tokens |
| 25 | WETH | `0xe44Fd7fCb2b1581822D0c862B68222998a0c299a` | 18 | 18 | OK | LI.FI /v1/tokens |
| 56 | DAI | `0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3` | 18 | 18 | OK | LI.FI /v1/tokens |
| 56 | USDC | `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d` | 18 | 18 | OK | LI.FI /v1/tokens |
| 56 | USDT | `0x55d398326f99059fF775485246999027B3197955` | 18 | 18 | OK | LI.FI /v1/tokens |
| 56 | WETH | `0x2170Ed0880ac9A755fd29B2688956BD959F933F8` | 18 | 18 | SYMBOL_DIFF | LI.FI /v1/tokens |
| 100 | USDC | `0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83` | 6 | 6 | OK | LI.FI /v1/tokens |
| 100 | USDC.e | `0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0` | 6 | 6 | OK | LI.FI /v1/tokens |
| 100 | USDT | `0x4ECaBa5870353805a9F068101A40E0f32ed605C6` | 6 | 6 | OK | LI.FI /v1/tokens |
| 100 | WBTC | `0x8e5bBbb09Ed1ebdE8674Cda39A0c169401db4252` | 8 | 8 | OK | LI.FI /v1/tokens |
| 100 | WETH | `0x6A023CCd1ff6F2045C3309768eAd9E68F978f6e1` | 18 | 18 | OK | LI.FI /v1/tokens |
| 130 | DAI | `0x20CAb320A855b39F724131C69424240519573f81` | 18 | 18 | OK | LI.FI /v1/tokens |
| 130 | USDC | `0x078D782b760474a361dDA0AF3839290b0EF57AD6` | 6 | 6 | OK | LI.FI /v1/tokens+Circle |
| 130 | WBTC | `0x0555E30da8f98308EdB960aa94C0Db47230d2B9c` | 8 | 8 | OK | LI.FI /v1/tokens |
| 130 | WETH | `0x4200000000000000000000000000000000000006` | 18 | 18 | OK | LI.FI /v1/tokens |
| 137 | DAI | `0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063` | 18 | 18 | OK | LI.FI /v1/tokens |
| 137 | USDC | `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` | 6 | 6 | OK | LI.FI /v1/tokens+Circle |
| 137 | USDC.e | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` | 6 | 6 | SYMBOL_DIFF | LI.FI /v1/tokens |
| 137 | USDT | `0xc2132D05D31c914a87C6611C10748AEb04B58e8F` | 6 | 6 | SYMBOL_DIFF | LI.FI /v1/tokens |
| 137 | WBTC | `0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6` | 8 | 8 | OK | LI.FI /v1/tokens |
| 137 | WETH | `0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619` | 18 | 18 | OK | LI.FI /v1/tokens |
| 146 | USDC | `0x29219dd400f2Bf60E5a23d13Be72B486D4038894` | 6 | 6 | OK | LI.FI /v1/tokens+Circle |
| 146 | USDT | `0x6047828dc181963ba44974801FF68e538dA5eaF9` | 6 | 6 | OK | LI.FI /v1/tokens |
| 146 | WBTC | `0x0555E30da8f98308EdB960aa94C0Db47230d2B9c` | 8 | 8 | OK | LI.FI /v1/tokens |
| 146 | WETH | `0x50c42dEAcD8Fc9773493ED674b675bE577f2634b` | 18 | 18 | OK | LI.FI /v1/tokens |
| 324 | USDC | `0x1d17CBcF0D6D143135aE902365D2E5e2A16538D4` | 6 | 6 | OK | LI.FI /v1/tokens+Circle |
| 324 | USDC.e | `0x3355df6D4c9C3035724Fd0e3914dE96A5a83aaf4` | 6 | 6 | OK | LI.FI /v1/tokens |
| 324 | USDT | `0x493257fD37EDB34451f62EDf8D2a0C418852bA4C` | 6 | 6 | OK | LI.FI /v1/tokens |
| 324 | WBTC | `0xBBeB516fb02a01611cBBE0453Fe3c580D7281011` | 8 | 8 | OK | LI.FI /v1/tokens |
| 324 | WETH | `0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91` | 18 | 18 | OK | LI.FI /v1/tokens |
| 480 | USDC | `0x79A02482A880bCE3F13e09Da970dC34db4CD24d1` | 6 | 6 | OK | LI.FI /v1/tokens+Circle |
| 480 | WBTC | `0x03C7054BCB39f7b2e5B2c7AcB37583e32D70Cfa3` | 8 | 8 | OK | LI.FI /v1/tokens |
| 480 | WETH | `0x4200000000000000000000000000000000000006` | 18 | 18 | OK | LI.FI /v1/tokens |
| 1101 | USDC | `0xA8CE8aee21bC2A48a5EF670afCc9274C7bbbC035` | 6 | 6 | OK | Symbiosis /v1/tokens |
| 1101 | USDC.e | `0x37eAA0eF3549a5Bb7D431be78a3D99BD360d19e5` | 6 | 6 | SYMBOL_DIFF | Symbiosis /v1/tokens |
| 1101 | WETH | `0x4F9A0e7FD2Bf6067db6994CF12E4495Df938E6e9` | 18 | 18 | OK | Symbiosis /v1/tokens |
| 5000 | USDC | `0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9` | 6 | 6 | OK | LI.FI /v1/tokens |
| 5000 | USDT | `0x201EBa5CC46D216Ce6DC03F6a759e8E766e956aE` | 6 | 6 | OK | LI.FI /v1/tokens |
| 5000 | WBTC | `0xCAbAE6f6Ea1ecaB08Ad02fE02ce9A44F09aebfA2` | 8 | 8 | OK | LI.FI /v1/tokens |
| 5000 | WETH | `0xdEAddEaDdeadDEadDEADDEAddEADDEAddead1111` | 18 | 18 | OK | LI.FI /v1/tokens |
| 8453 | DAI | `0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb` | 18 | 18 | OK | LI.FI /v1/tokens |
| 8453 | USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | 6 | 6 | OK | LI.FI /v1/tokens+Circle |
| 8453 | USDT | `0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2` | 6 | 6 | OK | LI.FI /v1/tokens |
| 8453 | USDbC | `0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA` | 6 | 6 | OK | LI.FI /v1/tokens |
| 8453 | WBTC | `0x0555E30da8f98308EdB960aa94C0Db47230d2B9c` | 8 | 8 | OK | LI.FI /v1/tokens |
| 8453 | WETH | `0x4200000000000000000000000000000000000006` | 18 | 18 | OK | LI.FI /v1/tokens |
| 42161 | DAI | `0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1` | 18 | 18 | OK | LI.FI /v1/tokens |
| 42161 | USDC | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` | 6 | 6 | OK | LI.FI /v1/tokens+Circle |
| 42161 | USDC.e | `0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8` | 6 | 6 | SYMBOL_DIFF | LI.FI /v1/tokens |
| 42161 | USDT | `0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9` | 6 | 6 | SYMBOL_DIFF | LI.FI /v1/tokens |
| 42161 | WBTC | `0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f` | 8 | 8 | OK | LI.FI /v1/tokens |
| 42161 | WETH | `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1` | 18 | 18 | OK | LI.FI /v1/tokens |
| 42220 | DAI | `0x90Ca507a5D4458a4C6C6249d186b6dCb02a5BCCd` | 18 | 18 | OK | LI.FI /v1/tokens |
| 42220 | USDC | `0xcebA9300f2b948710d2653dD7B07f33A8B32118C` | 6 | 6 | OK | LI.FI /v1/tokens+Circle |
| 42220 | USDT | `0x617f3112bf5397D0467D315cC709EF968D9ba546` | 6 | 6 | OK | LI.FI /v1/tokens |
| 42220 | WBTC | `0xBAAB46E28388d2779e6E31Fd00cF0e5Ad95E327B` | 8 | 8 | OK | LI.FI /v1/tokens |
| 42220 | WETH | `0x122013fd7dF1C6F636a5bb8f03108E876548b455` | 18 | 18 | OK | LI.FI /v1/tokens |
| 43114 | DAI.e | `0xd586E7F844cEa2F87f50152665BCbc2C279D8d70` | 18 | 18 | OK | LI.FI /v1/tokens |
| 43114 | USDC | `0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E` | 6 | 6 | OK | LI.FI /v1/tokens+Circle |
| 43114 | USDC.e | `0xA7D7079b0FEaD91F3e65f86E8915Cb59c1a4C664` | 6 | 6 | OK | LI.FI /v1/tokens |
| 43114 | USDT.e | `0xc7198437980c041c805A1EDcbA50c1Ce5db95118` | 6 | 6 | OK | LI.FI /v1/tokens |
| 43114 | USDt | `0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7` | 6 | 6 | OK | LI.FI /v1/tokens |
| 43114 | WBTC.e | `0x50b7545627a5162F82A992c33b87aDc75187B218` | 8 | 8 | OK | LI.FI /v1/tokens |
| 43114 | WETH.e | `0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB` | 18 | 18 | OK | LI.FI /v1/tokens |
| 59144 | DAI | `0x4AF15ec2A0BD43Db75dd04E62FAA3B8EF36b00d5` | 18 | 18 | OK | LI.FI /v1/tokens |
| 59144 | USDC | `0x176211869cA2b568f2A7D4EE941E073a821EE1ff` | 6 | 6 | OK | LI.FI /v1/tokens+Circle |
| 59144 | USDT | `0xA219439258ca9da29E9Cc4cE5596924745e12B93` | 6 | 6 | OK | LI.FI /v1/tokens |
| 59144 | WBTC | `0x3aAB2285ddcDdaD8edf438C1bAB47e1a9D05a9b4` | 8 | 8 | OK | LI.FI /v1/tokens |
| 59144 | WETH | `0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f` | 18 | 18 | OK | LI.FI /v1/tokens |
| 80002 | USDC | `0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582` | 6 | 6 | OK | Circle |
| 81457 | USDB | `0x4300000000000000000000000000000000000003` | 18 | 18 | OK | LI.FI /v1/tokens |
| 81457 | WBTC | `0xF7bc58b8D8f97ADC129cfC4c9f45Ce3C0E1D2692` | 8 | 8 | OK | LI.FI /v1/tokens |
| 81457 | WETH | `0x4300000000000000000000000000000000000004` | 18 | 18 | OK | LI.FI /v1/tokens |
| 84532 | USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | 6 | 6 | OK | LI.FI /v1/tokens+Circle |
| 84532 | WETH | `0x4200000000000000000000000000000000000006` | 18 | 18 | OK | LI.FI /v1/tokens |
| 167000 | WETH | `0xA51894664A773981C6C112C43ce576f315d5b1B6` | 18 | 18 | OK | Symbiosis /v1/tokens |
| 421614 | USDC | `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` | 6 | 6 | OK | LI.FI /v1/tokens+Circle |
| 421614 | WETH | `0x980B62Da83eFf3D4576C647993b0c1D7faf17c73` | 18 | 18 | OK | LI.FI /v1/tokens |
| 534352 | DAI | `0xcA77eB3fEFe3725Dc33bccB54eDEFc3D9f764f97` | 18 | 18 | OK | LI.FI /v1/tokens |
| 534352 | USDC | `0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4` | 6 | 6 | OK | LI.FI /v1/tokens |
| 534352 | USDT | `0xf55BEC9cafDbE8730f096Aa55dad6D22d44099Df` | 6 | 6 | OK | LI.FI /v1/tokens |
| 534352 | WBTC | `0x3C1BCa5a656e69edCD0D4E36BEbb3FcDAcA60Cf1` | 8 | 8 | OK | LI.FI /v1/tokens |
| 534352 | WETH | `0x5300000000000000000000000000000000000004` | 18 | 18 | OK | LI.FI /v1/tokens |
| 11155111 | LINK | `0x779877A7B0D9E8603169DdbD7836e478b4624789` | 18 | 18 | OK | Chainlink docs |
| 11155111 | USDC | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` | 6 | 6 | OK | LI.FI /v1/tokens+Circle |
| 11155111 | WETH | `0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14` | 18 | 18 | OK | LI.FI /v1/tokens |
| 11155420 | USDC | `0x5fd84259d66Cd46123540766Be93DFE6D43130D7` | 6 | 6 | OK | LI.FI /v1/tokens+Circle |
| 11155420 | WETH | `0x4200000000000000000000000000000000000006` | 18 | 18 | OK | LI.FI /v1/tokens |

### Rincian 8 SYMBOL_DIFF (aman dipakai — decimals cocok, tampilkan symbol on-chain)

| chain | label sumber | symbol on-chain | catatan |
|---|---|---|---|
| 10 | USDC.e | `USDC` | label lama, kontrak memang USDC (bridged) |
| 25 | USDC.e | `USDC` | idem |
| 56 | WETH | `ETH` | BSC: symbol on-chain `ETH` |
| 137 | USDC.e | `USDC` | idem |
| 137 | USDT | `USDT0` | **5 RPC independen sepakat**: polygon-rpc.com, polygon-bor-rpc.publicnode.com, polygon.drpc.org, + 2 run awal → `symbol() = "USDT0"`, decimals 6 |
| 1101 | USDC.e | `USDC` | idem |
| 42161 | USDC.e | `USDC` | idem |
| 42161 | USDT | `USD₮0` | Tether di Arbitrum melapor `USD₮0` (decimals 6) |

### Chain TANPA curated list (address DILARANG dikarang)

| chain | alasan | bukti (2026-10-05) |
|---|---|---|
| 1284 Moonbeam | tidak ditemukan daftar token resmi | docs domain tak terjangkau + repo `moonbeam-foundation/moonbeam-docs` (push 2026-06-29) tidak memuat file token-address/USDC — S26 |
| 97 BNB testnet | tidak ditemukan daftar token resmi | LI.FI tolak 97 (S11), Circle tidak terbitkan (S22), 2 path docs BNB 404 (S27) |
| 11155111 (token selain USDC/WETH/LINK) | hanya Chainlink LINK yang punya halaman resmi khusus | S25; token lain diverifikasi hanya jika dari LI.FI (tabel) |
| Aptos | di luar scope | — |

### Temuan kode (read-only, TIDAK diubah)

- **Token list LI.FI untuk Sepolia LINK rusak — `js/network.js` BENAR**:
  `js/network.js:168` memuat `0x779877A7B0D9E8603169DdbD7836e478b4624789` =
  alamat resmi Chainlink (S25) dan lolos verifikasi on-chain (`decimals()=18`,
  `symbol()=LINK`, checksum valid, probe 2026-10-05).
  Yang salah adalah entri di LI.FI `/v1/tokens`: `0x779877A7B0D9E8603169DdbD7836e678b4624789`
  (1 karakter beda di posisi 32: `4` → `6`; checksum EIP-55 gagal) — probe `eth_getCode`
  = `0x0` (tidak ada kontrak). Kandidat ini sudah **dibuang** dari tabel; jangan menyalin
  LINK Sepolia dari token list aggregator.
- **`js/bridge.js` — validasi native-only**: `sameAddr(fromTok||ZERO, ZERO)` menolak semua
  ERC-20; approval flow harus dibangun mengikuti A2 sebelum ERC-20 bisa dipakai.
- **`js/routers.js` — `BRIDGE_ROUTERS` memuat 97 & 80002** padahal LI.FI menolak dua chain
  itu dengan 400 code 1011 (S11) → route testnet itu mustahil dapat quote.

---

## KONFLIK

**KONFLIK-1 — Angka rate limit LI.FI: 75 vs 200 (per `/quote`, tanpa API key)**
- S1 (llms.txt): 200 requests/2 hours.
- S4 (halaman rate-limits): 75 requests/2 hours.
- S9 (header live `ratelimit-limit: 75`): 75.
- **Pemenang: 75** — halaman aturan + header live dua bukti independen vs satu baris indeks
  llms.txt (indeks biasanya tidak ikut di-update). Anggap 75 sebagai batas aman.

**KONFLIK-2 — Polygon zkEVM (1101): disebut didukung tapi tidak ada di `/v1/chains`**
- S1 llms.txt menyebut Polygon zkEVM; S10 `/v1/chains` (70 chain) TIDAK memuat 1101, dan
  `/v1/tokens?chains=1101` → 400.
- **Pemenang: `/v1/chains` live** — endpoint itulah yang dipakai router saat membangun
  quote; llms.txt kemungkinan stale. Konsekuensi: jangan pasang 1101 di jalur LI.FI
  (pakai Symbiosis/Send untuk chain itu).

**KONFLIK-3 — `BRIDGE_ROUTERS` memuat 97 & 80002, LI.FI menolak**
- Kode: `js/routers.js` (1,10,56,97,137,8453,42161,80002,84532,421614,11155111,11155420).
- S11: 97 & 80002 → HTTP 400 code 1011; route testnet→testnet → 404 code 1002.
- **Pemenang: probe live.** Daftar chain perlu dibersihkan (buang 97 & 80002 dari jalur
  quote LI.FI, atau beri fallback lokal).

**KONFLIK-4 — Label symbol vs symbol on-chain (8 kasus)**
- S23/S24 label: `USDC.e`, `WETH`, `USDT`; on-chain: `USDC`, `ETH`, `USDT0`, `USD₮0`.
- **Pemenang: on-chain** — `symbol()` adalah kebenaran kontrak; label aggregator hanya
  metadata. Decimals tetap cocok di semua 8 kasus → token tetap valid dipakai.

**KONFLIK-5 — OpenAPI `GasCost type = APPROVE` "reserved" vs dokumentasi approval workflow**
- S6 (spec): tipe APPROVE reserved, tidak muncul di response live (S7 tidak memuatnya).
- S3 (docs): menyebut estimasi gas approval.
- **Pemenang: response live + spec** → jangan membaca `gasCosts[].type` untuk memutuskan
  approval; pakai `skipApproval` + `allowance()` on-chain.

**KONFLIK-6 — Entri LINK Sepolia: LI.FI `/v1/tokens` vs Chainlink docs**
- S23 (LI.FI token list): `0x779877A7B0D9E8603169DdbD7836e678b4624789` — checksum EIP-55
  gagal, `eth_getCode` = `0x0` (probe 2026-10-05).
- S25 (Chainlink resmi) + `js/network.js:168`: `0x779877A7B0D9E8603169DdbD7836e478b4624789`
  — kontrak ada, LINK/18, checksum valid.
- **Pemenang: penerbit token (Chainlink) + bukti on-chain.** Ini bukti keras bahwa token
  list aggregator wajib diverifikasi on-chain sebelum masuk tabel (metode Bagian C).

---

## SIMPUL

1. **Approve-flow Bear-Tool dibangun sendiri di wallet** (terbukti dari S6+S7): quote ERC-20
   hanya memberi `estimate.approvalAddress`; app baca `allowance()`, kirim `approve()`
   (reset-0 dulu untuk token tipe USDT per S3), lalu kirim `tx` hasil quote. Endpoint approve
   LI.FI **tidak ada** (terbukti: grep OpenAPI 418 KB).
2. **LI.FI cukup sebagai router primer** (indikasi kuat): keyless (S6), 70 chain EVM (S10),
   schema validation lengkap (S6/S7), rate 75/2jam cukup untuk tool manual (S9).
3. **Socket public jadi fallback tunggal** (indikasi kuat): satu-satunya alternatif keyless
   yang memberi blok `approval` terstruktur (S13), beda spender (0x50c4…5909) → redundansi
   bila LI.FI diamond down.
4. **Symbiosis = fallback kedua sekaligus sumber token** (terbukti): keyless (S17) dan
   satu-satunya sumber kandidat 1101 & 167000 yang lolos verifikasi on-chain (tabel).
5. **Squid, Wormhole(SR), deBridge, Across, Synapse, Jumper tidak dikejar** — masing-masing
   butuh id partnership (S15), endpoint mati (S18/S21), atau hanya UI LI.FI (S20).
6. **97 token lolos verifikasi on-chain di 24 chain** — 89 OK + 8 SYMBOL_DIFF; chain tanpa
   sumber resmi ditulis `no curated list` (1284, 97) tanpa mengarang address.
7. **3 perbaikan yang direkomendasikan**: (a) jangan pakai entri LINK Sepolia dari
   token list LI.FI (alamat tidak ada kontraknya — `js/network.js` sudah benar dengan
   `0x779877A7B0D9E8603169DdbD7836e478b4624789`); (b) cabut 97 & 80002 dari
   `BRIDGE_ROUTERS`; (c) longgarkan validasi native-only di `js/bridge.js` bila ERC-20 mau
   diaktifkan.

## RISIKO (asumsi belum terverifikasi)

- Angka rate limit & daftar chain bisa berubah sewaktu-waktu (snapshot 2026-10-05 saja).
- Klaim "relayer.wormhole.com deprecated" = **indikasi** (522 + dokumen migrasi), bukan
  pernyataan tertulis resmi.
- `no curated list` untuk Moonbeam/BSC-testnet = ketiadaan bukti setelah N sumber dicoba,
  bukan bukti ketiadaan (Moonbeam docs tak terjangkau dari jaringan ini).
- Symbol `USDT0` (137) dan `USD₮0` (42161) belum dicek ke halaman resmi Tether — hanya
  on-chain (5 RPC untuk 137).
- Ketersediaan likuiditas route (S11) bisa berubah; kegagalan testnet→testnet hari ini bukan
  larangan permanen.
- Kandidat dari Symbiosis/LI.FI untuk chain tanpa penerbit (1101, 167000) = vendor list,
  bukan canonical issuer; statusnya tetap verifikasi on-chain, bukan "canonical".

## BIAYA

- Integrasi: **$0** — LI.FI, Socket public, Symbiosis, Owlto semuanya keyless pada endpoint
  yang dipakai (S6/S13/S17/S19).
- API key LI.FI (limit lebih tinggi): tidak ada angka harga di halaman yang diperiksa —
  **tidak ditemukan dalam sumber yang diperiksa** (jangan menebak).
- Biaya tidak langsung: rate limit 75/2jam memaksa quote dibuat saat user menekan tombol
  (bukan polling), dan tidak boleh ada retry loop agresif.

## SUMBER TAMBAHAN (perlu dicek lebih dalam oleh DEV)

1. OpenAPI Socket v3 resmi (schema `approval` + status endpoint) — docs.socket.tech.
2. Swagger Symbiosis v2 `/v2/quote` (`crosschain/docs/`) — format request valid agar fallback-2 siap.
3. Docs Across resmi (`docs.across.to`) untuk endpoint quote publik yang benar.
4. Docs deBridge DLN resmi — memastikan base URL benar (probe lama 400).
5. Halaman Tether resmi untuk symbol/decimals USDT Polygon (137) & Arbitrum (42161).
6. Docs BNB Chain terbaru untuk token testnet 97 (path lama 404).
7. Repo `moonbeam-foundation/moonbeam-docs` (grep isi) atau mirror docs Moonbeam bila jaringan
   memungkinkan — untuk memastikan status 1284.

---

## RINGKASAN EKSEKUTIF

- **Approve-flow**: LI.FI tidak punya endpoint approval — bangun sendiri: quote → baca
  `estimate.approvalAddress` → cek `allowance()` → `approve()` (reset-0 untuk USDT) → kirim
  `tx`. `skipApproval:true` hanya untuk native; `tx.value` `0x0` untuk ERC-20 (S6/S7/S8).
- **Keyless & limit**: semua endpoint yang dipakai tanpa API key; `/quote` = **75 request /
  2 jam** (header live + halaman resmi mengalahkan angka 200 di llms.txt) → jangan polling.
- **Router**: cukup **LI.FI primer + Socket public fallback**; Symbiosis opsional karena
  sekaligus sumber token chain yang tak didukung LI.FI; Squid wajib integrator-id, Wormhole
  Standard Relayer mati (522), Jumper hanyalah UI LI.FI → semua di-skip.
- **Chain LI.FI**: 70 chain EVM — 43114/59144/534352/146/42220/100/5000/81457/324/130/480
  ✅; **1101, 167000, 1284 tidak ada**; **97 & 80002 ditolak 400** padahal tercantum di
  `BRIDGE_ROUTERS` → bersihkan daftar itu.
- **Token**: 97 baris di 24 chain lolos verifikasi on-chain (getCode + decimals + symbol +
  EIP-55) — 89 OK, 8 SYMBOL_DIFF (label `USDC.e`→`USDC`, `WETH`→`ETH`, `USDT`→`USDT0`/
  `USD₮0`) — semua tetap layak pakai asal menampilkan symbol on-chain.
- **Chain tanpa sumber resmi**: 1284 Moonbeam dan 97 BSC-testnet ditulis `no curated list`
  (docs Moonbeam tak terjangkau + repo docs tanpa file token; docs BNB 404) — address tidak
  dikarang.
- **Bug data (bukan di kode)**: entri LINK Sepolia di token list LI.FI salah 1 karakter
  (kontrak tidak ada, checksum gagal) — `js/network.js:168` sudah benar dengan alamat
  resmi Chainlink `0x779877A7B0D9E8603169DdbD7836e478b4624789`; jangan menyalin token list
  aggregator tanpa verifikasi on-chain.
- **Prioritas integrasi**: (1) longgarkan validasi native-only `js/bridge.js` + approval
  flow A2, (2) perbaiki LINK Sepolia + bersihkan chain list `BRIDGE_ROUTERS`, (3) tambah
  token dari tabel (mulai chain yang sudah ada di NETWORKS), (4) pasang Socket sebagai
  fallback bila LI.FI 404/429.
