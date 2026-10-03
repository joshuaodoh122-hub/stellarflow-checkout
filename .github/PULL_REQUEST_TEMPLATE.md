## Summary

<!-- One or two sentences describing what this PR does. -->

## Related issue

<!-- Link to the issue this PR addresses: Fixes #<number> -->

## Changes

<!-- Bullet list of the key changes made. -->

-
-

## Testing

<!-- Describe how you tested this. Include test names or paste relevant output. -->

- [ ] `npm run lint` passes
- [ ] `npm run typecheck` passes
- [ ] `npm test` passes (no tests removed or weakened)
- [ ] New behaviour is covered by new or existing tests

## Security checklist

<!-- Required for any change touching payment logic, session management, XDR validation,
     API auth, or escrow contract code. -->

- [ ] Non-custodial invariant maintained — no code path gives the server signing authority over funds
- [ ] No private keys added, logged, or transmitted
- [ ] If escrow contract changed: Rust contract tests updated and passing

## Notes for reviewer

<!-- Anything the reviewer should know: deployment considerations, follow-up issues,
     intentional tradeoffs, or items deferred to a later PR. -->
