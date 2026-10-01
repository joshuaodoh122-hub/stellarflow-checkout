/** @type {import('jest').Config} */
module.exports = {
  projects: [
    '<rootDir>/packages/core',
    '<rootDir>/packages/server',
    '<rootDir>/packages/widget',
  ], 
  coverageDirectory: '<rootDir>/coverage',
  coverageProvider: 'v8',
};
