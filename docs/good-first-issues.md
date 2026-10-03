# Good first issues

Two ready-to-paste GitHub issues. Create them via the GitHub Issues UI and apply
the `complexity: trivial` / `complexity: medium` labels as noted.

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the development workflow before picking
one up.

---

## Issue 1 — React wrapper for the StellarFlow widget

**Labels:** `enhancement`, `complexity: trivial`

**Title:** `feat: React wrapper component for @stellarflow/widget`

**Body:**

### Background

`@stellarflow/widget` is a vanilla-JS embeddable widget. Teams that build their
merchant storefront in React currently have to wire up `StellarFlow.init()` in a
`useEffect` and manage the DOM lifecycle manually. A thin React wrapper would give
React teams a first-class component API without changing the underlying widget.

### What to build

A new `packages/react` workspace package (or a file inside `packages/widget`) that
exports a single `<StellarFlowCheckout>` React component. The component must:

1. Accept the same configuration props that the vanilla widget reads from
   `data-*` attributes (`apiUrl`, `fiatAmount`, `asset`, `label`, etc.).
2. Call `StellarFlow.init()` after the component mounts (i.e. inside `useEffect`).
3. Forward `stellarflow:paid` and `stellarflow:review` DOM events as `onPaid` and
   `onReview` React callback props.
4. Clean up the widget on unmount (remove event listeners, call the widget's
   teardown if available).

### Acceptance criteria

- [ ] A `<StellarFlowCheckout>` component renders without errors in a React 18 app.
- [ ] `onPaid(detail)` is called when `stellarflow:paid` fires.
- [ ] `onReview(detail)` is called when `stellarflow:review` fires.
- [ ] Event listeners are removed on unmount (no memory leaks).
- [ ] At least one Jest/RTL test covering mount, payment event, and unmount.
- [ ] `npm run lint && npm run typecheck && npm test` all pass.
- [ ] Non-custodial invariant maintained — component adds no server-side code.

### Files to touch

- `packages/react/` — new workspace package (or `packages/widget/src/react.tsx`)
- `packages/react/package.json` — add `react` and `react-dom` as peer dependencies
- Root `package.json` — add `packages/react` to workspaces if a new package
- `CONTRIBUTING.md` — update the Good first issues section once done

### Complexity

`complexity: trivial` — the component is a thin wrapper around an existing DOM API.
No payment logic or server code is needed.

### References

- [CONTRIBUTING.md](../CONTRIBUTING.md)
- [`packages/widget/src/widget.js`](../packages/widget/src/widget.js) — the widget being wrapped
- [React useEffect docs](https://react.dev/reference/react/useEffect)

---

## Issue 2 — HTTP webhook delivery handler with HMAC-SHA256 signing

**Labels:** `enhancement`, `complexity: medium`, `security`

**Title:** `feat: HTTP webhook delivery handler with HMAC-SHA256 signing`

**Body:**

### Background

`SessionManager.onWebhook()` only supports in-process callbacks. Merchants who run
their backend separately have no ready-made way to receive events over HTTP, and no
way to verify that a request really came from their StellarFlow server.

Adding an HTTP delivery helper with an `X-StellarFlow-Signature: sha256=<hex>` header
(HMAC-SHA256 of the raw JSON body, keyed with a shared secret) is the standard pattern
used by Stripe, GitHub, and most payment processors. It is the only thing standing
between the current in-process-only webhook API and production-readiness for merchants
who run a separate backend.

### What to build

`createHttpWebhookHandler({ url, secret, timeoutMs?, fetchImpl? })` in
`packages/server`, returning a `WebhookHandler` that can be passed straight to
`onWebhook()`. It POSTs the event as JSON and sets
`X-StellarFlow-Signature: sha256=<hex>`, the HMAC-SHA256 of the exact raw body
bytes, using Node's built-in `crypto`. No new dependencies; use the global `fetch`
(Node 18+), injectable for tests. Export it from `packages/server/src/index.ts`.

### Acceptance criteria

- [ ] Correct signature present on every outbound POST.
- [ ] Signature changes when the body changes.
- [ ] Request times out cleanly and does not throw into `SessionManager`.
- [ ] The signature is computed over the exact bytes sent (no double serialisation).
- [ ] At least four tests using an injected fake fetch.
- [ ] A verification snippet for merchants added to `SECURITY.md`.
- [ ] `WEBHOOK_URL` and `WEBHOOK_SECRET` documented in `packages/demo/.env.example`.
- [ ] `npm run lint && npm run typecheck && npm test` all pass.
- [ ] No new npm dependencies (use Node built-in `crypto` and global `fetch`).

### Files to touch

- `packages/server/src/http-webhook-handler.ts` — new file, the handler factory
- `packages/server/src/__tests__/http-webhook-handler.test.ts` — at least four tests
- `packages/server/src/index.ts` — export `createHttpWebhookHandler`
- `SECURITY.md` — merchant verification snippet
- `ARCHITECTURE.md` — update webhook events section
- `packages/demo/.env.example` — add `WEBHOOK_URL` and `WEBHOOK_SECRET` entries

### Complexity

`complexity: medium` — requires careful handling of serialised body bytes to ensure
the signature is reproducible on the merchant side. Timeout and error handling must
not propagate exceptions into `SessionManager`.

### References

- [CONTRIBUTING.md](../CONTRIBUTING.md)
- [HMAC-SHA256 Node.js docs](https://nodejs.org/api/crypto.html#cryptocreatehmacalgorithm-key-options)
- [Stripe webhook signing reference](https://stripe.com/docs/webhooks/signatures)
- [`packages/server/src/session-manager.ts`](../packages/server/src/session-manager.ts) — `onWebhook()` API
