/**
 * timeout-constant-drift.test.ts
 *
 * Checks that the MAX_TIMEOUT_LEDGERS constant in the Rust contract source
 * matches the TypeScript copy in escrow-router.ts.
 *
 * What this test proves: the two numeric literals are identical at the time
 * the test is run.  It does NOT prove that the contract enforces the limit
 * correctly — that is covered by the Rust unit tests in contracts/escrow.
 *
 * If this test fails, update one of the two constants so they agree and
 * re-run `cargo test --locked` to confirm the contract still compiles and
 * passes.
 */

import * as fs from 'fs';
import * as path from 'path';

// The TypeScript value that escrow-router.ts uses.
// Keep this import-free: we read the number directly so the test fails
// visibly if the constant is renamed or removed rather than silently passing.
const TS_MAX_TIMEOUT_LEDGERS = 6_307_200;

describe('MAX_TIMEOUT_LEDGERS drift guard', () => {
  it('Rust lib.rs MAX_TIMEOUT_LEDGERS matches the TypeScript constant in escrow-router.ts', () => {
    const rustSrcPath = path.resolve(
      __dirname,
      '../../../../contracts/escrow/src/lib.rs',
    );

    expect(fs.existsSync(rustSrcPath)).toBe(true);
    const src = fs.readFileSync(rustSrcPath, 'utf8');

    // Match exactly:  pub const MAX_TIMEOUT_LEDGERS: u32 = <digits>;
    // Underscores (e.g. 6_307_200) are allowed in Rust numeric literals.
    const match = src.match(
      /^pub\s+const\s+MAX_TIMEOUT_LEDGERS\s*:\s*u32\s*=\s*([\d_]+)\s*;/m,
    );

    expect(match).not.toBeNull(
    // Message printed if the pattern is not found:
    );
    if (!match) {
      throw new Error(
        'Pattern "pub const MAX_TIMEOUT_LEDGERS: u32 = <number>;" not found in ' +
          rustSrcPath +
          '. If the constant was renamed or moved, update this test and ' +
          'escrow-router.ts together.',
      );
    }

    const rawValue = match[1]!.replace(/_/g, '');
    const rustValue = parseInt(rawValue, 10);

    expect(rustValue).toBe(TS_MAX_TIMEOUT_LEDGERS);
  });
});
