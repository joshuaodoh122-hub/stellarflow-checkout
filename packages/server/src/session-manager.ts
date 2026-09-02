/**
 * session-manager.ts
 *
 * Manages checkout sessions: creation, lookup, status updates.
 *
 * v1 storage: in-memory Map. This is intentional for the MVP —
 * the SessionStore interface makes it straightforward to swap in
 * a SQLite/Postgres/Redis store without changing any caller code.
 *
 * Review mechanism decision (v1): webhook callbacks.
 * Rationale: webhooks work for both self-hosted and SaaS storefronts,
 * require no persistent connection, and map directly onto the existing
 * patterns developers use with Stripe/PayPal. A dashboard view requires
 * a hosted frontend (out of scope for a widget library). Email requires
 * an email provider dependency. The webhook payload is documented in
 * ARCHITECTURE.md. In the demo, a simple console logger is used as the
 * webhook handler.
 */

import type {
  CheckoutSession,
  PaymentStatus,
  Asset,
  StellarNetwork,
} from '@stellarflow/core';

// ─── Store interface ──────────────────────────────────────────────────────────

export interface SessionStore {
  create(session: CheckoutSession): Promise<void>;
  get(orderId: bigint): Promise<CheckoutSession | null>;
  updateStatus(orderId: bigint, status: PaymentStatus): Promise<void>;
  list(): Promise<CheckoutSession[]>;
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<bigint, CheckoutSession>();

  async create(session: CheckoutSession): Promise<void> {
    this.sessions.set(session.orderId, { ...session });
  }

  async get(orderId: bigint): Promise<CheckoutSession | null> {
    return this.sessions.get(orderId) ?? null;
  }

  async updateStatus(orderId: bigint, status: PaymentStatus): Promise<void> {
    const session = this.sessions.get(orderId);
    if (session) {
      this.sessions.set(orderId, { ...session, status });
    }
  }

  async list(): Promise<CheckoutSession[]> {
    return Array.from(this.sessions.values());
  }

  clear(): void {
    this.sessions.clear();
  }
}

// ─── Webhook types ────────────────────────────────────────────────────────────

export type WebhookEvent =
  | { type: 'payment.confirmed'; session: CheckoutSession; txHash: string }
  | { type: 'payment.review_required'; session: CheckoutSession; txHash: string; reason: string }
  | { type: 'payment.underpayment'; session: CheckoutSession; txHash: string; reason: string }
  | { type: 'quote.expired'; session: CheckoutSession };

export type WebhookHandler = (event: WebhookEvent) => void | Promise<void>;

// ─── Session manager ──────────────────────────────────────────────────────────

export interface CreateSessionInput {
  asset: Asset;
  amount: string;
  destination: string;
  expiresAt: number;
  network: StellarNetwork;
  label?: string;
}

export class SessionManager {
  private readonly store: SessionStore;
  private readonly webhookHandlers: WebhookHandler[] = [];
  private orderIdCounter = 1n;

  constructor(store: SessionStore) {
    this.store = store;
  }

  /**
   * Register a webhook handler. Multiple handlers are called in order.
   */
  onWebhook(handler: WebhookHandler): void {
    this.webhookHandlers.push(handler);
  }

  /**
   * Create a new checkout session. Assigns a unique numeric orderId.
   */
  async createSession(input: CreateSessionInput): Promise<CheckoutSession> {
    const orderId = this.nextOrderId();
    const session: CheckoutSession = {
      orderId,
      label: input.label ?? `Order #${orderId}`,
      asset: input.asset,
      amount: input.amount,
      destination: input.destination,
      expiresAt: input.expiresAt,
      status: 'pending',
      network: input.network,
    };
    await this.store.create(session);
    return session;
  }

  async getSession(orderId: bigint): Promise<CheckoutSession | null> {
    return this.store.get(orderId);
  }

  async listSessions(): Promise<CheckoutSession[]> {
    return this.store.list();
  }

  /**
   * Update a session's status directly. Used by the submit endpoint to
   * transition to 'submitting' before calling Horizon, and to roll back to
   * 'pending' if Horizon rejects the transaction.
   */
  async updateStatus(orderId: bigint, status: PaymentStatus): Promise<void> {
    await this.store.updateStatus(orderId, status);
  }

  /**
   * Mark a session as paid and fire the payment.confirmed webhook.
   */
  async markPaid(orderId: bigint, txHash: string): Promise<void> {
    await this.store.updateStatus(orderId, 'paid');
    const session = await this.store.get(orderId);
    if (session) {
      await this.fireWebhook({ type: 'payment.confirmed', session, txHash });
    }
  }

  /**
   * Mark a session for manual review and fire the appropriate webhook.
   */
  async markReviewRequired(
    orderId: bigint,
    txHash: string,
    reason: string,
    status: 'review_required' | 'underpayment' | 'wrong_asset' | 'expired',
  ): Promise<void> {
    await this.store.updateStatus(orderId, 'review_required');
    const session = await this.store.get(orderId);
    if (session) {
      if (status === 'underpayment') {
        await this.fireWebhook({
          type: 'payment.underpayment',
          session,
          txHash,
          reason,
        });
      } else {
        await this.fireWebhook({
          type: 'payment.review_required',
          session,
          txHash,
          reason,
        });
      }
    }
  }

  private async fireWebhook(event: WebhookEvent): Promise<void> {
    for (const handler of this.webhookHandlers) {
      await Promise.resolve(handler(event));
    }
  }

  private nextOrderId(): bigint {
    return this.orderIdCounter++;
  }
}
