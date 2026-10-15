# RISET: Peta Fitur + UX Meme-Token Launchpad 2025–2026 (untuk DEX Launchpad Mobile-First EVM, Tanpa Backend)

- Tanggal riset: 2026-10-15 (semua URL diakses 2026-10-15 kecuali disebut lain)
- Tujuan: dasar keputusan membangun ulang UX DEX launchpad kita (EVM, AMM pool x*y=k, read/write on-chain via RPC, Android WebView, ID+EN, tanpa backend/indexer)
- Scope: fitur + flow + label UI + pola UX terukur + anti-pattern + repo OSS. BUKAN riset kontrak/harga token.
- Catatan metode: kutipan label UI diambil dari dokumentasi resmi, GitBook platform, panduan pihak ketiga yang menyebut label literal, dan App Store/Reddit untuk komplain. Skeptisisme tingkat sumber dicatat per baris (skor 1–5: 5=dokumentasi resmi, 3=panduan pihak ketiga/agregator, 2=komunitas/forum, 1=spekulatif).

---

## 1) SUMBER & TANGGAL

### Sumber primer (dokumentasi resmi platform)

| # | Sumber | URL | Tgl (konten) | Akses | Tipe | Skor |
|---|--------|-----|---------------|-------|------|------|
| S1 | pump.fun Docs — Fees | https://pump.fun/docs/fees | Last Updated 08 Okt 2026 | 2026-10-15 | docs resmi | 5 |
| S2 | Pump.fun Help Center — Transaction Fees | https://intercom.help/pumpfun-web/en/articles/11002413-transaction-fees-on-pump-fun | 2025 (revisi berjalan) | 2026-10-15 | docs resmi | 5 |
| S3 | Four.meme GitBook — How it works | https://four-meme.gitbook.io/four.meme/guide/how-it-works | 2025–2026 (living doc) | 2026-10-15 | docs resmi | 5 |
| S4 | Sun.io Docs — SunPump Service Fees | https://docs.sun.io/protocols/sunpump/concepts/service-fees | 2025–2026 | 2026-10-15 | docs resmi | 5 |
| S5 | Virtuals Whitepaper — Launch Mechanics | https://whitepaper.virtuals.io/about-virtuals/capital-formation-layer/virtuals-launch-mechanics | 25 Agu 2026 | 2026-10-15 | docs resmi | 5 |
| S6 | Bags.fm — How it works (snippet) | https://bags.fm/how-it-works | 2025–2026 | 2026-10-15 | web resmi | 4 |
| S7 | Bags.fm — Apps/Curve (snippet) | https://bags.fm/apps | 2025–2026 | 2026-10-15 | web resmi | 4 |
| S8 | Clanker — situs resmi | https://www.clanker.world/ | 2026 | 2026-10-15 | web resmi | 4 |
| S9 | Ethervista — situs resmi | https://www.ethervista.app/ | 2026 ("acquired by Arctide") | 2026-10-15 | web resmi | 3 |
| S10 | GMGN Docs — Meme Trading Guide | https://docs.gmgn.ai/index/gmgn-meme-trading-guide | 2025–2026 | 2026-10-15 | docs resmi | 4 |
| S11 | TokenPocket Help — Four.Meme User Guide | https://help.tokenpocket.pro/en/wallet-operation/how-to-trade-on-dex/four-meme | 2025–2026 | 2026-10-15 | docs resmi wallet | 4 |
| S12 | Uniswap Support — Price Impact vs Slippage | https://support.uniswap.org/hc/en-us/articles/8643794102669-Price-Impact-vs-Price-Slippage | 11 Feb 2025 | 2026-10-15 | docs resmi | 5 |
| S13 | Uniswap Support — What is price impact? | https://support.uniswap.org/hc/en-us/articles/40074715860365-What-is-price-impact | 8 Des 2025 | 2026-10-15 | docs resmi | 5 |
| S14 | Android Accessibility — Touch target size (48dp) | https://support.google.com/accessibility/android/answer/7101858 | living doc | 2026-10-15 | docs resmi | 5 |
| S15 | (kena blokir/anti-bot) Four.meme GitBook versi .md | https://four-meme.gitbook.io/four.meme/guide/how-it-works.md | — | 2026-10-15 | mirror dok | — |

### Sumber analis/agregator (sekunder, untuk angka & konteks)

| # | Sumber | URL | Tgl (konten) | Akses | Tipe | Skor |
|---|--------|-----|---------------|-------|------|------|
| S16 | Smithii — pump.fun creator fees 2026 (tabel fee per fase) | https://smithii.io/en/pump-fun-creator-fees/ | 8 Sep 2026, upd 13 Okt 2026 | 2026-10-15 | blog analis | 3 |
| S17 | Smithii — Project Ascend (dynamic fees) | https://smithii.io/en/project-ascend-update/ | 3 Sep 2025, upd 20 Jun 2026 | 2026-10-15 | blog analis | 3 |
| S18 | Smithii — How to launch on Pump.fun (field form) | https://smithii.io/en/how-to-launch-a-meme-coin-on-pump-fun/ | 31 Jul 2025, upd 8 Sep 2026 | 2026-10-15 | blog analis | 3 |
| S19 | SolTokenCreator — Pump.fun Fees 2026 | https://www.soltokencreator.io/blog/pump-fun-fees-explained | 9 Mar 2026 | 2026-10-15 | blog vendor | 2 |
| S20 | Blofin — Pump.fun graduation fee | https://blofin.com/academy/education/pumpfun/pump-fun-graduation-fee-explained | 2026 | 2026-10-15 | blog exchange | 2 |
| S21 | Blofin — "zero-fee" app vs 1.25% | https://blofin.com/en/academy/education/pumpfun/pump-fun-app-zero-fee-trading | 26 Sep 2026 | 2026-10-15 | blog exchange | 2 |
| S22 | Coinspeaker via Yahoo — "Pump.fun Admits Creator Fees Failed" | https://finance.yahoo.com/news/pump-fun-admits-creator-fees-160120983.html | 10 Jan 2026 | 2026-10-15 | berita | 3 |
| S23 | BingX Learn — LetsBONK.fun | https://bingx.com/en/learn/article/what-is-lets-bonk-fun-launchpad-and-how-to-launch-your-meme-token | 6 Mei 2025, upd 25 Des 2025 | 2026-10-15 | blog exchange | 3 |
| S24 | Datawallet — Moonshot app explained | https://www.datawallet.com/crypto/moonshot-app-solana-explained | upd 6 Jul 2026 | 2026-10-15 | blog analis | 3 |
| S25 | Solana Compass — Moonshot | https://solanacompass.com/projects/moonshot | Sep 2026 | 2026-10-15 | direktori | 3 |
| S26 | Dev.to — Bags.fm (detail API/feeShares) | https://dev.to/sivarampg/bagsfm-the-solana-launchpad-thats-changing-creator-monetization-4g7n | 12 Jan 2026 | 2026-10-15 | blog komunitas | 2 |
| S27 | Binance Square — penjelasan mekanisme pump.fun (label UI) | https://www.binance.com/en/square/post/15600492237666 | 2024–2025 | 2026-10-15 (snippet) | posting edukasi | 2 |
| S28 | Protos — Four.meme exploit $130K | https://protos.com/binance-memecoin-platform-four-meme-exploited-again-this-time-for-130k/ | 18 Mar 2025 | 2026-10-15 | berita | 3 |
| S29 | CryptoPotato — Four.meme suspend launch | https://cryptopotato.com/four-meme-suffers-another-security-breach-130k-stolen-in-latest-attack/ | 18 Mar 2025 | 2026-10-15 | berita | 3 |
| S30 | CoinMarketCap Academy — Clanker $13M revenue | https://coinmarketcap.com/academy/article/clanker-achieves-dollar13-million-in-revenue-from-200000-tokens-on-base-in-five-months | 4 Apr 2025 | 2026-10-15 | media | 3 |
| S31 | OKX Learn — Clanker (fee split 40%) | https://www.okx.com/en-us/learn/what-is-tokenbot-clanker-exploring-the-autonomous-meme-coin-launchpad | 8 Apr 2025 | 2026-10-15 | blog exchange | 3 |
| S32 | Crypto.news — Clanker ecosystem fund | https://crypto.news/clanker-launches-ecosystem-fund-to-recycle-fees-into-creators-and-community/ | 3 Apr 2026 | 2026-10-15 | berita | 3 |
| S33 | BingX Learn — Clanker ($8M fees/minggu awal 2026) | https://bingx.com/en/learn/article/what-is-tokenbot-clanker-ai-agent-launchpad-on-base-how-to-buy | 11 Feb 2026 | 2026-10-15 | blog exchange | 2 |
| S34 | The Defiant — LetsBONK flips Pumpfun | https://thedefiant.io/news/tokens/letsbonk-flips-pumpfun-as-solana-s-top-memecoin-launchpad | 8 Jul 2025 | 2026-10-15 | berita | 3 |
| S35 | Yahoo/CoinDesk — LetsBonk 74% launches harian | https://finance.yahoo.com/news/pump-surges-meme-coin-launchpad-174939410.html | 11 Agu 2025 | 2026-10-15 | berita | 3 |
| S36 | Binance Square — pump.fun share kembali 81,2% | https://www.binance.com/en/square/post/29541973595418 | 11 Sep 2025 | 2026-10-15 | posting | 2 |
| S37 | StakePoint — LetsBonk vs Pump.fun 2026 | https://stakepoint.app/blog/letsbonk-fun-vs-pump-fun-2026 | 31 Agu 2026 | 2026-10-15 | blog | 2 |
| S38 | Dune — Memecoin Wars dashboard | https://dune.com/adam_tehc/memecoin-wars | data s/d 22 Sep 2026 | 2026-10-15 | dashboard | 3 |
| S39 | Webopedia — LetsBonk.fun | https://www.webopedia.com/crypto/learn/lets-bonk-fun-memecoin-launchpad/ | 5 Agu 2025 | 2026-10-15 (snippet; halaman 403) | blog | 2 |
| S40 | Bitquery Docs — Four.meme API (stage token) | https://docs.bitquery.io/docs/blockchain/BSC/four-meme-api/ | 2025–2026 | 2026-10-15 | docs API | 3 |
| S41 | Codex API Docs — Four.meme (stage Created/Completing/Completed) | https://docs.codex.io/launchpads/four-meme | 2026 | 2026-10-15 | docs API | 3 |
| S42 | Raydium Launchpad — halaman token BONK (label "Graduates at $45,668.06") | https://raydium.io/launchpad/token/?mint=GSUPDJeoRYYSjCqX7GFru7ufRnivwi1StxXC7G3wbonk | 2025 | 2026-10-15 | halaman resmi | 3 |

### Sumber komunitas (komplain/pengalaman user — untuk anti-pattern)

| # | Sumber | URL | Tgl (konten) | Akses | Tipe | Skor |
|---|--------|-----|---------------|-------|------|------|
| S43 | Reddit r/solana — "Unsupported Region - Moonshot" | https://www.reddit.com/r/solana/comments/1i4peit/unsupported_region_moonshot/ | Jan 2025 | 2026-10-15 (snippet) | forum | 2 |
| S44 | Reddit r/solana — "Moonshot App Stole my money?" | https://www.reddit.com/r/solana/comments/1i4pu4e/moonshot_app_stole_my_money/ | Jan 2025 | 2026-10-15 (snippet) | forum | 2 |
| S45 | Reddit r/solana — "Warning: Avoid Moonshot App" | https://www.reddit.com/r/solana/comments/1iau3te/warning_avoid_moonshot_app_lost_funds_and_no/ | Jan 2025 | 2026-10-15 (snippet) | forum | 2 |
| S46 | App Store — review Moonshot (fee "ridiculous") | https://apps.apple.com/us/app/moonshot/id6503993131?see-all=reviews | rolling | 2026-10-15 (snippet) | review | 2 |
| S47 | Reddit r/solana — "Beware of scams on pump.fun" | https://www.reddit.com/r/solana/comments/1cf31ao/beware_of_scams_on_pumpfun/ | Apr 2024 | 2026-10-15 (snippet) | forum | 2 |
| S48 | X Trending — "Solana Traders Frustrated with Pump.fun's Creator Fee…" | https://x.com/i/trending/1996357322336030785 | 3 Des 2025 | 2026-10-15 (snippet) | agregat X | 2 |

### Sumber yang GAGAL diakses (dicatat untuk transparansi)
- cryptoslate.com/launchpads/four-meme-review/ → HTTP 403
- intercom.help pumpfun (artikel fee) → HTTP 405 (dibaca via snippet mesin pencari)
- webopedia letsbonk → HTTP 403 (dibaca via snippet)
- old.reddit.com thread Moonshot → render kosong (dibaca via snippet)
- pump.fun/docs/fees full page → tertutup modal persetujuan (angka dibaca via snippet + S16/S19)

---

## 2) MATRIKS FITUR PER PLATFORM

Legenda: ✅ ada · ⚠️ parsial/kondisional · ❌ tidak ada/kontra · — tidak ditemukan dalam sumber yang diperiksa · (S#) = sumber di bagian 1.

| Fitur | pump.fun + PumpSwap | four.meme (BSC) | Moonshot | SunPump (Tron) | bags.fm | Bonk.fun / letsbonk | Virtuals | Clanker (EVM/Base) | Ethervista (EVM/ETH) |
|---|---|---|---|---|---|---|---|---|---|
| **Field create** | Name, Ticker, Description, Image, social links; metadata immutable (S18) | Token Name, Ticker Symbol, Description, Raised Token (BNB/USDT/USD1/UUSD/bStocks), Logo, Socials; supply preset 1 M (S3) | "Moonshot Create" di dalam app; jalur termudah ke Verified (S25) | Ada form launch (detail tidak dirinci di sumber) (S4) | name, symbol, description, image, initialBuy, feeShares[] (S26) | Create Token: name, symbol, description, logo; supply fixed/bonded; reserve sampai 25% (S23) | Create agent gratis; modul berbayar: Launch Radar 100 $VIRTUAL, Capital Formation 10, SOL Launch 10 (S5) | Create via web / bot Farcaster; support presales (S8) | — |
| **Dev buy / initial buy** | Native tidak ditegaskan di sumber; ekosistem bundler pihak ke-3 populer (bundler: nama, ticker, deskripsi, gambar, social + "buy in immediately... same block") (S18) | ✅ eksplisit: "developers can purchase a portion of their token supply in the same transaction to protect your coins from snipers" (S3) | — | — | ✅ `initialBuy` di SDK (S26) | ❌ "no presales/wajib curve"; bundler pihak ke-3 (S23) | ❌ "There are no presales, whitelists, or gated allocations" (S5) | Presales sebagai fitur (S8) | — |
| **Model harga** | Bonding curve → auto-migrasi ke AMM PumpSwap (S16, S19) | Bonding curve (multi-quote) → 100% = seeding ke PancakeSwap ~18 BNB (S3) | Bukan launchpad sendiri; router ke pump.fun/Raydium/agg (S24/S25) | Bonding curve → 100% auto ke SunSwap V2 (~100rb TRX + 200jt token, biaya ~3rb TRX) (S4) | Curve; graduation di 85 SOL (S7) | Bonding curve → Raydium (S23) | Bonding curve → Uniswap V2 di 42.000 $VIRTUAL; LP dikunci 10 tahun (S5) | Langsung pool Uniswap V3 (tanpa curve) (S30) | AMM + fair-launch; LP lock (S9) |
| **Tampilan status migrasi** | Kolom/status "New Creations / Completing / Completed"; fee migrasi 0.015 SOL (S10, S20) | Checkbox filter "Listed on PancakeSwap"; stage Created/Completing/Completed (80–100% = Completing) (S11, S41) | — (token hasil router tetap satu daftar) | "100% of the Bonding Curve" (S4) | — | Label harga "Graduates at $45.668,06" per token (S42) | "graduation" + Hyperboost otomatis pasca-graduasi (S5) | — | — |
| **Split fee** | Curve: total 1,25% = 0,95% protokol + 0,30% kreator. PumpSwap kanonik: 1,20%→0,30% (kreator 0,95%→0,05%); pool non-kanonik 0,30% (0% kreator). Bisa bagi fee ke 10 wallet; transfer ownership; revoke update authority (S16, S1, S22) | Launch gratis (~0,005 BNB gas); trading 1% (min 0,001 BNB); seeding fee saat 100% (S3) | Service fee trading 2,5% (<$250) / 1% (≥$250) (S24/S25) | Create ~20 TRX; trading 1%; fee tambah likuiditas ~3.000 TRX (S4) | Kreator 1% volume selamanya; curve flat 2%; feeShares multi-wallet; dividends top-100 holder (S7, S26) | 1% swap fee + post-migration 0,1–0,2%; split: ~40% platform dev, ~30% validator BONKsol, ~30% buyback/burn BONK (S23) | 1% trading; 70% kreator / 30% treasury; sniper tax 99%→1% (opsional), hasil tax = buyback token agen (S5) | 1% swap fee, 40% ke kreator (80% bila deploy via bot Farcaster); dana ekosistem Apr 2026 (S31, S16, S32) | — |
| **UI klaim creator fee** | Profile → "More" → "Creator rewards" (riwayat) → tombol "Claim all"; tanpa minimum (S16) | — | — | — | Claim 1% kapan pun; tool ClaimScan untuk fee tak-terklaim (S7, S26) | — | Hyperboost rewards claimable anytime pasca-graduasi (S5) | Tool pihak ke-3 "Claim Creator Fees" mengumpulkan Clanker+Uniswap (S16) | — |
| **Holder / activity UI** | Kolom transaksi + komentar per coin (S27: "add comment") | Tab Info / Chart / Buy-Sell (S11) | Portfolio P&L per holding (S24) | — | Top-100 holder dapat dividen (S26) | — | — | Analitik via Dune (S8) | — |
| **Portfolio** | Riwayat creator rewards; hodling per wallet (S16) | — (wallet eksternal) | ✅ live P&L per holding, exit ke USDC/bank (S24) | — | — | — | — | — | — |
| **Socials** | Field social links di create; "jangan skip social links" (S18) | Field "Socials" di create (S3) | — | — | fee sharing ke username X/GitHub/TikTok (S7 snippet) | — | — | — | — |
| **Search / sort / trending** | Daftar New/Completing/Completed + filter per kolom (via GMGN yang meniru/tracking platform) (S10) | Sort "by category, time" + filter PancakeSwap (S11) | Cari nama/ticker/CA; daftar kurasi + badge Verified (S24) | — | "Buy Launches at $74,6K" (sort by buy) (S6) | — | — | — | — |
| **Notifikasi** | — | — | Price alerts (via app DEX Screener induk) | — | — | Roadmap "Graduation Alerts" otomatis (S23) | — | — | — |
| **Mobile buy/sell pattern** | Panel trade: input amount → tombol "place trade" → popup wallet; ada pengaturan slippage (S27) | Tab Buy: input manual atau "quick selection", tombol [Trade] → popup [Transaction Details] → [Confirm Payment]; Sell: [Sell] + shortcut % → [Trade] (S11) | Discovery + eksekusi di layar sama; konfirmasi biometrik (FaceID) (S24/S25) | — | — | "Advanced" mode: toggle kolom trading (Snippet letsbonk.fun/advanced) | via app virtuals.io (S5) | Bot Farcaster 1 perintah (S8) | — |
| **Quick amounts** | — (dibahas di panduan pihak ke-3) | ✅ "quick selection function below" (buy) + "percentage shortcut" (sell) (S11) | — | — | — | — | — | — | — |
| **Slippage UI** | Ada pengaturan slippage (S27) | — (curve: slippage implisit) | Adjust tolerance sebelum konfirmasi (S24) | — | — | — | — | — | — |
| **Chart & tape** | — | Tab "Chart" (S11) | Realtime chart + trades dari DEX Screener (S24) | — | — | — | — | — | — |
| **Anti-sniper** | Bundler pihak ke-3 (S18) | Dev buy di tx yang sama (S3) | — | — | — | — | ✅ Sniper Tax 99%→1% dengan jendela pilihan (0s/60s/10m/98m) (S5) | — | — |
| **LP lock / anti-rug** | LP token hasil graduation dibakar instan (S18) | Likuiditas handoff otomatis (S3) | — | Auto LP SunSwap (S4) | — | — | ✅ LP hasil graduation di-stake dikunci 10 tahun (S5) | — | "secure liquidity locks" (snippet The Defiant) (S9) |
| **Bukti skala 2026** | Volume harian puncak $2,03 M (Jan 2026); share pernah 81,2% (Sep 2025); review Mar 2026: fee 1,25% (S21, S36, S19) | "first BSC meme launchpad", terbesar di BSC (DappBay) | >2 juta user; >$4 miliar volume kumulatif; naik ke app store top (S24/S25) | "First Meme Fair Launch Platform on Tron" (S4) | App Store + hackathon $4M (Mar 2026); "1% forever" (S6, S26) | Pernah flip pump.fun (47,4% vs 41,2% Jul 2025); "74% of daily launches" Agu 2025 (S34, S35) | "Shopify for AI agents"; staking VIRTUAL Mei 2025 (S5) | $13M revenue dari 200rb token dalam 5 bulan; ~$8M fee/minggu awal 2026 (S30, S33) | Diakuisisi Arctide; VISTA ~$0,45, volume 24h ~$59rb → praktis dorman (S9) |

**Catatan matriks:**
- "Believe" (tweet-to-launch) sempat besar 2025 (13% share Mei 2025) tapi harga LAUNCHCOIN ambruk dan sumber saling bertentangan soal nilai terkini ($0,00004 di CoinMarketCap vs narasi $0,03 di digitalcoinprice) → **KONFLIK sumber; status 2026 = menurun**; tidak dimasukkan kolom agar tabel fokus pada yang terbukti hidup. (Sumber: beincrypto.com/pump-fun-fades-new-players-rise-solana/ Mei 2025; coinmarketcap LAUNCHCOIN; tidak dijadikan dasar rekomendasi.)
- "Pharos" yang disebut di brief = **Layer-1, BUKAN launchpad** (pharos.xyz/mainnet; airdrop PROS) → diganti slot EVM dengan Clanker + Ethervista. (Sumber: cryptoticker.io Pharos airdrop 2026.)
- pump.fun menaikkan fee curve ke 1,25% sejak Okt 2025; app sempat promosi "zero-fee" Jul 2026 namun halaman fee tetap 1,25% → lihat anti-pattern butir A4. (S21)

---

## 3) POLA UX BERTITIK

Semua butir = fakta dari sumber + "pelajaran untuk kita" yang diturunkan (ditandai →). Kutipan label UI ditulis apa adanya dalam tanda kutip.

**U1. Halaman token = satu layar, trade selalu terjangkau.** four.meme menaruh tiga kategori di halaman token: "Info, Chart, and Buy/Sell" — panel beli/jual ada di halaman yang sama, bukan halaman terpisah (S11). Moonshot menegaskan "discovery and execution happen on the same screen" (S24). → Untuk DEX kita: pertahankan satu halaman token dengan tape/chart di atas, panel trade di bawah; jangan paksa user pindah halaman untuk membeli.

**U2. Bottom sheet + urutan blok yang konsisten.** Alur four.meme (via panduan wallet): buka token → tab "Buy" → "manually input the amount, or use the quick selection function below" → tombol **[Trade]** → popup **[Transaction Details]** → **[Confirm Payment]** → popup wallet (S11). GMGN: dropdown settings → "Click 'Buy' on the right side, and enter the purchase amount: 0.1 $SOL, click 'buy'" (S10). → Urutan blok yang aman untuk kita: (1) tab Beli/Jual, (2) input + preset, (3) baris info kecil (saldo, fee, slippage), (4) CTA full-width, (5) modal konfirmasi, (6) wallet. Modal konfirmasi terpisah dari wallet popup = pola yang dipakai four.meme; tiru.

**U3. Preset cepat adalah standar industri.** four.meme: "quick selection function" (buy) dan "percentage shortcut function" (sell) (S11). GMGN: input 0.1 SOL; jual pakai "select 100%" (S10). Photon (bot terminal): "Quick buy presets. Save buy amounts (e.g. 0.5, 1, 5 SOL) and one-click execute" (https://uwuu.ai/blog/photon-review, diakses 2026-10-15). → Wajib: preset beli (0.01/0.05/0.1 ETH) + preset jual (25/50/75/100%) + tombol MAX; satu tap langsung mengisi form.

**U4. Jumlah tap beli (perkiraan dari alur terdokumentasi).** four.meme ≈3 tap di dApp + 1 konfirmasi wallet + 1 popup bayar (S11); pump.fun: pilih nominal → tombol "place trade" → popup wallet (S27) ≈2–3 tap + wallet; Moonshot: onboarding email+FaceID sekali, lalu trade dikonfirmasi biometrik "within the same screen" (S24/S25) ≈2–3 tap + FaceID. → Target kita: **≤3 tap** dari halaman token ke modal konfirmasi; wallet popup dihitung terpisah dan tidak boleh ditambah langkah kita sendiri (mis. dropdown chain).

**U5. Slippage & "advanced" disembunyikan tapi terlihat.** GMGN: pengaturan di "settings dropdown" dengan mode "Boost mode"; panduan edukasi internal mereka: slippage 0,5% normal vs 10% untuk token trending, + peringatan sandwich attack (S10). Moonshot: "Slippage: Adjust tolerance from the default before confirming" (S24). Uniswap memisahkan dua konsep: **price impact** = dampak trade kita ke harga pool; **slippage tolerance** = batas eksekusi (S12, S13). → Untuk kita: tampilkan baris ringkas "Slippage 0,5% · Fee 0,3% · Price impact 0,12%" yang bisa di-tap untuk ubah; warna kuning/merah bila price impact >1%/ >5%; jelaskan price impact ≠ slippage dalam tooltip singkat.

**U6. Fee ditampilkan sebagai bagian dari keputusan, bukan halaman terpisah.** pump.fun mempublikasikan tabel fee per fase secara eksplisit (S1, S16) dan prompt pertama app-nya berisi peringatan "Prices can move quickly, so trade carefully." (S1 — layar welcome). → Untuk kita: di modal konfirmasi tampilkan breakdown "Anda bayar: x ETH · Fee LP 0,3% (ke LP) · Diterima minimal: y token". Tidak ada fee protokol = jual sebagai keunggulan ("0% platform fee").

**U7. Status migrasi/graduasi adalah elemen navigasi, bukan badge kecil.** GMGN meniru/tracking pump.fun dengan 3 kolom besar: "New Creations", "Completing", "Completed" (S10). four.meme punya checkbox filter "[Listed on PancakeSwap]" + sort kategori/waktu (S11) + stage API Created/Completing/Completed (S41). letsbonk menampilkan label per token "Graduates at $45.668,06" di halaman launchpad Raydium (S42). → Kita tidak punya kurva/migrasi; penggantinya: badge **"LP terkunci"** / "LP dibakar" + filter feed "Semua / Baru / LP terkunci / Trending". Status harus bisa difilter, bukan cuma ikon.

**U8. Klaim fee kreator = alur 3 langkah dengan satu tombol besar.** pump.fun: profil → "More" → "Creator rewards" → tombol **"Claim all"**; tanpa minimum, akumulasi otomatis on-chain (S16). Tool agregator pihak ke-3 menjual diri justru karena claim tersebar (S16). → Untuk kita: halaman "Fee Saya" (atau section di halaman token milik creator) menampilkan akumulasi + riwayat + satu tombol "Klaim Semua" (contract kita harus punya pull-pattern; kalau belum, desain UI-nya dulu agar kontrak menyusul).

**U9. Discovery: filter & sort adalah fitur inti, bukan pelengkap.** GMGN: filter marketcap, volume, jumlah tx, "at least one social media metric", analisa top-10 wallet, bubble chart distribusi holder (S10). four.meme: sort "by category, time, and other parameters" (S11). Moonshot: pencarian "by name, ticker, or contract address" + badge "Verified" hasil kurasi tim — dengan catatan kurasi bukan jaminan (S24). → Untuk kita: search harus menerima **alamat kontrak** (bukan hanya nama — nama duplikat = penipuan), tambah sort (Terbaru/Termahal/Teramai) + filter "punya socials".

**U10. Notifikasi berbasis kejadian.** letsbonk roadmap: "Graduation Alerts, automated notifications that inform token issuers and holders the instant their projects reach the liquidity thresholds" (S23). App induk Moonshot (DEX Screener) menjual "Unlimited price alerts" (App Store: https://apps.apple.com/us/app/dex-screener/id1631840457, diakses 2026-10-15). → Tanpa backend, notifikasi push penuh tidak realistis; versi minimal = in-app watcher (polling harga/event saat app terbuka) + toast saat event besar (trade >X, LP berubah). Catat batasannya ke user.

**U11. Touch target & ergonomi mobile Android.** Pedoman resmi Android: elemen interaktif ≥48×48dp dengan jarak ≥8dp; 48dp ≈9mm fisik (S14). Kami berjalan di Android WebView → jangan override ukuran default kontrol; jadikan 48px CSS minimum (setara dp pada density umum) sebagai konstanta desain. → Tombol Beli/Jual/Create harus full-width atau minimal 48px tinggi di dalam WebView; hindari tombol kecil berjejer.

**U12. Jual secepat beli.** GMGN: "Click 'Sell' tab, select 100%, and click 'sell'" (S10); four.meme: "Click [Sell], set the amount to sell, or use the percentage shortcut" (S11). → Panel Jual wajib punya preset % (25/50/75/100) dan tombol setara ukurannya dengan Beli; jangan sembunyikan tombol Jual di menu.

**U13. Anti-sniper sebagai properti yang terlihat.** Virtuals: "Sniper Tax… starts at 99% and decays to the 1% baseline"; founder memilih jendela (0s/60s/10m/98m); hasil tax otomatis buyback token (S5). four.meme: dev buy di "same transaction to protect your coins from snipers" (S3). → Wizard launch kita: karena kita 1-tx pool (tanpa curve), anti-sniper = edukasi + opsi "beli pertama di tx launch" + (kontrak permitting) batas waktu/limit; tampilkan jujur apa yang mungkin & tidak.

**U14. Chart & tape dari data on-chain murni bisa.** four.meme punya tab "Chart" (S11); Moonshot menampilkan "live price updates" & chart (S24) — keduanya adalah bukti bahwa chart/tape adalah ekspektasi minimum pengguna launchpad modern. → Untuk kita tanpa indexer: tape = queryFilter event Swap per pool (cache ke storage lokal, backfill bertahap); chart = agregasi harga per bucket waktu dari event yang sama. Tandai di UI "berbasis event on-chain (bukan indexer)" bila ada keterbatasan saat pool sepi.

**U15. Bahasa & onboarding.** four.meme menyediakan tombol switch bahasa di menu kanan atas ("click to switch languages or connect your wallet") (S11); prompt pertama pump.fun = layar edukasi + checkbox 18+ (S1). → Pertahankan switch ID/EN yang persisten + modal disclaimer singkat 1x saja (jangan menghalangi tiap kali).

---

## 4) ANTI-PATTERN (dengan kutipan komplain)

**A1. Fee tak transparan → user merasa dicurangi.** App Store review Moonshot (S46): *"Anyone who trades solana meme coins knows that transaction fees normally run within the $0.01-$0.05 range. They… their fees are flat out ridiculous"* dan *"If you double your money from a coin and get your money back after all their fees you will be getting the same you put in this app is a scam"*. Datawallet mencatat: *"recurring complaints that small buys lose a large percentage to fees"* (S24). → Pelajaran: fee 2,5% gaya Moonshot = reputasi rusak; kita: fee 0,3% saja dan TAMPILKAN di setiap langkah (U6).

**A2. Withdraw/masalah dana = keluhan terparah (mengalahkan fitur).** r/solana (S43): *"This app is a nightmare, its a scam … cant sell , cant buy , cant withdraw anything. Lost a lot of money because of this junk app"*; (S44): *"Moonshot stole $100 from me. I've used multiple crypto trading apps and decided to try this one. Deposited $100 and days later still…"*; (S45): *"While it may seem 'safe' to use Moonshot, the real problems begin when you deposit money and something goes wrong.. you'r left with no help"*. → Pelajaran: untuk DEX non-kustodial kita, "tidak ada dana mengendap" adalah fitur; komunikasikan jelas ("dana 100% di wallet Anda") dan prioritaskan status transaksi yang jujur (pending/failed alasan).

**A3. Beli dan jual harus selalu tersedia.** Penyebab besar komplain Moonshot = region lock: *"cant sell, cant buy, cant withdraw"* (S43) + app mobile-only tanpa desktop (S24/S25). → Pelajaran: jangan pernah disable tombol tanpa alasan eksplisit (tampilkan "kenapa" — R7); sediakan fallback bila RPC gagal (retry di UI).

**A4. Flip-flop kebijakan fee membakar kepercayaan.** Pump.fun: co-founder mengakui design fee gagal (*"the platform's creator-fee design failed to produce durable trading incentives"* — S22, Jan 2026), lalu X menjadi ajang protes: *"Solana Traders Frustrated with Pump.fun's Creator Fee…"* (S48, Des 2025). Komentar developer yang dikutip Coinspeaker: developer Unihax0r menyebut update itu *"nothing"* — tuduhan hanya mengganti nama "taxes" menjadi "creator fees" (S22). Ditambah ambiguitas promosi: app mempromosikan zero-fee Jul 2026 tapi halaman fee tetap 1,25% (S21). → Pelajaran: tetapkan aturan fee kita sekarang (LP 0,3%, 0 protokol, fee kreator x%) dan JANGAN ubah tanpa pengumuman di dalam app + changelog.

**A5. Slippage yang tidak dijelaskan = korban sandwich.** GMGN menulis contoh nyata: *"The original price was $0.023, but the buyer ended up paying close to $0.04"* (S10). Konteks BSC (relevan: four.meme): panduan TokenPocket menyarankan node anti-MEV karena *"Due to BSC's high TPS, low transaction fees, and relatively centralized validator network, the MEV issue is more prominent"* (S11). → Pelajaran: di DEX kita, tampilkan price impact + "min received" sebelum konfirmasi (U5); jangan biarkan user tanpa default slippage yang aman.

**A6. "Scam flood" menghancurkan kepercayaan kategori.** r/solana: *"There's an outbreak of pump-and-dump scams on the pump.fun website. Devs are aware but can't do much right now. All Support could tell me is…"* (S47). Statistik industri (dikutip Smithii, sekunder): ~98% token menunjukkan tanda scam (Solidus Labs via S18); <2% token lolos kurva (S19). → Pelajaran: kita tidak bisa membersihkan rantai, tapi bisa menampilkan sinyal kepercayaan: alamat kontrak + copy, umur pool, likuiditas, holder top-10, status LP lock (U7/U9) — persis yang diminta GMGN dari user profesionalnya (S10).

**A7. Insiden keamanan & pause = momem krisis UX.** Four.meme kena exploit $130K BNB lalu *"suspended its launch function"* (S28, S29, Mar 2025) — user melihat tombol launch mati tanpa konteks. → Pelajaran: siapkan "mode pause" yang menjelaskan (banner: "pembuatan token dijeda sementara — investigasi keamanan"), bukan tombol yang seolah rusak.

**A8. Klaim fee tanpa satu tempat = duit menggantung.** Smithii (S16): tim yang launch di banyak platform *"eventually hit a point where you don't even know how much you have pending"* — keluhan operasional kreator. → Pelajaran: satu halaman Rewards (R6). Sisi positif: pump.fun "Claim all" (S16) adalah pola yang harus kita tiru.

**A9. Metadata tidak lengkap → token tampak mati.** Panduan peluncuran menekankan: *"don't skip adding social links when creating a token on Pump.fun, since they add credibility"* (S18); GMGN menyarankan filter "at least one social media metric" (S10). → Pelajaran: wizard kita harus meminta socials (opsional tapi didorong) dan menampilkannya besar di halaman token.

---

## 5) REKOMENDASI BERNOMOR UNTUK DEX KITA (P0/P1/P2 + Effort + Alasan)

Konteks penilaian: WebView Android, tanpa backend/indexer, sudah ada feed/launch/token/swap/pools/liquidity/portfolio/bot. Effort: S=jam–1 hari, M=1–3 hari, L=banyak hari/minggu (relatif tanpa backend baru).

### P0 — TANPA INI PRODUK TIDAK LAYAK DIPAKAI

**R1. Satu komponen "TradeSheet" untuk Beli & Jual (konsistensi total).** Effort **M**.
Isi: bottom sheet; tab `Beli | Jual`; input jumlah + tombol MAX; preset beli 0,01/0,05/0,1 ETH; preset jual 25/50/75/100%; CTA full-width ≥48px (S14); state: normal → loading → sukses → gagal (+tombol "Coba lagi"); tombol disabled SELALU disertai alasan yang terlihat (saldo kurang / saldo gas kurang / jumlah nol / slippage tidak valid).
Alasan: pola label & langkah four.meme + GMGN (U2, U3, U12, S10, S11); keluhan langsung brief = "konsistensi tombol"; 48dp standar (S14).

**R2. Estimasi & slippage pra-eksekusi (wajib untuk AMM x*y=k).** Effort **M**.
Isi: di dalam sheet, baris ringkas `Slippage 0,5% · Fee LP 0,3% · Price impact 0,12%` (tappable); modal detail: estimasi diterima, minimum diterima, rasio pool, peringatan bila price impact >1% (kuning) / >5% (merah + konfirmasi ganda).
Alasan: Uniswap memisahkan price impact vs slippage sebagai dua angka yang berbeda (S12, S13); GMGN mengedukasi slippage & sandwich (S10); konteks BSC MEV nyata (S11). Ini pembeda dari launchpad kurva yang menyembunyikan slippage di balik "harga naik terus".

**R3. Search + sort + tab status di feed.** Effort **M**.
Isi: kolom pencarian (nama / ticker / **alamat kontrak**); tab `Semua | Baru | Trending`; sort `Terbaru | Likuiditas | Volume`; badge status `LP terkunci` / `LP dibakar` / `Pool baru` (pengganti "Graduated" yang tidak berlaku di kita).
Alasan: tiga kolom status GMGN (S10), sort & filter four.meme (S11), search by contract address Moonshot (S24); kombinasi ini yang diminta brief ("search/sort/trending").

**R4. Statistik token + tape on-chain yang jujur.** Effort **L**.
Isi: harga, market cap (supply × harga pool), likuiditas (reserve), jumlah holder (estimasi), volume 24 jam; tape transaksi (waktu, arah beli/jual, ukuran ETH & USD) dari `queryFilter` event Swap/Burn/Mint + cache lokal (IndexedDB/localStorage) + backfill bertahap per blok; label "data dihitung langsung dari event on-chain".
Alasan: chart+tape adalah ekspektasi minimum (U14; tab Chart four.meme S11; realtime DEX Screener S24); brief meminta "chart+tape bagus, statistik volume/marketcap/24h". Tanpa backend → satu-satunya jalan adalah queryFilter + cache; tandai bila data belum lengkap (kejujuran > angka palsu).

**R5. Holder list top-50 + konsentrasi top-10.** Effort **M**.
Isi: daftar holder (alamat singkat + copy), % top-10, status "kontrak LP dikunci/burn" untuk pool kita.
Alasan: GMGN menjadikan top-10 wallet & distribusi holder syarat anti-rug (S10); statistik scam industri (A6); brief meminta "holder list".

**R6. Halaman "Fee Saya" (creator rewards) + tombol "Klaim Semua".** Effort **S–M** (butuh fungsi claim di kontrak; jika belum ada → tambah ke backlog kontrak).
Isi: akumulasi fee kreator dari aktivitas pool (0,3% share bila diaktifkan), riwayat, satu CTA besar.
Alasan: pola "Creator rewards → Claim all" pump.fun (S16, U8); keluhan kreator kehilangan jejak fee di berbagai platform (A8).

**R7. Audit konsistensi CTA & status transaksi (satu bahasa tombol).** Effort **S**.
Isi: semua layar (swap, add/remove liquidity, launch, claim) memakai komponen tombol sama; status transaksi tunggal (submitted/confirmed/failed dengan alasan), toast & banner dengan format sama; retry di UI saat RPC gagal.
Alasan: brief "konsistensi tombol"; pelajaran withdrawal/support Moonshot (A2, A3) — kepercayaan dibangun dari status yang jujur.

### P1 — PEMBEDA / EKSPEKTASI LANJUTAN

**R8. Chart harga ringan dari agregasi event (1m/5m/1h/1d).** Effort **L**. Alasan: U14; four.meme tab Chart (S11). Implementasi: bucket waktu dari event Swap yang sudah dicache R4; jangan janjikan realtime tick bila RPC lambat.
**R9. Wizard launch 2.0: socials + preview + dev-buy 1-tx + edukasi anti-sniper.** Effort **M**. Alasan: socials=kredibilitas (S18, A9); dev buy satu tx four.meme (S3); anti-sniper Virtuals (S5, U13).
**R10. Add/Remove Liquidity yang jelas (brief: "UX add-liquidity yang jelas").** Effort **M**. Isi: dua input rasio 50:50 terkunci + tombol "auto isi sisi lain"; estimasi share pool & APR fee; langkah approve TERPISAH dan terjelaskan; preview "Anda menambah X ETH + Y TOKEN → share pool dari a→b%". Alasan: keluhan umum DeFi = IL & approve tak jelas; prinsip price impact/slippage Uniswap (S12/S13); pola popup konfirmasi four.meme (S11).
**R11. Badge keamanan pool di halaman token.** Effort **S–M**. Isi: "LP terkunci", umur pool, sumber fee, catatan "tanpa owner privileges" (jika kontrak memungkinkan). Alasan: U7, A6; posisi anti-rug sebagai market fit Ethervista/pump.fun LP burn (S9, S18).
**R12. Portfolio: harga rata-rata & P&L sederhana (dari event).** Effort **L**. Alasan: Moonshot menampilkan P&L per holding (S24); brief "portfolio".
**R13. Empty state / skeleton / copy error ID+EN manusiawi.** Effort **S**. Alasan: A3; WebView lambat RPC = kondisi normal, bukan edge case.

### P2 — RETENSI / POLISH

**R14. Watchlist + watcher harga in-app (poll RPC saat app terbuka + notifikasi lokal).** Effort **M**. Alasan: U10; batasan tanpa backend → jangan janji push notification lintas sesi.
**R15. "Trending" scoring lokal sederhana (volume 1 jam, umur, lompatan holder) dihitung di device.** Effort **M**. Alasan: U9; feed sudah ada → tinggal scoring + cache.
**R16. Onboarding 3 tooltip edukasi (LP, price impact, LP lock) + glossary ID/EN.** Effort **S**. Alasan: GMGN mengedukasi sebelum user kena (S10); Uniswap FAQ (S12/S13); prompt pertama pump.fun = edukasi (S1).
**R17. Audit i18n + format angka mata uang lokal.** Effort **S**. Alasan: switch bahasa four.meme (S11, U15); produk kita ID+EN sejak awal — pastikan tidak ada string keras.

---

## 6) REPO GITHUB OSS (INVENTARIS FITUR — JANGAN COPY KODE)

Sumber: GitHub Search API `q=pump.fun clone` & `q=meme launchpad` (diakses 2026-10-15), README repo terkait (S-stars/komit dari API; baca README di halaman repo).

| Repo | ★ / fork | Push terakhir | Stack | Fitur yang benar-benar dikirim (dari README/struktur) | Relevansi |
|---|---|---|---|---|---|
| [dappuniversity/fun-pump](https://github.com/dappuniversity/fun-pump) | 49 / 56 | 2024-11 (11 komit) | Solidity, Hardhat, Next.js, Ethers.js | Clone struktur: folder `contracts/` + `app/` + `ignition/` + `test/`; README hanya setup (install → deploy Factory → frontend) | Template minimal; sudah tua, tidak ada chart/holder |
| [bharathbabu3017/pump-fun-clone-evm](https://github.com/bharathbabu3017/pump-fun-clone-evm) | 31 / 50 | **2026-09-14** | Solidity 0.8.24, Hardhat, React 18, ethers v6, Moralis Web3 API | Launch ERC-20 fee 0,0001 ETH; kurva eksponensial (aproksimasi Taylor e^x) on-chain; auto list ke Uniswap V2 saat 24 ETH + **burn LP**; explorer token + progress kurva; halaman token dengan **holders & riwayat transfer** (via Moralis); support wallet EIP-1193 | **Paling dekat dengan kebutuhan kita** (EVM, launch+pool+burn). Pelajari alur UI form & halaman token; WAJIB ganti Moralis → queryFilter agar tanpa backend |
| [m8s-lab/pump-fun-smart-contract](https://github.com/m8s-lab/pump-fun-smart-contract) | 134 / — | 2025-07-01 | Solana (Anchor) | Clone pumpfun/fourmeme; swap fee configurable; catatan: repo populer tapi SOLANA | Referensi model fee & event; bukan EVM |
| [justFiveDev/Solana-Pumpfun-Smart-Contract](https://github.com/justFiveDev/Solana-Pumpfun-Smart-Contract) | 65 / — | 2025-12-12 | Solana | "fully forkable Pump.fun clone" — bonding curve + graduation Meteora | Pola kurva→AMM modern; bukan EVM |
| [donpushme/fourmeme-fork](https://github.com/donpushme/fourmeme-fork) | 19 / — | 2025-06-22 | Solidity (BSC) | "Forking of the Four.meme, the biggest meme launchpad on BSC" | Referensi kontrak launchpad BSC (pasangan 3 quote token kita!) |
| [launch-fi/launchpad](https://github.com/launch-fi/launchpad) | 15 / — | 2024-07-14 | Uniswap v4 hooks | "Launch your meme tokens here, powered by Uniswap v4 hooks" | Pola launchpad EVM modern; lama tapi arah hook menarik |
| [DevMarkson/Xlayer-MemePad](https://github.com/DevMarkson/Xlayer-MemePad) | 3 / — | 2025-09-05 | EVM (X Layer/OKX zkEVM) | "Pump.fun-style … dengan mekanik bonding curve otomatis" | Referensi multichain EVM kecil |
| [Trustdev-eth/evm-token-launchpad-fourmeme-smart-contract-fork](https://github.com/Trustdev-eth/evm-token-launchpad-fourmeme-smart-contract-fork) | 3 / — | 2025-10-16 | Solidity EVM | Fork kontrak four.meme | Pembanding kontrak |

Catatan daftar ini: (a) bintang/komit = kondisi 2026-10-15, bukan jaminan kualitas; (b) tidak ada repo EVM yang menyertakan chart/tape lengkap tanpa API pihak ke-3 — celah yang justru menjadi pembeda DEX kita bila R4/R8 dieksekusi murni on-chain; (c) repo Solana disertakan sebagai pembanding pola, bukan untuk di-fork.

---

## 7) KONFLIK, RISIKO & SUMBER LANJUTAN

**KONFLIK 1 — Fee pump.fun (1% vs 1,25%).** SolTokenCreator (9 Mar 2026) menulis "1% trading fee… 0,05% creator" (S19) sedangkan Smithii (upd 13 Okt 2026) & dokumen fee resmi (upd 8 Okt 2026) menulis 1,25% saat kurva (0,95% protokol + 0,30% kreator) (S16, S1, S2). **Kesimpulan: pakai 1,25%** — sumber lebih baru + resmi. Angka 0,05% adalah model lama (pre-Project Ascend).

**KONFLIK 2 — Siapa raja launchpad.** letsbonk sempat menyalip pump.fun (Jul–Agu 2025: 47,4% vs 41,2%; "74% of daily launches") (S34, S35) lalu pump.fun balik ke 81,2% share 24 jam (Sep 2025) (S36); review Agu 2026: "Pump.fun remains the highest-volume launchpad on Solana" (S37). **Kesimpulan: kedua-duanya hidup dan besar; desain harus mengambil pola TERBAIK dari keduanya, bukan meniru buta salah satu.**

**KONFLIK 3 — Status Believe.** Sumber harga saling bertentangan (CoinMarketCap $0,00004 vs digitalcoinprice menyebut $0,03 Okt 2026) → **tidak dipakai sebagai landasan rekomendasi**; hanya catatan bahwa "social launchpad" bisa cepat naik-turun.

**RISIKO (asumsi belum terverifikasi — DEV wajib cek manual):**
1. Label UI literal panel beli/jual pump.fun dibaca dari panduan pihak ke-3 (S27), bukan tangkapan layar app langsung → cek dengan app/frontend asli sebelum menyalin istilah.
2. Kelayakan performa: replay `queryFilter` volume 24 jam + holder list di WebView HP kelas bawah belum diuji; butuh benchmark nyata (jumlah blok Sepolia vs RPC publik) sebelum menjanjikan R4/R5/R8.
3. Fungsi claim fee kreator di kontrak DEX kita belum dikonfirmasi ada (brief menyebut "claim creator fee" masuk daftar "belum ada") → R6 butuh keputusan kontrak.
4. Angka share/volume launchpad berasal dari periode berbeda-beda 2025–2026; gunakan hanya sebagai konteks, tidak untuk klaim posisi kompetitif.

**SUMBER LANJUTAN (prioritas cek DEV):** (a) clanker.world/docs + Dune clanker (68); (b) docs.bags.fm (API feeShares); (c) pump.fun/docs/fees dibuka manual tanpa modal; (d) letsbonk.fun/advanced (Trading Controls) dan halaman token di letsbonk; (e) whitepaper.virtuals.io llms.txt; (f) cryptoslate.com/launchpads/four-meme-review/ (403 — coba browser biasa).

*Riset ini bahan keputusan, bukan spesifikasi implementasi. Semua angka fee berlaku per 2026-10-15; fee platform kategori ini berubah cepat — sebelum menulis ke dokumen produk, verifikasi ulang ke sumber resmi.*

