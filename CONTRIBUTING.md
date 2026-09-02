# Contributing to StellarFlow Checkout

Thank you for your interest in contributing. StellarFlow is submitted to the Stellar Drips Wave program and welcomes contributions from the community.

## Before you start

- Check [existing issues](https://github.com/joshuaodoh122-hub/stellarflow-checkout/issues) to avoid duplicate work.
- For large changes, open an issue first to discuss the approach before writing code.
- All contributions must maintain the non-custodial invariant: **no code path may hold, pool, or have signing authority over customer or merchant funds.**

## Issue granularity guide

When opening or picking up issues, use this rough size guide:

| Label | Scope | Examples |
|-------|-------|---------|
| `complexity: trivial` | Isolated util, config, or doc | Fix a typo in ARCHITECTURE.md, add a helper function, update a type |
| `complexity: medium` | A working feature end-to-end | Add a new `PriceSource` adapter, add SQLite session store, add SSE endpoint for real-time status |
| `complexity: high` | New integration or security-sensitive subsystem | Shopify plugin, Reflector oracle integration, webhook HMAC signing |

## Development setup

```bash
git clone https://github.com/joshuaodoh122-hub/stellarflow-checkout.git
cd stellarflow-checkout
npm install
npm run build
npm test
```

## Workflow

1. Fork the repository
2. Create a branch: `git checkout -b feature/your-feature-name`
3. Make your changes
4. Run checks: `npm run lint && npm run typecheck && npm test`
5. Commit with a descriptive message
6. Push and open a pull request against `main`

## Code standards

- TypeScript strict mode is required for all `core` and `server` code.
- New features in `core` and `server` require tests.
- The memo-matching and idempotency logic (`core/src/memo-matcher.ts`) is especially sensitive — any change there requires full test coverage of the affected paths.
- Do not introduce framework dependencies into `@stellarflow/widget` — it must remain vanilla JS.
- Match existing code style (ESLint config is in `.eslintrc.json`).

## Planned stretch goals (good first issues)

These are explicitly out of scope for v1 but documented here for contributors:

- **Persistent session store** — SQLite or Postgres implementation of `SessionStore` and `IdempotencyStore` interfaces (`complexity: medium`)
- **Webhook HMAC signing** — Add HMAC-SHA256 signature header to webhook POST requests (`complexity: medium`)
- **Reflector price oracle** — Implement `PriceSource` interface using the Reflector Soroban oracle (`complexity: high`)
- **Email review notifications** — Alternative to webhooks for solo merchants (`complexity: medium`)
- **Merchant review dashboard** — Simple HTML page listing flagged payments (`complexity: medium`)
- **WooCommerce plugin** — WordPress plugin using the `@stellarflow/server` package (`complexity: high`)
- **Shopify plugin** — Shopify app using the Checkout Extensions API (`complexity: high`)
- **Automated refund tooling** — CLI tool for merchants to issue refunds without server-side signing keys (`complexity: high`)
- **React wrapper** — Thin React component wrapping the widget, for merchant teams using React (`complexity: trivial`)

## Testing

Tests use Jest. Run the full suite with:

```bash
npm test
```

Run a specific package:

```bash
cd packages/core && npm test
cd packages/server && npm test
```

Run with coverage:

```bash
npm run test:coverage
```

The memo-matching logic in `core/src/memo-matcher.ts` must maintain high test coverage. Do not reduce coverage below what is currently passing CI.

## Pull request checklist

- [ ] `npm run lint` passes with no errors
- [ ] `npm run typecheck` passes with no errors
- [ ] `npm test` passes
- [ ] New features have tests
- [ ] Security-sensitive changes are noted in the PR description
- [ ] Non-custodial invariant is maintained
- [ ] Testnet is still the default in all examples

## Questions

Open a [GitHub Discussion](https://github.com/joshuaodoh122-hub/stellarflow-checkout/discussions) for questions that aren't bug reports or feature requests.
