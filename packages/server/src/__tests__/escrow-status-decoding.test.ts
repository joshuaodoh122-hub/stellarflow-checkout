/**
 * escrow-status-decoding.test.ts
 *
 * Tests for EscrowRecord decoding through the full simulateContract path.
 *
 * All inputs are built with the real SDK (xdr, nativeToScVal, scValToNative) —
 * no hand-written mock objects — so the shapes tested are the same shapes the
 * real Soroban contract returns.
 *
 * Verified behaviours:
 *   _decodeEscrowRecord (via HttpSorobanRpcClient.simulateContract):
 *     - Held status as scvVec(['Held'])  → { status: 'Held' }
 *     - Released status                  → { status: 'Released' }
 *     - Refunded status                  → { status: 'Refunded' }
 *     - all numeric/address fields round-trip correctly
 *
 *   Invalid status shapes (must throw SIMULATION_FAILED with value in message):
 *     - empty array   []
 *     - two-element   ['Held', 'Extra']
 *     - unknown tag   ['Pending']
 *     - number        42
 *     - null
 *
 *   Public path (EscrowClient.getEscrow via mocked simulateTransaction):
 *     - full XDR ScVal → simulateTransaction mock → scValToNative → decoder
 *       → correct EscrowRecord (status 'Held')
 */

import {
  HttpSorobanRpcClient,
  EscrowClient,
  type EscrowRecord,
} from '../escrow-session';
import {
  rpc as SorobanRpc,
  xdr,
  scValToNative,
  nativeToScVal,
  Keypair,
  Networks,
} from '@stellar/stellar-sdk';

// ─── Test constants ───────────────────────────────────────────────────────────

const CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const TOKEN_ID    = 'CAEWW3XEBPQB2QIOWFZS6A2FRJR4Y6E75BWJYUEQQITO7Q4BT5KPODNB';
const RPC_URL     = 'https://soroban-testnet.stellar.org';
const ORDER_ID_HEX = '00'.repeat(32);

// Two random Stellar keypairs (public keys only — no signing needed)
const PAYER_KEY    = Keypair.random().publicKey();
const MERCHANT_KEY = Keypair.random().publicKey();

// ─── ScVal builders ───────────────────────────────────────────────────────────

/**
 * Build an xdr.ScVal map that mirrors the EscrowRecord struct returned
 * by the Soroban escrow contract.  The status field is encoded as a
 * single-element vec of a symbol — the real on-chain shape for unit variants.
 */
function buildEscrowRecordScVal(statusTag: 'Held' | 'Released' | 'Refunded'): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('amount'),
      val: nativeToScVal(1_000_000n, { type: 'i128' }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('deposited_at'),
      val: nativeToScVal(500, { type: 'u32' }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('merchant'),
      val: nativeToScVal(MERCHANT_KEY, { type: 'address' }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('payer'),
      val: nativeToScVal(PAYER_KEY, { type: 'address' }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('status'),
      val: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(statusTag)]),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('timeout_ledgers'),
      val: nativeToScVal(100, { type: 'u32' }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('token'),
      val: nativeToScVal(TOKEN_ID, { type: 'address' }),
    }),
  ]);
}

/**
 * Build an EscrowRecord ScVal where the status field is replaced by an
 * arbitrary ScVal — used for invalid-shape tests.
 */
function buildRecordWithRawStatus(statusVal: xdr.ScVal): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('amount'), val: nativeToScVal(1_000_000n, { type: 'i128' }) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('deposited_at'), val: nativeToScVal(500, { type: 'u32' }) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('merchant'), val: nativeToScVal(MERCHANT_KEY, { type: 'address' }) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('payer'), val: nativeToScVal(PAYER_KEY, { type: 'address' }) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('status'), val: statusVal }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('timeout_ledgers'), val: nativeToScVal(100, { type: 'u32' }) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('token'), val: nativeToScVal(TOKEN_ID, { type: 'address' }) }),
  ]);
}

/** Build a successful simulateTransaction response whose retval is `scval`. */
function makeSimSuccessWithRetval(
  scval: xdr.ScVal,
): SorobanRpc.Api.SimulateTransactionResponse {
  return {
    id: '1',
    latestLedger: 100,
    transactionData: { toXDR: () => Buffer.alloc(0) },
    minResourceFee: '200',
    cost: { cpuInsns: '0', memBytes: '0' },
    result: { auth: [], retval: scval },
    events: [],
  } as unknown as SorobanRpc.Api.SimulateTransactionResponse;
}

// ─── Mock setup ───────────────────────────────────────────────────────────────

const mockServerMethods = {
  getAccount: jest.fn(),
  simulateTransaction: jest.fn(),
  sendTransaction: jest.fn(),
  getTransaction: jest.fn(),
};

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual<typeof import('@stellar/stellar-sdk')>('@stellar/stellar-sdk');
  return {
    ...actual,
    rpc: {
      ...actual.rpc,
      Server: jest.fn().mockImplementation(() => mockServerMethods),
      assembleTransaction: jest.fn().mockImplementation(
        (tx: import('@stellar/stellar-sdk').Transaction) => ({ build: () => tx }),
      ),
    },
  };
});

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── Direct decode path (HttpSorobanRpcClient.simulateContract) ───────────────

describe('_decodeEscrowRecord — real SDK-built shapes (via HttpSorobanRpcClient)', () => {
  let client: HttpSorobanRpcClient;

  beforeEach(() => {
    client = new HttpSorobanRpcClient(RPC_URL, 'testnet');
  });

  it('decodes Held status from scvVec(["Held"]) to EscrowRecord.status = "Held"', async () => {
    mockServerMethods.simulateTransaction.mockResolvedValue(
      makeSimSuccessWithRetval(buildEscrowRecordScVal('Held')),
    );

    const { result } = await client.simulateContract({
      contractId: CONTRACT_ID,
      method: 'get_escrow',
      args: [ORDER_ID_HEX],
    });

    const record = result as EscrowRecord;
    expect(record.status).toBe('Held');
  });

  it('decodes Released status from scvVec(["Released"]) to EscrowRecord.status = "Released"', async () => {
    mockServerMethods.simulateTransaction.mockResolvedValue(
      makeSimSuccessWithRetval(buildEscrowRecordScVal('Released')),
    );

    const { result } = await client.simulateContract({
      contractId: CONTRACT_ID,
      method: 'get_escrow',
      args: [ORDER_ID_HEX],
    });

    expect((result as EscrowRecord).status).toBe('Released');
  });

  it('decodes Refunded status from scvVec(["Refunded"]) to EscrowRecord.status = "Refunded"', async () => {
    mockServerMethods.simulateTransaction.mockResolvedValue(
      makeSimSuccessWithRetval(buildEscrowRecordScVal('Refunded')),
    );

    const { result } = await client.simulateContract({
      contractId: CONTRACT_ID,
      method: 'get_escrow',
      args: [ORDER_ID_HEX],
    });

    expect((result as EscrowRecord).status).toBe('Refunded');
  });

  it('round-trips all numeric and address fields correctly for a Held record', async () => {
    mockServerMethods.simulateTransaction.mockResolvedValue(
      makeSimSuccessWithRetval(buildEscrowRecordScVal('Held')),
    );

    const { result } = await client.simulateContract({
      contractId: CONTRACT_ID,
      method: 'get_escrow',
      args: [ORDER_ID_HEX],
    });

    const record = result as EscrowRecord;
    expect(record.payer).toBe(PAYER_KEY);
    expect(record.merchant).toBe(MERCHANT_KEY);
    expect(record.token).toBe(TOKEN_ID);
    expect(record.amount).toBe(1_000_000n);
    expect(record.deposited_at).toBe(500);
    expect(record.timeout_ledgers).toBe(100);
  });

  // ── Invalid status shapes ───────────────────────────────────────────────────

  it('throws SIMULATION_FAILED with offending value for empty-array status []', async () => {
    // scValToNative(scvVec([])) → []
    const scval = buildRecordWithRawStatus(xdr.ScVal.scvVec([]));
    mockServerMethods.simulateTransaction.mockResolvedValue(makeSimSuccessWithRetval(scval));

    await expect(
      client.simulateContract({ contractId: CONTRACT_ID, method: 'get_escrow', args: [ORDER_ID_HEX] }),
    ).rejects.toMatchObject({
      name: 'EscrowRpcError',
      kind: 'SIMULATION_FAILED',
      detail: expect.stringContaining('[]'),
    });
  });

  it('throws SIMULATION_FAILED with offending value for two-element array ["Held","Extra"]', async () => {
    const scval = buildRecordWithRawStatus(
      xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Held'), xdr.ScVal.scvSymbol('Extra')]),
    );
    mockServerMethods.simulateTransaction.mockResolvedValue(makeSimSuccessWithRetval(scval));

    await expect(
      client.simulateContract({ contractId: CONTRACT_ID, method: 'get_escrow', args: [ORDER_ID_HEX] }),
    ).rejects.toMatchObject({
      kind: 'SIMULATION_FAILED',
      detail: expect.stringContaining('Held'),
    });
  });

  it('throws SIMULATION_FAILED with offending value for unknown tag ["Pending"]', async () => {
    // 'Pending' is not a known EscrowStatus variant
    const scval = buildRecordWithRawStatus(
      xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Pending')]),
    );
    mockServerMethods.simulateTransaction.mockResolvedValue(makeSimSuccessWithRetval(scval));

    await expect(
      client.simulateContract({ contractId: CONTRACT_ID, method: 'get_escrow', args: [ORDER_ID_HEX] }),
    ).rejects.toMatchObject({
      kind: 'SIMULATION_FAILED',
      detail: expect.stringContaining('Pending'),
    });
  });

  it('throws SIMULATION_FAILED with offending value for numeric status (42)', async () => {
    // scValToNative(scvU32(42)) → 42
    const scval = buildRecordWithRawStatus(nativeToScVal(42, { type: 'u32' }));
    mockServerMethods.simulateTransaction.mockResolvedValue(makeSimSuccessWithRetval(scval));

    await expect(
      client.simulateContract({ contractId: CONTRACT_ID, method: 'get_escrow', args: [ORDER_ID_HEX] }),
    ).rejects.toMatchObject({
      kind: 'SIMULATION_FAILED',
      detail: expect.stringContaining('42'),
    });
  });

  it('throws SIMULATION_FAILED with offending value for null status', async () => {
    // scValToNative(scvVoid()) → null
    const scval = buildRecordWithRawStatus(xdr.ScVal.scvVoid());
    mockServerMethods.simulateTransaction.mockResolvedValue(makeSimSuccessWithRetval(scval));

    await expect(
      client.simulateContract({ contractId: CONTRACT_ID, method: 'get_escrow', args: [ORDER_ID_HEX] }),
    ).rejects.toMatchObject({
      kind: 'SIMULATION_FAILED',
      detail: expect.stringContaining('Cannot decode escrow status'),
    });
  });
});

// ─── Public path: EscrowClient.getEscrow ─────────────────────────────────────
// Exercises the full chain: EscrowClient → HttpSorobanRpcClient.simulateContract
// → scValToNative → _decodeEscrowRecord → EscrowRecord

describe('EscrowClient.getEscrow — full decode path with real ScVal input', () => {
  let rpcClient: HttpSorobanRpcClient;
  let escrowClient: EscrowClient;

  beforeEach(() => {
    rpcClient = new HttpSorobanRpcClient(RPC_URL, 'testnet');
    escrowClient = new EscrowClient({
      rpcClient,
      contractId: CONTRACT_ID,
      network: 'testnet',
    });
  });

  it('getEscrow returns correct EscrowRecord for a Held escrow from real ScVal', async () => {
    // The mock returns the XDR ScVal directly — the simulateContract
    // implementation calls scValToNative on it and passes the result to
    // _decodeEscrowRecord.  This exercises the full decode path.
    mockServerMethods.simulateTransaction.mockResolvedValue(
      makeSimSuccessWithRetval(buildEscrowRecordScVal('Held')),
    );

    const record = await escrowClient.getEscrow(ORDER_ID_HEX);

    expect(record.status).toBe('Held');
    expect(record.payer).toBe(PAYER_KEY);
    expect(record.merchant).toBe(MERCHANT_KEY);
    expect(record.token).toBe(TOKEN_ID);
    expect(record.amount).toBe(1_000_000n);
    expect(record.deposited_at).toBe(500);
    expect(record.timeout_ledgers).toBe(100);
  });

  it('getEscrow returns status "Released" for a released escrow', async () => {
    mockServerMethods.simulateTransaction.mockResolvedValue(
      makeSimSuccessWithRetval(buildEscrowRecordScVal('Released')),
    );
    const record = await escrowClient.getEscrow(ORDER_ID_HEX);
    expect(record.status).toBe('Released');
  });

  it('getEscrow returns status "Refunded" for a refunded escrow', async () => {
    mockServerMethods.simulateTransaction.mockResolvedValue(
      makeSimSuccessWithRetval(buildEscrowRecordScVal('Refunded')),
    );
    const record = await escrowClient.getEscrow(ORDER_ID_HEX);
    expect(record.status).toBe('Refunded');
  });

  it('getEscrow throws SIMULATION_FAILED when status ScVal is an empty array', async () => {
    mockServerMethods.simulateTransaction.mockResolvedValue(
      makeSimSuccessWithRetval(buildRecordWithRawStatus(xdr.ScVal.scvVec([]))),
    );
    await expect(escrowClient.getEscrow(ORDER_ID_HEX)).rejects.toMatchObject({
      kind: 'SIMULATION_FAILED',
    });
  });
});

// ─── Sanity: scValToNative shape confirmation ─────────────────────────────────
// These tests do NOT go through the decoder — they confirm the SDK output
// shape that the fix relies on, so a future SDK upgrade that changes the
// shape will fail here before anything else breaks.

describe('scValToNative shape contract (SDK sanity)', () => {
  it('scvVec([scvSymbol("Held")]) → ["Held"] (single-element string array)', () => {
    const val = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Held')]);
    const native = scValToNative(val);
    expect(Array.isArray(native)).toBe(true);
    expect((native as unknown[])[0]).toBe('Held');
    expect((native as unknown[]).length).toBe(1);
  });

  it('scvVec([scvSymbol("Released")]) → ["Released"]', () => {
    const native = scValToNative(xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Released')]));
    expect(native).toEqual(['Released']);
  });

  it('scvVec([scvSymbol("Refunded")]) → ["Refunded"]', () => {
    const native = scValToNative(xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Refunded')]));
    expect(native).toEqual(['Refunded']);
  });

  it('i128 amount 1_000_000n → bigint 1_000_000n', () => {
    const native = scValToNative(nativeToScVal(1_000_000n, { type: 'i128' }));
    expect(typeof native).toBe('bigint');
    expect(native).toBe(1_000_000n);
  });

  it('address (G... account key) → string G...', () => {
    const native = scValToNative(nativeToScVal(PAYER_KEY, { type: 'address' }));
    expect(typeof native).toBe('string');
    expect(native).toBe(PAYER_KEY);
  });

  it('address (C... contract key) → string C...', () => {
    const native = scValToNative(nativeToScVal(TOKEN_ID, { type: 'address' }));
    expect(typeof native).toBe('string');
    expect(native).toBe(TOKEN_ID);
  });

  it('u32 100 → number 100', () => {
    const native = scValToNative(nativeToScVal(100, { type: 'u32' }));
    expect(typeof native).toBe('number');
    expect(native).toBe(100);
  });

  it('scvVec([]) → []  (empty vec, NOT a valid status)', () => {
    const native = scValToNative(xdr.ScVal.scvVec([]));
    expect(native).toEqual([]);
  });

  it('scvVec([sym, sym]) → two-element array  (NOT a valid unit-variant status)', () => {
    const native = scValToNative(
      xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Held'), xdr.ScVal.scvSymbol('Extra')]),
    );
    expect(Array.isArray(native)).toBe(true);
    expect((native as unknown[]).length).toBe(2);
  });

  it('Networks.TESTNET passphrase is the expected string', () => {
    expect(Networks.TESTNET).toBe('Test SDF Network ; September 2015');
  });
});
