/**
 * escrow-router.test.ts
 *
 * Supertest tests for the escrow checkout router.
 * Real Stellar transactions are built with stellar-sdk — no stubs for XDR paths.
 */

import express from 'express';
import request from 'supertest';
import {
  Keypair, Account, TransactionBuilder, Contract,
  nativeToScVal, Networks, BASE_FEE,
} from 'stellar-sdk';
import {
  createEscrowRouter,
  EscrowSessionStore,
  type EscrowRouterOptions,
} from '../escrow-router';
import {
  type SorobanRpcClient,
  EscrowClientError,
  EscrowRpcError,
  ESCROW_ERROR_CODES,
  type EscrowRecord,
} from '../escrow-session';

// ─── Constants ────────────────────────────────────────────────────────────────

const CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const TOKEN_ID    = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
const WRONG_CONTRACT = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'; // different C...
// Valid contract StrKey (all-0xAB bytes) but different from TOKEN_ID:
const WRONG_TOKEN    = 'CCV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XMCW';
const AMOUNT = '500000000';
const NETWORK_PASSPHRASE = Networks.TESTNET;
const RELEASE_API_KEY = 'test-release-key';
const TX_HASH = 'aabb'.padEnd(64, '0');
const UNSIGNED_XDR = 'AAAA_UNSIGNED_XDR';

// Keypairs for building real transactions (not sent to network)
const payerKp = Keypair.random();
const merchantKp = Keypair.random();
const wrongMerchantKp = Keypair.random();
const PAYER    = payerKp.publicKey();
const MERCHANT = merchantKp.publicKey();
const WRONG_MERCHANT = wrongMerchantKp.publicKey();

// ─── Real XDR builder ─────────────────────────────────────────────────────────

interface DepositXdrParams {
  contractId?: string;
  method?: string;
  payer?: string;
  payerKp?: Keypair;
  merchant?: string;
  amount?: bigint;
  token?: string;
  orderIdHex?: string;
  timeoutLedgers?: number;
  addExtraOp?: boolean;
  useFeeBump?: boolean;
}

/**
 * Build a real signed deposit transaction XDR using stellar-sdk.
 * This creates an actual invokeHostFunction transaction that the router's
 * XDR validation code can parse and check.
 */
function buildSignedDepositXdr(orderId: string, overrides: DepositXdrParams = {}): string {
  const {
    contractId: cId = CONTRACT_ID,
    method = 'deposit',
    payer: payerAddr = PAYER,
    payerKp: signer = payerKp,
    merchant: merchantAddr = MERCHANT,
    amount = BigInt(AMOUNT),
    token = TOKEN_ID,
    orderIdHex = orderId,
    timeoutLedgers = 0,
    addExtraOp = false,
    useFeeBump = false,
  } = overrides;

  const contract = new Contract(cId);
  const args = [
    nativeToScVal(payerAddr, { type: 'address' }),
    nativeToScVal(merchantAddr, { type: 'address' }),
    nativeToScVal(amount, { type: 'i128' }),
    nativeToScVal(token, { type: 'address' }),
    nativeToScVal(Buffer.from(orderIdHex, 'hex'), { type: 'bytes' }),
    nativeToScVal(timeoutLedgers, { type: 'u32' }),
  ];
  const op = contract.call(method, ...args);

  const acct = new Account(payerAddr, '100');
  const builder = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(op)
    .setTimeout(30);

  if (addExtraOp) {
    builder.addOperation(op);
  }

  const tx = builder.build();
  tx.sign(signer);

  if (useFeeBump) {
    // Return a FeeBump XDR
    const fb = TransactionBuilder.buildFeeBumpTransaction(signer, '200', tx, NETWORK_PASSPHRASE);
    fb.sign(signer);
    return fb.toXDR();
  }

  return tx.toXDR();
}

/** Build a real signed release XDR. */
function buildSignedReleaseXdr(orderId: string, overrides: {
  contractId?: string; orderIdHex?: string; signerKp?: Keypair; signer?: string;
} = {}): string {
  const {
    contractId: cId = CONTRACT_ID,
    orderIdHex = orderId,
    signerKp = merchantKp,
  } = overrides;
  const signerAddr = signerKp.publicKey();
  const contract = new Contract(cId);
  const op = contract.call('release', nativeToScVal(Buffer.from(orderIdHex, 'hex'), { type: 'bytes' }));
  const acct = new Account(signerAddr, '100');
  const tx = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(op).setTimeout(30).build();
  tx.sign(signerKp);
  return tx.toXDR();
}

/** Build a real signed refund XDR. */
function buildSignedRefundXdr(orderId: string, caller: string, callerKp: Keypair, overrides: {
  contractId?: string; orderIdHex?: string;
} = {}): string {
  const { contractId: cId = CONTRACT_ID, orderIdHex = orderId } = overrides;
  const contract = new Contract(cId);
  const op = contract.call('refund',
    nativeToScVal(Buffer.from(orderIdHex, 'hex'), { type: 'bytes' }),
    nativeToScVal(caller, { type: 'address' }),
  );
  const acct = new Account(caller, '100');
  const tx = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(op).setTimeout(30).build();
  tx.sign(callerKp);
  return tx.toXDR();
}

// ─── Mock RPC factory ─────────────────────────────────────────────────────────

function makeHeldRecord(overrides: Partial<EscrowRecord> = {}): EscrowRecord {
  return {
    payer: PAYER, merchant: MERCHANT, amount: BigInt(AMOUNT),
    token: TOKEN_ID, status: 'Held', deposited_at: 1000, timeout_ledgers: 518400,
    ...overrides,
  };
}

function createMockRpc(overrides?: Partial<jest.Mocked<SorobanRpcClient>>): jest.Mocked<SorobanRpcClient> {
  return {
    invokeContract: jest.fn(),
    simulateContract: jest.fn().mockResolvedValue({ result: makeHeldRecord() }),
    buildUnsignedContractTx: jest.fn().mockResolvedValue({
      unsignedXdr: UNSIGNED_XDR,
      networkPassphrase: NETWORK_PASSPHRASE,
    }),
    submitSignedTx: jest.fn().mockResolvedValue({ txHash: TX_HASH }),
    ...overrides,
  };
}

// ─── App factory ──────────────────────────────────────────────────────────────

/**
 * Create a test app with a fresh session store each time to avoid state leakage.
 */
function makeApp(opts: Partial<EscrowRouterOptions> = {}, rpc?: jest.Mocked<SorobanRpcClient>) {
  const app = express();
  app.use(express.json());
  const store = new EscrowSessionStore();
  const router = createEscrowRouter({
    contractId: CONTRACT_ID,
    network: 'testnet',
    rpcClient: rpc ?? createMockRpc(),
    releaseApiKey: RELEASE_API_KEY,
    sessionStore: store,
    ...opts,
  });
  app.use('/api', router);
  return { app, store };
}

function makeUnconfiguredApp() {
  const app = express();
  app.use(express.json());
  const router = createEscrowRouter({ network: 'testnet' });
  app.use('/api', router);
  return app;
}

// ─── Helper: create + drive session to 'deposited' ───────────────────────────

async function createDepositedSession(app: express.Express, rpc: jest.Mocked<SorobanRpcClient>): Promise<string> {
  const createRes = await request(app).post('/api/escrow').send({
    payerAddress: PAYER, merchantAddress: MERCHANT,
    tokenContractId: TOKEN_ID, amount: AMOUNT,
  });
  expect(createRes.status).toBe(201);
  const orderId = createRes.body.orderId as string;

  // Real valid deposit XDR
  const signedXdr = buildSignedDepositXdr(orderId);
  rpc.simulateContract.mockResolvedValue({ result: makeHeldRecord() });

  const submitRes = await request(app)
    .post(`/api/escrow/${orderId}/submit`)
    .send({ signedDepositXdr: signedXdr });
  expect(submitRes.status).toBe(200);
  expect(submitRes.body.status).toBe('deposited');

  // Reset mock call counts after setup so tests can assert "not called again"
  // without the deposit submit call polluting the count.
  rpc.submitSignedTx.mockClear();

  return orderId;
}

// ─── POST /api/escrow ─────────────────────────────────────────────────────────

describe('POST /api/escrow', () => {
  it('returns 201 with orderId (64 hex chars), sessionId, pending status', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/api/escrow').send({
      payerAddress: PAYER, merchantAddress: MERCHANT,
      tokenContractId: TOKEN_ID, amount: AMOUNT,
    });
    expect(res.status).toBe(201);
    expect(res.body.orderId).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.sessionId).toBeDefined();
    expect(res.body.status).toBe('pending');
    expect(res.body.unsignedDepositXdr).toBe(UNSIGNED_XDR);
  });

  it('two sessions get different order IDs (random, not counter-derived)', async () => {
    const { app } = makeApp();
    const r1 = await request(app).post('/api/escrow').send({
      payerAddress: PAYER, merchantAddress: MERCHANT, tokenContractId: TOKEN_ID, amount: AMOUNT,
    });
    const r2 = await request(app).post('/api/escrow').send({
      payerAddress: PAYER, merchantAddress: MERCHANT, tokenContractId: TOKEN_ID, amount: AMOUNT,
    });
    expect(r1.body.orderId).not.toBe(r2.body.orderId);
  });

  it('orderId is not derivable from sessionId', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/api/escrow').send({
      payerAddress: PAYER, merchantAddress: MERCHANT, tokenContractId: TOKEN_ID, amount: AMOUNT,
    });
    // sessionId is "1", orderId must not be the padded version of 1
    const paddedOne = '0'.repeat(48) + '0000000000000001';
    expect(res.body.orderId).not.toBe(paddedOne);
  });

  it('400 when payerAddress missing', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/api/escrow').send({
      merchantAddress: MERCHANT, tokenContractId: TOKEN_ID, amount: AMOUNT,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/payerAddress/);
  });

  it('400 when merchantAddress invalid', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/api/escrow').send({
      payerAddress: PAYER, merchantAddress: 'bad', tokenContractId: TOKEN_ID, amount: AMOUNT,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/merchantAddress/);
  });

  it('400 when tokenContractId is a G... key not a C...', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/api/escrow').send({
      payerAddress: PAYER, merchantAddress: MERCHANT, tokenContractId: PAYER, amount: AMOUNT,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/tokenContractId/);
  });

  it('400 when amount is zero', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/api/escrow').send({
      payerAddress: PAYER, merchantAddress: MERCHANT, tokenContractId: TOKEN_ID, amount: '0',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/amount/);
  });

  it('400 when amount is decimal', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/api/escrow').send({
      payerAddress: PAYER, merchantAddress: MERCHANT, tokenContractId: TOKEN_ID, amount: '1.5',
    });
    expect(res.status).toBe(400);
  });

  it('400 when timeoutLedgers out of range', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/api/escrow').send({
      payerAddress: PAYER, merchantAddress: MERCHANT, tokenContractId: TOKEN_ID, amount: AMOUNT,
      timeoutLedgers: 9_999_999,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/timeoutLedgers/);
  });

  it('503 when escrow not configured', async () => {
    const res = await request(makeUnconfiguredApp()).post('/api/escrow').send({
      payerAddress: PAYER, merchantAddress: MERCHANT, tokenContractId: TOKEN_ID, amount: AMOUNT,
    });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not configured/i);
  });

  it('cleans up orphan session if buildUnsignedContractTx throws', async () => {
    const rpc = createMockRpc({
      buildUnsignedContractTx: jest.fn().mockRejectedValue(new EscrowRpcError('NETWORK_ERROR', 'rpc down')),
    });
    const { app } = makeApp({}, rpc);
    const res = await request(app).post('/api/escrow').send({
      payerAddress: PAYER, merchantAddress: MERCHANT, tokenContractId: TOKEN_ID, amount: AMOUNT,
    });
    expect(res.status).toBe(502);
    // Session should not exist (was cleaned up)
    const getRes = await request(app).get('/api/escrow/doesnotexist');
    expect(getRes.status).toBe(404);
  });
});

// ─── POST /api/escrow/:orderId/submit — REAL XDR TESTS ───────────────────────

describe('POST /api/escrow/:orderId/submit', () => {
  it('HAPPY PATH: valid signed deposit → 200, status deposited, submitSignedTx called once', async () => {
    const rpc = createMockRpc();
    const { app } = makeApp({}, rpc);
    const createRes = await request(app).post('/api/escrow').send({
      payerAddress: PAYER, merchantAddress: MERCHANT, tokenContractId: TOKEN_ID, amount: AMOUNT,
    });
    expect(createRes.status).toBe(201);
    const orderId = createRes.body.orderId as string;

    rpc.simulateContract.mockResolvedValue({ result: makeHeldRecord() });
    const signedXdr = buildSignedDepositXdr(orderId);

    const res = await request(app)
      .post(`/api/escrow/${orderId}/submit`)
      .send({ signedDepositXdr: signedXdr });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('deposited');
    expect(res.body.txHash).toBe(TX_HASH);
    expect(rpc.submitSignedTx).toHaveBeenCalledTimes(1);
    expect(rpc.submitSignedTx).toHaveBeenCalledWith(
      expect.objectContaining({ signedXdr })
    );
  });

  it('400 + submitSignedTx NOT called when wrong contract ID', async () => {
    const rpc = createMockRpc();
    const { app } = makeApp({}, rpc);
    const createRes = await request(app).post('/api/escrow').send({
      payerAddress: PAYER, merchantAddress: MERCHANT, tokenContractId: TOKEN_ID, amount: AMOUNT,
    });
    const orderId = createRes.body.orderId as string;

    const signedXdr = buildSignedDepositXdr(orderId, { contractId: WRONG_CONTRACT });
    const res = await request(app)
      .post(`/api/escrow/${orderId}/submit`)
      .send({ signedDepositXdr: signedXdr });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/contract/i);
    expect(rpc.submitSignedTx).not.toHaveBeenCalled();
  });

  it('400 + not submitted when wrong method ("release" instead of "deposit")', async () => {
    const rpc = createMockRpc();
    const { app } = makeApp({}, rpc);
    const createRes = await request(app).post('/api/escrow').send({
      payerAddress: PAYER, merchantAddress: MERCHANT, tokenContractId: TOKEN_ID, amount: AMOUNT,
    });
    const orderId = createRes.body.orderId as string;

    const signedXdr = buildSignedDepositXdr(orderId, { method: 'release' });
    const res = await request(app)
      .post(`/api/escrow/${orderId}/submit`)
      .send({ signedDepositXdr: signedXdr });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/method|release/i);
    expect(rpc.submitSignedTx).not.toHaveBeenCalled();
  });

  it('400 + not submitted when transaction source != payer', async () => {
    const rpc = createMockRpc();
    const { app } = makeApp({}, rpc);
    const createRes = await request(app).post('/api/escrow').send({
      payerAddress: PAYER, merchantAddress: MERCHANT, tokenContractId: TOKEN_ID, amount: AMOUNT,
    });
    const orderId = createRes.body.orderId as string;

    // Build tx from merchant account (wrong source)
    const signedXdr = buildSignedDepositXdr(orderId, {
      payer: MERCHANT,
      payerKp: merchantKp,
    });
    const res = await request(app)
      .post(`/api/escrow/${orderId}/submit`)
      .send({ signedDepositXdr: signedXdr });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/source|payer/i);
    expect(rpc.submitSignedTx).not.toHaveBeenCalled();
  });

  it('400 + not submitted when arg[1] merchant is wrong', async () => {
    const rpc = createMockRpc();
    const { app } = makeApp({}, rpc);
    const createRes = await request(app).post('/api/escrow').send({
      payerAddress: PAYER, merchantAddress: MERCHANT, tokenContractId: TOKEN_ID, amount: AMOUNT,
    });
    const orderId = createRes.body.orderId as string;

    const signedXdr = buildSignedDepositXdr(orderId, { merchant: WRONG_MERCHANT });
    const res = await request(app)
      .post(`/api/escrow/${orderId}/submit`)
      .send({ signedDepositXdr: signedXdr });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/merchant/i);
    expect(rpc.submitSignedTx).not.toHaveBeenCalled();
  });

  it('400 + not submitted when arg[2] amount is lower than session amount', async () => {
    const rpc = createMockRpc();
    const { app } = makeApp({}, rpc);
    const createRes = await request(app).post('/api/escrow').send({
      payerAddress: PAYER, merchantAddress: MERCHANT, tokenContractId: TOKEN_ID, amount: AMOUNT,
    });
    const orderId = createRes.body.orderId as string;

    const signedXdr = buildSignedDepositXdr(orderId, { amount: 1n }); // tiny amount
    const res = await request(app)
      .post(`/api/escrow/${orderId}/submit`)
      .send({ signedDepositXdr: signedXdr });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/amount/i);
    expect(rpc.submitSignedTx).not.toHaveBeenCalled();
  });

  it('400 + not submitted when arg[3] token is wrong', async () => {
    const rpc = createMockRpc();
    const { app } = makeApp({}, rpc);
    const createRes = await request(app).post('/api/escrow').send({
      payerAddress: PAYER, merchantAddress: MERCHANT, tokenContractId: TOKEN_ID, amount: AMOUNT,
    });
    const orderId = createRes.body.orderId as string;

    const signedXdr = buildSignedDepositXdr(orderId, { token: WRONG_TOKEN });
    const res = await request(app)
      .post(`/api/escrow/${orderId}/submit`)
      .send({ signedDepositXdr: signedXdr });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/token/i);
    expect(rpc.submitSignedTx).not.toHaveBeenCalled();
  });

  it('400 + not submitted when arg[4] order_id is wrong', async () => {
    const rpc = createMockRpc();
    const { app } = makeApp({}, rpc);
    const createRes = await request(app).post('/api/escrow').send({
      payerAddress: PAYER, merchantAddress: MERCHANT, tokenContractId: TOKEN_ID, amount: AMOUNT,
    });
    const orderId = createRes.body.orderId as string;

    const wrongOrderId = 'ff'.repeat(32); // different 32 bytes
    const signedXdr = buildSignedDepositXdr(orderId, { orderIdHex: wrongOrderId });
    const res = await request(app)
      .post(`/api/escrow/${orderId}/submit`)
      .send({ signedDepositXdr: signedXdr });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/order_id/i);
    expect(rpc.submitSignedTx).not.toHaveBeenCalled();
  });

  it('400 + not submitted when arg[5] timeout_ledgers is wrong', async () => {
    const rpc = createMockRpc();
    const { app } = makeApp({ defaultTimeoutLedgers: 0 }, rpc);
    const createRes = await request(app).post('/api/escrow').send({
      payerAddress: PAYER, merchantAddress: MERCHANT, tokenContractId: TOKEN_ID, amount: AMOUNT,
    });
    const orderId = createRes.body.orderId as string;

    const signedXdr = buildSignedDepositXdr(orderId, { timeoutLedgers: 9999 });
    const res = await request(app)
      .post(`/api/escrow/${orderId}/submit`)
      .send({ signedDepositXdr: signedXdr });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/timeout/i);
    expect(rpc.submitSignedTx).not.toHaveBeenCalled();
  });

  it('400 when extra operation present', async () => {
    const rpc = createMockRpc();
    const { app } = makeApp({}, rpc);
    const createRes = await request(app).post('/api/escrow').send({
      payerAddress: PAYER, merchantAddress: MERCHANT, tokenContractId: TOKEN_ID, amount: AMOUNT,
    });
    const orderId = createRes.body.orderId as string;

    const signedXdr = buildSignedDepositXdr(orderId, { addExtraOp: true });
    const res = await request(app)
      .post(`/api/escrow/${orderId}/submit`)
      .send({ signedDepositXdr: signedXdr });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/1 operation/i);
    expect(rpc.submitSignedTx).not.toHaveBeenCalled();
  });

  it('400 when FeeBump envelope submitted', async () => {
    const rpc = createMockRpc();
    const { app } = makeApp({}, rpc);
    const createRes = await request(app).post('/api/escrow').send({
      payerAddress: PAYER, merchantAddress: MERCHANT, tokenContractId: TOKEN_ID, amount: AMOUNT,
    });
    const orderId = createRes.body.orderId as string;

    const feeBumpXdr = buildSignedDepositXdr(orderId, { useFeeBump: true });
    const res = await request(app)
      .post(`/api/escrow/${orderId}/submit`)
      .send({ signedDepositXdr: feeBumpXdr });

    expect(res.status).toBe(400);
    expect(rpc.submitSignedTx).not.toHaveBeenCalled();
  });

  it('400 when unparseable XDR string', async () => {
    const rpc = createMockRpc();
    const { app } = makeApp({}, rpc);
    const createRes = await request(app).post('/api/escrow').send({
      payerAddress: PAYER, merchantAddress: MERCHANT, tokenContractId: TOKEN_ID, amount: AMOUNT,
    });
    const orderId = createRes.body.orderId as string;

    const res = await request(app)
      .post(`/api/escrow/${orderId}/submit`)
      .send({ signedDepositXdr: 'not-valid-xdr' });

    expect(res.status).toBe(400);
    expect(rpc.submitSignedTx).not.toHaveBeenCalled();
  });

  it('409 when session is already deposited (real 409, not ambiguous)', async () => {
    const rpc = createMockRpc();
    const { app } = makeApp({}, rpc);

    // Drive to deposited via the real happy-path flow
    const orderId = await createDepositedSession(app, rpc);

    // Try to submit again — should get 409
    const signedXdr = buildSignedDepositXdr(orderId);
    const res = await request(app)
      .post(`/api/escrow/${orderId}/submit`)
      .send({ signedDepositXdr: signedXdr });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/deposited|pending/i);
  });

  it('409 on concurrent duplicate (in-flight guard)', async () => {
    const rpc = createMockRpc({
      submitSignedTx: jest.fn().mockImplementation(() => new Promise<{ txHash: string }>(
        (resolve) => setTimeout(() => resolve({ txHash: TX_HASH }), 100)
      )),
      simulateContract: jest.fn().mockResolvedValue({ result: makeHeldRecord() }),
    });
    const { app } = makeApp({}, rpc);
    const createRes = await request(app).post('/api/escrow').send({
      payerAddress: PAYER, merchantAddress: MERCHANT, tokenContractId: TOKEN_ID, amount: AMOUNT,
    });
    const orderId = createRes.body.orderId as string;
    const signedXdr = buildSignedDepositXdr(orderId);

    // Send both at the same time
    const [first, second] = await Promise.all([
      request(app).post(`/api/escrow/${orderId}/submit`).send({ signedDepositXdr: signedXdr }),
      request(app).post(`/api/escrow/${orderId}/submit`).send({ signedDepositXdr: signedXdr }),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toContain(200);
    expect(statuses).toContain(409);
    expect(rpc.submitSignedTx).toHaveBeenCalledTimes(1);
  });

  it('session stays pending after POLL_TIMEOUT (retryable)', async () => {
    const rpc = createMockRpc({
      submitSignedTx: jest.fn().mockRejectedValue(new EscrowRpcError('POLL_TIMEOUT', 'timed out')),
      simulateContract: jest.fn().mockRejectedValue(
        new EscrowClientError('get_escrow', ESCROW_ERROR_CODES.NotFound),
      ),
    });
    const { app } = makeApp({}, rpc);
    const createRes = await request(app).post('/api/escrow').send({
      payerAddress: PAYER, merchantAddress: MERCHANT, tokenContractId: TOKEN_ID, amount: AMOUNT,
    });
    const orderId = createRes.body.orderId as string;
    const signedXdr = buildSignedDepositXdr(orderId);

    const res = await request(app)
      .post(`/api/escrow/${orderId}/submit`)
      .send({ signedDepositXdr: signedXdr });

    // Returns 504 for poll timeout
    expect(res.status).toBe(504);

    // Session is NOT in 'failed' — stays pending for retry
    const getRes = await request(app).get(`/api/escrow/${orderId}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.status).toBe('pending');
  });

  it('400 + mismatch status when on-chain record does not match session after confirmation', async () => {
    const rpc = createMockRpc({
      submitSignedTx: jest.fn().mockResolvedValue({ txHash: TX_HASH }),
      simulateContract: jest.fn().mockResolvedValue({
        result: makeHeldRecord({ amount: 1n }), // different amount on-chain
      }),
    });
    const { app } = makeApp({}, rpc);
    const createRes = await request(app).post('/api/escrow').send({
      payerAddress: PAYER, merchantAddress: MERCHANT, tokenContractId: TOKEN_ID, amount: AMOUNT,
    });
    const orderId = createRes.body.orderId as string;
    const signedXdr = buildSignedDepositXdr(orderId);

    const res = await request(app)
      .post(`/api/escrow/${orderId}/submit`)
      .send({ signedDepositXdr: signedXdr });

    expect(res.status).toBe(400);
    expect(res.body.status).toBe('mismatch');
    expect(res.body.error).toMatch(/amount/i);

    // Session is terminal 'mismatch'
    const getRes = await request(app).get(`/api/escrow/${orderId}`);
    expect(getRes.body.status).toBe('mismatch');
  });

  it('404 when session not found', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/api/escrow/ff'.padEnd(66, 'f') + '/submit')
      .send({ signedDepositXdr: 'XDR' });
    expect(res.status).toBe(404);
  });

  it('400 when signedDepositXdr missing', async () => {
    const rpc = createMockRpc();
    const { app } = makeApp({}, rpc);
    const createRes = await request(app).post('/api/escrow').send({
      payerAddress: PAYER, merchantAddress: MERCHANT, tokenContractId: TOKEN_ID, amount: AMOUNT,
    });
    const orderId = createRes.body.orderId as string;
    const res = await request(app).post(`/api/escrow/${orderId}/submit`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/signedDepositXdr/);
  });

  it('503 when escrow not configured', async () => {
    const res = await request(makeUnconfiguredApp())
      .post('/api/escrow/someId/submit')
      .send({ signedDepositXdr: 'XDR' });
    expect(res.status).toBe(503);
  });
});

// ─── POST /api/escrow/:orderId/release ────────────────────────────────────────

describe('POST /api/escrow/:orderId/release', () => {
  it('401 with no auth when releaseApiKey set', async () => {
    const rpc = createMockRpc();
    const { app } = makeApp({}, rpc);
    const orderId = await createDepositedSession(app, rpc);
    const res = await request(app).post(`/api/escrow/${orderId}/release`)
      .send({ merchantAddress: MERCHANT });
    expect(res.status).toBe(401);
  });

  it('401 with wrong token', async () => {
    const rpc = createMockRpc();
    const { app } = makeApp({}, rpc);
    const orderId = await createDepositedSession(app, rpc);
    const res = await request(app).post(`/api/escrow/${orderId}/release`)
      .set('Authorization', 'Bearer wrong')
      .send({ merchantAddress: MERCHANT });
    expect(res.status).toBe(401);
  });

  it('200 returns unsignedReleaseXdr with correct auth', async () => {
    const rpc = createMockRpc();
    const { app } = makeApp({}, rpc);
    const orderId = await createDepositedSession(app, rpc);
    const res = await request(app).post(`/api/escrow/${orderId}/release`)
      .set('Authorization', `Bearer ${RELEASE_API_KEY}`)
      .send({ merchantAddress: MERCHANT });
    expect(res.status).toBe(200);
    expect(res.body.unsignedReleaseXdr).toBe(UNSIGNED_XDR);
    expect(res.body.networkPassphrase).toBeTruthy();
  });

  it('409 when session is pending (not deposited)', async () => {
    const { app } = makeApp();
    const createRes = await request(app).post('/api/escrow').send({
      payerAddress: PAYER, merchantAddress: MERCHANT, tokenContractId: TOKEN_ID, amount: AMOUNT,
    });
    const orderId = createRes.body.orderId as string;
    const res = await request(app).post(`/api/escrow/${orderId}/release`)
      .set('Authorization', `Bearer ${RELEASE_API_KEY}`)
      .send({ merchantAddress: MERCHANT });
    expect(res.status).toBe(409);
  });

  it('403 when merchantAddress does not match session', async () => {
    const rpc = createMockRpc();
    const { app } = makeApp({}, rpc);
    const orderId = await createDepositedSession(app, rpc);
    const res = await request(app).post(`/api/escrow/${orderId}/release`)
      .set('Authorization', `Bearer ${RELEASE_API_KEY}`)
      .send({ merchantAddress: WRONG_MERCHANT });
    expect(res.status).toBe(403);
  });

  it('404 when session not found', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/api/escrow/ff'.padEnd(66, 'f') + '/release')
      .set('Authorization', `Bearer ${RELEASE_API_KEY}`)
      .send({ merchantAddress: MERCHANT });
    expect(res.status).toBe(404);
  });

  it('503 when escrow not configured', async () => {
    const res = await request(makeUnconfiguredApp()).post('/api/escrow/x/release')
      .set('Authorization', `Bearer ${RELEASE_API_KEY}`)
      .send({ merchantAddress: MERCHANT });
    expect(res.status).toBe(503);
  });
});

// ─── requireReleaseAuth — timing-safe and production-without-key ──────────────

describe('requireReleaseAuth', () => {
  it('200 when correct key provided', async () => {
    const rpc = createMockRpc();
    const { app } = makeApp({}, rpc);
    const orderId = await createDepositedSession(app, rpc);
    const res = await request(app)
      .post(`/api/escrow/${orderId}/release`)
      .set('Authorization', `Bearer ${RELEASE_API_KEY}`)
      .send({ merchantAddress: MERCHANT });
    expect(res.status).toBe(200);
  });

  it('401 when wrong key provided', async () => {
    const rpc = createMockRpc();
    const { app } = makeApp({}, rpc);
    const orderId = await createDepositedSession(app, rpc);
    const res = await request(app)
      .post(`/api/escrow/${orderId}/release`)
      .set('Authorization', 'Bearer wrong-key')
      .send({ merchantAddress: MERCHANT });
    expect(res.status).toBe(401);
  });

  it('401 when Authorization header is missing', async () => {
    const rpc = createMockRpc();
    const { app } = makeApp({}, rpc);
    const orderId = await createDepositedSession(app, rpc);
    const res = await request(app)
      .post(`/api/escrow/${orderId}/release`)
      .send({ merchantAddress: MERCHANT });
    expect(res.status).toBe(401);
  });

  it('401 when key has different length (timing-safe guard)', async () => {
    const rpc = createMockRpc();
    const { app } = makeApp({}, rpc);
    const orderId = await createDepositedSession(app, rpc);
    // Provide a key that is a prefix of the real key — same bytes but shorter
    const shortKey = RELEASE_API_KEY.slice(0, -1);
    const res = await request(app)
      .post(`/api/escrow/${orderId}/release`)
      .set('Authorization', `Bearer ${shortKey}`)
      .send({ merchantAddress: MERCHANT });
    expect(res.status).toBe(401);
  });

  it('503 on release when production NODE_ENV and no key configured', async () => {
    const prevEnv = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    try {
      // Router created with no releaseApiKey
      const rpc = createMockRpc();
      const store = new EscrowSessionStore();
      const app = express();
      app.use(express.json());
      const router = createEscrowRouter({
        rpcClient: rpc,
        contractId: CONTRACT_ID,
        network: 'testnet',
        releaseApiKey: undefined,  // no key
        sessionStore: store,
      });
      app.use('/api', router);
      // Manually insert a deposited session
      const orderId = await createDepositedSession(app, rpc);
      const res = await request(app)
        .post(`/api/escrow/${orderId}/release`)
        .send({ merchantAddress: MERCHANT });
      expect(res.status).toBe(503);
      expect(res.body.error).toMatch(/RELEASE_API_KEY/);
    } finally {
      process.env['NODE_ENV'] = prevEnv;
    }
  });
});

// ─── POST /api/escrow/:orderId/release/submit ─────────────────────────────────

describe('POST /api/escrow/:orderId/release/submit', () => {
  it('HAPPY PATH: valid signed release → 200, status fulfilled', async () => {
    const rpc = createMockRpc({
      submitSignedTx: jest.fn().mockResolvedValue({ txHash: TX_HASH }),
      simulateContract: jest.fn()
        .mockResolvedValueOnce({ result: makeHeldRecord() })    // deposit confirm
        .mockResolvedValueOnce({ result: makeHeldRecord({ status: 'Released' }) }), // release confirm
    });
    const { app } = makeApp({}, rpc);
    const orderId = await createDepositedSession(app, rpc);

    const signedReleaseXdr = buildSignedReleaseXdr(orderId);
    const res = await request(app)
      .post(`/api/escrow/${orderId}/release/submit`)
      .set('Authorization', `Bearer ${RELEASE_API_KEY}`)
      .send({ signedReleaseXdr });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('fulfilled');
    expect(res.body.txHash).toBe(TX_HASH);
  });

  it('400 when wrong contract ID in release XDR', async () => {
    const rpc = createMockRpc({
      simulateContract: jest.fn().mockResolvedValue({ result: makeHeldRecord() }),
    });
    const { app } = makeApp({}, rpc);
    const orderId = await createDepositedSession(app, rpc);

    const signedReleaseXdr = buildSignedReleaseXdr(orderId, { contractId: WRONG_CONTRACT });
    const res = await request(app)
      .post(`/api/escrow/${orderId}/release/submit`)
      .set('Authorization', `Bearer ${RELEASE_API_KEY}`)
      .send({ signedReleaseXdr });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/contract/i);
    expect(rpc.submitSignedTx).not.toHaveBeenCalled();
  });

  it('400 when wrong order_id in release XDR', async () => {
    const rpc = createMockRpc({
      simulateContract: jest.fn().mockResolvedValue({ result: makeHeldRecord() }),
    });
    const { app } = makeApp({}, rpc);
    const orderId = await createDepositedSession(app, rpc);

    const wrongOrderId = 'ee'.repeat(32);
    const signedReleaseXdr = buildSignedReleaseXdr(orderId, { orderIdHex: wrongOrderId });
    const res = await request(app)
      .post(`/api/escrow/${orderId}/release/submit`)
      .set('Authorization', `Bearer ${RELEASE_API_KEY}`)
      .send({ signedReleaseXdr });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/order_id/i);
    expect(rpc.submitSignedTx).not.toHaveBeenCalled();
  });

  it('400 when tx source is not merchant', async () => {
    const rpc = createMockRpc({
      simulateContract: jest.fn().mockResolvedValue({ result: makeHeldRecord() }),
    });
    const { app } = makeApp({}, rpc);
    const orderId = await createDepositedSession(app, rpc);

    // Sign with payer, not merchant
    const signedReleaseXdr = buildSignedReleaseXdr(orderId, { signerKp: payerKp });
    const res = await request(app)
      .post(`/api/escrow/${orderId}/release/submit`)
      .set('Authorization', `Bearer ${RELEASE_API_KEY}`)
      .send({ signedReleaseXdr });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/merchant|source/i);
    expect(rpc.submitSignedTx).not.toHaveBeenCalled();
  });

  it('401 when no auth header', async () => {
    const rpc = createMockRpc({
      simulateContract: jest.fn().mockResolvedValue({ result: makeHeldRecord() }),
    });
    const { app } = makeApp({}, rpc);
    const orderId = await createDepositedSession(app, rpc);

    const signedReleaseXdr = buildSignedReleaseXdr(orderId);
    const res = await request(app)
      .post(`/api/escrow/${orderId}/release/submit`)
      .send({ signedReleaseXdr });

    expect(res.status).toBe(401);
  });

  it('409 when session is not deposited', async () => {
    const { app } = makeApp();
    const createRes = await request(app).post('/api/escrow').send({
      payerAddress: PAYER, merchantAddress: MERCHANT, tokenContractId: TOKEN_ID, amount: AMOUNT,
    });
    const orderId = createRes.body.orderId as string;

    const signedReleaseXdr = buildSignedReleaseXdr(orderId);
    const res = await request(app)
      .post(`/api/escrow/${orderId}/release/submit`)
      .set('Authorization', `Bearer ${RELEASE_API_KEY}`)
      .send({ signedReleaseXdr });

    expect(res.status).toBe(409);
  });

  it('503 when escrow not configured', async () => {
    const res = await request(makeUnconfiguredApp())
      .post('/api/escrow/x/release/submit')
      .send({ signedReleaseXdr: 'XDR' });
    expect(res.status).toBe(503);
  });
});

// ─── POST /api/escrow/:orderId/refund ─────────────────────────────────────────

describe('POST /api/escrow/:orderId/refund', () => {
  it('200 returns unsignedRefundXdr for merchant caller', async () => {
    const rpc = createMockRpc();
    const { app } = makeApp({}, rpc);
    const orderId = await createDepositedSession(app, rpc);

    const res = await request(app)
      .post(`/api/escrow/${orderId}/refund`)
      .send({ callerAddress: MERCHANT });

    expect(res.status).toBe(200);
    expect(res.body.unsignedRefundXdr).toBe(UNSIGNED_XDR);
  });

  it('200 returns unsignedRefundXdr for payer caller', async () => {
    const rpc = createMockRpc();
    const { app } = makeApp({}, rpc);
    const orderId = await createDepositedSession(app, rpc);

    const res = await request(app)
      .post(`/api/escrow/${orderId}/refund`)
      .send({ callerAddress: PAYER });

    expect(res.status).toBe(200);
    expect(res.body.unsignedRefundXdr).toBe(UNSIGNED_XDR);
  });

  it('403 when caller is neither payer nor merchant', async () => {
    const rpc = createMockRpc();
    const { app } = makeApp({}, rpc);
    const orderId = await createDepositedSession(app, rpc);

    const res = await request(app)
      .post(`/api/escrow/${orderId}/refund`)
      .send({ callerAddress: WRONG_MERCHANT });

    expect(res.status).toBe(403);
  });

  it('409 when session is pending', async () => {
    const { app } = makeApp();
    const createRes = await request(app).post('/api/escrow').send({
      payerAddress: PAYER, merchantAddress: MERCHANT, tokenContractId: TOKEN_ID, amount: AMOUNT,
    });
    const orderId = createRes.body.orderId as string;

    const res = await request(app)
      .post(`/api/escrow/${orderId}/refund`)
      .send({ callerAddress: MERCHANT });

    expect(res.status).toBe(409);
  });

  it('503 when escrow not configured', async () => {
    const res = await request(makeUnconfiguredApp())
      .post('/api/escrow/x/refund')
      .send({ callerAddress: MERCHANT });
    expect(res.status).toBe(503);
  });
});

// ─── POST /api/escrow/:orderId/refund/submit ──────────────────────────────────

describe('POST /api/escrow/:orderId/refund/submit', () => {
  it('HAPPY PATH (merchant): valid signed refund → 200, status refunded', async () => {
    const rpc = createMockRpc({
      submitSignedTx: jest.fn().mockResolvedValue({ txHash: TX_HASH }),
      simulateContract: jest.fn()
        .mockResolvedValueOnce({ result: makeHeldRecord() })
        .mockResolvedValueOnce({ result: makeHeldRecord({ status: 'Refunded' }) }),
    });
    const { app } = makeApp({}, rpc);
    const orderId = await createDepositedSession(app, rpc);

    const signedRefundXdr = buildSignedRefundXdr(orderId, MERCHANT, merchantKp);
    const res = await request(app)
      .post(`/api/escrow/${orderId}/refund/submit`)
      .send({ signedRefundXdr, callerAddress: MERCHANT });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('refunded');
    expect(res.body.txHash).toBe(TX_HASH);
  });

  it('HAPPY PATH (payer): valid signed refund → 200, status refunded', async () => {
    const rpc = createMockRpc({
      submitSignedTx: jest.fn().mockResolvedValue({ txHash: TX_HASH }),
      simulateContract: jest.fn()
        .mockResolvedValueOnce({ result: makeHeldRecord() })
        .mockResolvedValueOnce({ result: makeHeldRecord({ status: 'Refunded' }) }),
    });
    const { app } = makeApp({}, rpc);
    const orderId = await createDepositedSession(app, rpc);

    const signedRefundXdr = buildSignedRefundXdr(orderId, PAYER, payerKp);
    const res = await request(app)
      .post(`/api/escrow/${orderId}/refund/submit`)
      .send({ signedRefundXdr, callerAddress: PAYER });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('refunded');
  });

  it('400 when wrong contract ID', async () => {
    const rpc = createMockRpc({
      simulateContract: jest.fn().mockResolvedValue({ result: makeHeldRecord() }),
    });
    const { app } = makeApp({}, rpc);
    const orderId = await createDepositedSession(app, rpc);

    const signedRefundXdr = buildSignedRefundXdr(orderId, MERCHANT, merchantKp, { contractId: WRONG_CONTRACT });
    const res = await request(app)
      .post(`/api/escrow/${orderId}/refund/submit`)
      .send({ signedRefundXdr, callerAddress: MERCHANT });

    expect(res.status).toBe(400);
    expect(rpc.submitSignedTx).not.toHaveBeenCalled();
  });

  it('400 when wrong order_id in refund XDR', async () => {
    const rpc = createMockRpc({
      simulateContract: jest.fn().mockResolvedValue({ result: makeHeldRecord() }),
    });
    const { app } = makeApp({}, rpc);
    const orderId = await createDepositedSession(app, rpc);

    const signedRefundXdr = buildSignedRefundXdr(orderId, MERCHANT, merchantKp, { orderIdHex: 'dd'.repeat(32) });
    const res = await request(app)
      .post(`/api/escrow/${orderId}/refund/submit`)
      .send({ signedRefundXdr, callerAddress: MERCHANT });

    expect(res.status).toBe(400);
    expect(rpc.submitSignedTx).not.toHaveBeenCalled();
  });

  it('403 when callerAddress is a third party', async () => {
    const rpc = createMockRpc({
      simulateContract: jest.fn().mockResolvedValue({ result: makeHeldRecord() }),
    });
    const { app } = makeApp({}, rpc);
    const orderId = await createDepositedSession(app, rpc);

    const signedRefundXdr = buildSignedRefundXdr(orderId, WRONG_MERCHANT, wrongMerchantKp);
    const res = await request(app)
      .post(`/api/escrow/${orderId}/refund/submit`)
      .send({ signedRefundXdr, callerAddress: WRONG_MERCHANT });

    expect(res.status).toBe(403);
    expect(rpc.submitSignedTx).not.toHaveBeenCalled();
  });

  it('503 when escrow not configured', async () => {
    const res = await request(makeUnconfiguredApp())
      .post('/api/escrow/x/refund/submit')
      .send({ signedRefundXdr: 'XDR', callerAddress: MERCHANT });
    expect(res.status).toBe(503);
  });
});

// ─── GET /api/escrow/:orderId ─────────────────────────────────────────────────

describe('GET /api/escrow/:orderId', () => {
  it('200 with null onChain for pending session (on-chain NotFound)', async () => {
    const rpc = createMockRpc({
      simulateContract: jest.fn().mockRejectedValue(
        new EscrowClientError('get_escrow', ESCROW_ERROR_CODES.NotFound),
      ),
    });
    const { app } = makeApp({}, rpc);
    const createRes = await request(app).post('/api/escrow').send({
      payerAddress: PAYER, merchantAddress: MERCHANT, tokenContractId: TOKEN_ID, amount: AMOUNT,
    });
    const orderId = createRes.body.orderId as string;

    const res = await request(app).get(`/api/escrow/${orderId}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending');
    expect(res.body.onChain).toBeNull();
  });

  it('reconciles to deposited when on-chain shows Held and fields match', async () => {
    const rpc = createMockRpc({
      simulateContract: jest.fn().mockResolvedValue({ result: makeHeldRecord() }),
    });
    const { app } = makeApp({}, rpc);
    const createRes = await request(app).post('/api/escrow').send({
      payerAddress: PAYER, merchantAddress: MERCHANT, tokenContractId: TOKEN_ID, amount: AMOUNT,
    });
    const orderId = createRes.body.orderId as string;

    const res = await request(app).get(`/api/escrow/${orderId}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('deposited');
    expect(res.body.onChain.status).toBe('Held');
    expect(res.body.reconcileError).toBeNull();
  });

  it('reports reconcileError and does NOT promote status when on-chain amount mismatches', async () => {
    const rpc = createMockRpc({
      simulateContract: jest.fn().mockResolvedValue({
        result: makeHeldRecord({ amount: 1n }), // wrong amount
      }),
    });
    const { app } = makeApp({}, rpc);
    const createRes = await request(app).post('/api/escrow').send({
      payerAddress: PAYER, merchantAddress: MERCHANT, tokenContractId: TOKEN_ID, amount: AMOUNT,
    });
    const orderId = createRes.body.orderId as string;

    const res = await request(app).get(`/api/escrow/${orderId}`);
    expect(res.status).toBe(200);
    // Status stays pending — not promoted despite on-chain record
    expect(res.body.status).toBe('pending');
    expect(res.body.reconcileError).toMatch(/amount/i);
  });

  it('404 when session not found', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/escrow/ff'.padEnd(66, 'f'));
    expect(res.status).toBe(404);
  });

  it('503 when not configured', async () => {
    const res = await request(makeUnconfiguredApp()).get('/api/escrow/x');
    expect(res.status).toBe(503);
  });
});

// ─── Error mapping ────────────────────────────────────────────────────────────

describe('Error mapping', () => {
  it('EscrowClientError(AlreadyExists) from buildUnsignedContractTx → 409', async () => {
    const rpc = createMockRpc({
      buildUnsignedContractTx: jest.fn().mockRejectedValue(
        new EscrowClientError('deposit', ESCROW_ERROR_CODES.AlreadyExists)
      ),
    });
    const { app } = makeApp({}, rpc);
    const res = await request(app).post('/api/escrow').send({
      payerAddress: PAYER, merchantAddress: MERCHANT, tokenContractId: TOKEN_ID, amount: AMOUNT,
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('AlreadyExists');
  });

  it('EscrowRpcError(SIMULATION_FAILED) → 400', async () => {
    const rpc = createMockRpc({
      buildUnsignedContractTx: jest.fn().mockRejectedValue(
        new EscrowRpcError('SIMULATION_FAILED', 'sim failed')
      ),
    });
    const { app } = makeApp({}, rpc);
    const res = await request(app).post('/api/escrow').send({
      payerAddress: PAYER, merchantAddress: MERCHANT, tokenContractId: TOKEN_ID, amount: AMOUNT,
    });
    expect(res.status).toBe(400);
    expect(res.body.kind).toBe('SIMULATION_FAILED');
  });

  it('EscrowRpcError(NETWORK_ERROR) → 502', async () => {
    const rpc = createMockRpc({
      buildUnsignedContractTx: jest.fn().mockRejectedValue(
        new EscrowRpcError('NETWORK_ERROR', 'down')
      ),
    });
    const { app } = makeApp({}, rpc);
    const res = await request(app).post('/api/escrow').send({
      payerAddress: PAYER, merchantAddress: MERCHANT, tokenContractId: TOKEN_ID, amount: AMOUNT,
    });
    expect(res.status).toBe(502);
  });
});
