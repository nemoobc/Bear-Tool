# Non-EVM sending — spec, threat model, and what was built (M1…M7)

Status: **implemented.** Bitcoin (P2WPKH), XRP (classic `r…` Payment) and Solana
(System Program transfer) can be sent from the wallet UI. Each chain's signer is
proven against published vectors or a real on-chain transaction, and the money
paths are attacked on purpose in `tests/non-evm-redteam.test.js`.

This document is the source of truth for sending on BTC/SOL/XRP. It absorbs the
earlier research record `docs/XRP-SENDING.md`, which is now removed.

---

## 1. SPEC — what happens

### INPUT
- From the wallet UI only (never from a dApp): the active network is one of
  BTC / SOL / XRP, the wallet is unlocked, the user types/pastes a **destination
  address**, a **tag** where the chain has one (XRP `DestinationTag`), and an
  **amount** in the chain's display unit.
- Units: BTC 8, SOL 9, XRP 6 decimals. Conversion is integer-only (bigints);
  there is no floating point anywhere in the amount path.

### OUTPUT
- A **review sheet** (`confirmTx`): destination in full, amount, network fee,
  total, network name, and (BTC) the change address. Nothing is signed until the
  user confirms.
- After confirm: a **txid / signature / hash**, an Activity row `pending`, then
  `confirmed` or `failed` (with the node's reason, verbatim).
- The seed is never an output: only signed bytes leave the device.

### ATURAN (rules)
1. **Address validation is per chain and per network.** BTC: bech32 `bc1q`/`tb1q`
   (P2WPKH v0) or base58check `1…`/`3…` with a real checksum, and the HRP/version
   must match the ACTIVE network. XRP: classic `r…` base58check (its own
   alphabet). SOL: base58 of exactly 32 bytes.
2. **Cross-chain / wrong-network / unsupported addresses are refused by name** —
   taproot `bc1p…`, XRP `X…` (X-address), a `tb1…` on mainnet: explicit error.
3. **XRP `DestinationTag` is a separate, optional field** — never defaulted, and
   validated as a uint32 only when the user supplies one.
4. **Fees are computed locally and shown before signing**; a node's suggestion is
   a hint (BTC rate) or a floor (XRP 12 drops, SOL 5000 lamports/signature).
   The fee on the sheet is the fee the chain pays: when a BTC change output is
   below dust it is dropped and the whole remainder becomes the fee, so that
   exact remainder is shown rather than the two-output estimate.
5. **Units are explicit**: satoshi / lamport / drop.
6. **Signing is local** — vendored ethers `SigningKey` for secp256k1, the
   coin-trees ed25519 arithmetic for Solana. No key material is ever passed to a
   `fetch`.
7. **Broadcast goes through one allowlisted https module** (`js/non-evm-rpc.js`);
   no dynamic host from user input, no plain http (loopback only under `debug`).
8. Send is offered **only for the three chains above**; the other five EVM-only
   views (swap, bridge, deploy, nft, activity) keep the existing refusal.
9. **The XRP reserve is read from the ledger, never assumed.** `server_info`
   (`reserve_base_xrp` / `reserve_inc_xrp`) plus the account's owner count gives
   the reserve; it is subtracted from MAX and added to the pre-sign check,
   because the ledger rejects a payment that would drop the account below it
   (`tecUNFUNDED_PAYMENT`). The values are set by fee voting and have changed
   (the mainnet base reserve is 1 XRP today).

### ERROR (situations + behaviour)
| Situation | Behaviour |
|---|---|
| Bad checksum / wrong chain address | refuse before the review sheet, name the reason |
| Amount ≤ 0, non-numeric, or > spendable | refuse, show the spendable balance |
| BTC amount below dust (546 sat) | the change output is dropped and the remainder becomes the fee — the sheet shows that exact fee, and the amount is refused if the remainder cannot pay a relayable fee |
| XRP amount that would break the account reserve | refuse before signing, name the reserve it would leave behind |
| No spendable UTXO / no balance | refuse, "nothing to spend on this address yet" |
| Locked wallet | refuse, "Unlock the wallet to send" |
| Fee fetch fails | BTC falls back to blockstream.info estimates; never silently 0 |
| Broadcast rejected by node | keep the row `failed` with the node's verbatim reason; no blind retry |
| Double-tap of Send | button disabled after the first press; one broadcast per review |
| Network switched mid-flow | `refreshView` re-reads the active network on every entry |

### NON-GOAL (deliberately NOT built)
SPL tokens, XRP issued currencies / trust lines, BTC taproot (bech32m `bc1p`),
multisig, PSBT interchange, RBF UI, hardware wallet, message signing,
dApp-initiated sends on these chains, auto-conversion from USD, batch sends,
XRP X-addresses, XRP memos, BTC taproot-multisig.

---

## 2. THREAT MODEL (real funds — payment surface)

| | |
|---|---|
| **ASET** | seed/private keys (P0), funds (P0), transaction integrity (P0), address integrity (P0), privacy (P2) |
| **AKTOR** | device thief / malware, malicious or compromised RPC node, MITM, clipboard-swapping malware, hostile dApp page, user error |
| **JALUR** | (1) wrong-network broadcast, (2) address substitution in UI/clipboard, (3) lying RPC (UTXO set / blockhash / fee), (4) unit or decimal confusion, (5) XRP wrong/missing tag, (6) signed-digest corruption, (7) key exfiltration, (8) double broadcast, (9) dApp-initiated send |
| **DAMPAK** | (1) P0 funds to the wrong chain, (2) P0 funds to the attacker, (3) P0 tx built on false inputs, (4) P0 1000× wrong amount, (5) P0 exchange credit lost, (6) P0 invalid/mis-signed tx, (7) P0 total loss, (8) P1 duplicate spend, (9) P0 dApp drains the user |
| **MITIGASI** | (1) HRP/version checked against the ACTIVE network + network name in the review sheet; (2) address shown in full, checksum-validated, confirmed by the user; (3) digest built and signed locally, only signed bytes are sent, untrusted UTXO fields are shape-checked in `btcUtxos` (a bad txid/vout/value is dropped before it can be signed); (4) integer-only conversion helpers, one per chain, vector-tested; (5) explicit tag field, no default, repeated in the sheet; (6) signing proven by official vectors (BIP143, XRP mainnet fixture, RFC 8032) + red-team; (7) no key in any fetch; (8) button disabled after the first press; (9) dApp paths keep refusing non-EVM with 4901 |
| **SISA** | Taproot and other unsupported destinations are refused (accepted). A malicious RPC can stall or hide a transaction but cannot redirect funds (accepted — the digest is local). Mainnet sends cannot run in CI: only offline vectors + testnet are automated; mainnet is the user's (accepted, stated openly). Sending to a Solana token-account address burns SOL and is not locally detectable (accepted, documented). |

**Resolved during M7:** the Solana zero key ("111…1", the System Program's own
address) is a valid key with no private key — a transfer to it is accepted and the
funds are gone. It is now refused by name.

**Resolved during the end-to-end bug hunt (post-M7):**
1. **BTC fee under-reported.** `buildBtcSend` dropped a below-dust change output
   but reported the *estimated* fee and a non-zero change; the sheet said 545 sat
   while the chain took 1000 sat (rate 5, 100000 in, 99000 out). The builder now
   reports the fee the chain pays (`total - amount` when change is dropped), the
   send prices through one `btcSendFee()` helper that charges that exact
   remainder, and an amount that cannot pay a relayable fee is refused up front.
2. **Activity row printed "[object Object]".** `record()` stored the whole
   decoded-address object as `detail`, which `escapeHtml` renders as text. It now
   stores a readable string (`to <short address>`, plus the XRP tag when present)
   and the destination as a plain address string.
3. **Wrong explorer links.** XRP links used `/transactions/` — XRPScan documents
   `/tx/` (mainnet, and `testnet.xrpscan.com` for testnet); and the Solana devnet
   base carried `?cluster=devnet` in front of the path, producing a dead URL. All
   transaction links now come from one `explorerTxUrl()` with the cluster as a
   suffix.
4. **XRP reserve wrong and unenforced.** A hardcoded 10 XRP reserve withheld 9 XRP
   from MAX (the mainnet base reserve is 1 XRP) and the manual path never checked
   it, so an amount that broke the reserve was submitted and rejected on-ledger.
   The reserve is now read from the ledger and enforced before signing.

---

## 3. MODULE MAP

| File | Responsibility |
|---|---|
| `js/chain-btc.js` | decode BTC addresses; BIP143 P2WPKH sighash; low-S DER sign; serialize; `buildBtcSend`, `estimateVsize`, `btcTxid` |
| `js/chain-xrp.js` | decode classic `r…`; canonical field ordering + wire serialization; SHA-512Half; DER sign; `buildSignedXrp`, `xrpTxHash` |
| `js/chain-sol.js` | compact-u16; legacy message compiler; System transfer instruction; ed25519 sign; `buildSolSend`, `ed25519Verify` re-export |
| `js/non-evm-rpc.js` | the ONLY network edge: https allowlist, timeouts, and normalisation of mempool.space / blockstream.info / rippled / Solana JSON-RPC; `explorerTxUrl` (one place for every chain's tx link) and `xrpReserveDrops` (ledger-read reserve) |
| `js/non-evm-send.js` | the Send panel for the three chains: pricing (`btcSendFee`), review sheet, broadcast, Activity row |
| `js/coin-trees.js` | shared primitives: base58, bech32, ed25519 (sign + verify), per-chain keypairs |

Wiring in `js/app.js`: `refreshView('send')` routes a non-EVM network to
`loadNonEvmSend`; the EVM-only gate (`EVM_ONLY_VIEWS`) still refuses the other
five views; `renderNonEvmHome` offers Send + Receive.

---

## 4. MILESTONES — each with its evidence

| M | Deliverable | Evidence (measured) |
|---|---|---|
| M1 | this spec + threat model | this file |
| M2 | BTC P2WPKH send | `tests/chain-btc.test.js` — 15 tests; the BIP143 official P2WPKH vector is reproduced byte-for-byte (sighash `c37af311…`, DER `30440220…`, full signed hex), plus the fee the builder reports must equal the fee the chain pays |
| M3 | RPC + broadcast + Activity | `tests/non-evm-rpc.test.js` — 30 tests, fully offline (mocked fetch); allowlist, timeout, UTXO hardening, both fee backends, ledger-read XRP reserves, explorer links |
| M4 | XRP Payment | `tests/chain-xrp.test.js` — 12 tests; a real mainnet payment (ledger 107591743, hash `024B165844BEEF347E40992FBB71C4D281EB364E2491E5285015802D53A2EA3C`) re-serializes to the exact signed hash, and the published signature recovers to the published account |
| M5 | SOL System transfer | `tests/chain-sol.test.js` — 14 tests; a real mainnet transaction is rebuilt byte-for-byte from its plain fields, and the published signature verifies against the sender's address (which IS the 32-byte ed25519 key) |
| M6 | Send UI + wiring | `tests/non-evm-send.test.js` — 20 tests; confirm-before-sign, key from the active account, no raw fetch, MAX subtracts the fee, the shown fee equals the paid fee, the history row carries a string, the XRP reserve is ledger-read |
| M7 | audit + red-team + docs | `tests/non-evm-redteam.test.js` — 25 tests attacking the money paths; `npm run check` + full `npm test` green |

---

## 5. WHAT THE WORK TURNED UP (bugs found by building + red-teaming)

1. **base58 had an off-by-one for an all-zero value** (`js/coin-trees.js`).
   The accumulator was seeded `[0]`, which is harmless once a real byte is folded
   in — but for a value that is *entirely* zero bytes the loop never runs, so the
   seed added one extra digit. `base58Encode(new Uint8Array(32))` returned **33**
   `1`s, and Solana's System Program address (32 zero bytes) decoded to 33 bytes.
   Fixed by starting the accumulators empty. This is why the SOL fixture's account
   list could not be decoded before the fix.

2. **XRP accepted a zero-drop Payment.** `buildSignedXrp` had no lower bound on
   `amountDrops`, so `"0"` produced a signed blob the ledger refuses
   (`temBAD_AMOUNT`). Now refused, with the same guard rejecting `"-1"` and
   `"1.5"` (the latter previously leaked ethers' `Cannot convert … to a BigInt`).

3. **Solana zero-key destination** (see §2) — refused by name.

4. **Untrusted UTXO fields** (`js/non-evm-rpc.js`) — a node-supplied txid that is
   not 32 bytes, a fractional/negative `vout`, or a non-positive `value` is now
   dropped in `btcUtxos` instead of being signed into an unconfirmable transaction.

## 6. XRP research (absorbed from `docs/XRP-SENDING.md`)

Field codes (rippled `sfields.macro`): `Account` ACCOUNT 1, `Amount` AMOUNT 1,
`Flags` UINT32 2, `TransactionType` UINT16 2, `Destination` ACCOUNT 3,
`SigningPubKey` VL 3, `Sequence` UINT32 4, `Fee` AMOUNT 8, `DestinationTag`
UINT32 14. Type codes from `definitions.json`: UInt16 1, UInt32 2, UInt64 3,
Amount 6, Blob 7, AccountID 8. Fields serialized in ascending
`(type << 16 | nth)`. XRP amounts are 8-byte big-endian with the high bit
`0x4000000000000000` set. The signing preimage is `0x53545800 ‖ body`; the tx id
prefix is `0x54584E00`.

**Correction to the earlier note:** `SHA512Half` is the **first 32 bytes** of the
SHA-512 output, not bytes 32…64. The implemented
`sha512half` (`ethers.sha512(bytes).slice(0, 32)`) reproduces the real mainnet
hash, which is the proof; the earlier prose was wrong.

The old note's blocker was "no byte-exact oracle". That is resolved: a real
mainnet Payment from the ledger archive is now the oracle, and the encoder is
proven against it.
