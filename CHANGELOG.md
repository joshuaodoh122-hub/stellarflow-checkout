# Changelog

All notable changes to StellarFlow Checkout are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
This project uses [Semantic Versioning](https://semver.org/). 

---

## [Unreleased]

### Added

- **Soroban escrow contract** (`contracts/escrow/`) — new Rust/Soroban contract
  implementing a fund-holding escrow flow for delayed-fulfilment orders:
  - `deposit(payer, merchant, amount, token, order_id, timeout_ledgers)` — locks
    funds in the contract, keyed by `order_id`. Rejects duplicate deposits.
  - `release(order_id)` — merchant-gated; transfers held funds to the merchant.
  - `refund(order_id, caller)` — merchant (any time) or payer (after timeout);
    returns held funds to the payer.
  - `get_escrow(order_id)` — read-only getter returning the full escrow record.
  - Default timeout: 30 days / 518,400 ledgers. Configurable per-deposit.
  - 17 Rust tests covering all happy paths and every error path.
  - `soroban-sdk = "=28.0.0"` pinned. `ed25519-dalek` verified to resolve to
    2.2.0 (not 3.x) under `^2.0.0` constraint — no additional pin required.
    See `contracts/escrow/Cargo.toml` for the documented finding.

- **`contracts/escrow/Cargo.lock`** committed (binary/deployable artifact —
  reproducible builds require it; see CONTRIBUTING.md "Rust/Soroban contract setup").

- **CI workflow** (`.github/workflows/contracts.yml`) — separate from the JS/TS
  CI; runs on `contracts/**` path changes. Steps: `cargo fmt --check`,
  `cargo clippy --target wasm32v1-none -- -D warnings`, `cargo test`,
  `cargo build --target wasm32v1-none --release`. Uploads the WASM artifact.

- **`EscrowCheckoutSession` TypeScript type** and **`EscrowClient`** in
  `packages/server/src/escrow-session.ts` — new checkout mode alongside the
  existing Horizon flow:
  - `EscrowClient.deposit()`, `.release()`, `.refund()`, `.getEscrow()`
  - `SorobanRpcClient` interface for mock injection in tests
  - `EscrowClientError` with typed error codes matching the Rust contract
  - `sessionIdToOrderIdHex()` — deterministic session ID → 32-byte order_id
  - `escrowRecordToSessionStatus()` — on-chain status → session lifecycle status
  - 34 TypeScript tests (all mocked, no real network calls)

- **`contracts/escrow/DEPLOY.md`** — deployment guide with real steps and an honest
  note that no live testnet deployment was performed in this PR.

- **`ARCHITECTURE.md`** — Soroban Escrow Contract section: state machine,
  auth model, timeout design rationale, TypeScript integration, session ID mapping.

- **`SECURITY.md`** — Soroban escrow trust assumptions section: what the contract
  guarantees, trust assumptions (key security, no arbitration in v0.2), and
  confirmation that the non-custodial invariant is maintained.

### Changed

- `README.md` escrow status row: "🔨 In development" → "✅ Built & tested —
  deploy pending". Roadmap updated to note partial release/arbitration as
  explicitly out of scope for v0.2.

- `packages/server/src/index.ts` — exports `escrow-session` module.

- `excessStroops: bigint` structured field added to the `'overpaid'` variant of
  `MatchResult` in `packages/core/src/types.ts`. `MatchResult` is now a proper
  3-variant discriminated union; narrowing on `status === 'overpaid'` gives
  `excessStroops` without any cast.

### Changed

- `matchPayment()` overpayment return now includes `excessStroops: excess` directly
  alongside `reason` — the value is set from the already-computed `excess` bigint.
- `PaymentProcessor.process()` regex removed entirely. `result.excessStroops` is
  accessed directly after narrowing on `result.status === 'overpaid'`; no cast required.
  The `result.reason` and `result.status` accesses in the `review_required` branch also
  lost their `as` casts — the narrowed type is now precise enough without them.
- `memo-matcher.test.ts` overpayment test now also asserts
  `(result as { excessStroops: bigint }).excessStroops === 10_000_000n` on the
  structured field directly, in addition to the existing reason-string substring check.

### Notes

- Pure refactor — runtime behavior and all existing assertion values are unchanged.
  216 tests, 11 suites, all pass.
- Optional follow-up flagged: the underpayment branch has the same pattern
  (`shortfall` bigint embedded in a reason string, never exposed as a structured field).
  Consistency would suggest adding `shortfallStroops: bigint` to the `'underpayment'`
  variant of `MatchResult` in a future pass — not done here per task scope.

- Overpayment detection branch in `matchPayment()` (`packages/core/src/memo-matcher.ts`):
  when a payment exceeds the quoted amount by more than `amountToleranceStroops`, returns
  `{ matched: false, status: 'overpaid', reason: '...excess N stroops' }` instead of
  silently treating it as an exact payment.
- `payment.overpaid` webhook event type added to `WebhookEvent` union
  (`packages/server/src/session-manager.ts`), carrying `excessStroops: bigint` alongside
  `txHash` and `reason`.
- `markOverpaid()` method added to `SessionManager`: marks session `paid` (order safe to
  fulfil) and fires both `payment.confirmed` and `payment.overpaid` in sequence.
- `PaymentProcessor.process()` updated to call `markOverpaid()` for `overpaid` results.
- Two new tests in `packages/core/src/__tests__/memo-matcher.test.ts`:
  `flags overpayment: matched:false, status:overpaid, reason includes excess stroops` and
  `accepts overpayment within tolerance as an exact match`.
- Two new tests in `packages/server/src/__tests__/payment-pipeline.test.ts` (overpayment
  suite, replacing the old silent-accept test):
  `flags overpayment: session is marked paid AND payment.overpaid webhook fires` and
  `accepts payment within amountToleranceStroops even if amount is slightly over`.
- Rust/Soroban contract setup note added to `CONTRIBUTING.md` under
  "Rust/Soroban contract setup" — documents Cargo.lock commit requirement, template
  `.gitignore` audit step, dependency pinning guidance (`ed25519-dalek` / `soroban-sdk`
  version-range issue), and CI path-mismatch risk. To be read before escrow contract
  scaffolding begins (PR 3).
- `ARCHITECTURE.md` updated: webhook events block includes `payment.overpaid`; review
  cases table includes overpayment row; overpayment design decision section added.
- `HorizonPaymentListener` lifecycle and SSE message handler integration tests
  (`horizon-listener-integration.test.ts`) — 22 tests covering `start()`, `stop()`,
  cursor restoration from `CursorStore`, `onmessage` delivery for all payment types,
  non-payment record filtering, memo-fetch failure handling, and `onerror` behaviour.
- Full SSE→processor→session pipeline tests (`payment-pipeline.test.ts`) — 14
  end-to-end tests: XLM/USDC happy path, `amountToleranceStroops`, `submitting`→`paid`
  in-browser path, underpayment, wrong-asset, expired-quote, duplicate-event,
  overpayment-flagged, and overpayment-within-tolerance scenarios.
- HTTP integration tests for all 5 checkout API endpoints (`checkout-router.test.ts`)
  using supertest with mocked QuoteService and Horizon.
- Unit tests for `SessionManager` and `InMemorySessionStore` covering session creation,
  status transitions, webhook firing, and multiple-handler ordering
  (`session-manager.test.ts`).
- Unit tests for `buildPaymentTx` with mocked Horizon, verifying XDR structure
  (destination, asset, amount, MEMO\_ID) for both XLM and USDC sessions
  (`tx-builder.test.ts`).
- `CHANGELOG.md` (this file).
- `EMMY_CHANGELOG.md` — running audit log for all Wave Program review changes.

### Changed

- `matchPayment()` no longer silently accepts overpayments beyond `amountToleranceStroops`.
  This is a **breaking change for webhook consumers** that rely on the old behaviour:
  a `payment.confirmed`-only overpayment now produces `payment.confirmed` +
  `payment.overpaid`. See ARCHITECTURE.md for the design rationale.

---


## [0.1.0] — 2026-09-28

### Added

**`@stellarflow/core`**
- `HorizonPaymentListener` — SSE-based payment listener with exponential-backoff
  reconnection. `CursorStore` interface with `InMemoryCursorStore` and
  `FileCursorStore` implementations for crash-safe cursor persistence across restarts.
- `parseHorizonRecord` — parses Horizon operation records into typed `PaymentEvent`
  objects. Handles native XLM, USDC, path payments, and all memo types.
- `matchPayment` / `MemoMatcher` — validates incoming `PaymentEvent` against an open
  `CheckoutSession`: memo ID, destination, asset, amount (with configurable tolerance),
  and quote expiry. Returns typed `MatchResult`.
- `InMemoryIdempotencyStore` — deduplication by `txHash` so replayed SSE events do
  not double-confirm a session.
- `QuoteService` + `CoinGeckoPriceSource` — price quoting with a 3-minute TTL cache.
  `PriceSource` interface is swappable (e.g. Reflector Soroban oracle, Binance).
  USDC is hardcoded to $1.00 USD.
- `buildSep0007Uri` / `sessionToSep0007Uri` / `renderQr` — SEP-0007 payment URI
  generation and QR code rendering (PNG data URL + SVG).
- Shared types: `CheckoutSession`, `PaymentEvent`, `Asset`, `PaymentStatus`,
  `StellarNetwork`, `MatchResult`, `HORIZON_URLS`, `NETWORK_PASSPHRASES`,
  `USDC_ISSUERS`.

**`@stellarflow/server`**
- `createCheckoutRouter` — Express router with 5 endpoints: POST /api/checkout,
  GET /api/checkout/:orderId, POST /api/checkout/:orderId/tx,
  POST /api/checkout/:orderId/submit, GET /api/sessions, GET /api/network.
- `buildPaymentTx` — builds unsigned Stellar payment XDR for in-browser wallet
  signing. Fetches customer account sequence number and fee stats from Horizon.
- `SessionManager` + `InMemorySessionStore` — session lifecycle management with
  webhook callbacks (`payment.confirmed`, `payment.review_required`,
  `payment.underpayment`, `quote.expired`).
- `PaymentProcessor` — glue layer connecting `HorizonPaymentListener` events to
  `SessionManager` updates.

**`@stellarflow/widget`**
- Vanilla JS embeddable widget (no framework dependencies). Renders QR code and
  deep link, polls for session status, emits `stellarflow:paid` and
  `stellarflow:review` DOM events.

**`@stellarflow/demo`**
- Reference storefront (Node/Express) demonstrating the full checkout loop with
  `FileCursorStore` for crash-safe SSE cursor persistence.

**Infrastructure**
- GitHub Actions CI: lint (ESLint), typecheck (tsc), test (Jest with coverage),
  Node 18 and 20 matrix. CI is green.
- `ARCHITECTURE.md` — design decisions: memo scheme, price source, review flow,
  refund story, cursor persistence, known gaps (stuck-session expiry, background sweep).
- `CONTRIBUTING.md`, `SECURITY.md`, `LICENSE` (MIT).

### Design decisions recorded

- **Non-custodial invariant**: funds flow directly customer → merchant. Server never
  holds keys or signing authority.
- **MEMO_ID scheme**: uint64, natively indexed by Horizon, human-readable.
- **Cursor persistence**: `FileCursorStore` with synchronous write ensures payments
  that arrive during server downtime are not silently missed on restart.
- **Double-submit guard**: session transitions to `submitting` before Horizon call;
  second concurrent submit sees `409` before XDR validation.
- **XDR validation on submit**: server parses and validates destination, asset,
  amount, and MEMO_ID before forwarding to Horizon — prevents attacker from using the
  submit endpoint to forward arbitrary transactions.
