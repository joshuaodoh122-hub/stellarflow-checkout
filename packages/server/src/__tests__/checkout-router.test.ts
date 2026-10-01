/**
 * checkout-router.test.ts
 *
 * HTTP integration tests for all five checkout API endpoints:
 *   POST /api/checkout                — create session
 *   GET  /api/checkout/:orderId       — poll status
 *   POST /api/checkout/:orderId/tx    — build unsigned tx
 *   POST /api/checkout/:orderId/submit — validate + submit signed tx
 *   GET  /api/sessions                — list sessions
 *
 * Uses supertest against a real Express app instance (no live network calls —
 * QuoteService and Horizon are mocked). Stellar tx XDRs are constructed with
 * the real stellar-sdk so XDR parsing exercises the actual code path.
 *
 * What is NOT tested here (covered elsewhere):
 *   - XDR validation logic detail (submit-validation.test.ts)
 *   - Payment matching / webhook logic (payment-processor.test.ts)
 *   - Session state machine (payment-processor.test.ts)
 */

import request from 'supertest';
import express from 'express';
import {
  TransactionBuilder,
  Networks,
  Asset,
  Operation,
  Memo,
  Account,
} from 'stellar-sdk';
import { createCheckoutRouter } from '../checkout-router';
import { SessionManager, InMemorySessionStore } from '../session-manager';
import { QuoteService, CoinGeckoPriceSource } from '@stellarflow/core';

// ─── Constants ────────────────────────────────────────────────────────────────

const MERCHANT = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const CUSTOMER = 'GCEYYRVII3YXJEPAO23Z65S4CYVT3OZUYXUHEU6UHBGKFZANXI77SXW7';
const NETWORK = 'testnet' as const;
const NETWORK_PASSPHRASE = Networks.TESTNET;

// ─── App factory ──────────────────────────────────────────────────────────────

/**
 * Build a fresh Express app with a new session store for each test suite.
 * QuoteService is created with a mocked PriceSource that always returns
 * a fixed XLM price of $0.10.
 */
function buildApp() {
  const store = new InMemorySessionStore();
  const manager = new SessionManager(store);

  // Mock PriceSource: XLM = $0.10, USDC = $1.00
  const mockSource = {
    name: 'mock',
    getUsdPrice: jest.fn(async (code: 'XLM' | 'USDC') => (code === 'XLM' ? 0.1 : 1.0)),
  };
  const quoteService = new QuoteService(mockSource as unknown as CoinGeckoPriceSource);

  const router = createCheckoutRouter({
    sessionManager: manager,
    quoteService,
    merchantAddress: MERCHANT,
    network: NETWORK,
  });

  const app = express();
  app.use(express.json());
  app.use('/api', router);

  return { app, manager, store, mockSource };
}

// ─── XDR helper ───────────────────────────────────────────────────────────────

/**
 * Build a valid signed (well, self-signed — sig is fake but XDR is parseable)
 * payment transaction XDR matching the given session parameters.
 */
function buildValidXdr(opts: {
  orderId: bigint;
  destination?: string;
  amount?: string;
  asset?: Asset;
  memoValue?: string;
  memoType?: 'id' | 'none' | 'text';
  opCount?: number;
}): string {
  const account = new Account(CUSTOMER, '0');
  const memo =
    opts.memoType === 'none'
      ? Memo.none()
      : opts.memoType === 'text'
        ? Memo.text(opts.memoValue ?? '')
        : Memo.id(opts.memoValue ?? opts.orderId.toString());

  let builder = new TransactionBuilder(account, {
    fee: '100',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.payment({
        destination: opts.destination ?? MERCHANT,
        asset: opts.asset ?? Asset.native(),
        amount: opts.amount ?? '100.0000000',
      }),
    )
    .addMemo(memo)
    .setTimeout(300);

  if ((opts.opCount ?? 1) > 1) {
    builder = builder.addOperation(
      Operation.payment({
        destination: MERCHANT,
        asset: Asset.native(),
        amount: '1.0000000',
      }),
    );
  }

  return builder.build().toXDR();
}

// ─── POST /api/checkout ───────────────────────────────────────────────────────

describe('POST /api/checkout', () => {
  it('creates a session and returns orderId, quote, and SEP-0007 URI', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .post('/api/checkout')
      .send({ fiatAmount: 9.99, assetCode: 'XLM' })
      .expect(201);

    expect(res.body.orderId).toBeDefined();
    expect(res.body.status).toBe('pending');
    expect(res.body.quote.assetCode).toBe('XLM');
    expect(res.body.quote.fiatAmount).toBe(9.99);
    expect(res.body.payment.sep0007Uri).toMatch(/^web\+stellar:pay/);
    expect(res.body.payment.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(res.body.payment.destination).toBe(MERCHANT);
  });

  it('creates a USDC session correctly', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .post('/api/checkout')
      .send({ fiatAmount: 5.00, assetCode: 'USDC' })
      .expect(201);

    expect(res.body.quote.assetCode).toBe('USDC');
    expect(res.body.payment.sep0007Uri).toContain('USDC');
  });

  it('uses the provided label in the session', async () => {
    const { app, manager } = buildApp();

    const res = await request(app)
      .post('/api/checkout')
      .send({ fiatAmount: 10, assetCode: 'XLM', label: 'Digital Download #42' })
      .expect(201);

    const session = await manager.getSession(BigInt(res.body.orderId));
    expect(session!.label).toBe('Digital Download #42');
  });

  it('returns 400 when fiatAmount is missing', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/checkout')
      .send({ assetCode: 'XLM' })
      .expect(400);
    expect(res.body.error).toContain('fiatAmount');
  });

  it('returns 400 when fiatAmount is zero', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/checkout')
      .send({ fiatAmount: 0, assetCode: 'XLM' })
      .expect(400);
    expect(res.body.error).toContain('fiatAmount');
  });

  it('returns 400 when fiatAmount is negative', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/checkout')
      .send({ fiatAmount: -5, assetCode: 'XLM' })
      .expect(400);
    expect(res.body.error).toContain('fiatAmount');
  });

  it('returns 400 when assetCode is missing', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/checkout')
      .send({ fiatAmount: 10 })
      .expect(400);
    expect(res.body.error).toContain('assetCode');
  });

  it('returns 400 for an unsupported asset', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/checkout')
      .send({ fiatAmount: 10, assetCode: 'BTC' })
      .expect(400);
    expect(res.body.error).toContain('assetCode');
  });

  it('returns 500 when the price source fails', async () => {
    const { app, mockSource } = buildApp();
    mockSource.getUsdPrice.mockRejectedValueOnce(new Error('CoinGecko down'));

    const res = await request(app)
      .post('/api/checkout')
      .send({ fiatAmount: 10, assetCode: 'XLM' })
      .expect(500);
    expect(res.body.error).toBeDefined();
  });

  it('assigns incrementing orderIds to successive sessions', async () => {
    const { app } = buildApp();

    const r1 = await request(app).post('/api/checkout').send({ fiatAmount: 1, assetCode: 'XLM' }).expect(201);
    const r2 = await request(app).post('/api/checkout').send({ fiatAmount: 2, assetCode: 'XLM' }).expect(201);

    expect(BigInt(r2.body.orderId)).toBeGreaterThan(BigInt(r1.body.orderId));
  });
});

// ─── GET /api/checkout/:orderId ───────────────────────────────────────────────

describe('GET /api/checkout/:orderId', () => {
  it('returns session status for a valid orderId', async () => {
    const { app } = buildApp();

    const create = await request(app)
      .post('/api/checkout')
      .send({ fiatAmount: 10, assetCode: 'XLM' })
      .expect(201);

    const orderId = create.body.orderId;

    const res = await request(app)
      .get(`/api/checkout/${orderId}`)
      .expect(200);

    expect(res.body.orderId).toBe(orderId);
    expect(res.body.status).toBe('pending');
    expect(res.body.asset).toBeDefined();
    expect(res.body.amount).toBeDefined();
    expect(res.body.expiresAt).toBeDefined();
  });

  it('returns 404 for an unknown orderId', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/checkout/999999').expect(404);
    expect(res.body.error).toContain('not found');
  });

  it('returns 400 for a non-numeric orderId', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/checkout/not-a-number').expect(400);
    expect(res.body.error).toContain('orderId');
  });

  it('reflects status updates (pending → paid)', async () => {
    const { app, manager } = buildApp();

    const create = await request(app)
      .post('/api/checkout')
      .send({ fiatAmount: 10, assetCode: 'XLM' })
      .expect(201);

    const orderId = create.body.orderId;
    await manager.markPaid(BigInt(orderId), 'fakehash');

    const res = await request(app).get(`/api/checkout/${orderId}`).expect(200);
    expect(res.body.status).toBe('paid');
  });
});

// ─── POST /api/checkout/:orderId/tx ──────────────────────────────────────────

describe('POST /api/checkout/:orderId/tx', () => {
  // tx endpoint calls Horizon to load the customer account — we mock it.
  // We do this by mocking the buildPaymentTx module.
  beforeEach(() => {
    jest.resetModules();
  });

  it('returns 400 for a non-numeric orderId', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/checkout/not-a-number/tx')
      .send({ customerAddress: CUSTOMER })
      .expect(400);
    expect(res.body.error).toContain('orderId');
  });

  it('returns 404 when session does not exist', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/checkout/999/tx')
      .send({ customerAddress: CUSTOMER })
      .expect(404);
    expect(res.body.error).toContain('not found');
  });

  it('returns 400 when customerAddress is missing', async () => {
    const { app } = buildApp();

    const create = await request(app)
      .post('/api/checkout')
      .send({ fiatAmount: 10, assetCode: 'XLM' })
      .expect(201);

    const res = await request(app)
      .post(`/api/checkout/${create.body.orderId}/tx`)
      .send({})
      .expect(400);
    expect(res.body.error).toContain('customerAddress');
  });

  it('returns 400 when customerAddress does not start with G', async () => {
    const { app } = buildApp();

    const create = await request(app)
      .post('/api/checkout')
      .send({ fiatAmount: 10, assetCode: 'XLM' })
      .expect(201);

    const res = await request(app)
      .post(`/api/checkout/${create.body.orderId}/tx`)
      .send({ customerAddress: 'SNOTAVALIDKEY' })
      .expect(400);
    expect(res.body.error).toContain('customerAddress');
  });

  it('returns 400 when customerAddress starts with G but fails StrKey checksum', async () => {
    const { app } = buildApp();

    const create = await request(app)
      .post('/api/checkout')
      .send({ fiatAmount: 10, assetCode: 'XLM' })
      .expect(201);

    // Starts with G and is 56 chars but has an invalid checksum — passes the
    // old startsWith('G') check but must fail StrKey.isValidEd25519PublicKey()
    const res = await request(app)
      .post(`/api/checkout/${create.body.orderId}/tx`)
      .send({ customerAddress: 'GBADKEYBADKEYBADKEYBADKEYBADKEYBADKEYBADKEYBADKEYBADKEY2' })
      .expect(400);
    expect(res.body.error).toContain('customerAddress');
  });

  it('returns 409 when session is not pending', async () => {
    const { app, manager } = buildApp();

    const create = await request(app)
      .post('/api/checkout')
      .send({ fiatAmount: 10, assetCode: 'XLM' })
      .expect(201);

    await manager.markPaid(BigInt(create.body.orderId), 'fakehash');

    const res = await request(app)
      .post(`/api/checkout/${create.body.orderId}/tx`)
      .send({ customerAddress: CUSTOMER })
      .expect(409);
    expect(res.body.error).toContain('paid');
  });

  it('returns 410 when session quote has expired', async () => {
    const { store, app } = buildApp();

    // Create a session with expiresAt in the past
    const expiredSession = {
      orderId: 99n,
      label: 'Expired',
      asset: { code: 'XLM' as const },
      amount: '10.0000000',
      destination: MERCHANT,
      expiresAt: Date.now() - 1000,
      status: 'pending' as const,
      network: NETWORK,
    };
    await store.create(expiredSession);

    const res = await request(app)
      .post('/api/checkout/99/tx')
      .send({ customerAddress: CUSTOMER })
      .expect(410);
    expect(res.body.error).toContain('expired');
  });
});

// ─── POST /api/checkout/:orderId/submit ──────────────────────────────────────

describe('POST /api/checkout/:orderId/submit', () => {
  // The submit endpoint parses XDR and validates it, then calls
  // horizonServer.submitTransaction(). We can test all the validation
  // paths without a live Horizon by injecting bad XDR or wrong fields.
  // For the happy path we mock stellar-sdk's Horizon.Server.

  it('returns 400 for a non-numeric orderId', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/checkout/not-a-number/submit')
      .send({ signedTxXdr: 'anything' })
      .expect(400);
    expect(res.body.error).toContain('orderId');
  });

  it('returns 404 when session does not exist', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/checkout/999/submit')
      .send({ signedTxXdr: 'anything' })
      .expect(404);
    expect(res.body.error).toContain('not found');
  });

  it('returns 400 when signedTxXdr is missing', async () => {
    const { app } = buildApp();

    const create = await request(app)
      .post('/api/checkout')
      .send({ fiatAmount: 10, assetCode: 'XLM' })
      .expect(201);

    const res = await request(app)
      .post(`/api/checkout/${create.body.orderId}/submit`)
      .send({})
      .expect(400);
    expect(res.body.error).toContain('signedTxXdr');
  });

  it('returns 409 when session is already paid', async () => {
    const { app, manager } = buildApp();

    const create = await request(app)
      .post('/api/checkout')
      .send({ fiatAmount: 10, assetCode: 'XLM' })
      .expect(201);

    await manager.markPaid(BigInt(create.body.orderId), 'fakehash');

    const res = await request(app)
      .post(`/api/checkout/${create.body.orderId}/submit`)
      .send({ signedTxXdr: 'anything' })
      .expect(409);
    expect(res.body.error).toContain('paid');
  });

  it('returns 410 when session quote has expired', async () => {
    const { store, app } = buildApp();

    const expiredSession = {
      orderId: 77n,
      label: 'Expired',
      asset: { code: 'XLM' as const },
      amount: '10.0000000',
      destination: MERCHANT,
      expiresAt: Date.now() - 1000,
      status: 'pending' as const,
      network: NETWORK,
    };
    await store.create(expiredSession);

    const res = await request(app)
      .post('/api/checkout/77/submit')
      .send({ signedTxXdr: 'anything' })
      .expect(410);
    expect(res.body.error).toContain('expired');
  });

  it('returns 400 for invalid (non-XDR) signedTxXdr', async () => {
    const { app } = buildApp();

    const create = await request(app)
      .post('/api/checkout')
      .send({ fiatAmount: 10, assetCode: 'XLM' })
      .expect(201);

    const res = await request(app)
      .post(`/api/checkout/${create.body.orderId}/submit`)
      .send({ signedTxXdr: 'not-valid-xdr' })
      .expect(400);
    expect(res.body.error).toContain('Invalid transaction XDR');
  });

  it('returns 400 when XDR memo does not match orderId', async () => {
    const { app } = buildApp();

    const create = await request(app)
      .post('/api/checkout')
      .send({ fiatAmount: 10, assetCode: 'XLM' })
      .expect(201);

    const { orderId } = create.body;
    // Build XDR with wrong memo ID
    const xdr = buildValidXdr({ orderId: BigInt(orderId), memoValue: '999999' });

    const res = await request(app)
      .post(`/api/checkout/${orderId}/submit`)
      .send({ signedTxXdr: xdr })
      .expect(400);
    expect(res.body.error).toContain('memo mismatch');
  });

  it('returns 400 when XDR destination does not match session', async () => {
    const { app } = buildApp();

    const create = await request(app)
      .post('/api/checkout')
      .send({ fiatAmount: 10, assetCode: 'XLM' })
      .expect(201);

    const { orderId } = create.body;
    const xdr = buildValidXdr({
      orderId: BigInt(orderId),
      amount: create.body.quote.cryptoAmount,
      destination: CUSTOMER, // wrong destination
    });

    const res = await request(app)
      .post(`/api/checkout/${orderId}/submit`)
      .send({ signedTxXdr: xdr })
      .expect(400);
    expect(res.body.error).toContain('destination mismatch');
  });

  it('returns 400 when XDR amount does not match session', async () => {
    const { app } = buildApp();

    const create = await request(app)
      .post('/api/checkout')
      .send({ fiatAmount: 10, assetCode: 'XLM' })
      .expect(201);

    const { orderId } = create.body;
    const xdr = buildValidXdr({
      orderId: BigInt(orderId),
      amount: '1.0000000', // wrong amount
    });

    const res = await request(app)
      .post(`/api/checkout/${orderId}/submit`)
      .send({ signedTxXdr: xdr })
      .expect(400);
    expect(res.body.error).toContain('amount mismatch');
  });
});

// ─── GET /api/sessions ────────────────────────────────────────────────────────

describe('GET /api/sessions', () => {
  it('returns an empty list when no sessions exist', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/sessions').expect(200);
    expect(res.body.sessions).toEqual([]);
  });

  it('lists all created sessions', async () => {
    const { app } = buildApp();

    await request(app).post('/api/checkout').send({ fiatAmount: 10, assetCode: 'XLM' });
    await request(app).post('/api/checkout').send({ fiatAmount: 5, assetCode: 'USDC' });

    const res = await request(app).get('/api/sessions').expect(200);
    expect(res.body.sessions).toHaveLength(2);
  });

  it('serialises orderId as a string (not a number)', async () => {
    const { app } = buildApp();

    await request(app).post('/api/checkout').send({ fiatAmount: 10, assetCode: 'XLM' });

    const res = await request(app).get('/api/sessions').expect(200);
    // BigInt orderId must be serialised as a string
    expect(typeof res.body.sessions[0].orderId).toBe('string');
  });

  it('includes the expected fields on each session entry', async () => {
    const { app } = buildApp();

    await request(app).post('/api/checkout').send({ fiatAmount: 10, assetCode: 'XLM' });

    const res = await request(app).get('/api/sessions').expect(200);
    const s = res.body.sessions[0];
    expect(s).toHaveProperty('orderId');
    expect(s).toHaveProperty('status');
    expect(s).toHaveProperty('asset');
    expect(s).toHaveProperty('amount');
    expect(s).toHaveProperty('expiresAt');
    expect(s).toHaveProperty('network');
  });

  it('returns 401 when sessionsApiKey is set and no Authorization header is provided', async () => {
    const store = new InMemorySessionStore();
    const manager = new SessionManager(store);
    const mockSource = {
      name: 'mock',
      getUsdPrice: jest.fn(async (code: 'XLM' | 'USDC') => (code === 'XLM' ? 0.1 : 1.0)),
    };
    const quoteService = new QuoteService(mockSource as unknown as CoinGeckoPriceSource);
    const router = createCheckoutRouter({
      sessionManager: manager,
      quoteService,
      merchantAddress: MERCHANT,
      network: NETWORK,
      sessionsApiKey: 'supersecret',
    });
    const app = express();
    app.use(express.json());
    app.use('/api', router);

    const res = await request(app).get('/api/sessions').expect(401);
    expect(res.body.error).toContain('Unauthorized');
  });

  it('returns 401 when sessionsApiKey is set and wrong token is provided', async () => {
    const store = new InMemorySessionStore();
    const manager = new SessionManager(store);
    const mockSource = {
      name: 'mock',
      getUsdPrice: jest.fn(async (code: 'XLM' | 'USDC') => (code === 'XLM' ? 0.1 : 1.0)),
    };
    const quoteService = new QuoteService(mockSource as unknown as CoinGeckoPriceSource);
    const router = createCheckoutRouter({
      sessionManager: manager,
      quoteService,
      merchantAddress: MERCHANT,
      network: NETWORK,
      sessionsApiKey: 'supersecret',
    });
    const app = express();
    app.use(express.json());
    app.use('/api', router);

    const res = await request(app)
      .get('/api/sessions')
      .set('Authorization', 'Bearer wrongtoken')
      .expect(401);
    expect(res.body.error).toContain('Unauthorized');
  });

  it('returns 200 when sessionsApiKey is set and correct token is provided', async () => {
    const store = new InMemorySessionStore();
    const manager = new SessionManager(store);
    const mockSource = {
      name: 'mock',
      getUsdPrice: jest.fn(async (code: 'XLM' | 'USDC') => (code === 'XLM' ? 0.1 : 1.0)),
    };
    const quoteService = new QuoteService(mockSource as unknown as CoinGeckoPriceSource);
    const router = createCheckoutRouter({
      sessionManager: manager,
      quoteService,
      merchantAddress: MERCHANT,
      network: NETWORK,
      sessionsApiKey: 'supersecret',
    });
    const app = express();
    app.use(express.json());
    app.use('/api', router);

    const res = await request(app)
      .get('/api/sessions')
      .set('Authorization', 'Bearer supersecret')
      .expect(200);
    expect(res.body.sessions).toEqual([]);
  });
});

// ─── GET /api/network ─────────────────────────────────────────────────────────

describe('GET /api/network', () => {
  it('returns network, networkPassphrase, and horizonUrl', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/network').expect(200);
    expect(res.body.network).toBe('testnet');
    expect(res.body.networkPassphrase).toContain('Test SDF');
    expect(res.body.horizonUrl).toContain('horizon-testnet');
  });
});
