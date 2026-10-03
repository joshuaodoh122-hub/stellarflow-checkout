/**
 * escrow-router.ts
 *
 * Express router exposing the StellarFlow Escrow Checkout API.
 *
 * Endpoints:
 *   POST /api/escrow                          Create session + unsigned deposit XDR
 *   POST /api/escrow/:orderId/submit          Submit wallet-signed deposit XDR
 *   POST /api/escrow/:orderId/release         Return unsigned release XDR
 *   POST /api/escrow/:orderId/release/submit  Submit wallet-signed release XDR
 *   POST /api/escrow/:orderId/refund          Return unsigned refund XDR
 *   POST /api/escrow/:orderId/refund/submit   Submit wallet-signed refund XDR
 *   GET  /api/escrow/:orderId                 Read on-chain + session state
 *
 * ## Non-custodial design
 *
 * The server NEVER holds or sees private keys on the normal request path.
 * Every state-changing operation follows the unsigned→sign→submit pattern:
 *   1. Server builds and returns UNSIGNED XDR (no key needed).
 *   2. Wallet signs the XDR (off-server, in user's wallet).
 *   3. Caller POSTs signed XDR to the /submit endpoint.
 *
 * ## XDR validation — what the server checks
 *
 * For deposit /submit:
 *   1. Parseable as Transaction (not FeeBump)
 *   2. Exactly one operation of type invokeHostFunction
 *   3. HostFunction type is invokeContract (not uploadContractWasm/createContract)
 *   4. Operation has no separate source account OR its source == payerAddress
 *   5. Transaction source account == session.payerAddress
 *   6. Invoked contract ID == session.contractId
 *   7. Method name == "deposit"
 *   8. arg[0] (payer)    == session.payerAddress
 *   9. arg[1] (merchant) == session.merchantAddress
 *  10. arg[2] (amount)   == BigInt(session.amount) (exact bigint comparison)
 *  11. arg[3] (token)    == session.tokenContractId
 *  12. arg[4] (order_id) == session.orderId bytes (exact 32-byte comparison)
 *  13. arg[5] (timeout)  == session.requestedTimeoutLedgers (exact u32 comparison)
 *
 * After on-chain confirmation, getEscrow() is called and payer/merchant/amount/token
 * are verified against the session before setting status to 'deposited'. Mismatch
 * sets a terminal 'mismatch' status.
 *
 * For release /submit:
 *   Same structural checks (1–7), method == "release", arg[0] == session.orderId,
 *   tx source == session.merchantAddress.
 *
 * For refund /submit:
 *   Same structural checks (1–7), method == "refund", arg[0] == session.orderId,
 *   arg[1] == callerAddress (payer or merchant), tx source == callerAddress.
 *
 * ## Configuration
 *
 * Required env vars (see packages/demo/.env.example):
 *   ESCROW_CONTRACT_ID  — deployed escrow contract Stellar address (C...)
 *   SOROBAN_RPC_URL     — Soroban RPC endpoint
 *
 * If ESCROW_CONTRACT_ID is unset, all escrow endpoints return 503.
 */

import { Router, type Request, type Response } from 'express';
import { timingSafeEqual } from 'crypto';
import { TransactionBuilder, StrKey, scValToNative } from 'stellar-sdk';
import { NETWORK_PASSPHRASES } from '@stellarflow/core';
import type { StellarNetwork } from '@stellarflow/core';
import {
  EscrowClient,
  EscrowClientError,
  EscrowRpcError,
  HttpSorobanRpcClient,
  SOROBAN_RPC_URLS,
  generateOrderId,
  escrowRecordToSessionStatus,
  type EscrowCheckoutSession,
  type SorobanRpcClient,
} from './escrow-session';

// ─── In-memory session store ──────────────────────────────────────────────────

/**
 * EscrowSessionStore encapsulates the in-memory session state.
 * Instantiated per createEscrowRouter call so test routers don't share state.
 */
class EscrowSessionStore {
  private readonly sessions = new Map<string, EscrowCheckoutSession>();
  private counter = 0n;

  create(params: Omit<EscrowCheckoutSession, 'sessionId' | 'orderId' | 'status' | 'createdAt'>): EscrowCheckoutSession {
    this.counter += 1n;
    const sessionId = this.counter.toString();
    const orderId = generateOrderId();
    const session: EscrowCheckoutSession = {
      ...params,
      sessionId,
      orderId,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    this.sessions.set(orderId, session);
    return session;
  }

  get(orderId: string): EscrowCheckoutSession | undefined {
    return this.sessions.get(orderId);
  }

  update(orderId: string, updates: Partial<EscrowCheckoutSession>): void {
    const session = this.sessions.get(orderId);
    if (session) {
      this.sessions.set(orderId, { ...session, ...updates });
    }
  }

  delete(orderId: string): void {
    this.sessions.delete(orderId);
  }
}

// ─── Router options ───────────────────────────────────────────────────────────

export interface EscrowRouterOptions {
  rpcClient?: SorobanRpcClient;
  contractId?: string;
  network: StellarNetwork;
  /**
   * If set, POST /release and POST /release/submit require
   * `Authorization: Bearer <releaseApiKey>`.
   */
  releaseApiKey?: string;
  defaultTimeoutLedgers?: number;
  /** Inject a custom store for testing. If omitted, a fresh store is created. */
  sessionStore?: EscrowSessionStore;
}

const MIN_TIMEOUT_LEDGERS = 1;
const MAX_TIMEOUT_LEDGERS = 6_307_200;

// ─── Router factory ───────────────────────────────────────────────────────────

export function createEscrowRouter(opts: EscrowRouterOptions): Router {
  const router = Router();
  const { network, releaseApiKey, defaultTimeoutLedgers = 0 } = opts;

  const contractId = opts.contractId;
  const isConfigured = !!contractId;

  const rpcClient: SorobanRpcClient =
    opts.rpcClient ??
    new HttpSorobanRpcClient(SOROBAN_RPC_URLS[network], network);

  const escrowClient = isConfigured
    ? new EscrowClient({ rpcClient, contractId: contractId!, network })
    : null;

  const networkPassphrase = NETWORK_PASSPHRASES[network];
  const store = opts.sessionStore ?? new EscrowSessionStore();

  /**
   * In-flight guard: set of orderIds currently being submitted to chain.
   * Prevents concurrent duplicate submissions without leaving sessions in
   * a stuck 'failed' state if the process crashes mid-submit.
   */
  const inFlight = new Set<string>();

  // ─── Guards ──────────────────────────────────────────────────────────────

  function notConfigured(res: Response): boolean {
    if (!isConfigured || !escrowClient) {
      res.status(503).json({
        error: 'Escrow checkout is not configured. Set ESCROW_CONTRACT_ID and SOROBAN_RPC_URL.',
      });
      return true;
    }
    return false;
  }

  function requireReleaseAuth(req: Request, res: Response): boolean {
    const isProd = process.env['NODE_ENV'] === 'production';

    if (!releaseApiKey) {
      // In production with no key configured, fail closed — do not allow every
      // request through. The startup warning in createEscrowRouterFromEnv alerts
      // the operator; here we reject the request cleanly.
      if (isProd) {
        res.status(503).json({
          error:
            'Release/refund endpoints require RELEASE_API_KEY in production. ' +
            'Set the RELEASE_API_KEY environment variable.',
        });
        return true;
      }
      // Non-production with no key: open (dev/test convenience).
      return false;
    }

    const auth = req.headers['authorization'];
    const provided = auth?.startsWith('Bearer ') ? auth.slice(7) : '';

    // Use timing-safe comparison to prevent timing-oracle attacks.
    // Pad/truncate both sides to equal length so timingSafeEqual does not throw.
    const keyBuf = Buffer.from(releaseApiKey, 'utf8');
    const providedBuf = Buffer.alloc(keyBuf.length);
    Buffer.from(provided, 'utf8').copy(providedBuf);

    const lengthMatch = Buffer.from(provided, 'utf8').length === keyBuf.length;
    const valueMatch = timingSafeEqual(keyBuf, providedBuf);

    if (!lengthMatch || !valueMatch) {
      res.status(401).json({ error: 'Unauthorized' });
      return true;
    }
    return false;
  }

  // ─── Error mapper ─────────────────────────────────────────────────────────

  function handleEscrowError(err: unknown, res: Response, context: string): void {
    if (err instanceof EscrowClientError) {
      const statusMap: Record<number, number> = {
        1: 409, 2: 404, 3: 409, 4: 409, 5: 403, 6: 403, 7: 409,
      };
      res.status(statusMap[err.code] ?? 400).json({
        error: `Contract error: ${err.codeName} (code ${err.code})`,
        code: err.codeName,
      });
      return;
    }
    if (err instanceof EscrowRpcError) {
      const kindMap: Record<EscrowRpcError['kind'], number> = {
        SIMULATION_FAILED: 400, SEND_FAILED: 502, TX_FAILED: 400,
        POLL_TIMEOUT: 504, INVALID_XDR: 400, NETWORK_ERROR: 502,
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

  // ─── POST /api/escrow ─────────────────────────────────────────────────────

  router.post('/escrow', async (req: Request, res: Response) => {
    if (notConfigured(res)) return;
    try {
      const { payerAddress, merchantAddress, tokenContractId, amount, timeoutLedgers } =
        req.body as Record<string, unknown>;

      if (typeof payerAddress !== 'string' || !StrKey.isValidEd25519PublicKey(payerAddress)) {
        res.status(400).json({ error: 'payerAddress must be a valid Stellar public key (G...)' });
        return;
      }
      if (typeof merchantAddress !== 'string' || !StrKey.isValidEd25519PublicKey(merchantAddress)) {
        res.status(400).json({ error: 'merchantAddress must be a valid Stellar public key (G...)' });
        return;
      }
      if (typeof tokenContractId !== 'string' || !StrKey.isValidContract(tokenContractId)) {
        res.status(400).json({ error: 'tokenContractId must be a valid Stellar contract address (C...)' });
        return;
      }
      if (typeof amount !== 'string' || !/^\d+$/.test(amount) || BigInt(amount) <= 0n) {
        res.status(400).json({ error: 'amount must be a positive integer string (token smallest unit)' });
        return;
      }
      let effectiveTimeout = defaultTimeoutLedgers;
      if (timeoutLedgers !== undefined) {
        if (typeof timeoutLedgers !== 'number' || !Number.isInteger(timeoutLedgers) ||
          timeoutLedgers < MIN_TIMEOUT_LEDGERS || timeoutLedgers > MAX_TIMEOUT_LEDGERS) {
          res.status(400).json({
            error: `timeoutLedgers must be an integer between ${MIN_TIMEOUT_LEDGERS} and ${MAX_TIMEOUT_LEDGERS}`,
          });
          return;
        }
        effectiveTimeout = timeoutLedgers as number;
      }

      // Create session (assigns random orderId)
      const session = store.create({
        payerAddress,
        merchantAddress,
        tokenContractId,
        amount,
        requestedTimeoutLedgers: effectiveTimeout,
        network,
        contractId: contractId!,
      });

      // Build unsigned XDR. If this fails, remove the orphan session.
      let unsignedXdr: string;
      let passphrase: string;
      try {
        const result = await escrowClient!.buildDepositXdr(
          payerAddress, merchantAddress, BigInt(amount), tokenContractId,
          session.orderId, effectiveTimeout,
        );
        unsignedXdr = result.unsignedXdr;
        passphrase = result.networkPassphrase;
      } catch (err) {
        store.delete(session.orderId);
        throw err;
      }

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

  router.post('/escrow/:orderId/submit', async (req: Request, res: Response) => {
    if (notConfigured(res)) return;
    try {
      const { orderId } = req.params;
      const { signedDepositXdr } = req.body as Record<string, unknown>;

      if (typeof signedDepositXdr !== 'string' || !signedDepositXdr) {
        res.status(400).json({ error: 'signedDepositXdr is required' });
        return;
      }

      const session = store.get(orderId ?? '');
      if (!session) {
        res.status(404).json({ error: 'Escrow session not found' });
        return;
      }
      if (session.status !== 'pending') {
        res.status(409).json({ error: `Session is ${session.status}, not pending` });
        return;
      }

      // In-flight guard: prevent concurrent duplicate submits
      if (inFlight.has(orderId)) {
        res.status(409).json({ error: 'Deposit submission already in progress for this session' });
        return;
      }

      // Parse XDR
      let tx: import('stellar-sdk').Transaction;
      try {
        const parsed = TransactionBuilder.fromXDR(signedDepositXdr, networkPassphrase);
        if (!('operations' in parsed)) {
          res.status(400).json({ error: 'FeeBump transactions are not accepted' });
          return;
        }
        tx = parsed as import('stellar-sdk').Transaction;
      } catch {
        res.status(400).json({ error: 'Invalid transaction XDR' });
        return;
      }

      // Validate the deposit arguments
      const depositValidationError = validateDepositArgs(tx, session, networkPassphrase);
      if (depositValidationError) {
        res.status(400).json({ error: depositValidationError });
        return;
      }

      // In-flight: mark before async submit, clear in finally
      inFlight.add(orderId);
      let txHash: string;
      try {
        const result = await rpcClient.submitSignedTx({ signedXdr: signedDepositXdr, networkPassphrase });
        txHash = result.txHash;
      } catch (err) {
        inFlight.delete(orderId);
        throw err;
      }
      inFlight.delete(orderId);

      // Post-confirmation on-chain verification (Fix 1c)
      // Read the on-chain record and verify it matches the session before
      // marking deposited. If getEscrow throws (e.g. POLL_TIMEOUT from RPC),
      // the outer catch handles it — session stays pending for retry.
      const record = await escrowClient!.getEscrow(session.orderId);
      const mismatch = verifyOnChainRecord(record, session);
      if (mismatch) {
        store.update(orderId, { status: 'mismatch' });
        res.status(400).json({
          error: `On-chain record does not match session: ${mismatch}`,
          txHash,
          status: 'mismatch',
        });
        return;
      }

      store.update(orderId, { status: 'deposited' });
      res.json({ txHash, status: 'deposited', orderId });
    } catch (err) {
      inFlight.delete(req.params.orderId ?? '');
      handleEscrowError(err, res, 'POST /escrow/:orderId/submit');
    }
  });

  // ─── POST /api/escrow/:orderId/release ────────────────────────────────────

  router.post('/escrow/:orderId/release', async (req: Request, res: Response) => {
    if (notConfigured(res)) return;
    if (requireReleaseAuth(req, res)) return;
    try {
      const { orderId } = req.params;
      const { merchantAddress } = req.body as Record<string, unknown>;

      if (typeof merchantAddress !== 'string' || !StrKey.isValidEd25519PublicKey(merchantAddress)) {
        res.status(400).json({ error: 'merchantAddress must be a valid Stellar public key (G...)' });
        return;
      }

      const session = store.get(orderId ?? '');
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

      res.json({ unsignedReleaseXdr: unsignedXdr, networkPassphrase: passphrase, orderId });
    } catch (err) {
      handleEscrowError(err, res, 'POST /escrow/:orderId/release');
    }
  });

  // ─── POST /api/escrow/:orderId/release/submit ─────────────────────────────

  router.post('/escrow/:orderId/release/submit', async (req: Request, res: Response) => {
    if (notConfigured(res)) return;
    if (requireReleaseAuth(req, res)) return;
    try {
      const { orderId } = req.params;
      const { signedReleaseXdr } = req.body as Record<string, unknown>;

      if (typeof signedReleaseXdr !== 'string' || !signedReleaseXdr) {
        res.status(400).json({ error: 'signedReleaseXdr is required' });
        return;
      }

      const session = store.get(orderId ?? '');
      if (!session) {
        res.status(404).json({ error: 'Escrow session not found' });
        return;
      }
      if (session.status !== 'deposited') {
        res.status(409).json({ error: `Session is ${session.status}, not deposited` });
        return;
      }

      if (inFlight.has(orderId + ':release')) {
        res.status(409).json({ error: 'Release submission already in progress' });
        return;
      }

      // Parse and validate release XDR
      let tx: import('stellar-sdk').Transaction;
      try {
        const parsed = TransactionBuilder.fromXDR(signedReleaseXdr, networkPassphrase);
        if (!('operations' in parsed)) {
          res.status(400).json({ error: 'FeeBump transactions are not accepted' });
          return;
        }
        tx = parsed as import('stellar-sdk').Transaction;
      } catch {
        res.status(400).json({ error: 'Invalid transaction XDR' });
        return;
      }

      const releaseValidationError = validateReleaseArgs(tx, session, networkPassphrase);
      if (releaseValidationError) {
        res.status(400).json({ error: releaseValidationError });
        return;
      }

      inFlight.add(orderId + ':release');
      let txHash: string;
      try {
        const result = await rpcClient.submitSignedTx({ signedXdr: signedReleaseXdr, networkPassphrase });
        txHash = result.txHash;
      } catch (err) {
        inFlight.delete(orderId + ':release');
        throw err;
      }
      inFlight.delete(orderId + ':release');

      // Post-confirmation: verify Released on-chain
      const releaseRecord = await escrowClient!.getEscrow(session.orderId);
      if (releaseRecord.status !== 'Released') {
        res.status(400).json({
          error: `On-chain status is ${releaseRecord.status}, expected Released`,
          txHash,
        });
        return;
      }

      store.update(orderId, { status: 'fulfilled' });
      res.json({ txHash, status: 'fulfilled', orderId });
    } catch (err) {
      inFlight.delete((req.params.orderId ?? '') + ':release');
      handleEscrowError(err, res, 'POST /escrow/:orderId/release/submit');
    }
  });

  // ─── POST /api/escrow/:orderId/refund ─────────────────────────────────────

  router.post('/escrow/:orderId/refund', async (req: Request, res: Response) => {
    if (notConfigured(res)) return;
    try {
      const { orderId } = req.params;
      const { callerAddress } = req.body as Record<string, unknown>;

      if (typeof callerAddress !== 'string' || !StrKey.isValidEd25519PublicKey(callerAddress)) {
        res.status(400).json({ error: 'callerAddress must be a valid Stellar public key (G...)' });
        return;
      }

      const session = store.get(orderId ?? '');
      if (!session) {
        res.status(404).json({ error: 'Escrow session not found' });
        return;
      }
      if (session.status !== 'deposited') {
        res.status(409).json({ error: `Session is ${session.status}, not deposited` });
        return;
      }
      if (callerAddress !== session.payerAddress && callerAddress !== session.merchantAddress) {
        res.status(403).json({ error: 'callerAddress must be either the payer or merchant for this session' });
        return;
      }

      const { unsignedXdr, networkPassphrase: passphrase } =
        await escrowClient!.buildRefundXdr(session.orderId, callerAddress);

      res.json({ unsignedRefundXdr: unsignedXdr, networkPassphrase: passphrase, orderId });
    } catch (err) {
      handleEscrowError(err, res, 'POST /escrow/:orderId/refund');
    }
  });

  // ─── POST /api/escrow/:orderId/refund/submit ──────────────────────────────

  router.post('/escrow/:orderId/refund/submit', async (req: Request, res: Response) => {
    if (notConfigured(res)) return;
    try {
      const { orderId } = req.params;
      const { signedRefundXdr, callerAddress } = req.body as Record<string, unknown>;

      if (typeof signedRefundXdr !== 'string' || !signedRefundXdr) {
        res.status(400).json({ error: 'signedRefundXdr is required' });
        return;
      }
      if (typeof callerAddress !== 'string' || !StrKey.isValidEd25519PublicKey(callerAddress)) {
        res.status(400).json({ error: 'callerAddress must be a valid Stellar public key (G...)' });
        return;
      }

      const session = store.get(orderId ?? '');
      if (!session) {
        res.status(404).json({ error: 'Escrow session not found' });
        return;
      }
      if (session.status !== 'deposited') {
        res.status(409).json({ error: `Session is ${session.status}, not deposited` });
        return;
      }
      if (callerAddress !== session.payerAddress && callerAddress !== session.merchantAddress) {
        res.status(403).json({ error: 'callerAddress must be either the payer or merchant' });
        return;
      }

      if (inFlight.has(orderId + ':refund')) {
        res.status(409).json({ error: 'Refund submission already in progress' });
        return;
      }

      let tx: import('stellar-sdk').Transaction;
      try {
        const parsed = TransactionBuilder.fromXDR(signedRefundXdr, networkPassphrase);
        if (!('operations' in parsed)) {
          res.status(400).json({ error: 'FeeBump transactions are not accepted' });
          return;
        }
        tx = parsed as import('stellar-sdk').Transaction;
      } catch {
        res.status(400).json({ error: 'Invalid transaction XDR' });
        return;
      }

      const refundValidationError = validateRefundArgs(tx, session, callerAddress, networkPassphrase);
      if (refundValidationError) {
        res.status(400).json({ error: refundValidationError });
        return;
      }

      inFlight.add(orderId + ':refund');
      let txHash: string;
      try {
        const result = await rpcClient.submitSignedTx({ signedXdr: signedRefundXdr, networkPassphrase });
        txHash = result.txHash;
      } catch (err) {
        inFlight.delete(orderId + ':refund');
        throw err;
      }
      inFlight.delete(orderId + ':refund');

      // Post-confirmation: verify Refunded on-chain
      const refundRecord = await escrowClient!.getEscrow(session.orderId);
      if (refundRecord.status !== 'Refunded') {
        res.status(400).json({
          error: `On-chain status is ${refundRecord.status}, expected Refunded`,
          txHash,
        });
        return;
      }

      store.update(orderId, { status: 'refunded' });
      res.json({ txHash, status: 'refunded', orderId });
    } catch (err) {
      inFlight.delete((req.params.orderId ?? '') + ':refund');
      handleEscrowError(err, res, 'POST /escrow/:orderId/refund/submit');
    }
  });

  // ─── GET /api/escrow/:orderId ─────────────────────────────────────────────

  router.get('/escrow/:orderId', async (req: Request, res: Response) => {
    if (notConfigured(res)) return;
    try {
      const { orderId } = req.params;

      const session = store.get(orderId ?? '');
      if (!session) {
        res.status(404).json({ error: 'Escrow session not found' });
        return;
      }

      let onChainRecord: unknown = null;
      let reconcileError: string | null = null;

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

        // Only reconcile status if payer/merchant/amount/token match the session.
        // If they don't match, do NOT promote the session and report the discrepancy.
        const mismatch = verifyOnChainRecord(record, session);
        if (mismatch) {
          reconcileError = `On-chain record does not match session: ${mismatch}`;
          // Do not update status — return discrepancy for investigation
        } else {
          const onChainStatus = escrowRecordToSessionStatus(record);
          const current = store.get(orderId ?? '')!;
          // Only update if not already in a terminal mismatch/failed state
          if (current.status !== 'mismatch' && current.status !== 'failed') {
            if (onChainStatus !== current.status) {
              store.update(orderId ?? '', { status: onChainStatus });
            }
          }
        }
      } catch (rpcErr) {
        if (rpcErr instanceof EscrowClientError && rpcErr.code === 2) {
          // NotFound = not yet deposited on-chain, normal for pending sessions
          onChainRecord = null;
        } else {
          console.warn('[escrow] GET on-chain read failed:', rpcErr);
        }
      }

      const latestSession = store.get(orderId ?? '')!;
      res.json({
        orderId,
        status: latestSession.status,
        onChain: onChainRecord,
        reconcileError,
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
 * Extract the invokeContract call from an invokeHostFunction operation.
 * Returns an error string if the operation is not a valid invokeContract call.
 */
function extractInvokeContract(op: { type: string }): {
  ic: { functionName: () => { toString: () => string }; args: () => unknown[] };
  contractAddress: string;
} | { error: string } {
  if (op.type !== 'invokeHostFunction') {
    return { error: `Expected invokeHostFunction operation, got ${op.type}` };
  }

  const opAny = op as {
    func?: {
      switch: () => { name: string };
      invokeContract?: () => {
        contractAddress: () => { contractId: () => Buffer };
        functionName: () => { toString: () => string };
        args: () => unknown[];
      };
    };
  };

  const funcSwitch = opAny.func?.switch()?.name;
  if (funcSwitch !== 'hostFunctionTypeInvokeContract') {
    return { error: `HostFunction type must be invokeContract, got ${funcSwitch ?? 'unknown'}` };
  }

  const ic = opAny.func?.invokeContract?.();
  if (!ic) {
    return { error: 'Cannot access invokeContract from operation' };
  }

  let contractAddress: string;
  try {
    contractAddress = StrKey.encodeContract(ic.contractAddress().contractId());
  } catch (e) {
    return { error: `Cannot decode contract address: ${String(e)}` };
  }

  return { ic, contractAddress };
}

/**
 * Validate a signed deposit transaction's arguments against the session.
 *
 * Checks (in order):
 *  1. Exactly one operation
 *  2. invokeHostFunction with invokeContract host function type
 *  3. No per-operation source account OR it matches payerAddress
 *  4. Transaction source == payerAddress
 *  5. Contract ID == session.contractId
 *  6. Method == "deposit"
 *  7. arg[0] payer    == session.payerAddress
 *  8. arg[1] merchant == session.merchantAddress
 *  9. arg[2] amount   == BigInt(session.amount)  (exact)
 * 10. arg[3] token    == session.tokenContractId
 * 11. arg[4] order_id == session.orderId bytes   (exact 32-byte comparison)
 * 12. arg[5] timeout  == session.requestedTimeoutLedgers (exact)
 */
function validateDepositArgs(
  tx: import('stellar-sdk').Transaction,
  session: EscrowCheckoutSession,
  _networkPassphrase: string,
): string | null {
  if (tx.operations.length !== 1) {
    return `Expected exactly 1 operation, got ${tx.operations.length}`;
  }

  const op = tx.operations[0]!;

  // Check per-operation source if present
  if ('source' in op && op.source && op.source !== session.payerAddress) {
    return `Operation source ${String(op.source)} does not match payer ${session.payerAddress}`;
  }

  // Transaction-level source must be payer
  if (tx.source !== session.payerAddress) {
    return `Transaction source ${tx.source} does not match payer ${session.payerAddress}`;
  }

  const extracted = extractInvokeContract(op);
  if ('error' in extracted) return extracted.error;
  const { ic, contractAddress } = extracted;

  if (contractAddress !== session.contractId) {
    return `Contract address mismatch: expected ${session.contractId}, got ${contractAddress}`;
  }

  const methodName = ic.functionName().toString();
  if (methodName !== 'deposit') {
    return `Expected method "deposit", got "${methodName}"`;
  }

  // Decode and validate each argument positionally
  const rawArgs = ic.args();
  if (rawArgs.length !== 6) {
    return `Expected 6 deposit arguments, got ${rawArgs.length}`;
  }

  // arg[0]: payer (Address → string)
  const argPayer = decodeScVal(rawArgs[0]);
  if (typeof argPayer !== 'string' || argPayer !== session.payerAddress) {
    return `arg[0] payer mismatch: expected ${session.payerAddress}, got ${String(argPayer)}`;
  }

  // arg[1]: merchant (Address → string)
  const argMerchant = decodeScVal(rawArgs[1]);
  if (typeof argMerchant !== 'string' || argMerchant !== session.merchantAddress) {
    return `arg[1] merchant mismatch: expected ${session.merchantAddress}, got ${String(argMerchant)}`;
  }

  // arg[2]: amount (i128 → bigint)
  const argAmount = decodeScVal(rawArgs[2]);
  if (typeof argAmount !== 'bigint' || argAmount !== BigInt(session.amount)) {
    return `arg[2] amount mismatch: expected ${session.amount}, got ${String(argAmount)}`;
  }

  // arg[3]: token (Address → string)
  const argToken = decodeScVal(rawArgs[3]);
  if (typeof argToken !== 'string' || argToken !== session.tokenContractId) {
    return `arg[3] token mismatch: expected ${session.tokenContractId}, got ${String(argToken)}`;
  }

  // arg[4]: order_id (bytes → Buffer-like)
  const argOrderId = decodeScVal(rawArgs[4]);
  const expectedBytes = Buffer.from(session.orderId, 'hex');
  let actualBytes: Buffer;
  if (Buffer.isBuffer(argOrderId)) {
    actualBytes = argOrderId;
  } else if (argOrderId && typeof argOrderId === 'object' && 'data' in argOrderId) {
    actualBytes = Buffer.from((argOrderId as { data: number[] }).data);
  } else {
    return `arg[4] order_id has unexpected type: ${typeof argOrderId}`;
  }
  if (!actualBytes.equals(expectedBytes)) {
    return `arg[4] order_id mismatch: expected ${session.orderId}, got ${actualBytes.toString('hex')}`;
  }

  // arg[5]: timeout_ledgers (u32 → number)
  const argTimeout = decodeScVal(rawArgs[5]);
  if (typeof argTimeout !== 'number' || argTimeout !== session.requestedTimeoutLedgers) {
    return `arg[5] timeout_ledgers mismatch: expected ${session.requestedTimeoutLedgers}, got ${String(argTimeout)}`;
  }

  return null;
}

/**
 * Validate a signed release transaction.
 * method == "release", arg[0] == session.orderId, tx.source == session.merchantAddress
 */
function validateReleaseArgs(
  tx: import('stellar-sdk').Transaction,
  session: EscrowCheckoutSession,
  _networkPassphrase: string,
): string | null {
  if (tx.operations.length !== 1) {
    return `Expected exactly 1 operation, got ${tx.operations.length}`;
  }

  const op = tx.operations[0]!;

  if (tx.source !== session.merchantAddress) {
    return `Transaction source ${tx.source} does not match merchant ${session.merchantAddress}`;
  }

  const extracted = extractInvokeContract(op);
  if ('error' in extracted) return extracted.error;
  const { ic, contractAddress } = extracted;

  if (contractAddress !== session.contractId) {
    return `Contract address mismatch: expected ${session.contractId}, got ${contractAddress}`;
  }

  const methodName = ic.functionName().toString();
  if (methodName !== 'release') {
    return `Expected method "release", got "${methodName}"`;
  }

  const rawArgs = ic.args();
  if (rawArgs.length !== 1) {
    return `Expected 1 release argument, got ${rawArgs.length}`;
  }

  const argOrderId = decodeScVal(rawArgs[0]);
  const expectedBytes = Buffer.from(session.orderId, 'hex');
  let actualBytes: Buffer;
  if (Buffer.isBuffer(argOrderId)) {
    actualBytes = argOrderId;
  } else if (argOrderId && typeof argOrderId === 'object' && 'data' in argOrderId) {
    actualBytes = Buffer.from((argOrderId as { data: number[] }).data);
  } else {
    return `arg[0] order_id has unexpected type`;
  }
  if (!actualBytes.equals(expectedBytes)) {
    return `arg[0] order_id mismatch: expected ${session.orderId}, got ${actualBytes.toString('hex')}`;
  }

  return null;
}

/**
 * Validate a signed refund transaction.
 * method == "refund", arg[0] == session.orderId, arg[1] == callerAddress,
 * tx.source == callerAddress
 */
function validateRefundArgs(
  tx: import('stellar-sdk').Transaction,
  session: EscrowCheckoutSession,
  callerAddress: string,
  _networkPassphrase: string,
): string | null {
  if (tx.operations.length !== 1) {
    return `Expected exactly 1 operation, got ${tx.operations.length}`;
  }

  const op = tx.operations[0]!;

  if (tx.source !== callerAddress) {
    return `Transaction source ${tx.source} does not match callerAddress ${callerAddress}`;
  }

  const extracted = extractInvokeContract(op);
  if ('error' in extracted) return extracted.error;
  const { ic, contractAddress } = extracted;

  if (contractAddress !== session.contractId) {
    return `Contract address mismatch: expected ${session.contractId}, got ${contractAddress}`;
  }

  const methodName = ic.functionName().toString();
  if (methodName !== 'refund') {
    return `Expected method "refund", got "${methodName}"`;
  }

  const rawArgs = ic.args();
  if (rawArgs.length !== 2) {
    return `Expected 2 refund arguments, got ${rawArgs.length}`;
  }

  const argOrderId = decodeScVal(rawArgs[0]);
  const expectedBytes = Buffer.from(session.orderId, 'hex');
  let actualBytes: Buffer;
  if (Buffer.isBuffer(argOrderId)) {
    actualBytes = argOrderId;
  } else if (argOrderId && typeof argOrderId === 'object' && 'data' in argOrderId) {
    actualBytes = Buffer.from((argOrderId as { data: number[] }).data);
  } else {
    return `arg[0] order_id has unexpected type`;
  }
  if (!actualBytes.equals(expectedBytes)) {
    return `arg[0] order_id mismatch: expected ${session.orderId}, got ${actualBytes.toString('hex')}`;
  }

  const argCaller = decodeScVal(rawArgs[1]);
  if (typeof argCaller !== 'string' || argCaller !== callerAddress) {
    return `arg[1] caller mismatch: expected ${callerAddress}, got ${String(argCaller)}`;
  }

  return null;
}

/** Decode a raw ScVal to a native JS value using scValToNative. */
function decodeScVal(raw: unknown): unknown {
  try {
    return scValToNative(raw as Parameters<typeof scValToNative>[0]);
  } catch {
    return undefined;
  }
}

/**
 * Verify that an on-chain EscrowRecord matches the session's stored values.
 * Returns a mismatch description string, or null if everything matches.
 */
function verifyOnChainRecord(
  record: { payer: string; merchant: string; amount: bigint; token: string; status: string },
  session: EscrowCheckoutSession,
): string | null {
  if (record.payer !== session.payerAddress) {
    return `payer: on-chain ${record.payer} != session ${session.payerAddress}`;
  }
  if (record.merchant !== session.merchantAddress) {
    return `merchant: on-chain ${record.merchant} != session ${session.merchantAddress}`;
  }
  if (record.amount !== BigInt(session.amount)) {
    return `amount: on-chain ${record.amount} != session ${session.amount}`;
  }
  if (record.token !== session.tokenContractId) {
    return `token: on-chain ${record.token} != session ${session.tokenContractId}`;
  }
  return null;
}

// ─── Factory for demo/server.ts usage ────────────────────────────────────────

export function createEscrowRouterFromEnv(network: StellarNetwork, releaseApiKey?: string): Router {
  const contractId = process.env['ESCROW_CONTRACT_ID'];
  const rpcUrl = process.env['SOROBAN_RPC_URL'] ?? SOROBAN_RPC_URLS[network];
  const isProd = process.env['NODE_ENV'] === 'production';

  if (!contractId) {
    console.warn('[escrow] ESCROW_CONTRACT_ID is not set. Escrow routes will return 503.');
  }

  if (isProd && !releaseApiKey) {
    console.warn(
      '[escrow] WARNING: RELEASE_API_KEY is not set in production. ' +
      'Release and refund endpoints will return 503 until it is configured. ' +
      'Set the RELEASE_API_KEY environment variable.',
    );
  }

  return createEscrowRouter({
    contractId,
    network,
    releaseApiKey,
    rpcClient: contractId ? new HttpSorobanRpcClient(rpcUrl, network) : undefined,
  });
}

// Export store for testing
export { EscrowSessionStore };
