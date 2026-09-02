/**
 * horizon-listener.test.ts
 *
 * Tests for the Horizon record parser (pure unit tests, no network calls).
 *
 * stellar-sdk v12 naming:
 *   'payment'                  → standard payment
 *   'path_payment'             → path payment strict receive (legacy name in SDK)
 *   'path_payment_strict_send' → path payment strict send
 */

import { parseHorizonRecord } from '../horizon-listener';
import type { Horizon } from 'stellar-sdk';

const MERCHANT = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const CUSTOMER = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN';
const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const TX_HASH = 'deadbeefdeadbeef1234567890abcdef1234567890abcdef1234567890abcdef';

function makePaymentRecord(
  overrides: Partial<Record<string, unknown>> = {},
): Horizon.ServerApi.OperationRecord {
  return {
    type: 'payment',
    id: '12345',
    paging_token: '12345',
    transaction_hash: TX_HASH,
    created_at: '2024-01-01T00:00:00Z',
    from: CUSTOMER,
    to: MERCHANT,
    amount: '100.0000000',
    asset_type: 'native',
    ...overrides,
  } as unknown as Horizon.ServerApi.OperationRecord;
}

describe('parseHorizonRecord', () => {
  it('parses a native XLM payment', () => {
    const record = makePaymentRecord();
    const event = parseHorizonRecord(record, 'id', '42', '2024-01-01T00:00:00Z');

    expect(event).not.toBeNull();
    expect(event!.asset).toEqual({ code: 'XLM' });
    expect(event!.amount).toBe('100.0000000');
    expect(event!.from).toBe(CUSTOMER);
    expect(event!.to).toBe(MERCHANT);
    expect(event!.txHash).toBe(TX_HASH);
  });

  it('parses MEMO_ID correctly', () => {
    const record = makePaymentRecord();
    const event = parseHorizonRecord(record, 'id', '42');

    expect(event!.memo).toEqual({ type: 'id', value: 42n });
  });

  it('parses MEMO_HASH correctly', () => {
    const record = makePaymentRecord();
    const event = parseHorizonRecord(record, 'hash', 'abc123');

    expect(event!.memo).toEqual({ type: 'hash', value: 'abc123' });
  });

  it('sets memo to none when no memo provided', () => {
    const record = makePaymentRecord();
    const event = parseHorizonRecord(record);

    expect(event!.memo).toEqual({ type: 'none' });
  });

  it('parses USDC credit payment', () => {
    const record = makePaymentRecord({
      asset_type: 'credit_alphanum4',
      asset_code: 'USDC',
      asset_issuer: USDC_ISSUER,
    });
    const event = parseHorizonRecord(record, 'id', '42');

    expect(event!.asset).toEqual({ code: 'USDC', issuer: USDC_ISSUER });
  });

  it('returns null for non-payment operation types', () => {
    const record = makePaymentRecord({ type: 'create_account' });
    expect(parseHorizonRecord(record)).toBeNull();
  });

  it('returns null for account_merge operations', () => {
    const record = makePaymentRecord({ type: 'account_merge' });
    expect(parseHorizonRecord(record)).toBeNull();
  });

  it('returns null for manage_sell_offer operations', () => {
    const record = makePaymentRecord({ type: 'manage_sell_offer' });
    expect(parseHorizonRecord(record)).toBeNull();
  });

  it('handles invalid memo value gracefully', () => {
    const record = makePaymentRecord();
    // 'not_a_number' cannot be parsed as BigInt
    const event = parseHorizonRecord(record, 'id', 'not_a_number');

    expect(event!.memo).toEqual({ type: 'none' });
  });

  it('parses path_payment (strict receive) operation', () => {
    // In stellar-sdk v12, PathPaymentOperationRecord has type 'path_payment_strict_receive'
    const record = {
      type: 'path_payment_strict_receive',
      id: '12345',
      paging_token: '12345',
      transaction_hash: TX_HASH,
      created_at: '2024-01-01T00:00:00Z',
      from: CUSTOMER,
      to: MERCHANT,
      amount: '50.0000000',
      asset_type: 'native',
    } as unknown as Horizon.ServerApi.OperationRecord;

    const event = parseHorizonRecord(record, 'id', '42');
    expect(event).not.toBeNull();
    expect(event!.amount).toBe('50.0000000');
    expect(event!.asset).toEqual({ code: 'XLM' });
  });

  it('parses path_payment_strict_send operation using amount (destination amount)', () => {
    // In stellar-sdk v12, PathPaymentStrictSendOperationRecord has:
    //   amount = what destination receives (not source_amount)
    //   asset_type/code/issuer = destination asset
    const record = {
      type: 'path_payment_strict_send',
      id: '12345',
      paging_token: '12345',
      transaction_hash: TX_HASH,
      created_at: '2024-01-01T00:00:00Z',
      from: CUSTOMER,
      to: MERCHANT,
      source_amount: '100.0000000', // what was sent (different asset)
      amount: '49.5000000',         // what destination receives
      asset_type: 'native',
    } as unknown as Horizon.ServerApi.OperationRecord;

    const event = parseHorizonRecord(record, 'id', '42');
    expect(event).not.toBeNull();
    // Should use `amount` (destination received), not source_amount
    expect(event!.amount).toBe('49.5000000');
  });

  it('converts createdAt to UNIX seconds', () => {
    const record = makePaymentRecord();
    const event = parseHorizonRecord(record, undefined, undefined, '2024-01-01T00:00:00Z');
    expect(event!.createdAt).toBe(1704067200);
  });
});
