/**
 * price-quote.ts
 *
 * Price quoting interface + CoinGecko v3 adapter.
 *
 * Design decisions:
 *
 *   Source: CoinGecko free API for v1. The PriceSource interface makes it
 *   trivially swappable for an on-chain oracle (e.g. Reflector on Soroban)
 *   without touching any caller code.
 *
 *   Expiry window: 3 minutes (180 seconds). Rationale:
 *     - XLM spot price can move 1–5% in minutes during volatile periods.
 *     - 3 min gives a user enough time to approve the wallet transaction.
 *     - The Stellar network confirms in ~5 s, so we're not waiting on-chain.
 *     - After expiry, a new quote is issued with the current price.
 *   Merchants can override DEFAULT_QUOTE_TTL_MS via config.
 *
 *   USDC stability: USDC is treated as $1.00 USD exactly. We do NOT call
 *   a price API for USDC — this avoids CoinGecko rate limits for the common
 *   case and is correct for a regulated stablecoin. If USDC depegs, the
 *   merchant can pause the widget manually.
 */

export const DEFAULT_QUOTE_TTL_MS = 3 * 60 * 1000; // 3 minutes

// ─── Interface ────────────────────────────────────────────────────────────────

/**
 * A price source provides the current USD price of a crypto asset.
 * Implement this interface to swap in a different oracle.
 */
export interface PriceSource {
  readonly name: string;
  /**
   * Return the current price of `assetCode` in USD.
   * Throws if the price cannot be fetched.
   */
  getUsdPrice(assetCode: 'XLM' | 'USDC'): Promise<number>;
}

// ─── Quote types ──────────────────────────────────────────────────────────────

export interface PriceQuote {
  /** ISO-8601 creation time */
  createdAt: string;
  /** ISO-8601 expiry time */
  expiresAt: string;
  /** Expiry as UNIX milliseconds (for numeric comparison) */
  expiresAtMs: number;
  /** The fiat amount the merchant wants to receive */
  fiatAmount: number;
  /** Fiat currency code (only USD supported in v1) */
  fiatCurrency: 'USD';
  /** The crypto asset the customer will send */
  assetCode: 'XLM' | 'USDC';
  /** USD price per unit of the asset at quote time */
  pricePerUnit: number;
  /** The exact crypto amount the customer must send (7dp string) */
  cryptoAmount: string;
  /** Name of the price source used */
  source: string;
}

// ─── CoinGecko adapter ────────────────────────────────────────────────────────

const COINGECKO_IDS: Record<'XLM' | 'USDC', string> = {
  XLM: 'stellar',
  USDC: 'usd-coin',
};

/**
 * CoinGecko free-tier price source.
 * Rate limit: 10–30 req/min. Quote results should be cached by QuoteService.
 */
export class CoinGeckoPriceSource implements PriceSource {
  readonly name = 'CoinGecko (free tier)';

  private readonly baseUrl: string;

  constructor(baseUrl = 'https://api.coingecko.com/api/v3') {
    this.baseUrl = baseUrl;
  }

  async getUsdPrice(assetCode: 'XLM' | 'USDC'): Promise<number> {
    // USDC is a regulated stablecoin — treat it as exactly $1.00.
    if (assetCode === 'USDC') return 1.0;

    const id = COINGECKO_IDS[assetCode];
    const url = `${this.baseUrl}/simple/price?ids=${id}&vs_currencies=usd`;

    // Use dynamic import to avoid bundling issues in environments that provide
    // a global fetch (Node 18+). Falls back to node-fetch.
    const fetchFn: typeof fetch =
      typeof globalThis.fetch === 'function'
        ? globalThis.fetch.bind(globalThis)
        : (await import('node-fetch')).default as unknown as typeof fetch;

    const res = await fetchFn(url, {
      headers: { Accept: 'application/json' },
    });

    if (!res.ok) {
      throw new Error(`CoinGecko HTTP ${res.status}: ${res.statusText}`);
    }

    const json = (await res.json()) as Record<string, { usd?: number }>;
    const price = json[id]?.usd;
    if (typeof price !== 'number' || price <= 0) {
      throw new Error(`CoinGecko returned unexpected payload for ${assetCode}: ${JSON.stringify(json)}`);
    }
    return price;
  }
}

// ─── Quote service ────────────────────────────────────────────────────────────

export interface QuoteServiceOptions {
  /** TTL for quotes in milliseconds. Default: DEFAULT_QUOTE_TTL_MS (3 min) */
  quoteTtlMs?: number;
}

/**
 * QuoteService wraps a PriceSource and generates PriceQuote objects.
 * It caches the last fetched price per asset for the TTL window to avoid
 * hammering the price API on every checkout page load.
 */
export class QuoteService {
  private readonly source: PriceSource;
  private readonly ttlMs: number;
  private readonly priceCache = new Map<string, { price: number; fetchedAt: number }>();

  constructor(source: PriceSource, opts: QuoteServiceOptions = {}) {
    this.source = source;
    this.ttlMs = opts.quoteTtlMs ?? DEFAULT_QUOTE_TTL_MS;
  }

  /**
   * Generate a price quote for the given fiat amount and asset.
   * @param fiatAmount   Amount in USD the merchant wants to receive.
   * @param assetCode    The crypto asset to price.
   */
  async quote(fiatAmount: number, assetCode: 'XLM' | 'USDC'): Promise<PriceQuote> {
    if (fiatAmount <= 0) throw new Error('fiatAmount must be positive');

    const pricePerUnit = await this.getCachedPrice(assetCode);
    const rawAmount = fiatAmount / pricePerUnit;
    // Stellar amounts have max 7 decimal places
    const cryptoAmount = rawAmount.toFixed(7);

    const now = Date.now();
    const expiresAtMs = now + this.ttlMs;

    return {
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      expiresAtMs,
      fiatAmount,
      fiatCurrency: 'USD',
      assetCode,
      pricePerUnit,
      cryptoAmount,
      source: this.source.name,
    };
  }

  /**
   * Check if a quote is still valid at the given time.
   */
  isValid(quote: PriceQuote, nowMs = Date.now()): boolean {
    return nowMs < quote.expiresAtMs;
  }

  private async getCachedPrice(assetCode: 'XLM' | 'USDC'): Promise<number> {
    const cached = this.priceCache.get(assetCode);
    const now = Date.now();
    if (cached && now - cached.fetchedAt < this.ttlMs) {
      return cached.price;
    }
    const price = await this.source.getUsdPrice(assetCode);
    this.priceCache.set(assetCode, { price, fetchedAt: now });
    return price;
  }
}
