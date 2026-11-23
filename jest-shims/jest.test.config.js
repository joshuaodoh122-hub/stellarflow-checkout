module.exports = {
  testEnvironment: 'node',
  rootDir: '/workspaces/stellarflow-checkout',
  testMatch: ['<rootDir>/jest-shims/__tests__/**/*.test.js'],
  transformIgnorePatterns: ['/node_modules/(?!(uint8array-extras)/)'],
  transform: { '^.+\\.m?js$': 'babel-jest' },
  moduleNameMapper: {
    '^uint8array-extras$': '<rootDir>/node_modules/uint8array-extras/index.js'
  }
};
