/**
 * sep0007.test.ts
 */

import { buildSep0007Uri, sessionToSep0007Uri } from '../sep0007';
import type { CheckoutSession } from '../types';

const MERCHANT = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const NOW = Date.now();

function makeSession(overrides: Partial<CheckoutSession> = {}): CheckoutSession {
  return {
    orderId: 42n,
    label: 'Order #42',
    asset: { code: 'XLM' },
    amount: '10.0000000',
    destination: MERCHANT,
    expiresAt: NOW + 300_000,
    status: 'pending',
    network: 'testnet',
    ...overrides,
  };
}

describe('buildSep0007Uri', () => {
  it('generates a valid web+stellar:pay URI', () => {
    const uri = buildSep0007Uri({
      destination: MERCHANT,
      amount: '10.0000000',
    });
    expect(uri).toMatch(/^web\+stellar:pay\?/);
    expect(uri).toContain(`destination=${MERCHANT}`);
    expect(uri).toContain('amount=10.0000000');
  });

  it('omits asset params for XLM (native)', () => {
    const uri = buildSep0007Uri({
      destination: MERCHANT,
      amount: '10.0000000',
    });
    expect(uri).not.toContain('asset_code');
    expect(uri).not.toContain('asset_issuer');
  });

  it('includes asset_code and asset_issuer for non-native assets', () => {
    const uri = buildSep0007Uri({
      destination: MERCHANT,
      amount: '25.0000000',
      assetCode: 'USDC',
      assetIssuer: USDC_ISSUER,
    });
    expect(uri).toContain('asset_code=USDC');
    expect(uri).toContain(`asset_issuer=${USDC_ISSUER}`);
  });

  it('includes memo and memo_type', () => {
    const uri = buildSep0007Uri({
      destination: MERCHANT,
      amount: '10.0000000',
      memo: '42',
      memoType: 'MEMO_ID',
    });
    expect(uri).toContain('memo=42');
    expect(uri).toContain('memo_type=MEMO_ID');
  });

  it('defaults memo_type to MEMO_ID when memo is provided', () => {
    const uri = buildSep0007Uri({
      destination: MERCHANT,
      amount: '10.0000000',
      memo: '42',
    });
    expect(uri).toContain('memo_type=MEMO_ID');
  });

  it('includes network_passphrase when provided', () => {
    const uri = buildSep0007Uri({
      destination: MERCHANT,
      amount: '10.0000000',
      networkPassphrase: 'Test SDF Network ; September 2015',
    });
    expect(uri).toContain('network_passphrase=');
    expect(decodeURIComponent(uri)).toContain('Test SDF Network ; September 2015');
  });

  it('includes msg when provided', () => {
    const uri = buildSep0007Uri({
      destination: MERCHANT,
      amount: '10.0000000',
      msg: 'StellarFlow order 42',
    });
    expect(decodeURIComponent(uri)).toContain('StellarFlow order 42');
  });
});

describe('sessionToSep0007Uri', () => {
  it('sets MEMO_ID from session.orderId', () => {
    const session = makeSession({ orderId: 999n });
    const uri = sessionToSep0007Uri(session);
    expect(uri).toContain('memo=999');
    expect(uri).toContain('memo_type=MEMO_ID');
  });

  it('sets testnet passphrase for testnet sessions', () => {
    const session = makeSession({ network: 'testnet' });
    const uri = sessionToSep0007Uri(session);
    expect(decodeURIComponent(uri)).toContain('Test SDF Network');
  });

  it('sets mainnet passphrase for mainnet sessions', () => {
    const session = makeSession({ network: 'mainnet' });
    const uri = sessionToSep0007Uri(session);
    expect(decodeURIComponent(uri)).toContain('Public Global Stellar Network');
  });

  it('includes USDC asset info for USDC sessions', () => {
    const session = makeSession({ asset: { code: 'USDC', issuer: USDC_ISSUER } });
    const uri = sessionToSep0007Uri(session);
    expect(uri).toContain('asset_code=USDC');
    expect(uri).toContain(`asset_issuer=${USDC_ISSUER}`);
  });

  it('does not include asset info for XLM sessions', () => {
    const session = makeSession({ asset: { code: 'XLM' } });
    const uri = sessionToSep0007Uri(session);
    expect(uri).not.toContain('asset_code=XLM');
    expect(uri).not.toContain('asset_issuer');
  });
});
