# WalletConnect registry listing — Bear Tool

Packet for getting Bear Tool to appear in a dApp's wallet picker (Uniswap →
WalletConnect → wallet list), **prepared, not submitted**. Submitting needs a
WalletConnect Cloud account, so that step is yours.

## 1. Why Bear Tool is not in the list

The picker is the **WalletConnect / Reown Explorer registry**. It is a curated
database, not a resolver: a wallet that has no entry cannot be picked, no
matter how well it handles `wc:` links.

```
curl -s "https://explorer-api.walletconnect.com/v3/wallets?projectId=99909bde486039e2102663b92be74974&entries=200&page=1"
```

Result: `total: 649`, and no listing whose name matches `/bear/i`. MetaMask,
Trust Wallet, Binance Wallet, SafePal and TokenPocket are all present — all
registered.

The old submission repo (`WalletConnect/walletconnect-registry`) is **archived**;
its README points at the Cloud dashboard. So there is no PR route any more:
listing = account + dashboard form.

## 2. What the app already does (verified, no change needed)

| Piece | Where | Effect |
| --- | --- | --- |
| `wc:` intent-filter | `android/app/src/main/AndroidManifest.xml:28-33` | A `wc:…` link opens Bear Tool |
| Native deep link | `js/walletconnect.js:741-750` | `appUrlOpen` → pair sheet, URI pre-filled |
| Web fallback | `js/walletconnect.js:737-738` | `?wc=<uri>` on the deployed site |
| Session metadata | `js/walletconnect.js` (`WC_PUBLIC_URL`) | dApp prompt shows the public URL + icon, not `https://localhost` |

## 3. What is missing

1. **The listing itself** — account-based, done in the WalletConnect Cloud
   dashboard.
2. **A link the listing can hand out** — registered wallets give a *universal*
   link (e.g. `https://metamask.app.link`). Bear Tool now has one: a static
   page that bounces into the `wc:` scheme (section 5).

## 4. Prepared files

| File | What it is |
| --- | --- |
| `assets/bear-512.png` | 512×512 logo for the dashboard upload |
| `tools/make-wc-logo.mjs` | Regenerates that PNG from `assets/bear.svg` (chromium locally, sharp in CI — same geometry, so the listing can never drift from the app icon) |
| `public/wc/index.html` | Universal-link landing page → deployed at `https://nemoobc.github.io/Bear-Tool/wc` |
| `.github/workflows/pages.yml` | Also emits `dist/assets/bear-512.png` so a public copy always exists |

## 5. Field values for the dashboard

| Field | Value |
| --- | --- |
| name | `Bear Tool` |
| slug | `bear-tool` |
| homepage | `https://nemoobc.github.io/Bear-Tool/` |
| description | `Self-custody multichain wallet with a hardened dApp browser.` |
| category | `Mobile Wallets` |
| app_type | `wallet` |
| logo | `assets/bear-512.png` (512×512) |
| mobile — native | *(empty: no custom scheme is registered)* |
| mobile — universal | `https://nemoobc.github.io/Bear-Tool/` |
| android app | *(only if/when published to a store)* |
| sdks | `sign_v2` |
| versions | `2` |
| chains | the 17 mainnet EVM chains below |

```
eip155:1, eip155:56, eip155:137, eip155:42161, eip155:10, eip155:8453,
eip155:43114, eip155:100, eip155:42220, eip155:146, eip155:59144,
eip155:534352, eip155:81457, eip155:5000, eip155:324, eip155:130, eip155:480
```

Source of truth: `js/network.js` `NETWORKS` — 23 entries, 17 `mainnet` + 6
testnet. Testnets are deliberately not advertised.

## 6. How the deep link works

1. The dApp builds the wallet link as
   `<mobile.universal>` + `wc?uri=` + `encodeURIComponent(uri)`
   (the shape MetaMask and Trust Wallet use → `<base>/wc?uri=…`).
2. That opens `https://nemoobc.github.io/Bear-Tool/wc?uri=…`.
3. `public/wc/index.html` reads the parameter, accepts **only** a value that
   starts with `wc:` (never `https:`, `javascript:` or `data:`), then
   `location.replace(uri)`.
4. Android routes the `wc:` scheme through the manifest intent-filter → Bear
   Tool opens with the pairing URI already filled.

## 7. What only you can do

Verified 2026-10-11: the PR route is dead, the dashboard route is live.

- `gh api repos/WalletConnect/walletconnect-registry --jq .archived` → `true`
  (the repo is read-only; a PR cannot be opened against it).
- Dashboard path (from their own docs, Explorer Submission): sign in at
  `https://dashboard.walletconnect.com` → **New Project** → open the project →
  **Explorer** tab → **Submit your wallet** → fill the section 5 fields → Submit.

Steps, in order:

1. Create/log into the WalletConnect Cloud dashboard (only you can — it needs
   your account).
2. Add the listing using the values in section 5 and upload the logo
   (`assets/bear-512.png`, public copy `https://nemoobc.github.io/Bear-Tool/assets/bear-512.png`).
3. Wait for their review (their schedule, not ours — commonly 1–3 weeks).

Optional follow-up: register a custom scheme (`beartool://`) and parse
`wc?uri=` in the app, which would let the listing also carry a `mobile.native`
link. Not required — the universal link above already works.

## 8. Verify

```bash
node tools/make-wc-logo.mjs                  # regenerate the 512 PNG
npm run build && ls dist/wc/index.html       # page ships in the web deploy
node --test tests/wc-registry-listing.test.js
```

## 9. Open risks (stated, not hidden)

- The exact concatenation of the universal link is WalletConnect's. The page
  accepts `?uri=`, `?wc=`, **or** any parameter whose value starts with `wc:`,
  so all plausible shapes land. The one shape that would not is a base that
  produces `/wcwc?…` or `//wc?…`; neither matches the MetaMask/Trust pattern.
- GitHub Pages 301s `/wc` → `/wc/`; the query string survives that redirect.
- Listing review time is outside our control.
- The logo is an SVG-derived raster. If their uploader rejects it, point the
  logo field at the public SVG (`assets/bear.svg`), which is served with
  `content-type: image/svg+xml`.
