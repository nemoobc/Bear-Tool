# Riset GitHub — Fitur Nyata Launchpad Meme-Token Open-Source

**Untuk:** Bear-Tool DEX Launchpad EVM (mobile, on-chain only, tanpa backend)
**Tanggal riset & akses semua URL:** 2026-10-15 (UTC)
**Metode:** GitHub Search API (6 query repo search, 2026-10-15) + 1 web search crosscheck → 12 repo di-`git clone --depth 1` → inspeksi kode langsung (baca fungsi, grep, baca file frontend). Klaim "fitur ada di kode" = diverifikasi ke fungsi/file, bukan hanya README.
**Batasan:** tidak ada audit keamanan kontrak; tidak ada eksekusi kode repo; bintang repo = snapshot saat akses.

---

## Ringkasan Eksekutif (5 temuan)

1. **Chart harga tanpa backend SUDAH terbukti bisa** — pola terbaik ada di GluedLaunch: `getLogs` inkremental (chunk 49k blok) → harga per trade = `ethSpent/tokensReceived` → candle OHLC dibangun di klien → render pakai TradingView `lightweight-charts`. File: `frontend/src/hooks/useTradeHistory.ts`, `frontend/src/components/PriceChart.tsx`.
2. **Holder list adalah celah terbesar.** Tidak ada satu pun repo yang menghitung holder murni dari RPC. Yang ada: Moralis API (pump-fun-clone-evm), Postgres indexer (openlaunch), mock (solana-launchpad-ui). Ini kandidat pembeda kita.
3. **Tren 2026 bergeser dari "curve + migrasi Uniswap" ke "pool Uniswap v4 langsung + posisi terkunci permanen"** (par/PairPad, openlaunch): 1 transaksi launch, tanpa kontrak bonding curve, phantom reserve meniru perilaku curve. Model 2024-2025 (migrasi V2 + burn LP) tetap valid untuk chain sederhana.
4. **Anti-sniper PREVENTION: nol dari semua repo yang diperiksa** (grep sniper/cooldown/maxTx/tradingEnabled di semua kontrak = kosong). openlaunch hanya *mendeteksi* sniper di panel holder. Peluang pembeda nyata.
5. **Tidak ada repo yang menuntaskan paket "chart + tape + holders tanpa backend" sekaligus.** GluedLaunch paling dekat (chart+tape klien penuh, tanpa holders, komentar pakai file server). openlaunch/par secara eksplisit butuh indexer di luar repo.

**Daftar fitur wajib terpendek (7 item):** create token, buy+sell dengan slippage/minOut, harga & progress on-chain, chart dari event, trade history (tape), fee breakdown di UI, wallet connect + RPC fallback. (Elaborasi di bagian 3.)

---

## 1) Daftar Repo

Tabel — urutan prioritas untuk kita. Kolom "Fitur inti (terverifikasi kode)" hanya memuat yang benar-benar ditemukan di source.

| # | Repo | Stack | Commit terakhir | Fitur inti terverifikasi (file kunci) |
|---|------|-------|-----------------|----------------------------------------|
| 1 | [qiwihui/build-pumpfun](https://github.com/qiwihui/build-pumpfun) (63★) | Solidity/Foundry | 2024-08-31 | create/buy/sell; curve eksponensial (expWad); uniswap pool + **burn LP**; fee bp + claim; minimal proxy — `src/TokenFactory.sol`, `src/BondingCurve.sol` |
| 2 | [kradkov14/launchpad-contracts](https://github.com/kradkov14/launchpad-contracts) (8★) | Solidity 0.8.28/Foundry | 2025-02-02 | proxy-factory (clone + logic terpisah); curve eksponensial (BASE_PRICE/EXP_FACTOR); **migrasi Uniswap V2 + distribusi LP**; pause; fuzz test — `src/Launchpad.sol`, `src/libraries/BondingCurve.sol` |
| 3 | [dappuniversity/fun-pump](https://github.com/dappuniversity/fun-pump) (49★) + **2 mirror identik** (lihat catatan) | Solidity+Hardhat+Next.js | 2024-11-27 | create/buy (tanpa sell); kurva tangga `getCost`; deposit/withdraw hasil; UI 1 halaman — `contracts/Factory.sol`, `app/page.js` |
| 4 | [bharathbabu3017/pump-fun-clone-evm](https://github.com/bharathbabu3017/pump-fun-clone-evm) (31★) | Solidity+Hardhat+React CRA+ethers v6 | 2026-09-14 | create (fee 0.0001 ETH); curve exp Taylor; buy; goal 24 ETH → **Uniswap V2 + burn LP**; holders/transfers via **Moralis API** — `hardhat/contracts/TokenFactory.sol`, `frontend/src/components/TokenDetail.jsx` |
| 5 | [anotheronefrombinary/GluedLaunch](https://github.com/anotheronefrombinary/GluedLaunch) (2★) | Solidity+Next.js+wagmi/viem+RainbowKit | 2026-02-22 | **chart+tape 100% client-side**; curve linier; collateral floor (burn→redeem ETH); graduasi V2 (10% reserved); transfer tax burn; vesting creator — `frontend/src/hooks/useTradeHistory.ts`, `frontend/src/components/PriceChart.tsx` |
| 6 | [pardotfamily/par / PairPad](https://github.com/pardotfamily/par) (8★) | Solidity/Foundry (Robinhood Chain 4663) | 2026-09-08 | **tanpa curve/migrasi**: pool v4 dibuka saat launch, supply 100% posisi terkunci tanpa withdraw; quote = ERC-20 apa pun; fee split protokol/creator + launch fee 0.0005 ETH — `contracts/src/v2/PairPadLaunchFactory.sol`, `PairPadLaunchLocker.sol` |
| 7 | [Twigpine/openlaunch](https://github.com/Twigpine/openlaunch) (34★) | Foundry+Next.js 16+wagmi3/**Postgres indexer** | 2026-10-15 (hari riset) | launch 1 tx: token+v4 pool+locker tanpa owner; creator fee 0/1/3% ke beneficiaries/burn; **no platform fee**; multi-chain; quote tokenized stock; holders & trust panel — `contracts/src/LaunchFactory.sol`, `contracts/src/LaunchLocker.sol`, `app/src/app/api/launch/*` |
| 8 | [nirholas/solana-launchpad-ui](https://github.com/nirholas/solana-launchpad-ui) (16★) | HTML/CSS/JS statis **MOCK** (tanpa chain) | 2026-10-10 | **checklist UI kanonik pump.fun**: board tab (trending/new/top), KOTH, activity ticker, kartu token + progress curve, panel trade (buy/sell, nominal cepat, slippage), chart SVG, komentar, profil — `index.html`, `token.html` |
| 9 | [UjjwalCodes01/degen-launcher](https://github.com/UjjwalCodes01/degen-launcher) (3★) | Solidity/Foundry+Next.js RainbowKit | 2026-08-06 | create/buy/closeSale/deposit/withdraw; fee di constructor; polling `useReadContract` 2 detik — `foundry/src/Factory.sol`, `frontend/src/hooks/useTokenData.ts` |

**Catatan mirror & duplikat (penting):** `0xkanazawa/pump-fun-evm` = **commit hash identik** dengan `dappuniversity/fun-pump` (5063a44c...) → copy; `gunjanghate/gg-pump-fun` = file set sama (commit 84734a58, 2025-06-02) → derivatif. Jadi baris #3 sebenarnya mewakili 3 repo publik. `g0drlc/Solidity-Pump.fun-Contracts` (disebut hasil websearch) **sudah tidak ada** — clone gagal "Repository not found" (2026-10-15).

**Honorable mention (tidak masuk tabel utama):** [0xtkm/pump-fun-clone](https://github.com/0xtkm/pump-fun-clone) (8★, Anchor/Solana — matematika curve `e^(k(1-ratio))` dengan stepping, bagus utk referensi rumus); [syedashar1/pump-fun](https://github.com/syedashar1/pump-fun) (10★, Anchor — pool in-contract + buy/sell); [m8s-lab/pump-fun-smart-contract](https://github.com/m8s-lab/pump-fun-smart-contract) (134★, TS, fork Solana pumpfun — bukan EVM); [topsecretagent007/pumpfun-smart-contract-frontend-backend](https://github.com/topsecretagent007/pumpfun-smart-contract-frontend-backend) (67★, full-stack Solana).

### Detail bukti per repo (file:baris)

**#1 build-pumpfun** — `src/TokenFactory.sol`: `createToken`(71), `buy`(83), `sell`(133), `createLiquilityPool`(158), `addLiquidity`(168), `burnLiquidityToken`(188 — LP dibakar), `calculateFee`(192), `feePercent` bp(32), `claimFee`(63). `src/BondingCurve.sol`: `getFundsReceived`(19), `getAmountOut`(36), pakai solady `expWad`(31) — curve eksponensial berbasis e^x. Ada alternatif `ConstantBondingCurve.sol` (linear). Test fork mainnet Uniswap (`test/TokenFactoryForked.t.sol`). README (CN): 3 operasi inti + checklist [x] minimal proxy, [x] bonding curve, [x] fork test. **Tanpa frontend. Tanpa anti-sniper. Tanpa sell-fee.**

**#2 launchpad-contracts** — `src/LaunchpadFactory.sol`: `createLaunchpad`(45), array `allLaunchpads`(20)+`allLaunchpadsLength`(78) (enumerasi utk frontend!), `pause/unpause`(85/92), `TOTAL_SUPPLY=1e9`(14). `src/Launchpad.sol`: `buyTokens(amountOutMin)`(83), `sellTokens`(120), `getEthersOutAtCurrentSupply`(148), `getTokensOutAtCurrentSupply`(157), `_migrateLiquidity`(187), events `LiquidityMigration`(43)/`TokenPurchase`(44)/`TokenSale`(45). `src/libraries/BondingCurve.sol`: `BASE_PRICE=30677636300`, `EXP_FACTOR=4000000`, Math64x64, `calculatePurchaseReturn`(36). README: proxy-factory, curve eksponensial, migrasi V2 + distribusi LP, 60% coverage. **Tidak ditemukan logika fee** (grep 'fee' di src hanya menemukan import SafeERC20) — fee = tidak diimplementasi. Tanpa frontend.

**#3 fun-pump (+2 mirror)** — `contracts/Factory.sol`: `getCost`(41) kurva **tangga harga**: floor 0.0001 ETH, step 0.0001 ETH per 10.000 token terjual (baris 42-46); `create`(50) dgn creator fee; `buy`(80); `deposit`(111)/`withdraw`(130) = mekanisme hasil sale (bukan AMM); events `Created`(27)/`Buy`(28). Frontend `app/page.js` 1 halaman: load factory(36), modal create, modal trade, fee(21). **Tanpa sell — model presale, bukan curve bolak-balik.**

**#4 pump-fun-clone-evm** — `hardhat/contracts/TokenFactory.sol`: `createMemeToken`(76), `calculateCost`(43)+`exp` Taylor(60), `buyMemeToken`(96), `getAllMemeTokens`(88), `_createLiquidityPool`(161), `_provideLiquidity`(168), `_burnLpTokens`(178). README: 6 fitur (launch 0.0001 ETH, curve exp, auto-list V2 + burn LP saat 24 ETH, explorer, holders/transfers Moralis, wallet EIP-1193). Frontend `TokenDetail.jsx`: progress funding goal, quote `calculateCost` via provider, **owners & transfers dari Moralis API (baris 39-62)** — dependensi pihak ketiga + API key di env frontend.

**#5 GluedLaunch** — kontrak `contracts/GluedLaunch.sol`: `createToken`(123), `buyTokens(token,minTokens)`(213), `graduateToUniswap`(269), `calculateTokensForETH`(332), `calculateETHForTokens`(378), `getCurrentPrice`(408), `getTokenInfo`(437), `getAllTokens`(469); events `TokenCreated`(59), `TokensPurchased`(74), `SaleEnded`(83), `TokenGraduated`(86). `GluedToken.sol`: transfer tax burn (`TransferTaxBurned` 70, `_update` hook 180), vesting creator (`getVestingInfo` 269). Frontend: `useTradeHistory.ts` (getLogs inkremental, MAX_RANGE=49_000 baris 27; poll from last+1 baris 85-93; paralel buy+sell baris 93-105; estimasi sell via getBalance historis baris 41-63; cache timestamp per blok baris 135-150; dedupe txHash ~155), `PriceChart.tsx` (lightweight-charts baris 4; timeframe 1m/5m/15m/1h/4h; `buildBuyPrices` = ethSpent/tokensReceived; OHLC dibangun sendiri), `tokens/page.tsx` (`getAllTokens`+`useReadContracts` multicall+refetch 10s), `TradingPanel.tsx` (slippage 5%(46), minTokens(147), fee breakdown 163-165 & 408-412). Wallet: `wagmi.config.ts` **fallback 3 RPC publik**.

**#6 par/PairPad** — README (verbatim inti): "no bonding curve contract and no migration… whole supply in one permanently locked position… single-sided position… is a constant-product curve with a phantom reserve… the pool that exists in the first second is the pool the token lives in forever". Fee: `launchFee` 0.0005 ETH (`PairPadLaunchFactory.sol`:205,308,480), `poolFeeFor(creatorTaxBps)` (base+creator tax, 1% default), `collectFees` permissionless (`PairPadLaunchLocker.sol`:214), split protokol 50% base fee (README). Kontrak lain: `PairPadLaunchDeployer` (`predictTokenAddress` CREATE2:88), `PairPadQuotePricer` (registries/paths, `quoteEconomics`:380), `PairPadRouter` (`buyWithEth`:179, `sellToEth`:196, `launchAndBuyWithEth`:239). **Indexer + UI + SDK di luar repo** (repo hanya protokol; klaim: "everything reproducible from the contracts and events").

**#7 openlaunch** — `contracts/src/LaunchFactory.sol`: `launch`(115) 1 tx → `LaunchToken` (fixed supply, no mint/pause/blacklist/tax) + pool v4 + position NFT → `LaunchLocker` (tanpa owner/pause/upgrade/transfer; "no withdraw"). `LaunchLocker.sol`: `collect`(137), `claim/claimFor`, events `Paid`(83)/`Burned`(84). README: fee platform = 0 ("no fee parameter exists"), creator pilih 0/1/3% fee trading → beneficiaries/burn; multi-chain Base/RH/Arc; quote asset termasuk tokenized stock (B20 Coinbase, Robinhood Stock Tokens); **indexer Postgres** utk launches/swaps/fees/transfers/holders; RPC proxy read-only (`app/src/app/api/rpc/route.ts` allowlist `eth_getLogs` dst; API key tetap di server); candles server-side (`api/launch/candles/route.ts` — respons berisi `baseline{price}`, "client fills gaps from baseline.price"); komponen: `TokenChart.tsx`, `TradingChart.tsx`, `LaunchTape.tsx`, `TokenTrades.tsx`, `HoldersPanel.tsx`, `TradePanel.tsx`. Anti-rug: adversarial fork suite + verified contracts.

**#8 solana-launchpad-ui** — README: "Static design template clone of pump.fun… No blockchain functionality — pure HTML/CSS/JS with mock data". 4 halaman (board/create/trade/profile), komponen: activity ticker, kartu progress curve, KOTH, panel trade + slippage, chart SVG placeholder, komentar, distribusi holder (mock), mobile-first breakpoint 480/768/1024. Pakai sebagai **checklist UI**, bukan referensi arsitektur.

**#9 degen-launcher** — `foundry/src/Factory.sol`: `getCost`(38) kurva tangga (sama keluarga fun-pump), `create`(47), `buy`(71), `closeSale`(98), `deposit`(107), `withdraw`(121), fee constructor(29). Frontend `useTokenData.ts`: `useReadContract` + `refetchInterval: 2000` (polling murni). Tutorial-grade; dicatat sebagai pola polling sederhana.

---

## 2) Pola Arsitektur Berulang (contoh file:path di repo mereka)

### 2.1 Chart & harga dari event — TANPA backend (pola paling penting untuk kita)

Tiga pendekatan ditemukan di lapangan:

| Pendekatan | Contoh | Butuh apa | Untuk kita |
|---|---|---|---|
| A. Event-scan inkremental + candle dibangun di klien | GluedLaunch: `frontend/src/hooks/useTradeHistory.ts` + `frontend/src/components/PriceChart.tsx` | Hanya RPC | ✅ pola utama |
| B. API server yang menghitung candle dari indexer | openlaunch: `app/src/app/api/launch/candles/route.ts` | Postgres indexer | ❌ tapi berguna sebagai spesifikasi bentuk data |
| C. API pihak ketiga (Moralis) | pump-fun-clone-evm: `frontend/src/components/TokenDetail.jsx:39-62` | API key + vendor | ❌ |

**Resep pola A (langkah demi langkah, terbukti di kode GluedLaunch):**
1. `getLogs` ber-chunk — RPC publik membatasi range; konstanta di kode mereka: `MAX_RANGE = 49_000n` (komentar: "most RPCs cap at 50k") → `useTradeHistory.ts:27`.
2. Scan awal sekali: `latestBlock - MAX_RANGE` (≈7 hari di Sepolia per komentar mereka); setelah itu poll hanya `lastBlock+1 .. latest` → baris 85-93.
3. Buy dan sell diambil paralel satu ronde `Promise.all([getLogs(buy), getLogs(sell)])` → baris 93-105.
4. Harga per trade buy = `ethSpent / tokensReceived` (`PriceChart.tsx`: `buildBuyPrices`) → deret waktu.
5. Candle OHLC dibangun di klien dari deret itu dengan agregasi interval `1m/5m/15m/1h/4h` (`TIMEFRAME_SECONDS`) → `buildCandles`.
6. Render pakai TradingView `lightweight-charts` (Area + Candlestick) → `PriceChart.tsx:4`.
7. Timestamp: simpan cache `Map<blockNumber, timestamp>` supaya `getBlock` tidak dipanggil berulang; dedupe trade per `txHash` saat merge → `useTradeHistory.ts:135-160`.

**Cara baca harga untuk panel trade (quote sebelum sign):** view function di kontrak, bukan simulasi off-chain rumit — `calculateCost(totalSupply, amount)` (pump-fun-clone-evm `TokenDetail.jsx`), `getTokensOutAtCurrentSupply` (launchpad-contracts `ILaunchpad.sol`), `calculateTokensForETH` (GluedLaunch).

**Bentuk data candle versi server (openlaunch) — tiru formulirnya, hitung sendiri di klien:** respons berisi `{interval, from, asOf, baseline:{price, hasPriorTrades}, launch:{t, price}, supply, candles[]}` dan komentar resmi di kode: *"The client fills gaps from baseline.price"* (`api/launch/candles/route.ts`). Artinya: kirim titik-baseline + candle sparse, klien menambal gap — strategi yang sama valid untuk klien murni RPC (isi `baseline` dari view function `getCurrentPrice`).

**KELEMAHAN POLA A yang wajib kita hindari:** event sell GluedLaunch TIDAK memuat nilai ETH yang dikembalikan → kode mereka mengestimasi sell via `getBalance(glueAddress, blockNumber) * realAmount / afterTotalSupply` (query saldo historis, baris 41-63) — tidak presisi. **Pelajaran desain kontrak untuk kita: event `Sell` harus membawa `ethOut` + `newTokensSold`/harga eksekusi agar chart & tape akurat 100% dari event, tanpa query historis.**

### 2.2 Daftar token (board/list) tanpa backend

- **Pola view-array + multicall (paling umum & paling murah):** factory menyimpan array token on-chain, klien memanggil `getAllTokens()` lalu `useReadContracts` (batch multicall) untuk detail per token, refresh via `refetchInterval`.
  - GluedLaunch: `frontend/src/app/tokens/page.tsx` (`getAllTokens` + `useReadContracts` + `refetchInterval: 10_000`).
  - launchpad-contracts: `src/LaunchpadFactory.sol` (`allLaunchpads` array + `allLaunchpadsLength`).
  - fun-pump/degen: `tokens[]` + `getTokenSale(index)`.
- **Pola event-scan `TokenCreated` murni di klien: TIDAK DITEMUKAN** di repo yang diperiksa. Yang ada: indexer server (openlaunch, par) atau API pihak ketiga. → Artinya ini area kosong: kalau factory kita TIDAK menyimpan array (lebih murah gas), kita harus membangun scan chunked `TokenCreated` sendiri; kalau menyimpan array, ikut pola dominan (multicall). Keputusan sadar, bukan ikut-ikutan.

### 2.3 Holder list — tiga cara yang ada, nol yang murni RPC

1. **API pihak ketiga:** Moralis `/erc20/{token}/owners` — pump-fun-clone-evm `frontend/src/components/TokenDetail.jsx:39-53` (API key frontend — risiko bocor).
2. **Indexer server:** openlaunch — Postgres indexer semua `Transfer`; panel berisi holder count, top-10 share, creator sells, launch-window snipers, locked-pool share (`api/launch/holders/route.ts` + README).
3. **Mock UI:** solana-launchpad-ui `token.html` (tab holder distribution tanpa data nyata).

Konsisten di semua repo: yang butuh holder serius, semuanya bayar dengan indexer/vendor. **Belum ada yang menghitung holder dari `Transfer` events langsung di klien (dengan cursor + cache). Ini celah yang kita isi.**

### 2.4 Fee model & cara menampilkannya

- **Kontrak:** `build-pumpfun` = `feePercent` bps saat buy & sell + `claimFee()` owner (`src/TokenFactory.sol:32,59,63,92-99,145-147`); `par` = `launchFee` 0.0005 ETH + `poolFeeFor(creatorTaxBps)` (base 1% + creator tax opsional) dengan split protokol 50% (`PairPadLaunchFactory.sol:205,308,480`; `PairPadLaunchLocker.sol:214`; README); `openlaunch` = tanpa fee platform, creator fee 0/1/3% → beneficiaries/burn (`LaunchLocker.sol` events `Paid`/`Burned`); `launchpad-contracts` = **tidak ada fee**.
- **UI:** tampilkan **breakdown fee sebagai baris terpisah sebelum konfirmasi** — GluedLaunch `TradingPanel.tsx:163-165` menghitung `protocolFee = grossETH*0.001`, `platformFee = grossETH*0.02`, `netETH`; ditampilkan di baris 408-412. Slippage state + `minTokens = est * (100 - slippage)/100` (baris 46/147).

### 2.5 Graduasi: dua model arsitektur (V2-migrate vs v4-locker)

- **Model lama (2024-2025) — curve lalu migrasi:** kumpulkan ETH di curve → di ambang, buat pair Uniswap V2, tambah likuiditas, **burn LP** — jaminan likuiditas tidak bisa ditarik. Contoh: `build-pumpfun` (`burnLiquidityToken` 188), `pump-fun-clone-evm` (`_burnLpTokens` 178, goal 24 ETH), `launchpad-contracts` (`_migrateLiquidity` 187), `GluedLaunch` (`graduateToUniswap` 269, 10% supply disisihkan).
- **Model 2026 — tanpa curve, tanpa migrasi:** pool Uniswap v4 dibuka pada transaksi launch, seluruh supply masuk satu posisi single-sided yang terkunci permanen; "curve" disimulasikan phantom reserve. par: *"single-sided position… is a constant-product curve with a phantom reserve… pool that exists in the first second is the pool the token lives in forever"* (README par); openlaunch: locker tanpa owner/pause/upgrade/withdraw (`LaunchLocker.sol`).
- Implikasi: model 2026 menghapus kontrak curve + momen graduasi (titik eksploitasi klasik: front-run migrasi, snipe pool pertama), tapi bergantung pada infra v4 + PositionManager chain setempat. Untuk target awal (chain EVM sederhana, mobile, tanpa backend) model lama lebih portabel; pindah v4 saat chain target mendukung.

### 2.6 Real-time (poll, bukan websocket)

Tidak ditemukan `watchEvent`/websocket di repo yang diperiksa. Norma: polling. Interval terlihat: 2 dtk (degen `useTokenData.ts:27`), 5 dtk (GluedLaunch halaman token), 10 dtk (GluedLaunch list). openlaunch: "One poller feeds the list, the trending strip, the tape…" (README) — satu poller terpusat, bukan banyak timer. **Untuk mobile: satu poller + cursor per-query adalah pola yang benar; hindari N interval paralel.**

### 2.7 Metadata token

- Simpan on-chain sebagai argumen create (`imageUrl`, `description`) — pump-fun-clone-evm `createMemeToken` (76).
- Edit metadata bertanda tangan via server — openlaunch ("signed metadata edits", API `edit/nonce`).
- IPFS disiapkan di frontend — degen-launcher `frontend/src/lib/ipfs.ts` (keberadaan file terverifikasi; isi belum diaudit).

---

## 3) Fitur WAJIB vs NICE-TO-HAVE

Kriteria "wajib" = (a) ditemukan di mayoritas repo serius, DAN (b) tanpa itu loop inti user (launch → beli → jual → lihat posisi) rusak. "Nice" = menambah kualitas tapi bisa menyusul tanpa mengubah arsitektur.

### WAJIB — 10 fitur (versi terpendek: 7 pertama)

| # | Fitur | Bukti di repo | Catatan implementasi kita |
|---|-------|---------------|---------------------------|
| W1 | **Create token** via factory (nama, simbol, metadata) | semua repo | factory + event `TokenCreated` untuk discovery |
| W2 | **Buy + SELL dari/ke pool** (bukan presale) | `sell` build-pumpfun(133); `sellTokens` launchpad-contracts(120); `sellToEth` par(196); openlaunch (pool v4 dua arah); GluedLaunch = jual lewat burn→redeem 'unglue' (kontrak Glue eksternal) | **fun-pump, pump-fun-clone-evm, degen-launcher TANPA sell — jangan ditiru** (grep 2026-10-15) |
| W3 | **Quote on-chain + slippage minOut** di setiap trade | GluedLaunch `buyTokens(token, minTokens)` 213; launchpad-contracts `amountOutMin`; par router | tombol disabled saat quote gagal; tampilkan harga eksekusi estimasi |
| W4 | **Harga sekarang + progress** (terjual / raised / % curve) dari view function | GluedLaunch `getTokenInfo` 437; launchpad-contracts `getEthersOut…` 148; pump-fun-clone-evm progress bar | 1 view function gabungan = 1 RPC call (mobile friendly) |
| W5 | **Chart harga dari event** (minimal line; candle bagus) | GluedLaunch `PriceChart.tsx` | pola A di 2.1; event `Sell` wajib bawa `ethOut` |
| W6 | **Trade history / tape** (buy/sell + waktu + trader + nominal) | GluedLaunch `TradeHistory.tsx`; openlaunch `LaunchTape.tsx` (server) | dari event yang sama dengan chart; timestamp cache |
| W7 | **Fee breakdown di UI sebelum konfirmasi** + slippage control | GluedLaunch `TradingPanel.tsx:163-165,408-412` | estimasi fee dari parameter kontrak yang dibaca on-chain |
| W8 | **Wallet connect + network guard + RPC fallback** | GluedLaunch `wagmi.config.ts` (fallback 3 RPC) | mobile: WalletConnect deep-link; fallback RPC = wajib untuk polling getLogs |
| W9 | **Status likuiditas/graduasi terkunci** (burn LP atau locker tanpa withdraw) | semua repo (V2 burn / v4 locker) | tampilkan status "liquidity locked" di UI = trust signal |
| W10 | **Data layer event: chunked getLogs + cursor + cache + dedupe** | GluedLaunch `useTradeHistory.ts` | fondasi W5/W6; satu modul dipakai semua fitur |

### NICE-TO-HAVE (urut dampak)

1. **Holder list / distribusi** — belum ada implementasi murni-RPC di repo manapun (lihat 2.3 & celah #1). Kandidat pembeda.
2. **Candle multi-timeframe (1m..4h)** — GluedLaunch sudah punya; port mudah setelah W5 ada.
3. **Anti-sniper prevention** (limit beli blok-1 / fee decay / delay) — NOL implementasi di repo yang diperiksa (grep semua kontrak). Pembeda bila kita kerjakan (celah #3).
4. **Anti-rug ekstra:** collateral floor redeem/burn (GluedLaunch), creator vesting (GluedLaunch `getVestingInfo` 269), transfer tax burn (GluedToken `_update` 180), adversarial fork test (openlaunch).
5. **Trending / King-of-the-Hill / watchlist** — UI template `solana-launchpad-ui` (mock) + openlaunch (indexer).
6. **Multi-quote asset / tokenized stock** — par & openlaunch; fitur kelas 2026, kompleks, tunda.
7. **Comments/posts** — openlaunch (wallet-signed, server), GluedLaunch (file JSON server) — TIDAK cocok untuk no-backend; tunda atau local-only.
8. **Creator dashboard (klaim fee, edit metadata)** — openlaunch; butuh auth wallet + data kaya.
9. **Points/gamifikasi, bridge, earn/Morpho** — openlaunch; jelas di luar scope MVp.

---

## 4) Celah yang TIDAK Mereka Selesaikan (Pembeda Kita)

1. **Holder list murni RPC.** Semua yang serius pakai indexer/vendor (Moralis/openlaunch/par). Tidak ada contoh klien menghitung holder dari `Transfer` events. → Pembeda: per-token cursor (block deploy → sekarang), scan chunked, agregasi balance di klien, cache incremental di penyimpanan lokal. Khusus token muda (event sedikit) ini realistis di mobile; untuk token ramai, batasi top-N atau window terakhir + sampling.
2. **Chart/tape akurat untuk SELL tanpa query historis.** GluedLaunch mengakali dengan `getBalance` historis (tidak presisi, bisa gagal di RPC tertentu). → Pembeda: desain event kontrak kita `Sell(buyer, tokenAmount, ethOut, newSupply)` → semua angka chart/tape langsung dari log. Keunggulan yang lahir dari kita yang mengontrol kontrak.
3. **Anti-sniper prevention: kosong di semua repo.** Yang ada hanya deteksi (openlaunch "launch-window snipers" di panel). → Pembeda: mekanisme kontrak (contoh arah: limit nominal per wallet per blok pertama, fee awal yang dibakar, atau delay trade 1 blok) + indikator visual "protected launch" di UI.
4. **Paket lengkap tanpa backend belum ada.** GluedLaunch (terdekat): chart+tape klien, tapi tanpa holders; komentarnya pakai file server. openlaunch/par: jujur mengakui butuh indexer. → Positioning kita: "100% on-chain, data dari event + RPC, tanpa server" belum diklaim/dibuktikan siapa pun untuk paket trading lengkap. Klaim ini harus diuji beban (RPC budget per user) sebelum dipasarkan.
5. **Mobile nyata: nol.** Semua implementasi trading = web desktop; satu-satunya mobile-first adalah template mock. → Pembeda: trade UX mobile (bottom-sheet, ticker ringkas, quick-buy preset, haptic) sebagai identitas produk.
6. **Riwayat chart tumbuh terbatas window RPC.** GluedLaunch hanya men-scan ~49k blok terakhir (≈7 hari Sepolia, komentar mereka sendiri) → riwayat lama hilang. → Pembeda: simpan cursor + agregat candle ke penyimpanan lokal (IndexedDB) → riwayat tumbuh selama dipakai; saat dibuka dari device baru, mulai dari window RPC.
7. **Fee/trust display masih sepi di repo murni-RPC.** Yang rapi (openlaunch) bergantung server; GluedLaunch menampilkan fee tapi *tidak sinkron* dengan README (lihat Konflik). → Pembeda: fee breakdown yang dibaca langsung dari parameter kontrak (bukan hardcode) + halaman "trust" (LP locked, tax, vesting) dihitung dari view functions.

---

## Konflik & Catatan Verifikasi

- **KONFLIK GluedLaunch (README vs kode UI):** README menyatakan "Platform Fee — 2% fee on collateral withdrawals (unglue)… No fees on buying", tetapi `TradingPanel.tsx:163-165` menghitung `protocolFee 0.1% + platformFee 2%` pada alur **beli**, dan menampilkannya (baris 408-412). Kode UI lebih kuat dari README (aturan bukti). Kemungkinan: inkonsistensi repo sendiri; fee sesungguhnya kemungkinan hidup di hook Glue Protocol eksternal (komentar `GluedLaunch.sol:96` menyebut "platform fees from token hooks" — tidak terverifikasi lebih jauh di repo ini). **Pelajaran: jangan dokumentasikan fee yang tidak dipakai; satu sumber kebenaran (parameter kontrak → UI).**
- **fun-pump / pump-fun-evm / gg-pump-fun = satu sumber.** Commit hash identik `5063a44c…` untuk dua yang pertama; ketiga salinan file set sama. Hitung sebagai 1 repo, jangan hitung 3 "implementasi".
- **g0drlc/Solidity-Pump.fun-Contracts tidak lagi dapat diakses** (clone gagal, 2026-10-15) — jangan dijadikan referensi.
- **Batas klaim:** semua "fitur ada" = bukti statik (kode terbaca). Tidak ada repo yang dieksekusi/diuji runtime dalam riset ini; kualitas keamanan & gas tidak dinilai; tidak ada audit. Angka bintang = snapshot 2026-10-15.

## Sumber (URL + tanggal + tipe + kelemahan)

| ID | Sumber | Tgl commit | Tipe | Kelemahan |
|----|--------|-----------|------|-----------|
| S1 | https://github.com/qiwihui/build-pumpfun | 2024-08-31 | repo (kode tersetup foundry) | ⚠️ 2 tahun; tanpa frontend; tanpa sell-fee; README CN |
| S2 | https://github.com/kradkov14/launchpad-contracts | 2025-02-02 | repo | tanpa frontend; tanpa fee; coverage 60% (badge) |
| S3 | https://github.com/dappuniversity/fun-pump | 2024-11-27 | repo | ⚠️ tutorial; tanpa sell; tanpa test UI |
| S4 | https://github.com/bharathbabu3017/pump-fun-clone-evm | 2026-09-14 | repo | holder via Moralis (API key di frontend); TANPA fungsi sell di kontrak (grep `sell` kosong, 2026-10-15) |
| S5 | https://github.com/anotheronefrombinary/GluedLaunch | 2026-02-22 | repo | 2★; addresses placeholder; komentar butuh file server; konflik fee README vs UI |
| S6 | https://github.com/pardotfamily/par | 2026-09-08 | repo + README arsitektur | UI/indexer/SDK di luar repo; chain spesifik (Robinhood 4663); PowerShell scripts |
| S7 | https://github.com/Twigpine/openlaunch | 2026-10-15 | repo + README | butuh Postgres indexer untuk fitur penuh; kompleks (v4, multi-chain) |
| S8 | https://github.com/nirholas/solana-launchpad-ui | 2026-10-10 | repo UI (mock) | TANPA blockchain; data mock; bukan referensi arsitektur |
| S9 | https://github.com/UjjwalCodes01/degen-launcher | 2026-08-06 | repo | tutorial-grade; polling 2 dtk boros; tanpa sell |
| S10 | https://github.com/0xtkm/pump-fun-clone | 2025-01-29 | repo (Solana) | bukan EVM; hanya referensi matematika curve |
| S11 | https://github.com/syedashar1/pump-fun | 2025-01-12 | repo (Solana) | bukan EVM |
| S12 | GitHub Search API (repository search, 6 query: "pump.fun clone", "pumpfun", "meme coin launchpad", "token launchpad solidity", "bonding curve launchpad", "fair launch dex") | 2026-10-15 (akses) | API | ranking by stars ≠ kualitas; repo tanpa deskripsi terlewat |

Tidak ditemukan dalam sumber yang diperiksa: implementasi klien holder-list murni RPC; anti-sniper on-chain; websocket/event-subscription di frontend.

## Metodologi

1. Discovery: GitHub Search API (6 query, sort=stars, per_page=12) + 1 web search crosscheck.
2. Seleksi: prioritaskan kontrak bonding-curve/AMM EVM + frontend trading; buang bot/scraper/SDK non-launchpad; buang repo tanpa kode.
3. Verifikasi: 12 repo di-`git clone --depth 1` (2026-10-15) → `git log -1` untuk tanggal commit → baca fungsi kontrak (grep `function/event/struct`) → baca file frontend kunci → README hanya sebagai pelengkap, bukan bukti utama.
4. Semua path file di laporan ini relatif terhadap root masing-masing repo.
