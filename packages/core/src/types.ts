/**
 * Shared types for StellarFlow Checkout core.
 *
 * Memo scheme decision: we use MEMO_ID (uint64) for order correlation.
 * Rationale: numeric order IDs are universal across storefront platforms,
 * MEMO_ID is natively indexed by Horizon, and the 64-bit range
 * (0–18,446,744,073,709,551,615) is far larger than any realistic order volume.
 * MEMO_HASH would give us 32 arbitrary bytes but would require custom serialisation
 * on both ends and is not rendered by most wallets in a human-readable way.
 * If a platform uses non-numeric IDs (e.g. UUIDs), the caller is responsible
 * for mapping them to a u64 before passing to this library.
 */

export type StellarNetwork = 'testnet' | 'mainnet';

export type Asset =
  | { code: 'XLM' }
  | { code: 'USDC'; issuer: string };

export type PaymentStatus =
  | 'pending'
  | 'paid'
  | 'expired'
  | 'underpayment'
  | 'wrong_asset'
  | 'review_required';

/**
 * A checkout session created by the merchant backend.
 */
export interface CheckoutSession {
  /** Unique session ID (used as the MEMO_ID on the Stellar payment) */
  orderId: bigint;
  /** Human-readable merchant label, e.g. "Order #42" */
  label: string;
  /** The asset the merchant wants to receive */
  asset: Asset;
  /** The exact crypto amount to send, derived from the quoted price */
  amount: string;
  /** Merchant's receiving Stellar address */
  destination: string;
  /** UNIX ms timestamp when this quote expires */
  expiresAt: number;
  /** Current payment status */
  status: PaymentStatus;
  /** The network to use — testnet by default */
  network: StellarNetwork;
}

/**
 * Canonical representation of an on-chain payment event,
 * after it has been parsed from a Horizon operations record.
 */
export interface PaymentEvent {
  /** Stellar transaction hash — used as the idempotency key */
  txHash: string;
  /** The Stellar address that sent the payment */
  from: string;
  /** The receiving Stellar address */
  to: string;
  /** Amount as a string (Stellar amounts are decimal strings) */
  amount: string;
  /** The asset that was actually sent */
  asset: Asset;
  /** The memo attached to the transaction */
  memo: { type: 'id'; value: bigint } | { type: 'hash'; value: string } | { type: 'none' };
  /** Ledger close time as UNIX seconds */
  createdAt: number;
}

/**
 * Result of matching an incoming PaymentEvent against an open CheckoutSession.
 */
export type MatchResult =
  | { matched: true; status: 'paid' }
  | { matched: false; status: PaymentStatus; reason: string };

/**
 * Horizon network passphrase strings (for reference / verification).
 */
export const NETWORK_PASSPHRASES: Record<StellarNetwork, string> = {
  testnet: 'Test SDF Network ; September 2015',
  mainnet: 'Public Global Stellar Network ; September 2015',
};

/**
 * Horizon base URLs.
 */
export const HORIZON_URLS: Record<StellarNetwork, string> = {
  testnet: 'https://horizon-testnet.stellar.org',
  mainnet: 'https://horizon.stellar.org',
};

/**
 * Well-known USDC issuers per network.
 */
export const USDC_ISSUERS: Record<StellarNetwork, string> = {
  testnet: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  mainnet: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
};
