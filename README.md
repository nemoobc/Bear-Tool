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
| 🌐 **Networks** | 12 EVM networks: 6 mainnet (Ethereum, BSC, Polygon, Arbitrum, OP, Base) + 6 testnet (Sepolia, Amoy, Arbitrum Sepolia, OP Sepolia, Base Sepolia, BSC Testnet), RPC fallback chain, custom network + custom RPC. Settings → **Testnet mode** toggle hides testnets |
| 🪙 **Assets** | Native + 19 popular ERC-20 balances (USDT, USDC, DAI, WETH, WBTC, LINK, UNI, AAVE, SHIB, MATIC, ARB, OP, PEPE, CRV, SNX, SUSHI, COMP, MKR, LDO) |
| ✈️ **Send** | Native + ERC-20, gas speed (slow/normal/fast), live preview + est. gas, paste button, address validation + poisoning detection |
| 🔄 **Swap** | Real quotes only — auto-route KyberSwap → Uniswap V3 → Uniswap V2 (on-chain verified routers, incl. Sepolia V2), slippage control, flip. No simulation: no route = honest error. The Swap nav button is also the Bridge entry (tap it twice to choose) |
| 🌉 **Bridge** | LI.FI quotes (real API, fetch timeout), native-only fail-closed, all chains — reaches `#view-bridge` from the Swap chooser, no separate nav item |
| ⚡ **EIP-7702** | Delegate to implementation (chainId 0 = all chains, replay warning), revoke, batch atomic call, rescue atomic, claim + forward airdrop. Batch/Rescue/Claim each require deploying their helper contract first (step 1 in the Tools view) — no silent auto-deploy |
| 🔐 **Approvals** | Scan popular/custom token approvals, detect UNLIMITED, revoke to 0 |
| 🧙 **Deploy** | Wizard for ERC-20 / ERC-721 / ERC-1155 — real in-browser solc compile (CDN fallback if the primary mirror is blocked) |
| 📜 **Activity** | Local tx history with explorer links (sidebar item next to Dashboard) |
| 🌐 **DApps** | Web3 DApps browser — iframe for sites that permit framing (Aave, Compound, Snapshot) + a curated URL box. Uniswap, OpenSea, Blur, Lido, Rocket Pool, Etherscan and ENS ship `X-Frame-Options` / `frame-ancestors` clickjacking protection, so **no** in-app browser can embed them; those open in a new tab instead of showing a blank frame. See [DApps & framing](#-dapps--why-most-dapps-open-in-a-new-tab) |
| 🖼️ **NFT** | NFT gallery (on-chain metadata + images), per-card sparklines (CoinGecko price history), OpenSea WL check + mint estimate (price/gas/total), list/cancel/fulfill via Seaport, accept highest offer auto-detect. **OpenSea needs an API key** — see below |
| 🎨 **Theme** | Full cartoon: chunky borders, soft shadows, 5s skippable logo intro, spinning bear loader |

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

`verify` = syntax check all JS + 268 unit tests (267 pass, 1 skip; network data, custom networks, testnet toggle, EIP-7702 delegation detection, wallet create/import/encrypt/decrypt/derive, session persist, address poisoning, nav/status UI invariants, Sepolia swap constants). Plus browser E2E (`npm run test:e2e`, 65 tests) and on-chain fork tests for 12 networks (`run-fork-all.sh`, 10 fork tests per network).

## 📁 Structure

```
Bear-Tool/
├── index.html          # SPA shell (all views, ethers CDN pinned + SRI)
├── css/cartoon.css     # cartoon theme + intro animation + spinner + reduced-motion
├── js/
│   ├── app.js          # entry: boot, router, topbar, wallet modals, dashboard, approvals, activity
│   ├── state.js        # singleton state + pub/sub + activity persistence
│   ├── network.js      # networks, tokens, ABIs, EIP-7702 constants, delegation, gas price
│   ├── wallet.js       # create/import/encrypt/decrypt/derive/sign (unchanged core)
│   ├── ui.js           # modal/toast/spinner/confirm/format/escape helpers
│   ├── i18n.js         # EN/ID translations + t() + data-i18n scanning
│   ├── price.js        # CoinGecko + DexScreener price cache
│   ├── safetx.js       # double-submit lock + error boundary + button loading
│   ├── send.js         # send view: preview, gas estimate, poisoning warnings
│   ├── swap.js         # swap view: auto-route KyberSwap → Uniswap V3 → V2 (real quotes only)
│   ├── bridge.js       # bridge view: LI.FI quote (real API, no simulation)
│   ├── eip7702.js      # delegate/revoke (chainId guard), batch, rescue, claim
│   ├── deploy.js       # deploy wizard (honest stub)
│   ├── nft.js          # NFT gallery (best-effort enumeration)
│   └── theme.js        # 5s intro animation
├── assets/             # original bear + logo SVG
├── docs/PROMPT.md      # full build prompt spec (for AI agents)
└── tests/              # node:test unit tests
```

## 🔒 Security notes

- Keys encrypted with **PBKDF2 (310k iterations) + AES-GCM** via Web Crypto — never stored plaintext.
- `ethers` is **vendored** at `js/vendor/ethers.umd.min.js` with a SHA-384 SRI in `index.html`, not fetched from a CDN at runtime. This is the wallet's one hard dependency — no ethers means no wallet — so a blocked or down CDN was a single point of total failure. The CDN build is kept only as a fallback if the vendored copy fails to execute. The version is pinned identically in `package.json` (no caret), so the test suite exercises the exact library the browser runs.
- **EIP-7702 is powerful and dangerous**: a malicious delegation = total compromise. Only delegate to audited implementations. Mainnet requires type-4 RPC (Alchemy/QuickNode).
- **Serve over HTTPS or `http://localhost`.** Web Crypto (`crypto.subtle`) is only exposed in a secure context. On plain HTTP from any other host the app boots fine but every keystore operation dies with `Cannot read properties of undefined (reading 'importKey')` — silent and unexplainable. The app now detects this and warns at boot. This is also why the DApps list is not framed blind: `index.html` needs `frame-src https:` for the iframe browser to load anything at all.
- Address poisoning detection flags addresses sharing prefix+suffix.
- **OpenSea API v2 rejects keyless browser requests.** The same
  `GET /api/v2/collections/{slug}` returns `200` from curl and `401` from a page,
  so the WL check, listing lookup and offer lookup cannot work until you paste a
  key into the OpenSea panel. It is stored in `localStorage` (`bear.openseaKey`)
  and sent as `X-API-KEY`; the UI now says exactly that instead of a generic
  "failed to fetch". Get a free key at <https://docs.opensea.io/>.
- **Whitelist (WL) is collection-level, not address-level.** OpenSea exposes no
  per-address whitelist endpoint, so the app reports whether a collection is
  public or private and tells you the WL is managed off-chain — it never invents
  a per-address "you are whitelisted" verdict.
- Mainnet sends/swaps/deploys require typed confirmation.
- This is a reference implementation — audit before real funds.

## 📄 License

MIT — use freely, build your own. Original code, no copying from MetaMask/OKX/EIP-7702-TOOL.