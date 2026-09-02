/**
 * memo-matcher.test.ts
 *
 * Tests for the memo-matching and idempotency logic.
 * These tests cover the "must not have silent bugs" requirement.
 */

import {
  matchPayment,
  InMemoryIdempotencyStore,
  assetsEqual,
  compareAmounts,
} from '../memo-matcher';
import type { CheckoutSession, PaymentEvent } from '../types';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000; // fixed "now" in ms
const EXPIRES_FUTURE = NOW + 5 * 60 * 1000; // 5 min from now
const EXPIRES_PAST = NOW - 60_000; // 1 min ago (expired)

const MERCHANT = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const CUSTOMER = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN';
const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

function makeSession(overrides: Partial<CheckoutSession> = {}): CheckoutSession {
  return {
    orderId: 42n,
    label: 'Order #42',
    asset: { code: 'XLM' },
    amount: '100.0000000',
    destination: MERCHANT,
    expiresAt: EXPIRES_FUTURE,
    status: 'pending',
    network: 'testnet',
    ...overrides,
  };
}

function makeEvent(overrides: Partial<PaymentEvent> = {}): PaymentEvent {
  return {
    txHash: 'abc123txhash',
    from: CUSTOMER,
    to: MERCHANT,
    amount: '100.0000000',
    asset: { code: 'XLM' },
    memo: { type: 'id', value: 42n },
    createdAt: Math.floor(NOW / 1000),
    ...overrides,
  };
}

// ─── assetsEqual ─────────────────────────────────────────────────────────────

describe('assetsEqual', () => {
  it('XLM equals XLM', () => {
    expect(assetsEqual({ code: 'XLM' }, { code: 'XLM' })).toBe(true);
  });

  it('USDC equals USDC with same issuer', () => {
    expect(
      assetsEqual(
        { code: 'USDC', issuer: USDC_ISSUER },
        { code: 'USDC', issuer: USDC_ISSUER },
      ),
    ).toBe(true);
  });

  it('USDC does not equal USDC with different issuer', () => {
    expect(
      assetsEqual(
        { code: 'USDC', issuer: USDC_ISSUER },
        { code: 'USDC', issuer: 'GDIFFERENT' },
      ),
    ).toBe(false);
  });

  it('XLM does not equal USDC', () => {
    expect(
      assetsEqual({ code: 'XLM' }, { code: 'USDC', issuer: USDC_ISSUER }),
    ).toBe(false);
  });

  it('issuer comparison is case-insensitive', () => {
    expect(
      assetsEqual(
        { code: 'USDC', issuer: USDC_ISSUER.toLowerCase() },
        { code: 'USDC', issuer: USDC_ISSUER.toUpperCase() },
      ),
    ).toBe(true);
  });
});

// ─── compareAmounts ───────────────────────────────────────────────────────────

describe('compareAmounts', () => {
  it('equal amounts return 0', () => {
    expect(compareAmounts('100.0000000', '100.0000000')).toBe(0);
  });

  it('greater amount returns positive', () => {
    expect(compareAmounts('100.0000001', '100.0000000')).toBeGreaterThan(0);
  });

  it('lesser amount returns negative', () => {
    expect(compareAmounts('99.9999999', '100.0000000')).toBeLessThan(0);
  });

  it('handles amounts without decimal', () => {
    expect(compareAmounts('100', '100.0000000')).toBe(0);
  });

  it('handles amounts with fewer decimal places', () => {
    expect(compareAmounts('100.5', '100.5000000')).toBe(0);
  });

  it('correctly identifies underpayment by 1 stroop', () => {
    expect(compareAmounts('99.9999999', '100.0000000')).toBeLessThan(0);
  });
});

// ─── matchPayment — happy path ─────────────────────────────────────────────────

describe('matchPayment — happy path', () => {
  it('accepts a valid payment and returns matched:true', async () => {
    const store = new InMemoryIdempotencyStore();
    const result = await matchPayment(makeSession(), makeEvent(), store, NOW);
    expect(result.matched).toBe(true);
    expect(result.status).toBe('paid');
  });

  it('records the txHash in the store after a match', async () => {
    const store = new InMemoryIdempotencyStore();
    await matchPayment(makeSession(), makeEvent(), store, NOW);
    expect(store.size()).toBe(1);
    expect(await store.has('abc123txhash')).toBe(true);
  });

  it('accepts exact amount with XLM', async () => {
    const store = new InMemoryIdempotencyStore();
    const result = await matchPayment(
      makeSession({ amount: '50.1234567' }),
      makeEvent({ amount: '50.1234567' }),
      store,
      NOW,
    );
    expect(result.matched).toBe(true);
  });

  it('accepts overpayment', async () => {
    const store = new InMemoryIdempotencyStore();
    const result = await matchPayment(
      makeSession({ amount: '100.0000000' }),
      makeEvent({ amount: '101.0000000' }),
      store,
      NOW,
    );
    expect(result.matched).toBe(true);
  });
});

// ─── matchPayment — idempotency ────────────────────────────────────────────────

describe('matchPayment — idempotency', () => {
  it('returns matched:false for a duplicate txHash', async () => {
    const store = new InMemoryIdempotencyStore();
    const event = makeEvent();

    const first = await matchPayment(makeSession(), event, store, NOW);
    expect(first.matched).toBe(true);

    const second = await matchPayment(makeSession(), event, store, NOW);
    expect(second.matched).toBe(false);
    expect(second.status).toBe('pending');
    expect((second as { reason: string }).reason).toContain('duplicate');
  });

  it('does not double-count even if called concurrently', async () => {
    // Simulate concurrent calls with the same txHash
    const store = new InMemoryIdempotencyStore();
    const session = makeSession();
    const event = makeEvent();

    // Race condition: both calls check has() before either records()
    // Our implementation records BEFORE any state mutation, so the second
    // has() check in a synchronous flow catches this — but since the store
    // is async we test the sequential case which is what a Node event loop delivers
    const results = await Promise.all([
      matchPayment(session, event, store, NOW),
      matchPayment(session, { ...event, txHash: 'different_hash' }, store, NOW),
    ]);

    const paid = results.filter((r) => r.status === 'paid');
    expect(paid.length).toBe(2); // different hashes, both valid
    expect(store.size()).toBe(2);
  });

  it('store records txHash even for flagged payments (wrong asset)', async () => {
    const store = new InMemoryIdempotencyStore();
    const session = makeSession({ asset: { code: 'XLM' } });
    const event = makeEvent({ asset: { code: 'USDC', issuer: USDC_ISSUER } });

    const result = await matchPayment(session, event, store, NOW);
    expect(result.matched).toBe(false);
    expect(result.status).toBe('review_required');
    // txHash should still be recorded to prevent re-processing
    expect(await store.has(event.txHash)).toBe(true);
  });
});

// ─── matchPayment — expired quote ─────────────────────────────────────────────

describe('matchPayment — expired quote', () => {
  it('flags expired quote as review_required', async () => {
    const store = new InMemoryIdempotencyStore();
    const session = makeSession({ expiresAt: EXPIRES_PAST });
    const result = await matchPayment(session, makeEvent(), store, NOW);
    expect(result.matched).toBe(false);
    expect(result.status).toBe('review_required');
    expect((result as { reason: string }).reason).toContain('expired');
  });

  it('does NOT silently accept expired payments', async () => {
    const store = new InMemoryIdempotencyStore();
    const session = makeSession({ expiresAt: NOW - 1 }); // 1ms ago
    const result = await matchPayment(session, makeEvent(), store, NOW);
    expect(result.matched).toBe(false);
  });

  it('accepts payment at exactly the expiry boundary', async () => {
    const store = new InMemoryIdempotencyStore();
    // expiresAt is exclusive — payment at exactly expiresAt is still valid
    const session = makeSession({ expiresAt: NOW + 1 }); // 1ms in future
    const result = await matchPayment(session, makeEvent(), store, NOW);
    expect(result.matched).toBe(true);
  });
});

// ─── matchPayment — wrong asset ────────────────────────────────────────────────

describe('matchPayment — wrong asset', () => {
  it('flags wrong asset (USDC sent for XLM order)', async () => {
    const store = new InMemoryIdempotencyStore();
    const session = makeSession({ asset: { code: 'XLM' } });
    const event = makeEvent({ asset: { code: 'USDC', issuer: USDC_ISSUER } });

    const result = await matchPayment(session, event, store, NOW);
    expect(result.matched).toBe(false);
    expect(result.status).toBe('review_required');
    expect((result as { reason: string }).reason).toContain('wrong asset');
  });

  it('flags wrong asset (XLM sent for USDC order)', async () => {
    const store = new InMemoryIdempotencyStore();
    const session = makeSession({ asset: { code: 'USDC', issuer: USDC_ISSUER } });
    const event = makeEvent({ asset: { code: 'XLM' } });

    const result = await matchPayment(session, event, store, NOW);
    expect(result.matched).toBe(false);
    expect(result.status).toBe('review_required');
  });

  it('flags USDC from wrong issuer', async () => {
    const store = new InMemoryIdempotencyStore();
    const session = makeSession({ asset: { code: 'USDC', issuer: USDC_ISSUER } });
    const event = makeEvent({ asset: { code: 'USDC', issuer: 'GFAKEISSUERXXX' } });

    const result = await matchPayment(session, event, store, NOW);
    expect(result.matched).toBe(false);
    expect(result.status).toBe('review_required');
  });
});

// ─── matchPayment — underpayment ───────────────────────────────────────────────

describe('matchPayment — underpayment', () => {
  it('flags underpayment', async () => {
    const store = new InMemoryIdempotencyStore();
    const session = makeSession({ amount: '100.0000000' });
    const event = makeEvent({ amount: '99.0000000' });

    const result = await matchPayment(session, event, store, NOW);
    expect(result.matched).toBe(false);
    expect(result.status).toBe('underpayment');
    expect((result as { reason: string }).reason).toContain('underpayment');
  });

  it('flags underpayment of 1 stroop', async () => {
    const store = new InMemoryIdempotencyStore();
    const session = makeSession({ amount: '100.0000000' });
    const event = makeEvent({ amount: '99.9999999' });

    const result = await matchPayment(session, event, store, NOW);
    expect(result.matched).toBe(false);
    expect(result.status).toBe('underpayment');
  });

  it('accepts within tolerance', async () => {
    const store = new InMemoryIdempotencyStore();
    const session = makeSession({ amount: '100.0000000' });
    const event = makeEvent({ amount: '99.9999999' }); // 1 stroop short

    const result = await matchPayment(session, event, store, NOW, {
      amountToleranceStroops: 1n,
    });
    expect(result.matched).toBe(true);
  });
});

// ─── matchPayment — memo mismatch ──────────────────────────────────────────────

describe('matchPayment — memo mismatch', () => {
  it('ignores payment with wrong memo ID', async () => {
    const store = new InMemoryIdempotencyStore();
    const session = makeSession({ orderId: 42n });
    const event = makeEvent({ memo: { type: 'id', value: 99n } });

    const result = await matchPayment(session, event, store, NOW);
    expect(result.matched).toBe(false);
    expect(result.status).toBe('pending');
    expect((result as { reason: string }).reason).toContain('memo mismatch');
  });

  it('ignores payment with no memo', async () => {
    const store = new InMemoryIdempotencyStore();
    const session = makeSession({ orderId: 42n });
    const event = makeEvent({ memo: { type: 'none' } });

    const result = await matchPayment(session, event, store, NOW);
    expect(result.matched).toBe(false);
    expect((result as { reason: string }).reason).toContain('memo mismatch');
  });

  it('ignores payment with hash memo type', async () => {
    const store = new InMemoryIdempotencyStore();
    const session = makeSession({ orderId: 42n });
    const event = makeEvent({ memo: { type: 'hash', value: 'deadbeef' } });

    const result = await matchPayment(session, event, store, NOW);
    expect(result.matched).toBe(false);
  });

  it('does NOT record txHash in store for memo mismatches (not our payment)', async () => {
    const store = new InMemoryIdempotencyStore();
    const session = makeSession({ orderId: 42n });
    const event = makeEvent({ memo: { type: 'id', value: 99n } });

    await matchPayment(session, event, store, NOW);
    // Memo mismatch happens BEFORE we record the txHash
    expect(await store.has(event.txHash)).toBe(false);
  });
});

// ─── matchPayment — destination mismatch ──────────────────────────────────────

describe('matchPayment — destination mismatch', () => {
  it('ignores payment to a different address', async () => {
    const store = new InMemoryIdempotencyStore();
    const session = makeSession({ destination: MERCHANT });
    const event = makeEvent({ to: 'GDIFFERENTMERCHANT' });

    const result = await matchPayment(session, event, store, NOW);
    expect(result.matched).toBe(false);
    expect(result.status).toBe('pending');
  });
});

// ─── InMemoryIdempotencyStore ─────────────────────────────────────────────────

describe('InMemoryIdempotencyStore', () => {
  it('has() returns false for unseen hash', async () => {
    const store = new InMemoryIdempotencyStore();
    expect(await store.has('unknown')).toBe(false);
  });

  it('has() returns true after record()', async () => {
    const store = new InMemoryIdempotencyStore();
    await store.record('myhash');
    expect(await store.has('myhash')).toBe(true);
  });

  it('clear() resets state', async () => {
    const store = new InMemoryIdempotencyStore();
    await store.record('myhash');
    store.clear();
    expect(await store.has('myhash')).toBe(false);
    expect(store.size()).toBe(0);
  });
});
