# StellarFlow Checkout

Open-source, non-custodial Web3 payment widget for the [Stellar network](https://stellar.org). Lets small merchants and independent creators accept **USDC** and **XLM** with ~5 second settlement and near-zero fees — without the 2–3%+ taken by traditional processors.

[![CI](https://github.com/joshuaodoh122-hub/stellarflow-checkout/actions/workflows/ci.yml/badge.svg)](https://github.com/joshuaodoh122-hub/stellarflow-checkout/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Stellar: Testnet](https://img.shields.io/badge/Stellar-Testnet-blue)](https://developers.stellar.org/docs/fundamentals-and-concepts/testnet-and-pubnet)

---

## The problem

Small digital-download shops and independent creators pay 2–3%+ per transaction to payment processors, wait 1–3 business days for settlement, and have no option for cross-border payments without high FX fees.

Stellar offers a programmable payment rail with:
- ~5 second settlement finality
- Fees of ~0.00001 XLM per transaction (fractions of a cent)
- Native USD stablecoin support (USDC via Circle)
- A global, permissionless network

The missing piece is a drop-in checkout widget that works without a custodian, without per-wallet integration, and without platform-specific plugins.

---

## How it works

1. Customer clicks **"Pay with Stellar Wallet"** on the merchant's checkout page.
2. The widget calls the merchant's backend to create a checkout session with a quoted price.
3. A [SEP-0007](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0007.md) payment URI is generated — the Stellar standard for payment requests. This produces both a QR code (for mobile wallets) and a deep link (for browser extensions).
4. The customer pays via any SEP-0007-compatible wallet: Freighter, Lobstr, xBull, Albedo, Solar.
5. The merchant backend listens to Horizon's SSE stream for payments to their address. The last-seen cursor is persisted to disk so any payment that arrives while the server is temporarily down is still processed on restart — not silently missed. When a payment arrives, it is matched by **memo ID** (the order's unique numeric ID) and validated against amount, asset, and quote expiry.
6. The widget polls for status and shows a success screen when the payment is confirmed.

Funds go **directly from the customer's wallet to the merchant's wallet**. StellarFlow never holds, pools, or has signing authority over any funds.

---

## Architecture summary

See [ARCHITECTURE.md](ARCHITECTURE.md) for full details including all design decisions.

Key decisions:
- **Memo scheme:** `MEMO_ID` (uint64) — natively indexed by Horizon, human-readable, covers any realistic order volume.
- **Price source:** CoinGecko free tier with a 3-minute expiry window. USDC is treated as exactly $1.00. The `PriceSource` interface makes it swappable for an on-chain oracle (e.g. Reflector on Soroban).
- **Review flow:** Webhook callbacks. Underpayments, wrong-asset payments, and expired-quote payments are flagged for merchant review — never silently accepted.
- **Refunds:** Manual (see ARCHITECTURE.md). Automated refunds would require server-side signing authority over merchant funds — a violation of the non-custodial invariant.
- **Cursor persistence:** The Horizon SSE cursor (`paging_token`) is saved to disk after every message via `FileCursorStore`. On restart, the listener resumes from the last saved cursor instead of `now`, closing the gap where payments that land during a server downtime would otherwise be missed.

---

## Packages

| Package | Description |
|---------|-------------|
| [`@stellarflow/core`](packages/core) | Memo matching, idempotency, price quoting, SEP-0007 URI generation, Horizon listener |
| [`@stellarflow/server`](packages/server) | Express middleware, session manager, payment processor |
| [`@stellarflow/widget`](packages/widget) | Vanilla JS embeddable widget (no framework dependency) |
| [`@stellarflow/demo`](packages/demo) | Reference storefront demonstrating the full loop |

---

## Quick start (testnet)

### Prerequisites
- Node.js 18+
- A funded Stellar testnet account ([get one here](https://laboratory.stellar.org/#account-creator))

### Run the demo

```bash
git clone https://github.com/joshuaodoh122-hub/stellarflow-checkout.git
cd stellarflow-checkout
npm install

# Configure
cp packages/demo/.env.example packages/demo/.env
# Edit packages/demo/.env — set your MERCHANT_ADDRESS to a testnet public key

# Build core + server packages
npm run build

# Start the demo server
cd packages/demo && npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to see the demo storefront.

On startup you will see a line like:

```
[horizon] Cursor file: /path/to/stellarflow-checkout/horizon-cursor.txt
```

This file persists the Horizon cursor across restarts. You can change its location with the `CURSOR_FILE` env var in your `.env`:

```
CURSOR_FILE=/var/data/stellarflow/horizon-cursor.txt
```

### Embed the widget

```html
<!-- In your checkout page: -->
<script src="stellarflow-widget.js"></script>
<div
  data-stellarflow
  data-api-url="https://yourstore.com"
  data-fiat-amount="9.99"
  data-asset="XLM"
  data-label="Your Product Name"
></div>
<script>StellarFlow.init();</script>
```

Listen for payment events:

```js
document.addEventListener('stellarflow:paid', (e) => {
  console.log('Order paid:', e.detail.orderId);
  // Fulfil the order
});

document.addEventListener('stellarflow:review', (e) => {
  console.log('Review needed:', e.detail.orderId, e.detail.status);
});
```

### Handle webhooks (server-side)

```typescript
import { SessionManager } from '@stellarflow/server';

const manager = new SessionManager(store);
manager.onWebhook((event) => {
  if (event.type === 'payment.confirmed') {
    // Fulfil order event.session.orderId
    fulfil(event.session.orderId, event.txHash);
  }
  if (event.type === 'payment.underpayment') {
    // Contact customer
    flagForReview(event.session.orderId, event.reason);
  }
});
```

### Using `HorizonPaymentListener` directly

`start()` is async — it loads the saved cursor from the store before opening the SSE stream. Always `await` it:

```typescript
import { HorizonPaymentListener, FileCursorStore } from '@stellarflow/core';

const listener = new HorizonPaymentListener(merchantAddress, {
  network: 'testnet',
  cursor: 'now',                              // fallback used only on first start
  cursorStore: new FileCursorStore('./horizon-cursor.txt'),
});

// Must be awaited — loads the saved cursor before the stream opens
await listener.start(
  async (event) => { /* handle PaymentEvent */ },
  (err) => { console.error(err); },
);
```

If you omit `cursorStore`, `InMemoryCursorStore` is used by default (cursor lost on restart — fine for tests, not for production).

---

## Switching to mainnet

> ⚠️ **Mainnet uses real funds. There is no undo.**

1. Set `STELLAR_NETWORK=mainnet` in your `.env`
2. Set `MERCHANT_ADDRESS` to a real funded Stellar account
3. Acknowledge the warning at server startup
4. Update your CSP to use `https://horizon.stellar.org` instead of `https://horizon-testnet.stellar.org`

---

## Development

```bash
npm install        # Install all workspace dependencies
npm run build      # Build all packages
npm run typecheck  # TypeScript type checking
npm run lint       # ESLint
npm test           # Run all tests
npm run test:coverage  # With coverage report
```

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Security

See [SECURITY.md](SECURITY.md) for vulnerability reporting and security design.

---

## License

[MIT](LICENSE) — Copyright (c) 2026 StellarFlow Checkout Contributors
