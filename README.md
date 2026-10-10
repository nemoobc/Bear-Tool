# 🐻 Bear Tool

**The cartoon wallet that means business.**

Self-custody crypto wallet — 100% client-side, all EVM networks (mainnet + testnet), with a full **EIP-7702** suite. Original code, no copying. Cartoon theme built from scratch.

> ⚠️ **Educational / self-custody tool.** Keys never leave your browser. Always verify addresses. Mainnet transactions require extra confirmation (type `YA` to proceed).

🔗 **Live:** [nemoobc.github.io/Bear-Tool](https://nemoobc.github.io/Bear-Tool)
📦 Web build auto-deploys to Pages · 🤖 Android APK builds in CI (artifact `bear-tool-apk`) — both from this one repo.

---

## ✨ Features

| Area | What it does |
|---|---|
| 🐻 **Wallet** | Create (12-word seed) / import (seed or private key) with optional wallet name (auto-names Wallet, Wallet 1, …), PBKDF2-310k + AES-GCM encrypted keystore in localStorage, multi-account (m/44'/60'/0'/0/i), auto-lock, export secret. Refresh keeps the wallet unlocked (sessionStorage); closing the tab locks it again |
| 🌐 **Networks** | 23 EVM networks built in: 17 mainnet (Ethereum, BSC, Polygon, Arbitrum, OP, Base, Avalanche, Gnosis, Celo, Sonic, Linea, Scroll, Blast, Mantle, zkSync Era, Unichain, World Chain) + 6 testnet (Sepolia, Amoy, Arbitrum Sepolia, OP Sepolia, Base Sepolia, BSC Testnet), RPC fallback chain — each mainnet carries ≥2 probe-verified RPC endpoints (2026-10-05 pass). **Add Network is a picker, not a form** — 7 further EVM chains (Moonbeam, Cronos, Aurora, Polygon zkEVM, Mode, Metis, Hoodi) are one tap and fill themselves in; every preset RPC was probed to confirm it answers `eth_chainId` with the chain it claims, and saving re-checks that live. Custom RPC still supported, and it is **used exactly as entered** — if it stops answering, the app says so by name and stops, rather than quietly falling through to a different node. That failure mode was real: a fork endpoint that was slow to answer got skipped, the wallet connected to a public node instead, and the only symptom was a funded account reporting a balance it never had. Settings also shows **which node is live**. Settings → **Testnet mode** toggle hides testnets |
| 🪙 **Assets** | Native balance plus a bundled ERC-20 watchlist: **23 tokens on Ethereum mainnet** (USDT, USDC, DAI, WETH, WBTC, LINK, UNI, AAVE, SHIB, MATIC, ARB, OP, PEPE, CRV, SNX, SUSHI, COMP, MKR, LDO, rETH, cbETH, wstETH, FRAX) and a curated 3–5 on every OTHER shipped mainnet (each address probe-verified on-chain 2026-10-05 — `eth_getCode` + `decimals()` + `symbol()`, `docs/research/bridge-tokens-2026-10-05.md`; testnets carry 1–3, BSC Testnet stays native-only — no curated source exists, and a wrong address is a burnt transfer) — the list is a convenience, not a limit. **+ Add Token** sits under the list; paste an ERC-20 contract address and its name, symbol and decimals are read off the contract and shown before you commit, so a wrong paste is obvious instead of landing as an unlabelled row |
| ✈️ **Send** | Native + ERC-20, gas speed (slow/normal/fast), live preview + est. gas, paste button, address validation + poisoning detection |
| 🔄 **Swap** | Real quotes only. The try-order is **derived from the router registry**, not a hard-coded ladder: aggregators first (KyberSwap, ParaSwap), then every on-chain venue listed for the chain (Uniswap V3, Uniswap V2, SushiSwap, QuickSwap, BaseSwap). Every address in the registry was verified on-chain per chain — see `js/routers.js`. Slippage control, flip. No simulation: no route = honest error. The Swap nav button is also the Bridge entry (tap it twice to choose) |
| 🌉 **Bridge** | LI.FI quotes (real API, fetch timeout), **native + ONE curated ERC-20** — the picker offers **up to** two options: native, plus the best common stable (USDC > USDT > USDB > DAI > WETH > WBTC) curated on BOTH the source and destination chain, so a destination twin address always exists before anything is offered (458 of 506 ordered chain pairs carry a curated ERC-20 row; the other 48 share no stable family and stay native-only). Native drops out when LI.FI deny-lists that chain's native token — live-probed 2026-10-05: Celo's native answers HTTP 400 code 1011 at every amount, while Celo ERC-20 quotes fine — so the pair shows the ERC-20 row only. ERC-20 execution is the real three-step: on-chain allowance read against the quote-bound spender → exact-amount approve (stale partial allowance is reset to 0 first, USDT-style) → re-quote with full re-validation before the bridge tx; a fresh quote naming a different spender aborts honestly, and one execution runs at a time (double-click cannot run a second flow). Anything unmappable fails closed before any network call. Fail-closed on the networks Bear Tool actually supports — the registry does not claim chains the app cannot open (2026-10-05: LI.FI rejects BSC Testnet/Amoy with HTTP 400 code 1011, so they were removed from the router list). Measured 2026-09-27: LI.FI, KyberSwap and ParaSwap all answer with no credential; 1inch (401) and Bungee/Socket (403) need a key and are not offered. **M2 (2026-10-06): the token picker is TWO columns — source token → destination twin, painted from one option list so the pair cannot disagree (the same "eth token = bnb token" shape as Swap), and the router list is now LI.FI + **Gas.zip** + **Relay**, all measured unauthenticated (Gas.zip `/v2/quotes` 200 → a ready-to-send `contractDepositTxn`, native-only by design; Relay `/quote/v2` 200 → ordered steps, the spender read out of the `approve` calldata). "Auto (Best Route)" quotes every router covering the chain pair in parallel and binds the one with the largest destination output; each adapter validates its response field-by-field against the quote context before anything can be signed. Superbridge is deliberately absent: `api.superbridge.app` answers 401 and grants access case by case — same rule that keeps 1inch out. Any router that fails is named in the error box instead of being silently dropped — reaches `#view-bridge` from the Swap chooser, no separate nav item |
| ⚡ **EIP-7702** | Delegate to implementation (chainId 0 = all chains, replay warning), revoke, batch atomic call, rescue atomic, claim + forward airdrop. Batch/Rescue/Claim each require deploying their helper contract first (step 1 in the Tools view) — no silent auto-deploy. Settings can also **ask every network whether it supports 7702 at all** — a read-only estimate probe, no keys touched — and lists the exact RPC endpoints that answered yes as links you can copy |
| 💬 **Discord** | The slot Approvals vacated — that view was removed on request (M3: *"fitur approvals hapus ganti fitur discord"*). Connect two ways. **Login with Discord**: OAuth2 authorization code + PKCE as a *public client* — Discord's own docs say to enable Public Client when you have no backend, so **no client_secret exists** anywhere, only a Client ID from your own application at `discord.com/developers` (the exact redirect URI to paste there is shown on screen with a copy button). **Paste a user token**: instant, and the token never leaves the device (`bear.discordAuth` in localStorage, wiped on Log out). Connected, you get your identity card, the full server list with **Open** (deep link into Discord), **Channels** (text + announcement), **Leave** per server and **Leave all** behind a confirm — a partial run reports *"Left N of M servers, stopped at X"* instead of pretending it finished. **Send** works on the pasted-token connect only: Discord offers OAuth no user-message scope, and the UI says that *before* the request rather than after a guaranteed 403. Every call goes straight to `discord.com/api/v10` from the browser — their CORS preflight echoes your Origin and allows Authorization + POST/GET/PATCH/DELETE (measured 2026-10-06), so there is no proxy, no key, and nothing in between |
| 🧙 **Deploy** | Wizard for ERC-20 / ERC-721 / ERC-1155 with OpenZeppelin-wizard parity options — mintable/burnable/pausable, supply cap with **premint presets**, **EIP-2612 permit**, **votes (delegation + checkpoints)**, **Callback (ERC-1363)**, **Flash Minting (ERC-3156)**, **enumerable + per-token URI storage**, NFT **manual token ids** + **fallback image**, ownership **Ownable / Ownable2Step / Roles / Managed** select, solc **language / EVM version / optimizer / runs** on the form, and **copy source / download .sol / copy ABI** once compiled — real in-browser solc **0.8.37** compile (SRI-pinned, CDN fallback if the primary mirror is blocked). **Upgradeable** puts the token behind an **ERC-1967 proxy (UUPS or Transparent)**: `constructor` becomes `initialize`, the implementation locks its own initializer, and the deploy is **two transactions** — implementation, then the proxy with `initialize` *inside its constructor*, so there is never a block in which a live, uninitialised proxy can be claimed by someone else. Both addresses are recorded. A deploy that lands then **auto-verifies**: Sourcify first (keyless), Etherscan V2 if you paste an API key into the deploy form, both from the *same* standard-JSON input that compiled the bytecode; a local/dev chain is skipped with the reason instead of pretending |
| 📜 **Activity** | Local tx history with explorer links (sidebar item next to Dashboard) |
| 🌐 **DApps** | Web3 DApps browser — 18 curated DApps behind **one omnibox** (type to filter name/category/URL, paste an address and an **Open** button appears; Enter opens it) plus category chips, split into two sections inside the one grid: **Ready in-app** (Aave, Balancer, Lido, Snapshot — green badge) and **Opens in a new tab** (the other 14). Every card keyboard-operable with an accessible name. iframe for sites that permit framing (Aave, Balancer, Lido, Snapshot); the other 14 ship `X-Frame-Options` / `frame-ancestors` clickjacking protection, so **no** in-app browser can embed them — those are labelled `↗ new tab` and open externally instead of showing a blank frame. See [DApps & framing](#-dapps--why-most-dapps-open-in-a-new-tab) |
| 📱 **Mobile parity** | The bottom bar is **generated from the desktop sidebar**, so it cannot drift from it: **Dashboard · Activity · Swap · DApps · Settings**, five slots, no "More". A sixth button whose contents you had to guess was the wrong trade for a thumb. The five views that no longer fit are still reachable without a sheet — **Send**, **NFT** and **Tools** from Dashboard quick actions, **Bridge** from a second press of Swap, **Discord** from a Dashboard quick action. Those routes are written down in `REACHABLE_ON_MOBILE` in `app.js`, so the next person to remove a bottom-bar button can see what they just cut off |
| 🖼️ **NFT** | NFT gallery (on-chain metadata + images) that loads on a **locked** wallet too — enumeration only reads the chain with an address that is already public, so requiring the password left the gallery silently empty after a refresh. OpenSea WL check + mint estimate (price/gas/total), list/cancel/fulfill via Seaport, accept highest offer auto-detect. **OpenSea needs an API key** — see below |
| 🛡 **Security Center** | Back in **Settings → Security Center** (its original home; it had moved into the now-removed Approvals view and returned in M3), **collapsed in a disclosure you open** — closed by default so the page keeps its length and the delete stays last. What a dApp can and cannot reach, connected sites and their per-method grants, both site lists, the live guardrails with the real numbers, what approvals are and how they bite, browsing data, stored keys. It also states the one thing that is easy to get wrong in a wallet's favour — **a cross-origin page cannot detect this wallet at all** |
| ⚡ **MAX** | One button, no arithmetic, and it never guesses. Reserve = fee × gas limit at the live gas price, then the amount is **truncated**, never rounded up, so the reserved remainder is the fee and not a penny of it. Proven against real funds on a fork: 100 → MAX writes 99.999977 → sent exactly 99.999977, fee exactly the reserve |
| 🎨 **Theme** | Full cartoon: chunky borders, soft shadows, 5s skippable logo intro, spinning bear loader |
| 👆 **Pull-to-refresh** | Pull down at the top of the main screen and release → reload balances through the one shared refresh pipeline (`emit('refresh')` → `loadDashboard()`), with a chunky spinner disc that follows the thumb (damped 1:2, 72px commit). Guards proven by test: this layout scrolls `<body>` (read directly, not just `window.scrollY`), horizontal swipes, gestures starting on buttons/inputs, an open modal, and a refresh already in flight never re-trigger. Chrome/Android's own pull-to-refresh is retired at the root (`overscroll-behavior-y: none`) so the SPA never double-reloads — `js/pull-refresh.js` |

---

## 🧭 Where everything is

| | Desktop | Phone |
|---|---|---|
| Dashboard · Activity · Swap · DApps · Settings | sidebar | the five bottom-bar slots |
| Send · NFT · Tools | sidebar | Dashboard quick actions |
| Bridge | second press of Swap | second press of Swap |
| Discord | sidebar | Dashboard quick action |
| Security Center | Settings (collapsed) | Settings (collapsed) |
| EIP-7702, contract wizard, OpenSea panel | Tools | Dashboard → Tools |

Two rules keep that table true rather than aspirational:

- **`MOBILE_PRIMARY` in `app.js` picks the slots, `REACHABLE_ON_MOBILE` beside it
  records how the rest is reached.** A view with no route in that second map is a
  view that exists on desktop and not on a phone — the exact bug the bar was
  rebuilt to remove.
- **The bar is generated from the sidebar**, so a new sidebar view cannot be
  forgotten on mobile. It used to be six hand-written buttons against a nine-item
  sidebar, which put EIP-7702, Approvals and Tools on desktop only.

### Touch targets

`--touch-min` is **44px** and the floor is applied in **one** place —
`css/cartoon.css`, in the `@media (pointer: coarse), (max-width: 768px)` block,
with each control's measured "before" in a comment.

The `768px` is the point of that rule. The phone *layout* (bottom bar, no
sidebar) starts at 768px, so between 561 and 768 the app was showing a
finger-sized layout with mouse-sized controls. Two breakpoints for one decision
is the bug. The separate 560px queries are a different question — two controls
no longer sharing a line — and are not a second floor.

Measured in a browser after the change, across all ten views:

| Viewport | Horizontal overflow | Targets under 44px |
|---|---|---|
| 320 · 390 · 560 · 768 | 0 | 0 |
| 1280 · 1440 (mouse) | 0 | 0 required — 32px desktop floor |

---

## 🚀 Run

```bash
npm ci
npm run dev       # Vite dev server (React views compiled on the fly)
npm run preview   # serve the built bundle from dist/
```

Works offline for wallet ops (quotes need internet).

## 📦 Build (web → HTML/CSS/JS)

The web app is plain **HTML/CSS/JS** at its core — `index.html` + `css/` + `js/`
(runtime), with React views in `src/` compiled by Vite into one static bundle:

```bash
npm run build     # → dist/: index.html + assets/ (hashed js/css) + js/ + assets/
```

`dist/` is the publishable artifact (gitignored). GitHub Pages serves it through
the **Deploy Web (Pages)** workflow (`.github/workflows/pages.yml`):
build → `upload-pages-artifact` → `deploy-pages`, on every push to `master`
or via `gh workflow run pages.yml`.

## 🤖 Android APK

The Android app is a **Capacitor** wrapper over the same web code — one repo,
one source of truth (`capacitor.config.json`, `android/`, `www/` staged from
the Vite build):

```bash
# CI (recommended): Android APK workflow (.github/workflows/apk.yml)
gh workflow run apk.yml
gh run download <run-id> -n bear-tool-apk -D .
```

Local build needs JDK 21 + Android SDK 36:

```bash
npm run build && mkdir -p www && cp index.html www/ && cp -r css js assets www/ \
  && npx cap sync android && cd android && ./gradlew assembleDebug
```

## 🧪 Test

```bash
npm install   # devDependency: ethers (for tests only)
npm run verify
```

`verify` = syntax check all JS, then the unit suite, then the on-chain fork
suite, then the browser suite. That last part used to be a separate script, which
meant "everything is green" could be true while nothing had ever touched a chain —
the approval, swap, deploy and 7702 tests are the only ones that can catch a
contract-level mistake. They skip themselves, with a stated reason, unless anvil
is reachable (`CI=1`, or `FORK_RPC_URL` / `FORK_PORT`), so on a machine with no
foundry the gate reports skips rather than pretending to have passed.

**The browser suite needs Playwright browsers installed** (`npx playwright install
chromium`). The 22 specs are driven by `tools/e2e.mjs`, which serves the app itself
and works on any platform. It is in `verify`, and it exits **5** — neither pass nor
failure — on a machine with no browser, rather than passing without running.

The same suite also runs **on the BrowserStack grid** — no local browser needed,
against the deployed site:

```bash
BEAR_E2E_BROWSERSTACK=1 BEAR_BASE_URL=https://nemoobc.github.io/Bear-Tool/ \
  node tools/e2e.mjs            # or: npm run test:e2e:browserstack
```

That path carries three Termux repairs, applied only after they prove
themselves on the machine: `tools/bin/playwright` (a `#!/bin/sh` shim, because
`/usr/bin/env` does not exist here and npm's launcher dies on its own shebang),
an explicit `PLAYWRIGHT_BROWSERS_PATH` (`playwright-core` throws
`Unsupported platform: android` while computing a cache directory it will never
use), and `browserstackLocal: false` — the specs target a public URL, so there
is no localhost worth tunneling to.

The APK itself gets smoke-tested on a **real Android device in the same cloud**:

```bash
node tools/apk-test.mjs [bs://…]   # upload → session → WEBVIEW DOM assert → screenshot
```

It opens a WebDriver session against the uploaded build, waits out the splash,
asserts the welcome screen's `#wCreate` exists inside the live WebView, saves a
screenshot to `artifacts/`, and closes the session so no device keeps billing.
Measured 2026-10-03: contexts `["NATIVE_APP","WEBVIEW_com.nemoobc.beartool"]`,
verdict OK, Galaxy S23 / Android 13.

`npm test` on its own is still the fast loop. The fork suite needs anvil and
takes minutes: it compiles real Solidity with solc 0.8.37 and runs against a
forked chain. `npm run test:fork` runs one network (`FORK_NETWORK`).

Coverage includes wallet create/import/encrypt/decrypt, network presets,
EIP-7702, session persistence, address poisoning, nav invariants, the dApp
pre-load security gate, the signing guardrails, the injected-provider
refusals, MAX amount arithmetic, and the contract wizard — every standard ×
feature combination compiled with the real solc (including the upgradeable
ERC-1967 builds) plus the auto-verify routing. Plus browser E2E
(`npm run test:e2e`).

### Tests call the app, they do not rebuild it

A swap test that declares its own ABI and calls the router itself proves the
*address* is right. It cannot prove the app works, because the app's code is never
run. Three bugs got through a green suite of 617 unit tests — the count at the
time; the suite has grown since, and the point below is why that alone never
suffices — and a 12-network fork
sweep, and all three surfaced only once a test called the real module:

| Found by | Bug |
|---|---|
| calling `js/swap.js` | Two ABI constants were used but never declared, so every quote and every swap threw. Swapping was dead on every chain. |
| calling `v2Quote` | Swapping ETH for WETH produced a route of one token twice, and the router's raw error reached the user. |
| calling `js/wallet.js` | The phishing guard compared addresses case-sensitively, so pasting your own address again reported **your own wallet as poisoned**. |

Two things came out of that, both enforced in `tests/`:

- A gate is trusted because it goes **red when deliberately damaged**, not because
  it is green. Three gates here were green while unable to fail, including a
  syntax checker that had silently stopped checking a third of the source.
- A test that goes red because its *input* is malformed is not a finding. One
  mistyped address produced a failure that read exactly like a missed phishing
  check.

Two portability traps in this suite are worth knowing about, because both were
invisible until it ran on a second operating system. Test paths come from
`fileURLToPath(new URL(…, import.meta.url))`, never from `URL.pathname` — the
latter returns a percent-encoded POSIX string, which on Windows is `/C:/Users/…`
and resolves to `C:\C:\Users\…`. And no file defaults a path to a Termux-only
absolute location. `tests/audit-regression.test.js` fails the build if either
comes back.

**A green terminal run is not the acceptance test here.** Every layout, touch
target and empty state in this README was found by measuring a real rendered box
in a real browser and comparing the number against the threshold — nine bugs
that a passing test suite had no way to see, including a select that rendered
**1px** wide, a checkbox label at **23px**, and an NFT empty state that had never
been loaded at all because `refreshView` had no `nft` branch. Numbers quoted in
this file are measured, not intended.

## 📁 Structure

```
Bear-Tool/
├── android/         # Capacitor Android project (Gradle assembleDebug)
├── src/             # React views (App.jsx + views/*.jsx), Vite entry
├── index.html          # SPA shell (all views; ethers vendored + SHA-384 SRI)
├── css/cartoon.css     # cartoon theme + intro animation + spinner + reduced-motion
├── js/
│   ├── app.js          # entry: boot, router, topbar, mobile nav, wallet modals,
│   │                   #        dashboard, network picker, add-token autodetect
│   ├── state.js        # singleton state + pub/sub + activity persistence
│   ├── network.js      # networks, CHAIN_PRESETS (verified), tokens, ABIs,
│   │                   #        EIP-7702 constants, delegation, gas price
│   ├── wallet.js       # create/import/encrypt/decrypt/derive/sign
│   ├── ui.js           # modal/toast/spinner/confirm/format/escape helpers
│   ├── i18n.js         # EN/ID translations + t() + data-i18n scanning
│   ├── price.js        # CoinGecko + DexScreener price cache
│   ├── safetx.js       # double-submit lock + error boundary + button loading
│   ├── send.js         # send view: preview, gas estimate, poisoning warnings
│   ├── swap.js         # swap view: auto-route over the registry (real quotes only)
│   ├── bridge.js       # bridge view: quote + execute over the router registry (no simulation)
│   ├── bridge-routes.js# Gas.zip + Relay quote adapters (validated field-by-field)
│   ├── eip7702.js      # delegate/revoke (chainId guard); batch/rescue/claim in tools
│   ├── eip7702-tools.js# helper-contract batch/rescue/airdrop flows
│   ├── deploy.js       # deploy wizard: solc compile → gas → deploy (+ 2-tx proxy) → auto-verify
│   ├── contracts.js    # contract sources + OZ-parity feature flags + ERC-1967 upgradeable transform
│   ├── solc.js         # solc-js loader (SRI-pinned CDN, crossOrigin) + the ONE standard-JSON builder
│   ├── verify.js       # auto-verify: Sourcify v2 (keyless) then Etherscan V2 (user's key), same input
│   ├── dapps.js        # DApps catalogue: filterable grid, category chips
│   ├── nft.js          # NFT gallery (best-effort enumeration)
│   ├── opensea.js      # NFT market actions
│   ├── opensea-api.js  # OpenSea v2 client (needs a user-supplied API key)
│   ├── seaport-abi.js  # Seaport ABI for list/cancel/fulfill
│   ├── registry.js     # token + known-token registry
│   ├── routers.js      # on-chain-verified swap router addresses per chain
│   ├── theme.js        # 5s intro animation
│   ├── dapp-safety.js  # pre-load URL gate: schemes, homographs, lure shapes, user lists
│   ├── dapp-sessions.js# connected sites, per-method grants, block/trust lists
│   ├── dapp-browser.js # the in-app browser: tabs, history, omnibox, bookmarks,
│   │                   #        pre-load gate sheet, external-open notice
│   ├── dapp-bridge.js  # window.ethereum for same-origin pages, with refusals
│   ├── security.js     # calldata decoding, unlimited-approval detection, URL secret hygiene
│   ├── security-center.js # the Settings page that makes all of the above visible
│   ├── max-amount.js   # MAX arithmetic: reserve the fee, truncate, never round up
│   ├── max-ui.js       # MAX against a live node: real fee, real gas limit
│   ├── nft-intel.js    # drop eligibility, cost breakdown, contract safety signals
│   ├── token-picker.js # in-app pickers rendered inside the app, not off-screen
│   └── token-logo.js   # shared token mark renderer (dashboard + pickers)
├── js/vendor/          # vendored runtime deps: ethers.umd.min.js (SRI), qrcode.min.js
├── assets/             # original bear + logo SVG
├── docs/               # PROMPT, ARCHITECTURE-FIX, DESIGN-AUDIT, SECURITY-AUDIT*,
│                       # CHAIN-PRESETS (RPC verification table)
├── tests/              # node:test unit tests
│   ├── e2e/            # Playwright browser suite (npm run test:e2e)
│   └── fork/           # Anvil mainnet/testnet fork tests (run-fork-all.sh)
└── test-contracts/     # Foundry sources for the on-chain fork tests
```

## 🔒 Security notes

- Keys encrypted with **PBKDF2 (310k iterations) + AES-GCM** via Web Crypto — never stored plaintext.
- `ethers` is **vendored** at `js/vendor/ethers.umd.min.js` with a SHA-384 SRI in `index.html`, not fetched from a CDN at runtime. This is the wallet's one hard dependency — no ethers means no wallet — so a blocked or down CDN was a single point of total failure. The CDN build is kept only as a fallback if the vendored copy fails to execute. The version is pinned identically in `package.json` (no caret), so the test suite exercises the exact library the browser runs.
  > This was broken in practice: `.gitignore` carried a bare `vendor/`, which matches any directory named `vendor` at any depth, so `js/vendor/ethers.umd.min.js` was silently ignored and never committed. Every fresh clone 404'd on the wallet's main script and fell through to the CDN fallback — exactly the single point of failure the vendoring existed to remove. The pattern is now `/vendor/` (root only) and the file is tracked. Verified by loading the app with `cdn.jsdelivr.net` blocked: `window.ethers` is 6.17.0 and **zero** CDN requests are made.
- **EIP-7702 is powerful and dangerous**: a malicious delegation = total compromise. Only delegate to audited implementations. Mainnet requires type-4 RPC (Alchemy/QuickNode).
- **Serve over HTTPS or `http://localhost`.** Web Crypto (`crypto.subtle`) is only exposed in a secure context. On plain HTTP from any other host the app boots fine but every keystore operation dies with `Cannot read properties of undefined (reading 'importKey')` — silent and unexplainable. The app now detects this and warns at boot. This is also why the DApps list is not framed blind: `index.html` needs `frame-src https:` for the iframe browser to load anything at all.
- Address poisoning detection flags addresses sharing prefix+suffix.
- **OpenSea API v2 rejects keyless browser requests.** The same
  `GET /api/v2/collections/{slug}` returns `200` from curl and `401` from a page,
  so the WL check, listing lookup and offer lookup cannot work until you paste a
  key into the OpenSea panel. It is stored in `localStorage` (`bear.openseaKey`)
  and sent as `X-API-KEY`; the UI now says exactly that instead of a generic
  "failed to fetch". Get a free key at <https://docs.opensea.io/>.
- **Eligibility is holder-based, and is labelled that way.** OpenSea exposes no
  per-address mint allowlist, so the app checks the one thing that *is* public
  and on-chain: `GET /api/v2/collections/{slug}/holders`, paginated. An address
  in that list is a real holder and is reported as one, with the quantity. It is
  never dressed up as "you are whitelisted" — a project's private allowlist is
  off-chain and no API can read it, so the UI says so instead of guessing.
  The old handler did claim eligibility from collection privacy alone, without
  ever looking at the address, which made the verdict worthless per-address.
- **The "price" shown is a asking price, not a mint price.** OpenSea has no
  mint-price field. The figure is the lowest ask / floor and is labelled that
  way, because calling it a mint price would be a number nobody can verify.
- **Contract safety is a list of signals, not a verdict.** Six independently
  sourced checks (EIP-1967 proxy, `owner()` renounced, `paused()`, a
  transfer-out simulation for honeypots, minted supply, and OpenSea's own
  `is_suspicious`) each render as pass / warn / fail with the reason. There is
  deliberately no single "safe" badge, and the panel states that no automated
  check can prove a mint is safe.
- **A custom RPC is never silently replaced.** `getProvider` walks a list of
  endpoints and returns the first that answers, which for a user-entered override
  is the wrong behaviour: a local fork that was slow on its first call got
  skipped, the wallet connected to a **public node** instead, and the account
  reported a balance it was never funded with while `estimateGas` failed with
  `missing revert data`. Every symptom traced to that one substitution. An
  override is now user intent — it is tried, and if it fails it **throws with the
  URL and the reason** instead of answering from somewhere else. Settings shows
  which node is live, because a provider whose origin is invisible is a provider
  nobody can debug.
- **The NFT gallery used to never load.** `loadNfts` was imported and never
  called — `refreshView` had no `nft` branch — so the view showed its static
  placeholder forever, and that placeholder claimed "No NFTs found" **and**
  "Connect wallet to view your NFTs" simultaneously. It also required `unlocked`,
  so a restored read-only wallet saw the same thing. Both fixed; the outcome is
  now stated by the code that fetched it.
- Mainnet sends/swaps/deploys require typed confirmation.
- This is a reference implementation — audit before real funds.

## 🌐 DApps — why most DApps open in a new tab

**Aave**, **Lido**, **Snapshot** and **Balancer** allow cross-origin framing. The rest
ship clickjacking protection, verified by re-probing live response headers
(2026-09-26 — two rows in an earlier version of this table were wrong):

| DApp | Header | In-app? |
|---|---|---|
| Aave, Balancer, Snapshot | none sent | ✅ frames |
| Lido | `frame-ancestors: *` | ✅ frames (was wrongly listed as blocked) |
| Compound | `X-Frame-Options: DENY` | ↗ new tab (was wrongly listed as frameable) |
| Uniswap, Rocket Pool, Etherscan, Safe | `X-Frame-Options: SAMEORIGIN` | ↗ new tab |
| OpenSea, Blur, Across | `X-Frame-Options: DENY` | ↗ new tab |
| ENS, Zora | `frame-ancestors: 'self'` | ↗ new tab |
| 1inch, Stargate | `frame-ancestors` lists specific wallet hosts only | ↗ new tab |

DApps that refused the probe outright (PancakeSwap, Curve, Yearn, CoW Swap) are
marked new tab rather than guessed at.

No in-app browser can override these — they are enforced by the site, not by
this wallet. Rather than point an iframe at a site that will refuse it and leave
you with a blank frame and a console violation, those cards are labelled
`↗ new tab` and explain the block before you tap. The framed content also runs
in a `sandbox` with **no** `allow-same-origin`, so a DApp page never shares an
origin with the wallet holding your keys.

### WalletConnect projectId

The relay leg (paste a `wc:` URI → the connection comes back here) needs one
project id from [dashboard.reown.com](https://dashboard.reown.com) — free, one
id for the whole app. **No per-DApp registration**: Reown's own FAQ states
*"dApps do not need approval in order to use your projectId"* (checked
2026-10-07). The repo ships a working fallback, so nothing breaks out of the
box; to use your own:

```bash
cp .env.example .env
echo "VITE_WC_PROJECT_ID=your_id_here" >> .env
npm run build   # env is baked at build time
```

Optional, from the same dashboard: an origin **allowlist** (who may use the
id) and **Verify** (shows your domain as verified during pairing).

## 🛡 dApp browser security

Every navigation goes through `dapp-safety.js` before the frame is pointed at
anything. It is honest about being a set of heuristics rather than a malware
scan, and every signal names what it saw:

- **scheme allow-list** — `javascript:`, `data:`, `blob:`, `file:` are never loaded
- **mixed-script / punycode hosts** → refused with no way past. A user allow-list
  can clear "nobody has checked this site" but deliberately **cannot** clear this:
  the user's memory of a dApp's name is exactly what a homograph forges
- **lure words on cheap TLDs** → refused (`.xyz`, `.top`, … with `claim`/`airdrop`/`free-mint`)
- **plain HTTP** → warned, with the consequence spelled out
- **unknown sites** → warned as unknown, never presented as known-good
- **your own blocklist** → honoured, with no override in the UI

The frame itself is hardened: `sandbox="allow-scripts allow-forms allow-popups
allow-modals"` (no `allow-same-origin`, no `escape-sandbox`), `referrerpolicy="no-referrer"`,
`credentialless` (no ambient cookies or storage), and `allow=""` — no clipboard,
microphone or camera, because clipboard-reading is a real drainer vector.

Before any signature, `security.js` decodes the calldata for the calls that
actually cost people money — `approve`, `increaseAllowance`, `setApprovalForAll`,
`permit` — and flags unlimited allowances with the spender named, operator
grants, off-chain permits, unreadable selectors and first-time contracts. Large
amounts ask for a typed confirmation. The raw calldata is always shown, so the
user can check it independently of anything this app claims.

`dapp-bridge.js` provides `window.ethereum` **only to pages served from the
wallet's own origin**, with per-origin consent, a per-method grant for anything
that signs or sends, a method allow-list, and no answer at all while the wallet
is locked. It does not claim to be MetaMask. A cross-origin dApp inside an
iframe can never see it — injection requires a native wrapper, a proxy or a
browser extension, and the Security Center in Settings says exactly that.

Settings → Security lists connected sites and their individual grants, both site
lists, the guardrails in force, and a button to forget the stored API key.

### Native dApp browser (Android build)

On Android, `BearDappBrowser` opens any URL **in-app** — a full-page WebView
belongs to the wallet, not an external browser and not an iframe. There is no
allow-list: `http://` and `https://` open as-is, `javascript:` / `data:` /
`file:` / `wc:` schemes are refused at the native gate with a readable message
(the same policy as MetaMask's in-app browser). The provider is injected before
the page's own scripts on every navigation (triple-hook: start/commit/finish),
announces itself via EIP-6963, and answers the full EIP-1193 surface — connect,
`personal_sign`, `eth_signTypedData_v4`, `eth_sendTransaction`, plus read-only
RPC (`eth_blockNumber`, `eth_getBalance`, `eth_call`, …) forwarded to the
wallet's own node like MetaMask does. Every sign/send request flashes the same
confirm modal the wallet itself uses, and the site's origin is named by native
code, never by the page.

Research & evidence: `docs/research/dapp-browser-all-url-2026-10-10.md`.

## 📄 License

MIT — use freely, build your own. Original code, no copying from MetaMask/OKX/EIP-7702-TOOL.