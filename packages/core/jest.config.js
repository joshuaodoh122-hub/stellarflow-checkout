/** @type {import('jest').Config} */
module.exports = {
  displayName: 'core', 
  preset: 'ts-jest',
  testEnvironment: 'node',
  // rootDir must be the workspace root so transformIgnorePatterns resolves node_modules
  // correctly when @stellar/stellar-sdk@17's ESM-only transitive deps are loaded.
  rootDir: '../..',
  testMatch: ['<rootDir>/packages/core/src/**/*.test.ts'],
  collectCoverageFrom: [
    'packages/core/src/**/*.ts',
    '!packages/core/src/**/*.d.ts',
    '!packages/core/src/**/__tests__/**',
  ],
  // @stellar/stellar-sdk@17 ships a CJS build that depends on several ESM-only
  // packages: uint8array-extras, @exodus/bytes, @noble/ed25519, @noble/hashes,
  // eventsource. We need:
  //  1. transformIgnorePatterns: tell Jest NOT to ignore these for transformation.
  //  2. moduleNameMapper: bypass package.json exports maps so Jest can find them.
  //  3. babel-jest for .js files: compile ESM export/import syntax to CJS.
  //
  // Note: rootDir = workspace root, so node_modules paths are <rootDir>/node_modules/...
  transformIgnorePatterns: [
    '/node_modules/(?!(uint8array-extras|@exodus/bytes|@noble/ed25519|@noble/hashes|eventsource)/)',
  ],
  moduleNameMapper: {
    // Bypass ESM-only exports maps by pointing directly to the .js file,
    // then babel-jest (transform below) converts the ESM syntax to CJS.
    '^uint8array-extras$': '<rootDir>/node_modules/uint8array-extras/index.js',
    '^@exodus/bytes/(.*)$': '<rootDir>/node_modules/@exodus/bytes/$1',
    '^@noble/ed25519$': '<rootDir>/node_modules/@noble/ed25519/index.js',
    // Redirect nested ESM @noble/hashes to the root CJS version
    '^@noble/hashes/(.*)$': '<rootDir>/node_modules/@noble/hashes/$1',
    // eventsource@4 is ESM-only; not used in tests — empty stub suffices
    '^eventsource$': '<rootDir>/jest-shims/eventsource-stub.cjs',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      diagnostics: true,
      tsconfig: {
        target: 'ES2020',
        lib: ['ES2020'],
        strict: true,
        esModuleInterop: true,
      },
    }],
    // babel-jest converts ESM export/import to CJS for the Jest runner.
    // This applies to the ESM-only packages listed in transformIgnorePatterns above.
    '^.+\\.m?js$': 'babel-jest',
  },
  // Floor: a few points below measured (95/88/94/95 as of 2026-10-03).
  // Prevents regressions while tolerating minor fluctuation.
  coverageThreshold: {
    global: {
      statements: 92,
      branches: 85,
      functions: 91,
      lines: 92,
    },
  },
};
