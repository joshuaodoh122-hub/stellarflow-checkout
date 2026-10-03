/** @type {import('jest').Config} */
module.exports = {
  displayName: 'core', 
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/src/**/*.test.ts'],
  globals: {
    'ts-jest': {
      tsconfig: {
        strict: true,
        esModuleInterop: true,
      },
    },
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts', '!src/**/__tests__/**'],
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
