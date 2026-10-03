# StellarFlow and the Stellar Ecosystem

This document explains how StellarFlow Checkout uses the Stellar ecosystem
— SEP-0007, Horizon, Soroban, and SAC tokens — and links to the relevant
Stellar developer documentation.

---

## SEP-0007 (Payment URIs)

**Used by:** Classic Horizon checkout flow (`packages/core/src/sep0007.ts`)

[SEP-0007](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0007.md)
is a Stellar Ecosystem Proposal that defines a URI scheme for payment requests.
A `web+stellar:pay?...` URI encodes the destination address, asset, amount, and
memo in a format that any compatible Stellar wallet can parse and present to the
user for approval.

StellarFlow uses SEP-0007 to generate a payment URI and QR code when a checkout
session is created. The customer scans the QR code or clicks the deep link in
their wallet app; the wallet pre-fills the payment details; the customer approves
and signs the transaction without StellarFlow ever seeing a private key.

**Key parameters StellarFlow sets:**

| Parameter | Value |
|-----------|-------|
| `destination` | Merchant's Stellar public key |
| `amount` | Quoted crypto amount (XLM or USDC) |
| `asset_code` / `asset_issuer` | `XLM` (native) or `USDC` + Circle issuer |
| `memo` | `MEMO_ID` — the session's uint64 order ID |
| `memo_type` | `MEMO_ID` |

The `MEMO_ID` is the session order ID. Horizon natively indexes payments by memo ID,
so matching an incoming payment to an open session is a single indexed lookup.

**Stellar docs:** [SEP-0007 specification](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0007.md)

---

## Horizon (Stellar Classic)

**Used by:** Classic checkout flow and payment listener
(`packages/core/src/horizon-listener.ts`, `packages/server/src/tx-builder.ts`)

[Horizon](https://developers.stellar.org/docs/data/horizon) is Stellar's REST API
and Server-Sent Events (SSE) gateway for Stellar Classic (non-Soroban) transactions.
StellarFlow uses Horizon in two ways:

1. **SSE payment stream** — `HorizonPaymentListener` opens a persistent SSE connection
   to `GET /accounts/{merchantAddress}/payments?cursor=<N>`. Every payment that arrives
   at the merchant's address is delivered as a server-sent event. The cursor is persisted
   to disk after each event so payments that arrive during server downtime are not missed
   on restart.

2. **Transaction building** — `buildPaymentTx` uses Horizon's
   `GET /accounts/{customerAddress}` to load the customer's sequence number, and
   `GET /fee_stats` to fetch a current base fee, before assembling an unsigned payment
   XDR for in-browser wallet signing (`POST /api/checkout/:orderId/tx`).

StellarFlow defaults to Stellar Testnet (`https://horizon-testnet.stellar.org`).
Mainnet requires explicit opt-in via `STELLAR_NETWORK=mainnet`.

**Stellar docs:**
- [Horizon overview](https://developers.stellar.org/docs/data/horizon)
- [Payments endpoint](https://developers.stellar.org/docs/data/horizon/api-reference/resources/operations/object/payment)
- [SSE streaming](https://developers.stellar.org/docs/data/horizon/api-reference/introduction/streaming)

---

## Soroban (Smart Contracts)

**Used by:** Soroban escrow checkout flow
(`contracts/escrow/src/lib.rs`, `packages/server/src/escrow-session.ts`,
`packages/server/src/escrow-router.ts`)

[Soroban](https://developers.stellar.org/docs/smart-contracts) is Stellar's smart
contract platform, built on the WebAssembly (WASM) virtual machine. Soroban contracts
run on-chain and can hold, transfer, and enforce rules on Stellar assets.

StellarFlow's escrow contract (`contracts/escrow`) is a Rust crate compiled to WASM
and deployed as a Soroban contract. It implements a fund-holding escrow:

- `deposit(payer, merchant, amount, token, order_id, timeout_ledgers)` — locks funds
  in the contract until the merchant releases or the payer reclaims after timeout.
- `release(order_id)` — merchant-authenticated; transfers funds to the merchant.
- `refund(order_id, caller)` — merchant (any time) or payer (after timeout); returns
  funds to the payer.
- `get_escrow(order_id)` — read-only; returns the on-chain escrow record.

The TypeScript integration (`HttpSorobanRpcClient`) uses
[`stellar-sdk@12`](https://www.npmjs.com/package/stellar-sdk)'s `SorobanRpc.Server`
to build, simulate, and submit contract transactions.

**Non-custodial design:** The server constructs unsigned XDR transactions and returns
them to the caller's wallet for signing. The server never holds a private key.

**Stellar docs:**
- [Soroban overview](https://developers.stellar.org/docs/smart-contracts)
- [Soroban SDK (Rust)](https://developers.stellar.org/docs/smart-contracts/getting-started/setup)
- [Soroban RPC](https://developers.stellar.org/docs/data/rpc)
- [stellar-sdk Soroban guide](https://stellar.github.io/js-stellar-sdk/)

---

## SAC Tokens (Stellar Asset Contracts)

**Used by:** Soroban escrow checkout flow (token contract ID per session)

A [Stellar Asset Contract (SAC)](https://developers.stellar.org/docs/smart-contracts/tokens/stellar-asset-contract)
is an automatically deployed Soroban contract that wraps any existing Stellar Classic
asset and makes it callable from Soroban smart contracts. Every Stellar Classic asset
(XLM, USDC, etc.) has a corresponding SAC address on Soroban.

StellarFlow's escrow contract accepts any SAC token as the payment asset. When an
escrow session is created, the caller specifies the `tokenContractId` — the SAC
address of the token to be escrowed (e.g. the USDC SAC address on testnet).

This means the escrow contract works with any Stellar asset that has a SAC, not just
USDC or XLM. The token is fixed at deposit time and enforced in the server's XDR
validation before the transaction is submitted.

**Finding SAC addresses:**
- [Stellar Asset Contract docs](https://developers.stellar.org/docs/smart-contracts/tokens/stellar-asset-contract)
- Native XLM SAC on testnet:
  `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC`
- USDC SAC: deploy via `stellar contract asset deploy --asset USDC:<issuer>`
  (see [contracts/escrow/DEPLOY.md](../contracts/escrow/DEPLOY.md))
