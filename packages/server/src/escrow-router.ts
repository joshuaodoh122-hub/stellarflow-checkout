/**
 * escrow-router.ts
 *
 * Express router exposing the StellarFlow Escrow Checkout API.
 *
 * Endpoints:
 *   POST /api/escrow                    Create an escrow session + unsigned deposit XDR
 *   POST /api/escrow/:orderId/submit    Accept wallet-signed deposit XDR, submit on-chain
 *   POST /api/escrow/:orderId/release   Return unsigned release XDR for merchant to sign
 *   POST /api/escrow/:orderId/refund    Return unsigned refund XDR for payer/merchant
 *   GET  /api/escrow/:orderId           Read on-chain + session state
 *
 * ## Non-custodial design
 *
 * The server NEVER holds or sees private keys on the normal request path.
 *
 * - POST /api/escrow         → returns UNSIGNED deposit XDR (payer's wallet signs it)
 * - POST /api/escrow/submit  → accepts wallet-SIGNED deposit XDR, submits to chain
 * - POST /api/escrow/release → returns UNSIGNED release XDR (merchant's wallet signs it)
 * - POST /api/escrow/refund  → returns UNSIGNED refund XDR (payer/merchant's wallet signs it)
 *
 * The wallet-to-server round trip (sign → submit) lets us validate that the
 * signed XDR actually targets the configured contract and method before
 * forwarding to the network (XDR substitution defence).
 *
 * ## Configuration
 *
 * Required env vars (see packages/demo/.env.example):
 *   ESCROW_CONTRACT_ID  — deployed escrow contract Stellar address (C...)
 *   SOROBAN_RPC_URL     — Soroban RPC endpoint (default: testnet)
 *
 * If either is unset, all escrow endpoints return 503 "escrow not configured".
 * The server never crashes on missing config.
 *
 * ## Authentication
 *
 * - POST /api/escrow/:orderId/release requires `Authorization: Bearer <sessionsApiKey>`
 *   (same API-key pattern as GET /api/sessions in checkout-router.ts).
 *   Rationale: release transfers funds to the merchant — we must confirm the
 *   caller is an authorised operator of this server, not an arbitrary third party.
 *
 * ## XDR Validation (submit endpoint)
 *
 * Before submitting a signed deposit XDR we validate:
 *   1. Parseable as a Transaction (not FeeBump)
 *   2. Contains exactly one invokeHostFunction operation
 *   3. The invoked contract ID matches the configured ESCROW_CONTRACT_ID
 *   4. The invoked method name is "deposit"
 *   5. The transaction source account matches the session's payerAddress
 *
 * Failure on any check → 400, XDR discarded, nothing submitted.
 */

import { Router, type Request, type Response } from 'express';
import { TransactionBuilder, StrKey, xdr } from 'stellar-sdk';
import { NETWORK_PASSPHRASES } from '@stellarflow/core';
import type { StellarNetwork } from '@stellarflow/core';
import {
  EscrowClient,
  EscrowClientError,
  EscrowRpcError,
  HttpSorobanRpcClient,
  SOROBAN_RPC_URLS,
  sessionIdToOrderIdHex,
  escrowRecordToSessionStatus,
  type EscrowCheckoutSession,
  type SorobanRpcClient,
} from './escrow-session';

// ─── In-memory session store (simple map) ────────────────────────────────────

/**
 * Simple in-memory store for EscrowCheckoutSession objects.
 * Keyed by orderId (64-char hex string).
 *
 * In production this should be replaced with a persistent store.
 * The same limitation applies to the classic CheckoutSession store.
 */
const escrowSessions = new Map<string, EscrowCheckoutSession>();

/** Monotonic session ID counter (mirrors classic SessionManager pattern). */
let sessionCounter = 0n;

function createEscrowSession(
  params: Omit<EscrowCheckoutSession, 'sessionId' | 'orderId' | 'status' | 'createdAt'>,
): EscrowCheckoutSession {
  sessionCounter += 1n;
  const sessionId = sessionCounter.toString();
  const orderId = sessionIdToOrderIdHex(sessionCounter);
  const session: EscrowCheckoutSession = {
    ...params,
    sessionId,
    orderId,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  escrowSessions.set(orderId, session);
  return session;
}

function getEscrowSession(orderId: string): EscrowCheckoutSession | undefined {
  return escrowSessions.get(orderId);
}

function updateEscrowSession(orderId: string, updates: Partial<EscrowCheckoutSession>): void {
  const session = escrowSessions.get(orderId);
  if (session) {
    escrowSessions.set(orderId, { ...session, ...updates });
  }
}

// ─── Router options ───────────────────────────────────────────────────────────

export interface EscrowRouterOptions {
  /** Soroban RPC client — inject a mock for testing. Defaults to HttpSorobanRpcClient. */
  rpcClient?: SorobanRpcClient;
  /** Deployed escrow contract address (C...). If undefined → 503 on all routes. */
  contractId?: string;
  /** Network (testnet/mainnet). */
  network: StellarNetwork;
  /**
   * API key for the release endpoint (same pattern as sessionsApiKey in checkout-router).
   * If set, POST /api/escrow/:orderId/release requires `Authorization: Bearer <key>`.
   * If unset, the release endpoint is open (acceptable only for local dev).
   */
  releaseApiKey?: string;
  /**
   * Timeout ledgers for new escrow deposits.
   * Defaults to 0 (uses the contract's DEFAULT_TIMEOUT_LEDGERS = 518_400).
   */
  defaultTimeoutLedgers?: number;
}

// ─── Timeout ledger bounds ────────────────────────────────────────────────────

/** Minimum timeout: 1 ledger (must be positive to be meaningful) */
const MIN_TIMEOUT_LEDGERS = 1;
/** Maximum timeout: ~1 year in ledgers at ~5s/ledger */
const MAX_TIMEOUT_LEDGERS = 6_307_200;

// ─── Router factory ───────────────────────────────────────────────────────────

export function createEscrowRouter(opts: EscrowRouterOptions): Router {
  const router = Router();
  const { network, releaseApiKey, defaultTimeoutLedgers = 0 } = opts;

  // Determine if escrow is configured
  const contractId = opts.contractId;
  const isConfigured = !!contractId;

  // Build the RPC client (injected mock in tests, real client in production)
  const rpcClient: SorobanRpcClient =
    opts.rpcClient ??
    (isConfigured
      ? new HttpSorobanRpcClient(SOROBAN_RPC_URLS[network], network)
      : // Placeholder that always throws — only reached if isConfigured is true
        new HttpSorobanRpcClient(SOROBAN_RPC_URLS[network], network));

  // EscrowClient wraps the RPC client with contract-specific logic
  const escrowClient = isConfigured
    ? new EscrowClient({ rpcClient, contractId: contractId!, network })
    : null;

  // Network passphrase for XDR validation
  const networkPassphrase = NETWORK_PASSPHRASES[network];

  // ─── 503 guard ─────────────────────────────────────────────────────────────

  /** Return 503 if escrow is not configured. */
  function notConfigured(res: Response): boolean {
    if (!isConfigured || !escrowClient) {
      res.status(503).json({
        error:
          'Escrow checkout is not configured. Set ESCROW_CONTRACT_ID and SOROBAN_RPC_URL environment variables.',
      });
      return true;
    }
    return false;
  }

  // ─── Auth guard ─────────────────────────────────────────────────────────────

  /** Enforce Bearer token auth for merchant-only endpoints. */
  function requireReleaseAuth(req: Request, res: Response): boolean {
    if (!releaseApiKey) return false; // open in dev
    const auth = req.headers['authorization'];
    if (!auth || auth !== `Bearer ${releaseApiKey}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return true;
    }
    return false;
  }

  // ─── Error mapper ──────────────────────────────────────────────────────────

  /** Map EscrowClientError / EscrowRpcError to HTTP responses. */
  function handleEscrowError(err: unknown, res: Response, context: string): void {
    if (err instanceof EscrowClientError) {
      const statusMap: Record<number, number> = {
        1: 409, // AlreadyExists
        2: 404, // NotFound
        3: 409, // AlreadyReleased
        4: 409, // AlreadyRefunded
        5: 403, // NotMerchant
        6: 403, // NotAuthorized
        7: 409, // TimeoutNotElapsed
      };
      const httpStatus = statusMap[err.code] ?? 400;
      res.status(httpStatus).json({
        error: `Contract error: ${err.codeName} (code ${err.code})`,
        code: err.codeName,
      });
      return;
    }
    if (err instanceof EscrowRpcError) {
      const kindMap: Record<EscrowRpcError['kind'], number> = {
        SIMULATION_FAILED: 400,
        SEND_FAILED: 502,
        TX_FAILED: 400,
        POLL_TIMEOUT: 504,
        INVALID_XDR: 400,
        NETWORK_ERROR: 502,
      };
      res.status(kindMap[err.kind] ?? 502).json({
        error: `RPC error [${err.kind}]: ${err.detail ?? err.message}`,
        kind: err.kind,
      });
      return;
    }
    console.error(`[escrow] ${context} unexpected error:`, err);
    res.status(500).json({ error: 'Internal server error' });
  }

  // ─── POST /api/escrow ──────────────────────────────────────────────────────

  /**
   * Create an escrow session and return the unsigned deposit XDR.
   *
   * Body:
   *   {
   *     payerAddress: string,     // G... Stellar public key
   *     merchantAddress: string,  // G... Stellar public key
   *     tokenContractId: string,  // C... SAC contract address
   *     amount: string,           // positive integer (token's smallest unit)
   *     timeoutLedgers?: number   // optional; defaults to contract default
   *   }
   *
   * Returns:
   *   { orderId, sessionId, status, unsignedDepositXdr, networkPassphrase, createdAt }
   */
  router.post('/escrow', async (req: Request, res: Response) => {
    if (notConfigured(res)) return;
    try {
      const { payerAddress, merchantAddress, tokenContractId, amount, timeoutLedgers } =
        req.body as {
          payerAddress?: unknown;
          merchantAddress?: unknown;
          tokenContractId?: unknown;
          amount?: unknown;
          timeoutLedgers?: unknown;
        };

      // ── Validate inputs ───────────────────────────────────────────────────
      if (typeof payerAddress !== 'string' || !StrKey.isValidEd25519PublicKey(payerAddress)) {
        res.status(400).json({ error: 'payerAddress must be a valid Stellar public key (G...)' });
        return;
      }
      if (typeof merchantAddress !== 'string' || !StrKey.isValidEd25519PublicKey(merchantAddress)) {
        res.status(400).json({ error: 'merchantAddress must be a valid Stellar public key (G...)' });
        return;
      }
      if (
        typeof tokenContractId !== 'string' ||
        !StrKey.isValidContract(tokenContractId)
      ) {
        res.status(400).json({ error: 'tokenContractId must be a valid Stellar contract address (C...)' });
        return;
      }
      if (typeof amount !== 'string' || !/^\d+$/.test(amount) || BigInt(amount) <= 0n) {
        res.status(400).json({ error: 'amount must be a positive integer string (token smallest unit)' });
        return;
      }
      if (timeoutLedgers !== undefined) {
        if (typeof timeoutLedgers !== 'number' || !Number.isInteger(timeoutLedgers) ||
          timeoutLedgers < MIN_TIMEOUT_LEDGERS || timeoutLedgers > MAX_TIMEOUT_LEDGERS) {
          res.status(400).json({
            error: `timeoutLedgers must be an integer between ${MIN_TIMEOUT_LEDGERS} and ${MAX_TIMEOUT_LEDGERS}`,
          });
          return;
        }
      }

      // ── Create session ────────────────────────────────────────────────────
      const session = createEscrowSession({
        payerAddress,
        merchantAddress,
        tokenContractId,
        amount,
        network,
        contractId: contractId!,
      });

      // ── Build unsigned deposit XDR ────────────────────────────────────────
      const effectiveTimeout =
        timeoutLedgers !== undefined ? (timeoutLedgers as number) : defaultTimeoutLedgers;

      const { unsignedXdr, networkPassphrase: passphrase } =
        await escrowClient!.buildDepositXdr(
          payerAddress,
          merchantAddress,
          BigInt(amount),
          tokenContractId,
          session.orderId,
          effectiveTimeout,
        );

      res.status(201).json({
        orderId: session.orderId,
        sessionId: session.sessionId,
        status: session.status,
        unsignedDepositXdr: unsignedXdr,
        networkPassphrase: passphrase,
        createdAt: session.createdAt,
      });
    } catch (err) {
      handleEscrowError(err, res, 'POST /escrow');
    }
  });

  // ─── POST /api/escrow/:orderId/submit ─────────────────────────────────────

  /**
   * Accept a wallet-signed deposit XDR, validate it, submit to chain,
   * and update session status to 'deposited' on success.
   *
   * Body: { signedDepositXdr: string }
   *
   * Validation (in order):
   *   1. Session exists and is 'pending'
   *   2. XDR parses as a Transaction (not FeeBump)
   *   3. Contains exactly one invokeHostFunction operation
   *   4. Invoked contract ID == session.contractId
   *   5. Invoked method == "deposit"
   *   6. Transaction source == session.payerAddress
   *
   * Returns: { txHash, status: 'deposited' }
   */
  router.post('/escrow/:orderId/submit', async (req: Request, res: Response) => {
    if (notConfigured(res)) return;
    try {
      const { orderId } = req.params;
      const { signedDepositXdr } = req.body as { signedDepositXdr?: unknown };

      if (typeof signedDepositXdr !== 'string' || !signedDepositXdr) {
        res.status(400).json({ error: 'signedDepositXdr is required' });
        return;
      }

      const session = getEscrowSession(orderId ?? '');
      if (!session) {
        res.status(404).json({ error: 'Escrow session not found' });
        return;
      }
      if (session.status !== 'pending') {
        res.status(409).json({ error: `Session is ${session.status}, not pending` });
        return;
      }

      // ── Parse XDR ─────────────────────────────────────────────────────────
      let tx: ReturnType<typeof TransactionBuilder.fromXDR>;
      try {
        tx = TransactionBuilder.fromXDR(signedDepositXdr, networkPassphrase);
      } catch {
        res.status(400).json({ error: 'Invalid transaction XDR' });
        return;
      }

      if (!('operations' in tx)) {
        res.status(400).json({ error: 'FeeBump transactions are not accepted' });
        return;
      }

      // Cast to Transaction now that we've confirmed it's not a FeeBump
      const innerTx = tx as import('stellar-sdk').Transaction;

      // ── Validate operations ────────────────────────────────────────────────
      const ops = innerTx.operations;
      if (ops.length !== 1) {
        res.status(400).json({ error: `Expected exactly 1 operation, got ${ops.length}` });
        return;
      }

      const op = ops[0]!;
      if (op.type !== 'invokeHostFunction') {
        res.status(400).json({ error: `Expected invokeHostFunction, got ${op.type}` });
        return;
      }

      // Validate source account is the payer
      const txSource = innerTx.source;
      if (txSource !== session.payerAddress) {
        res.status(400).json({
          error: `Transaction source ${txSource} does not match payer ${session.payerAddress}`,
        });
        return;
      }

      // ── Validate contract & method from XDR ───────────────────────────────
      const xdrValidationError = validateDepositXdrOp(op, session.contractId, session.orderId);
      if (xdrValidationError) {
        res.status(400).json({ error: xdrValidationError });
        return;
      }

      // ── Mark submitting (double-submit guard) ─────────────────────────────
      updateEscrowSession(orderId, { status: 'failed' }); // hold slot

      // ── Submit ─────────────────────────────────────────────────────────────
      let txHash: string;
      try {
        const result = await rpcClient.submitSignedTx({
          signedXdr: signedDepositXdr,
          networkPassphrase,
        });
        txHash = result.txHash;
      } catch (err) {
        // Roll back to pending on failure so the payer can retry
        updateEscrowSession(orderId, { status: 'pending' });
        throw err;
      }

      updateEscrowSession(orderId, { status: 'deposited' });

      res.json({ txHash, status: 'deposited', orderId });
    } catch (err) {
      handleEscrowError(err, res, 'POST /escrow/:orderId/submit');
    }
  });

  // ─── POST /api/escrow/:orderId/release ────────────────────────────────────

  /**
   * Return an unsigned release XDR for the merchant's wallet to sign.
   *
   * Auth: requires Bearer token matching releaseApiKey (if configured).
   *
   * Body: { merchantAddress: string }
   *
   * Returns: { unsignedReleaseXdr, networkPassphrase }
   */
  router.post('/escrow/:orderId/release', async (req: Request, res: Response) => {
    if (notConfigured(res)) return;
    if (requireReleaseAuth(req, res)) return;
    try {
      const { orderId } = req.params;
      const { merchantAddress } = req.body as { merchantAddress?: unknown };

      if (typeof merchantAddress !== 'string' || !StrKey.isValidEd25519PublicKey(merchantAddress)) {
        res.status(400).json({ error: 'merchantAddress must be a valid Stellar public key (G...)' });
        return;
      }

      const session = getEscrowSession(orderId ?? '');
      if (!session) {
        res.status(404).json({ error: 'Escrow session not found' });
        return;
      }
      if (session.status !== 'deposited') {
        res.status(409).json({
          error: `Session is ${session.status}, not deposited. Release is only valid after a confirmed deposit.`,
        });
        return;
      }
      if (merchantAddress !== session.merchantAddress) {
        res.status(403).json({
          error: `merchantAddress ${merchantAddress} does not match session merchant ${session.merchantAddress}`,
        });
        return;
      }

      const { unsignedXdr, networkPassphrase: passphrase } =
        await escrowClient!.buildReleaseXdr(session.orderId, merchantAddress);

      res.json({
        unsignedReleaseXdr: unsignedXdr,
        networkPassphrase: passphrase,
        orderId,
      });
    } catch (err) {
      handleEscrowError(err, res, 'POST /escrow/:orderId/release');
    }
  });

  // ─── POST /api/escrow/:orderId/refund ─────────────────────────────────────

  /**
   * Return an unsigned refund XDR for the caller (payer or merchant) to sign.
   *
   * The contract enforces who may refund:
   *   - Merchant: any time, no timeout
   *   - Payer: only after timeout_ledgers have elapsed since deposit
   *
   * Body: { callerAddress: string }
   *
   * Returns: { unsignedRefundXdr, networkPassphrase }
   */
  router.post('/escrow/:orderId/refund', async (req: Request, res: Response) => {
    if (notConfigured(res)) return;
    try {
      const { orderId } = req.params;
      const { callerAddress } = req.body as { callerAddress?: unknown };

      if (typeof callerAddress !== 'string' || !StrKey.isValidEd25519PublicKey(callerAddress)) {
        res.status(400).json({ error: 'callerAddress must be a valid Stellar public key (G...)' });
        return;
      }

      const session = getEscrowSession(orderId ?? '');
      if (!session) {
        res.status(404).json({ error: 'Escrow session not found' });
        return;
      }
      if (session.status !== 'deposited') {
        res.status(409).json({
          error: `Session is ${session.status}, not deposited. Refund is only valid on a deposited escrow.`,
        });
        return;
      }

      // Server-side check: caller must be payer or merchant
      // (the contract enforces this on-chain too, but reject early for UX)
      if (callerAddress !== session.payerAddress && callerAddress !== session.merchantAddress) {
        res.status(403).json({
          error: 'callerAddress must be either the payer or merchant for this session',
        });
        return;
      }

      const { unsignedXdr, networkPassphrase: passphrase } =
        await escrowClient!.buildRefundXdr(session.orderId, callerAddress);

      res.json({
        unsignedRefundXdr: unsignedXdr,
        networkPassphrase: passphrase,
        orderId,
      });
    } catch (err) {
      handleEscrowError(err, res, 'POST /escrow/:orderId/refund');
    }
  });

  // ─── GET /api/escrow/:orderId ─────────────────────────────────────────────

  /**
   * Read on-chain state via simulateContract and reconcile with session status.
   *
   * The session status in memory is the server's view; the on-chain status is
   * the canonical source of truth. If they disagree (e.g. the deposit was
   * submitted directly without going through /submit), the on-chain status wins
   * and the session is updated.
   *
   * Returns:
   *   { orderId, status, onChain: EscrowRecord | null, session: EscrowCheckoutSession }
   */
  router.get('/escrow/:orderId', async (req: Request, res: Response) => {
    if (notConfigured(res)) return;
    try {
      const { orderId } = req.params;

      const session = getEscrowSession(orderId ?? '');
      if (!session) {
        res.status(404).json({ error: 'Escrow session not found' });
        return;
      }

      // Attempt on-chain read; if the escrow doesn't exist yet (pending before
      // first deposit), the contract returns NotFound — that's normal.
      let onChain: ReturnType<typeof escrowRecordToSessionStatus> | null = null;
      let onChainRecord: unknown = null;

      try {
        const record = await escrowClient!.getEscrow(session.orderId);
        onChainRecord = {
          payer: record.payer,
          merchant: record.merchant,
          amount: record.amount.toString(),
          token: record.token,
          status: record.status,
          deposited_at: record.deposited_at,
          timeout_ledgers: record.timeout_ledgers,
        };
        onChain = escrowRecordToSessionStatus(record);

        // Reconcile: on-chain wins if the session status is stale
        const currentSession = getEscrowSession(orderId ?? '')!;
        if (onChain !== currentSession.status && currentSession.status !== 'failed') {
          updateEscrowSession(orderId ?? '', { status: onChain });
        }
      } catch (rpcErr) {
        // EscrowClientError code 2 = NotFound = not yet deposited = fine
        if (rpcErr instanceof EscrowClientError && rpcErr.code === 2) {
          onChain = null;
        } else {
          // Other RPC errors — include in response but don't fail the whole call
          console.warn('[escrow] GET on-chain read failed:', rpcErr);
        }
      }

      const latestSession = getEscrowSession(orderId ?? '')!;
      res.json({
        orderId,
        status: latestSession.status,
        onChain: onChainRecord,
        session: {
          sessionId: latestSession.sessionId,
          payerAddress: latestSession.payerAddress,
          merchantAddress: latestSession.merchantAddress,
          tokenContractId: latestSession.tokenContractId,
          amount: latestSession.amount,
          network: latestSession.network,
          contractId: latestSession.contractId,
          createdAt: latestSession.createdAt,
        },
      });
    } catch (err) {
      handleEscrowError(err, res, 'GET /escrow/:orderId');
    }
  });

  return router;
}

// ─── XDR validation helpers ───────────────────────────────────────────────────

/**
 * Validate that an invokeHostFunction operation targets the correct contract
 * and method for a deposit call.
 *
 * Returns an error string if invalid, or null if valid.
 *
 * We parse the operation's HostFunction XDR to extract:
 *   - The contract address (must match configured contractId)
 *   - The function name (must be "deposit")
 *
 * This is the XDR substitution defence: a payer cannot submit a signed XDR
 * for a different contract or method and have it forwarded as a deposit.
 */
function validateDepositXdrOp(
  op: { type: string },
  expectedContractId: string,
  _expectedOrderId: string,
): string | null {
  try {
    // The operation is an invokeHostFunction from stellar-sdk.
    // Access the underlying XDR to extract contract and function name.
    const opAny = op as {
      func?: {
        invokeContract?: () => {
          contractAddress?: () => { contractId?: () => Buffer };
          functionName?: () => { toString?: () => string };
        };
      };
    };

    const invokeContract = opAny.func?.invokeContract?.();
    if (!invokeContract) {
      return 'Operation hostFunction does not contain an invokeContract call';
    }

    // Extract the function name (method)
    const fnName = invokeContract.functionName?.().toString?.() ?? '';
    if (fnName !== 'deposit') {
      return `Expected contract method "deposit", got "${fnName}"`;
    }

    // Extract the contract address and compare to expected
    const contractIdBytes = invokeContract.contractAddress?.().contractId?.();
    if (!contractIdBytes) {
      return 'Cannot extract contract address from XDR';
    }

    // Convert the contract ID bytes to a Stellar contract address (C...)
    // stellar-sdk's StrKey can encode contract IDs
    const { StrKey: StrKeyUtil } = require('stellar-sdk') as typeof import('stellar-sdk');
    const contractAddress = StrKeyUtil.encodeContract(contractIdBytes);
    if (contractAddress !== expectedContractId) {
      return `Contract address mismatch: expected ${expectedContractId}, got ${contractAddress}`;
    }

    return null;
  } catch (e) {
    // If XDR parsing fails, that itself is a validation failure
    return `XDR validation error: ${String(e)}`;
  }
}

// ─── Factory for demo/server.ts usage ────────────────────────────────────────

/**
 * Create an EscrowRouter from environment variables.
 * Used by packages/demo/src/server.ts.
 *
 * Returns null if ESCROW_CONTRACT_ID or SOROBAN_RPC_URL is not set — the
 * caller should still mount the router (it will return 503 on all routes).
 */
export function createEscrowRouterFromEnv(network: StellarNetwork, releaseApiKey?: string): Router {
  const contractId = process.env['ESCROW_CONTRACT_ID'];
  const rpcUrl = process.env['SOROBAN_RPC_URL'] ?? SOROBAN_RPC_URLS[network];

  if (!contractId) {
    console.warn(
      '[escrow] ESCROW_CONTRACT_ID is not set. Escrow routes will return 503.',
    );
  }

  return createEscrowRouter({
    contractId,
    network,
    releaseApiKey,
    rpcClient: contractId
      ? new HttpSorobanRpcClient(rpcUrl, network)
      : undefined,
  });
}
