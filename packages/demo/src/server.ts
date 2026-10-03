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
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import {
  HorizonPaymentListener,
  FileCursorStore,
  CoinGeckoPriceSource,
  QuoteService,
  type StellarNetwork,
} from '@stellarflow/core';
import {
  InMemorySessionStore,
  SessionManager,
  PaymentProcessor,
  createCheckoutRouter,
  createEscrowRouterFromEnv,
} from '@stellarflow/server';

// ─── Config ───────────────────────────────────────────────────────────────────

const NETWORK = (process.env.STELLAR_NETWORK ?? 'testnet') as StellarNetwork;
const MERCHANT_ADDRESS_RAW = process.env.MERCHANT_ADDRESS ?? '';
// Fail fast if the placeholder from .env.example was accidentally used.
const PLACEHOLDER_PREFIX = 'GXXXXXXXXXXXXXXXXXXXX';
if (!MERCHANT_ADDRESS_RAW || MERCHANT_ADDRESS_RAW.startsWith(PLACEHOLDER_PREFIX)) {
  console.error(
    'ERROR: MERCHANT_ADDRESS is not set or is still the placeholder from .env.example.\n' +
    '  Set a real funded Stellar address in packages/demo/.env before starting the server.',
  );
  process.exit(1);
}
const MERCHANT_ADDRESS = MERCHANT_ADDRESS_RAW;
const PORT = parseInt(process.env.PORT ?? '3000', 10);
const ORIGIN_DOMAIN = process.env.ORIGIN_DOMAIN ?? `localhost:${PORT}`;
const QUOTE_TTL_MS = parseInt(process.env.QUOTE_TTL_MS ?? '180000', 10);
// Optional: restrict GET /api/sessions to Bearer token auth.
// Leave unset in local dev to keep the endpoint open.
const SESSIONS_API_KEY = process.env.SESSIONS_API_KEY;
// Optional: restrict CORS to a specific origin (e.g. "https://yourstore.com").
// Defaults to same-origin (false) in production; set to "*" only for local dev.
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? false;

// File used to persist the Horizon cursor across restarts.
// Override via CURSOR_FILE env var; defaults to a file in the project root.
const CURSOR_FILE = process.env.CURSOR_FILE ?? path.resolve(__dirname, '../../horizon-cursor.txt');

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

// FileCursorStore persists the last-seen Horizon paging_token to disk.
// On restart the listener resumes from that cursor instead of 'now', so any
// payments that landed while the server was down are still processed.
const cursorStore = new FileCursorStore(CURSOR_FILE);

const listener = new HorizonPaymentListener(MERCHANT_ADDRESS, {
  network: NETWORK,
  cursor: 'now', // used only on the very first start (no saved cursor yet)
  cursorStore,
});

// start() is async — it reads the saved cursor before opening the stream.
// We await it inside an IIFE so the server doesn't open the SSE stream before
// the cursor has been loaded (avoids a brief gap on startup).
(async () => {
  await listener.start(
    async (event) => {
      console.log(`[horizon] payment event: tx=${event.txHash} amount=${event.amount} memo=${JSON.stringify(event.memo)}`);
      await paymentProcessor.process(event);
    },
    (err) => {
      console.error('[horizon] listener error:', err.message);
    },
  );

  console.log(`[horizon] Listening for payments to ${MERCHANT_ADDRESS} on ${NETWORK}`);
  console.log(`[horizon] Cursor file: ${CURSOR_FILE}`);
})();

// ─── Express app ──────────────────────────────────────────────────────────────

const app = express();

// Security headers — helmet with a CSP compatible with the demo's widget and API.
// Mirrors the recommended CSP in SECURITY.md.
const horizonUrl =
  NETWORK === 'mainnet' ? 'https://horizon.stellar.org' : 'https://horizon-testnet.stellar.org';
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        connectSrc: [
          "'self'",
          horizonUrl,
          'https://api.coingecko.com',
          // Stellar Wallets Kit — wallet connection endpoints used by the widget
          'https://albedo.link',
          'https://wallet.xbull.app',
          'https://lobstr.co',
          'https://stellarwalletskit.dev',
        ],
        imgSrc: ["'self'", 'data:', 'https:'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        frameAncestors: ["'none'"],
      },
    },
    // Helmet's default Cross-Origin-Opener-Policy is 'same-origin', which closes
    // the browsing context group and breaks popup-based wallet flows (e.g. Albedo,
    // xBull) that open a popup window and communicate back via window.opener.
    // 'same-origin-allow-popups' keeps the COOP protection against cross-origin
    // window attacks while still allowing same-site popup communication.
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
  }),
);

// CORS — restrict to configured origin (same-origin by default).
// Set CORS_ORIGIN=* in .env only for local cross-origin development.
app.use(cors({ origin: CORS_ORIGIN }));

// Rate limiting — 60 requests per minute per IP across all API routes.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});
app.use('/api', apiLimiter);

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// API routes — classic Horizon checkout
const checkoutRouter = createCheckoutRouter({
  sessionManager,
  quoteService,
  merchantAddress: MERCHANT_ADDRESS,
  network: NETWORK,
  originDomain: ORIGIN_DOMAIN,
  sessionsApiKey: SESSIONS_API_KEY,
});

app.use('/api', checkoutRouter);

// API routes — Soroban escrow checkout (requires ESCROW_CONTRACT_ID env var)
// If not configured, all /api/escrow routes return 503 with a clear message.
const escrowRouter = createEscrowRouterFromEnv(NETWORK, SESSIONS_API_KEY);
app.use('/api', escrowRouter);

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
