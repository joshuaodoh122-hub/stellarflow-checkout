# EMMY_CHANGELOG

Single source of truth for every change made to this repo during the Wave Program audit.
Entries are append-only — never overwritten. Most recent entry at the top.

---

## 2026-09-29 — PR 1: HTTP integration tests + session-manager + tx-builder tests

**Branch:** `feat/http-integration-tests`
**PR:** TBD

### What was changed

**New test files (packages/server/src/__tests__/):**

- `checkout-router.test.ts` — HTTP integration tests for all 5 Express endpoints using
  supertest. QuoteService's PriceSource is mocked (XLM = $0.10, USDC = $1.00); Horizon
  is not called. Covers: POST /api/checkout (session creation, asset validation, error
  paths), GET /api/checkout/:orderId (status polling, 404, 400 for non-numeric IDs),
  POST /api/checkout/:orderId/tx (input validation, 404, 409, 410 expiry), POST
  /api/checkout/:orderId/submit (XDR validation rejection paths, 409, 410),
  GET /api/sessions (listing, BigInt serialisation), GET /api/network.

- `session-manager.test.ts` — Unit tests for SessionManager and InMemorySessionStore
  covering: session creation, orderId increment, status transitions (markPaid,
  markReviewRequired, updateStatus), webhook event types and ordering, async webhook
  handlers, store isolation, and the clear() method.

- `tx-builder.test.ts` — Unit tests for buildPaymentTx with Horizon mocked via
  jest.mock('stellar-sdk'). Verifies that the returned XDR parses correctly with
  stellar-sdk and that destination, asset (XLM and USDC), amount, MEMO_ID, and
  network passphrase are all set correctly. Also covers the baseFeeStroops override
  and feeStats fallback.

### Why

The checkout-router (5 HTTP endpoints), session-manager, and tx-builder had no
direct test coverage. The submit-validation tests tested validation logic extracted as
a pure function but did not exercise the HTTP routing layer. These gaps were the most
significant coverage hole in the codebase.

### Test count before / after

- Before: 107 tests across 6 suites
- After: 180 tests across 9 suites (+73 tests)

### Files modified

- `packages/server/src/__tests__/checkout-router.test.ts` (new)
- `packages/server/src/__tests__/session-manager.test.ts` (new)
- `packages/server/src/__tests__/tx-builder.test.ts` (new)
- `EMMY_CHANGELOG.md` (new — this file)
- `CHANGELOG.md` (new)

---

## 2026-09-29 — PR 2: README overhaul + honest Soroban status

**Branch:** `docs/readme-overhaul`
**PR:** TBD

### What was changed

**README.md** — full rewrite:
- Added explicit "Soroban status — honest statement" section at the top: v0.1 uses
  Horizon only; Soroban escrow (in development) and Reflector oracle (planned v0.3)
  are called out with their target branches.
- Replaced the brief "how it works" paragraph with an ASCII sequence diagram showing
  the full customer→browser→backend→Stellar→Horizon→webhook flow.
- Added a proper "Quick start" section with prerequisites table, numbered steps
  (clone, configure, build, start, test a payment), and all env vars explained.
- Contract interface section documents all 6 API endpoints with request/response shapes.
- Replaced vague "Roadmap" with a versioned table tied to concrete features.
- Added "Known limitations" section that honestly lists: no sybil resistance, USDC
  peg assumption, no automated refunds, in-memory storage, no expiry sweep, and
  "Soroban not yet integrated."
- Updated test count reference (180, not 107).

### Why

The original README described the project at a high level but lacked setup
instructions detailed enough for a new developer to actually run it, had no
API reference, and did not mention the absence of Soroban. For a Wave Program
review, vague documentation looks like the author doesn't understand their own
stack. The new README is concrete, honest, and actionable.

### Files modified

- `README.md` (rewritten)
- `EMMY_CHANGELOG.md` (this entry appended)
- `CHANGELOG.md` (Unreleased section updated)

---
