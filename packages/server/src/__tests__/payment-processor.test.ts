/**
 * payment-processor.test.ts
 *
 * Integration tests for the full payment processing pipeline:
 * PaymentEvent → PaymentProcessor → SessionManager → webhooks
 */

import { PaymentProcessor } from '../payment-processor';
import { SessionManager, InMemorySessionStore } from '../session-manager';
import type { WebhookEvent } from '../session-manager';
import type { PaymentEvent } from '@stellarflow/core';
import { InMemoryIdempotencyStore } from '@stellarflow/core';

const MERCHANT = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const CUSTOMER = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN';
const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const NOW = Date.now();

async function makeSetup() {
  const store = new InMemorySessionStore();
  const idempotencyStore = new InMemoryIdempotencyStore();
  const manager = new SessionManager(store);
  const processor = new PaymentProcessor(manager, { idempotencyStore });

  const webhookEvents: WebhookEvent[] = [];
  manager.onWebhook((e) => { webhookEvents.push(e); });

  const session = await manager.createSession({
    asset: { code: 'XLM' },
    amount: '100.0000000',
    destination: MERCHANT,
    expiresAt: NOW + 300_000,
    network: 'testnet',
    label: 'Order #1',
  });

  return { store, idempotencyStore, manager, processor, webhookEvents, session };
}

function makeEvent(overrides: Partial<PaymentEvent> = {}): PaymentEvent {
  return {
    txHash: 'testhash001',
    from: CUSTOMER,
    to: MERCHANT,
    amount: '100.0000000',
    asset: { code: 'XLM' },
    memo: { type: 'id', value: 1n }, // orderId 1n (first created)
    createdAt: Math.floor(NOW / 1000),
    ...overrides,
  };
}

describe('PaymentProcessor — end-to-end flow', () => {
  it('marks session as paid on valid payment', async () => {
    const { processor, manager, session } = await makeSetup();
    await processor.process(makeEvent());

    const updated = await manager.getSession(session.orderId);
    expect(updated!.status).toBe('paid');
  });

  it('fires payment.confirmed webhook on success', async () => {
    const { processor, webhookEvents } = await makeSetup();
    await processor.process(makeEvent());

    expect(webhookEvents).toHaveLength(1);
    expect(webhookEvents[0].type).toBe('payment.confirmed');
    expect((webhookEvents[0] as { txHash: string }).txHash).toBe('testhash001');
  });

  it('does not double-confirm on duplicate txHash', async () => {
    const { processor, manager, webhookEvents } = await makeSetup();
    await processor.process(makeEvent());
    await processor.process(makeEvent()); // duplicate

    expect(webhookEvents).toHaveLength(1); // only one webhook fired
    const session = await manager.getSession(1n);
    expect(session!.status).toBe('paid');
  });

  it('ignores events with non-MEMO_ID memo', async () => {
    const { processor, manager } = await makeSetup();
    await processor.process(makeEvent({ memo: { type: 'none' } }));

    const session = await manager.getSession(1n);
    expect(session!.status).toBe('pending');
  });

  it('ignores events with no matching session', async () => {
    const { processor, manager } = await makeSetup();
    // orderId 999 doesn't exist
    await processor.process(makeEvent({ memo: { type: 'id', value: 999n } }));

    const session = await manager.getSession(1n);
    expect(session!.status).toBe('pending');
  });

  it('flags underpayment and fires review webhook', async () => {
    const { processor, manager, webhookEvents } = await makeSetup();
    await processor.process(makeEvent({ amount: '50.0000000' }));

    const session = await manager.getSession(1n);
    expect(session!.status).toBe('review_required');
    expect(webhookEvents[0].type).toBe('payment.underpayment');
  });

  it('flags wrong asset and fires review webhook', async () => {
    const { processor, manager, webhookEvents } = await makeSetup();
    await processor.process(
      makeEvent({ asset: { code: 'USDC', issuer: USDC_ISSUER } }),
    );

    const session = await manager.getSession(1n);
    expect(session!.status).toBe('review_required');
    expect(webhookEvents[0].type).toBe('payment.review_required');
  });

  it('does not re-process an already-paid session', async () => {
    const { processor, manager, webhookEvents } = await makeSetup();
    await processor.process(makeEvent());
    // Session is now 'paid'. A second different txHash arrives.
    await processor.process(makeEvent({ txHash: 'different_hash' }));

    // Should still only have one webhook event
    expect(webhookEvents).toHaveLength(1);
    const session = await manager.getSession(1n);
    expect(session!.status).toBe('paid'); // not changed
  });

  it('confirms payment on a submitting session (in-browser path)', async () => {
    // 'submitting' is set by POST /submit before Horizon call.
    // The SSE listener fires after on-chain confirmation — processor must
    // still match and mark the session paid.
    const { store, processor, manager, webhookEvents } = await makeSetup();
    await store.updateStatus(1n, 'submitting');

    await processor.process(makeEvent());

    const session = await manager.getSession(1n);
    expect(session!.status).toBe('paid');
    expect(webhookEvents[0].type).toBe('payment.confirmed');
  });

  it('does not re-process a submitting session with a duplicate txHash', async () => {
    const { store, processor, manager, webhookEvents } = await makeSetup();
    await store.updateStatus(1n, 'submitting');

    await processor.process(makeEvent());          // first — marks paid
    await processor.process(makeEvent());          // duplicate txHash

    expect(webhookEvents).toHaveLength(1);
    const session = await manager.getSession(1n);
    expect(session!.status).toBe('paid');
  });
});

describe('SessionManager', () => {
  it('assigns incrementing orderIds', async () => {
    const store = new InMemorySessionStore();
    const manager = new SessionManager(store);

    const s1 = await manager.createSession({
      asset: { code: 'XLM' },
      amount: '10.0',
      destination: MERCHANT,
      expiresAt: NOW + 300_000,
      network: 'testnet',
    });
    const s2 = await manager.createSession({
      asset: { code: 'XLM' },
      amount: '20.0',
      destination: MERCHANT,
      expiresAt: NOW + 300_000,
      network: 'testnet',
    });

    expect(s1.orderId).toBe(1n);
    expect(s2.orderId).toBe(2n);
  });

  it('listSessions returns all created sessions', async () => {
    const store = new InMemorySessionStore();
    const manager = new SessionManager(store);

    await manager.createSession({ asset: { code: 'XLM' }, amount: '10.0', destination: MERCHANT, expiresAt: NOW + 300_000, network: 'testnet' });
    await manager.createSession({ asset: { code: 'XLM' }, amount: '20.0', destination: MERCHANT, expiresAt: NOW + 300_000, network: 'testnet' });

    const sessions = await manager.listSessions();
    expect(sessions).toHaveLength(2);
  });
});
