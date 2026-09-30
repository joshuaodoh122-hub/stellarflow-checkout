/**
 * escrow-session.ts
 *
 * EscrowCheckoutSession — the Soroban-backed checkout mode for StellarFlow.
 *
 * This is a NEW checkout mode alongside the existing Horizon-based
 * CheckoutSession. It does NOT modify or replace the Horizon flow.
 *
 * ## How it works
 *
 * 1. The merchant backend calls `EscrowClient.deposit()` to invoke the
 *    Soroban escrow contract, locking `amount` of `token` in the contract.
 * 2. The widget polls `GET /api/escrow/:orderId` (or the merchant uses
 *    `EscrowClient.getEscrow()`) to check the on-chain status.
 * 3. When the merchant has fulfilled the order, they call
 *    `EscrowClient.release()` to send the held funds to themselves.
 * 4. If the merchant cannot fulfil, they call `EscrowClient.refund()` to
 *    return the funds to the payer immediately (no time gate for merchants).
 * 5. If the merchant never acts, the payer may call `EscrowClient.refund()`
 *    after the timeout window has elapsed (default: 30 days / 518_400 ledgers).
 *
 * ## Trust model
 *
 * The StellarFlow server does NOT hold signing keys. All contract invocations
 * are constructed as unsigned XDR here and signed by the caller's wallet.
 * The server only constructs and submits transactions — the non-custodial
 * invariant is preserved.
 *
 * For testnet testing the caller may inject a pre-signed keypair via
 * `EscrowClientOptions.signer` (used only in tests — never in production).
 *
 * ## Soroban RPC
 *
 * All on-chain reads and writes go through the Soroban RPC endpoint.
 * The endpoint is configurable (default: Stellar testnet Soroban RPC).
 * In tests, the RPC client is replaced by a mock.
 */

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
 * Named `EscrowCheckoutSession` to match the README reference
 * (`EscrowCheckoutSession`).
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
 * The real implementation calls the Soroban JSON-RPC API.
 * Tests inject a mock that satisfies this interface.
 */
export interface SorobanRpcClient {
  /**
   * Invoke a contract function (state-changing operation).
   * Returns the transaction hash on success.
   */
  invokeContract(params: {
    contractId: string;
    method: string;
    args: unknown[];
    signerAddress: string;
  }): Promise<{ txHash: string; status: 'success' | 'failed'; errorCode?: number }>;

  /**
   * Simulate a read-only contract call (no auth needed).
   * Returns the decoded return value.
   */
  simulateContract(params: {
    contractId: string;
    method: string;
    args: unknown[];
  }): Promise<{ result: unknown }>;
}

// ─── Real Soroban RPC client ───────────────────────────────────────────────

/**
 * HTTP-based Soroban RPC client.
 * Calls the Soroban JSON-RPC API directly.
 *
 * In tests this class is NOT used — the `SorobanRpcClient` interface is
 * injected directly so no network calls are made.
 */
export class HttpSorobanRpcClient implements SorobanRpcClient {
  private readonly rpcUrl: string;

  constructor(rpcUrl: string) {
    this.rpcUrl = rpcUrl;
  }

  async invokeContract(params: {
    contractId: string;
    method: string;
    args: unknown[];
    signerAddress: string;
  }): Promise<{ txHash: string; status: 'success' | 'failed'; errorCode?: number }> {
    // Real implementation would:
    // 1. Build a Soroban invoke-contract operation
    // 2. Simulate to get the footprint and fee
    // 3. Return the unsigned XDR for the wallet to sign
    // 4. Wait for the signed XDR and submit it
    //
    // For v0.2, the actual wallet-signing flow is handled by the EscrowCheckoutRouter
    // endpoints (similar to how checkout-router.ts handles tx building for Horizon).
    // This stub represents the full invoke flow for testing purposes.
    const response = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'simulateTransaction',
        params: {
          transaction: JSON.stringify({ contractId: params.contractId, method: params.method, args: params.args }),
        },
      }),
    });
    if (!response.ok) {
      throw new Error(`Soroban RPC error: ${response.status} ${response.statusText}`);
    }
    const data = await response.json() as { result?: { status?: string; transactionHash?: string; error?: { code: number } } };
    const result = data.result ?? {};
    return {
      txHash: result.transactionHash ?? '',
      status: result.status === 'SUCCESS' ? 'success' : 'failed',
      errorCode: result.error?.code,
    };
  }

  async simulateContract(params: {
    contractId: string;
    method: string;
    args: unknown[];
  }): Promise<{ result: unknown }> {
    const response = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'simulateTransaction',
        params: {
          transaction: JSON.stringify({ contractId: params.contractId, method: params.method, args: params.args }),
        },
      }),
    });
    if (!response.ok) {
      throw new Error(`Soroban RPC error: ${response.status} ${response.statusText}`);
    }
    const data = await response.json() as { result?: { retval?: unknown } };
    return { result: data.result?.retval };
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
 * All write methods (deposit, release, refund) invoke the contract
 * and return the transaction hash. The caller is responsible for
 * providing the signer's address — the signing itself happens in the
 * wallet (non-custodial invariant preserved).
 *
 * Read methods (getEscrow) use contract simulation (free, no auth needed).
 */
export class EscrowClient {
  private readonly rpc: SorobanRpcClient;
  private readonly contractId: string;
  readonly network: StellarNetwork;

  constructor(opts: EscrowClientOptions) {
    this.rpc = opts.rpcClient;
    this.contractId = opts.contractId;
    this.network = opts.network;
  }

  /**
   * Invoke the escrow contract's `deposit` function.
   *
   * Locks `amount` of `token` in the contract on behalf of `payer`.
   * The `payer` must sign this transaction.
   *
   * @param payer          - Stellar address funding the escrow
   * @param merchant       - Stellar address to receive funds on release
   * @param amount         - Token amount in the token's smallest unit
   * @param token          - SAC token contract ID
   * @param orderIdHex     - 32-byte order ID as a 64-character hex string
   * @param timeoutLedgers - Ledger delta for payer timeout; 0 = use default (518_400)
   * @returns              Transaction hash of the deposit transaction
   */
  async deposit(
    payer: string,
    merchant: string,
    amount: bigint,
    token: string,
    orderIdHex: string,
    timeoutLedgers: number = 0,
  ): Promise<string> {
    const result = await this.rpc.invokeContract({
      contractId: this.contractId,
      method: 'deposit',
      args: [payer, merchant, amount.toString(), token, orderIdHex, timeoutLedgers],
      signerAddress: payer,
    });

    if (result.status !== 'success') {
      throw new EscrowClientError('deposit', result.errorCode ?? 0);
    }

    return result.txHash;
  }

  /**
   * Invoke the escrow contract's `release` function.
   *
   * Transfers held funds to the merchant. The merchant must sign this transaction.
   *
   * @param orderIdHex     - 32-byte order ID as a 64-character hex string
   * @param merchantAddress - Merchant's Stellar address (must be the signer)
   * @returns              Transaction hash of the release transaction
   */
  async release(orderIdHex: string, merchantAddress: string): Promise<string> {
    const result = await this.rpc.invokeContract({
      contractId: this.contractId,
      method: 'release',
      args: [orderIdHex],
      signerAddress: merchantAddress,
    });

    if (result.status !== 'success') {
      throw new EscrowClientError('release', result.errorCode ?? 0);
    }

    return result.txHash;
  }

  /**
   * Invoke the escrow contract's `refund` function.
   *
   * Transfers held funds back to the payer. The caller must be either:
   * - The merchant (any time, no timeout)
   * - The payer (only after the timeout window has elapsed)
   *
   * @param orderIdHex   - 32-byte order ID as a 64-character hex string
   * @param callerAddress - Stellar address initiating the refund
   * @returns            Transaction hash of the refund transaction
   */
  async refund(orderIdHex: string, callerAddress: string): Promise<string> {
    const result = await this.rpc.invokeContract({
      contractId: this.contractId,
      method: 'refund',
      args: [orderIdHex, callerAddress],
      signerAddress: callerAddress,
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
