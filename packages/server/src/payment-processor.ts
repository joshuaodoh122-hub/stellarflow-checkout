/**
 * payment-processor.ts
 *
 * Orchestrates the flow: incoming PaymentEvent → memo match → session update → webhook.
 *
 * This is the "glue" layer between the Horizon listener and the session store.
 * It holds the IdempotencyStore and calls matchPayment() for each event.
 */

import {
  matchPayment,
  InMemoryIdempotencyStore,
  type IdempotencyStore,
  type PaymentEvent,
} from '@stellarflow/core';
import type { SessionManager } from './session-manager';

export interface PaymentProcessorOptions {
  /** Inject a custom idempotency store. Defaults to InMemoryIdempotencyStore. */
  idempotencyStore?: IdempotencyStore;
  /** Amount tolerance in stroops. Default: 0 */
  amountToleranceStroops?: bigint;
}

export class PaymentProcessor {
  private readonly sessionManager: SessionManager;
  private readonly store: IdempotencyStore;
  private readonly toleranceStroops: bigint;

  constructor(sessionManager: SessionManager, opts: PaymentProcessorOptions = {}) {
    this.sessionManager = sessionManager;
    this.store = opts.idempotencyStore ?? new InMemoryIdempotencyStore();
    this.toleranceStroops = opts.amountToleranceStroops ?? 0n;
  }

  /**
   * Process a single incoming PaymentEvent.
   * Looks up the session by memo ID, runs the matcher, and updates session status.
   *
   * If no session is found for the memo, the event is silently ignored —
   * this is expected for payments not addressed to any open session.
   */
  async process(event: PaymentEvent): Promise<void> {
    // Only process MEMO_ID events (our scheme)
    if (event.memo.type !== 'id') {
      return;
    }

    const session = await this.sessionManager.getSession(event.memo.value);
    if (!session) {
      // No open session for this memo — not our payment
      return;
    }

    // Only process pending sessions
    if (session.status !== 'pending') {
      return;
    }

    const result = await matchPayment(session, event, this.store, Date.now(), {
      amountToleranceStroops: this.toleranceStroops,
    });

    if (result.matched) {
      await this.sessionManager.markPaid(session.orderId, event.txHash);
    } else if (
      result.status === 'review_required' ||
      result.status === 'underpayment' ||
      result.status === 'wrong_asset'
    ) {
      await this.sessionManager.markReviewRequired(
        session.orderId,
        event.txHash,
        (result as { reason: string }).reason,
        result.status as 'review_required' | 'underpayment' | 'wrong_asset' | 'expired',
      );
    }
    // For 'pending' results (memo mismatch, duplicate, destination mismatch),
    // we do nothing — these are not errors, just not our payment.
  }
}
