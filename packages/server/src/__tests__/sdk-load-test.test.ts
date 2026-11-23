// Test that the SDK loads without ESM errors
import { rpc, TransactionBuilder } from '@stellar/stellar-sdk';

test('SDK rpc namespace loads', () => {
  expect(typeof rpc.Server).toBe('function');
});

test('SDK TransactionBuilder loads', () => {
  expect(typeof TransactionBuilder).toBe('function');
});
