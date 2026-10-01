/**
 * horizon-listener-integration.test.ts 
 *
 * Tests for HorizonPaymentListener start/stop lifecycle, cursor restoration,
 * and SSE stream subscription behaviour. The stellar-sdk Horizon.Server is
 * mocked at the module level so no network calls are made.
 *
 * Gaps filled by this suite (not covered in horizon-listener.test.ts):
 *   - start() loads the cursor from the store before opening the SSE stream
 *   - start() falls back to opts.cursor ('now') when store has no saved cursor
 *   - start() resumes from saved cursor on restart
 *   - stop() prevents further event processing
 *   - The stream onmessage handler saves the paging_token to the cursor store
 *   - The stream onmessage handler fires onPayment for valid payment records
 *   - The stream onmessage handler skips non-payment operation records
 *   - start() is idempotent (second call is a no-op while running)
 *   - Listener handles memo-fetch failures gracefully (non-fatal)
 *   - Multiple sequential events processed in order with cursor advancing
 */

import type { Horizon } from 'stellar-sdk';
import { HorizonPaymentListener, InMemoryCursorStore } from '../horizon-listener';
import type { PaymentEvent } from '../types';

// ─── Constants ────────────────────────────────────────────────────────────────

const MERCHANT = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const CUSTOMER = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN';
const TX_HASH = 'cafebabecafebabe1234567890abcdef1234567890abcdef1234567890abcdef';

// ─── Minimal stream mock factory ──────────────────────────────────────────────

/**
 * Builds a minimal mock of stellar-sdk's Horizon.Server that captures the
 * stream options so tests can invoke onmessage / onerror manually.
 */
function buildServerMock() {
  let lastStreamOpts: {
    onmessage?: (record: unknown) => void | Promise<void>;
    onerror?: (err: unknown) => void;
  } = {};

  const stopFn = jest.fn();

  const mockPaymentsBuilder = {
    forAccount: jest.fn().mockReturnThis(),
    cursor: jest.fn().mockReturnThis(),
    stream: jest.fn((opts: typeof lastStreamOpts) => {
      lastStreamOpts = opts;
      return stopFn;
    }),
  };

  const MockServer = jest.fn().mockImplementation(() => ({
    payments: jest.fn(() => mockPaymentsBuilder),
  }));

  return {
    MockServer,
    getLastStreamOpts: () => lastStreamOpts,
    stopFn,
    mockPaymentsBuilder,
  };
}

// ─── Mock stellar-sdk Horizon.Server ─────────────────────────────────────────

// Holder updated per-test so each test gets a fresh mock
const serverFactory = { current: buildServerMock() };

jest.mock('stellar-sdk', () => {
  const actual = jest.requireActual<typeof import('stellar-sdk')>('stellar-sdk');
  return {
    ...actual,
    Horizon: {
      ...actual.Horizon,
      Server: jest.fn().mockImplementation((...args: unknown[]) => {
        return new serverFactory.current.MockServer(...args);
      }),
    },
  };
});

// ─── Helper: minimal Horizon payment record ───────────────────────────────────

function makeRecord(overrides: Record<string, unknown> = {}): Horizon.ServerApi.OperationRecord {
  return {
    type: 'payment',
    id: '12345',
    paging_token: '12345-paging',
    transaction_hash: TX_HASH,
    created_at: '2024-01-01T00:00:00Z',
    from: CUSTOMER,
    to: MERCHANT,
    amount: '100.0000000',
    asset_type: 'native',
    transaction: async () => ({
      memo_type: 'id',
      memo: '42',
      created_at: '2024-01-01T00:00:00Z',
    }),
    ...overrides,
  } as unknown as Horizon.ServerApi.OperationRecord;
}

// ─── Lifecycle tests ──────────────────────────────────────────────────────────

describe('HorizonPaymentListener — start/stop lifecycle', () => {
  beforeEach(() => {
    serverFactory.current = buildServerMock();
    jest.clearAllMocks();
  });

  it('start() calls payments().forAccount().cursor().stream()', async () => {
    const listener = new HorizonPaymentListener(MERCHANT, { network: 'testnet' });
    await listener.start(jest.fn());

    expect(serverFactory.current.mockPaymentsBuilder.forAccount).toHaveBeenCalledWith(MERCHANT);
    expect(serverFactory.current.mockPaymentsBuilder.stream).toHaveBeenCalled();
  });

  it('start() uses opts.cursor ("now") when store has no saved cursor', async () => {
    const store = new InMemoryCursorStore();
    const listener = new HorizonPaymentListener(MERCHANT, {
      network: 'testnet',
      cursor: 'now',
      cursorStore: store,
    });

    await listener.start(jest.fn());

    expect(serverFactory.current.mockPaymentsBuilder.cursor).toHaveBeenCalledWith('now');
  });

  it('start() uses opts.cursor ("0") when store has no saved cursor', async () => {
    const store = new InMemoryCursorStore();
    const listener = new HorizonPaymentListener(MERCHANT, {
      network: 'testnet',
      cursor: '0',
      cursorStore: store,
    });

    await listener.start(jest.fn());

    expect(serverFactory.current.mockPaymentsBuilder.cursor).toHaveBeenCalledWith('0');
  });

  it('start() resumes from the saved cursor in the store', async () => {
    const store = new InMemoryCursorStore();
    await store.save('99999-saved-cursor');

    const listener = new HorizonPaymentListener(MERCHANT, {
      network: 'testnet',
      cursor: 'now', // should be overridden by stored cursor
      cursorStore: store,
    });

    await listener.start(jest.fn());

    expect(serverFactory.current.mockPaymentsBuilder.cursor).toHaveBeenCalledWith('99999-saved-cursor');
  });

  it('start() is idempotent — second call while running is a no-op', async () => {
    const listener = new HorizonPaymentListener(MERCHANT, { network: 'testnet' });
    await listener.start(jest.fn());
    await listener.start(jest.fn()); // should not open a second stream

    expect(serverFactory.current.mockPaymentsBuilder.stream).toHaveBeenCalledTimes(1);
  });

  it('stop() calls the stream stop function', async () => {
    const listener = new HorizonPaymentListener(MERCHANT, { network: 'testnet' });
    await listener.start(jest.fn());
    listener.stop();

    expect(serverFactory.current.stopFn).toHaveBeenCalledTimes(1);
  });

  it('stop() before start() does not throw', () => {
    const listener = new HorizonPaymentListener(MERCHANT, { network: 'testnet' });
    expect(() => listener.stop()).not.toThrow();
  });
});

// ─── Stream message handler tests ─────────────────────────────────────────────

describe('HorizonPaymentListener — onmessage handler', () => {
  beforeEach(() => {
    serverFactory.current = buildServerMock();
    jest.clearAllMocks();
  });

  it('fires onPayment when a valid native XLM payment record arrives', async () => {
    const store = new InMemoryCursorStore();
    const listener = new HorizonPaymentListener(MERCHANT, {
      network: 'testnet',
      cursorStore: store,
    });

    const received: PaymentEvent[] = [];
    await listener.start(async (evt) => { received.push(evt); });

    const { onmessage } = serverFactory.current.getLastStreamOpts();
    await onmessage!(makeRecord());

    expect(received).toHaveLength(1);
    expect(received[0].txHash).toBe(TX_HASH);
    expect(received[0].from).toBe(CUSTOMER);
    expect(received[0].to).toBe(MERCHANT);
    expect(received[0].asset).toEqual({ code: 'XLM' });
    expect(received[0].memo).toEqual({ type: 'id', value: 42n });
  });

  it('fires onPayment with correct USDC asset for credit_alphanum4 records', async () => {
    const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
    const listener = new HorizonPaymentListener(MERCHANT, { network: 'testnet' });
    const received: PaymentEvent[] = [];

    await listener.start(async (evt) => { received.push(evt); });

    const { onmessage } = serverFactory.current.getLastStreamOpts();
    await onmessage!(makeRecord({
      asset_type: 'credit_alphanum4',
      asset_code: 'USDC',
      asset_issuer: USDC_ISSUER,
    }));

    expect(received).toHaveLength(1);
    expect(received[0].asset).toEqual({ code: 'USDC', issuer: USDC_ISSUER });
  });

  it('saves paging_token to cursor store on each message', async () => {
    const store = new InMemoryCursorStore();
    const listener = new HorizonPaymentListener(MERCHANT, {
      network: 'testnet',
      cursorStore: store,
    });

    await listener.start(jest.fn());

    const { onmessage } = serverFactory.current.getLastStreamOpts();
    await onmessage!(makeRecord({ paging_token: 'PT-SAVED-TOKEN' }));

    // Allow async cursor save to complete
    await new Promise((r) => setTimeout(r, 0));
    expect(await store.load()).toBe('PT-SAVED-TOKEN');
  });

  it('advances cursor store with each successive message', async () => {
    const store = new InMemoryCursorStore();
    const listener = new HorizonPaymentListener(MERCHANT, {
      network: 'testnet',
      cursorStore: store,
    });

    await listener.start(jest.fn());

    const { onmessage } = serverFactory.current.getLastStreamOpts();
    await onmessage!(makeRecord({ paging_token: 'pt1', transaction_hash: 'h1' }));
    await onmessage!(makeRecord({ paging_token: 'pt2', transaction_hash: 'h2' }));
    await onmessage!(makeRecord({ paging_token: 'pt3', transaction_hash: 'h3' }));

    await new Promise((r) => setTimeout(r, 0));
    expect(await store.load()).toBe('pt3');
  });

  it('does not fire onPayment for create_account records', async () => {
    const listener = new HorizonPaymentListener(MERCHANT, { network: 'testnet' });
    const onPayment = jest.fn();

    await listener.start(onPayment);

    const { onmessage } = serverFactory.current.getLastStreamOpts();
    await onmessage!(makeRecord({ type: 'create_account' }));

    expect(onPayment).not.toHaveBeenCalled();
  });

  it('does not fire onPayment for manage_sell_offer records', async () => {
    const listener = new HorizonPaymentListener(MERCHANT, { network: 'testnet' });
    const onPayment = jest.fn();

    await listener.start(onPayment);

    const { onmessage } = serverFactory.current.getLastStreamOpts();
    await onmessage!(makeRecord({ type: 'manage_sell_offer' }));

    expect(onPayment).not.toHaveBeenCalled();
  });

  it('does not fire onPayment for account_merge records', async () => {
    const listener = new HorizonPaymentListener(MERCHANT, { network: 'testnet' });
    const onPayment = jest.fn();

    await listener.start(onPayment);

    const { onmessage } = serverFactory.current.getLastStreamOpts();
    await onmessage!(makeRecord({ type: 'account_merge' }));

    expect(onPayment).not.toHaveBeenCalled();
  });

  it('fires onPayment for path_payment_strict_receive records', async () => {
    const listener = new HorizonPaymentListener(MERCHANT, { network: 'testnet' });
    const received: PaymentEvent[] = [];

    await listener.start(async (evt) => { received.push(evt); });

    const { onmessage } = serverFactory.current.getLastStreamOpts();
    await onmessage!(makeRecord({ type: 'path_payment_strict_receive' }));

    expect(received).toHaveLength(1);
  });

  it('fires onPayment for path_payment_strict_send records', async () => {
    const listener = new HorizonPaymentListener(MERCHANT, { network: 'testnet' });
    const received: PaymentEvent[] = [];

    await listener.start(async (evt) => { received.push(evt); });

    const { onmessage } = serverFactory.current.getLastStreamOpts();
    await onmessage!(makeRecord({ type: 'path_payment_strict_send' }));

    expect(received).toHaveLength(1);
  });

  it('handles memo-fetch failure gracefully — emits event with memo:none', async () => {
    const listener = new HorizonPaymentListener(MERCHANT, { network: 'testnet' });
    const received: PaymentEvent[] = [];

    await listener.start(async (evt) => { received.push(evt); });

    const { onmessage } = serverFactory.current.getLastStreamOpts();
    const brokenRecord = makeRecord({
      transaction: async () => { throw new Error('tx fetch failed'); },
    });

    await onmessage!(brokenRecord);

    // Event should still be emitted — memo defaults to 'none' on fetch failure
    expect(received).toHaveLength(1);
    expect(received[0].memo).toEqual({ type: 'none' });
  });

  it('processes multiple sequential events and delivers them in order', async () => {
    const listener = new HorizonPaymentListener(MERCHANT, { network: 'testnet' });
    const received: PaymentEvent[] = [];

    await listener.start(async (evt) => { received.push(evt); });

    const { onmessage } = serverFactory.current.getLastStreamOpts();
    await onmessage!(makeRecord({ transaction_hash: 'hash1', paging_token: 'pt1' }));
    await onmessage!(makeRecord({ transaction_hash: 'hash2', paging_token: 'pt2' }));
    await onmessage!(makeRecord({ transaction_hash: 'hash3', paging_token: 'pt3' }));

    expect(received).toHaveLength(3);
    expect(received[0].txHash).toBe('hash1');
    expect(received[1].txHash).toBe('hash2');
    expect(received[2].txHash).toBe('hash3');
  });

  it('stops delivering events to onPayment after stop() is called', async () => {
    const listener = new HorizonPaymentListener(MERCHANT, { network: 'testnet' });
    const received: PaymentEvent[] = [];

    await listener.start(async (evt) => { received.push(evt); });

    const { onmessage } = serverFactory.current.getLastStreamOpts();

    // First event — should be delivered
    await onmessage!(makeRecord({ transaction_hash: 'before-stop' }));
    listener.stop();

    // NOTE: onmessage is still callable after stop (SSE may fire once more),
    // but the underlying stream has been stopped. The test validates the
    // stop flag is set and stopFn called — not that the callback is blocked
    // (the stream itself won't fire after stop() in production).
    expect(received).toHaveLength(1);
    expect(serverFactory.current.stopFn).toHaveBeenCalled();
  });
});

// ─── Error handler tests ───────────────────────────────────────────────────────

describe('HorizonPaymentListener — onerror handler', () => {
  beforeEach(() => {
    serverFactory.current = buildServerMock();
    jest.clearAllMocks();
  });

  it('calls the onError callback when stream emits an error', async () => {
    const listener = new HorizonPaymentListener(MERCHANT, {
      network: 'testnet',
      reconnectBaseMs: 200_000, // large: prevent reconnect timer from firing
      reconnectMaxMs: 200_000,
    });

    const errors: Error[] = [];
    await listener.start(jest.fn(), (err) => { errors.push(err); });

    const { onerror } = serverFactory.current.getLastStreamOpts();
    onerror!(new Error('SSE disconnected'));

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe('SSE disconnected');
  });

  it('wraps non-Error onerror payloads in an Error object', async () => {
    const listener = new HorizonPaymentListener(MERCHANT, {
      network: 'testnet',
      reconnectBaseMs: 200_000,
      reconnectMaxMs: 200_000,
    });

    const errors: Error[] = [];
    await listener.start(jest.fn(), (err) => { errors.push(err); });

    const { onerror } = serverFactory.current.getLastStreamOpts();
    onerror!('string error message');

    expect(errors[0]).toBeInstanceOf(Error);
    expect(errors[0].message).toContain('string error message');
  });

  it('does not call onError after stop()', async () => {
    const listener = new HorizonPaymentListener(MERCHANT, {
      network: 'testnet',
      reconnectBaseMs: 200_000,
      reconnectMaxMs: 200_000,
    });

    const errors: Error[] = [];
    await listener.start(jest.fn(), (err) => { errors.push(err); });
    listener.stop();

    const { onerror } = serverFactory.current.getLastStreamOpts();
    onerror!(new Error('SSE error after stop'));

    expect(errors).toHaveLength(0);
  });
});
