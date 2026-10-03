# Contributing to StellarFlow Checkout

Thank you for your interest in contributing. This repository welcomes contributions from the community. 

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

## Code of Conduct

This project follows the [Contributor Covenant 2.1 Code of Conduct](CODE_OF_CONDUCT.md).
By participating you agree to abide by its terms.

## Questions

Open a [GitHub Discussion](https://github.com/joshuaodoh122-hub/stellarflow-checkout/discussions) for questions that aren't bug reports or feature requests.

---

## Rust/Soroban contract setup

**Read this before scaffolding the escrow contract (or any future Soroban crate) in this repo.**

This repo is about to gain its first Rust/Soroban crate. The following are easy-to-miss
mistakes when setting up a new Rust project inside a JS/TS monorepo. Each one has caused
real CI failures in Soroban-adjacent projects that were hard to diagnose after the fact.

### 1. Commit `Cargo.lock` — never add it to `.gitignore`

A Soroban smart contract is a **binary/deployable artifact**, not a library intended for
downstream consumption with version-range flexibility. Reproducible builds require the
lockfile. Without it, CI resolves dependencies fresh on every run — and if an upstream
crate publishes a new version that breaks your build, CI fails in a way that does not
reproduce locally (where a stale local lockfile masks the same issue).

The current `.gitignore` in this repo is pure JS/TS and correctly has no Rust entries.
Keep it that way. When you run `cargo new` or copy a Soroban template, the default
`.gitignore` that Cargo generates **does include `Cargo.lock`** (as would be appropriate
for a library). **Check before committing anything and remove that line if it is present.**

### 2. Audit the template `.gitignore` before your first commit

Steps:
1. `cargo new contracts/escrow` (or wherever the crate lives)
2. `cat contracts/escrow/.gitignore` — look for `Cargo.lock`
3. If present, delete that line. Then `git add Cargo.lock` alongside your first
   `Cargo.toml` commit.

### 3. Pin dependencies with known version-range problems

Pin explicitly in `Cargo.toml` with a comment rather than discovering it later through a
failed CI run. In particular:

`soroban-env-host` has historically had a loose `>=2.0.0` constraint on `ed25519-dalek`
that can resolve to the 3.x series, which has a breaking API change. Some versions of
`soroban-sdk` pull in `soroban-env-host` transitively. **Verify the current upstream state
before assuming this is already fixed** — it may be resolved by the time you read this, but
it may not be. If you see `ed25519-dalek` in your lock file at 3.x and the build fails with
an API error, this is the cause. Fix by adding an explicit upper-bound pin:

```toml
# Explicit upper bound: soroban-env-host's >=2.0.0 constraint can resolve to
# ed25519-dalek 3.x which has a breaking API. Pin to <3 until upstream fixes the
# constraint. Remove this pin once soroban-env-host publishes a version that
# requires >=3 explicitly.
ed25519-dalek = "=2.1.1"
```

Verify `soroban-sdk` version compatibility at https://github.com/stellar/rs-soroban-sdk
before choosing a `soroban-sdk` version to pin.

### 4. CI Rust job path hygiene

Do **not** add `working-directory` to a CI job unless the crate genuinely lives in a
subdirectory — and if you do, verify the path exists before considering CI "done."

A common failure mode: you write a CI YAML with `working-directory: contracts/escrow`
before the directory exists, or after renaming it. The job looks correct on paper but
fails on the first run with a confusing "no such file or directory" or "no Cargo.toml
found" error. Local commands run from wherever you are and don't expose the mismatch.

Before marking CI as done:
1. Confirm the actual path of `Cargo.toml` relative to the repo root.
2. Check the `working-directory` in every Rust CI step matches it exactly.
3. Push a branch and verify the CI run passes — do not assume it will.

