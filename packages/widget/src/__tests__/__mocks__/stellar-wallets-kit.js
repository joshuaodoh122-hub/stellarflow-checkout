// Mock for @creit.tech/stellar-wallets-kit and its sub-paths
// Used in widget tests to avoid browser-only Web Components dependencies.

const StellarWalletsKit = {
  init: jest.fn(),
  on: jest.fn(() => jest.fn()), // returns an unsubscribe fn
  openModal: jest.fn(),
  closeModal: jest.fn(),
  signTransaction: jest.fn().mockResolvedValue({ signedTxXdr: 'MOCK_SIGNED_XDR' }),
};

const defaultModules = jest.fn(() => []);
const KitEventType = { STATE_UPDATED: 'STATE_UPDATED', CONNECT: 'CONNECT' };
const SwkAppDarkTheme = 'DARK';

module.exports = { StellarWalletsKit, defaultModules, KitEventType, SwkAppDarkTheme };
