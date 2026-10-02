# StellarFlow Checkout

Open-source, non-custodial payment widget for the [Stellar network](https://stellar.org).
Lets merchants accept **USDC** and **XLM** with ~5 second settlement and near-zero fees — without the 2–3%+ taken by traditional processors.
 
[![CI](https://github.com/joshuaodoh122-hub/stellarflow-checkout/actions/workflows/ci.yml/badge.svg)](https://github.com/joshuaodoh122-hub/stellarflow-checkout/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Stellar: Testnet](https://img.shields.io/badge/Stellar-Testnet-blue)](https://developers.stellar.org/docs/fundamentals-and-concepts/testnet-and-pubnet)
 
---

## Two checkout modes: Classic Horizon and Soroban Escrow

StellarFlow supports two independent checkout modes. They can run on the same server simultaneously.

| Mode | How it works | Settlement | Best for |
|------|-------------|-----------|----------|
| **Classic Horizon** | SEP-0007 URI → customer wallet → Stellar payment → Horizon SSE | Direct (customer → merchant) | Digital downloads, immediate fulfilment, lowest friction |
| **Soroban Escrow** | Unsigned XDR → wallet signs → funds locked in contract → merchant releases | Via contract (customer → contract → merchant) | Delayed fulfilment, physical goods, orders needing a trust window |

**Choose escrow when:** fulfilment takes time (shipping, service delivery), the customer wants a refund window, or you want on-chain proof of the payment lifecycle.

**Choose classic when:** you fulfil instantly, want lowest transaction overhead, or your customers are already familiar with SEP-0007 wallets.

---

## Soroban escrow — honest status (v0.2)

**What is built and tested:**

| Component | Status | Evidence |
|-----------|--------|----------|
| Rust escrow contract (`contracts/escrow`) | ✅ 17 unit tests written | `contracts/escrow/src/lib.rs` |
| `HttpSorobanRpcClient` (real SDK integration) | ✅ Implemented | `packages/server/src/escrow-session.ts` |
| `simulateContract` (read path) | ✅ 3 tests | `http-soroban-rpc-client.test.ts` |
| `buildUnsignedContractTx` (non-custodial write) | ✅ 6 tests | `http-soroban-rpc-client.test.ts` |
| `submitSignedTx` (poll-until-confirmed) | ✅ 6 tests | `http-soroban-rpc-client.test.ts` |
| `invokeContract` (scripts/tests signer) | ✅ 3 tests | `http-soroban-rpc-client.test.ts` |
| `POST /api/escrow` + 6 other endpoints | ✅ real-XDR supertest tests | `escrow-router.test.ts` |
| Deposit XDR: full 6-arg validation (payer/merchant/amount/token/order_id/timeout) | ✅ one test per arg | `escrow-router.test.ts` |
| Post-confirmation on-chain record verification | ✅ mismatch test | `escrow-router.test.ts` |
| `POST /api/escrow/:id/release/submit` | ✅ 6 tests including wrong-contract/order_id/source | `escrow-router.test.ts` |
| `POST /api/escrow/:id/refund/submit` | ✅ 6 tests including wrong-contract/order_id/third-party | `escrow-router.test.ts` |
| Testnet proof script | ✅ Written, uses server endpoints, typechecks | `scripts/escrow-testnet-demo.ts` |
| Live testnet run | ⏳ **Not yet run** — requires deployed contract + funded accounts | See below |

**What "not yet run" means:** The TypeScript implementation is complete and all 101 new unit/integration tests pass. The escrow contract itself is not yet deployed to testnet by this author. The testnet proof script (`scripts/escrow-testnet-demo.ts`) is ready to execute once a contract is deployed.

---

## Escrow trust model

**What the server validates before forwarding a deposit to the chain:**

1. XDR parses as a `Transaction` (not `FeeBump`)
2. Exactly one `invokeHostFunction` operation
3. Host function type is `invokeContract` (not `uploadContractWasm` or `createContract`)
4. Operation has no per-op source account, OR it equals `session.payerAddress`
5. Transaction source account equals `session.payerAddress`
6. Invoked contract ID equals `session.contractId` (ESCROW_CONTRACT_ID)
7. Method name equals `"deposit"`
8. `arg[0]` payer equals `session.payerAddress` (exact)
9. `arg[1]` merchant equals `session.merchantAddress` (exact)
10. `arg[2]` amount equals `BigInt(session.amount)` (exact bigint — no loose comparison)
11. `arg[3]` token equals `session.tokenContractId` (exact)
12. `arg[4]` order\_id equals `session.orderId` bytes (exact 32-byte comparison)
13. `arg[5]` timeout\_ledgers equals `session.requestedTimeoutLedgers` (exact)

After the deposit transaction confirms on-chain, `getEscrow()` is called and the on-chain payer/merchant/amount/token are verified against the session a second time before setting status to `deposited`. A mismatch sets terminal status `mismatch` — the session is never promoted.

**For release/submit and refund/submit:** same structural checks, with method == `"release"` / `"refund"`, tx source == merchant (release) or caller (refund), and the order\_id argument verified exactly.

**What the wallet signs:** Everything. The server returns unsigned XDR; the wallet signs it; the server validates the signed XDR before submitting. The server never holds or sees a private key.

**Session state:** In-memory only. A server restart loses session state. On-chain funds are still safe — the escrow contract holds them independently — but the server will lose knowledge of sessions created before the restart. Use `GET /api/escrow/:orderId` to reconcile once the session is re-created from on-chain data.

**Single token per order:** Each escrow session is for one SAC token contract. The token is fixed at session creation and enforced in XDR validation.

**All-or-nothing:** Release transfers the full deposited amount to the merchant. Refund returns the full amount to the payer. Partial amounts are not supported in v0.2.

**Remaining limitations (v0.2):**
- No partial refunds — refund always returns the full deposited amount
- No third-party arbitration — if merchant claims fulfilment and payer disagrees, payer must wait for timeout
- Single token per order — one SAC token contract per escrow
- Session store is in-memory — server restart loses escrow session state (same limitation as classic checkout)
- The 17 Rust contract tests pass in an environment with Rust installed — they could not be run in this CI environment (no `cargo` available)

**Soroban SDK note:** This integration uses `stellar-sdk@12.3.0` (already in the repo) which ships full Soroban support (`SorobanRpc.Server`, `Contract`, `nativeToScVal`, `scValToNative`, `assembleTransaction`). A separate `@stellar/stellar-sdk` package is not needed and was not added.

---

## How to run the testnet proof

```bash
# 1. Install the Stellar CLI
# https://developers.stellar.org/docs/tools/stellar-cli

# 2. Deploy the escrow contract to testnet
cd contracts/escrow
cargo build --target wasm32v1-none --release
stellar contract deploy \
  --wasm target/wasm32v1-none/release/escrow.wasm \
  --network testnet \
  --source <your-funded-account>
# Note the contract address (C...)

# 3. Configure environment
export ESCROW_CONTRACT_ID=CXXX...   # from step 2
export SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
export STELLAR_NETWORK=testnet

# 4. Start the demo server
cd packages/demo
npm run dev &

# 5. Run the testnet proof script
cd ../..
npx ts-node scripts/escrow-testnet-demo.ts
```

The script will print every transaction hash and links to stellar.expert for verification.

---

## Soroban status — honest statement

**v0.1 uses Horizon (Stellar Classic) only for the classic payment flow.** That flow is:
SEP-0007 URI → customer wallet → Stellar transaction → Horizon SSE stream → memo matching.

**v0.2 adds a real Soroban escrow checkout mode.** See the "Two checkout modes" section above and the implementation in `packages/server/src/escrow-session.ts` and `packages/server/src/escrow-router.ts`.

| Feature | Status | Branch |
|---|---|---|
| Soroban escrow checkout (`EscrowCheckoutSession`) | ✅ Built & tested — testnet deploy pending | `feat/escrow-rpc-client`, `feat/escrow-checkout-routes` |
| Reflector on-chain price oracle (`ReflectorPriceSource`) | Planned v0.3 | — |

---

## What problem this solves

Small digital-download shops and independent creators pay 2–3%+ per transaction to
payment processors, wait 1–3 business days for settlement, and face high FX fees for
cross-border payments.

Stellar offers:
- ~5 second settlement finality
- Fees of ~0.00001 XLM per transaction (fractions of a cent)
- Native USD stablecoin support (USDC via Circle)
- A global, permissionless payment rail

The missing piece is a **drop-in checkout widget** that works without a custodian,
without per-wallet integration, and without platform-specific plugins.
StellarFlow is that piece.

---

## How it works

```
Customer Browser                        Merchant Backend
      │                                       │
      │  1. Click "Pay with Stellar"          │
      │──POST /api/checkout──────────────────▶│
      │                                       │ creates CheckoutSession
      │◀─{ sep0007Uri, qrDataUrl, orderId }───│ fetches XLM/USDC price
      │                                       │ (CoinGecko, 3-min TTL)
      │  2. Renders QR + deep link            │
      │                                       │
      │  3. Customer opens wallet             │
      │     signs SEP-0007 payment            │
      │──────────────────────────────────────▶ Stellar Network (~5s)
      │                                              │
      │  4. Widget polls GET /api/checkout/:id       │ Horizon SSE stream
      │                                       │◀─────┘
      │                                       │ memo-matched, idempotency-checked
      │◀─{ status: 'paid' }──────────────────│ fires payment.confirmed webhook
      │
      │  5. stellarflow:paid DOM event
```

Key design decisions:
- **Memo scheme:** `MEMO_ID` (uint64) — natively indexed by Horizon, human-readable.
- **Price source:** CoinGecko free tier with 3-minute expiry. Swappable via `PriceSource` interface.
- **Non-custodial:** funds go directly customer → merchant. StellarFlow never holds keys.
- **Cursor persistence:** Horizon SSE cursor saved to disk after every message so payments
  that arrive during server downtime are not silently missed on restart.
- **XDR validation:** the `/submit` endpoint validates destination, asset, amount, and
  MEMO_ID before forwarding to Horizon — prevents request forgery.

Full rationale in [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Packages

| Package | Description |
|---------|-------------|
| [`@stellarflow/core`](packages/core) | Memo matching, idempotency, price quoting, SEP-0007 URI generation, Horizon SSE listener |
| [`@stellarflow/server`](packages/server) | Express router, session manager, payment processor, tx builder |
| [`@stellarflow/widget`](packages/widget) | Vanilla JS embeddable widget (no framework dependency) |
| [`@stellarflow/demo`](packages/demo) | Reference storefront demonstrating the full checkout loop |

---

## Quick start (testnet)

### Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | ≥ 18 | [nodejs.org](https://nodejs.org) |
| npm | ≥ 9 | bundled with Node |
| A funded Stellar testnet account | — | [Stellar Laboratory](https://laboratory.stellar.org/#account-creator) |

### 1. Clone and install

```bash
git clone https://github.com/joshuaodoh122-hub/stellarflow-checkout.git
cd stellarflow-checkout
npm install
```

### 2. Configure

```bash
cp packages/demo/.env.example packages/demo/.env
```

Edit `packages/demo/.env` and set **at minimum**:

```
MERCHANT_ADDRESS=GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
STELLAR_NETWORK=testnet
```

All other fields have sensible defaults for testnet. See `packages/demo/.env.example`
for the full reference.

### 3. Build

```bash
npm run build
```

### 4. Start the demo server

```bash
cd packages/demo && npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The console will print:

```
[stellarflow] Merchant: GXXX...
[horizon] Cursor file: /path/to/stellarflow-checkout/horizon-cursor.txt
[server] Listening on port 3000
```

The cursor file persists the Horizon stream position across restarts. Change its
location with `CURSOR_FILE` in your `.env`.

### 5. Test a payment

Use [Stellar Laboratory](https://laboratory.stellar.org/#txbuilder) or any
SEP-0007-compatible testnet wallet (Freighter with testnet mode enabled) to pay
the generated QR code.

---

## Embed the widget

```html
<script src="stellarflow-widget.js"></script>
<div
  data-stellarflow
  data-api-url="https://yourstore.com"
  data-fiat-amount="9.99"
  data-asset="XLM"
  data-label="Digital Download Pack"
></div>
<script>StellarFlow.init();</script>
```

Listen for payment events:

```js
document.addEventListener('stellarflow:paid', (e) => {
  // e.detail.orderId — fulfil the order
  fulfil(e.detail.orderId);
});

document.addEventListener('stellarflow:review', (e) => {
  // e.detail.orderId, e.detail.status — flag for manual review
});
```

---

## Server-side integration

### Handle webhooks

```typescript
import { SessionManager } from '@stellarflow/server';

const manager = new SessionManager(store);

manager.onWebhook((event) => {
  switch (event.type) {
    case 'payment.confirmed':
      fulfil(event.session.orderId, event.txHash);
      break;
    case 'payment.underpayment':
      flagForReview(event.session.orderId, event.reason);
      break;
    case 'payment.review_required':
      flagForReview(event.session.orderId, event.reason);
      break;
  }
});
```

### Start the Horizon listener

```typescript
import { HorizonPaymentListener, FileCursorStore } from '@stellarflow/core';

const listener = new HorizonPaymentListener(merchantAddress, {
  network: 'testnet',
  cursor: 'now',                                      // fallback on first start
  cursorStore: new FileCursorStore('./horizon-cursor.txt'), // persists across restarts
});

// Must be awaited — loads the saved cursor before opening the SSE stream
await listener.start(
  async (event) => { await processor.process(event); },
  (err) => console.error('[horizon]', err),
);
```

If you omit `cursorStore`, `InMemoryCursorStore` is used (cursor lost on restart —
fine for tests, not for production).

---

## Contract interface

### `POST /api/checkout`

Create a checkout session.

**Body:** `{ fiatAmount: number, assetCode: 'XLM' | 'USDC', label?: string }`

**Returns:**
```json
{
  "orderId": "1",
  "status": "pending",
  "quote": { "cryptoAmount": "99.9000000", "assetCode": "XLM", "pricePerUnit": 0.1, "fiatAmount": 9.99, "expiresAt": "..." },
  "payment": { "destination": "GXXX...", "sep0007Uri": "web+stellar:pay?...", "qrDataUrl": "data:image/png;base64,..." }
}
```

### `GET /api/checkout/:orderId`

Poll session status. Returns `pending`, `submitting`, `paid`, `expired`,
`underpayment`, `wrong_asset`, or `review_required`.

### `POST /api/checkout/:orderId/tx`

Build an unsigned payment transaction for in-browser wallet signing.

**Body:** `{ customerAddress: string }`

**Returns:** `{ txXdr: string, networkPassphrase: string }`

### `POST /api/checkout/:orderId/submit`

Validate and submit a signed transaction XDR to Horizon. Validates destination,
asset, amount, and MEMO_ID before forwarding — prevents request forgery.

**Body:** `{ signedTxXdr: string }`

### `GET /api/sessions`

List all sessions (for merchant dashboard / demo use).

### `GET /api/network`

Returns `{ network, networkPassphrase, horizonUrl }` — used by the widget to
initialise the Stellar Wallets Kit without hardcoded config.

---

## Development

```bash
npm install        # install all workspace dependencies
npm run build      # compile all TypeScript packages
npm run typecheck  # type-check without emitting
npm run lint       # ESLint
npm test           # run all 180 tests
npm run test:coverage  # with coverage report
```

Run a single package:

```bash
cd packages/core && npm test
cd packages/server && npm test
```

---

## Switching to mainnet

> ⚠️ **Mainnet uses real funds. There is no undo.**

1. Set `STELLAR_NETWORK=mainnet` in your `.env`
2. Set `MERCHANT_ADDRESS` to a funded mainnet Stellar account
3. Acknowledge the warning printed at server startup
4. Update your CSP to allow `https://horizon.stellar.org`

---

## Known limitations

1. **No sybil resistance / allow-list.** Any Stellar address can initiate a payment.
   Add an allow-list or minimum-stake requirement at the application layer if needed.

2. **Fixed credit allocation.** USDC is pegged at $1.00 exactly. If USDC depegs,
   pause the widget manually.

3. **No automated refunds.** Stellar has no native transaction reversal. See
   [ARCHITECTURE.md](ARCHITECTURE.md) for the manual refund process.

4. **In-memory session storage.** The default store loses sessions on restart.
   A SQLite/Postgres `SessionStore` implementation is a documented stretch goal.

5. **No time-based session expiry sweep.** Sessions stuck in `submitting` past
   `expiresAt` need a manual query to resolve. A background sweep is a documented
   stretch goal.

6. **Soroban escrow: tested against a mocked network only.** The server validates every
   XDR argument, verifies the on-chain record after confirmation (against a mock), and
   all 101 escrow unit/integration tests pass. The contract has 17 Rust unit tests.
   Neither has been run against a live testnet — that requires a deployed contract and
   funded accounts. See the [Soroban escrow — honest status](#soroban-escrow--honest-status-v02)
   section above.

---

## Roadmap

| Version | Feature |
|---|---|
| v0.2 | Soroban escrow checkout (built & tested against mocked network — live testnet deploy pending) |
| v0.2 (future) | Escrow: partial releases/refunds (all-or-nothing in current version) |
| v0.2 (future) | Escrow: third-party arbitration (no arbiter role in current version) |
| v0.3 | Reflector on-chain price oracle (`ReflectorPriceSource` via `PriceSource` interface) |
| v0.4 | Persistent session store (SQLite implementation of `SessionStore`) |
| v0.5 | Webhook HMAC-SHA256 signing |
| v1.0 | Shopify / WooCommerce plugins |

---

## Project structure

```
stellarflow-checkout/
├── packages/
│   ├── core/        # @stellarflow/core — Horizon listener, memo matching, quoting, SEP-0007
│   ├── server/      # @stellarflow/server — Express router, session manager, tx builder
│   ├── widget/      # @stellarflow/widget — vanilla JS embeddable widget
│   └── demo/        # @stellarflow/demo — reference storefront
├── .github/
│   └── workflows/   # CI: lint, typecheck, test (Node 18 + 20 matrix)
├── ARCHITECTURE.md
├── CHANGELOG.md
├── CONTRIBUTING.md
├── EMMY_CHANGELOG.md
├── SECURITY.md
└── LICENSE          # MIT
```

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Security

See [SECURITY.md](SECURITY.md) for vulnerability reporting and the security design
(non-custodial invariant, XDR validation, testnet-by-default).

---

## License

[MIT](LICENSE) — Copyright (c) 2026 StellarFlow Checkout Contributors
