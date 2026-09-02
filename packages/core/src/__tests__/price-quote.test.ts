/**
 * price-quote.test.ts
 */

import {
  QuoteService,
  CoinGeckoPriceSource,
  DEFAULT_QUOTE_TTL_MS,
} from '../price-quote';
import type { PriceSource } from '../price-quote';

// ─── Mock price source ─────────────────────────────────────────────────────────

class MockPriceSource implements PriceSource {
  readonly name = 'mock';
  private prices: Record<string, number>;
  public callCount = 0;

  constructor(prices: Record<string, number> = { XLM: 0.12, USDC: 1.0 }) {
    this.prices = prices;
  }

  async getUsdPrice(assetCode: 'XLM' | 'USDC'): Promise<number> {
    this.callCount++;
    const price = this.prices[assetCode];
    if (!price) throw new Error(`No mock price for ${assetCode}`);
    return price;
  }

  setPrice(assetCode: string, price: number): void {
    this.prices[assetCode] = price;
  }
}

// ─── QuoteService ─────────────────────────────────────────────────────────────

describe('QuoteService', () => {
  it('generates a valid XLM quote', async () => {
    const source = new MockPriceSource({ XLM: 0.10, USDC: 1.0 });
    const svc = new QuoteService(source);

    const quote = await svc.quote(10.0, 'XLM');

    expect(quote.fiatAmount).toBe(10.0);
    expect(quote.assetCode).toBe('XLM');
    expect(quote.pricePerUnit).toBe(0.10);
    // 10 USD / 0.10 per XLM = 100 XLM
    expect(quote.cryptoAmount).toBe('100.0000000');
    expect(quote.source).toBe('mock');
    expect(quote.fiatCurrency).toBe('USD');
  });

  it('generates a USDC quote at $1.00 exactly', async () => {
    const source = new MockPriceSource({ XLM: 0.12, USDC: 1.0 });
    const svc = new QuoteService(source);

    const quote = await svc.quote(25.50, 'USDC');

    expect(quote.pricePerUnit).toBe(1.0);
    expect(quote.cryptoAmount).toBe('25.5000000');
  });

  it('sets expiresAtMs to now + TTL', async () => {
    const source = new MockPriceSource();
    const svc = new QuoteService(source, { quoteTtlMs: 60_000 });
    const before = Date.now();
    const quote = await svc.quote(10, 'XLM');
    const after = Date.now();

    expect(quote.expiresAtMs).toBeGreaterThanOrEqual(before + 60_000);
    expect(quote.expiresAtMs).toBeLessThanOrEqual(after + 60_000);
  });

  it('uses default TTL of 3 minutes', async () => {
    const source = new MockPriceSource();
    const svc = new QuoteService(source);
    const quote = await svc.quote(10, 'XLM');

    const diff = quote.expiresAtMs - new Date(quote.createdAt).getTime();
    expect(diff).toBe(DEFAULT_QUOTE_TTL_MS);
    expect(DEFAULT_QUOTE_TTL_MS).toBe(3 * 60 * 1000);
  });

  it('caches price within TTL window', async () => {
    const source = new MockPriceSource();
    const svc = new QuoteService(source, { quoteTtlMs: 60_000 });

    await svc.quote(10, 'XLM');
    await svc.quote(20, 'XLM');
    await svc.quote(30, 'XLM');

    // Only one API call should have been made
    expect(source.callCount).toBe(1);
  });

  it('re-fetches price after cache expiry', async () => {
    const source = new MockPriceSource();
    // Very short TTL for testing
    const svc = new QuoteService(source, { quoteTtlMs: 1 });

    await svc.quote(10, 'XLM');
    // Wait for TTL to expire
    await new Promise((r) => setTimeout(r, 5));
    await svc.quote(20, 'XLM');

    expect(source.callCount).toBe(2);
  });

  it('throws for non-positive fiatAmount', async () => {
    const source = new MockPriceSource();
    const svc = new QuoteService(source);

    await expect(svc.quote(0, 'XLM')).rejects.toThrow('fiatAmount must be positive');
    await expect(svc.quote(-5, 'XLM')).rejects.toThrow('fiatAmount must be positive');
  });

  it('isValid() returns true for non-expired quote', async () => {
    const source = new MockPriceSource();
    const svc = new QuoteService(source, { quoteTtlMs: 60_000 });
    const quote = await svc.quote(10, 'XLM');

    expect(svc.isValid(quote, Date.now())).toBe(true);
  });

  it('isValid() returns false for expired quote', async () => {
    const source = new MockPriceSource();
    const svc = new QuoteService(source, { quoteTtlMs: 60_000 });
    const quote = await svc.quote(10, 'XLM');

    // Travel 61 seconds into the future
    expect(svc.isValid(quote, quote.expiresAtMs + 1)).toBe(false);
  });

  it('propagates price source errors', async () => {
    const source: PriceSource = {
      name: 'failing',
      getUsdPrice: async () => { throw new Error('network error'); },
    };
    const svc = new QuoteService(source);

    await expect(svc.quote(10, 'XLM')).rejects.toThrow('network error');
  });
});

// ─── CoinGeckoPriceSource — USDC special case ─────────────────────────────────

describe('CoinGeckoPriceSource', () => {
  it('returns 1.0 for USDC without making an API call', async () => {
    // We can test this without mocking fetch because USDC short-circuits
    const source = new CoinGeckoPriceSource();
    const price = await source.getUsdPrice('USDC');
    expect(price).toBe(1.0);
  });
});
