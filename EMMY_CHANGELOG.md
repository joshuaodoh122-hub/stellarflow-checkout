# EMMY_CHANGELOG

Single source of truth for every change made to this repo during the Wave Program audit.
Entries are append-only — never overwritten. Most recent entry at the top.

---

## 2026-09-30 — Refactor: typed excessStroops on MatchResult (pre-escrow hardening)

**Branch:** `refactor/typed-overpayment-excess`
**PR:** TBD

### What was changed

**`packages/core/src/types.ts`**

`MatchResult` expanded from a 2-variant to a 3-variant discriminated union:

```typescript
// Before
export type MatchResult =
  | { matched: true; status: 'paid' }
  | { matched: false; status: PaymentStatus; reason: string };

// After
export type MatchResult =
  | { matched: true; status: 'paid' }
  | { matched: false; status: 'overpaid'; reason: string; excessStroops: bigint }
  | { matched: false; status: Exclude<PaymentStatus, 'paid' | 'overpaid'>; reason: string };
```

The explicit `'overpaid'` variant carries `excessStroops: bigint` as a typed field.
TypeScript's discriminant narrowing on `status === 'overpaid'` now resolves to that
variant specifically, making `result.excessStroops` available without any cast.

**`packages/core/src/memo-matcher.ts`**

Overpayment return object gains `excessStroops: excess` — the value is the already-computed
`excess` bigint, so no new calculation is needed:

```typescript
return {
  matched: false,
  status: 'overpaid',
  reason: `overpayment: got ${event.amount}, expected ${session.amount} (excess ${excess} stroops)`,
  excessStroops: excess,   // ← new structured field
};
```

**`packages/server/src/payment-processor.ts`**

Regex parsing removed entirely. Before:

```typescript
const excessMatch = (result as { reason: string }).reason.match(/excess (\d+) stroops/);
const excessStroops = excessMatch ? BigInt(excessMatch[1]) : 0n;
await this.sessionManager.markOverpaid(session.orderId, event.txHash,
  (result as { reason: string }).reason, excessStroops);
```

After:

```typescript
await this.sessionManager.markOverpaid(
  session.orderId,
  event.txHash,
  result.reason,
  result.excessStroops,
);
```

No cast was needed — the 3-variant `MatchResult` narrows cleanly on
`result.status === 'overpaid'`. The `review_required` branch also lost its `as` casts
on `result.reason` and `result.status`, which were made redundant by the same
type restructuring.

**`packages/core/src/__tests__/memo-matcher.test.ts`**

The overpayment test now asserts the structured field directly:

```typescript
expect((result as { excessStroops: bigint }).excessStroops).toBe(10_000_000n);
expect((result as { reason: string }).reason).toContain('10000000 stroops'); // kept
```

Both assertions are present: the typed field (load-bearing) and the reason string
(informational, useful for regression-catching the human-readable format).

### Why

The previous implementation extracted `excessStroops` from the human-readable `reason`
string via regex in `payment-processor.ts`. Two files were implicitly coupled through
exact wording of a display string — a rename of "excess" → "surplus" or a reformat of
the number would silently produce `excessStroops = 0n` in the webhook with no compile-time
warning. For a financial value that ends up in a merchant-facing webhook, that's
unacceptable coupling. The fix is additive: `reason` is still present and still tested,
but it is no longer the source of truth for the stroop count.

### Cast required for narrowing? No.

The discriminated union narrowing worked cleanly without any cast. The key was splitting
`MatchResult` into 3 explicit variants rather than using `status: PaymentStatus` (a wide
union) in the non-match branch. With `status: PaymentStatus`, TypeScript cannot narrow
to a specific subtype on `status === 'overpaid'` because the whole second variant already
covers all `PaymentStatus` values — the discriminant is not unique. With 3 explicit
variants, each `status` value belongs to exactly one variant, so narrowing is clean.

### Optional follow-up flagged

The `'underpayment'` branch has the same pattern: `shortfall` bigint embedded in a reason
string, never exposed as a structured field. Consistency would suggest adding
`shortfallStroops: bigint` to a dedicated `'underpayment'` variant of `MatchResult`
in a future pass. Not done here — kept strictly to the overpayment scope as instructed.

### Test count before / after

- Before: 216 tests across 11 suites
- After: 216 tests across 11 suites (no count change — existing overpayment test
  strengthened with an additional assertion, not replaced)

### Files modified

- `packages/core/src/types.ts`
- `packages/core/src/memo-matcher.ts`
- `packages/core/src/__tests__/memo-matcher.test.ts`
- `packages/server/src/payment-processor.ts`
- `CHANGELOG.md`
- `EMMY_CHANGELOG.md` (this file — appended)

---

## 2026-09-30 — PR 3 (pre-escrow): Overpayment fix + Rust/Soroban setup doc

**Branch:** `fix/overpayment-handling`
**PR:** TBD

### What was changed

**`packages/core/src/types.ts`**

Added `'overpaid'` variant to the `PaymentStatus` union, alongside the existing
`'underpayment'` and `'review_required'` variants. Style matches existing union.

**`packages/core/src/memo-matcher.ts`**

Added an explicit overpayment branch in `matchPayment()` after the underpayment check
(step 7, now "Amount checks: underpayment and overpayment"). If `cmp > 0` (event amount
exceeds session amount) AND the excess exceeds `amountToleranceStroops`, returns:

```typescript
{ matched: false, status: 'overpaid', reason: `overpayment: got ${event.amount}, expected ${session.amount} (excess ${excess} stroops)` }
```

The `amountToleranceStroops` guard is applied symmetrically to overpayment — a 1–2 stroop
rounding excess from wallet decimal handling does not trigger the flag.

Updated module doc comment and `matchPayment` JSDoc to mention overpayment alongside the
existing non-silent failure rules.

**`packages/server/src/session-manager.ts`**

- Added `payment.overpaid` variant to `WebhookEvent` union, carrying `excessStroops: bigint`.
- Added `markOverpaid()` method to `SessionManager`: marks session status `'paid'`
  (merchant received sufficient funds — order is safe to fulfil), then fires
  `payment.confirmed` followed by `payment.overpaid` in sequence.

**`packages/server/src/payment-processor.ts`**

Updated `PaymentProcessor.process()` to branch on `result.status === 'overpaid'` and call
`sessionManager.markOverpaid()`, extracting `excessStroops` from the reason string via
regex (`/excess (\d+) stroops/`).

**`packages/core/src/__tests__/memo-matcher.test.ts`**

Replaced the old `'accepts overpayment'` test (which asserted `matched: true`, proving
the gap existed) with two new tests:

1. `flags overpayment: matched:false, status:overpaid, reason includes excess stroops`
   — proves `matchPayment()` returns `status: 'overpaid'` with the correct stroop count
   (1 XLM = 10,000,000 stroops) for a 101 XLM payment on a 100 XLM session.
2. `accepts overpayment within tolerance as an exact match`
   — proves that a 1-stroop excess within a 5-stroop `amountToleranceStroops` still
   returns `{ matched: true, status: 'paid' }`.

**`packages/server/src/__tests__/payment-pipeline.test.ts`**

Replaced the old `'accepts overpayment (more XLM than quoted)'` test with two new tests
in the `'Horizon payment pipeline — overpayment'` suite:

1. `flags overpayment: session is marked paid (order safe to fulfil) AND payment.overpaid webhook fires`
   — end-to-end: 150 XLM payment on a 100 XLM session → session status `'paid'`,
   exactly 2 webhooks (`payment.confirmed` + `payment.overpaid`), `excessStroops = 500_000_000n`,
   `txHash` and reason string match.
2. `accepts payment within amountToleranceStroops even if amount is slightly over (no overpaid flag)`
   — 3-stroop excess within a 10-stroop tolerance → session `'paid'`, only 1 webhook
   (`payment.confirmed`), no `payment.overpaid`.

**`ARCHITECTURE.md`**

- Webhook events block updated to include `payment.overpaid` type with full TypeScript
  signature.
- Review cases table now includes the overpayment row (`payment.confirmed` +
  `payment.overpaid`, status `paid`, recommended: "Fulfil order; then refund excess").
- New "Overpayment design decision" section added explaining the paid+dual-webhook
  approach and its rationale.
- Architecture diagram updated to show `payment.overpaid` alongside `payment.confirmed`
  in the `session.paid` path.

**`CONTRIBUTING.md`**

Added "Rust/Soroban contract setup" section with four items to check before scaffolding
the escrow contract (PR 3):
- Commit `Cargo.lock` (binary/deployable artifact — reproducible builds require it).
- Audit any template `.gitignore` for a `Cargo.lock` exclusion line before committing.
- Explicit dependency pinning guidance: check whether `ed25519-dalek` needs an
  upper-bound pin alongside `soroban-sdk` / `soroban-env-host` (loose `>=2.0.0`
  constraint may resolve to incompatible 3.x) — verify upstream before assuming.
- CI Rust job path hygiene: do not add `working-directory` unless the crate is actually
  in a subdirectory; verify paths match reality before considering CI done.

**`CHANGELOG.md`**, **`EMMY_CHANGELOG.md`**

Updated (this file — appended).

### Design decision flagged (affects webhook consumers)

The overpayment handling strategy chosen is **"mark paid + emit additional signal"**:

> When a customer sends more than the quoted amount (excess > `amountToleranceStroops`),
> the session is marked **`paid`** (the merchant received sufficient funds — order fulfilment
> is safe) AND a **`payment.overpaid`** webhook fires immediately after `payment.confirmed`,
> carrying `excessStroops` (bigint) for reconciliation.

This is more conservative than silent acceptance (which loses the signal) and more practical
than `review_required` (which would block fulfilment even though funds are confirmed). **Webhook
consumers MUST be prepared to receive `payment.confirmed` + `payment.overpaid` for the same
`orderId`/`txHash` on overpayments** — they arrive in that order.

### Test count before / after

- Before: 214 tests across 11 suites
- After: 216 tests across 11 suites (+2 tests)

Breakdown:
- `memo-matcher.test.ts`: 1 old overpayment test → 2 new overpayment tests (+1)
- `payment-pipeline.test.ts`: 1 old overpayment test → 2 new overpayment tests (+1)

### Files modified

- `packages/core/src/types.ts`
- `packages/core/src/memo-matcher.ts`
- `packages/core/src/__tests__/memo-matcher.test.ts`
- `packages/server/src/session-manager.ts`
- `packages/server/src/payment-processor.ts`
- `packages/server/src/__tests__/payment-pipeline.test.ts`
- `ARCHITECTURE.md`
- `CONTRIBUTING.md`
- `CHANGELOG.md`
- `EMMY_CHANGELOG.md` (this file — appended)

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
