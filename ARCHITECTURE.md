# StellarFlow Checkout — Architecture

This document records the key architectural decisions made during the v1 build. These are not defaults — each choice was made deliberately and documented here so they can be revisited with full context.

---

## Open Questions (resolved)

### 1. Memo scheme: `MEMO_ID` (uint64)

**Decision:** Use `MEMO_ID` (Stellar's 64-bit unsigned integer memo type).

**Why not `MEMO_HASH`:**
- `MEMO_HASH` gives 32 arbitrary bytes, but requires custom serialisation on both the client (embedding the hash in the SEP-0007 URI) and the server (parsing and matching it).
- Most wallet UIs display `MEMO_ID` as a plain integer to the user, making it human-readable for support cases ("your order ID is 42").
- `MEMO_ID` is natively indexed by Horizon — queries like `GET /accounts/{id}/payments?memo_id=42` are first-class API operations.
- The 64-bit range (0–18,446,744,073,709,551,615) is far larger than any realistic order volume.

**Limitation:** Platforms using non-numeric IDs (e.g. UUID-based systems) must map their order IDs to a uint64 before calling this library. The simplest approach is a sequential counter (which is what `SessionManager` uses in v1).

---

### 2. Price source: CoinGecko free tier, 3-minute expiry

**Decision:** CoinGecko `/simple/price` API with a 3-minute quote TTL.

**Why CoinGecko:**
- Zero configuration required for v1 — no API key for the free tier.
- Widely used and well-documented.
- The `PriceSource` interface (`packages/core/src/price-quote.ts`) makes it trivially replaceable with Reflector (Soroban oracle), Binance, or any other source.

**Why 3 minutes:**
- XLM spot price can move 1–5% in minutes during volatile conditions.
- 3 minutes gives a customer enough time to review and approve a wallet transaction.
- Stellar settles in ~5 seconds — once the customer approves, the on-chain time is negligible.
- After expiry, a new quote is issued with the current price. The old payment, if it arrives late, is flagged for merchant review (not silently accepted).

**USDC special case:** USDC is treated as exactly $1.00 USD. No price API call is made. If USDC depegs, the merchant must pause the widget manually.

---

### 3. Manual review flow: Webhooks

**Decision:** Webhook callbacks to the merchant's configured endpoint.

**Why not a dashboard:** A dashboard requires a hosted frontend — out of scope for a widget library.
**Why not email:** Requires an email provider dependency and adds configuration burden.
**Why webhooks:** Webhooks are the standard pattern developers use with Stripe, PayPal, and every other payment processor. They work for both self-hosted and SaaS storefronts, require no persistent connection, and are easy to test with tools like webhook.site or ngrok.

**Webhook events (v1):**

```typescript
// Payment confirmed — safe to fulfil order
{ type: 'payment.confirmed', session: CheckoutSession, txHash: string }

// Payment confirmed AND an overpayment was detected — fulfil the order, then
// reconcile the excess. excessStroops is the overage in Stellar's base unit (1 XLM = 10,000,000 stroops).
// This event always follows a payment.confirmed for the same orderId and txHash.
{ type: 'payment.overpaid', session: CheckoutSession, txHash: string, reason: string, excessStroops: bigint }

// Payment needs manual merchant review
{ type: 'payment.review_required', session: CheckoutSession, txHash: string, reason: string }

// Underpayment — customer sent less than quoted
{ type: 'payment.underpayment', session: CheckoutSession, txHash: string, reason: string }

// Quote expired — price may have changed
{ type: 'quote.expired', session: CheckoutSession }
```

**Review cases and recommended merchant action:**

| Case | Webhook type(s) | Session status | Recommended action |
|------|----------------|----------------|-------------------|
| Exact / near-exact payment | `payment.confirmed` | `paid` | Fulfil order immediately |
| Overpayment (above `amountToleranceStroops`) | `payment.confirmed` + `payment.overpaid` | `paid` | Fulfil order; then refund excess to customer |
| Underpayment | `payment.underpayment` | `review_required` | Contact customer, request top-up or issue refund |
| Wrong asset | `payment.review_required` | `review_required` | Return funds manually; see refund story below |
| Expired quote | `payment.review_required` | `review_required` | Verify current price; if acceptable, fulfil manually |

**Overpayment design decision:**

When a customer sends more than the quoted amount (and the excess is beyond `amountToleranceStroops`), the system takes the following approach:

1. The session is marked **`paid`** — the merchant did receive at least the quoted amount on-chain, so the order is safe to fulfil.
2. A **`payment.overpaid`** webhook fires (after `payment.confirmed`) carrying `excessStroops` so the merchant's system has an unambiguous signal to initiate a refund for the excess.

This is more conservative than silently accepting (which loses the signal entirely) and more practical than `review_required` (which would block order fulfilment even though the merchant holds sufficient funds). Webhook consumers MUST be prepared to receive both `payment.confirmed` and `payment.overpaid` for the same `orderId`/`txHash` — they arrive in that order.

The `amountToleranceStroops` option exists to absorb tiny rounding differences (e.g. wallet decimal rounding at the 7th decimal place). Both underpayment and overpayment use the same tolerance symmetrically.

---

### 4. Refund story

Stellar has **no native transaction reversal**. There is no equivalent of a credit card chargeback or an EVM `revert`.

**v1 refund approach:**
Refunds are manual, off-protocol, and out of scope for the widget code. The recommended merchant process is:

1. The webhook fires with `payment.review_required` or `payment.underpayment`.
2. Merchant contacts the customer via their existing support channel.
3. Merchant sends a new Stellar payment from their wallet back to the customer's address for the agreed refund amount.
4. The refund transaction is recorded in the merchant's order management system manually.

This is the same process used by most crypto payment processors in v1. Automated refund tooling is a documented stretch goal (see `CONTRIBUTING.md`).

**Why we do not automate refunds in v1:**
- Automated refunds require the server to have signing authority over merchant funds — a direct violation of the non-custodial invariant.
- Signing keys in server-side code is a high-risk security surface.
- The correct v1 answer is a clear process, not risky automation.

---

### 5. Cursor persistence for HorizonPaymentListener

**Decision:** Persist the Horizon `paging_token` to a local file after every SSE message via `FileCursorStore`.

**Problem being solved:** With `cursor: 'now'` (the default), any payment that lands while the server is down is silently missed on restart. A dropped response from Horizon does not mean the transaction failed — it means the server didn't see the SSE event. Without a persisted cursor, those events are gone.

**Implementation:**
- `CursorStore` interface with `load()` / `save()` methods (`packages/core/src/horizon-listener.ts`)
- `InMemoryCursorStore` — default, no cross-restart durability (useful for tests)
- `FileCursorStore` — writes the cursor synchronously (`writeFileSync`) to a plain text file after each message so the cursor survives a process crash between the message handler returning and an async write completing
- `HorizonPaymentListener.start()` is now `async`; it calls `cursorStore.load()` before opening the stream and resumes from the saved cursor if one exists
- On reconnect (SSE error), the cursor is re-read from the store so the reconnect also resumes from the last safe position rather than re-opening at `opts.cursor`
- Demo wires `FileCursorStore` with path configurable via `CURSOR_FILE` env var (default: `horizon-cursor.txt` in the project root)

**Why synchronous write:** The cursor file is a single short string (< 30 bytes). `writeFileSync` flushes before the message handler returns, ensuring the cursor is durable even if the process is killed immediately after. The sync cost is negligible for this payload size.

---

## Known gaps / post-MVP follow-ups

These gaps are real but are not blockers for the MVP testnet demo. They are tracked here for the next iteration.

### Gap 1 — Stuck-session expiry transition

**Problem:** A session stuck in `submitting` status past its `expiresAt` timestamp stays `submitting` forever. It should transition to `expired` so the merchant and customer get a clear signal.

**Current behaviour:** The `/checkout/:orderId` GET endpoint returns `status: submitting` even after `expiresAt` has passed.

**Minimal fix (post-MVP):** In the GET handler, add a check before returning:
```ts
if (session.status === 'submitting' && Date.now() > session.expiresAt) {
  await sessionManager.updateStatus(session.orderId, 'expired');
  session = { ...session, status: 'expired' };
}
```
A more complete fix also stores the `txHash` on the session at submission time and queries Horizon for it before deciding whether to expire or mark paid — this handles the case where the transaction actually landed but the server never received the SSE confirmation.

### Gap 2 — Background sweep for unqueried stuck sessions

**Problem:** The on-demand reconcile in Gap 1 only fires when the order is next polled. If no one queries a stuck session (e.g. the customer abandoned the tab), the session stays in `submitting` indefinitely. This inflates the "active" session count and could prevent the idempotency store from being cleaned up correctly.

**Minimal fix (post-MVP):** A `setInterval` sweep in `server.ts` that runs every 60 seconds, calls `sessionManager.listSessions()`, and transitions any `submitting` session past `expiresAt` to `expired`:
```ts
setInterval(async () => {
  const sessions = await sessionManager.listSessions();
  const now = Date.now();
  for (const s of sessions) {
    if (s.status === 'submitting' && now > s.expiresAt) {
      await sessionManager.updateStatus(s.orderId, 'expired');
    }
  }
}, 60_000);
```
This sweep intentionally does not query Horizon for each `txHash` — that would be N Horizon calls per sweep cycle. The correct approach is to store the `txHash` at submission time (see Gap 1) and only query Horizon if the hash is present.

---

## System Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  Customer Browser                                                    │
│                                                                      │
│  ┌──────────────────┐     POST /api/checkout     ┌───────────────┐  │
│  │  Merchant Page   │ ──────────────────────────▶ │  Demo Server  │  │
│  │  (vanilla JS     │ ◀────────────────────────── │  (Express)    │  │
│  │   widget)        │  { uri, qrDataUrl, orderId} └───────┬───────┘  │
│  │                  │                                     │          │
│  │  Renders QR code │                                     │ creates  │
│  │  + deep link     │                              CheckoutSession   │
│  │                  │                                     │          │
│  │  GET /checkout/  │◀── poll every 3s ───────────────────┘          │
│  │  :orderId        │                                                 │
│  └────────┬─────────┘                                                │
│           │                                                           │
│   customer opens wallet                                               │
│           │                                                           │
└───────────┼───────────────────────────────────────────────────────────┘
            │
            ▼
   ┌────────────────┐   SEP-0007 URI     ┌────────────────────┐
   │  Stellar Wallet│ ─────────────────▶ │  Stellar Network   │
   │  (Freighter,   │   (web+stellar:    │  (Testnet/Mainnet) │
   │   Lobstr, etc) │    pay?...)        └────────┬───────────┘
   └────────────────┘                            │
                                                 │ tx confirmed (~5s)
                                                 ▼
                                    ┌────────────────────────┐
                                    │  Horizon SSE stream    │
                                    │  /accounts/{addr}/     │
                                    │  payments?cursor=<N>   │
                                    └────────────┬───────────┘
                                                 │
                                                 ▼
                                    ┌────────────────────────┐
                                    │  HorizonPaymentListener│
                                    │  parseHorizonRecord()  │
                                    │  + FileCursorStore     │◀── horizon-cursor.txt
                                    └────────────┬───────────┘
                                                 │ PaymentEvent
                                                 ▼
                                    ┌────────────────────────┐
                                    │  PaymentProcessor      │
                                    │  matchPayment()        │◀── IdempotencyStore
                                    │  (memo, asset, amount, │    (dedup by txHash)
                                    │   expiry checks)       │
                                    └────────────┬───────────┘
                                                 │
                               ┌─────────────────┼──────────────────┐
                               ▼                 ▼                  ▼
                        session.paid    session.review_required  (ignored)
                               │                 │
                               ▼                 ▼
                          webhook              webhook
                     payment.confirmed    payment.review_required
                     (+ payment.overpaid  payment.underpayment
                      if excess beyond
                      tolerance)
```

---

## Non-custodial invariant

**Funds always flow directly from customer wallet → merchant wallet.** The StellarFlow server never:
- Holds funds in escrow
- Has access to any private key
- Acts as an intermediary in the payment path
- Can reverse or modify a completed payment

The server only observes the blockchain and updates its local session state.

---

## Security defaults

### Testnet by default

Every example, config file, and default environment variable uses Stellar Testnet. Mainnet requires three explicit steps:
1. Set `STELLAR_NETWORK=mainnet` in `.env`
2. Fund a real Stellar account and set `MERCHANT_ADDRESS`
3. Acknowledge the warning printed at server startup: `⚠️ MAINNET MODE — real funds will be transferred!`

### Subresource Integrity (SRI)

The widget script is a self-contained IIFE bundle. Merchants should load it with an SRI hash:

```html
<script
  src="https://cdn.example.com/stellarflow-widget.js"
  integrity="sha384-REPLACE_WITH_HASH_FROM_BUILD"
  crossorigin="anonymous"
></script>
```

Generate the hash after each build:
```bash
openssl dgst -sha384 -binary packages/widget/dist/stellarflow-widget.js | openssl base64 -A
```

### Recommended Content Security Policy

For merchant pages embedding the widget:

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self' https://cdn.example.com;
  connect-src 'self' https://horizon-testnet.stellar.org https://api.coingecko.com;
  img-src 'self' data:;
  style-src 'self' 'unsafe-inline';
  frame-ancestors 'none';
```

Replace `https://cdn.example.com` with your actual widget CDN domain. Replace `horizon-testnet` with `horizon.stellar.org` for mainnet.

---

## Package structure

```
stellarflow-checkout/
├── packages/
│   ├── core/           # Memo matching, idempotency, price quoting, SEP-0007, Horizon listener
│   ├── server/         # Express middleware, session manager, payment processor
│   ├── widget/         # Vanilla JS embeddable widget (no framework)
│   └── demo/           # Reference storefront (Node/Express)
├── .github/
│   └── workflows/      # CI: lint, typecheck, test
├── ARCHITECTURE.md     # This file
├── CONTRIBUTING.md
├── SECURITY.md
├── README.md
└── LICENSE             # MIT
```

---

## Soroban Escrow Contract (v0.2)

This section documents the architectural decisions for the Soroban escrow checkout
mode added in v0.2 on `feat/soroban-escrow`. This is a NEW checkout mode alongside
the existing Horizon-based flow — it does NOT replace it.

### State machine

```
        deposit()
  (new) ─────────▶ Held ──── release() [merchant] ──▶ Released
                     └───── refund()  [merchant, any time]    ──▶ Refunded
                     └───── refund()  [payer, after timeout]  ──▶ Refunded
```

### Auth model

| Function   | Required auth                                         |
|------------|-------------------------------------------------------|
| deposit    | payer — must sign the deposit transaction             |
| release    | merchant — the address recorded at deposit time       |
| refund     | merchant (any time) OR payer (after timeout only)     |
| get_escrow | none — read-only simulation, no signature required    |

Auth is enforced by `require_auth()` on the address stored in the escrow record,
not on a caller argument. This means the contract checks that the *recorded* merchant
(set immutably at deposit time) has signed the release — a different address cannot
impersonate the merchant even if they call the function.

### Timeout design

**Duration chosen: 30 days (518,400 ledgers at ~5 s/ledger)**

Reasoning:
- 30 days covers the longest common fulfilment windows for physical goods and
  services with delayed delivery (digital downloads are typically fulfilled in
  seconds; physical goods may take weeks for international shipping).
- It gives the merchant enough time to fulfil genuinely delayed orders without
  the customer being able to reclaim funds prematurely.
- It gives the customer a guaranteed recovery path if the merchant disappears
  without fulfilling or voluntarily refunding — preventing funds from being
  permanently locked.
- The timeout is per-deposit and configurable: callers can pass a custom
  `timeout_ledgers` value to `deposit()` for shorter (digital download: 7 days /
  120,960 ledgers) or longer (custom manufacture: 60 days / 1,036,800 ledgers)
  windows. Pass `0` to use the 30-day default.

The timeout is measured in ledger sequence numbers (not wall-clock time) because
ledger numbers are canonical on-chain data — they cannot be faked or skewed by
node clock drift. At 5 s/ledger this is approximately 30 days, but Stellar's
ledger close time can vary. The `deposited_at` field in the escrow record gives
both parties the exact ledger at which the timeout starts, so either party can
calculate the unlock ledger: `deposited_at + timeout_ledgers`.

**Merchant voluntary refund has NO time gate** — a merchant can call `refund()` at
any time before release, including at ledger 0. This is the explicit voluntary
cancellation path (e.g. stock out, order cancelled by customer request).

### Out of scope (v0.2)

Explicitly NOT built in this version — see roadmap in README:

- **Third-party arbitration**: no external arbiter role. Disputes beyond
  "merchant voluntarily refunds" or "payer waits for timeout" require off-chain
  resolution in v0.2.
- **Partial releases/refunds**: all-or-nothing per `order_id`. A partial release
  would require a more complex contract design (splitting the escrow, new state
  machine) — deferred to a future version.

### TypeScript integration

The `EscrowClient` in `packages/server/src/escrow-session.ts` provides:

- `deposit()` — builds and submits the deposit invocation (payer signs)
- `release()` — builds and submits the release invocation (merchant signs)
- `refund()` — builds and submits the refund invocation (payer or merchant signs)
- `getEscrow()` — reads the on-chain record via contract simulation (no auth)

The `SorobanRpcClient` interface is injected, allowing full mock coverage in tests
without real network calls. The non-custodial invariant is preserved: all signing
happens in the caller's wallet — the server never holds keys.

### Session ID → order_id mapping

The escrow contract uses `BytesN<32>` for order IDs. The TypeScript layer derives
a deterministic 32-byte value from the server's numeric session ID by encoding the
session ID as a big-endian uint64 left-padded to 32 bytes:

```typescript
// Session 1 → 000...00000001 (64 hex chars)
sessionIdToOrderIdHex(1n)
```

This ensures the same session always produces the same `order_id` on-chain and
the server can always look up the escrow record for any session.

---

## Stretch goals / future issues

These are explicitly out of scope for v1 but should be tracked as GitHub issues:

| Area | Scope |
|------|-------|
| Shopify plugin | App review + OAuth + Liquid templates — different architecture |
| WooCommerce plugin | WordPress plugin architecture — different build/release pipeline |
| Reflector oracle | Soroban on-chain price feed — replaces CoinGecko via `PriceSource` interface |
| Automated refunds | Requires signed tx capability — careful key management required |
| Multi-merchant | Session isolation, per-merchant config |
| Persistent storage | SQLite/Postgres SessionStore and IdempotencyStore implementations |
| Webhook signing | HMAC-SHA256 signature header for webhook security |
| Dashboard UI | Merchant review queue for flagged payments |
| Stuck-session expiry | Transition `submitting` sessions to `expired` after `expiresAt` (see Known gaps above) |
| Background sweep | Periodic sweep to resolve stuck `submitting` sessions without a query trigger (see Known gaps above) |
