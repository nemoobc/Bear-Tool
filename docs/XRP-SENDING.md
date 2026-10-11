# XRP sending — what is verified, what is still blocked

Status: **receive-only.** Deriving an XRP address is done and proven; *signing*
a transaction is not implemented. This note records the research so the next
attempt does not start from zero, and so the boundary is explicit rather than
implied.

## What is already proven (address side)

Implemented in `js/coin-trees.js`, asserted in `tests/coin-trees.test.js`:

- Address format: `0x00 ‖ RIPEMD160(SHA256(pubkey)) ‖ sha256d[0:4]`, 25 bytes.
- **XRP's own base58 alphabet**, not Bitcoin's — `p` is 0, `r` is the leading
  zero byte. Getting this wrong decodes to 20 wrong bytes and the checksum then
  looks self-consistent, which is how the first attempt shipped a broken
  address that only a real address could expose.
- Verified by round-tripping two live mainnet addresses:
  `rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh`, `rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH`.
- `DestinationTag` is derived from the account's key material, so it is stable
  for the life of the account — a tag that moves between sessions strands
  deposits at exchanges.

## Signing — the researched rules (from rippled, not from memory)

Sources, fetched 2026-10-11 from `github.com/XRPLF/rippled` @ `develop`:

**1. Field codes** — `include/xrpl/protocol/detail/sfields.macro`:

| Field | Type | Code |
|---|---|---|
| `Account` | ACCOUNT | 1 |
| `Amount` | AMOUNT | 1 |
| `Flags` | UINT32 | 2 |
| `TransactionType` | UINT16 | 2 |
| `Destination` | ACCOUNT | 3 |
| `SigningPubKey` | VL | 3 |
| `Sequence` | UINT32 | 4 |
| `Fee` | AMOUNT | 8 |
| `DestinationTag` | UINT32 | 14 |

**2. The signing digest** — `src/libxrpl/protocol/STObject.cpp`:

```cpp
UInt256 STObject::getSigningHash(HashPrefix prefix) const {
    Serializer s;
    s.add32(prefix);                       // HashPrefix::TxSign
    add(s, WhichFields::OmitSigningFields); // everything except the signature
    return s.getSHA512Half();
}
```

So: `digest = SHA512Half( 0x53545800 ‖ canonical(txn minus signature) )`.
`SHA512Half` takes bytes 32…64 of the SHA-512 output — not the first half.

**3. Prefix** — `src/libxrpl/protocol/STTx.cpp`, `getSigningData()`:
`s.add32(prefix)` before the body, i.e. `TxSign = 0x53545800` ("STX\0").

## Why nothing is implemented yet

A transaction encoder needs four more things this codebase does not have:

1. **Canonical field ordering** — the SField comparator (`canonicalFieldLess`)
   was not located in the fetched sources; it determines byte order, and byte
   order determines the TxID.
2. **Amount encoding** — XRP amounts are *not* just a u64 of drops. The type
   is `AMOUNT`, which is either a 48-bit drop value or a full IOU with mantissa
   / exponent / currency, chosen by a leading bit. Passing drops where an IOU
   is expected silently decodes wrong.
3. **DER + low-S normalisation** — XRPL rejects a signature with a high S.
4. **A byte-exact oracle.**

### On the oracle

XRPL mainnet and devnet were both reachable from the build environment
(`xrplcluster.com` ledger 107585322; `s.altnet.rippletest.net:51234` build
3.4.1), and `account_info`, `fee`, `ledger_current` all answer normally. But:

- no public node reached from here serves `tx_blob` in `account_tx`/`ledger`,
  so a real signed transaction could not be pulled to compare against;
- `tx_format` (the JSON ⇄ binary codec, which would have been the ideal
  oracle) returns `unknownCmd` on both networks.

So the encoder has **no way to prove itself byte-for-byte today**.

This is the same position that caught two earlier near-misses: the XRP checksum
and the Solana SLIP-0010 derivation both *looked* right and were only caught
because a published vector existed. Writing an XRPL signer without one would
repeat that failure mode on the code path that moves money.

## What unblocks it

Any one of:

- a signed XRPL Payment (hex blob + its TxID) from a full ledger archive;
- access to a node that serves `tx_blob`;
- a `tx_format`-capable endpoint;
- the canonical field-order comparator from rippled, plus the
  `STAmount`/`STObject` serializers, so the encoder can be diffed against the
  reference implementation rather than against prose.

Once one of those exists, the work is mechanical and the existing digest rule
plus the recovered field codes are most of it.