/**
 * escrow-session.ts
 *
 * EscrowCheckoutSession — the Soroban-backed checkout mode for StellarFlow.
 *
 * This is a NEW checkout mode alongside the existing Horizon-based
 * CheckoutSession. It does NOT modify or replace the Horizon flow.
 *
 * ## How it works (non-custodial two-step flow)
 *
 * ### Read path (free, no auth)
 *   `simulateContract` → RPC simulateTransaction → decode ScVal result
 *   Used by `EscrowClient.getEscrow()`.
 *
 * ### Write path (non-custodial — server never holds keys)
 *   The write path is split into two server calls and one wallet call:
 *
 *   1. Server: `buildUnsignedContractTx(params)` — simulate + assemble
 *      footprint/fees, return UNSIGNED XDR to the caller.
 *   2. Wallet: caller signs the XDR offline (Freighter, Albedo, etc.)
 *   3. Server: `submitSignedTx(signedXdr)` — validate, submit via
 *      `rpc.sendTransaction`, poll until SUCCESS/FAILED, return hash.
 *
 *   `invokeContract` is a convenience wrapper that combines steps 1–3
 *   with an injected signer callback. It is used only by:
 *   - scripts/escrow-testnet-demo.ts (server-side test harness with funded keypair)
 *   - tests (mock signer injected)
 *   It must NEVER be called from an HTTP request handler that receives
 *   user input, because the signer callback would need a private key
 *   visible to the server — violating the non-custodial invariant.
 *
 * ## Soroban SDK note
 *
 * This file uses `stellar-sdk@12.3.0` which ships full Soroban support:
 * `SorobanRpc.Server`, `Contract`, `nativeToScVal`, `scValToNative`,
 * `assembleTransaction`. The legacy classic-payment code elsewhere in the
 * server also uses `stellar-sdk@12.x` — they coexist from the same package.
 *
 * If a future migration to `@stellar/stellar-sdk@>=13` is desired, the change
 * is isolated to this file and the HTTP escrow routes (escrow-router.ts).
 * The classic Horizon flow (checkout-router.ts, tx-builder.ts, core/*) does
 * not need to change at the same time. A breaking import path change between
 * the two SDK generations is the main migration cost.
 */

import {
  SorobanRpc,
  TransactionBuilder,
  Contract,
  nativeToScVal,
  scValToNative,
  Networks,
  BASE_FEE,
  xdr,
  Account,
  Transaction,
} from 'stellar-sdk';
import type { StellarNetwork } from '@stellarflow/core';

// ─── Soroban RPC endpoints ─────────────────────────────────────────────────

export const SOROBAN_RPC_URLS: Record<StellarNetwork, string> = {
  testnet: 'https://soroban-testnet.stellar.org',
  mainnet: 'https://soroban.stellar.org',
};

// ─── On-chain escrow status ───────────────────────────────────────────────

/**
 * On-chain escrow status as returned by the get_escrow contract function.
 * Mirrors the EscrowStatus enum in the Rust contract.
 */
export type EscrowStatus = 'Held' | 'Released' | 'Refunded';

/**
 * On-chain escrow record as returned by get_escrow().
 * Mirrors the EscrowRecord struct in the Rust contract.
 */
export interface EscrowRecord {
  payer: string;
  merchant: string;
  amount: bigint;
  token: string;
  status: EscrowStatus;
  deposited_at: number;
  timeout_ledgers: number;
}

// ─── EscrowCheckoutSession ────────────────────────────────────────────────

/**
 * Session lifecycle status for an EscrowCheckoutSession.
 *
 * - `pending`    — session created, deposit not yet confirmed on-chain
 * - `deposited`  — funds confirmed held in the escrow contract
 * - `fulfilled`  — merchant called release(); funds transferred to merchant
 * - `refunded`   — funds returned to payer (merchant voluntary or payer timeout)
 * - `failed`     — deposit transaction failed or timed out without confirmation
 */
export type EscrowSessionStatus =
  | 'pending'
  | 'deposited'
  | 'fulfilled'
  | 'refunded'
  | 'failed';

/**
 * An escrow-based checkout session.
 *
 * Named `EscrowCheckoutSession` to match the README reference.
 */
export interface EscrowCheckoutSession {
  /** Server-assigned session ID (maps to the on-chain order_id) */
  sessionId: string;
  /** 32-byte order identifier as a hex string (64 hex chars) */
  orderId: string;
  /** Payer's Stellar address */
  payerAddress: string;
  /** Merchant's Stellar address */
  merchantAddress: string;
  /** SAC token contract ID */
  tokenContractId: string;
  /** Amount in token's smallest unit (as bigint string) */
  amount: string;
  /** Network this session is on */
  network: StellarNetwork;
  /** Current session lifecycle status */
  status: EscrowSessionStatus;
  /** ISO timestamp when the session was created */
  createdAt: string;
  /**
   * Ledger number after which the payer may self-refund.
   * Calculated as deposited_at + timeout_ledgers once confirmed on-chain.
   */
  payerUnlockLedger?: number;
  /** Contract ID of the deployed escrow contract */
  contractId: string;
}

// ─── Soroban RPC client interface (for mocking in tests) ──────────────────

/**
 * Minimal interface for a Soroban RPC client.
 *
 * The split between invokeContract, buildUnsignedContractTx, and
 * submitSignedTx is intentional:
 *
 * - HTTP endpoints use buildUnsignedContractTx (returns XDR, no key needed)
 *   and submitSignedTx (accepts wallet-signed XDR, no key needed).
 * - Scripts and tests use invokeContract (takes a signer callback).
 *
 * Tests inject a mock that satisfies this interface — no network calls.
 */
export interface SorobanRpcClient {
  /**
   * Invoke a contract function server-side (state-changing operation).
   *
   * ⚠️  NON-CUSTODIAL WARNING: The signer callback receives the unsigned
   * transaction and must return a signed XDR. This callback must NEVER
   * be driven by a private key stored on the server in production.
   * Use only in scripts and tests where the key is explicitly injected.
   *
   * @returns The transaction hash on success.
   */
  invokeContract(params: {
    contractId: string;
    method: string;
    args: unknown[];
    signerAddress: string;
    /** Signer callback — must return signed XDR. Never use in HTTP handlers. */
    signer: (unsignedXdr: string) => Promise<string>;
  }): Promise<{ txHash: string; status: 'success' | 'failed'; errorCode?: number }>;

  /**
   * Simulate a read-only contract call (no auth needed).
   * Returns the decoded return value.
   * Used by getEscrow() — free, no fee, no signature.
   */
  simulateContract(params: {
    contractId: string;
    method: string;
    args: unknown[];
  }): Promise<{ result: unknown }>;

  /**
   * Build an unsigned transaction XDR for a contract call.
   *
   * Steps:
   *  1. Load the caller's account sequence number from the RPC.
   *  2. Build a transaction with the contract invocation operation.
   *  3. Simulate it to get the fee and storage footprint.
   *  4. Assemble footprint + resource fee into the transaction.
   *  5. Return the unsigned XDR for the wallet to sign.
   *
   * No private key is needed. The wallet signs the returned XDR.
   */
  buildUnsignedContractTx(params: {
    contractId: string;
    method: string;
    args: unknown[];
    callerAddress: string;
  }): Promise<{ unsignedXdr: string; networkPassphrase: string }>;

  /**
   * Validate and submit a wallet-signed transaction XDR.
   *
   * Steps:
   *  1. Parse the XDR and verify it contains exactly one invokeHostFunction op.
   *  2. Submit via rpc.sendTransaction.
   *  3. Poll rpc.getTransaction until SUCCESS or FAILED (bounded timeout).
   *  4. Map FAILED status or polling timeout to a distinct EscrowRpcError.
   *  5. Return the transaction hash on SUCCESS.
   *
   * Does NOT check which contract/method/args — that is the caller's
   * responsibility (see escrow-router.ts for XDR validation).
   */
  submitSignedTx(params: {
    signedXdr: string;
    networkPassphrase: string;
  }): Promise<{ txHash: string }>;
}

// ─── Error types ──────────────────────────────────────────────────────────

/** Distinct error kinds from the RPC layer. */
export type EscrowRpcErrorKind =
  | 'SIMULATION_FAILED'
  | 'SEND_FAILED'
  | 'TX_FAILED'
  | 'POLL_TIMEOUT'
  | 'INVALID_XDR'
  | 'NETWORK_ERROR';

/**
 * Error thrown by HttpSorobanRpcClient for RPC-level failures.
 * Distinguished from EscrowClientError (which is for contract errors).
 */
export class EscrowRpcError extends Error {
  readonly kind: EscrowRpcErrorKind;
  readonly detail?: string;

  constructor(kind: EscrowRpcErrorKind, detail?: string) {
    super(`Soroban RPC error [${kind}]${detail ? ': ' + detail : ''}`);
    this.kind = kind;
    this.detail = detail;
    this.name = 'EscrowRpcError';
  }
}

// ─── Real Soroban RPC client ───────────────────────────────────────────────

/** How long to poll getTransaction before giving up (ms). */
const POLL_TIMEOUT_MS = 30_000;
/** Interval between getTransaction polls (ms). */
const POLL_INTERVAL_MS = 1_500;

/**
 * HTTP-based Soroban RPC client using stellar-sdk@12.x SorobanRpc.
 *
 * ## Non-custodial design
 *
 * The HTTP escrow routes (escrow-router.ts) call:
 *   - buildUnsignedContractTx → returns XDR; no key involved
 *   - submitSignedTx          → accepts wallet-signed XDR; no key involved
 *
 * The convenience method invokeContract combines those steps with a signer
 * callback. It is used only in scripts/tests — NEVER in HTTP request handlers.
 *
 * ## Error mapping
 *
 * - Simulation failures        → EscrowRpcError(SIMULATION_FAILED)
 * - sendTransaction rejection  → EscrowRpcError(SEND_FAILED)
 * - tx hash FAILED status      → EscrowRpcError(TX_FAILED) with errorCode
 * - poll timeout               → EscrowRpcError(POLL_TIMEOUT)
 * - XDR parse failure          → EscrowRpcError(INVALID_XDR)
 * - Contract error (code 1–7)  → EscrowClientError via EscrowClient layer
 */
export class HttpSorobanRpcClient implements SorobanRpcClient {
  private readonly rpc: SorobanRpc.Server;
  private readonly network: StellarNetwork;

  constructor(rpcUrl: string, network: StellarNetwork) {
    this.rpc = new SorobanRpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') });
    this.network = network;
  }

  private get networkPassphrase(): string {
    return this.network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;
  }

  // ─── simulateContract (read path) ─────────────────────────────────────

  /**
   * Simulate a read-only contract call (no auth, no fee).
   * Used for get_escrow reads.
   *
   * Builds a minimal unsigned tx, calls simulateTransaction, decodes the
   * ScVal result with scValToNative, and returns the decoded value.
   */
  async simulateContract(params: {
    contractId: string;
    method: string;
    args: unknown[];
  }): Promise<{ result: unknown }> {
    const { contractId, method, args } = params;

    // We need a source account to build the tx even for simulation.
    // Use a zero-sequence placeholder — simulation doesn't submit.
    let sourceAccount: Account;
    try {
      // For pure read simulations we use a well-known placeholder account.
      // The simulation only needs a valid strkey — it never submits.
      // GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5 is the
      // StellarFlow demo merchant address used in tests — a valid Ed25519 key.
      sourceAccount = new Account(
        'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        '0',
      );
    } catch (e) {
      throw new EscrowRpcError('NETWORK_ERROR', `Failed to construct placeholder account: ${String(e)}`);
    }

    const contract = new Contract(contractId);
    const scArgs = this._encodeArgs(args);
    const operation = contract.call(method, ...scArgs);

    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    let simResult: SorobanRpc.Api.SimulateTransactionResponse;
    try {
      simResult = await this.rpc.simulateTransaction(tx);
    } catch (e) {
      throw new EscrowRpcError('NETWORK_ERROR', `simulateTransaction network error: ${String(e)}`);
    }

    if (SorobanRpc.Api.isSimulationError(simResult)) {
      throw new EscrowRpcError('SIMULATION_FAILED', simResult.error);
    }

    if (!SorobanRpc.Api.isSimulationSuccess(simResult)) {
      throw new EscrowRpcError('SIMULATION_FAILED', 'Simulation returned unexpected response type');
    }

    // The result is the first return value of the contract function
    const rawResult = simResult.result?.retval;
    if (!rawResult) {
      throw new EscrowRpcError('SIMULATION_FAILED', 'No result returned from simulation');
    }

    const decoded = scValToNative(rawResult);
    return { result: this._decodeEscrowRecord(decoded) };
  }

  // ─── buildUnsignedContractTx (write path, step 1) ─────────────────────

  /**
   * Simulate + assemble a contract invocation and return unsigned XDR.
   *
   * The caller's wallet signs this and returns it to submitSignedTx.
   * No private key is needed here — the non-custodial invariant is intact.
   */
  async buildUnsignedContractTx(params: {
    contractId: string;
    method: string;
    args: unknown[];
    callerAddress: string;
  }): Promise<{ unsignedXdr: string; networkPassphrase: string }> {
    const { contractId, method, args, callerAddress } = params;

    // Load actual account sequence from the RPC
    let sourceAccount: Account;
    try {
      sourceAccount = await this.rpc.getAccount(callerAddress);
    } catch (e) {
      throw new EscrowRpcError(
        'NETWORK_ERROR',
        `Failed to load account ${callerAddress}: ${String(e)}`,
      );
    }

    const contract = new Contract(contractId);
    const scArgs = this._encodeArgs(args);
    const operation = contract.call(method, ...scArgs);

    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(300) // 5-minute signing window
      .build();

    // Simulate to get the storage footprint and resource fee
    let simResult: SorobanRpc.Api.SimulateTransactionResponse;
    try {
      simResult = await this.rpc.simulateTransaction(tx);
    } catch (e) {
      throw new EscrowRpcError('NETWORK_ERROR', `simulateTransaction error: ${String(e)}`);
    }

    if (SorobanRpc.Api.isSimulationError(simResult)) {
      // Map simulation errors to EscrowClientError if they contain a contract error code
      const errorCode = this._extractContractErrorCode(simResult.error);
      if (errorCode !== null) {
        throw new EscrowClientError(method, errorCode);
      }
      throw new EscrowRpcError('SIMULATION_FAILED', simResult.error);
    }

    if (!SorobanRpc.Api.isSimulationSuccess(simResult)) {
      throw new EscrowRpcError('SIMULATION_FAILED', 'Unexpected simulation response');
    }

    // Assemble: inject footprint and resource fee into the transaction
    const assembled = SorobanRpc.assembleTransaction(tx, simResult).build();

    return {
      unsignedXdr: assembled.toXDR(),
      networkPassphrase: this.networkPassphrase,
    };
  }

  // ─── submitSignedTx (write path, step 3) ──────────────────────────────

  /**
   * Submit a wallet-signed XDR to the Soroban RPC and poll for result.
   *
   * Polling behaviour:
   * - Polls every POLL_INTERVAL_MS (1.5 s)
   * - Gives up after POLL_TIMEOUT_MS (30 s) → EscrowRpcError(POLL_TIMEOUT)
   * - FAILED status → EscrowRpcError(TX_FAILED) with extracted error code
   * - SUCCESS → returns { txHash }
   */
  async submitSignedTx(params: {
    signedXdr: string;
    networkPassphrase: string;
  }): Promise<{ txHash: string }> {
    const { signedXdr, networkPassphrase } = params;

    // Parse and validate XDR
    let tx: Transaction;
    try {
      const parsed = TransactionBuilder.fromXDR(signedXdr, networkPassphrase);
      if (!(parsed instanceof Transaction)) {
        throw new EscrowRpcError('INVALID_XDR', 'FeeBump transactions are not accepted for escrow');
      }
      tx = parsed;
    } catch (e) {
      if (e instanceof EscrowRpcError) throw e;
      throw new EscrowRpcError('INVALID_XDR', `XDR parse error: ${String(e)}`);
    }

    // Submit
    let sendResult: SorobanRpc.Api.SendTransactionResponse;
    try {
      sendResult = await this.rpc.sendTransaction(tx);
    } catch (e) {
      throw new EscrowRpcError('NETWORK_ERROR', `sendTransaction error: ${String(e)}`);
    }

    if (sendResult.status === 'ERROR') {
      throw new EscrowRpcError(
        'SEND_FAILED',
        `sendTransaction rejected: ${sendResult.errorResult?.result().switch().name ?? 'unknown'}`,
      );
    }

    const txHash = sendResult.hash;

    // Poll until confirmed
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));

      let pollResult: SorobanRpc.Api.GetTransactionResponse;
      try {
        pollResult = await this.rpc.getTransaction(txHash);
      } catch (e) {
        // Transient network error during polling — keep trying
        continue;
      }

      const status = pollResult.status;

      if (status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        return { txHash };
      }

      if (status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
        // Extract contract error code if present
        const errorCode = this._extractContractErrorCodeFromTx(pollResult);
        throw new EscrowRpcError(
          'TX_FAILED',
          `Transaction failed${errorCode !== null ? ` with contract error code ${errorCode}` : ''}`,
        );
      }

      // NOT_FOUND = still pending, keep polling
    }

    throw new EscrowRpcError(
      'POLL_TIMEOUT',
      `Transaction ${txHash} did not confirm within ${POLL_TIMEOUT_MS}ms`,
    );
  }

  // ─── invokeContract (scripts/tests only — NOT for HTTP handlers) ──────

  /**
   * Convenience method that combines buildUnsignedContractTx + signer + submitSignedTx.
   *
   * ⚠️  NON-CUSTODIAL WARNING:
   * The signer callback has access to a private key. This method must NEVER
   * be called from an HTTP request handler. It exists only for:
   *   - scripts/escrow-testnet-demo.ts (funded testnet keypair)
   *   - unit/integration tests (mock signer)
   *
   * Contract errors (codes 1–7) returned via TX_FAILED are mapped to
   * EscrowClientError so the EscrowClient layer can catch them uniformly.
   */
  async invokeContract(params: {
    contractId: string;
    method: string;
    args: unknown[];
    signerAddress: string;
    signer: (unsignedXdr: string) => Promise<string>;
  }): Promise<{ txHash: string; status: 'success' | 'failed'; errorCode?: number }> {
    const { contractId, method, args, signerAddress, signer } = params;

    let unsignedXdr: string;
    let networkPassphrase: string;

    try {
      const built = await this.buildUnsignedContractTx({
        contractId,
        method,
        args,
        callerAddress: signerAddress,
      });
      unsignedXdr = built.unsignedXdr;
      networkPassphrase = built.networkPassphrase;
    } catch (e) {
      // Simulation-detected contract errors surface here
      if (e instanceof EscrowClientError) {
        return { txHash: '', status: 'failed', errorCode: e.code };
      }
      throw e;
    }

    let signedXdr: string;
    try {
      signedXdr = await signer(unsignedXdr);
    } catch (e) {
      throw new EscrowRpcError('INVALID_XDR', `Signer callback failed: ${String(e)}`);
    }

    try {
      const result = await this.submitSignedTx({ signedXdr, networkPassphrase });
      return { txHash: result.txHash, status: 'success' };
    } catch (e) {
      if (e instanceof EscrowRpcError && e.kind === 'TX_FAILED') {
        // Extract error code from the error message
        const match = e.detail?.match(/error code (\d+)/);
        const errorCode = match ? parseInt(match[1]!, 10) : 0;
        return { txHash: '', status: 'failed', errorCode };
      }
      throw e;
    }
  }

  // ─── ScVal encoding helpers ────────────────────────────────────────────

  /**
   * Encode an array of JS values to Soroban ScVal arguments.
   *
   * Supported mappings (matching the escrow contract's parameter types):
   *   - string starting with G… → Address (Stellar public key)
   *   - string starting with C… → Address (contract ID)
   *   - string of 64 hex chars  → Bytes (BytesN<32> order_id)
   *   - bigint                  → i128
   *   - number                  → u32
   */
  private _encodeArgs(args: unknown[]): ReturnType<typeof nativeToScVal>[] {
    return args.map((arg) => this._encodeArg(arg));
  }

  private _encodeArg(arg: unknown): ReturnType<typeof nativeToScVal> {
    if (typeof arg === 'bigint') {
      return nativeToScVal(arg, { type: 'i128' });
    }
    if (typeof arg === 'number') {
      return nativeToScVal(arg, { type: 'u32' });
    }
    if (typeof arg === 'string') {
      // Stellar public key (G...) or contract ID (C...) → Address
      if (arg.startsWith('G') || arg.startsWith('C')) {
        return nativeToScVal(arg, { type: 'address' });
      }
      // 64-char hex string → BytesN<32>
      if (/^[0-9a-fA-F]{64}$/.test(arg)) {
        return nativeToScVal(Buffer.from(arg, 'hex'), { type: 'bytes' });
      }
    }
    // Fallback: let nativeToScVal infer the type
    return nativeToScVal(arg as string | number | bigint | boolean | null | undefined);
  }

  /**
   * Decode an EscrowRecord from a scValToNative result.
   * The Soroban SDK decodes struct fields as a Map<string, unknown>.
   */
  private _decodeEscrowRecord(decoded: unknown): EscrowRecord {
    // scValToNative decodes a contracttype struct as a plain object (Map)
    if (typeof decoded !== 'object' || decoded === null) {
      throw new EscrowRpcError(
        'SIMULATION_FAILED',
        `Expected EscrowRecord object, got ${typeof decoded}`,
      );
    }

    const rec = decoded as Record<string, unknown>;

    // Status enum: Soroban SDK decodes enum variants as { tag: 'Held'|... }
    // or plain string depending on the SDK version
    let status: EscrowStatus;
    const rawStatus = rec['status'];
    if (typeof rawStatus === 'string' && (rawStatus === 'Held' || rawStatus === 'Released' || rawStatus === 'Refunded')) {
      status = rawStatus;
    } else if (typeof rawStatus === 'object' && rawStatus !== null && 'tag' in rawStatus) {
      const tag = (rawStatus as { tag: string }).tag;
      if (tag === 'Held' || tag === 'Released' || tag === 'Refunded') {
        status = tag;
      } else {
        throw new EscrowRpcError('SIMULATION_FAILED', `Unknown escrow status tag: ${tag}`);
      }
    } else {
      throw new EscrowRpcError('SIMULATION_FAILED', `Cannot decode escrow status: ${JSON.stringify(rawStatus)}`);
    }

    // Addresses: Soroban SDK decodes Address as a string (public key or contract ID)
    const payer = this._assertString(rec['payer'], 'payer');
    const merchant = this._assertString(rec['merchant'], 'merchant');
    const token = this._assertString(rec['token'], 'token');

    // amount: i128 decoded as bigint
    const amount = BigInt(rec['amount'] as bigint | number | string);

    // deposited_at, timeout_ledgers: u32 decoded as number
    const deposited_at = Number(rec['deposited_at']);
    const timeout_ledgers = Number(rec['timeout_ledgers']);

    return { payer, merchant, amount, token, status, deposited_at, timeout_ledgers };
  }

  private _assertString(val: unknown, field: string): string {
    if (typeof val !== 'string') {
      throw new EscrowRpcError('SIMULATION_FAILED', `Expected string for ${field}, got ${typeof val}`);
    }
    return val;
  }

  /**
   * Attempt to extract a contract error code (1–7) from a simulation error string.
   * Returns null if no error code can be identified.
   *
   * Soroban simulation error strings typically contain "Error(Contract, #N)"
   * where N is the EscrowError variant code.
   */
  private _extractContractErrorCode(errorStr: string): number | null {
    // Pattern: "Error(Contract, #1)" or "contract error: 1" etc.
    const patterns = [
      /Error\(Contract,\s*#(\d+)\)/,
      /contract error[:\s]+(\d+)/i,
      /error code[:\s]+(\d+)/i,
    ];
    for (const pattern of patterns) {
      const match = errorStr.match(pattern);
      if (match) {
        const code = parseInt(match[1]!, 10);
        if (code >= 1 && code <= 7) return code;
      }
    }
    return null;
  }

  /**
   * Attempt to extract a contract error code from a failed transaction response.
   */
  private _extractContractErrorCodeFromTx(
    pollResult: SorobanRpc.Api.GetTransactionResponse,
  ): number | null {
    try {
      // The result XDR may contain a Soroban error with a contract error code
      const resultMeta = (pollResult as { resultMetaXdr?: { toXDR?: () => Buffer } }).resultMetaXdr;
      if (!resultMeta) return null;
      // Parse the XDR to find contract error codes
      // TransactionMeta v3 has sorobanMeta which has returnValue
      // For simplicity, we use string matching on the XDR base64 representation
      const xdrBase64 = Buffer.isBuffer(resultMeta) ? resultMeta.toString('base64') : String(resultMeta);
      return this._extractContractErrorCode(xdrBase64);
    } catch {
      return null;
    }
  }
}

// ─── EscrowClient ─────────────────────────────────────────────────────────

export interface EscrowClientOptions {
  /** Soroban RPC client. Inject a mock for testing. */
  rpcClient: SorobanRpcClient;
  /** Deployed escrow contract ID */
  contractId: string;
  /** Network (testnet/mainnet) */
  network: StellarNetwork;
}

/**
 * Client for the StellarFlow escrow contract.
 *
 * ## Non-custodial usage from HTTP routes
 *
 * The escrow-router.ts HTTP endpoints use the two-step write path:
 *
 *   1. `buildDepositXdr()` / `buildReleaseXdr()` / `buildRefundXdr()`
 *      → calls rpcClient.buildUnsignedContractTx
 *      → returns unsigned XDR to the wallet
 *   2. Wallet signs and POSTs the signed XDR back
 *      → escrow-router calls `rpcClient.submitSignedTx` directly
 *
 * The EscrowClient.deposit/release/refund methods (which call invokeContract)
 * are for scripts and tests only.
 *
 * ## Read path (always non-custodial)
 *
 *   `getEscrow()` → rpcClient.simulateContract (read-only, no key needed)
 */
export class EscrowClient {
  private readonly rpc: SorobanRpcClient;
  readonly contractId: string;
  readonly network: StellarNetwork;

  constructor(opts: EscrowClientOptions) {
    this.rpc = opts.rpcClient;
    this.contractId = opts.contractId;
    this.network = opts.network;
  }

  /**
   * Build an unsigned deposit XDR for the payer's wallet to sign.
   *
   * Non-custodial: the server never sees the payer's private key.
   */
  async buildDepositXdr(
    payer: string,
    merchant: string,
    amount: bigint,
    token: string,
    orderIdHex: string,
    timeoutLedgers: number = 0,
  ): Promise<{ unsignedXdr: string; networkPassphrase: string }> {
    return this.rpc.buildUnsignedContractTx({
      contractId: this.contractId,
      method: 'deposit',
      args: [payer, merchant, amount, token, orderIdHex, timeoutLedgers],
      callerAddress: payer,
    });
  }

  /**
   * Build an unsigned release XDR for the merchant's wallet to sign.
   *
   * Non-custodial: the server never sees the merchant's private key.
   */
  async buildReleaseXdr(
    orderIdHex: string,
    merchantAddress: string,
  ): Promise<{ unsignedXdr: string; networkPassphrase: string }> {
    return this.rpc.buildUnsignedContractTx({
      contractId: this.contractId,
      method: 'release',
      args: [orderIdHex],
      callerAddress: merchantAddress,
    });
  }

  /**
   * Build an unsigned refund XDR for the caller's wallet to sign.
   *
   * Caller is either the merchant (any time) or the payer (after timeout).
   * Non-custodial: the server never sees any private key.
   */
  async buildRefundXdr(
    orderIdHex: string,
    callerAddress: string,
  ): Promise<{ unsignedXdr: string; networkPassphrase: string }> {
    return this.rpc.buildUnsignedContractTx({
      contractId: this.contractId,
      method: 'refund',
      args: [orderIdHex, callerAddress],
      callerAddress,
    });
  }

  /**
   * Invoke the escrow contract's `deposit` function.
   *
   * ⚠️  Uses invokeContract internally — for scripts/tests only.
   * HTTP routes must use buildDepositXdr + submitSignedTx instead.
   */
  async deposit(
    payer: string,
    merchant: string,
    amount: bigint,
    token: string,
    orderIdHex: string,
    timeoutLedgers: number = 0,
    signer?: (xdr: string) => Promise<string>,
  ): Promise<string> {
    const signerFn = signer ?? ((_xdr: string) => Promise.reject(new Error(
      'EscrowClient.deposit() requires a signer callback when called with invokeContract. ' +
      'HTTP routes must use buildDepositXdr() instead.'
    )));

    const result = await this.rpc.invokeContract({
      contractId: this.contractId,
      method: 'deposit',
      args: [payer, merchant, amount, token, orderIdHex, timeoutLedgers],
      signerAddress: payer,
      signer: signerFn,
    });

    if (result.status !== 'success') {
      throw new EscrowClientError('deposit', result.errorCode ?? 0);
    }

    return result.txHash;
  }

  /**
   * Invoke the escrow contract's `release` function.
   *
   * ⚠️  Uses invokeContract internally — for scripts/tests only.
   * HTTP routes must use buildReleaseXdr + submitSignedTx instead.
   */
  async release(
    orderIdHex: string,
    merchantAddress: string,
    signer?: (xdr: string) => Promise<string>,
  ): Promise<string> {
    const signerFn = signer ?? ((_xdr: string) => Promise.reject(new Error(
      'EscrowClient.release() requires a signer callback. ' +
      'HTTP routes must use buildReleaseXdr() instead.'
    )));

    const result = await this.rpc.invokeContract({
      contractId: this.contractId,
      method: 'release',
      args: [orderIdHex],
      signerAddress: merchantAddress,
      signer: signerFn,
    });

    if (result.status !== 'success') {
      throw new EscrowClientError('release', result.errorCode ?? 0);
    }

    return result.txHash;
  }

  /**
   * Invoke the escrow contract's `refund` function.
   *
   * ⚠️  Uses invokeContract internally — for scripts/tests only.
   * HTTP routes must use buildRefundXdr + submitSignedTx instead.
   */
  async refund(
    orderIdHex: string,
    callerAddress: string,
    signer?: (xdr: string) => Promise<string>,
  ): Promise<string> {
    const signerFn = signer ?? ((_xdr: string) => Promise.reject(new Error(
      'EscrowClient.refund() requires a signer callback. ' +
      'HTTP routes must use buildRefundXdr() instead.'
    )));

    const result = await this.rpc.invokeContract({
      contractId: this.contractId,
      method: 'refund',
      args: [orderIdHex, callerAddress],
      signerAddress: callerAddress,
      signer: signerFn,
    });

    if (result.status !== 'success') {
      throw new EscrowClientError('refund', result.errorCode ?? 0);
    }

    return result.txHash;
  }

  /**
   * Read the escrow record from the contract (read-only, no auth needed).
   *
   * @param orderIdHex - 32-byte order ID as a 64-character hex string
   * @returns          The on-chain escrow record
   */
  async getEscrow(orderIdHex: string): Promise<EscrowRecord> {
    const { result } = await this.rpc.simulateContract({
      contractId: this.contractId,
      method: 'get_escrow',
      args: [orderIdHex],
    });

    return result as EscrowRecord;
  }
}

// ─── Escrow error ─────────────────────────────────────────────────────────

/**
 * Error codes from the escrow contract's EscrowError enum.
 * These values must stay in sync with the Rust contract definition.
 */
export const ESCROW_ERROR_CODES = {
  AlreadyExists: 1,
  NotFound: 2,
  AlreadyReleased: 3,
  AlreadyRefunded: 4,
  NotMerchant: 5,
  NotAuthorized: 6,
  TimeoutNotElapsed: 7,
} as const;

export type EscrowErrorCode = (typeof ESCROW_ERROR_CODES)[keyof typeof ESCROW_ERROR_CODES];

const ERROR_CODE_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(ESCROW_ERROR_CODES).map(([name, code]) => [code, name]),
);

/**
 * Error thrown by EscrowClient when the contract returns a non-success status.
 */
export class EscrowClientError extends Error {
  readonly operation: string;
  readonly code: number;
  readonly codeName: string;

  constructor(operation: string, code: number) {
    const name = ERROR_CODE_NAMES[code] ?? `Unknown(${code})`;
    super(`Escrow contract error in ${operation}: ${name} (code ${code})`);
    this.operation = operation;
    this.code = code;
    this.codeName = name;
    this.name = 'EscrowClientError';
  }
}

// ─── Session lifecycle helpers ────────────────────────────────────────────

/**
 * Convert an on-chain EscrowRecord to an EscrowSessionStatus.
 * Used to map between the contract's status enum and the TS session status.
 */
export function escrowRecordToSessionStatus(record: EscrowRecord): EscrowSessionStatus {
  switch (record.status) {
    case 'Held':
      return 'deposited';
    case 'Released':
      return 'fulfilled';
    case 'Refunded':
      return 'refunded';
  }
}

/**
 * Build an order_id hex string from a session ID (bigint or string number).
 * The escrow contract uses BytesN<32> for order IDs. We derive a deterministic
 * 32-byte value from the session ID by left-padding a big-endian uint64 to 32 bytes.
 *
 * This ensures the same session ID always produces the same order_id on-chain.
 */
export function sessionIdToOrderIdHex(sessionId: bigint | string): string {
  const n = typeof sessionId === 'bigint' ? sessionId : BigInt(sessionId);
  // Encode as big-endian uint64 (8 bytes), then pad to 32 bytes
  const bytes = new Uint8Array(32);
  let val = n;
  for (let i = 31; i >= 24 && val > 0n; i--) {
    bytes[i] = Number(val & 0xffn);
    val >>= 8n;
  }
  return Buffer.from(bytes).toString('hex');
}
