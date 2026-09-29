/**
 * session-manager.test.ts
 *
 * Unit tests for SessionManager and InMemorySessionStore covering:
 *   - Session creation, retrieval, and listing
 *   - Status transitions (markPaid, markReviewRequired, updateStatus)
 *   - Webhook firing (confirmed, review_required, underpayment)
 *   - Multiple webhook handlers called in order
 *   - InMemorySessionStore isolation
 */

import { SessionManager, InMemorySessionStore } from '../session-manager';
import type { WebhookEvent } from '../session-manager';

const MERCHANT = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const NOW = Date.now();

function makeManager() {
  const store = new InMemorySessionStore();
  const manager = new SessionManager(store);
  const webhooks: WebhookEvent[] = [];
  manager.onWebhook((e) => { webhooks.push(e); });
  return { store, manager, webhooks };
}

async function createSession(manager: SessionManager, overrides: Partial<{
  amount: string;
  asset: { code: 'XLM' } | { code: 'USDC'; issuer: string };
  expiresAt: number;
}> = {}) {
  return manager.createSession({
    asset: overrides.asset ?? { code: 'XLM' },
    amount: overrides.amount ?? '100.0000000',
    destination: MERCHANT,
    expiresAt: overrides.expiresAt ?? NOW + 300_000,
    network: 'testnet',
  });
}

// ─── InMemorySessionStore ─────────────────────────────────────────────────────

describe('InMemorySessionStore', () => {
  it('returns null for an unknown orderId', async () => {
    const store = new InMemorySessionStore();
    expect(await store.get(999n)).toBeNull();
  });

  it('creates and retrieves a session', async () => {
    const store = new InMemorySessionStore();
    const session = {
      orderId: 1n,
      label: 'Test',
      asset: { code: 'XLM' as const },
      amount: '10.0',
      destination: MERCHANT,
      expiresAt: NOW + 300_000,
      status: 'pending' as const,
      network: 'testnet' as const,
    };
    await store.create(session);
    const retrieved = await store.get(1n);
    expect(retrieved).toEqual(session);
  });

  it('updateStatus changes the session status', async () => {
    const store = new InMemorySessionStore();
    const session = {
      orderId: 1n,
      label: 'Test',
      asset: { code: 'XLM' as const },
      amount: '10.0',
      destination: MERCHANT,
      expiresAt: NOW + 300_000,
      status: 'pending' as const,
      network: 'testnet' as const,
    };
    await store.create(session);
    await store.updateStatus(1n, 'paid');
    expect((await store.get(1n))!.status).toBe('paid');
  });

  it('updateStatus is a no-op for unknown orderId', async () => {
    const store = new InMemorySessionStore();
    // Should not throw
    await expect(store.updateStatus(999n, 'paid')).resolves.toBeUndefined();
  });

  it('list returns all created sessions', async () => {
    const store = new InMemorySessionStore();
    for (let i = 1n; i <= 3n; i++) {
      await store.create({
        orderId: i,
        label: `Order ${i}`,
        asset: { code: 'XLM' },
        amount: '10.0',
        destination: MERCHANT,
        expiresAt: NOW + 300_000,
        status: 'pending',
        network: 'testnet',
      });
    }
    expect(await store.list()).toHaveLength(3);
  });

  it('clear removes all sessions', async () => {
    const store = new InMemorySessionStore();
    await store.create({
      orderId: 1n, label: 'X', asset: { code: 'XLM' }, amount: '1',
      destination: MERCHANT, expiresAt: NOW, status: 'pending', network: 'testnet',
    });
    store.clear();
    expect(await store.list()).toHaveLength(0);
  });
});

// ─── SessionManager.createSession ────────────────────────────────────────────

describe('SessionManager.createSession', () => {
  it('assigns orderId starting from 1n', async () => {
    const { manager } = makeManager();
    const s = await createSession(manager);
    expect(s.orderId).toBe(1n);
  });

  it('assigns incrementing orderIds', async () => {
    const { manager } = makeManager();
    const s1 = await createSession(manager);
    const s2 = await createSession(manager);
    const s3 = await createSession(manager);
    expect(s1.orderId).toBe(1n);
    expect(s2.orderId).toBe(2n);
    expect(s3.orderId).toBe(3n);
  });

  it('sets status to pending', async () => {
    const { manager } = makeManager();
    const s = await createSession(manager);
    expect(s.status).toBe('pending');
  });

  it('uses a default label when none is provided', async () => {
    const { manager } = makeManager();
    const s = await createSession(manager);
    expect(s.label).toMatch(/Order #1/);
  });

  it('uses the provided label', async () => {
    const { manager } = makeManager();
    const s = await manager.createSession({
      asset: { code: 'XLM' },
      amount: '10.0',
      destination: MERCHANT,
      expiresAt: NOW + 300_000,
      network: 'testnet',
      label: 'Digital Comic Pack',
    });
    expect(s.label).toBe('Digital Comic Pack');
  });
});

// ─── SessionManager.getSession / listSessions ─────────────────────────────────

describe('SessionManager.getSession', () => {
  it('returns null for an unknown orderId', async () => {
    const { manager } = makeManager();
    expect(await manager.getSession(999n)).toBeNull();
  });

  it('returns the session after creation', async () => {
    const { manager } = makeManager();
    const created = await createSession(manager);
    const fetched = await manager.getSession(created.orderId);
    expect(fetched).toEqual(created);
  });
});

describe('SessionManager.listSessions', () => {
  it('returns empty array when no sessions', async () => {
    const { manager } = makeManager();
    expect(await manager.listSessions()).toEqual([]);
  });

  it('returns all created sessions', async () => {
    const { manager } = makeManager();
    await createSession(manager);
    await createSession(manager);
    expect(await manager.listSessions()).toHaveLength(2);
  });
});

// ─── SessionManager.markPaid ──────────────────────────────────────────────────

describe('SessionManager.markPaid', () => {
  it('transitions status to paid', async () => {
    const { manager } = makeManager();
    const s = await createSession(manager);
    await manager.markPaid(s.orderId, 'txhash123');
    const updated = await manager.getSession(s.orderId);
    expect(updated!.status).toBe('paid');
  });

  it('fires payment.confirmed webhook with correct txHash', async () => {
    const { manager, webhooks } = makeManager();
    const s = await createSession(manager);
    await manager.markPaid(s.orderId, 'txhash123');

    expect(webhooks).toHaveLength(1);
    expect(webhooks[0].type).toBe('payment.confirmed');
    expect((webhooks[0] as { txHash: string }).txHash).toBe('txhash123');
  });

  it('fires webhook with the correct session data', async () => {
    const { manager, webhooks } = makeManager();
    const s = await createSession(manager);
    await manager.markPaid(s.orderId, 'abc');

    const event = webhooks[0] as { session: typeof s };
    expect(event.session.orderId).toBe(s.orderId);
  });

  it('does not fire webhook for an unknown orderId', async () => {
    const { manager, webhooks } = makeManager();
    await manager.markPaid(999n, 'txhash');
    expect(webhooks).toHaveLength(0);
  });
});

// ─── SessionManager.markReviewRequired ───────────────────────────────────────

describe('SessionManager.markReviewRequired', () => {
  it('transitions status to review_required', async () => {
    const { manager } = makeManager();
    const s = await createSession(manager);
    await manager.markReviewRequired(s.orderId, 'txhash', 'wrong asset', 'wrong_asset');
    const updated = await manager.getSession(s.orderId);
    expect(updated!.status).toBe('review_required');
  });

  it('fires payment.underpayment webhook for underpayment status', async () => {
    const { manager, webhooks } = makeManager();
    const s = await createSession(manager);
    await manager.markReviewRequired(s.orderId, 'txhash', 'sent 50, expected 100', 'underpayment');
    expect(webhooks[0].type).toBe('payment.underpayment');
  });

  it('fires payment.review_required webhook for other review statuses', async () => {
    const { manager, webhooks } = makeManager();
    const s = await createSession(manager);
    await manager.markReviewRequired(s.orderId, 'txhash', 'wrong asset', 'wrong_asset');
    expect(webhooks[0].type).toBe('payment.review_required');
  });

  it('fires payment.review_required for expired status', async () => {
    const { manager, webhooks } = makeManager();
    const s = await createSession(manager);
    await manager.markReviewRequired(s.orderId, 'txhash', 'quote expired', 'expired');
    expect(webhooks[0].type).toBe('payment.review_required');
  });

  it('includes the reason in the webhook event', async () => {
    const { manager, webhooks } = makeManager();
    const s = await createSession(manager);
    await manager.markReviewRequired(s.orderId, 'txhash', 'underpaid by 10%', 'underpayment');
    expect((webhooks[0] as { reason: string }).reason).toBe('underpaid by 10%');
  });
});

// ─── Multiple webhook handlers ────────────────────────────────────────────────

describe('Multiple webhook handlers', () => {
  it('calls all registered handlers in order', async () => {
    const store = new InMemorySessionStore();
    const manager = new SessionManager(store);
    const order: number[] = [];

    manager.onWebhook(() => { order.push(1); });
    manager.onWebhook(() => { order.push(2); });
    manager.onWebhook(() => { order.push(3); });

    const s = await createSession(manager);
    await manager.markPaid(s.orderId, 'hash');

    expect(order).toEqual([1, 2, 3]);
  });

  it('awaits async handlers', async () => {
    const store = new InMemorySessionStore();
    const manager = new SessionManager(store);
    let resolved = false;

    manager.onWebhook(async () => {
      await new Promise((r) => setTimeout(r, 10));
      resolved = true;
    });

    const s = await createSession(manager);
    await manager.markPaid(s.orderId, 'hash');

    expect(resolved).toBe(true);
  });
});

// ─── SessionManager.updateStatus ─────────────────────────────────────────────

describe('SessionManager.updateStatus', () => {
  it('transitions to submitting', async () => {
    const { manager } = makeManager();
    const s = await createSession(manager);
    await manager.updateStatus(s.orderId, 'submitting');
    const updated = await manager.getSession(s.orderId);
    expect(updated!.status).toBe('submitting');
  });

  it('rolls back from submitting to pending', async () => {
    const { manager } = makeManager();
    const s = await createSession(manager);
    await manager.updateStatus(s.orderId, 'submitting');
    await manager.updateStatus(s.orderId, 'pending');
    const updated = await manager.getSession(s.orderId);
    expect(updated!.status).toBe('pending');
  });
});
