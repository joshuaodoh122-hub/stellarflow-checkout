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
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts'],
};
