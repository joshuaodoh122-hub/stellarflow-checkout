## Summary

<!-- One or two sentences describing what this PR does. -->

## Related issue

<!-- Link to the issue this PR addresses: Fixes #<number> -->

## Changes

<!-- Bullet list of the key changes made. -->

-
-

## Changelog

<!-- Every PR must add a dated, reasoned entry to CHANGELOG.md under ## [Unreleased]
     as: ### YYYY-MM-DD — <branch name>
     with sections: Changes (files and what), Why (the concrete defect or inaccuracy),
     Tests (exact commands and real results), Limits (what the tests do not prove). -->

- [ ] Entry added to `CHANGELOG.md` under `## [Unreleased]`
- [ ] `bash scripts/check_claims.sh` passes (add rows to `docs/claims-audit.md` for any new behavioural claim)

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
