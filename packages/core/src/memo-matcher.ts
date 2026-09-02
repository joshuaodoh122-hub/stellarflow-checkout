/**
 * memo-matcher.ts
 *
 * Core memo-matching and idempotency logic.
 *
 * This module is the reliability centrepiece of StellarFlow Checkout.
 * ALL payment confirmations flow through matchPayment(). The contract is:
 *
 *   1. If txHash has already been processed → return duplicate, do nothing.
 *   2. Record txHash in the dedup store BEFORE marking the order paid.
 *   3. Validate memo, asset, amount, and quote expiry in that order.
 *   4. Underpayment, wrong-asset, and expired-quote payments are NEVER
 *      auto-accepted — they are flagged as review_required.
 *
 * Persistence: the IdempotencyStore interface is intentionally minimal so
 * callers can back it with an in-memory Map (tests / demo) or a real DB
 * (production). The in-memory InMemoryIdempotencyStore is provided here
 * for convenience but is NOT safe across process restarts.
 */

import type { CheckoutSession, PaymentEvent, MatchResult, Asset } from './types';

// ─── Idempotency store ────────────────────────────────────────────────────────

/**
 * Minimal interface for the dedup store.
 * Back with Redis, Postgres, or SQLite for production use.
 */
export interface IdempotencyStore {
  /** Returns true if txHash was already recorded (i.e. is a duplicate). */
  has(txHash: string): Promise<boolean>;
  /** Record txHash as processed. Must be called BEFORE marking order paid. */
  record(txHash: string): Promise<void>;
}

/**
 * In-process, non-persistent idempotency store.
 * Safe for tests and the demo server. Not safe across restarts.
 */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly seen = new Set<string>();

  async has(txHash: string): Promise<boolean> {
    return this.seen.has(txHash);
  }

  async record(txHash: string): Promise<void> {
    this.seen.add(txHash);
  }

  /** Test helper: wipe state. */
  clear(): void {
    this.seen.clear();
  }

  /** Test helper: current size. */
  size(): number {
    return this.seen.size;
  }
}

// ─── Asset equality ───────────────────────────────────────────────────────────

/**
 * Compare two Asset values for equality.
 * XLM has no issuer; USDC requires matching both code and issuer.
 */
export function assetsEqual(a: Asset, b: Asset): boolean {
  if (a.code !== b.code) return false;
  if (a.code === 'USDC' && b.code === 'USDC') {
    return a.issuer.toLowerCase() === b.issuer.toLowerCase();
  }
  return true; // both XLM
}

// ─── Amount comparison ────────────────────────────────────────────────────────

/**
 * Compare two Stellar decimal amount strings.
 * Stellar uses up to 7 decimal places. We compare as fixed-point integers
 * at 7dp precision to avoid floating-point issues.
 *
 * Returns:
 *   negative  → a < b
 *   0         → a == b
 *   positive  → a > b
 */
export function compareAmounts(a: string, b: string): number {
  const toStroops = (s: string): bigint => {
    const [int = '0', dec = ''] = s.split('.');
    const padded = dec.padEnd(7, '0').slice(0, 7);
    return BigInt(int) * 10_000_000n + BigInt(padded);
  };
  const sa = toStroops(a);
  const sb = toStroops(b);
  if (sa < sb) return -1;
  if (sa > sb) return 1;
  return 0;
}

// ─── Core matcher ─────────────────────────────────────────────────────────────

export interface MatchPaymentOptions {
  /** Allow a small amount tolerance for rounding differences (in stroops, default 0). */
  amountToleranceStroops?: bigint;
}

/**
 * Match an incoming on-chain payment event against an open checkout session.
 *
 * This function enforces all the non-silent failure rules:
 *  - Expired quotes are flagged, not accepted.
 *  - Underpayments are flagged, not accepted.
 *  - Wrong-asset payments are flagged, not accepted.
 *
 * Idempotency is enforced: a duplicate txHash is silently ignored (returns
 * { matched: false, status: 'pending', reason: 'duplicate' }).
 *
 * @param session   The open checkout session to match against.
 * @param event     The incoming payment event from Horizon.
 * @param store     Idempotency store (must be shared across all calls in the process).
 * @param nowMs     Current time in milliseconds (injectable for testing).
 * @param opts      Optional tuning parameters.
 */
export async function matchPayment(
  session: CheckoutSession,
  event: PaymentEvent,
  store: IdempotencyStore,
  nowMs: number = Date.now(),
  opts: MatchPaymentOptions = {},
): Promise<MatchResult> {
  const { amountToleranceStroops = 0n } = opts;

  // ── 1. Idempotency check ────────────────────────────────────────────────────
  if (await store.has(event.txHash)) {
    return {
      matched: false,
      status: 'pending',
      reason: `duplicate tx: ${event.txHash}`,
    };
  }

  // ── 2. Destination check ────────────────────────────────────────────────────
  if (event.to.toLowerCase() !== session.destination.toLowerCase()) {
    // Not addressed to this merchant — not our payment at all, ignore.
    return {
      matched: false,
      status: 'pending',
      reason: `wrong destination: got ${event.to}, expected ${session.destination}`,
    };
  }

  // ── 3. Memo check ──────────────────────────────────────────────────────────
  if (event.memo.type !== 'id' || event.memo.value !== session.orderId) {
    const memoDesc =
      event.memo.type === 'id'
        ? `id:${event.memo.value}`
        : event.memo.type === 'hash'
          ? `hash:${event.memo.value}`
          : 'none';
    return {
      matched: false,
      status: 'pending',
      reason: `memo mismatch: got ${memoDesc}, expected id:${session.orderId}`,
    };
  }

  // ── 4. Record txHash BEFORE any state mutation ─────────────────────────────
  //   We record here so that even if the subsequent logic throws, the tx is
  //   marked processed and will not be retried in an inconsistent state.
  await store.record(event.txHash);

  // ── 5. Expired quote check ─────────────────────────────────────────────────
  if (nowMs > session.expiresAt) {
    return {
      matched: false,
      status: 'review_required',
      reason: `quote expired at ${new Date(session.expiresAt).toISOString()}, payment arrived at ${new Date(nowMs).toISOString()}`,
    };
  }

  // ── 6. Wrong-asset check ───────────────────────────────────────────────────
  if (!assetsEqual(event.asset, session.asset)) {
    return {
      matched: false,
      status: 'review_required',
      reason: `wrong asset: got ${JSON.stringify(event.asset)}, expected ${JSON.stringify(session.asset)}`,
    };
  }

  // ── 7. Underpayment check ──────────────────────────────────────────────────
  const cmp = compareAmounts(event.amount, session.amount);
  if (cmp < 0) {
    // Check if within tolerance
    const toStroops = (s: string): bigint => {
      const [int = '0', dec = ''] = s.split('.');
      const padded = dec.padEnd(7, '0').slice(0, 7);
      return BigInt(int) * 10_000_000n + BigInt(padded);
    };
    const shortfall = toStroops(session.amount) - toStroops(event.amount);
    if (shortfall > amountToleranceStroops) {
      return {
        matched: false,
        status: 'underpayment',
        reason: `underpayment: got ${event.amount}, expected ${session.amount} (shortfall ${shortfall} stroops)`,
      };
    }
  }

  // ── 8. All checks passed — payment is valid ────────────────────────────────
  return { matched: true, status: 'paid' };
}
