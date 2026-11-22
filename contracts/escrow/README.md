# StellarFlow Escrow Contract

A Soroban smart contract that holds funds until a merchant releases them or a payer reclaims them. This is the on-chain component of StellarFlow's non-custodial checkout mode.

---

## Honest limitations

**No token whitelist.** The contract accepts any Stellar Asset Contract (SAC) address. A malicious token contract could report a successful `transfer` call without actually moving funds, causing the escrow record to show `Held` while no real funds were locked. The protection against this is at the server layer: `escrow-router.ts` pins a single SAC token address per session and validates it before building a deposit transaction. The escrow contract itself provides no protection against a deliberately broken token.

**Timeout chosen by the depositor.** The `timeout_ledgers` parameter is passed by whoever calls `deposit`. The server validates that it does not exceed `MAX_TIMEOUT_LEDGERS` (≈ 1 year at 5 s/ledger), but within that cap the depositor controls the timeout. A very short timeout gives the payer a narrow refund window; a very long one ties up the merchant's expected funds for an extended period.

**No arbitration.** There is no third-party dispute mechanism. The only paths to resolution are: merchant calls `release` (funds go to merchant), or payer or merchant calls `refund` (funds go back to payer). There is no partial release, no split, and no way to change the beneficiary after deposit.

**TTL is not automatic.** Persistent storage entries on Stellar/Soroban expire if their TTL is not extended. The state-changing functions (`deposit`, `release`, `refund`) extend the TTL on each call. A held escrow that sits idle for longer than `TTL_EXTEND_TO` ledgers (≈ 2 years at 5 s/ledger) without any contract call will have its entry archived by the network. Archived entries cannot be queried by `get_escrow` and would appear as `NotFound`. Either the payer, the merchant, or an automated keeper bot must call `extend_escrow_ttl` periodically for long-running held escrows. This is not done automatically.

**Unaudited.** This contract has not been professionally audited. Use on mainnet is at your own risk.

---

## How it differs from classic Horizon checkout

The classic StellarFlow checkout (`packages/server/src/checkout-session.ts`) uses Stellar's built-in payment operations via the Horizon API. Funds move directly from payer to merchant in a single Horizon transaction; there is no holding period and no refund path once confirmed.

The escrow contract holds funds in a Soroban contract account for a configurable period. The merchant must call `release` to receive funds. If the merchant never acts, the payer can call `refund` once `timeout_ledgers` ledgers have elapsed. This creates a time-bounded escrow that protects buyers without requiring the server to hold private keys.

The two modes operate independently. The escrow contract does not modify the Horizon checkout path.

---

## Functions

| Function | Auth required | Returns | Errors |
|---|---|---|---|
| `deposit(payer, merchant, amount, token, order_id, timeout_ledgers)` | `payer` | `()` | `InvalidAmount` (8), `SameParty` (9), `TimeoutTooLong` (10), `AlreadyExists` (1) |
| `release(order_id)` | merchant recorded at deposit time | `()` | `NotFound` (2), `AlreadyReleased` (3), `AlreadyRefunded` (4) |
| `refund(order_id, caller)` | `caller` (must be payer or merchant) | `()` | `NotFound` (2), `AlreadyReleased` (3), `AlreadyRefunded` (4), `NotAuthorized` (6), `TimeoutNotElapsed` (7) |
| `get_escrow(order_id)` | none | `EscrowRecord` | `NotFound` (2) |
| `extend_escrow_ttl(order_id)` | none | `()` | `NotFound` (2) |

### Error codes

| Code | Name | Meaning |
|---|---|---|
| 1 | `AlreadyExists` | An escrow for this `order_id` already exists |
| 2 | `NotFound` | No escrow for this `order_id` (or entry has expired) |
| 3 | `AlreadyReleased` | Escrow has already been released |
| 4 | `AlreadyRefunded` | Escrow has already been refunded |
| 5 | `NotMerchant` | (reserved) Caller is not the merchant |
| 6 | `NotAuthorized` | Caller is neither payer nor merchant |
| 7 | `TimeoutNotElapsed` | Payer-initiated refund attempted before timeout |
| 8 | `InvalidAmount` | `amount` is zero or negative |
| 9 | `SameParty` | `payer` and `merchant` are the same address |
| 10 | `TimeoutTooLong` | Non-zero `timeout_ledgers` exceeds `MAX_TIMEOUT_LEDGERS` |

### Events

| Event | Topics | Data fields |
|---|---|---|
| `Deposited` | `("escrow", "deposited", order_id)` | `payer`, `merchant`, `token`, `amount` |
| `Released` | `("escrow", "released", order_id)` | `payer`, `merchant`, `token`, `amount` |
| `Refunded` | `("escrow", "refunded", order_id)` | `payer`, `merchant`, `token`, `amount`, `caller` |

The `order_id` topic is a `BytesN<32>`, making each state transition indexable by order.

---

## Constants

| Constant | Value | Meaning |
|---|---|---|
| `DEFAULT_TIMEOUT_LEDGERS` | 518,400 | Default timeout: 30 days at ~5 s/ledger |
| `MAX_TIMEOUT_LEDGERS` | 6,307,200 | Maximum timeout: 1 year at ~5 s/ledger |
| `TTL_THRESHOLD` | 3,153,600 | TTL below which entries are extended on state change |
| `TTL_EXTEND_TO` | 12,614,400 | Target TTL for extensions (≈ 2 years); clamped to network max |

---

## State machine

```
        deposit()
  (new) ─────────▶ Held ──── release() [merchant] ──────────────────▶ Released
                     └─────── refund()  [merchant, any time]  ───────▶ Refunded
                     └─────── refund()  [payer, after timeout] ───────▶ Refunded
```

`get_escrow` and `extend_escrow_ttl` are read/TTL-only and do not change state.

---

## Building

```
stellar contract build
```

Requires stellar-cli v25.2.0+. The `soroban-sdk` build script checks for the CLI at build time. Set `SOROBAN_SDK_BUILD_SYSTEM_SUPPORTS_SPEC_SHAKING_V2=1` to satisfy the check if running `cargo` directly (e.g. for `cargo test` or `cargo clippy`).

```
# Tests
cargo test

# Clippy (wasm target)
SOROBAN_SDK_BUILD_SYSTEM_SUPPORTS_SPEC_SHAKING_V2=1 \
  cargo clippy --target wasm32v1-none -- -D warnings
```
