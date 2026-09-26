# CHAIN_PRESETS — RPC verification

Auto-probed with `node .probe-chains.mjs`: each RPC is asked `eth_chainId` and the
answer is compared against the chainId the preset claims. Re-run it after editing
`CHAIN_PRESETS` in `js/network.js` — a preset that stops matching must be fixed or
removed, because the picker would silently add a network on the wrong chain.

Result: **15/15 verified**.

| Chain | chainId claimed | chainId answered | RPC |
|---|---|---|---|
| Celo | 42220 | 42220 | ✅ |
| Gnosis | 100 | 100 | ✅ |
| Avalanche C-Chain | 43114 | 43114 | ✅ |
| Sonic | 146 | 146 | ✅ |
| Linea | 59144 | 59144 | ✅ |
| Scroll | 534352 | 534352 | ✅ |
| Blast | 81457 | 81457 | ✅ |
| Mantle | 5000 | 5000 | ✅ |
| Moonbeam | 1284 | 1284 | ✅ |
| Cronos | 25 | 25 | ✅ |
| Aurora | 1313161554 | 1313161554 | ✅ |
| Polygon zkEVM | 1101 | 1101 | ✅ |
| Mode | 34443 | 34443 | ✅ |
| Metis Andromeda | 1088 | 1088 | ✅ |
| hoodi | 560048 | 560048 | ✅ |
