# 🐻 Bear Tool

**The cartoon wallet that means business.**

Self-custody crypto wallet — 100% client-side, all EVM networks (mainnet + testnet), with a full **EIP-7702** suite. Original code, no copying. Cartoon theme built from scratch.

> ⚠️ **Educational / self-custody tool.** Keys never leave your browser. Always verify addresses. Mainnet transactions require extra confirmation (type `YA` to proceed).

🔗 **Live:** [nemoobc.github.io/Bear-Tool](https://nemoobc.github.io/Bear-Tool)

---

## ✨ Features

| Area | What it does |
|---|---|
| 🐻 **Wallet** | Create (12-word seed) / import (seed or private key) with optional wallet name (auto-names Wallet, Wallet 1, …), PBKDF2-310k + AES-GCM encrypted keystore in localStorage, multi-account (m/44'/60'/0'/0/i), auto-lock, export secret. Refresh keeps the wallet unlocked (sessionStorage); closing the tab locks it again |
| 🌐 **Networks** | 12 EVM networks built in: 6 mainnet (Ethereum, BSC, Polygon, Arbitrum, OP, Base) + 6 testnet (Sepolia, Amoy, Arbitrum Sepolia, OP Sepolia, Base Sepolia, BSC Testnet), RPC fallback chain. **Add Network is a picker, not a form** — 15 further EVM chains (Celo, Gnosis, Avalanche, Sonic, Linea, Scroll, Blast, Mantle, Moonbeam, Cronos, Aurora, Polygon zkEVM, Mode, Metis, Hoodi) are one tap and fill themselves in; every preset RPC was probed to confirm it answers `eth_chainId` with the chain it claims, and saving re-checks that live. Custom RPC still supported, and it is **used exactly as entered** — if it stops answering, the app says so by name and stops, rather than quietly falling through to a different node. That failure mode was real: a fork endpoint that was slow to answer got skipped, the wallet connected to a public node instead, and the only symptom was a funded account reporting a balance it never had. Settings also shows **which node is live**. Settings → **Testnet mode** toggle hides testnets |
| 🪙 **Assets** | Native balance plus a bundled ERC-20 watchlist: **19 tokens on Ethereum mainnet** (USDT, USDC, DAI, WETH, WBTC, LINK, UNI, AAVE, SHIB, MATIC, ARB, OP, PEPE, CRV, SNX, SUSHI, COMP, MKR, LDO) and 1–2 on each other supported chain — the list is a convenience, not a limit. **+ Add Token** sits under the list; paste an ERC-20 contract address and its name, symbol and decimals are read off the contract and shown before you commit, so a wrong paste is obvious instead of landing as an unlabelled row |
| ✈️ **Send** | Native + ERC-20, gas speed (slow/normal/fast), live preview + est. gas, paste button, address validation + poisoning detection |
| 🔄 **Swap** | Real quotes only — auto-route KyberSwap → Uniswap V3 → Uniswap V2 (on-chain verified routers, incl. Sepolia V2), slippage control, flip. No simulation: no route = honest error. The Swap nav button is also the Bridge entry (tap it twice to choose) |
| 🌉 **Bridge** | LI.FI quotes (real API, fetch timeout), native-only fail-closed, all chains — reaches `#view-bridge` from the Swap chooser, no separate nav item |
| ⚡ **EIP-7702** | Delegate to implementation (chainId 0 = all chains, replay warning), revoke, batch atomic call, rescue atomic, claim + forward airdrop. Batch/Rescue/Claim each require deploying their helper contract first (step 1 in the Tools view) — no silent auto-deploy |
| 🔐 **Approvals** | Scan popular/custom token approvals, detect UNLIMITED, revoke to 0 |
| 🧙 **Deploy** | Wizard for ERC-20 / ERC-721 / ERC-1155 — real in-browser solc compile (CDN fallback if the primary mirror is blocked) |
| 📜 **Activity** | Local tx history with explorer links (sidebar item next to Dashboard) |
| 🌐 **DApps** | Web3 DApps browser — 10 curated DApps with a text filter (name/category/URL) and category chips, every card keyboard-operable with an accessible name. iframe for sites that permit framing (Aave, Compound, Snapshot); Uniswap, OpenSea, Blur, Lido, Rocket Pool, Etherscan and ENS ship `X-Frame-Options` / `frame-ancestors` clickjacking protection, so **no** in-app browser can embed them — those are labelled `↗ new tab` and open externally instead of showing a blank frame. Paste any URL to open it in-app. See [DApps & framing](#-dapps--why-most-dapps-open-in-a-new-tab) |
| 📱 **Mobile parity** | The bottom bar is **generated from the desktop sidebar**, so it cannot drift from it: **Dashboard · Activity · Swap · DApps · Settings**, five slots, no "More". A sixth button whose contents you had to guess was the wrong trade for a thumb. The five views that no longer fit are still reachable without a sheet — **Send**, **NFT** and **Tools** from Dashboard quick actions, **Bridge** from a second press of Swap, **Approvals** from Settings → Security Center. Those routes are written down in `REACHABLE_ON_MOBILE` in `app.js`, so the next person to remove a bottom-bar button can see what they just cut off |
| 🖼️ **NFT** | NFT gallery (on-chain metadata + images) that loads on a **locked** wallet too — enumeration only reads the chain with an address that is already public, so requiring the password left the gallery silently empty after a refresh. OpenSea WL check + mint estimate (price/gas/total), list/cancel/fulfill via Seaport, accept highest offer auto-detect. **OpenSea needs an API key** — see below |
| 🛡 **Security Center** | Settings → Security makes the whole model visible: what a dApp can and cannot reach, connected sites and their per-method grants, both site lists, the live guardrails with the real numbers, live token approvals, browsing data, stored keys. It also states the one thing that is easy to get wrong in a wallet's favour — **a cross-origin page cannot detect this wallet at all** |
| ⚡ **MAX** | One button, no arithmetic, and it never guesses. Reserve = fee × gas limit at the live gas price, then the amount is **truncated**, never rounded up, so the reserved remainder is the fee and not a penny of it. Proven against real funds on a fork: 100 → MAX writes 99.999977 → sent exactly 99.999977, fee exactly the reserve |
| 🎨 **Theme** | Full cartoon: chunky borders, soft shadows, 5s skippable logo intro, spinning bear loader |

---

## 🧭 Where everything is

| | Desktop | Phone |
|---|---|---|
| Dashboard · Activity · Swap · DApps · Settings | sidebar | the five bottom-bar slots |
| Send · NFT · Tools | sidebar | Dashboard quick actions |
| Bridge | second press of Swap | second press of Swap |
| Approvals | sidebar | Settings → Security Center → Review live approvals |
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

No build step. Serve the folder:

```bash
# any static server
python3 -m http.server 8080
# or
npx serve .
```

Open `http://localhost:8080`. Works offline for wallet ops (quotes need internet).

## 🧪 Test

```bash
npm install   # devDependency: ethers (for tests only)
npm run verify
```

`verify` = syntax check all JS + the unit suite, covering wallet
create/import/encrypt/decrypt, network presets, EIP-7702, session persistence,
address poisoning, nav invariants, the dApp pre-load security gate, the signing
guardrails, the injected-provider refusals, and MAX amount arithmetic. Plus
browser E2E (`npm run test:e2e`) and on-chain fork tests for 12 networks
(`run-fork-all.sh`).

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
│   ├── swap.js         # swap view: auto-route KyberSwap → Uniswap V3 → V2 (real quotes only)
│   ├── bridge.js       # bridge view: LI.FI quote (real API, no simulation)
│   ├── eip7702.js      # delegate/revoke (chainId guard), batch, rescue, claim
│   ├── eip7702-tools.js# helper-contract batch/rescue/airdrop flows
│   ├── deploy.js       # deploy wizard: real in-browser solc compile → gas → deploy
│   ├── contracts.js    # standard contract sources for the deploy wizard
│   ├── solc.js         # solc-js loader (SRI-pinned CDN, crossOrigin)
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

## 📄 License

MIT — use freely, build your own. Original code, no copying from MetaMask/OKX/EIP-7702-TOOL.