/**
 * tx-builder.ts
 *
 * Builds unsigned Stellar payment transactions for in-browser wallet signing.
 *
 * Flow:
 *   1. Widget calls POST /api/checkout/:orderId/tx with { customerAddress }
 *   2. Server fetches the customer's account from Horizon to get sequence number
 *   3. Server builds a payment transaction with:
 *        - source: customerAddress
 *        - destination: merchant address
 *        - amount: session.amount
 *        - asset: session.asset
 *        - memo: MEMO_ID = session.orderId
 *        - fee: loaded from Horizon fee stats (falls back to 100 stroops)
 *        - timebounds: session expiry (so the tx can't be submitted after quote expires)
 *   4. Returns { txXdr, networkPassphrase } — unsigned, ready to hand to the kit
 *
 * Security notes:
 *   - The server NEVER sees or stores the customer's private key.
 *   - The transaction has a timebounds upper bound matching the session expiry,
 *     so a signed-but-not-submitted tx cannot be replayed after quote expiry.
 *   - The server does not sign anything. It only assembles the transaction envelope.
 *   - The kit calls signTransaction(xdr, ...) and returns signedTxXdr which the
 *     widget submits to Horizon directly.
 */

import {
  TransactionBuilder,
  Networks,
  Asset as StellarAsset,
  Operation,
  Memo,
  Horizon as StellarHorizon,
} from 'stellar-sdk';
import type { CheckoutSession, StellarNetwork } from '@stellarflow/core';
import { HORIZON_URLS, NETWORK_PASSPHRASES } from '@stellarflow/core';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BuildTxResult {
  txXdr: string;
  networkPassphrase: string;
}

export interface TxBuilderOptions {
  /** Override the base fee in stroops. Default: fetched from Horizon fee stats. */
  baseFeeStroops?: number;
}

// ─── Asset conversion ─────────────────────────────────────────────────────────

function toStellarAsset(session: CheckoutSession): StellarAsset {
  if (session.asset.code === 'XLM') {
    return StellarAsset.native();
  }
  return new StellarAsset(session.asset.code, session.asset.issuer);
}

// ─── Fee fetcher ──────────────────────────────────────────────────────────────

const DEFAULT_FEE_STROOPS = 100; // 0.00001 XLM — Stellar's minimum base fee
const FEE_MULTIPLIER = 1.5; // pay 1.5× median to ensure inclusion

async function fetchRecommendedFee(
  server: StellarHorizon.Server,
  override?: number,
): Promise<number> {
  if (override !== undefined) return override;
  try {
    const stats = await server.feeStats();
    const medianFee = parseInt(stats.fee_charged.p50, 10);
    return Math.ceil(medianFee * FEE_MULTIPLIER);
  } catch {
    return DEFAULT_FEE_STROOPS;
  }
}

// ─── Transaction builder ──────────────────────────────────────────────────────

/**
 * Build an unsigned Stellar payment transaction for a checkout session.
 *
 * @param session         The open checkout session
 * @param customerAddress The customer's Stellar public key (G...)
 * @param network         'testnet' | 'mainnet'
 * @param opts            Optional overrides
 */
export async function buildPaymentTx(
  session: CheckoutSession,
  customerAddress: string,
  network: StellarNetwork,
  opts: TxBuilderOptions = {},
): Promise<BuildTxResult> {
  const horizonUrl = HORIZON_URLS[network];
  const networkPassphrase = NETWORK_PASSPHRASES[network];
  const server = new StellarHorizon.Server(horizonUrl);

  // Fetch customer account (needed for sequence number)
  const account = await server.loadAccount(customerAddress);

  // Fetch recommended fee
  const baseFee = await fetchRecommendedFee(server, opts.baseFeeStroops);

  // Timebounds: valid now until the session quote expires (UNIX seconds)
  const maxTime = Math.floor(session.expiresAt / 1000);

  // Build the transaction
  const tx = new TransactionBuilder(account, {
    fee: String(baseFee),
    networkPassphrase,
  })
    .addOperation(
      Operation.payment({
        destination: session.destination,
        asset: toStellarAsset(session),
        amount: session.amount,
      }),
    )
    .addMemo(Memo.id(session.orderId.toString()))
    .setTimeout(maxTime - Math.floor(Date.now() / 1000)) // seconds from now
    .build();

  return {
    txXdr: tx.toXDR(),
    networkPassphrase,
  };
}
