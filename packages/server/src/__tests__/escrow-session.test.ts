/**
 * escrow-session.test.ts
 *
 * TypeScript tests for EscrowCheckoutSession and EscrowClient.
 *
 * All Soroban RPC calls are mocked — no network calls are made.
 * This is consistent with how the existing Horizon tests mock stellar-sdk.
 *
 * What is tested:
 *   - Full session lifecycle: pending → deposit confirmed → merchant releases → fulfilled
 *   - Merchant voluntary refund path: deposited → refunded
 *   - Error handling: contract errors mapped to EscrowClientError with correct codes
 *   - EscrowClient.getEscrow() maps on-chain record to session status
 *   - sessionIdToOrderIdHex produces consistent 64-char hex output
 *   - escrowRecordToSessionStatus maps all three EscrowStatus values
 *   - EscrowClientError carries correct code, codeName, and message
 *
 * What is NOT tested here:
 *   - Real Soroban RPC wire format (that's an integration test against a live node)
 *   - Transaction signing (non-custodial invariant — signing is in the wallet)
 *   - The Rust contract logic (covered by the Rust test suite in contracts/escrow)
 */

import {
  EscrowClient,
  EscrowClientError,
  ESCROW_ERROR_CODES,
  type EscrowCheckoutSession,
  type EscrowRecord,
  type SorobanRpcClient,
  escrowRecordToSessionStatus,
  sessionIdToOrderIdHex,
} from '../escrow-session';

// ─── Test constants ───────────────────────────────────────────────────────────

const CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const PAYER = 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGBFS67X3RJ1YIJ2HXKOL6';
const MERCHANT = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const TOKEN = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
const ORDER_ID_HEX = sessionIdToOrderIdHex(1n);
const DEPOSIT_AMOUNT = 500_000_000n; // 50 USDC in stroops

// ─── Mock factory ─────────────────────────────────────────────────────────────

/**
 * Create a mock SorobanRpcClient.
 * All methods return jest.fn() so tests can configure return values and
 * assert on calls.
 */
function createMockRpc(): jest.Mocked<SorobanRpcClient> {
  return {
    invokeContract: jest.fn(),
    simulateContract: jest.fn(),
  };
}

/**
 * Build a mock on-chain EscrowRecord with sensible defaults.
 */
function makeEscrowRecord(overrides: Partial<EscrowRecord> = {}): EscrowRecord {
  return {
    payer: PAYER,
    merchant: MERCHANT,
    amount: DEPOSIT_AMOUNT,
    token: TOKEN,
    status: 'Held',
    deposited_at: 1_000,
    timeout_ledgers: 518_400,
    ...overrides,
  };
}

// ─── EscrowClient — deposit ───────────────────────────────────────────────────

describe('EscrowClient.deposit()', () => {
  let rpc: jest.Mocked<SorobanRpcClient>;
  let client: EscrowClient;

  beforeEach(() => {
    rpc = createMockRpc();
    client = new EscrowClient({ rpcClient: rpc, contractId: CONTRACT_ID, network: 'testnet' });
  });

  it('invokes the contract with the correct method and args', async () => {
    rpc.invokeContract.mockResolvedValue({ txHash: 'txhash-abc', status: 'success' });

    const hash = await client.deposit(PAYER, MERCHANT, DEPOSIT_AMOUNT, TOKEN, ORDER_ID_HEX, 0);

    expect(hash).toBe('txhash-abc');
    expect(rpc.invokeContract).toHaveBeenCalledTimes(1);
    expect(rpc.invokeContract).toHaveBeenCalledWith(
      expect.objectContaining({
        contractId: CONTRACT_ID,
        method: 'deposit',
        signerAddress: PAYER,
        args: expect.arrayContaining([PAYER, MERCHANT, DEPOSIT_AMOUNT.toString(), TOKEN, ORDER_ID_HEX, 0]),
      }),
    );
  });

  it('uses the default timeout (0) when not specified', async () => {
    rpc.invokeContract.mockResolvedValue({ txHash: 'txhash-def', status: 'success' });

    await client.deposit(PAYER, MERCHANT, DEPOSIT_AMOUNT, TOKEN, ORDER_ID_HEX);

    const call = rpc.invokeContract.mock.calls[0]![0];
    expect(call.args).toContain(0); // default timeout_ledgers
  });

  it('throws EscrowClientError with AlreadyExists code on duplicate deposit', async () => {
    rpc.invokeContract.mockResolvedValue({
      txHash: '',
      status: 'failed',
      errorCode: ESCROW_ERROR_CODES.AlreadyExists,
    });

    await expect(
      client.deposit(PAYER, MERCHANT, DEPOSIT_AMOUNT, TOKEN, ORDER_ID_HEX),
    ).rejects.toThrow(EscrowClientError);

    await expect(
      client.deposit(PAYER, MERCHANT, DEPOSIT_AMOUNT, TOKEN, ORDER_ID_HEX),
    ).rejects.toMatchObject({
      operation: 'deposit',
      code: ESCROW_ERROR_CODES.AlreadyExists,
      codeName: 'AlreadyExists',
    });
  });

  it('returns the transaction hash on success', async () => {
    const expectedHash = 'abc123def456';
    rpc.invokeContract.mockResolvedValue({ txHash: expectedHash, status: 'success' });

    const result = await client.deposit(PAYER, MERCHANT, 100n, TOKEN, ORDER_ID_HEX);
    expect(result).toBe(expectedHash);
  });
});

// ─── EscrowClient — release ───────────────────────────────────────────────────

describe('EscrowClient.release()', () => {
  let rpc: jest.Mocked<SorobanRpcClient>;
  let client: EscrowClient;

  beforeEach(() => {
    rpc = createMockRpc();
    client = new EscrowClient({ rpcClient: rpc, contractId: CONTRACT_ID, network: 'testnet' });
  });

  it('invokes release with the order ID and merchant as signer', async () => {
    rpc.invokeContract.mockResolvedValue({ txHash: 'release-hash', status: 'success' });

    const hash = await client.release(ORDER_ID_HEX, MERCHANT);

    expect(hash).toBe('release-hash');
    expect(rpc.invokeContract).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'release',
        args: [ORDER_ID_HEX],
        signerAddress: MERCHANT,
      }),
    );
  });

  it('throws EscrowClientError(AlreadyReleased) when escrow already released', async () => {
    rpc.invokeContract.mockResolvedValue({
      txHash: '',
      status: 'failed',
      errorCode: ESCROW_ERROR_CODES.AlreadyReleased,
    });

    await expect(client.release(ORDER_ID_HEX, MERCHANT)).rejects.toMatchObject({
      name: 'EscrowClientError',
      operation: 'release',
      code: ESCROW_ERROR_CODES.AlreadyReleased,
      codeName: 'AlreadyReleased',
    });
  });

  it('throws EscrowClientError(AlreadyRefunded) when escrow already refunded', async () => {
    rpc.invokeContract.mockResolvedValue({
      txHash: '',
      status: 'failed',
      errorCode: ESCROW_ERROR_CODES.AlreadyRefunded,
    });

    await expect(client.release(ORDER_ID_HEX, MERCHANT)).rejects.toMatchObject({
      code: ESCROW_ERROR_CODES.AlreadyRefunded,
      codeName: 'AlreadyRefunded',
    });
  });

  it('throws EscrowClientError(NotFound) for unknown order_id', async () => {
    rpc.invokeContract.mockResolvedValue({
      txHash: '',
      status: 'failed',
      errorCode: ESCROW_ERROR_CODES.NotFound,
    });

    await expect(client.release('0000000000000000000000000000000000000000000000000000000000000099', MERCHANT))
      .rejects.toMatchObject({ code: ESCROW_ERROR_CODES.NotFound });
  });
});

// ─── EscrowClient — refund ────────────────────────────────────────────────────

describe('EscrowClient.refund()', () => {
  let rpc: jest.Mocked<SorobanRpcClient>;
  let client: EscrowClient;

  beforeEach(() => {
    rpc = createMockRpc();
    client = new EscrowClient({ rpcClient: rpc, contractId: CONTRACT_ID, network: 'testnet' });
  });

  it('merchant voluntary refund — invokes refund with merchant as caller and signer', async () => {
    rpc.invokeContract.mockResolvedValue({ txHash: 'refund-hash', status: 'success' });

    const hash = await client.refund(ORDER_ID_HEX, MERCHANT);

    expect(hash).toBe('refund-hash');
    expect(rpc.invokeContract).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'refund',
        args: [ORDER_ID_HEX, MERCHANT],
        signerAddress: MERCHANT,
      }),
    );
  });

  it('payer refund after timeout — invokes refund with payer as caller and signer', async () => {
    rpc.invokeContract.mockResolvedValue({ txHash: 'payer-refund-hash', status: 'success' });

    const hash = await client.refund(ORDER_ID_HEX, PAYER);

    expect(rpc.invokeContract).toHaveBeenCalledWith(
      expect.objectContaining({
        args: [ORDER_ID_HEX, PAYER],
        signerAddress: PAYER,
      }),
    );
    expect(hash).toBe('payer-refund-hash');
  });

  it('throws EscrowClientError(TimeoutNotElapsed) when payer refunds too early', async () => {
    rpc.invokeContract.mockResolvedValue({
      txHash: '',
      status: 'failed',
      errorCode: ESCROW_ERROR_CODES.TimeoutNotElapsed,
    });

    await expect(client.refund(ORDER_ID_HEX, PAYER)).rejects.toMatchObject({
      code: ESCROW_ERROR_CODES.TimeoutNotElapsed,
      codeName: 'TimeoutNotElapsed',
    });
  });

  it('throws EscrowClientError(NotAuthorized) when caller is neither payer nor merchant', async () => {
    rpc.invokeContract.mockResolvedValue({
      txHash: '',
      status: 'failed',
      errorCode: ESCROW_ERROR_CODES.NotAuthorized,
    });

    const randomAddress = 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
    await expect(client.refund(ORDER_ID_HEX, randomAddress)).rejects.toMatchObject({
      code: ESCROW_ERROR_CODES.NotAuthorized,
      codeName: 'NotAuthorized',
    });
  });
});

// ─── EscrowClient — getEscrow ─────────────────────────────────────────────────

describe('EscrowClient.getEscrow()', () => {
  let rpc: jest.Mocked<SorobanRpcClient>;
  let client: EscrowClient;

  beforeEach(() => {
    rpc = createMockRpc();
    client = new EscrowClient({ rpcClient: rpc, contractId: CONTRACT_ID, network: 'testnet' });
  });

  it('calls simulateContract (read-only) with get_escrow method', async () => {
    const record = makeEscrowRecord();
    rpc.simulateContract.mockResolvedValue({ result: record });

    const result = await client.getEscrow(ORDER_ID_HEX);

    expect(rpc.simulateContract).toHaveBeenCalledWith(
      expect.objectContaining({
        contractId: CONTRACT_ID,
        method: 'get_escrow',
        args: [ORDER_ID_HEX],
      }),
    );
    expect(result).toEqual(record);
  });

  it('returns Held status for a freshly deposited escrow', async () => {
    rpc.simulateContract.mockResolvedValue({ result: makeEscrowRecord({ status: 'Held' }) });

    const record = await client.getEscrow(ORDER_ID_HEX);
    expect(record.status).toBe('Held');
    expect(record.amount).toBe(DEPOSIT_AMOUNT);
    expect(record.payer).toBe(PAYER);
    expect(record.merchant).toBe(MERCHANT);
  });

  it('returns Released status after release', async () => {
    rpc.simulateContract.mockResolvedValue({ result: makeEscrowRecord({ status: 'Released' }) });

    const record = await client.getEscrow(ORDER_ID_HEX);
    expect(record.status).toBe('Released');
  });

  it('returns Refunded status after refund', async () => {
    rpc.simulateContract.mockResolvedValue({ result: makeEscrowRecord({ status: 'Refunded' }) });

    const record = await client.getEscrow(ORDER_ID_HEX);
    expect(record.status).toBe('Refunded');
  });

  it('does NOT call invokeContract (must be read-only)', async () => {
    rpc.simulateContract.mockResolvedValue({ result: makeEscrowRecord() });

    await client.getEscrow(ORDER_ID_HEX);

    expect(rpc.invokeContract).not.toHaveBeenCalled();
  });
});

// ─── Full session lifecycle ───────────────────────────────────────────────────

describe('EscrowCheckoutSession lifecycle — mock end-to-end', () => {
  let rpc: jest.Mocked<SorobanRpcClient>;
  let client: EscrowClient;
  let session: EscrowCheckoutSession;

  beforeEach(() => {
    rpc = createMockRpc();
    client = new EscrowClient({ rpcClient: rpc, contractId: CONTRACT_ID, network: 'testnet' });

    // Build a mock session (in real code this would be created by the server)
    session = {
      sessionId: '1',
      orderId: ORDER_ID_HEX,
      payerAddress: PAYER,
      merchantAddress: MERCHANT,
      tokenContractId: TOKEN,
      amount: DEPOSIT_AMOUNT.toString(),
      network: 'testnet',
      status: 'pending',
      createdAt: new Date().toISOString(),
      contractId: CONTRACT_ID,
    };
  });

  it('full happy path: deposit confirmed → merchant releases → session fulfilled', async () => {
    // Step 1: Deposit (payer signs)
    rpc.invokeContract.mockResolvedValueOnce({ txHash: 'deposit-hash', status: 'success' });
    const depositHash = await client.deposit(
      session.payerAddress,
      session.merchantAddress,
      BigInt(session.amount),
      session.tokenContractId,
      session.orderId,
    );
    expect(depositHash).toBe('deposit-hash');

    // Step 2: Confirm deposit by reading on-chain status → session becomes 'deposited'
    rpc.simulateContract.mockResolvedValueOnce({
      result: makeEscrowRecord({ status: 'Held' }),
    });
    const record = await client.getEscrow(session.orderId);
    session = { ...session, status: escrowRecordToSessionStatus(record) };
    expect(session.status).toBe('deposited');

    // Step 3: Merchant releases funds after fulfilment
    rpc.invokeContract.mockResolvedValueOnce({ txHash: 'release-hash', status: 'success' });
    const releaseHash = await client.release(session.orderId, session.merchantAddress);
    expect(releaseHash).toBe('release-hash');

    // Step 4: Confirm release by reading on-chain status → session becomes 'fulfilled'
    rpc.simulateContract.mockResolvedValueOnce({
      result: makeEscrowRecord({ status: 'Released' }),
    });
    const releasedRecord = await client.getEscrow(session.orderId);
    session = { ...session, status: escrowRecordToSessionStatus(releasedRecord) };
    expect(session.status).toBe('fulfilled');
  });

  it('merchant voluntary refund path: deposit → merchant refunds → session refunded', async () => {
    // Step 1: Deposit
    rpc.invokeContract.mockResolvedValueOnce({ txHash: 'deposit-hash', status: 'success' });
    await client.deposit(
      session.payerAddress,
      session.merchantAddress,
      BigInt(session.amount),
      session.tokenContractId,
      session.orderId,
    );

    // Step 2: Confirm deposit by querying on-chain status
    rpc.simulateContract.mockResolvedValueOnce({
      result: makeEscrowRecord({ status: 'Held' }),
    });
    const heldRecord = await client.getEscrow(session.orderId);
    session = { ...session, status: escrowRecordToSessionStatus(heldRecord) };
    expect(session.status).toBe('deposited');

    // Step 3: Merchant decides to refund (e.g. stock out, can't fulfil)
    rpc.invokeContract.mockResolvedValueOnce({ txHash: 'refund-hash', status: 'success' });
    const refundHash = await client.refund(session.orderId, session.merchantAddress);
    expect(refundHash).toBe('refund-hash');

    // Step 4: Confirm refund by querying on-chain status
    rpc.simulateContract.mockResolvedValueOnce({
      result: makeEscrowRecord({ status: 'Refunded' }),
    });
    const refundedRecord = await client.getEscrow(session.orderId);
    session = { ...session, status: escrowRecordToSessionStatus(refundedRecord) };
    expect(session.status).toBe('refunded');
  });

  it('double release is blocked by the contract', async () => {
    // First release succeeds
    rpc.invokeContract.mockResolvedValueOnce({ txHash: 'release-hash', status: 'success' });
    await client.release(session.orderId, MERCHANT);

    // Second release fails with AlreadyReleased
    rpc.invokeContract.mockResolvedValueOnce({
      txHash: '',
      status: 'failed',
      errorCode: ESCROW_ERROR_CODES.AlreadyReleased,
    });

    await expect(client.release(session.orderId, MERCHANT)).rejects.toMatchObject({
      code: ESCROW_ERROR_CODES.AlreadyReleased,
    });
  });

  it('deposit amount and token match exactly what the contract records', async () => {
    const expectedAmount = 1_234_567n;
    const expectedToken = TOKEN;

    rpc.invokeContract.mockResolvedValueOnce({ txHash: 'hash', status: 'success' });
    rpc.simulateContract.mockResolvedValueOnce({
      result: makeEscrowRecord({ amount: expectedAmount, token: expectedToken }),
    });

    await client.deposit(PAYER, MERCHANT, expectedAmount, expectedToken, ORDER_ID_HEX);
    const record = await client.getEscrow(ORDER_ID_HEX);

    expect(record.amount).toBe(expectedAmount);
    expect(record.token).toBe(expectedToken);
  });
});

// ─── Utilities ────────────────────────────────────────────────────────────────

describe('escrowRecordToSessionStatus()', () => {
  it('maps Held → deposited', () => {
    expect(escrowRecordToSessionStatus(makeEscrowRecord({ status: 'Held' }))).toBe('deposited');
  });

  it('maps Released → fulfilled', () => {
    expect(escrowRecordToSessionStatus(makeEscrowRecord({ status: 'Released' }))).toBe('fulfilled');
  });

  it('maps Refunded → refunded', () => {
    expect(escrowRecordToSessionStatus(makeEscrowRecord({ status: 'Refunded' }))).toBe('refunded');
  });
});

describe('sessionIdToOrderIdHex()', () => {
  it('returns a 64-character hex string', () => {
    const hex = sessionIdToOrderIdHex(1n);
    expect(hex).toHaveLength(64);
    expect(hex).toMatch(/^[0-9a-f]+$/);
  });

  it('is deterministic — same input always gives same output', () => {
    expect(sessionIdToOrderIdHex(42n)).toBe(sessionIdToOrderIdHex(42n));
    expect(sessionIdToOrderIdHex('99')).toBe(sessionIdToOrderIdHex(99n));
  });

  it('produces different hashes for different session IDs', () => {
    expect(sessionIdToOrderIdHex(1n)).not.toBe(sessionIdToOrderIdHex(2n));
    expect(sessionIdToOrderIdHex(100n)).not.toBe(sessionIdToOrderIdHex(101n));
  });

  it('accepts both bigint and string inputs', () => {
    expect(sessionIdToOrderIdHex('7')).toBe(sessionIdToOrderIdHex(7n));
  });
});

// ─── EscrowClientError ────────────────────────────────────────────────────────

describe('EscrowClientError', () => {
  it('carries operation, code, and codeName', () => {
    const err = new EscrowClientError('deposit', ESCROW_ERROR_CODES.AlreadyExists);
    expect(err.operation).toBe('deposit');
    expect(err.code).toBe(ESCROW_ERROR_CODES.AlreadyExists);
    expect(err.codeName).toBe('AlreadyExists');
    expect(err.message).toContain('deposit');
    expect(err.message).toContain('AlreadyExists');
  });

  it('has name EscrowClientError for instanceof checks', () => {
    const err = new EscrowClientError('release', ESCROW_ERROR_CODES.NotFound);
    expect(err.name).toBe('EscrowClientError');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(EscrowClientError);
  });

  it('handles unknown error codes gracefully', () => {
    const err = new EscrowClientError('refund', 999);
    expect(err.codeName).toContain('Unknown');
    expect(err.message).toContain('999');
  });

  it('all defined error codes have readable names', () => {
    for (const [name, code] of Object.entries(ESCROW_ERROR_CODES)) {
      const err = new EscrowClientError('test', code);
      expect(err.codeName).toBe(name);
    }
  });
});

// ─── Network configuration ────────────────────────────────────────────────────

describe('EscrowClient network configuration', () => {
  it('stores the network on the client instance', () => {
    const rpc = createMockRpc();
    const client = new EscrowClient({ rpcClient: rpc, contractId: CONTRACT_ID, network: 'mainnet' });
    expect(client.network).toBe('mainnet');
  });

  it('testnet and mainnet are both valid networks', () => {
    const rpc = createMockRpc();
    const testnetClient = new EscrowClient({ rpcClient: rpc, contractId: CONTRACT_ID, network: 'testnet' });
    const mainnetClient = new EscrowClient({ rpcClient: rpc, contractId: CONTRACT_ID, network: 'mainnet' });
    expect(testnetClient.network).toBe('testnet');
    expect(mainnetClient.network).toBe('mainnet');
  });
});
