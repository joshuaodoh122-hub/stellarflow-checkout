/**
 * payment-pipeline.test.ts
 *
 * End-to-end pipeline tests: HorizonPaymentListener → PaymentProcessor →
 * SessionManager → webhook events.
 *
 * These tests simulate the full SSE-to-webhook flow without any live network
 * calls. stellar-sdk's Horizon.Server is mocked at the module level so the
 * listener's stream() callback can be invoked synchronously from tests.
 *
 * Gaps filled by this suite:
 *   - Full pipeline: SSE event → processor → session marked paid
 *   - Full pipeline: processor with amountToleranceStroops accepts near-match
 *   - Full pipeline: wrong_asset SSE event → session → review webhook
 *   - Full pipeline: expired-quote SSE event → session → review webhook
 *   - PaymentProcessor.process() skips sessions already in 'paid' state
 *   - Double-submit guard: submitting → paid via SSE, not re-processed by
 *     a second duplicate SSE event
 */

import {
  HorizonPaymentListener,
  InMemoryCursorStore,
} from '@stellarflow/core';
import type { PaymentEvent } from '@stellarflow/core';
import { PaymentProcessor } from '../payment-processor';
import { SessionManager, InMemorySessionStore } from '../session-manager';
import type { WebhookEvent } from '../session-manager';
import { InMemoryIdempotencyStore } from '@stellarflow/core';
import type { Horizon } from 'stellar-sdk';

// ─── Constants ────────────────────────────────────────────────────────────────

const MERCHANT = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const CUSTOMER = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN';
const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const TX_HASH = 'deadbeef1234cafebabe5678000000001111111122222222333333334444444455';

// ─── Stream mock factory ──────────────────────────────────────────────────────

function buildStreamMock() {
  let onmessage: ((r: unknown) => void | Promise<void>) | undefined;
  let onerror: ((e: unknown) => void) | undefined;
  const stopFn = jest.fn();

  const mockPaymentsBuilder = {
    forAccount: jest.fn().mockReturnThis(),
    cursor: jest.fn().mockReturnThis(),
    stream: jest.fn((opts: { onmessage?: typeof onmessage; onerror?: typeof onerror }) => {
      onmessage = opts.onmessage;
      onerror = opts.onerror;
      return stopFn;
    }),
  };

  const MockServer = jest.fn().mockImplementation(() => ({
    payments: jest.fn(() => mockPaymentsBuilder),
  }));

  return {
    MockServer,
    triggerMessage: async (record: unknown) => { await onmessage?.(record); },
    triggerError: (err: unknown) => { onerror?.(err); },
    stopFn,
  };
}

const streamFactory = { current: buildStreamMock() };

jest.mock('stellar-sdk', () => {
  const actual = jest.requireActual<typeof import('stellar-sdk')>('stellar-sdk');
  return {
    ...actual,
    Horizon: {
      ...actual.Horizon,
      Server: jest.fn().mockImplementation((...args: unknown[]) => {
        return new streamFactory.current.MockServer(...args);
      }),
    },
  };
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeHorizonRecord(overrides: Record<string, unknown> = {}): Horizon.ServerApi.OperationRecord {
  return {
    type: 'payment',
    id: '99999',
    paging_token: '99999-pt',
    transaction_hash: TX_HASH,
    created_at: new Date().toISOString(),
    from: CUSTOMER,
    to: MERCHANT,
    amount: '100.0000000',
    asset_type: 'native',
    transaction: async () => ({
      memo_type: 'id',
      memo: '1', // orderId 1n — first session created
      created_at: new Date().toISOString(),
    }),
    ...overrides,
  } as unknown as Horizon.ServerApi.OperationRecord;
}

type SetupOptions = {
  assetCode?: 'XLM' | 'USDC';
  amount?: string;
  expiresAt?: number;
  toleranceStroops?: bigint;
};

async function buildPipeline(opts: SetupOptions = {}) {
  const store = new InMemorySessionStore();
  const idempotencyStore = new InMemoryIdempotencyStore();
  const manager = new SessionManager(store);
  const processor = new PaymentProcessor(manager, {
    idempotencyStore,
    amountToleranceStroops: opts.toleranceStroops ?? 0n,
  });

  const webhookEvents: WebhookEvent[] = [];
  manager.onWebhook((e) => { webhookEvents.push(e); });

  const NOW = Date.now();
  const asset =
    (opts.assetCode ?? 'XLM') === 'USDC'
      ? { code: 'USDC' as const, issuer: USDC_ISSUER }
      : { code: 'XLM' as const };

  const session = await manager.createSession({
    asset,
    amount: opts.amount ?? '100.0000000',
    destination: MERCHANT,
    expiresAt: opts.expiresAt ?? NOW + 300_000,
    network: 'testnet',
    label: 'Pipeline Test Order',
  });

  const cursorStore = new InMemoryCursorStore();
  const listener = new HorizonPaymentListener(MERCHANT, {
    network: 'testnet',
    cursorStore,
  });

  await listener.start(async (evt: PaymentEvent) => {
    await processor.process(evt);
  });

  return { session, manager, processor, webhookEvents, listener, idempotencyStore };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Horizon payment pipeline — successful payment', () => {
  beforeEach(() => {
    streamFactory.current = buildStreamMock();
    jest.clearAllMocks();
  });

  it('marks session paid when a matching XLM payment arrives via SSE', async () => {
    const { session, manager, webhookEvents, listener } = await buildPipeline();

    await streamFactory.current.triggerMessage(makeHorizonRecord({
      transaction: async () => ({
        memo_type: 'id',
        memo: session.orderId.toString(),
        created_at: new Date().toISOString(),
      }),
    }));

    const updated = await manager.getSession(session.orderId);
    expect(updated!.status).toBe('paid');
    expect(webhookEvents).toHaveLength(1);
    expect(webhookEvents[0].type).toBe('payment.confirmed');
    expect((webhookEvents[0] as Extract<WebhookEvent, { type: 'payment.confirmed' }>).txHash)
      .toBe(TX_HASH);

    listener.stop();
  });

  it('marks session paid when a matching USDC payment arrives via SSE', async () => {
    const { session, manager, listener } = await buildPipeline({ assetCode: 'USDC' });

    await streamFactory.current.triggerMessage(makeHorizonRecord({
      asset_type: 'credit_alphanum4',
      asset_code: 'USDC',
      asset_issuer: USDC_ISSUER,
      transaction: async () => ({
        memo_type: 'id',
        memo: session.orderId.toString(),
        created_at: new Date().toISOString(),
      }),
    }));

    const updated = await manager.getSession(session.orderId);
    expect(updated!.status).toBe('paid');

    listener.stop();
  });

  it('accepts payment within amountToleranceStroops', async () => {
    const { session, manager, listener } = await buildPipeline({
      amount: '100.0000000',
      toleranceStroops: 5n, // 5 stroops tolerance
    });

    // Send 3 stroops short of 100 XLM
    await streamFactory.current.triggerMessage(makeHorizonRecord({
      amount: '99.9999997', // 3 stroops short
      transaction: async () => ({
        memo_type: 'id',
        memo: session.orderId.toString(),
        created_at: new Date().toISOString(),
      }),
    }));

    const updated = await manager.getSession(session.orderId);
    expect(updated!.status).toBe('paid');

    listener.stop();
  });

  it('does not double-confirm on duplicate SSE events', async () => {
    const { session, manager, webhookEvents, listener } = await buildPipeline();

    const record = makeHorizonRecord({
      transaction: async () => ({
        memo_type: 'id',
        memo: session.orderId.toString(),
        created_at: new Date().toISOString(),
      }),
    });

    await streamFactory.current.triggerMessage(record);
    await streamFactory.current.triggerMessage(record); // duplicate

    expect(webhookEvents).toHaveLength(1);
    const updated = await manager.getSession(session.orderId);
    expect(updated!.status).toBe('paid');

    listener.stop();
  });

  it('confirms payment when session is in submitting state (in-browser path)', async () => {
    const { session, manager, store } = (() => {
      // need access to internal store to set status manually
      const s = new InMemorySessionStore();
      const mgr = new SessionManager(s);
      return { session: null as unknown, manager: mgr, store: s };
    })();

    // Re-build with access to store
    const sessionStore = new InMemorySessionStore();
    const idempotencyStore = new InMemoryIdempotencyStore();
    const mgr = new SessionManager(sessionStore);
    const processor = new PaymentProcessor(mgr, { idempotencyStore });
    const webhookEvents: WebhookEvent[] = [];
    mgr.onWebhook((e) => { webhookEvents.push(e); });

    const NOW = Date.now();
    const sess = await mgr.createSession({
      asset: { code: 'XLM' },
      amount: '100.0000000',
      destination: MERCHANT,
      expiresAt: NOW + 300_000,
      network: 'testnet',
    });

    // Simulate the in-browser path: session moves to 'submitting' before
    // Horizon broadcast, and the SSE confirmation arrives afterwards.
    await sessionStore.updateStatus(sess.orderId, 'submitting');

    const listener = new HorizonPaymentListener(MERCHANT, { network: 'testnet' });
    await listener.start(async (evt: PaymentEvent) => { await processor.process(evt); });

    await streamFactory.current.triggerMessage(makeHorizonRecord({
      transaction: async () => ({
        memo_type: 'id',
        memo: sess.orderId.toString(),
        created_at: new Date().toISOString(),
      }),
    }));

    const updated = await mgr.getSession(sess.orderId);
    expect(updated!.status).toBe('paid');
    expect(webhookEvents[0].type).toBe('payment.confirmed');

    listener.stop();
  });
});

describe('Horizon payment pipeline — flagged payments', () => {
  beforeEach(() => {
    streamFactory.current = buildStreamMock();
    jest.clearAllMocks();
  });

  it('flags underpayment and fires payment.underpayment webhook', async () => {
    const { session, manager, webhookEvents, listener } = await buildPipeline({
      amount: '100.0000000',
    });

    await streamFactory.current.triggerMessage(makeHorizonRecord({
      amount: '50.0000000', // half the expected amount
      transaction: async () => ({
        memo_type: 'id',
        memo: session.orderId.toString(),
        created_at: new Date().toISOString(),
      }),
    }));

    const updated = await manager.getSession(session.orderId);
    expect(updated!.status).toBe('review_required');
    expect(webhookEvents[0].type).toBe('payment.underpayment');

    listener.stop();
  });

  it('flags wrong asset and fires payment.review_required webhook', async () => {
    // Session expects XLM, customer sends USDC
    const { session, manager, webhookEvents, listener } = await buildPipeline({
      assetCode: 'XLM',
    });

    await streamFactory.current.triggerMessage(makeHorizonRecord({
      asset_type: 'credit_alphanum4',
      asset_code: 'USDC',
      asset_issuer: USDC_ISSUER,
      transaction: async () => ({
        memo_type: 'id',
        memo: session.orderId.toString(),
        created_at: new Date().toISOString(),
      }),
    }));

    const updated = await manager.getSession(session.orderId);
    expect(updated!.status).toBe('review_required');
    expect(webhookEvents[0].type).toBe('payment.review_required');

    listener.stop();
  });

  it('flags expired-quote payment and fires payment.review_required webhook', async () => {
    const { session, manager, webhookEvents, listener } = await buildPipeline({
      expiresAt: Date.now() - 60_000, // already expired
    });

    await streamFactory.current.triggerMessage(makeHorizonRecord({
      transaction: async () => ({
        memo_type: 'id',
        memo: session.orderId.toString(),
        created_at: new Date().toISOString(),
      }),
    }));

    const updated = await manager.getSession(session.orderId);
    expect(updated!.status).toBe('review_required');
    // expired quote fires 'payment.review_required'
    expect(webhookEvents[0].type).toBe('payment.review_required');

    listener.stop();
  });

  it('ignores events with wrong MEMO_ID (not our session)', async () => {
    const { session, manager, webhookEvents, listener } = await buildPipeline();

    await streamFactory.current.triggerMessage(makeHorizonRecord({
      transaction: async () => ({
        memo_type: 'id',
        memo: '999999', // wrong orderId
        created_at: new Date().toISOString(),
      }),
    }));

    const updated = await manager.getSession(session.orderId);
    expect(updated!.status).toBe('pending'); // unchanged
    expect(webhookEvents).toHaveLength(0);

    listener.stop();
  });

  it('ignores events with no memo', async () => {
    const { session, manager, webhookEvents, listener } = await buildPipeline();

    await streamFactory.current.triggerMessage(makeHorizonRecord({
      transaction: async () => ({
        memo_type: undefined,
        memo: undefined,
        created_at: new Date().toISOString(),
      }),
    }));

    const updated = await manager.getSession(session.orderId);
    expect(updated!.status).toBe('pending');
    expect(webhookEvents).toHaveLength(0);

    listener.stop();
  });

  it('does not re-process a session already in paid state', async () => {
    const { session, manager, webhookEvents, listener } = await buildPipeline();

    const record = makeHorizonRecord({
      transaction: async () => ({
        memo_type: 'id',
        memo: session.orderId.toString(),
        created_at: new Date().toISOString(),
      }),
    });

    // First event — marks session paid
    await streamFactory.current.triggerMessage(record);
    expect((await manager.getSession(session.orderId))!.status).toBe('paid');

    // Second event with a different txHash — session is already paid, should be ignored
    await streamFactory.current.triggerMessage({ ...record, transaction_hash: 'new-hash' });

    expect(webhookEvents).toHaveLength(1); // only the first confirmation
    listener.stop();
  });
});

describe('Horizon payment pipeline — overpayment', () => {
  beforeEach(() => {
    streamFactory.current = buildStreamMock();
    jest.clearAllMocks();
  });

  it('accepts overpayment (more XLM than quoted)', async () => {
    const { session, manager, webhookEvents, listener } = await buildPipeline({
      amount: '100.0000000',
    });

    await streamFactory.current.triggerMessage(makeHorizonRecord({
      amount: '150.0000000', // 50% over
      transaction: async () => ({
        memo_type: 'id',
        memo: session.orderId.toString(),
        created_at: new Date().toISOString(),
      }),
    }));

    const updated = await manager.getSession(session.orderId);
    expect(updated!.status).toBe('paid');
    expect(webhookEvents[0].type).toBe('payment.confirmed');

    listener.stop();
  });
});
