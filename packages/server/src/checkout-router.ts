/**
 * checkout-router.ts
 *
 * Express router exposing the StellarFlow Checkout API.
 *
 * Endpoints:
 *   POST /api/checkout                  Create a checkout session + SEP-0007 URI + QR
 *   GET  /api/checkout/:orderId          Poll session status
 *   POST /api/checkout/:orderId/tx       Build unsigned payment tx for in-browser signing
 *   POST /api/checkout/:orderId/submit   Submit a signed tx XDR to Horizon
 *   GET  /api/sessions                   List all sessions (demo/merchant dashboard)
 *
 * Security notes:
 *   - All responses set Content-Type: application/json
 *   - orderId is parsed as BigInt to prevent integer overflow on 64-bit IDs
 *   - Input validation is explicit — no silent coercions
 *   - The /tx endpoint never receives or stores private keys — it only builds
 *     an unsigned transaction envelope. Signing happens entirely in the browser.
 */

import { Router, type Request, type Response } from 'express';
import {
  Horizon as StellarHorizon,
  TransactionBuilder,
  Operation,
  Asset as StellarAsset,
  Memo,
} from 'stellar-sdk';
import {
  sessionToSep0007Uri,
  renderQr,
  QuoteService,
  type Asset,
  type StellarNetwork,
  USDC_ISSUERS,
  HORIZON_URLS,
  NETWORK_PASSPHRASES,
} from '@stellarflow/core';
import type { SessionManager } from './session-manager';
import { buildPaymentTx } from './tx-builder';

export interface CheckoutRouterOptions {
  sessionManager: SessionManager;
  quoteService: QuoteService;
  merchantAddress: string;
  network: StellarNetwork;
  originDomain?: string;
}

export function createCheckoutRouter(opts: CheckoutRouterOptions): Router {
  const router = Router();
  const { sessionManager, quoteService, merchantAddress, network, originDomain } = opts;

  // Horizon server instance — shared for tx submission
  const horizonServer = new StellarHorizon.Server(HORIZON_URLS[network]);

  // ─── Helper: parse orderId param ───────────────────────────────────────────

  function parseOrderId(raw: string): bigint | null {
    try {
      return BigInt(raw);
    } catch {
      return null;
    }
  }

  // ─── POST /api/checkout ────────────────────────────────────────────────────

  /**
   * Create a checkout session.
   * Body: { fiatAmount: number, assetCode: 'XLM' | 'USDC', label?: string }
   * Returns: session details + SEP-0007 URI + QR code data URLs.
   */
  router.post('/checkout', async (req: Request, res: Response) => {
    try {
      const { fiatAmount, assetCode, label } = req.body as {
        fiatAmount?: unknown;
        assetCode?: unknown;
        label?: unknown;
      };

      if (typeof fiatAmount !== 'number' || fiatAmount <= 0) {
        res.status(400).json({ error: 'fiatAmount must be a positive number' });
        return;
      }
      if (assetCode !== 'XLM' && assetCode !== 'USDC') {
        res.status(400).json({ error: "assetCode must be 'XLM' or 'USDC'" });
        return;
      }

      const quote = await quoteService.quote(fiatAmount, assetCode);
      const asset: Asset =
        assetCode === 'USDC'
          ? { code: 'USDC', issuer: USDC_ISSUERS[network] }
          : { code: 'XLM' };

      const session = await sessionManager.createSession({
        asset,
        amount: quote.cryptoAmount,
        destination: merchantAddress,
        expiresAt: quote.expiresAtMs,
        network,
        label: typeof label === 'string' ? label : undefined,
      });

      const sep0007Uri = sessionToSep0007Uri(session, { originDomain });
      const qr = await renderQr(sep0007Uri);

      res.status(201).json({
        orderId: session.orderId.toString(),
        status: session.status,
        quote: {
          cryptoAmount: quote.cryptoAmount,
          assetCode: quote.assetCode,
          pricePerUnit: quote.pricePerUnit,
          fiatAmount: quote.fiatAmount,
          expiresAt: quote.expiresAt,
          source: quote.source,
        },
        payment: {
          destination: merchantAddress,
          sep0007Uri,
          qrDataUrl: qr.dataUrl,
          qrSvg: qr.svg,
        },
      });
    } catch (err) {
      console.error('[checkout] POST /checkout error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ─── GET /api/checkout/:orderId ────────────────────────────────────────────

  router.get('/checkout/:orderId', async (req: Request, res: Response) => {
    try {
      const orderIdBig = parseOrderId(req.params.orderId);
      if (orderIdBig === null) {
        res.status(400).json({ error: 'Invalid orderId' });
        return;
      }

      const session = await sessionManager.getSession(orderIdBig);
      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      res.json({
        orderId: session.orderId.toString(),
        status: session.status,
        label: session.label,
        expiresAt: new Date(session.expiresAt).toISOString(),
        asset: session.asset,
        amount: session.amount,
      });
    } catch (err) {
      console.error('[checkout] GET /checkout/:orderId error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ─── POST /api/checkout/:orderId/tx ───────────────────────────────────────

  /**
   * Build an unsigned Stellar payment transaction for in-browser wallet signing.
   *
   * Body: { customerAddress: string }
   *
   * Returns: { txXdr, networkPassphrase }
   *
   * The widget passes txXdr to StellarWalletsKit.signTransaction(), then submits
   * the signed XDR back via POST /api/checkout/:orderId/submit.
   *
   * This endpoint NEVER receives a private key. It only builds and returns an
   * unsigned transaction envelope — the non-custodial invariant is preserved.
   */
  router.post('/checkout/:orderId/tx', async (req: Request, res: Response) => {
    try {
      const orderIdBig = parseOrderId(req.params.orderId);
      if (orderIdBig === null) {
        res.status(400).json({ error: 'Invalid orderId' });
        return;
      }

      const { customerAddress } = req.body as { customerAddress?: unknown };
      if (typeof customerAddress !== 'string' || !customerAddress.startsWith('G')) {
        res.status(400).json({ error: 'customerAddress must be a valid Stellar public key (G...)' });
        return;
      }

      const session = await sessionManager.getSession(orderIdBig);
      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      if (session.status !== 'pending') {
        res.status(409).json({ error: `Session is ${session.status}, not pending` });
        return;
      }
      if (Date.now() > session.expiresAt) {
        res.status(410).json({ error: 'Session quote has expired' });
        return;
      }

      const result = await buildPaymentTx(session, customerAddress, network);

      res.json(result);
    } catch (err) {
      // Horizon account not found is a common user error — give a clearer message
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('Not Found') || message.includes('404')) {
        res.status(400).json({ error: 'Customer Stellar account not found or not funded' });
        return;
      }
      console.error('[checkout] POST /checkout/:orderId/tx error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ─── POST /api/checkout/:orderId/submit ───────────────────────────────────

  /**
   * Validate and submit a signed transaction XDR to Horizon.
   *
   * Body: { signedTxXdr: string }
   *
   * Before forwarding to Horizon the endpoint VALIDATES that the parsed
   * transaction's operations actually match the checkout session:
   *   - Exactly one payment operation
   *   - Destination matches session.destination
   *   - Asset matches session.asset (code + issuer)
   *   - Amount matches session.amount (exact string comparison after normalisation)
   *   - MEMO_ID matches session.orderId
   *
   * Rejection here is a hard 400 — the XDR is discarded, nothing is submitted
   * to the network. This prevents an attacker who crafts a request directly to
   * this endpoint from getting an unrelated transaction forwarded on their behalf.
   *
   * Note: the non-custodial invariant is still intact — the server never signs
   * anything. We only validate that the customer signed what we asked them to sign.
   */
  router.post('/checkout/:orderId/submit', async (req: Request, res: Response) => {
    try {
      const orderIdBig = parseOrderId(req.params.orderId);
      if (orderIdBig === null) {
        res.status(400).json({ error: 'Invalid orderId' });
        return;
      }

      const { signedTxXdr } = req.body as { signedTxXdr?: unknown };
      if (typeof signedTxXdr !== 'string' || !signedTxXdr) {
        res.status(400).json({ error: 'signedTxXdr is required' });
        return;
      }

      const session = await sessionManager.getSession(orderIdBig);
      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      if (session.status !== 'pending') {
        res.status(409).json({ error: `Session is ${session.status}, not pending` });
        return;
      }
      if (Date.now() > session.expiresAt) {
        res.status(410).json({ error: 'Session quote has expired' });
        return;
      }

      // ── Deserialise ────────────────────────────────────────────────────────
      let tx: ReturnType<typeof TransactionBuilder.fromXDR>;
      try {
        tx = TransactionBuilder.fromXDR(signedTxXdr, NETWORK_PASSPHRASES[network]);
      } catch {
        res.status(400).json({ error: 'Invalid transaction XDR' });
        return;
      }

      // FeeBump transactions cannot be StellarFlow payment txs
      if (!('memo' in tx)) {
        res.status(400).json({ error: 'FeeBump transactions are not accepted' });
        return;
      }

      // ── Validate memo ──────────────────────────────────────────────────────
      const memo = tx.memo;
      const expectedMemoId = session.orderId.toString();
      if (
        !(memo instanceof Memo) ||
        memo.type !== 'id' ||
        memo.value !== expectedMemoId
      ) {
        res.status(400).json({
          error: `Transaction memo mismatch: expected MEMO_ID ${expectedMemoId}, got type=${memo?.type} value=${memo?.value}`,
        });
        return;
      }

      // ── Validate operations ────────────────────────────────────────────────
      const ops = tx.operations;
      if (ops.length !== 1) {
        res.status(400).json({
          error: `Transaction must have exactly 1 operation, got ${ops.length}`,
        });
        return;
      }

      const op = ops[0];
      if (op.type !== 'payment') {
        res.status(400).json({
          error: `Expected payment operation, got ${op.type}`,
        });
        return;
      }

      const paymentOp = op as Operation.Payment;

      // Validate destination
      if (paymentOp.destination !== session.destination) {
        res.status(400).json({
          error: `Transaction destination mismatch: expected ${session.destination}`,
        });
        return;
      }

      // Validate asset
      const expectedAsset =
        session.asset.code === 'XLM'
          ? StellarAsset.native()
          : new StellarAsset(session.asset.code, session.asset.issuer);

      if (!paymentOp.asset.equals(expectedAsset)) {
        res.status(400).json({
          error: `Transaction asset mismatch: expected ${expectedAsset.getCode()}`,
        });
        return;
      }

      // Validate amount — normalise to 7dp for comparison
      const normalise = (s: string) => parseFloat(s).toFixed(7);
      if (normalise(paymentOp.amount) !== normalise(session.amount)) {
        res.status(400).json({
          error: `Transaction amount mismatch: expected ${session.amount}, got ${paymentOp.amount}`,
        });
        return;
      }

      // ── All checks passed — submit ─────────────────────────────────────────
      // Mark as 'submitting' BEFORE calling Horizon. This is the double-submit
      // guard: a second concurrent call to this endpoint will now see status
      // 'submitting' (not 'pending') and be rejected with 409 before it reaches
      // the XDR validation or Horizon. The window between the status check above
      // and this write is the only remaining race — acceptable in Node's
      // single-threaded event loop since no await separates them.
      await sessionManager.updateStatus(orderIdBig, 'submitting');

      let submitResult: Awaited<ReturnType<typeof horizonServer.submitTransaction>>;
      try {
        submitResult = await horizonServer.submitTransaction(tx);
      } catch (horizonErr) {
        // Submission failed — roll back to pending so the customer can retry.
        await sessionManager.updateStatus(orderIdBig, 'pending');
        throw horizonErr;
      }

      res.json({
        hash: submitResult.hash ?? '',
        ledger: (submitResult as { ledger?: number }).ledger ?? null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('transaction') || message.includes('horizon')) {
        res.status(400).json({ error: `Transaction submission failed: ${message}` });
        return;
      }
      console.error('[checkout] POST /checkout/:orderId/submit error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ─── GET /api/sessions ────────────────────────────────────────────────────

  router.get('/sessions', async (_req: Request, res: Response) => {
    try {
      const sessions = await sessionManager.listSessions();
      res.json({
        sessions: sessions.map((s) => ({
          orderId: s.orderId.toString(),
          label: s.label,
          status: s.status,
          asset: s.asset,
          amount: s.amount,
          expiresAt: new Date(s.expiresAt).toISOString(),
          network: s.network,
        })),
      });
    } catch (err) {
      console.error('[checkout] GET /sessions error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ─── GET /api/network ─────────────────────────────────────────────────────

  /**
   * Returns network info the widget needs to initialise the kit.
   * Keeps the widget config-free — it just knows the API URL.
   */
  router.get('/network', (_req: Request, res: Response) => {
    res.json({
      network,
      networkPassphrase: NETWORK_PASSPHRASES[network],
      horizonUrl: HORIZON_URLS[network],
    });
  });

  return router;
}
