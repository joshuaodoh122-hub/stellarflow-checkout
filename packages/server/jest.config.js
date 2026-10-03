/** @type {import('jest').Config} */
module.exports = {
  displayName: 'server',
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/src/**/*.test.ts'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/__tests__/**',
  ],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: {
        strict: true,
        esModuleInterop: true,
        paths: {
          '@stellarflow/core': ['../core/src/index.ts'],
        },
      },
    }],
  },
  moduleNameMapper: {
    '^@stellarflow/core$': '<rootDir>/../core/src/index.ts',
  },
  // Floor: a few points below measured (88/77/95/88 as of 2026-10-03).
  coverageThreshold: {
    global: {
      statements: 85,
      branches: 74,
      functions: 92,
      lines: 85,
    },
  },
};
