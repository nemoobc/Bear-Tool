# 🐻 Bear Tool

**The cartoon wallet that means business.**

Self-custody crypto wallet — 100% client-side, all EVM networks (mainnet + testnet), with a full **EIP-7702** suite. Original code, no copying. Cartoon theme built from scratch.

> ⚠️ **Educational / self-custody tool.** Keys never leave your browser. Always verify addresses. Mainnet transactions require extra confirmation (type `YA` to proceed).

---

## ✨ Features

| Area | What it does |
|---|---|
| 🐻 **Wallet** | Create (12-word seed) / import (seed or private key), PBKDF2-310k + AES-GCM encrypted keystore in localStorage, multi-account (m/44'/60'/0'/0/i), auto-lock, export secret |
| 🌐 **Networks** | 12 EVM networks: 6 mainnet (Ethereum, BSC, Polygon, Arbitrum, OP, Base) + 6 testnet (Sepolia, Amoy, Arbitrum Sepolia, OP Sepolia, Base Sepolia, BSC Testnet), RPC fallback chain, custom network + custom RPC |
| 🪙 **Assets** | Native + 19 popular ERC-20 balances (USDT, USDC, DAI, WETH, WBTC, LINK, UNI, AAVE, SHIB, MATIC, ARB, OP, PEPE, CRV, SNX, SUSHI, COMP, MKR, LDO) |
| ✈️ **Send** | Native + ERC-20, gas speed (slow/normal/fast), live preview + est. gas, paste button, address validation + poisoning detection |
| 🔄 **Swap** | 0x API quotes (fallback simulated), slippage control, flip — the Swap nav button is also the Bridge entry (tap it twice to choose) |
| 🌉 **Bridge** | LI.FI quotes (fallback simulated), all chains — reaches `#view-bridge` from the Swap chooser, no separate nav item |
| ⚡ **EIP-7702** | Delegate to implementation (chainId 0 = all chains, replay warning), revoke, batch atomic call, rescue atomic, claim + forward airdrop |
| 🔐 **Approvals** | Scan popular/custom token approvals, detect UNLIMITED, revoke to 0 |
| 🧙 **Deploy** | Wizard for ERC-20 / ERC-721 / ERC-1155 |
| 📜 **Activity** | Local tx history with explorer links |
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

`verify` = syntax check all JS + 22 unit tests (network data, custom networks, EIP-7702 delegation detection, wallet create/import/encrypt/decrypt/derive, address poisoning).

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
│   ├── swap.js         # swap view: 0x quote (simulated fallback)
│   ├── bridge.js       # bridge view: LI.FI quote (simulated fallback)
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