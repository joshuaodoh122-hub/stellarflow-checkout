# Security Policy
 
## Supported versions

| Version | Supported |
|---------|-----------|
| 0.1.x (current) | ✅ |

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**
 
Report vulnerabilities by emailing the maintainer or opening a [GitHub Security Advisory](https://github.com/joshuaodoh122-hub/stellarflow-checkout/security/advisories/new).

Include:
- A description of the vulnerability
- Steps to reproduce
- Potential impact
- Any suggested mitigations

We aim to acknowledge reports within 48 hours and to publish a fix or mitigation within 14 days for critical issues.

## Security design

### Non-custodial invariant

StellarFlow is strictly non-custodial. The system is designed so that:

- Funds flow **directly** from the customer's wallet to the merchant's configured Stellar address.
- The StellarFlow server holds **no private keys**.
- The server has **no signing authority** over any funds.
- There is **no escrow**, intermediary account, or pooling.

Any code path that would give the server signing authority over funds is a **critical vulnerability**, regardless of whether it is intentional.

### Idempotency

Every payment event is deduplicated by transaction hash before an order is marked paid. A redelivered Horizon event, a server restart, or a reconnect cannot double-credit an order. The `IdempotencyStore` must persist across restarts in production — the in-memory implementation provided is for testing and the demo only.

### Payment validation

The following conditions are enforced on every incoming payment. Failing any check flags the payment for merchant review — it is **never silently accepted**:

- Correct destination address
- Correct MEMO_ID (matching the order)
- Correct asset (code + issuer)
- Amount ≥ quoted amount
- Payment received within the quote expiry window

### Subresource Integrity

The widget script runs inside third-party merchant pages. Merchants must load it with a Subresource Integrity (SRI) hash to protect against supply-chain attacks:

```html
<script
  src="https://cdn.example.com/stellarflow-widget.js"
  integrity="sha384-REPLACE_WITH_HASH"
  crossorigin="anonymous"
></script>
```

Generate the hash:
```bash
openssl dgst -sha384 -binary packages/widget/dist/stellarflow-widget.js | openssl base64 -A
```

### Recommended Content Security Policy

Merchants embedding the widget should use:

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self' https://cdn.example.com;
  connect-src 'self' https://horizon-testnet.stellar.org https://api.coingecko.com;
  img-src 'self' data:;
  style-src 'self' 'unsafe-inline';
  frame-ancestors 'none';
```

For mainnet, replace `horizon-testnet.stellar.org` with `horizon.stellar.org`.

### Input validation

- All API endpoints validate input types and reject invalid values with 400 responses.
- `orderId` values are parsed as `BigInt` to prevent integer overflow.
- Amounts are compared as fixed-point integers (stroops) to avoid floating-point precision errors.

### Testnet default

Testnet is the default in every config, example, and script. Mainnet requires explicit opt-in and triggers a startup warning. This prevents accidental mainnet transactions during development.

## Known limitations (v1)

- The session store and idempotency store are in-memory. **A server restart loses all session state.** Do not use the demo server for production without implementing a persistent store.
- Webhook delivery is fire-and-forget with no retry. Failed webhook handlers are logged but not retried.
- Webhook payloads are not HMAC-signed in v1. Adding webhook signing is a documented stretch goal.

---

## Soroban escrow contract security (v0.2)

The escrow contract (`contracts/escrow`) holds real customer and merchant funds in a
Soroban smart contract. The following trust assumptions apply.

### What the contract guarantees

- **Funds cannot be permanently locked.** After the timeout window (default: 30 days /
  518,400 ledgers), the original payer can always reclaim their funds by calling
  `refund()`. The contract enforces this on-chain — no off-chain intervention is needed.
- **Only the recorded merchant can release funds.** The `release()` function calls
  `require_auth()` on the address stored in the escrow record at deposit time. A
  different address cannot impersonate the merchant.
- **Only payer or merchant can refund.** The `refund()` function explicitly checks
  that `caller == record.payer || caller == record.merchant` before calling
  `require_auth()`. Any other caller gets `NotAuthorized`.
- **No double-deposit.** Depositing with a duplicate `order_id` returns `AlreadyExists`
  without touching funds.

### Trust assumptions

- **Funds are only as safe as the merchant and payer key security.** If the merchant's
  private key is compromised, an attacker can call `release()` and drain the escrow.
  If the payer's key is compromised, an attacker can call `refund()` after the timeout.
  There is no multi-sig or additional key security in v0.2.
- **There is no arbitration for disputed fulfilment in v0.2.** If the merchant claims
  to have fulfilled and the payer disagrees, there is no on-chain dispute resolution.
  The payer's only recourse is to wait for the timeout and then call `refund()`. A
  future version may add a third-party arbiter role.
- **All-or-nothing per order.** Partial releases or refunds are not supported in v0.2.
  A refund always returns the full deposited amount. A release always sends the full
  amount to the merchant.
- **The timeout is approximate.** The timeout is measured in ledger sequence numbers
  at ~5 s/ledger. Actual wall-clock time may differ slightly depending on network
  conditions. The `deposited_at` field in the escrow record is canonical — use
  `deposited_at + timeout_ledgers` to determine the exact unlock ledger.

### Non-custodial invariant (maintained)

The StellarFlow server does not hold or have signing authority over escrow funds.
All contract invocations are signed by the caller's wallet (payer or merchant).
The server constructs unsigned transactions and coordinates the flow — it never
sees a private key.

---

## Soroban escrow threat model (v0.2)

### XDR substitution

**Threat:** An attacker intercepts the unsigned deposit XDR and replaces it with a transaction targeting a different contract, a different method (e.g. `release` instead of `deposit`), or a different beneficiary, then submits the replaced XDR via `POST /api/escrow/:id/submit`.

**Mitigation:** The submit endpoint validates the parsed XDR before forwarding:
1. Must be a `Transaction` (not `FeeBump`)
2. Must contain exactly one `invokeHostFunction` operation
3. Invoked contract ID must match `session.contractId` (ESCROW_CONTRACT_ID)
4. Invoked method must be `"deposit"`
5. Transaction source account must match `session.payerAddress`

Failure on any check returns 400 and the XDR is discarded — nothing is sent to the network.

### Replay of a submitted deposit

**Threat:** An attacker replays a previously submitted signed deposit XDR to create a duplicate on-chain deposit for the same `order_id`.

**Mitigation (contract layer):** The escrow contract rejects any `deposit()` call for an `order_id` that already exists in persistent storage (`EscrowError::AlreadyExists` code 1). The contract is the canonical guard — the server cannot be bypassed.

**Mitigation (server layer):** The session's status transitions from `pending` to a temporary lock before submission. A second concurrent submit attempt sees a non-`pending` status and is rejected with 409 before even reaching the XDR validation.

### Merchant key handling

**Non-custodial invariant:** The StellarFlow server never holds or requests the merchant's private key on the normal HTTP request path.

- `POST /api/escrow/:id/release` returns an unsigned release XDR for the merchant to sign in their own wallet.
- The server only calls `buildUnsignedContractTx` (simulates + assembles footprint) — no signing authority.
- The `invokeContract` method (which accepts a signer callback) is explicitly documented as scripts/tests-only and must never be called from an HTTP handler.

**Threat:** If a merchant's private key is compromised, an attacker can call `release()` and drain the escrow to the merchant's address — but not to any other address. The contract enforces `record.merchant.require_auth()`.

### Timeout semantics and payer protection

**What the timeout protects against:** If a merchant never calls `release()` and never calls `refund()`, the payer's funds would be locked forever without the timeout mechanism.

**How it works:** The `timeout_ledgers` parameter (default: 518,400 ledgers ≈ 30 days at ~5s/ledger) is stored on-chain at deposit time. After `deposited_at + timeout_ledgers` ledgers have passed, the payer may call `refund()` unilaterally. Before that ledger, `EscrowError::TimeoutNotElapsed` is returned.

**Risks to communicate to users:**
- The timeout is measured in ledger sequence numbers, not wall clock time. Actual elapsed time may differ slightly from the ledger estimate.
- The payer cannot get funds back before the timeout without the merchant's co-operation.
- There is no arbiter or dispute resolution in v0.2 — if fulfilment is disputed, the payer must wait for the timeout.

### Session store persistence

The escrow session store is in-memory. A server restart loses all session state. If a deposit was submitted successfully but the server restarts before the session is updated to `deposited`, the on-chain funds are still safe (held by the contract), but the server will lose knowledge of the session. The `GET /api/escrow/:id` endpoint reconciles with on-chain state, but only if the session object still exists in memory.

**Mitigation for production:** Replace the in-memory store with a persistent store (SQLite, Postgres) — the same recommendation applies to the classic `SessionStore`.

### Rate limiting

The `/api/escrow` routes are subject to the same rate limiter configured in `packages/demo/src/server.ts` (60 req/min per IP). For production, consider separate, more aggressive limits on the write endpoints (`/submit`, `/release`, `/refund`).

