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

## Issue 2 — Webhook HMAC-SHA256 signing

**Labels:** `enhancement`, `complexity: medium`, `security`

**Title:** `feat: add HMAC-SHA256 signature header to webhook POST requests`

**Body:**

### Background

StellarFlow fires webhook events (`payment.confirmed`, `payment.overpaid`,
`payment.review_required`, etc.) via HTTP POST to a merchant-configured endpoint.
Currently the payload is unsigned, so a merchant's webhook handler has no way to
verify that the POST actually came from their StellarFlow server instance and not
from an attacker replaying or spoofing a webhook.

Adding an `X-StellarFlow-Signature` header (HMAC-SHA256 of the raw JSON body,
keyed with a shared secret) is the standard pattern used by Stripe, GitHub, and
most payment processors. It is the only thing standing between the current webhook
implementation and production-readiness for security-conscious merchants.

This is tracked as a roadmap item in README.md under v0.5.

### What to build

In `packages/server/src/session-manager.ts`, where the webhook POST is constructed:

1. Add an optional `webhookSecret?: string` field to `SessionManagerOptions`.
2. When `webhookSecret` is set, compute
   `HMAC-SHA256(rawJsonBody, webhookSecret)` using Node's built-in `crypto` module
   (no new dependencies).
3. Add the result as `X-StellarFlow-Signature: sha256=<hex>` on every webhook POST.
4. Document the header format in `SECURITY.md` and `ARCHITECTURE.md`.
5. Add `WEBHOOK_SECRET` to `packages/demo/.env.example` with a comment.

### Acceptance criteria

- [ ] When `webhookSecret` is set, every outbound webhook POST carries
  `X-StellarFlow-Signature: sha256=<hex>`.
- [ ] The signature is computed with `crypto.createHmac('sha256', secret)` over
  the exact bytes sent in the body (no double-serialisation).
- [ ] When `webhookSecret` is not set, no signature header is added (backwards
  compatible — existing integrations are unaffected).
- [ ] At least three tests: correct signature present, absent when no secret,
  signature changes when body changes.
- [ ] A verification code snippet (for the merchant's webhook handler) is added
  to `SECURITY.md`.
- [ ] `npm run lint && npm run typecheck && npm test` all pass.
- [ ] No new npm dependencies (use Node built-in `crypto`).

### Files to touch

- `packages/server/src/session-manager.ts` — add signing logic
- `packages/server/src/__tests__/session-manager.test.ts` — add tests
- `packages/demo/.env.example` — add `WEBHOOK_SECRET` entry
- `SECURITY.md` — add verification snippet
- `ARCHITECTURE.md` — update webhook events section

### Complexity

`complexity: medium` — touches the session manager and requires careful handling of
the serialised body bytes to ensure the signature is reproducible on the merchant side.

### References

- [CONTRIBUTING.md](../CONTRIBUTING.md)
- [HMAC-SHA256 Node.js docs](https://nodejs.org/api/crypto.html#cryptocreatehmacalgorithm-key-options)
- [Stripe webhook signing reference](https://stripe.com/docs/webhooks/signatures)
- [`packages/server/src/session-manager.ts`](../packages/server/src/session-manager.ts)
