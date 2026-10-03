/** @type {import('jest').Config} */
module.exports = {
  displayName: 'widget',
  testEnvironment: 'jsdom',
  rootDir: '.',
  testMatch: ['<rootDir>/src/**/__tests__/**/*.test.js'],
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/**/__tests__/**',
  ],
  // widget.js uses ES module imports — transform with babel-jest
  transform: {
    '^.+\\.js$': ['babel-jest', {
      presets: [['@babel/preset-env', { targets: { node: 'current' } }]],
    }],
  },
  // The wallet kit is a browser dependency — mock it entirely in tests
  moduleNameMapper: {
    '@creit\\.tech/stellar-wallets-kit(.*)': '<rootDir>/src/__tests__/__mocks__/stellar-wallets-kit.js',
  },
  // Floor: a few points below measured (60/69/50/60 as of 2026-10-03).
  coverageThreshold: {
    global: {
      statements: 57,
      branches: 66,
      functions: 47,
      lines: 57,
    },
  },
};
