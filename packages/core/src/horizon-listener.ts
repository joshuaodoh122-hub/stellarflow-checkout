/**
 * horizon-listener.ts
 *
 * Horizon SSE-based payment listener.
 *
 * Subscribes to the Horizon payments stream for a given merchant address
 * and emits PaymentEvent objects. Handles reconnection with exponential
 * backoff automatically.
 *
 * Design notes:
 *   - Uses stellar-sdk's Server.payments().stream() which wraps Horizon's
 *     Server-Sent Events endpoint.
 *   - Deduplication of already-seen tx hashes happens in matchPayment()
 *     (memo-matcher.ts), NOT here. The listener's job is purely to parse
 *     and emit events.
 *
 * stellar-sdk v12 type notes:
 *   OperationResponseType enum values:
 *     payment                  → 'payment'
 *     pathPayment              → 'path_payment_strict_receive'
 *     pathPaymentStrictSend    → 'path_payment_strict_send'
 *
 *   For all payment types, `amount` is what the destination receives and
 *   `asset_type/code/issuer` refer to the destination asset.
 *
 *   The stream() callback receives individual operation records (not pages),
 *   but the SDK types it as CollectionPage<T> for the generic. We cast via
 *   unknown to work around this known SDK type inconsistency.
 */

import { Horizon } from 'stellar-sdk';
import type { PaymentEvent, Asset, StellarNetwork } from './types';
import { HORIZON_URLS } from './types';

export type PaymentEventHandler = (event: PaymentEvent) => void | Promise<void>;
export type ErrorHandler = (err: Error) => void;

export interface HorizonListenerOptions {
  network: StellarNetwork;
  /** Starting cursor. 'now' = only new txs; '0' = all history. Default: 'now' */
  cursor?: string;
  /** Base reconnect delay in ms. Default: 1000 */
  reconnectBaseMs?: number;
  /** Max reconnect delay in ms. Default: 30000 */
  reconnectMaxMs?: number;
}

// ─── Operation type strings ───────────────────────────────────────────────────

const PAYMENT_TYPES = new Set([
  'payment',
  'path_payment_strict_receive',
  'path_payment_strict_send',
]);

// ─── Asset parsing ────────────────────────────────────────────────────────────

function parseAsset(assetType: string, assetCode?: string, assetIssuer?: string): Asset | null {
  if (assetType === 'native') {
    return { code: 'XLM' };
  }
  if (assetType === 'credit_alphanum4' || assetType === 'credit_alphanum12') {
    if (!assetCode || !assetIssuer) return null;
    return { code: assetCode as 'USDC', issuer: assetIssuer };
  }
  return null;
}

// ─── Record shape (minimal, agnostic) ────────────────────────────────────────

interface PaymentLike {
  type: string;
  transaction_hash?: string;
  created_at?: string;
  paging_token?: string;
  from: string;
  to: string;
  amount: string;
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
}

/**
 * Parse a raw Horizon operations record into a PaymentEvent.
 * Returns null if the record is not a recognisable payment type.
 *
 * @param record     The Horizon operation record
 * @param memoType   Memo type from the transaction ('id' | 'hash' | undefined)
 * @param memoValue  Memo value string
 * @param createdAt  ISO timestamp (from transaction record if available)
 */
export function parseHorizonRecord(
  record: Horizon.ServerApi.OperationRecord,
  memoType?: string,
  memoValue?: string,
  createdAt?: string,
): PaymentEvent | null {
  // The record type field is typed as OperationResponseType enum but at runtime
  // it's a string value. We use a Set<string> comparison for safety.
  const raw = record as unknown as PaymentLike;

  if (!PAYMENT_TYPES.has(raw.type)) {
    return null;
  }

  const asset = parseAsset(raw.asset_type, raw.asset_code, raw.asset_issuer);
  if (!asset) return null;

  // Parse memo
  let memo: PaymentEvent['memo'] = { type: 'none' };
  if (memoType === 'id' && memoValue) {
    try {
      memo = { type: 'id', value: BigInt(memoValue) };
    } catch {
      memo = { type: 'none' };
    }
  } else if (memoType === 'hash' && memoValue) {
    memo = { type: 'hash', value: memoValue };
  }

  const txHash = raw.transaction_hash ?? '';
  const ts = createdAt ?? raw.created_at ?? new Date().toISOString();

  return {
    txHash,
    from: raw.from,
    to: raw.to,
    amount: raw.amount,
    asset,
    memo,
    createdAt: Math.floor(new Date(ts).getTime() / 1000),
  };
}

// ─── Listener class ───────────────────────────────────────────────────────────

export class HorizonPaymentListener {
  private readonly server: Horizon.Server;
  private readonly merchantAddress: string;
  private readonly opts: Required<HorizonListenerOptions>;

  private stopFn: (() => void) | null = null;
  private running = false;

  constructor(merchantAddress: string, opts: HorizonListenerOptions) {
    this.merchantAddress = merchantAddress;
    this.opts = {
      network: opts.network,
      cursor: opts.cursor ?? 'now',
      reconnectBaseMs: opts.reconnectBaseMs ?? 1000,
      reconnectMaxMs: opts.reconnectMaxMs ?? 30_000,
    };
    this.server = new Horizon.Server(HORIZON_URLS[opts.network]);
  }

  /**
   * Start listening. Calls onPayment for each incoming payment event.
   * Automatically reconnects on error with exponential backoff.
   */
  start(onPayment: PaymentEventHandler, onError?: ErrorHandler): void {
    if (this.running) return;
    this.running = true;
    this.subscribe(onPayment, onError, 0);
  }

  /** Stop the listener. */
  stop(): void {
    this.running = false;
    if (this.stopFn) {
      this.stopFn();
      this.stopFn = null;
    }
  }

  private subscribe(
    onPayment: PaymentEventHandler,
    onError: ErrorHandler | undefined,
    retryCount: number,
  ): void {
    if (!this.running) return;

    let cursor = this.opts.cursor;

    // The SDK types stream()'s onmessage as receiving CollectionPage<T>, but at
    // runtime it delivers individual OperationRecord objects. We cast via unknown.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stopStream = (this.server.payments() as any)
      .forAccount(this.merchantAddress)
      .cursor(cursor)
      .stream({
        onmessage: async (record: unknown) => {
          const rec = record as { paging_token?: string };
          cursor = rec.paging_token ?? cursor;

          // Fetch transaction details to get memo
          let memoType: string | undefined;
          let memoValue: string | undefined;
          let createdAt: string | undefined;

          try {
            const txFn = (record as {
              transaction?: () => Promise<{ memo_type?: string; memo?: string; created_at?: string }>
            }).transaction;
            if (txFn) {
              const tx = await txFn();
              memoType = tx.memo_type;
              memoValue = tx.memo;
              createdAt = tx.created_at;
            }
          } catch {
            // Memo fetch failure is non-fatal
          }

          const event = parseHorizonRecord(
            record as Horizon.ServerApi.OperationRecord,
            memoType,
            memoValue,
            createdAt,
          );
          if (event) {
            await Promise.resolve(onPayment(event));
          }
        },
        onerror: (err: unknown) => {
          if (!this.running) return;
          const error = err instanceof Error ? err : new Error(String(err));
          onError?.(error);

          const delay = Math.min(
            this.opts.reconnectBaseMs * Math.pow(2, retryCount),
            this.opts.reconnectMaxMs,
          );
          setTimeout(() => this.subscribe(onPayment, onError, retryCount + 1), delay);
        },
      });

    this.stopFn = stopStream;
  }
}
