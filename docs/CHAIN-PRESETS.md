# CHAIN_PRESETS — RPC verification

Auto-probed with `node .probe-chains.mjs`: each RPC is asked `eth_chainId` and the
answer is compared against the chainId the preset claims. Re-run it after editing
CHAIN_PRESETS in `js/network.js` — a preset that stops matching must be fixed or
removed, because the picker would silently add a network on the wrong chain.

Result: **7/7 verified** (this file tracks PRESETS only).

> 2026-10-05: eight presets graduated into the shipped network set in
> `js/network.js` (Celo 42220, Gnosis 100, Avalanche 43114, Sonic 146, Linea
> 59144, Scroll 534352, Blast 81457, Mantle 5000) and three more chains
> (zkSync Era 324, Unichain 130, World Chain 480) were added straight to
> NETWORKS without ever being presets. A chain listed BOTH as shipped and as
> an addable preset is the same network in two places (HUKUM 10), so those
> rows left the table below. The shipped set is now 23 networks (17 mainnet +
> 6 testnet) — see README.

| Chain | chainId claimed | chainId answered | RPC |
|---|---|---|---|
| Moonbeam | 1284 | 1284 | ✅ |
| Cronos | 25 | 25 | ✅ |
| Aurora | 1313161554 | 1313161554 | ✅ |
| Polygon zkEVM | 1101 | 1101 | ✅ |
| Mode | 34443 | 34443 | ✅ |
| Metis Andromeda | 1088 | 1088 | ✅ |
| Hoodi | 560048 | 560048 | ✅ |
