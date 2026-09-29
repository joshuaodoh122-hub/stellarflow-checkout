# EMMY_CHANGELOG

Single source of truth for every change made to this repo during the Wave Program audit.
Entries are append-only — never overwritten. Most recent entry at the top.

---

## 2026-09-29 — PR 2: Horizon flow integration tests (listener lifecycle + full pipeline)

**Branch:** `feat/horizon-flow-tests`
**PR:** TBD

### What was changed

**New test file: `packages/core/src/__tests__/horizon-listener-integration.test.ts`**

22 new tests covering `HorizonPaymentListener` lifecycle and stream behaviour — the
biggest untested surface area remaining after PR 1. All tests mock `stellar-sdk`'s
`Horizon.Server` at the module level so no network calls are made.

Suites added:

- **start/stop lifecycle** (7 tests): `start()` calls the correct SDK chain
  (`payments().forAccount().cursor().stream()`); `start()` uses `opts.cursor` ("now"
  and "0") when the `CursorStore` has no saved cursor; `start()` resumes from the saved
  cursor in the `CursorStore`; `start()` is idempotent (second call while running is a
  no-op); `stop()` calls the stream's stop function; `stop()` before `start()` does not
  throw.

- **onmessage handler** (12 tests): fires `onPayment` for native XLM and USDC
  `credit_alphanum4` records; saves `paging_token` to the cursor store on each message;
  advances the cursor store through successive messages; does NOT fire for
  `create_account`, `manage_sell_offer`, `account_merge` records; fires for
  `path_payment_strict_receive` and `path_payment_strict_send`; handles memo-fetch
  failures gracefully (emits event with `memo:none`); delivers multiple events in order.

- **onerror handler** (3 tests): calls the `onError` callback on stream errors; wraps
  non-`Error` payloads in an `Error` instance; does not call `onError` after `stop()`.

**New test file: `packages/server/src/__tests__/payment-pipeline.test.ts`**

12 new tests covering the full SSE→processor→session pipeline. `HorizonPaymentListener`
is wired to `PaymentProcessor` → `SessionManager`, with `Horizon.Server` mocked.

Suites added:

- **successful payment** (5 tests): XLM session marked paid; USDC session marked paid;
  payment within `amountToleranceStroops` accepted; duplicate SSE event not
  double-confirmed; session in `submitting` state (in-browser path) confirmed by SSE.

- **flagged payments** (6 tests): underpayment fires `payment.underpayment` webhook;
  wrong asset fires `payment.review_required`; expired quote fires
  `payment.review_required`; wrong MEMO_ID silently ignored; no-memo event silently
  ignored; already-paid session not re-processed by second event.

- **overpayment** (1 test): overpayment accepted and session marked paid.

### Why

`HorizonPaymentListener.start()`, `stop()`, and the SSE message handler were the
largest untested paths in the codebase after PR 1. These are the core paths for
on-chain payment detection — if they break silently, payments are missed without
any test failure. The pipeline tests also fill the gap on `PaymentProcessor` with
`amountToleranceStroops > 0`, the `submitting` → `paid` SSE confirmation path, and
the `wrong_asset` + expired-quote SSE scenarios that `payment-processor.test.ts`
covered only partially.

### Test count before / after

- Before: 180 tests across 9 suites
- After: 214 tests across 11 suites (+34 tests)

### Files modified

- `packages/core/src/__tests__/horizon-listener-integration.test.ts` (new)
- `packages/server/src/__tests__/payment-pipeline.test.ts` (new)
- `EMMY_CHANGELOG.md` (this file — appended)
- `CHANGELOG.md` (updated)

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
