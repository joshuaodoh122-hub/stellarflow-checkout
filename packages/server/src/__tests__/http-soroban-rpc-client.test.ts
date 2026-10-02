/**
 * http-soroban-rpc-client.test.ts
 *
 * Unit tests for HttpSorobanRpcClient.
 *
 * SorobanRpc.Server is mocked at the module level — no real network calls.
 *
 * Verified behaviours:
 *   simulateContract:
 *     - calls rpc.simulateTransaction with a Transaction object
 *     - throws EscrowRpcError(SIMULATION_FAILED) on simulation error response
 *     - throws EscrowRpcError(NETWORK_ERROR) on network throw
 *
 *   buildUnsignedContractTx:
 *     - loads caller account via getAccount
 *     - calls simulateTransaction; returns unsignedXdr + networkPassphrase
 *     - throws EscrowRpcError(NETWORK_ERROR) when getAccount throws
 *     - throws EscrowRpcError(SIMULATION_FAILED) on generic sim error
 *     - maps "Error(Contract, #N)" in sim error to EscrowClientError(code N)
 *     - payload sent to simulateTransaction is a Transaction object
 *
 *   submitSignedTx:
 *     - throws EscrowRpcError(INVALID_XDR) for bad XDR
 *     - sends parsed Transaction (not raw string) to sendTransaction
 *     - polls getTransaction with the hash returned by sendTransaction
 *     - SUCCESS → returns { txHash }
 *     - FAILED  → throws EscrowRpcError(TX_FAILED)
 *     - SEND ERROR status → throws EscrowRpcError(SEND_FAILED)
 *     - polls through NOT_FOUND before SUCCESS
 *
 *   invokeContract:
 *     - returns { status:'failed', errorCode } when build throws EscrowClientError
 *       and does NOT call the signer
 *     - calls signer with unsigned XDR string and submits the result
 *     - returns { status:'failed' } on TX_FAILED
 *
 *   EscrowRpcError:
 *     - carries kind, detail, name
 *     - covers all six EscrowRpcErrorKind values
 */

import {
  HttpSorobanRpcClient,
  EscrowRpcError,
  EscrowClientError,
  ESCROW_ERROR_CODES,
} from '../escrow-session';
import {
  SorobanRpc,
  TransactionBuilder,
  Networks,
  Keypair,
  Account,
} from 'stellar-sdk';

// ─── Constants ────────────────────────────────────────────────────────────────

const CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const PAYER = Keypair.random().publicKey();
const NETWORK_PASSPHRASE = Networks.TESTNET;
const RPC_URL = 'https://soroban-testnet.stellar.org';
const ORDER_ID_HEX = '00'.repeat(32);

/** Minimal valid unsigned tx XDR for submit tests. */
function buildMinimalXdr(): string {
  const acct = new Account(PAYER, '100');
  const tx = new TransactionBuilder(acct, {
    fee: '100',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .setTimeout(30)
    .build();
  return tx.toXDR();
}

// ─── Stub factories ───────────────────────────────────────────────────────────
// We use `as unknown as X` casts throughout so the stubs compile without
// replicating every internal SDK field.

function makeSimSuccess(): SorobanRpc.Api.SimulateTransactionResponse {
  return {
    id: '1',
    latestLedger: 100,
    // SorobanDataBuilder stub — assembleTransaction reads .toXDR()
    transactionData: { toXDR: () => Buffer.alloc(0) },
    minResourceFee: '200',
    cost: { cpuInsns: '0', memBytes: '0' },
    result: { auth: [], retval: undefined },
    events: [],
  } as unknown as SorobanRpc.Api.SimulateTransactionResponse;
}

function makeSimError(msg: string): SorobanRpc.Api.SimulateTransactionResponse {
  return { id: '1', latestLedger: 100, error: msg, events: [] } as unknown as SorobanRpc.Api.SimulateTransactionResponse;
}

function makeSendPending(hash: string): SorobanRpc.Api.SendTransactionResponse {
  return { hash, status: 'PENDING', latestLedger: 100, latestLedgerCloseTime: 1000 } as unknown as SorobanRpc.Api.SendTransactionResponse;
}

function makeSendError(): SorobanRpc.Api.SendTransactionResponse {
  return {
    hash: '',
    status: 'ERROR',
    latestLedger: 100,
    latestLedgerCloseTime: 1000,
    errorResult: { result: () => ({ switch: () => ({ name: 'txFailed' }) }) },
  } as unknown as SorobanRpc.Api.SendTransactionResponse;
}

function makeGetTx(status: SorobanRpc.Api.GetTransactionStatus): SorobanRpc.Api.GetTransactionResponse {
  return {
    status,
    latestLedger: 101,
    latestLedgerCloseTime: 1010,
    oldestLedger: 1,
    oldestLedgerCloseTime: 1,
  } as unknown as SorobanRpc.Api.GetTransactionResponse;
}

// ─── Module-level mock ────────────────────────────────────────────────────────

/**
 * Mock SorobanRpc.Server so every new HttpSorobanRpcClient gets the same
 * mockServerMethods object — no real HTTP calls are made.
 */
const mockServerMethods = {
  getAccount: jest.fn(),
  simulateTransaction: jest.fn(),
  sendTransaction: jest.fn(),
  getTransaction: jest.fn(),
};

jest.mock('stellar-sdk', () => {
  const actual = jest.requireActual<typeof import('stellar-sdk')>('stellar-sdk');

  // assembleTransaction is called after simulation to inject the footprint.
  // In tests we stub it to return a { build: () => tx } so no real XDR parsing happens.
  const assembleTransactionStub = jest.fn().mockImplementation(
    (tx: import('stellar-sdk').Transaction) => ({
      build: () => tx,
    }),
  );

  return {
    ...actual,
    SorobanRpc: {
      ...actual.SorobanRpc,
      Server: jest.fn().mockImplementation(() => mockServerMethods),
      assembleTransaction: assembleTransactionStub,
    },
  };
});

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── simulateContract ─────────────────────────────────────────────────────────

describe('HttpSorobanRpcClient.simulateContract()', () => {
  let client: HttpSorobanRpcClient;

  beforeEach(() => {
    client = new HttpSorobanRpcClient(RPC_URL, 'testnet');
  });

  it('sends a Transaction object to simulateTransaction', async () => {
    mockServerMethods.simulateTransaction.mockResolvedValue(makeSimSuccess());
    // Result decoding may throw because retval is undefined — that's fine here,
    // we only care that simulateTransaction was called with a tx object.
    await client.simulateContract({
      contractId: CONTRACT_ID,
      method: 'get_escrow',
      args: [ORDER_ID_HEX],
    }).catch(() => { /* decoding stub retval throws — expected */ });

    expect(mockServerMethods.simulateTransaction).toHaveBeenCalledTimes(1);
    const arg = mockServerMethods.simulateTransaction.mock.calls[0]?.[0];
    expect(typeof (arg as { toXDR?: unknown }).toXDR).toBe('function');
  });

  it('throws EscrowRpcError(SIMULATION_FAILED) on simulation error response', async () => {
    mockServerMethods.simulateTransaction.mockResolvedValue(makeSimError('HostError: bad'));

    await expect(
      client.simulateContract({ contractId: CONTRACT_ID, method: 'get_escrow', args: [ORDER_ID_HEX] }),
    ).rejects.toMatchObject({ name: 'EscrowRpcError', kind: 'SIMULATION_FAILED' });
  });

  it('throws EscrowRpcError(NETWORK_ERROR) when simulateTransaction throws', async () => {
    mockServerMethods.simulateTransaction.mockRejectedValue(new Error('network timeout'));

    await expect(
      client.simulateContract({ contractId: CONTRACT_ID, method: 'get_escrow', args: [ORDER_ID_HEX] }),
    ).rejects.toMatchObject({ kind: 'NETWORK_ERROR' });
  });
});

// ─── buildUnsignedContractTx ──────────────────────────────────────────────────

describe('HttpSorobanRpcClient.buildUnsignedContractTx()', () => {
  let client: HttpSorobanRpcClient;

  beforeEach(() => {
    client = new HttpSorobanRpcClient(RPC_URL, 'testnet');
  });

  it('loads the caller account and returns unsignedXdr + networkPassphrase', async () => {
    mockServerMethods.getAccount.mockResolvedValue(new Account(PAYER, '100'));
    mockServerMethods.simulateTransaction.mockResolvedValue(makeSimSuccess());

    const result = await client.buildUnsignedContractTx({
      contractId: CONTRACT_ID,
      method: 'deposit',
      args: [PAYER, PAYER, 100n, CONTRACT_ID, ORDER_ID_HEX, 0],
      callerAddress: PAYER,
    });

    expect(typeof result.unsignedXdr).toBe('string');
    expect(result.unsignedXdr.length).toBeGreaterThan(10);
    expect(result.networkPassphrase).toBe(Networks.TESTNET);
    expect(mockServerMethods.getAccount).toHaveBeenCalledWith(PAYER);
    expect(mockServerMethods.simulateTransaction).toHaveBeenCalledTimes(1);
  });

  it('sends a Transaction object to simulateTransaction', async () => {
    mockServerMethods.getAccount.mockResolvedValue(new Account(PAYER, '100'));
    mockServerMethods.simulateTransaction.mockResolvedValue(makeSimSuccess());

    await client.buildUnsignedContractTx({
      contractId: CONTRACT_ID,
      method: 'release',
      args: [ORDER_ID_HEX],
      callerAddress: PAYER,
    });

    const arg = mockServerMethods.simulateTransaction.mock.calls[0]?.[0];
    expect(typeof (arg as { toXDR?: unknown }).toXDR).toBe('function');
  });

  it('throws EscrowRpcError(NETWORK_ERROR) when getAccount throws', async () => {
    mockServerMethods.getAccount.mockRejectedValue(new Error('account not found'));

    await expect(
      client.buildUnsignedContractTx({ contractId: CONTRACT_ID, method: 'deposit', args: [], callerAddress: PAYER }),
    ).rejects.toMatchObject({ kind: 'NETWORK_ERROR' });
  });

  it('throws EscrowRpcError(SIMULATION_FAILED) on generic simulation error', async () => {
    mockServerMethods.getAccount.mockResolvedValue(new Account(PAYER, '100'));
    mockServerMethods.simulateTransaction.mockResolvedValue(makeSimError('HostError: generic'));

    await expect(
      client.buildUnsignedContractTx({
        contractId: CONTRACT_ID, method: 'deposit',
        args: [PAYER, PAYER, 100n, CONTRACT_ID, ORDER_ID_HEX, 0], callerAddress: PAYER,
      }),
    ).rejects.toMatchObject({ kind: 'SIMULATION_FAILED' });
  });

  it('maps Error(Contract, #1) in sim error to EscrowClientError(AlreadyExists)', async () => {
    mockServerMethods.getAccount.mockResolvedValue(new Account(PAYER, '100'));
    mockServerMethods.simulateTransaction.mockResolvedValue(makeSimError('HostError: Error(Contract, #1)'));

    await expect(
      client.buildUnsignedContractTx({
        contractId: CONTRACT_ID, method: 'deposit',
        args: [PAYER, PAYER, 100n, CONTRACT_ID, ORDER_ID_HEX, 0], callerAddress: PAYER,
      }),
    ).rejects.toMatchObject({ name: 'EscrowClientError', code: ESCROW_ERROR_CODES.AlreadyExists, codeName: 'AlreadyExists' });
  });

  it('maps Error(Contract, #2) to EscrowClientError(NotFound)', async () => {
    mockServerMethods.getAccount.mockResolvedValue(new Account(PAYER, '100'));
    mockServerMethods.simulateTransaction.mockResolvedValue(makeSimError('HostError: Error(Contract, #2)'));

    await expect(
      client.buildUnsignedContractTx({ contractId: CONTRACT_ID, method: 'get_escrow', args: [ORDER_ID_HEX], callerAddress: PAYER }),
    ).rejects.toMatchObject({ code: ESCROW_ERROR_CODES.NotFound, codeName: 'NotFound' });
  });

  it('maps Error(Contract, #7) to EscrowClientError(TimeoutNotElapsed)', async () => {
    mockServerMethods.getAccount.mockResolvedValue(new Account(PAYER, '100'));
    mockServerMethods.simulateTransaction.mockResolvedValue(makeSimError('HostError: Error(Contract, #7)'));

    await expect(
      client.buildUnsignedContractTx({ contractId: CONTRACT_ID, method: 'refund', args: [ORDER_ID_HEX, PAYER], callerAddress: PAYER }),
    ).rejects.toMatchObject({ code: ESCROW_ERROR_CODES.TimeoutNotElapsed, codeName: 'TimeoutNotElapsed' });
  });
});

// ─── submitSignedTx ───────────────────────────────────────────────────────────

describe('HttpSorobanRpcClient.submitSignedTx()', () => {
  let client: HttpSorobanRpcClient;

  beforeEach(() => {
    client = new HttpSorobanRpcClient(RPC_URL, 'testnet');
  });

  it('throws EscrowRpcError(INVALID_XDR) for unparseable XDR', async () => {
    await expect(
      client.submitSignedTx({ signedXdr: 'not-valid!!!', networkPassphrase: NETWORK_PASSPHRASE }),
    ).rejects.toMatchObject({ kind: 'INVALID_XDR' });
  });

  it('sends parsed Transaction object (not raw string) to sendTransaction', async () => {
    const TX_HASH = 'aaaa'.padEnd(64, '0');
    mockServerMethods.sendTransaction.mockResolvedValue(makeSendPending(TX_HASH));
    mockServerMethods.getTransaction.mockResolvedValue(makeGetTx(SorobanRpc.Api.GetTransactionStatus.SUCCESS));

    await client.submitSignedTx({ signedXdr: buildMinimalXdr(), networkPassphrase: NETWORK_PASSPHRASE });

    const sentArg = mockServerMethods.sendTransaction.mock.calls[0]?.[0];
    expect(typeof (sentArg as { toXDR?: unknown }).toXDR).toBe('function');
  });

  it('SUCCESS → returns { txHash }', async () => {
    const TX_HASH = 'success'.padEnd(64, '0');
    mockServerMethods.sendTransaction.mockResolvedValue(makeSendPending(TX_HASH));
    mockServerMethods.getTransaction.mockResolvedValue(makeGetTx(SorobanRpc.Api.GetTransactionStatus.SUCCESS));

    const result = await client.submitSignedTx({ signedXdr: buildMinimalXdr(), networkPassphrase: NETWORK_PASSPHRASE });
    expect(result.txHash).toBe(TX_HASH);
  });

  it('polls getTransaction with the hash from sendTransaction', async () => {
    const TX_HASH = 'pollhash'.padEnd(64, '0');
    mockServerMethods.sendTransaction.mockResolvedValue(makeSendPending(TX_HASH));
    mockServerMethods.getTransaction.mockResolvedValue(makeGetTx(SorobanRpc.Api.GetTransactionStatus.SUCCESS));

    await client.submitSignedTx({ signedXdr: buildMinimalXdr(), networkPassphrase: NETWORK_PASSPHRASE });
    expect(mockServerMethods.getTransaction).toHaveBeenCalledWith(TX_HASH);
  });

  it('SEND ERROR → throws EscrowRpcError(SEND_FAILED)', async () => {
    mockServerMethods.sendTransaction.mockResolvedValue(makeSendError());

    await expect(
      client.submitSignedTx({ signedXdr: buildMinimalXdr(), networkPassphrase: NETWORK_PASSPHRASE }),
    ).rejects.toMatchObject({ kind: 'SEND_FAILED' });
  });

  it('TX FAILED → throws EscrowRpcError(TX_FAILED)', async () => {
    const TX_HASH = 'failed'.padEnd(64, '0');
    mockServerMethods.sendTransaction.mockResolvedValue(makeSendPending(TX_HASH));
    mockServerMethods.getTransaction.mockResolvedValue(makeGetTx(SorobanRpc.Api.GetTransactionStatus.FAILED));

    await expect(
      client.submitSignedTx({ signedXdr: buildMinimalXdr(), networkPassphrase: NETWORK_PASSPHRASE }),
    ).rejects.toMatchObject({ kind: 'TX_FAILED' });
  });

  it('polls through NOT_FOUND before SUCCESS (3 polls total)', async () => {
    const TX_HASH = 'pending'.padEnd(64, '0');
    mockServerMethods.sendTransaction.mockResolvedValue(makeSendPending(TX_HASH));
    mockServerMethods.getTransaction
      .mockResolvedValueOnce(makeGetTx(SorobanRpc.Api.GetTransactionStatus.NOT_FOUND))
      .mockResolvedValueOnce(makeGetTx(SorobanRpc.Api.GetTransactionStatus.NOT_FOUND))
      .mockResolvedValueOnce(makeGetTx(SorobanRpc.Api.GetTransactionStatus.SUCCESS));

    const result = await client.submitSignedTx({ signedXdr: buildMinimalXdr(), networkPassphrase: NETWORK_PASSPHRASE });
    expect(result.txHash).toBe(TX_HASH);
    expect(mockServerMethods.getTransaction).toHaveBeenCalledTimes(3);
  }, 60_000);
});

// ─── invokeContract ───────────────────────────────────────────────────────────

describe('HttpSorobanRpcClient.invokeContract()', () => {
  let client: HttpSorobanRpcClient;

  beforeEach(() => {
    client = new HttpSorobanRpcClient(RPC_URL, 'testnet');
  });

  it('does NOT call signer when build step throws EscrowClientError; returns { status:failed, errorCode }', async () => {
    mockServerMethods.getAccount.mockResolvedValue(new Account(PAYER, '100'));
    mockServerMethods.simulateTransaction.mockResolvedValue(makeSimError('HostError: Error(Contract, #1)'));

    const signer = jest.fn();
    const result = await client.invokeContract({
      contractId: CONTRACT_ID, method: 'deposit',
      args: [PAYER, PAYER, 100n, CONTRACT_ID, ORDER_ID_HEX, 0],
      signerAddress: PAYER, signer,
    });

    expect(result.status).toBe('failed');
    expect(result.errorCode).toBe(ESCROW_ERROR_CODES.AlreadyExists);
    expect(signer).not.toHaveBeenCalled();
  });

  it('calls signer with unsigned XDR string and submits it', async () => {
    mockServerMethods.getAccount.mockResolvedValue(new Account(PAYER, '100'));
    mockServerMethods.simulateTransaction.mockResolvedValue(makeSimSuccess());

    const TX_HASH = 'invoke'.padEnd(64, '0');
    mockServerMethods.sendTransaction.mockResolvedValue(makeSendPending(TX_HASH));
    mockServerMethods.getTransaction.mockResolvedValue(makeGetTx(SorobanRpc.Api.GetTransactionStatus.SUCCESS));

    // Signer returns the same XDR (pass-through)
    const signer = jest.fn().mockImplementation(async (xdr: string) => xdr);

    const result = await client.invokeContract({
      contractId: CONTRACT_ID, method: 'release',
      args: [ORDER_ID_HEX], signerAddress: PAYER, signer,
    });

    expect(result.status).toBe('success');
    expect(result.txHash).toBe(TX_HASH);
    expect(signer).toHaveBeenCalledTimes(1);
    expect(typeof signer.mock.calls[0]?.[0]).toBe('string');
  });

  it('returns { status:failed } when submission fails with TX_FAILED', async () => {
    mockServerMethods.getAccount.mockResolvedValue(new Account(PAYER, '100'));
    mockServerMethods.simulateTransaction.mockResolvedValue(makeSimSuccess());
    mockServerMethods.sendTransaction.mockResolvedValue(makeSendPending(''));
    mockServerMethods.getTransaction.mockResolvedValue(makeGetTx(SorobanRpc.Api.GetTransactionStatus.FAILED));

    const signer = jest.fn().mockImplementation(async (xdr: string) => xdr);
    const result = await client.invokeContract({
      contractId: CONTRACT_ID, method: 'refund',
      args: [ORDER_ID_HEX, PAYER], signerAddress: PAYER, signer,
    });

    expect(result.status).toBe('failed');
  });
});

// ─── EscrowRpcError ───────────────────────────────────────────────────────────

describe('EscrowRpcError', () => {
  it('carries kind, detail, and name', () => {
    const err = new EscrowRpcError('SIMULATION_FAILED', 'some detail');
    expect(err.kind).toBe('SIMULATION_FAILED');
    expect(err.detail).toBe('some detail');
    expect(err.name).toBe('EscrowRpcError');
    expect(err.message).toContain('SIMULATION_FAILED');
    expect(err.message).toContain('some detail');
  });

  it('works without detail', () => {
    const err = new EscrowRpcError('POLL_TIMEOUT');
    expect(err.detail).toBeUndefined();
    expect(err.message).toContain('POLL_TIMEOUT');
  });

  it('is an instance of Error', () => {
    expect(new EscrowRpcError('TX_FAILED')).toBeInstanceOf(Error);
  });

  it('covers all six EscrowRpcErrorKind values', () => {
    const kinds: Array<EscrowRpcError['kind']> = [
      'SIMULATION_FAILED', 'SEND_FAILED', 'TX_FAILED',
      'POLL_TIMEOUT', 'INVALID_XDR', 'NETWORK_ERROR',
    ];
    for (const kind of kinds) {
      expect(new EscrowRpcError(kind).kind).toBe(kind);
    }
  });
});
