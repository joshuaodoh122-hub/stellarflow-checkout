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
 * Cursor persistence:
 *   - On every incoming message the listener writes the paging_token to the
 *     CursorStore so a restart resumes from where it left off rather than
 *     replaying from 'now' (which would silently miss events that landed
 *     while the server was down).
 *   - The default InMemoryCursorStore keeps the cursor in process memory
 *     only — useful for tests and single-process deployments that don't
 *     need cross-restart durability.
 *   - FileCursorStore persists the cursor to a local file. Pass one to
 *     HorizonPaymentListener when you need durability across restarts.
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

import fs from 'fs';
import path from 'path';
import { Horizon } from 'stellar-sdk';
import type { PaymentEvent, Asset, StellarNetwork } from './types';
import { HORIZON_URLS } from './types';

export type PaymentEventHandler = (event: PaymentEvent) => void | Promise<void>;
export type ErrorHandler = (err: Error) => void;

// ─── CursorStore ──────────────────────────────────────────────────────────────

/**
 * Stores and retrieves the Horizon paging_token (cursor) so the listener can
 * resume from the correct position after a restart.
 *
 * Implementations must be safe to call concurrently (Node's event loop makes
 * this trivial for the in-memory and file variants — writes are synchronous or
 * awaited one at a time in the message handler).
 */
export interface CursorStore {
  /** Return the last saved cursor, or null if none has been saved yet. */
  load(): Promise<string | null>;
  /** Persist the cursor returned from the most recent Horizon message. */
  save(cursor: string): Promise<void>;
}

/**
 * In-memory cursor store. The cursor is lost when the process exits.
 * Useful for tests and short-lived scripts where cross-restart durability
 * is not needed.
 */
export class InMemoryCursorStore implements CursorStore {
  private cursor: string | null = null;

  async load(): Promise<string | null> {
    return this.cursor;
  }

  async save(cursor: string): Promise<void> {
    this.cursor = cursor;
  }
}

/**
 * File-backed cursor store. Writes the cursor as a plain UTF-8 string to
 * `filePath` on every Horizon message so a restart can resume from the
 * last seen paging_token.
 *
 * The write is synchronous (writeFileSync) to ensure the cursor is flushed
 * before the process can be killed between the message handler returning and
 * a subsequent async write completing. The file is small (< 30 bytes), so
 * the sync write does not block the event loop in any meaningful way.
 *
 * The directory containing `filePath` must already exist.
 */
export class FileCursorStore implements CursorStore {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
  }

  async load(): Promise<string | null> {
    try {
      const cursor = fs.readFileSync(this.filePath, 'utf8').trim();
      return cursor.length > 0 ? cursor : null;
    } catch (err: unknown) {
      // ENOENT means no cursor has been saved yet — start fresh
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async save(cursor: string): Promise<void> {
    fs.writeFileSync(this.filePath, cursor, 'utf8');
  }
}

export interface HorizonListenerOptions {
  network: StellarNetwork;
  /**
   * Starting cursor used only when no saved cursor is found in the store.
   * 'now' = only new txs; '0' = full history replay. Default: 'now'.
   */
  cursor?: string;
  /** Base reconnect delay in ms. Default: 1000 */
  reconnectBaseMs?: number;
  /** Max reconnect delay in ms. Default: 30000 */
  reconnectMaxMs?: number;
  /**
   * Cursor store for persisting the Horizon paging_token across restarts.
   * Defaults to InMemoryCursorStore (no cross-restart durability).
   * Pass a FileCursorStore (or your own implementation) to survive restarts.
   */
  cursorStore?: CursorStore;
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
      cursorStore: opts.cursorStore ?? new InMemoryCursorStore(),
    };
    this.server = new Horizon.Server(HORIZON_URLS[opts.network]);
  }

  /**
   * Start listening. Calls onPayment for each incoming payment event.
   * Automatically reconnects on error with exponential backoff.
   *
   * On startup the listener checks the CursorStore for a previously saved
   * cursor and resumes from that position. If none is found it falls back to
   * the `cursor` option ('now' by default).
   */
  async start(onPayment: PaymentEventHandler, onError?: ErrorHandler): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Restore the last saved cursor so we resume from where we left off.
    // Falls back to opts.cursor ('now' by default) if no cursor is stored yet.
    const savedCursor = await this.opts.cursorStore.load();
    const startCursor = savedCursor ?? this.opts.cursor;

    this.subscribe(startCursor, onPayment, onError, 0);
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
    startCursor: string,
    onPayment: PaymentEventHandler,
    onError: ErrorHandler | undefined,
    retryCount: number,
  ): void {
    if (!this.running) return;

    let cursor = startCursor;

    // The SDK types stream()'s onmessage as receiving CollectionPage<T>, but at
    // runtime it delivers individual OperationRecord objects. We cast via unknown.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stopStream = (this.server.payments() as any)
      .forAccount(this.merchantAddress)
      .cursor(cursor)
      .stream({
        onmessage: async (record: unknown) => {
          const rec = record as { paging_token?: string };
          if (rec.paging_token) {
            cursor = rec.paging_token;
            // Persist the cursor so a restart resumes from this position.
            // We fire-and-forget but catch so a store error never crashes the handler.
            this.opts.cursorStore.save(cursor).catch((err: unknown) => {
              console.error('[horizon-listener] cursor save error:', err);
            });
          }

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
          // On reconnect, resume from the last cursor we successfully processed
          // (persisted in the store) rather than opts.cursor.
          this.opts.cursorStore.load()
            .then((saved) => {
              const resumeCursor = saved ?? this.opts.cursor;
              setTimeout(() => this.subscribe(resumeCursor, onPayment, onError, retryCount + 1), delay);
            })
            .catch(() => {
              setTimeout(() => this.subscribe(cursor, onPayment, onError, retryCount + 1), delay);
            });
        },
      });

    this.stopFn = stopStream;
  }
}
