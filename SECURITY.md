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
