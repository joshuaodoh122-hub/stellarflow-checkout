# Claims Audit

Each row covers one behavioural claim from the main docs.  
**Status key:**
- `VERIFIED` — the claim is backed by a named test that exists in the test files (backtick-quoted)
- `REWORDED` — the doc was changed to narrow or qualify the claim; either no automated test exists or the test only partially covers it
- `REMOVED` — the claim was removed because it could not be backed by a test

Columns: **Claim** | **Source file § section** | **Implementing function/file** | **Test name** | **Status**

The test-name column uses backticks for every name that `scripts/check_claims.sh` will verify exists. Plain text without backticks is an explanatory note and is not checked automatically.

---

## README.md

| Claim | Source § section | Implementing function/file | Test name | Status |
|-------|-----------------|---------------------------|-----------|--------|
| Funds flow directly from customer wallet to merchant — server holds no key (classic) | README.md § Security model | `checkout-router.ts` `validateSignedTx` | `returns 400 when XDR destination does not match session` | VERIFIED |
| Payer signs the deposit; server never holds a private key (escrow) | README.md § Escrow trust model | `escrow-router.ts` `POST /api/escrow/:id/submit` | `HAPPY PATH: valid signed deposit → 200, status deposited, submitSignedTx called once` | VERIFIED |
| XDR validate arg[1] merchant == session.merchantAddress (deposit) | README.md § Escrow trust model check 9 | `escrow-router.ts` `validateDepositArgs` | `400 + not submitted when arg[1] merchant is wrong` | VERIFIED |
| XDR validate arg[2] amount == BigInt(session.amount) exact | README.md § Escrow trust model check 10 | `escrow-router.ts` `validateDepositArgs` | `400 + not submitted when arg[2] amount is lower than session amount` | VERIFIED |
| XDR validate arg[3] token == session.tokenContractId | README.md § Escrow trust model check 11 | `escrow-router.ts` `validateDepositArgs` | `400 + not submitted when arg[3] token is wrong` | VERIFIED |
| XDR validate arg[4] order_id == session.orderId bytes | README.md § Escrow trust model check 12 | `escrow-router.ts` `validateDepositArgs` | `400 + not submitted when arg[4] order_id is wrong` | VERIFIED |
| XDR validate arg[5] timeout_ledgers == session.requestedTimeoutLedgers | README.md § Escrow trust model check 13 | `escrow-router.ts` `validateDepositArgs` | `400 + not submitted when arg[5] timeout_ledgers is wrong` | VERIFIED |
| XDR validate transaction source == payerAddress | README.md § Escrow trust model check 5 | `escrow-router.ts` `validateDepositArgs` | `400 + not submitted when transaction source != payer` | VERIFIED |
| Post-confirmation on-chain record verified; mismatch → terminal status | README.md § Escrow trust model | `escrow-router.ts` `POST /api/escrow/:id/submit` | `400 + mismatch status when on-chain record does not match session after confirmation` | VERIFIED |
| orderId is cryptographically random 32 bytes, not derivable from sessionId | README.md § Security model | `escrow-router.ts` `generateOrderId` | `orderId is not derivable from sessionId` | VERIFIED |
| Two sessions get different orderIds | README.md § Security model | `escrow-router.ts` `generateOrderId` | `two sessions get different order IDs (random, not counter-derived)` | VERIFIED |
| orderId is 64 hex characters | README.md § Soroban escrow status table | `escrow-router.ts` `generateOrderId` | `returns 201 with orderId (64 hex chars), sessionId, pending status` | VERIFIED |
| Session store is in-memory; on-chain funds safe after restart | README.md § Security model and limitations | `escrow-router.ts` `EscrowSessionStore` | `404 when session not found` | VERIFIED |
| Payer-chosen timeout validated by server as [1, 6307200] when supplied | README.md § Timeout bounds | `escrow-router.ts` `MIN_TIMEOUT_LEDGERS` / `MAX_TIMEOUT_LEDGERS` | `400 when timeoutLedgers out of range` | VERIFIED |
| MAX_TIMEOUT_LEDGERS same value in Rust and TypeScript | README.md § Timeout bounds | `escrow-router.ts`, `contracts/escrow/src/lib.rs` | `Rust lib.rs MAX_TIMEOUT_LEDGERS matches the TypeScript constant in escrow-router.ts` | VERIFIED |
| Rate limiting: 60 req/min per IP on /api routes | README.md § Security model and limitations | `packages/demo/src/server.ts` | Configured in demo server; not under Jest. Claim says "as configured in `packages/demo/src/server.ts`" | REWORDED |
| CORS: defaults to same-origin (false) unless CORS_ORIGIN set | README.md § Security model and limitations | `packages/demo/src/server.ts` | Configured in demo server; not under Jest. Claim is accurate but untested automatically | REWORDED |
| /api/sessions requires Bearer key when SESSIONS_API_KEY set | README.md § Security model and limitations | `checkout-router.ts` | Guard exists in code; jest tests do not explicitly test key-on/key-off for sessions route | REWORDED |
| CoinGecko price source with 3-min TTL (DEFAULT_QUOTE_TTL_MS) | README.md § Security model and limitations | `packages/core/src/price-quote.ts` | `returns 500 when the price source fails` | VERIFIED |
| Testnet is default in all examples | README.md § Switching to mainnet | `packages/demo/.env.example` | `creates a session and returns orderId, quote, and SEP-0007 URI` | VERIFIED |
| Payment deduplicated by txHash | README.md § How it works | `PaymentProcessor` / `IdempotencyStore` | `returns matched:false for a duplicate txHash` | VERIFIED |
| Quote expires; late payment flagged for review | README.md § How it works | `PaymentProcessor.process` | `flags expired quote as review_required` | VERIFIED |
| Exact payment → `payment.confirmed` webhook | README.md § Server-side integration | `SessionManager.handlePayment` | `fires payment.confirmed webhook with correct txHash` | VERIFIED |
| payerAddress == merchantAddress rejected at server | README.md § Escrow trust model | `escrow-router.ts` `POST /api/escrow` | `400 when payerAddress equals merchantAddress (self-escrow)` | VERIFIED |
| amount == 0 rejected at server | README.md § Escrow trust model | `escrow-router.ts` `POST /api/escrow` | `400 when amount is zero` | VERIFIED |
| In-flight guard: concurrent duplicate submit rejected 409 | README.md § Escrow trust model | `escrow-router.ts` in-flight Set | `409 on concurrent duplicate (in-flight guard)` | VERIFIED |
| POLL_TIMEOUT leaves session pending (retryable) | README.md § Session lifecycle | `escrow-router.ts` POLL_TIMEOUT catch | `session stays pending after POLL_TIMEOUT (retryable)` | VERIFIED |
| SDK getTransaction errors are logged once; not silently swallowed | README.md § Known limitations #7 | `escrow-session.ts` `submitSignedTx` | `SDK throws Bad union switch → raw fallback SUCCESS → returns { txHash }` | VERIFIED |
| SDK XDR parse error (Bad union switch) → raw fallback reads status → SUCCESS returned | README.md § Known limitations #7 | `escrow-session.ts` `submitSignedTx` | `SDK throws Bad union switch → raw fallback SUCCESS → returns { txHash }` | VERIFIED |
| SDK XDR parse error → raw fallback reads status → FAILED throws TX_FAILED | README.md § Known limitations #7 | `escrow-session.ts` `submitSignedTx` | `SDK throws Bad union switch → raw fallback FAILED → throws TX_FAILED` | VERIFIED |
| Both SDK and raw fallback failing → POLL_TIMEOUT with last error text | README.md § Known limitations #7 | `escrow-session.ts` `submitSignedTx` | `SDK and raw fallback both keep failing → POLL_TIMEOUT with last error text` | VERIFIED |
| Live read-only testnet checks pass (getTransaction SUCCESS; simulateTransaction getEscrow NotFound) | README.md § Known limitations #6 | — (manual live checks against testnet; not unit tests) | Run 2026-11-23 against the deployed testnet contract; real output recorded in CHANGELOG.md Task 3 | REWORDED |
| 35 Rust contract tests (as of 2026-11-22) | README.md § Soroban escrow honest status | `contracts/escrow/src/lib.rs` | Count verified by running `cargo test --locked` on 2026-11-22; command and date in README | REWORDED |
| Contract CI runs fmt, clippy, test, WASM build | README.md § Soroban escrow honest status | `.github/workflows/contracts.yml` | CI workflow file verified by reading `.github/workflows/contracts.yml` | REWORDED |

---

## ARCHITECTURE.md

| Claim | Source § section | Implementing function/file | Test name | Status |
|-------|-----------------|---------------------------|-----------|--------|
| MEMO_ID natively indexed by Horizon | ARCHITECTURE.md § Memo scheme | `packages/core/src/sep0007.ts` | `creates a session and returns orderId, quote, and SEP-0007 URI` | VERIFIED |
| Payment validated: destination, memo, asset, amount, expiry | ARCHITECTURE.md § System diagram | `PaymentProcessor.process` / `checkout-router.ts` `validateSignedTx` | `accepts a valid payment and returns matched:true` | VERIFIED |
| Underpayment → `payment.underpayment` webhook | ARCHITECTURE.md § Webhook events | `PaymentProcessor.process` | `correctly identifies underpayment by 1 stroop` | VERIFIED |
| Overpayment beyond tolerance → `payment.overpaid` | ARCHITECTURE.md § Webhook events | `PaymentProcessor.process` | `flags overpayment: matched:false, status:overpaid, reason includes excess stroops` | VERIFIED |
| Overpayment within tolerance accepted as exact match | ARCHITECTURE.md § Overpayment design | `PaymentProcessor.process` | `accepts overpayment within tolerance as an exact match` | VERIFIED |
| Non-custodial: server never holds funds, no signing authority | ARCHITECTURE.md § Non-custodial invariant | `checkout-router.ts`, `escrow-router.ts` | `HAPPY PATH: valid signed deposit → 200, status deposited, submitSignedTx called once` | VERIFIED |
| Horizon cursor persisted; payments during downtime not missed | ARCHITECTURE.md § Cursor persistence | `FileCursorStore` `packages/core/src/horizon-listener.ts` | `records the txHash in the store after a match` | VERIFIED |
| `release`/`refund` write status before token transfer (checks-effects) | ARCHITECTURE.md § Soroban escrow data flow | `contracts/escrow/src/lib.rs` | `test_release_status_written_before_transfer` | VERIFIED |
| Auth: only recorded merchant can call `release` | ARCHITECTURE.md § Auth model table | `contracts/escrow/src/lib.rs` | `test_release_requires_merchant_auth_structural` | VERIFIED |
| Auth: refund by payer only after timeout | ARCHITECTURE.md § Auth model table | `contracts/escrow/src/lib.rs` | `test_payer_refund_before_timeout_fails` | VERIFIED |
| Auth: merchant can refund any time | ARCHITECTURE.md § Auth model table | `contracts/escrow/src/lib.rs` | `test_merchant_refund_no_time_gate` | VERIFIED |
| Auth: third party cannot call release | ARCHITECTURE.md § Auth model table | `contracts/escrow/src/lib.rs` | `test_release_by_wrong_address_fails` | VERIFIED |
| Auth: third party cannot refund even after timeout | ARCHITECTURE.md § Auth model table | `contracts/escrow/src/lib.rs` | `test_third_party_cannot_refund_after_timeout` | VERIFIED |
| Duplicate order_id deposit fails with AlreadyExists | ARCHITECTURE.md § Escrow contract error table | `contracts/escrow/src/lib.rs` | `test_duplicate_deposit_fails` | VERIFIED |
| Deposit validation rejects amount==0, same party, timeout too long (codes 8/9/10) | ARCHITECTURE.md § Escrow contract error codes | `contracts/escrow/src/lib.rs` | `test_deposit_zero_amount_rejected` | VERIFIED |
| `GET /api/escrow/:id` reconciles on-chain status | ARCHITECTURE.md § Session status lifecycle | `escrow-router.ts` `GET /escrow/:orderId` | `reconciles to deposited when on-chain shows Held and fields match` | VERIFIED |
| Mismatch in on-chain fields → reconcileError, status not promoted | ARCHITECTURE.md § Session status lifecycle | `escrow-router.ts` `GET /escrow/:orderId` | `reports reconcileError and does NOT promote status when on-chain amount mismatches` | VERIFIED |

---

## SECURITY.md

| Claim | Source § section | Implementing function/file | Test name | Status |
|-------|-----------------|---------------------------|-----------|--------|
| Non-custodial: server holds no private key, no signing authority | SECURITY.md § Non-custodial invariant | `checkout-router.ts`, `escrow-router.ts` | `HAPPY PATH: valid signed deposit → 200, status deposited, submitSignedTx called once` | VERIFIED |
| Payment deduplicated by txHash (idempotency) | SECURITY.md § Idempotency | `IdempotencyStore` / `PaymentProcessor` | `returns matched:false for a duplicate txHash` | VERIFIED |
| Payment validation: destination, memo, asset, amount, expiry | SECURITY.md § Payment validation | `checkout-router.ts` `validateSignedTx` | `returns 400 when XDR destination does not match session` | VERIFIED |
| `RELEASE_API_KEY` compared with timingSafeEqual | SECURITY.md § Release API key | `escrow-router.ts` `requireReleaseAuth` | `401 when key has different length (timing-safe guard)` | VERIFIED |
| Production returns 503 when RELEASE_API_KEY not set | SECURITY.md § Release API key | `escrow-router.ts` `requireReleaseAuth` | `503 on release when production NODE_ENV and no key configured` | VERIFIED |
| Funds cannot be permanently locked (payer reclaims after timeout) | SECURITY.md § Contract guarantees | `contracts/escrow/src/lib.rs` `refund` | `test_payer_refund_after_timeout_succeeds` | VERIFIED |
| Only recorded merchant can release | SECURITY.md § Contract guarantees | `contracts/escrow/src/lib.rs` `release` | `test_release_requires_merchant_auth_structural` | VERIFIED |
| Only payer or merchant can refund (not a third party) | SECURITY.md § Contract guarantees | `contracts/escrow/src/lib.rs` `refund` | `test_refund_by_random_fails` | VERIFIED |
| No double-deposit for same order_id | SECURITY.md § Contract guarantees | `contracts/escrow/src/lib.rs` `deposit` | `test_duplicate_deposit_fails` | VERIFIED |
| Order IDs are cryptographically random, not predictable | SECURITY.md § Order-ID predictability | `escrow-router.ts` `generateOrderId` | `orderId is not derivable from sessionId` | VERIFIED |
| Rate limiting applied to /api routes | SECURITY.md § Rate limiting | `packages/demo/src/server.ts` | Configured in demo server; not under Jest | REWORDED |
| Session store in-memory; server restart loses state but on-chain funds safe | SECURITY.md § Session store persistence | `escrow-router.ts` `EscrowSessionStore` | `404 when session not found` | VERIFIED |

---

## contracts/escrow/README.md

| Claim | Source § section | Implementing function/file | Test name | Status |
|-------|-----------------|---------------------------|-----------|--------|
| No token whitelist; server pins the token | contracts/escrow/README.md § Honest limitations | `escrow-router.ts` XDR validation arg[3] | `400 + not submitted when arg[3] token is wrong` | VERIFIED |
| `deposit` rejects amount == 0 (InvalidAmount code 8) | contracts/escrow/README.md § Functions table | `contracts/escrow/src/lib.rs` `deposit` | `test_deposit_zero_amount_rejected` | VERIFIED |
| `deposit` rejects negative amount (InvalidAmount code 8) | contracts/escrow/README.md § Functions table | `contracts/escrow/src/lib.rs` `deposit` | `test_deposit_negative_amount_rejected` | VERIFIED |
| `deposit` rejects payer == merchant (SameParty code 9) | contracts/escrow/README.md § Functions table | `contracts/escrow/src/lib.rs` `deposit` | `test_deposit_same_payer_and_merchant_rejected` | VERIFIED |
| `deposit` rejects timeout_ledgers > MAX_TIMEOUT_LEDGERS (TimeoutTooLong code 10) | contracts/escrow/README.md § Functions table | `contracts/escrow/src/lib.rs` `deposit` | `test_deposit_timeout_too_long_rejected` | VERIFIED |
| `deposit` accepts timeout_ledgers == MAX_TIMEOUT_LEDGERS (boundary) | contracts/escrow/README.md § Constants | `contracts/escrow/src/lib.rs` `deposit` | `test_deposit_timeout_at_max_accepted` | VERIFIED |
| `deposit` timeout=0 uses DEFAULT_TIMEOUT_LEDGERS | contracts/escrow/README.md § Constants | `contracts/escrow/src/lib.rs` `deposit` | `test_default_timeout_applied` | VERIFIED |
| `release` requires merchant auth | contracts/escrow/README.md § Functions table | `contracts/escrow/src/lib.rs` `release` | `test_release_requires_merchant_auth_structural` | VERIFIED |
| `refund` by payer only after timeout | contracts/escrow/README.md § Functions table | `contracts/escrow/src/lib.rs` `refund` | `test_payer_refund_before_timeout_fails` | VERIFIED |
| `deposit` emits `Deposited` event | contracts/escrow/README.md § Events table | `contracts/escrow/src/lib.rs` `deposit` | `test_deposit_emits_deposited_event` | VERIFIED |
| `release` emits `Released` event | contracts/escrow/README.md § Events table | `contracts/escrow/src/lib.rs` `release` | `test_release_emits_released_event` | VERIFIED |
| `refund` emits `Refunded` event with caller | contracts/escrow/README.md § Events table | `contracts/escrow/src/lib.rs` `refund` | `test_refund_merchant_emits_refunded_event` | VERIFIED |
| TTL not automatic; `extend_escrow_ttl` exists for keepers | contracts/escrow/README.md § Honest limitations | `contracts/escrow/src/lib.rs` `extend_escrow_ttl` | `test_extend_escrow_ttl_increases_ttl` | VERIFIED |
| `extend_escrow_ttl` on unknown order_id returns NotFound | contracts/escrow/README.md § Functions table | `contracts/escrow/src/lib.rs` | `test_extend_escrow_ttl_not_found` | VERIFIED |
| `deposit` sets TTL | contracts/escrow/README.md § Constants (TTL_EXTEND_TO) | `contracts/escrow/src/lib.rs` | `test_deposit_sets_ttl` | VERIFIED |
| Unaudited; mainnet use at own risk | contracts/escrow/README.md § Honest limitations | — | Structural claim; no automated test | REWORDED |

---

## CONTRIBUTING.md

| Claim | Source § section | Implementing function/file | Test name | Status |
|-------|-----------------|---------------------------|-----------|--------|
| `npm run lint && npm run typecheck && npm test` all pass | CONTRIBUTING.md § Workflow | CI scripts in `package.json` | Full suite run on branch; real results in CHANGELOG.md | REWORDED |
| Rust tests run with `npm run test:contracts` | CONTRIBUTING.md § Testing | `package.json` `test:contracts` script | npm script invokes `cargo test --manifest-path`; verified by running directly | REWORDED |
| Non-custodial invariant maintained in every contribution | CONTRIBUTING.md § Before you start | `escrow-router.ts`, `checkout-router.ts` | `HAPPY PATH: valid signed deposit → 200, status deposited, submitSignedTx called once` | VERIFIED |
| `Cargo.lock` committed (not gitignored) | CONTRIBUTING.md § Rust/Soroban setup §1 | `contracts/escrow/Cargo.lock` | File present and tracked; structural claim | VERIFIED |

---

## docs/ecosystem.md and docs/good-first-issues.md

| Claim | Source § section | Implementing function/file | Test name | Status |
|-------|-----------------|---------------------------|-----------|--------|
| `PriceSource` interface is swappable | README.md § Roadmap / docs/good-first-issues.md | `packages/core/src/price-quote.ts` `PriceSource` | `returns 500 when the price source fails` | VERIFIED |
| `SessionStore` interface is swappable | docs/good-first-issues.md | `packages/server/src/session-manager.ts` `SessionStore` | `creates and retrieves a session` | VERIFIED |

---

## Notes on REWORDED rows

1. **Rate limiting and CORS** are configured in the demo server (`packages/demo/src/server.ts`) which is not under Jest. The claims in README.md and SECURITY.md say "as configured in `packages/demo/src/server.ts`" rather than asserting a testable guarantee, and note that production deployments may differ.

2. **`/api/sessions` SESSIONS_API_KEY guard** — the guard exists in `checkout-router.ts` and is straightforward code, but the Jest tests for the checkout router do not exercise key-on/key-off for the sessions route directly. The README wording says "when `SESSIONS_API_KEY` is set" which is accurate. Status REWORDED to remove any implied stronger assertion.

3. **"Unaudited"** — this is a negative structural claim (no audit has been performed). There is no automated test for the absence of an audit.

---

*Last updated: 2026-11-22. Run `scripts/check_claims.sh` to verify all backtick-quoted test names still exist.*
