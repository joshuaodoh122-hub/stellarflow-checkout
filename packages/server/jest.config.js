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
};
