# 🐻 Bear Tool

**The cartoon wallet that means business.**

Self-custody crypto wallet — 100% client-side, all EVM networks (mainnet + testnet), with a full **EIP-7702** suite. Original code, no copying. Cartoon theme built from scratch.

> ⚠️ **Educational / self-custody tool.** Keys never leave your browser. Always verify addresses. Mainnet transactions require extra confirmation (type `YA` to proceed).

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

`verify` = syntax check all JS + 144 unit tests (network data, custom networks, testnet toggle, EIP-7702 delegation detection, wallet create/import/encrypt/decrypt/derive, session persist, address poisoning, nav/status UI invariants, Sepolia swap constants).

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
- **EIP-7702 is powerful and dangerous**: a malicious delegation = total compromise. Only delegate to audited implementations. Mainnet requires type-4 RPC (Alchemy/QuickNode).
- Address poisoning detection flags addresses sharing prefix+suffix.
- Mainnet sends/swaps/deploys require typed confirmation.
- This is a reference implementation — audit before real funds.

## 📄 License

MIT — use freely, build your own. Original code, no copying from MetaMask/OKX/EIP-7702-TOOL.