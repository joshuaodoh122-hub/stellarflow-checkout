/**
 * server.ts — StellarFlow demo reference storefront
 *
 * Demonstrates the full checkout loop:
 *   1. Customer visits the demo shop page
 *   2. Customer clicks "Pay with Stellar Wallet"
 *   3. POST /api/checkout creates a session + SEP-0007 URI + QR code
 *   4. Widget renders the QR code and deep link
 *   5. Customer pays via their Stellar wallet
 *   6. Horizon listener detects the payment, memo-matches it
 *   7. Session is marked paid, webhook fires (logged to console in demo)
 *   8. Widget polls GET /api/checkout/:orderId and shows success
 *
 * Testnet by default. See .env.example to opt into mainnet.
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import {
  HorizonPaymentListener,
  CoinGeckoPriceSource,
  QuoteService,
  type StellarNetwork,
} from '@stellarflow/core';
import {
  InMemorySessionStore,
  SessionManager,
  PaymentProcessor,
  createCheckoutRouter,
} from '@stellarflow/server';

// ─── Config ───────────────────────────────────────────────────────────────────

const NETWORK = (process.env.STELLAR_NETWORK ?? 'testnet') as StellarNetwork;
const MERCHANT_ADDRESS =
  process.env.MERCHANT_ADDRESS ??
  'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const PORT = parseInt(process.env.PORT ?? '3000', 10);
const ORIGIN_DOMAIN = process.env.ORIGIN_DOMAIN ?? `localhost:${PORT}`;
const QUOTE_TTL_MS = parseInt(process.env.QUOTE_TTL_MS ?? '180000', 10);

if (NETWORK !== 'testnet' && NETWORK !== 'mainnet') {
  console.error('STELLAR_NETWORK must be "testnet" or "mainnet"');
  process.exit(1);
}

if (NETWORK === 'mainnet') {
  console.warn('⚠️  MAINNET MODE — real funds will be transferred!');
}

// ─── Dependency wiring ────────────────────────────────────────────────────────

const sessionStore = new InMemorySessionStore();
const sessionManager = new SessionManager(sessionStore);

// Webhook handler: in the demo we just log. Replace with HTTP POST to
// your storefront's order management endpoint in production.
sessionManager.onWebhook((event) => {
  console.log(`[webhook] ${event.type}:`, JSON.stringify(event, (_, v) =>
    typeof v === 'bigint' ? v.toString() : v
  ));
});

const priceSource = new CoinGeckoPriceSource();
const quoteService = new QuoteService(priceSource, { quoteTtlMs: QUOTE_TTL_MS });
const paymentProcessor = new PaymentProcessor(sessionManager);

// ─── Horizon listener ─────────────────────────────────────────────────────────

const listener = new HorizonPaymentListener(MERCHANT_ADDRESS, {
  network: NETWORK,
  cursor: 'now', // only process payments that arrive after server start
});

listener.start(
  async (event) => {
    console.log(`[horizon] payment event: tx=${event.txHash} amount=${event.amount} memo=${JSON.stringify(event.memo)}`);
    await paymentProcessor.process(event);
  },
  (err) => {
    console.error('[horizon] listener error:', err.message);
  },
);

console.log(`[horizon] Listening for payments to ${MERCHANT_ADDRESS} on ${NETWORK}`);

// ─── Express app ──────────────────────────────────────────────────────────────

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// API routes
const checkoutRouter = createCheckoutRouter({
  sessionManager,
  quoteService,
  merchantAddress: MERCHANT_ADDRESS,
  network: NETWORK,
  originDomain: ORIGIN_DOMAIN,
});

app.use('/api', checkoutRouter);

// Health check
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    network: NETWORK,
    merchant: MERCHANT_ADDRESS,
    quoteTtlMs: QUOTE_TTL_MS,
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────

const server = app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║        StellarFlow Checkout — Demo Server        ║
╠══════════════════════════════════════════════════╣
║  Network:  ${NETWORK.padEnd(38)}║
║  Merchant: ${MERCHANT_ADDRESS.slice(0, 38)}  ║
║  Port:     ${String(PORT).padEnd(38)}║
║  URL:      http://localhost:${PORT}${' '.repeat(Math.max(0, 21 - String(PORT).length))}║
╚══════════════════════════════════════════════════╝
  `.trim());
});

// Graceful shutdown
process.on('SIGTERM', () => {
  listener.stop();
  server.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  listener.stop();
  server.close(() => process.exit(0));
});

export { app };
