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
 */

import {
  SorobanRpc,
  TransactionBuilder,
  Contract,
  nativeToScVal,
  scValToNative,
  Networks,
  BASE_FEE,
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
 * - `deposited`  — funds confirmed held in the escrow contract;
 *                  on-chain record matches session payer/merchant/amount/token
 * - `fulfilled`  — merchant called release(); funds transferred to merchant
 * - `refunded`   — funds returned to payer (merchant voluntary or payer timeout)
 * - `failed`     — deposit transaction failed or timed out without confirmation
 * - `mismatch`   — deposit confirmed on-chain but the on-chain payer/merchant/
 *                  amount/token does not match what this session recorded.
 *                  This is a terminal error state requiring manual investigation.
 *                  The session will NOT be marked 'deposited'. Funds are on-chain
 *                  but may belong to a different escrow record.
 */
export type EscrowSessionStatus =
  | 'pending'
  | 'deposited'
  | 'fulfilled'
  | 'refunded'
  | 'failed'
  | 'mismatch';

/**
 * An escrow-based checkout session.
 */
export interface EscrowCheckoutSession {
  /** Server-assigned session ID (human-facing counter) */
  sessionId: string;
  /** 32 random bytes as a 64-character hex string (on-chain order_id key) */
  orderId: string;
  /** Payer's Stellar address */
  payerAddress: string;
  /** Merchant's Stellar address */
  merchantAddress: string;
  /** SAC token contract ID */
  tokenContractId: string;
  /** Amount in token's smallest unit (as bigint string) */
  amount: string;
  /** The timeout_ledgers value requested at session creation (0 = contract default) */
  requestedTimeoutLedgers: number;
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
   */
  invokeContract(params: {
    contractId: string;
    method: string;
    args: unknown[];
    signerAddress: string;
    signer: (unsignedXdr: string) => Promise<string>;
  }): Promise<{ txHash: string; status: 'success' | 'failed'; errorCode?: number }>;

  /**
   * Simulate a read-only contract call (no auth needed).
   * Returns the decoded return value.
   * Used by getEscrow() — free, no fee, no signature.
   *
   * Contract errors (codes 1–7) detected in the simulation error string are
   * mapped to EscrowClientError so callers can handle them specifically.
   */
  simulateContract(params: {
    contractId: string;
    method: string;
    args: unknown[];
  }): Promise<{ result: unknown }>;

  /**
   * Build an unsigned transaction XDR for a contract call.
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
   * Returns the transaction hash on SUCCESS.
   * Does NOT check which contract/method/args — that is the caller's
   * responsibility (escrow-router.ts validates the XDR before calling this).
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
 * HTTP escrow routes call:
 *   - buildUnsignedContractTx → returns XDR; no key involved
 *   - submitSignedTx          → accepts wallet-signed XDR; no key involved
 *
 * invokeContract combines those with a signer callback.
 * It is used only in scripts/tests — NEVER in HTTP request handlers.
 *
 * ## Error mapping
 *
 * - Simulation failures             → EscrowRpcError(SIMULATION_FAILED)
 * - Simulation with contract error  → EscrowClientError(code) — caller can catch
 * - sendTransaction rejection       → EscrowRpcError(SEND_FAILED)
 * - tx hash FAILED status           → EscrowRpcError(TX_FAILED)
 * - poll timeout                    → EscrowRpcError(POLL_TIMEOUT)
 * - XDR parse failure               → EscrowRpcError(INVALID_XDR)
 * - Contract error code in XDR      → NOT extracted from tx result (see note below)
 *
 * NOTE on TX_FAILED error codes: Stellar SDK does not expose a simple API to extract
 * Soroban contract error codes from a failed transaction's result meta XDR.
 * TX_FAILED returns errorCode undefined. The contract error is detectable from
 * simulation (buildUnsignedContractTx path) but not from a submitted tx result.
 * This is a known limitation documented here and in ARCHITECTURE.md.
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
   * Contract errors (codes 1–7) found in the simulation error are surfaced
   * as EscrowClientError so callers (e.g. GET /api/escrow/:id) can handle
   * NotFound specifically rather than treating all failures the same.
   */
  async simulateContract(params: {
    contractId: string;
    method: string;
    args: unknown[];
  }): Promise<{ result: unknown }> {
    const { contractId, method, args } = params;

    // Use a well-known valid placeholder for simulation — sequence 0, never submitted
    const sourceAccount = new Account(
      'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      '0',
    );

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
      // Map contract error codes so callers can distinguish NotFound from other errors
      const errorCode = this._extractContractErrorCode(simResult.error);
      if (errorCode !== null) {
        throw new EscrowClientError(method, errorCode);
      }
      throw new EscrowRpcError('SIMULATION_FAILED', simResult.error);
    }

    if (!SorobanRpc.Api.isSimulationSuccess(simResult)) {
      throw new EscrowRpcError('SIMULATION_FAILED', 'Simulation returned unexpected response type');
    }

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
   * No private key needed.
   */
  async buildUnsignedContractTx(params: {
    contractId: string;
    method: string;
    args: unknown[];
    callerAddress: string;
  }): Promise<{ unsignedXdr: string; networkPassphrase: string }> {
    const { contractId, method, args, callerAddress } = params;

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
      .setTimeout(300)
      .build();

    let simResult: SorobanRpc.Api.SimulateTransactionResponse;
    try {
      simResult = await this.rpc.simulateTransaction(tx);
    } catch (e) {
      throw new EscrowRpcError('NETWORK_ERROR', `simulateTransaction error: ${String(e)}`);
    }

    if (SorobanRpc.Api.isSimulationError(simResult)) {
      const errorCode = this._extractContractErrorCode(simResult.error);
      if (errorCode !== null) {
        throw new EscrowClientError(method, errorCode);
      }
      throw new EscrowRpcError('SIMULATION_FAILED', simResult.error);
    }

    if (!SorobanRpc.Api.isSimulationSuccess(simResult)) {
      throw new EscrowRpcError('SIMULATION_FAILED', 'Unexpected simulation response');
    }

    const assembled = SorobanRpc.assembleTransaction(tx, simResult).build();

    return {
      unsignedXdr: assembled.toXDR(),
      networkPassphrase: this.networkPassphrase,
    };
  }

  // ─── submitSignedTx (write path, step 3) ──────────────────────────────

  /**
   * Submit a wallet-signed XDR and poll for result.
   *
   * NOTE: TX_FAILED does not include a contract error code. The Stellar SDK
   * does not provide a simple path to extract Soroban error codes from the
   * result meta XDR of a submitted transaction. errorCode is always undefined
   * for TX_FAILED results.
   */
  async submitSignedTx(params: {
    signedXdr: string;
    networkPassphrase: string;
  }): Promise<{ txHash: string }> {
    const { signedXdr, networkPassphrase } = params;

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

    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));

      let pollResult: SorobanRpc.Api.GetTransactionResponse;
      try {
        pollResult = await this.rpc.getTransaction(txHash);
      } catch {
        continue;
      }

      const status = pollResult.status;

      if (status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        return { txHash };
      }

      if (status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
        // Contract error code extraction from tx result XDR is not implemented.
        // See module docblock note on TX_FAILED.
        throw new EscrowRpcError('TX_FAILED', `Transaction ${txHash} failed on-chain`);
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
   * Convenience wrapper: buildUnsignedContractTx + signer + submitSignedTx.
   *
   * ⚠️  NON-CUSTODIAL WARNING: Must never be called from HTTP request handlers.
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
        contractId, method, args, callerAddress: signerAddress,
      });
      unsignedXdr = built.unsignedXdr;
      networkPassphrase = built.networkPassphrase;
    } catch (e) {
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
        return { txHash: '', status: 'failed', errorCode: undefined };
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
      if (arg.startsWith('G') || arg.startsWith('C')) {
        return nativeToScVal(arg, { type: 'address' });
      }
      if (/^[0-9a-fA-F]{64}$/.test(arg)) {
        return nativeToScVal(Buffer.from(arg, 'hex'), { type: 'bytes' });
      }
    }
    return nativeToScVal(arg as string | number | bigint | boolean | null | undefined);
  }

  /**
   * Decode an EscrowRecord from a scValToNative result.
   */
  private _decodeEscrowRecord(decoded: unknown): EscrowRecord {
    if (typeof decoded !== 'object' || decoded === null) {
      throw new EscrowRpcError(
        'SIMULATION_FAILED',
        `Expected EscrowRecord object, got ${typeof decoded}`,
      );
    }

    const rec = decoded as Record<string, unknown>;

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

    const payer = this._assertString(rec['payer'], 'payer');
    const merchant = this._assertString(rec['merchant'], 'merchant');
    const token = this._assertString(rec['token'], 'token');
    const amount = BigInt(rec['amount'] as bigint | number | string);
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
   * Returns null if no code can be identified.
   *
   * Soroban simulation errors typically contain "Error(Contract, #N)".
   */
  private _extractContractErrorCode(errorStr: string): number | null {
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
}

// ─── EscrowClient ─────────────────────────────────────────────────────────

export interface EscrowClientOptions {
  rpcClient: SorobanRpcClient;
  contractId: string;
  network: StellarNetwork;
}

export class EscrowClient {
  private readonly rpc: SorobanRpcClient;
  readonly contractId: string;
  readonly network: StellarNetwork;

  constructor(opts: EscrowClientOptions) {
    this.rpc = opts.rpcClient;
    this.contractId = opts.contractId;
    this.network = opts.network;
  }

  async buildDepositXdr(
    payer: string, merchant: string, amount: bigint, token: string,
    orderIdHex: string, timeoutLedgers: number = 0,
  ): Promise<{ unsignedXdr: string; networkPassphrase: string }> {
    return this.rpc.buildUnsignedContractTx({
      contractId: this.contractId,
      method: 'deposit',
      args: [payer, merchant, amount, token, orderIdHex, timeoutLedgers],
      callerAddress: payer,
    });
  }

  async buildReleaseXdr(
    orderIdHex: string, merchantAddress: string,
  ): Promise<{ unsignedXdr: string; networkPassphrase: string }> {
    return this.rpc.buildUnsignedContractTx({
      contractId: this.contractId,
      method: 'release',
      args: [orderIdHex],
      callerAddress: merchantAddress,
    });
  }

  async buildRefundXdr(
    orderIdHex: string, callerAddress: string,
  ): Promise<{ unsignedXdr: string; networkPassphrase: string }> {
    return this.rpc.buildUnsignedContractTx({
      contractId: this.contractId,
      method: 'refund',
      args: [orderIdHex, callerAddress],
      callerAddress,
    });
  }

  /** Scripts/tests only — NOT for HTTP handlers. */
  async deposit(
    payer: string, merchant: string, amount: bigint, token: string,
    orderIdHex: string, timeoutLedgers: number = 0,
    signer?: (xdr: string) => Promise<string>,
  ): Promise<string> {
    const signerFn = signer ?? (() => Promise.reject(new Error(
      'EscrowClient.deposit() requires a signer callback. HTTP routes must use buildDepositXdr().',
    )));
    const result = await this.rpc.invokeContract({
      contractId: this.contractId, method: 'deposit',
      args: [payer, merchant, amount, token, orderIdHex, timeoutLedgers],
      signerAddress: payer, signer: signerFn,
    });
    if (result.status !== 'success') throw new EscrowClientError('deposit', result.errorCode ?? 0);
    return result.txHash;
  }

  /** Scripts/tests only — NOT for HTTP handlers. */
  async release(
    orderIdHex: string, merchantAddress: string,
    signer?: (xdr: string) => Promise<string>,
  ): Promise<string> {
    const signerFn = signer ?? (() => Promise.reject(new Error(
      'EscrowClient.release() requires a signer callback. HTTP routes must use buildReleaseXdr().',
    )));
    const result = await this.rpc.invokeContract({
      contractId: this.contractId, method: 'release',
      args: [orderIdHex], signerAddress: merchantAddress, signer: signerFn,
    });
    if (result.status !== 'success') throw new EscrowClientError('release', result.errorCode ?? 0);
    return result.txHash;
  }

  /** Scripts/tests only — NOT for HTTP handlers. */
  async refund(
    orderIdHex: string, callerAddress: string,
    signer?: (xdr: string) => Promise<string>,
  ): Promise<string> {
    const signerFn = signer ?? (() => Promise.reject(new Error(
      'EscrowClient.refund() requires a signer callback. HTTP routes must use buildRefundXdr().',
    )));
    const result = await this.rpc.invokeContract({
      contractId: this.contractId, method: 'refund',
      args: [orderIdHex, callerAddress], signerAddress: callerAddress, signer: signerFn,
    });
    if (result.status !== 'success') throw new EscrowClientError('refund', result.errorCode ?? 0);
    return result.txHash;
  }

  async getEscrow(orderIdHex: string): Promise<EscrowRecord> {
    const { result } = await this.rpc.simulateContract({
      contractId: this.contractId, method: 'get_escrow', args: [orderIdHex],
    });
    return result as EscrowRecord;
  }
}

// ─── Escrow error ─────────────────────────────────────────────────────────

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

export function escrowRecordToSessionStatus(record: EscrowRecord): EscrowSessionStatus {
  switch (record.status) {
    case 'Held': return 'deposited';
    case 'Released': return 'fulfilled';
    case 'Refunded': return 'refunded';
  }
}

/**
 * Generate a cryptographically random 32-byte order ID as a 64-char hex string.
 * Each session gets a fresh random ID — not derivable from session counter,
 * not guessable, no restart collisions.
 */
export function generateOrderId(): string {
  const bytes = new Uint8Array(32);
  // Node 18+ always has globalThis.crypto.getRandomValues (Web Crypto API).
  // This is the minimum supported Node version for this project.
  globalThis.crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('hex');
}

/**
 * @deprecated Use generateOrderId() instead.
 * This function derives order_id from a counter: IDs are guessable and reset
 * on server restart, causing on-chain collisions. Kept only for existing tests
 * that reference it directly; will be removed in a future cleanup.
 */
export function sessionIdToOrderIdHex(sessionId: bigint | string): string {
  const n = typeof sessionId === 'bigint' ? sessionId : BigInt(sessionId);
  const bytes = new Uint8Array(32);
  let val = n;
  for (let i = 31; i >= 24 && val > 0n; i--) {
    bytes[i] = Number(val & 0xffn);
    val >>= 8n;
  }
  return Buffer.from(bytes).toString('hex');
}
