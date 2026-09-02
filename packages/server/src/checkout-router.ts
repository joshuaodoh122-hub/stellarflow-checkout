/**
 * checkout-router.ts
 *
 * Express router exposing the StellarFlow Checkout API.
 *
 * Endpoints:
 *   POST /api/checkout          Create a checkout session + get SEP-0007 URI + QR
 *   GET  /api/checkout/:orderId  Poll session status
 *   GET  /api/sessions           List all sessions (demo/merchant dashboard)
 *
 * Security notes:
 *   - All responses set Content-Type: application/json
 *   - orderId is parsed as BigInt to prevent integer overflow on 64-bit IDs
 *   - Input validation is explicit — no silent coercions
 */

import { Router, type Request, type Response } from 'express';
import {
  sessionToSep0007Uri,
  renderQr,
  QuoteService,
  type Asset,
  type StellarNetwork,
  USDC_ISSUERS,
} from '@stellarflow/core';
import type { SessionManager } from './session-manager';

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

  /**
   * POST /api/checkout
   * Body: { fiatAmount: number, assetCode: 'XLM' | 'USDC', label?: string }
   */
  router.post('/checkout', async (req: Request, res: Response) => {
    try {
      const { fiatAmount, assetCode, label } = req.body as {
        fiatAmount?: unknown;
        assetCode?: unknown;
        label?: unknown;
      };

      // Validate inputs
      if (typeof fiatAmount !== 'number' || fiatAmount <= 0) {
        res.status(400).json({ error: 'fiatAmount must be a positive number' });
        return;
      }

      if (assetCode !== 'XLM' && assetCode !== 'USDC') {
        res.status(400).json({ error: "assetCode must be 'XLM' or 'USDC'" });
        return;
      }

      // Get price quote
      const quote = await quoteService.quote(fiatAmount, assetCode);

      // Build asset descriptor
      const asset: Asset =
        assetCode === 'USDC'
          ? { code: 'USDC', issuer: USDC_ISSUERS[network] }
          : { code: 'XLM' };

      // Create session
      const session = await sessionManager.createSession({
        asset,
        amount: quote.cryptoAmount,
        destination: merchantAddress,
        expiresAt: quote.expiresAtMs,
        network,
        label: typeof label === 'string' ? label : undefined,
      });

      // Generate SEP-0007 URI and QR
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
      console.error('[checkout] POST /api/checkout error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * GET /api/checkout/:orderId
   * Returns the current status of a checkout session.
   */
  router.get('/checkout/:orderId', async (req: Request, res: Response) => {
    try {
      const { orderId } = req.params;
      let orderIdBig: bigint;
      try {
        orderIdBig = BigInt(orderId);
      } catch {
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
      console.error('[checkout] GET /api/checkout/:orderId error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * GET /api/sessions
   * List all sessions (for merchant dashboard / demo).
   */
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
      console.error('[checkout] GET /api/sessions error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
