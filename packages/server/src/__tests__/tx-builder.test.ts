/**
 * tx-builder.test.ts
 *
 * Unit tests for buildPaymentTx — the function that constructs an unsigned
 * Stellar payment transaction for the in-browser signing flow.
 *
 * Horizon is mocked so these tests run without a network connection.
 * We verify the structure of the built transaction (destination, asset,
 * amount, memo, timebounds) by deserialising the returned XDR with the
 * stellar-sdk and inspecting the operation and memo fields.
 */

import {
  TransactionBuilder,
  Networks,
  Operation,
} from 'stellar-sdk';
import { buildPaymentTx } from '../tx-builder';
import type { CheckoutSession } from '@stellarflow/core';

// ─── Constants ────────────────────────────────────────────────────────────────

const MERCHANT = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const CUSTOMER = 'GCEYYRVII3YXJEPAO23Z65S4CYVT3OZUYXUHEU6UHBGKFZANXI77SXW7';
const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const NETWORK_PASSPHRASE = Networks.TESTNET;

// ─── Horizon mock ─────────────────────────────────────────────────────────────
//
// stellar-sdk's Horizon.Server is a class. We mock it at the module level so
// buildPaymentTx (which imports and instantiates it internally) gets the mock.

jest.mock('stellar-sdk', () => {
  const actual = jest.requireActual<typeof import('stellar-sdk')>('stellar-sdk');

  // A minimal mock account that the real TransactionBuilder can work with
  const mockAccount = new actual.Account(
    'GCEYYRVII3YXJEPAO23Z65S4CYVT3OZUYXUHEU6UHBGKFZANXI77SXW7',
    '100',
  );

  const MockHorizonServer = jest.fn().mockImplementation(() => ({
    loadAccount: jest.fn().mockResolvedValue(mockAccount),
    feeStats: jest.fn().mockResolvedValue({ fee_charged: { p50: '200' } }),
  }));

  return {
    ...actual,
    Horizon: {
      ...actual.Horizon,
      Server: MockHorizonServer,
    },
  };
});

// ─── Session fixture ──────────────────────────────────────────────────────────

const NOW = Date.now();

const XLM_SESSION: CheckoutSession = {
  orderId: 42n,
  label: 'Test Order',
  asset: { code: 'XLM' },
  amount: '99.9999999',
  destination: MERCHANT,
  expiresAt: NOW + 300_000,
  status: 'pending',
  network: 'testnet',
};

const USDC_SESSION: CheckoutSession = {
  orderId: 43n,
  label: 'USDC Order',
  asset: { code: 'USDC', issuer: USDC_ISSUER },
  amount: '25.0000000',
  destination: MERCHANT,
  expiresAt: NOW + 300_000,
  status: 'pending',
  network: 'testnet',
};

// ─── Helper: deserialise XDR ──────────────────────────────────────────────────

function parseTx(xdr: string) {
  return TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASE);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('buildPaymentTx — XLM payment', () => {
  it('returns a valid XDR string and the correct network passphrase', async () => {
    const result = await buildPaymentTx(XLM_SESSION, CUSTOMER, 'testnet');
    expect(typeof result.txXdr).toBe('string');
    expect(result.txXdr.length).toBeGreaterThan(50);
    expect(result.networkPassphrase).toBe(NETWORK_PASSPHRASE);
  });

  it('builds a transaction with exactly one payment operation', async () => {
    const result = await buildPaymentTx(XLM_SESSION, CUSTOMER, 'testnet');
    const tx = parseTx(result.txXdr);
    expect('operations' in tx).toBe(true);
    if ('operations' in tx) {
      expect(tx.operations).toHaveLength(1);
      expect(tx.operations[0].type).toBe('payment');
    }
  });

  it('sets the correct destination', async () => {
    const result = await buildPaymentTx(XLM_SESSION, CUSTOMER, 'testnet');
    const tx = parseTx(result.txXdr);
    if ('operations' in tx) {
      const op = tx.operations[0] as Operation.Payment;
      expect(op.destination).toBe(MERCHANT);
    }
  });

  it('sets the correct XLM asset', async () => {
    const result = await buildPaymentTx(XLM_SESSION, CUSTOMER, 'testnet');
    const tx = parseTx(result.txXdr);
    if ('operations' in tx) {
      const op = tx.operations[0] as Operation.Payment;
      expect(op.asset.isNative()).toBe(true);
    }
  });

  it('sets the correct amount', async () => {
    const result = await buildPaymentTx(XLM_SESSION, CUSTOMER, 'testnet');
    const tx = parseTx(result.txXdr);
    if ('operations' in tx) {
      const op = tx.operations[0] as Operation.Payment;
      expect(parseFloat(op.amount)).toBeCloseTo(99.9999999, 6);
    }
  });

  it('sets MEMO_ID equal to the session orderId', async () => {
    const result = await buildPaymentTx(XLM_SESSION, CUSTOMER, 'testnet');
    const tx = parseTx(result.txXdr);
    if ('memo' in tx) {
      expect(tx.memo.type).toBe('id');
      expect(tx.memo.value).toBe('42');
    }
  });
});

describe('buildPaymentTx — USDC payment', () => {
  it('sets the USDC asset with correct issuer', async () => {
    const result = await buildPaymentTx(USDC_SESSION, CUSTOMER, 'testnet');
    const tx = parseTx(result.txXdr);
    if ('operations' in tx) {
      const op = tx.operations[0] as Operation.Payment;
      expect(op.asset.isNative()).toBe(false);
      expect(op.asset.getCode()).toBe('USDC');
      expect(op.asset.getIssuer()).toBe(USDC_ISSUER);
    }
  });

  it('sets the correct USDC amount', async () => {
    const result = await buildPaymentTx(USDC_SESSION, CUSTOMER, 'testnet');
    const tx = parseTx(result.txXdr);
    if ('operations' in tx) {
      const op = tx.operations[0] as Operation.Payment;
      expect(parseFloat(op.amount)).toBeCloseTo(25.0, 6);
    }
  });

  it('sets correct MEMO_ID for USDC session', async () => {
    const result = await buildPaymentTx(USDC_SESSION, CUSTOMER, 'testnet');
    const tx = parseTx(result.txXdr);
    if ('memo' in tx) {
      expect(tx.memo.value).toBe('43');
    }
  });
});

describe('buildPaymentTx — fee and options', () => {
  it('accepts a custom baseFeeStroops override', async () => {
    // Should not throw — just uses the provided value instead of fetching
    const result = await buildPaymentTx(XLM_SESSION, CUSTOMER, 'testnet', {
      baseFeeStroops: 500,
    });
    expect(result.txXdr).toBeDefined();
  });

  it('falls back gracefully when feeStats throws', async () => {
    const { Horizon } = jest.requireMock<typeof import('stellar-sdk')>('stellar-sdk');
    const mockInstance = (Horizon.Server as jest.Mock).mock.results.at(-1)?.value;
    if (mockInstance) {
      mockInstance.feeStats.mockRejectedValueOnce(new Error('fee stats unavailable'));
    }
    // Should not throw — uses DEFAULT_FEE_STROOPS fallback
    const result = await buildPaymentTx(XLM_SESSION, CUSTOMER, 'testnet');
    expect(result.txXdr).toBeDefined();
  });
});
