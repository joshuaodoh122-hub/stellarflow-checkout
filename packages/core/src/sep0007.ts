/**
 * sep0007.ts
 *
 * SEP-0007 payment URI generation and QR code rendering.
 *
 * Spec: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0007.md
 *
 * This module generates standard web+stellar:pay?... URIs. Because the URI
 * follows the published Stellar standard, the widget is wallet-agnostic —
 * Freighter, Lobstr, Solar, xBull, and any other SEP-0007-compliant wallet
 * can parse and execute the payment without custom per-wallet integration.
 *
 * QR codes are rendered as data-URL PNGs (for embedding in <img> tags) or
 * as SVG strings. The deep link is also returned for use as an <a href>.
 */

import QRCode from 'qrcode';
import type { CheckoutSession, StellarNetwork } from './types';

// ─── URI builder ──────────────────────────────────────────────────────────────

export interface Sep0007PayParams {
  destination: string;
  amount: string;
  assetCode?: string;
  assetIssuer?: string;
  memo?: string;
  memoType?: 'MEMO_TEXT' | 'MEMO_ID' | 'MEMO_HASH' | 'MEMO_RETURN';
  msg?: string;
  /** If provided, Horizon will verify the payment was submitted here */
  originDomain?: string;
  /** For testnet: 'Test SDF Network ; September 2015' */
  networkPassphrase?: string;
}

/**
 * Build a SEP-0007 pay URI from the given parameters.
 *
 * Returns a string like:
 *   web+stellar:pay?destination=G...&amount=10.0000000&asset_code=USDC&asset_issuer=G...&memo=42&memo_type=MEMO_ID
 */
export function buildSep0007Uri(params: Sep0007PayParams): string {
  const qp = new URLSearchParams();
  qp.set('destination', params.destination);
  qp.set('amount', params.amount);

  if (params.assetCode && params.assetCode !== 'XLM') {
    qp.set('asset_code', params.assetCode);
    if (params.assetIssuer) {
      qp.set('asset_issuer', params.assetIssuer);
    }
  }

  if (params.memo !== undefined) {
    qp.set('memo', params.memo);
    qp.set('memo_type', params.memoType ?? 'MEMO_ID');
  }

  if (params.msg) {
    qp.set('msg', params.msg);
  }

  if (params.networkPassphrase) {
    qp.set('network_passphrase', params.networkPassphrase);
  }

  if (params.originDomain) {
    qp.set('origin_domain', params.originDomain);
  }

  // URLSearchParams uses + for spaces; SEP-0007 requires %20 for compatibility
  // with wallets that may not decode + as space in custom URI schemes.
  return `web+stellar:pay?${qp.toString().replace(/\+/g, '%20')}`;
}

/**
 * Build a SEP-0007 URI from a CheckoutSession.
 * Automatically sets MEMO_ID from session.orderId and sets the correct
 * network passphrase.
 */
export function sessionToSep0007Uri(
  session: CheckoutSession,
  opts: { msg?: string; originDomain?: string; network?: StellarNetwork } = {},
): string {
  const network = opts.network ?? session.network;
  const networkPassphrase =
    network === 'testnet'
      ? 'Test SDF Network ; September 2015'
      : 'Public Global Stellar Network ; September 2015';

  const params: Sep0007PayParams = {
    destination: session.destination,
    amount: session.amount,
    memo: session.orderId.toString(),
    memoType: 'MEMO_ID',
    networkPassphrase,
    msg: opts.msg ?? `StellarFlow order ${session.orderId}`,
    originDomain: opts.originDomain,
  };

  if (session.asset.code !== 'XLM') {
    params.assetCode = session.asset.code;
    params.assetIssuer = session.asset.issuer;
  }

  return buildSep0007Uri(params);
}

// ─── QR rendering ─────────────────────────────────────────────────────────────

export interface QrRenderResult {
  /** data:image/png;base64,... — use as <img src="..."> */
  dataUrl: string;
  /** SVG string — use as <div dangerouslySetInnerHTML> or inline SVG */
  svg: string;
  /** The raw URI that was encoded */
  uri: string;
}

/**
 * Render a SEP-0007 URI as both a PNG data URL and an SVG string.
 */
export async function renderQr(uri: string): Promise<QrRenderResult> {
  const [dataUrl, svg] = await Promise.all([
    QRCode.toDataURL(uri, {
      errorCorrectionLevel: 'M',
      margin: 2,
      color: { dark: '#1a1a2e', light: '#ffffff' },
    }),
    QRCode.toString(uri, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 2,
    }),
  ]);

  return { dataUrl, svg, uri };
}

/**
 * Convenience: build URI from session and render QR in one call.
 */
export async function sessionToQr(
  session: CheckoutSession,
  opts: { msg?: string; originDomain?: string } = {},
): Promise<QrRenderResult> {
  const uri = sessionToSep0007Uri(session, opts);
  return renderQr(uri);
}
