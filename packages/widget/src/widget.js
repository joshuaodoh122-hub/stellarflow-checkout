/**
 * stellarflow-widget.js
 *
 * Vanilla JS embeddable checkout widget. No framework dependency.
 * Renders a "Pay with Stellar Wallet" button that opens the payment modal.
 *
 * Usage:
 *   <script src="stellarflow-widget.js" integrity="sha384-..." crossorigin="anonymous"></script>
 *   <div
 *     data-stellarflow
 *     data-api-url="https://yourstore.com"
 *     data-fiat-amount="9.99"
 *     data-asset="XLM"
 *     data-label="Digital Download #42"
 *   ></div>
 *   <script>StellarFlow.init();</script>
 *
 * Events dispatched on the container element:
 *   stellarflow:paid   — { detail: { orderId, txHash } }
 *   stellarflow:error  — { detail: { message } }
 *   stellarflow:review — { detail: { orderId, reason } }
 *
 * Security note for merchants:
 *   This script runs inside your checkout page. Always serve it with:
 *     1. Subresource Integrity (SRI) — integrity="sha384-..." attribute above.
 *     2. A Content Security Policy that allows only your own origin + the
 *        StellarFlow CDN domain. See ARCHITECTURE.md for the recommended CSP.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.StellarFlow = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ─── CSS ────────────────────────────────────────────────────────────────────

  const STYLES = `
    .sf-btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 12px 24px;
      background: #1a1a2e;
      color: #fff;
      border: none;
      border-radius: 8px;
      font-size: 15px;
      font-weight: 600;
      font-family: system-ui, -apple-system, sans-serif;
      cursor: pointer;
      transition: background 0.2s;
    }
    .sf-btn:hover { background: #16213e; }
    .sf-btn:disabled { opacity: 0.6; cursor: not-allowed; }
    .sf-btn svg { flex-shrink: 0; }

    .sf-modal-backdrop {
      position: fixed; inset: 0;
      background: rgba(0,0,0,0.6);
      display: flex; align-items: center; justify-content: center;
      z-index: 9999;
      font-family: system-ui, -apple-system, sans-serif;
    }
    .sf-modal {
      background: #fff;
      border-radius: 16px;
      padding: 32px;
      max-width: 420px;
      width: 90vw;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      position: relative;
    }
    .sf-modal-close {
      position: absolute; top: 16px; right: 16px;
      background: none; border: none; cursor: pointer;
      font-size: 20px; color: #666;
      width: 32px; height: 32px;
      display: flex; align-items: center; justify-content: center;
      border-radius: 50%;
      transition: background 0.2s;
    }
    .sf-modal-close:hover { background: #f0f0f0; }
    .sf-modal h2 {
      margin: 0 0 4px;
      font-size: 18px;
      color: #1a1a2e;
    }
    .sf-modal-subtitle {
      margin: 0 0 20px;
      font-size: 13px;
      color: #666;
    }
    .sf-amount-block {
      background: #f8f9fa;
      border-radius: 10px;
      padding: 16px;
      margin-bottom: 20px;
      text-align: center;
    }
    .sf-amount-crypto {
      font-size: 28px;
      font-weight: 700;
      color: #1a1a2e;
    }
    .sf-amount-fiat {
      font-size: 13px;
      color: #888;
      margin-top: 2px;
    }
    .sf-expires {
      font-size: 12px;
      color: #f0803c;
      text-align: center;
      margin-bottom: 16px;
    }
    .sf-qr-wrap {
      text-align: center;
      margin-bottom: 20px;
    }
    .sf-qr-wrap img {
      width: 200px;
      height: 200px;
      border: 4px solid #f0f0f0;
      border-radius: 8px;
    }
    .sf-qr-label {
      font-size: 12px;
      color: #888;
      margin-top: 8px;
    }
    .sf-deeplink {
      display: block;
      text-align: center;
      padding: 12px;
      background: #1a1a2e;
      color: #fff;
      text-decoration: none;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 12px;
      transition: background 0.2s;
    }
    .sf-deeplink:hover { background: #16213e; }
    .sf-status {
      text-align: center;
      font-size: 14px;
      padding: 12px;
      border-radius: 8px;
    }
    .sf-status.pending { background: #fff8e1; color: #856404; }
    .sf-status.paid { background: #d1fae5; color: #065f46; font-weight: 700; font-size: 16px; }
    .sf-status.review_required,
    .sf-status.underpayment,
    .sf-status.wrong_asset { background: #fee2e2; color: #991b1b; }
    .sf-status.expired { background: #f3f4f6; color: #6b7280; }
    .sf-loader {
      text-align: center;
      padding: 40px;
      color: #888;
      font-size: 14px;
    }
    .sf-error {
      text-align: center;
      padding: 20px;
      color: #991b1b;
      background: #fee2e2;
      border-radius: 8px;
      font-size: 14px;
    }
    @keyframes sf-spin { to { transform: rotate(360deg); } }
    .sf-spinner {
      display: inline-block;
      width: 20px; height: 20px;
      border: 3px solid #e5e7eb;
      border-top-color: #1a1a2e;
      border-radius: 50%;
      animation: sf-spin 0.8s linear infinite;
      vertical-align: middle;
      margin-right: 8px;
    }
  `;

  // ─── Icons ───────────────────────────────────────────────────────────────────

  const STELLAR_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="white" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.5 13.5l-9-5.5 1-1.5 9 5.5-1 1.5zm1-3l-9-5.5 1-1.5 9 5.5-1 1.5zm1-3l-9-5.5 1-1.5 9 5.5-1 1.5z"/>
  </svg>`;

  // ─── Utility ─────────────────────────────────────────────────────────────────

  function injectStyles() {
    if (document.getElementById('sf-styles')) return;
    const style = document.createElement('style');
    style.id = 'sf-styles';
    style.textContent = STYLES;
    document.head.appendChild(style);
  }

  function formatExpiry(isoString) {
    const secs = Math.floor((new Date(isoString).getTime() - Date.now()) / 1000);
    if (secs <= 0) return 'Quote expired';
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `Quote expires in ${m}:${String(s).padStart(2, '0')}`;
  }

  // ─── Widget class ────────────────────────────────────────────────────────────

  class StellarFlowWidget {
    constructor(container, config) {
      this.container = container;
      this.config = config;
      this.modal = null;
      this.pollInterval = null;
      this.expiryInterval = null;
      this.sessionData = null;
    }

    render() {
      const btn = document.createElement('button');
      btn.className = 'sf-btn';
      btn.innerHTML = `${STELLAR_ICON} Pay with Stellar Wallet`;
      btn.addEventListener('click', () => this.open());
      this.container.innerHTML = '';
      this.container.appendChild(btn);
      this.button = btn;
    }

    async open() {
      this.button.disabled = true;
      this.showModal('<div class="sf-loader"><span class="sf-spinner"></span>Preparing checkout…</div>');

      try {
        const resp = await fetch(`${this.config.apiUrl}/api/checkout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fiatAmount: parseFloat(this.config.fiatAmount),
            assetCode: this.config.asset || 'XLM',
            label: this.config.label || undefined,
          }),
        });

        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        this.sessionData = await resp.json();
        this.renderPaymentUI();
        this.startPolling();
        this.startExpiryCountdown();
      } catch (err) {
        this.showErrorModal(`Failed to create checkout session: ${err.message}`);
        this.button.disabled = false;
      }
    }

    showModal(innerHTML) {
      this.closeModal();
      const backdrop = document.createElement('div');
      backdrop.className = 'sf-modal-backdrop';
      backdrop.innerHTML = `
        <div class="sf-modal" role="dialog" aria-modal="true" aria-label="StellarFlow Checkout">
          <button class="sf-modal-close" aria-label="Close">&times;</button>
          <div class="sf-modal-content">${innerHTML}</div>
        </div>
      `;
      backdrop.querySelector('.sf-modal-close').addEventListener('click', () => {
        this.closeModal();
        this.button.disabled = false;
      });
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) {
          this.closeModal();
          this.button.disabled = false;
        }
      });
      document.body.appendChild(backdrop);
      this.modal = backdrop;
    }

    renderPaymentUI() {
      const { quote, payment, orderId } = this.sessionData;
      const content = `
        <h2>Pay with Stellar</h2>
        <p class="sf-modal-subtitle">Scan the QR code with your Stellar wallet or tap the button below.</p>
        <div class="sf-amount-block">
          <div class="sf-amount-crypto">${quote.cryptoAmount} ${quote.assetCode}</div>
          <div class="sf-amount-fiat">≈ $${quote.fiatAmount.toFixed(2)} USD · 1 ${quote.assetCode} = $${quote.pricePerUnit.toFixed(4)}</div>
        </div>
        <div class="sf-expires" id="sf-expiry-${orderId}">
          ${formatExpiry(quote.expiresAt)}
        </div>
        <div class="sf-qr-wrap">
          <img src="${payment.qrDataUrl}" alt="Stellar payment QR code" />
          <div class="sf-qr-label">Scan with Freighter, Lobstr, xBull, or any SEP-0007 wallet</div>
        </div>
        <a class="sf-deeplink" href="${payment.sep0007Uri}">
          Open in Stellar Wallet App
        </a>
        <div class="sf-status pending" id="sf-status-${orderId}">
          <span class="sf-spinner"></span>Waiting for payment…
        </div>
      `;
      this.modal.querySelector('.sf-modal-content').innerHTML = content;
    }

    startPolling() {
      const { orderId } = this.sessionData;
      const apiUrl = this.config.apiUrl;

      this.pollInterval = setInterval(async () => {
        try {
          const resp = await fetch(`${apiUrl}/api/checkout/${orderId}`);
          if (!resp.ok) return;
          const data = await resp.json();
          this.updateStatus(data.status, orderId, data);
        } catch { /* ignore network errors during polling */ }
      }, 3000);
    }

    updateStatus(status, orderId, data) {
      const statusEl = document.getElementById(`sf-status-${orderId}`);
      if (!statusEl) return;

      statusEl.className = `sf-status ${status}`;

      switch (status) {
        case 'paid':
          statusEl.innerHTML = '✅ Payment confirmed! Thank you.';
          this.stopPolling();
          this.stopExpiryCountdown();
          this.button.textContent = '✅ Paid';
          this.button.disabled = true;
          this.container.dispatchEvent(new CustomEvent('stellarflow:paid', {
            bubbles: true,
            detail: { orderId },
          }));
          setTimeout(() => this.closeModal(), 3000);
          break;
        case 'review_required':
        case 'underpayment':
        case 'wrong_asset':
          statusEl.innerHTML = '⚠️ Payment issue — merchant notified for review.';
          this.stopPolling();
          this.container.dispatchEvent(new CustomEvent('stellarflow:review', {
            bubbles: true,
            detail: { orderId, status },
          }));
          break;
        case 'expired':
          statusEl.innerHTML = '⏰ Quote expired. Please refresh to get a new price.';
          this.stopPolling();
          this.stopExpiryCountdown();
          break;
        default:
          statusEl.innerHTML = '<span class="sf-spinner"></span>Waiting for payment…';
      }
    }

    startExpiryCountdown() {
      const { orderId, quote } = this.sessionData;
      this.expiryInterval = setInterval(() => {
        const el = document.getElementById(`sf-expiry-${orderId}`);
        if (el) el.textContent = formatExpiry(quote.expiresAt);
      }, 1000);
    }

    stopPolling() {
      if (this.pollInterval) {
        clearInterval(this.pollInterval);
        this.pollInterval = null;
      }
    }

    stopExpiryCountdown() {
      if (this.expiryInterval) {
        clearInterval(this.expiryInterval);
        this.expiryInterval = null;
      }
    }

    showErrorModal(message) {
      this.showModal(`<div class="sf-error">❌ ${message}</div>`);
      this.container.dispatchEvent(new CustomEvent('stellarflow:error', {
        bubbles: true,
        detail: { message },
      }));
    }

    closeModal() {
      this.stopPolling();
      this.stopExpiryCountdown();
      if (this.modal) {
        this.modal.remove();
        this.modal = null;
      }
    }
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  function init(selector) {
    injectStyles();
    const containers = document.querySelectorAll(selector || '[data-stellarflow]');
    containers.forEach((el) => {
      const config = {
        apiUrl: el.dataset.apiUrl || '',
        fiatAmount: el.dataset.fiatAmount || '0',
        asset: el.dataset.asset || 'XLM',
        label: el.dataset.label || '',
      };
      if (!config.apiUrl) {
        console.error('[StellarFlow] data-api-url is required on', el);
        return;
      }
      const widget = new StellarFlowWidget(el, config);
      widget.render();
    });
  }

  return { init, StellarFlowWidget };
});
