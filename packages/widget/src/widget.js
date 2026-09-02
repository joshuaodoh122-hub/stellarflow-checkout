/**
 * stellarflow-widget.js
 *
 * Vanilla JS embeddable checkout widget — no framework dependency.
 * Supports two payment paths:
 *
 *   PATH A — SEP-0007 deep link / QR code (wallet-agnostic, always available)
 *     • Generates a web+stellar:pay?... URI from the checkout session
 *     • Renders it as a QR code (for mobile wallets) and a clickable deep link
 *     • Works with any SEP-0007-compatible wallet without browser extension
 *
 *   PATH B — In-browser wallet connection via @creit.tech/stellar-wallets-kit
 *     • Customer clicks "Connect Wallet" → kit opens its wallet picker modal
 *     • Kit handles Freighter, Albedo, xBull, Rabet, Lobstr, Hana out of the box
 *     • Widget builds tx server-side (POST /api/checkout/:id/tx), passes XDR to kit
 *     • Kit prompts customer to review and sign in their wallet
 *     • Widget submits signed XDR (POST /api/checkout/:id/submit) to Horizon
 *     • Standard memo-match + dedup confirmation loop via polling
 *
 * Both paths converge on the same server-side confirmation — the Horizon listener
 * matches by MEMO_ID and fires the webhook regardless of which path was used.
 *
 * Usage:
 *   <script src="stellarflow-widget.js"
 *     integrity="sha384-..." crossorigin="anonymous"></script>
 *
 *   <div
 *     data-stellarflow
 *     data-api-url="https://yourstore.com"
 *     data-fiat-amount="9.99"
 *     data-asset="XLM"
 *     data-label="Your Product"
 *   ></div>
 *
 *   <script>StellarFlow.init();</script>
 *
 * Events dispatched (bubble up from the container):
 *   stellarflow:paid     — { detail: { orderId } }
 *   stellarflow:review   — { detail: { orderId, status } }
 *   stellarflow:error    — { detail: { message } }
 */

import { StellarWalletsKit } from '@creit.tech/stellar-wallets-kit/sdk';
import { defaultModules } from '@creit.tech/stellar-wallets-kit/modules/utils';
import { KitEventType, SwkAppDarkTheme } from '@creit.tech/stellar-wallets-kit/types';

// ─── Module state ─────────────────────────────────────────────────────────────

let kitInitialized = false;
let connectedAddress = null;
let connectedNetworkPassphrase = null;
let kitUnsubs = [];

// ─── Kit bootstrap ────────────────────────────────────────────────────────────

/**
 * Initialize the kit once — it is a singleton, shared across all widget
 * instances on the page. Must be called in a browser context.
 */
function ensureKitInit(networkPassphrase) {
  if (kitInitialized) return;
  kitInitialized = true;

  StellarWalletsKit.init({
    theme: SwkAppDarkTheme,
    modules: defaultModules(),
  });

  // Listen for wallet connect/disconnect events globally
  const unsubState = StellarWalletsKit.on(KitEventType.STATE_UPDATED, (event) => {
    connectedAddress = event.payload.address || null;
    connectedNetworkPassphrase = event.payload.networkPassphrase || null;
    // Notify all active widget instances
    document.dispatchEvent(new CustomEvent('stellarflow:kit-state', {
      detail: { address: connectedAddress, networkPassphrase: connectedNetworkPassphrase },
    }));
  });

  const unsubDisconnect = StellarWalletsKit.on(KitEventType.DISCONNECT, () => {
    connectedAddress = null;
    connectedNetworkPassphrase = null;
    document.dispatchEvent(new CustomEvent('stellarflow:kit-state', {
      detail: { address: null, networkPassphrase: null },
    }));
  });

  kitUnsubs.push(unsubState, unsubDisconnect);
}

// ─── CSS ──────────────────────────────────────────────────────────────────────

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
    max-width: 440px;
    width: 90vw;
    box-shadow: 0 20px 60px rgba(0,0,0,0.3);
    position: relative;
    max-height: 90vh;
    overflow-y: auto;
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
  .sf-modal h2 { margin: 0 0 4px; font-size: 18px; color: #1a1a2e; }
  .sf-modal-subtitle { margin: 0 0 20px; font-size: 13px; color: #666; }

  .sf-amount-block {
    background: #f8f9fa;
    border-radius: 10px;
    padding: 16px;
    margin-bottom: 16px;
    text-align: center;
  }
  .sf-amount-crypto { font-size: 28px; font-weight: 700; color: #1a1a2e; }
  .sf-amount-fiat { font-size: 13px; color: #888; margin-top: 2px; }

  .sf-expires { font-size: 12px; color: #f0803c; text-align: center; margin-bottom: 16px; }

  .sf-tabs {
    display: flex;
    border-bottom: 2px solid #e5e7eb;
    margin-bottom: 20px;
    gap: 0;
  }
  .sf-tab {
    flex: 1;
    padding: 10px;
    background: none;
    border: none;
    font-size: 13px;
    font-weight: 600;
    color: #888;
    cursor: pointer;
    border-bottom: 2px solid transparent;
    margin-bottom: -2px;
    transition: color 0.15s, border-color 0.15s;
    font-family: system-ui, -apple-system, sans-serif;
  }
  .sf-tab.active { color: #1a1a2e; border-bottom-color: #1a1a2e; }
  .sf-tab:hover { color: #1a1a2e; }

  .sf-tab-panel { display: none; }
  .sf-tab-panel.active { display: block; }

  .sf-qr-wrap { text-align: center; margin-bottom: 16px; }
  .sf-qr-wrap img {
    width: 180px; height: 180px;
    border: 4px solid #f0f0f0;
    border-radius: 8px;
  }
  .sf-qr-label { font-size: 12px; color: #888; margin-top: 8px; }

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

  .sf-wallet-section { margin-bottom: 16px; }
  .sf-wallet-intro { font-size: 13px; color: #555; margin-bottom: 14px; line-height: 1.5; }

  .sf-kit-btn-wrapper {
    margin-bottom: 14px;
  }
  .sf-kit-btn-wrapper stellar-wallets-button {
    display: block;
  }

  .sf-wallet-connected {
    display: flex;
    align-items: center;
    gap: 10px;
    background: #f0fdf4;
    border: 1px solid #bbf7d0;
    border-radius: 8px;
    padding: 10px 14px;
    margin-bottom: 14px;
    font-size: 13px;
  }
  .sf-wallet-addr {
    font-family: monospace;
    font-size: 12px;
    color: #166534;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sf-wallet-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: #22c55e;
    flex-shrink: 0;
  }

  .sf-pay-btn {
    width: 100%;
    padding: 14px;
    background: #1a1a2e;
    color: #fff;
    border: none;
    border-radius: 8px;
    font-size: 15px;
    font-weight: 700;
    cursor: pointer;
    font-family: system-ui, -apple-system, sans-serif;
    transition: background 0.2s;
    margin-bottom: 8px;
  }
  .sf-pay-btn:hover { background: #16213e; }
  .sf-pay-btn:disabled { opacity: 0.6; cursor: not-allowed; }

  .sf-pay-hint { font-size: 12px; color: #888; text-align: center; }

  .sf-status {
    text-align: center;
    font-size: 14px;
    padding: 12px;
    border-radius: 8px;
    margin-top: 12px;
  }
  .sf-status.pending { background: #fff8e1; color: #856404; }
  .sf-status.paid { background: #d1fae5; color: #065f46; font-weight: 700; font-size: 16px; }
  .sf-status.review_required,
  .sf-status.underpayment,
  .sf-status.wrong_asset { background: #fee2e2; color: #991b1b; }
  .sf-status.expired { background: #f3f4f6; color: #6b7280; }
  .sf-status.submitting { background: #eff6ff; color: #1e40af; }

  .sf-error { text-align: center; padding: 20px; color: #991b1b; background: #fee2e2; border-radius: 8px; font-size: 14px; }

  .sf-loader { text-align: center; padding: 40px; color: #888; font-size: 14px; }
  @keyframes sf-spin { to { transform: rotate(360deg); } }
  .sf-spinner {
    display: inline-block;
    width: 16px; height: 16px;
    border: 2px solid #e5e7eb;
    border-top-color: #1a1a2e;
    border-radius: 50%;
    animation: sf-spin 0.8s linear infinite;
    vertical-align: middle;
    margin-right: 6px;
  }
`;

// ─── Utilities ─────────────────────────────────────────────────────────────────

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

function addrShort(addr) {
  if (!addr || addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-6)}`;
}

async function apiFetch(url, method, body) {
  const opts = {
    method: method || 'GET',
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

// ─── Widget class ─────────────────────────────────────────────────────────────

class StellarFlowWidget {
  constructor(container, config) {
    this.container = container;
    this.config = config;
    this.modal = null;
    this.pollInterval = null;
    this.expiryInterval = null;
    this.sessionData = null;
    this.networkInfo = null;
    this.activeTab = 'wallet'; // 'wallet' | 'qr'
    this.kitStateListener = null;
  }

  render() {
    const btn = document.createElement('button');
    btn.className = 'sf-btn';
    btn.innerHTML = `${STELLAR_ICON} Pay with Stellar`;
    btn.addEventListener('click', () => this.open());
    this.container.innerHTML = '';
    this.container.appendChild(btn);
    this.button = btn;
  }

  async open() {
    this.button.disabled = true;
    this.showModal(`<div class="sf-loader"><span class="sf-spinner"></span>Preparing checkout…</div>`);

    try {
      // Fetch network info and create session in parallel
      const [networkInfo, sessionData] = await Promise.all([
        apiFetch(`${this.config.apiUrl}/api/network`),
        apiFetch(`${this.config.apiUrl}/api/checkout`, 'POST', {
          fiatAmount: parseFloat(this.config.fiatAmount),
          assetCode: this.config.asset || 'XLM',
          label: this.config.label || undefined,
        }),
      ]);

      this.networkInfo = networkInfo;
      this.sessionData = sessionData;

      // Bootstrap kit with the network passphrase from the server
      ensureKitInit(networkInfo.networkPassphrase);

      this.renderPaymentUI();
      this.startPolling();
      this.startExpiryCountdown();
      this.listenToKitState();
    } catch (err) {
      this.showErrorModal(`Failed to create checkout session: ${err.message}`);
      this.button.disabled = false;
    }
  }

  // ─── Kit state listener ──────────────────────────────────────────────────

  listenToKitState() {
    // Update the connected-wallet indicator whenever the kit state changes
    this.kitStateListener = (e) => {
      this.updateWalletIndicator(e.detail.address);
    };
    document.addEventListener('stellarflow:kit-state', this.kitStateListener);
    // Paint the current state immediately
    this.updateWalletIndicator(connectedAddress);
  }

  updateWalletIndicator(address) {
    if (!this.modal) return;
    const indicator = this.modal.querySelector('.sf-wallet-indicator');
    const payBtn = this.modal.querySelector('.sf-pay-btn');
    if (!indicator) return;

    if (address) {
      indicator.innerHTML = `
        <div class="sf-wallet-connected">
          <div class="sf-wallet-dot"></div>
          <span class="sf-wallet-addr">${addrShort(address)}</span>
        </div>
      `;
      if (payBtn) payBtn.disabled = false;
    } else {
      indicator.innerHTML = `<p class="sf-wallet-intro">Connect your Stellar wallet to pay directly in this page. Supports Freighter, Lobstr, xBull, Albedo, Hana and more.</p>`;
      if (payBtn) payBtn.disabled = true;
    }
  }

  // ─── UI ──────────────────────────────────────────────────────────────────

  renderPaymentUI() {
    const { quote, payment, orderId } = this.sessionData;

    const html = `
      <h2>Pay with Stellar</h2>
      <p class="sf-modal-subtitle">${this.sessionData.label || 'Complete your payment'}</p>

      <div class="sf-amount-block">
        <div class="sf-amount-crypto">${quote.cryptoAmount} ${quote.assetCode}</div>
        <div class="sf-amount-fiat">≈ $${quote.fiatAmount.toFixed(2)} USD · 1 ${quote.assetCode} = $${quote.pricePerUnit.toFixed(4)}</div>
      </div>

      <div class="sf-expires" id="sf-expiry-${orderId}">${formatExpiry(quote.expiresAt)}</div>

      <div class="sf-tabs">
        <button class="sf-tab active" data-tab="wallet">🔌 Connect Wallet</button>
        <button class="sf-tab" data-tab="qr">📱 QR / Deep Link</button>
      </div>

      <div class="sf-tab-panel active" id="sf-tab-wallet-${orderId}">
        <div class="sf-wallet-section">
          <div class="sf-wallet-indicator">
            <p class="sf-wallet-intro">Connect your Stellar wallet to pay directly in this page. Supports Freighter, Lobstr, xBull, Albedo, Hana and more.</p>
          </div>
          <div class="sf-kit-btn-wrapper" id="sf-kit-btn-${orderId}"></div>
          <button class="sf-pay-btn" id="sf-pay-btn-${orderId}" disabled>
            Pay ${quote.cryptoAmount} ${quote.assetCode}
          </button>
          <p class="sf-pay-hint">Your wallet will ask you to review and approve the transaction.</p>
        </div>
      </div>

      <div class="sf-tab-panel" id="sf-tab-qr-${orderId}">
        <div class="sf-qr-wrap">
          <img src="${payment.qrDataUrl}" alt="Stellar payment QR code" />
          <div class="sf-qr-label">Scan with any SEP-0007 wallet</div>
        </div>
        <a class="sf-deeplink" href="${payment.sep0007Uri}">Open in Stellar Wallet App</a>
      </div>

      <div class="sf-status pending" id="sf-status-${orderId}">
        <span class="sf-spinner"></span>Waiting for payment…
      </div>
    `;

    this.modal.querySelector('.sf-modal-content').innerHTML = html;

    // Insert the kit button into the designated slot
    const kitBtnSlot = document.getElementById(`sf-kit-btn-${orderId}`);
    if (kitBtnSlot) {
      StellarWalletsKit.createButton(kitBtnSlot);
    }

    // Wire tab switching
    this.modal.querySelectorAll('.sf-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        this.activeTab = tab.dataset.tab;
        this.modal.querySelectorAll('.sf-tab').forEach(t => t.classList.remove('active'));
        this.modal.querySelectorAll('.sf-tab-panel').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        const panel = this.modal.querySelector(`#sf-tab-${tab.dataset.tab}-${orderId}`);
        if (panel) panel.classList.add('active');
      });
    });

    // Wire the Pay button
    const payBtn = document.getElementById(`sf-pay-btn-${orderId}`);
    if (payBtn) {
      payBtn.addEventListener('click', () => this.handleInBrowserPay());
    }

    // Restore current kit state
    this.updateWalletIndicator(connectedAddress);
  }

  // ─── In-browser payment flow ─────────────────────────────────────────────

  async handleInBrowserPay() {
    if (!connectedAddress) return;

    const { orderId, quote } = this.sessionData;
    const payBtn = document.getElementById(`sf-pay-btn-${orderId}`);
    const statusEl = document.getElementById(`sf-status-${orderId}`);

    if (payBtn) payBtn.disabled = true;

    try {
      // 1. Build the unsigned transaction on the server
      this.setStatus(statusEl, 'submitting', `<span class="sf-spinner"></span>Building transaction…`);

      const { txXdr, networkPassphrase } = await apiFetch(
        `${this.config.apiUrl}/api/checkout/${orderId}/tx`,
        'POST',
        { customerAddress: connectedAddress },
      );

      // 2. Ask the customer to sign via the kit
      this.setStatus(statusEl, 'submitting', `<span class="sf-spinner"></span>Check your wallet to approve…`);

      const { signedTxXdr } = await StellarWalletsKit.signTransaction(txXdr, {
        networkPassphrase,
        address: connectedAddress,
      });

      // 3. Submit the signed transaction
      this.setStatus(statusEl, 'submitting', `<span class="sf-spinner"></span>Submitting to Stellar network…`);

      await apiFetch(
        `${this.config.apiUrl}/api/checkout/${orderId}/submit`,
        'POST',
        { signedTxXdr },
      );

      // 4. Polling will pick up the confirmation via the Horizon SSE listener
      this.setStatus(statusEl, 'pending', `<span class="sf-spinner"></span>Submitted — waiting for confirmation…`);

    } catch (err) {
      // User rejected signing — put the button back
      if (
        err.message.toLowerCase().includes('cancel') ||
        err.message.toLowerCase().includes('reject') ||
        err.message.toLowerCase().includes('denied') ||
        err.message.toLowerCase().includes('user')
      ) {
        this.setStatus(statusEl, 'pending', `<span class="sf-spinner"></span>Waiting for payment…`);
        if (payBtn) payBtn.disabled = false;
      } else {
        this.setStatus(statusEl, 'review_required', `❌ ${err.message}`);
        this.container.dispatchEvent(new CustomEvent('stellarflow:error', {
          bubbles: true,
          detail: { message: err.message },
        }));
      }
    }
  }

  setStatus(el, className, html) {
    if (!el) return;
    el.className = `sf-status ${className}`;
    el.innerHTML = html;
  }

  // ─── Polling ──────────────────────────────────────────────────────────────

  startPolling() {
    const { orderId } = this.sessionData;
    const apiUrl = this.config.apiUrl;
    this.pollInterval = setInterval(async () => {
      try {
        const data = await apiFetch(`${apiUrl}/api/checkout/${orderId}`);
        this.applyStatus(data.status, orderId);
      } catch { /* ignore transient errors */ }
    }, 3000);
  }

  applyStatus(status, orderId) {
    const statusEl = document.getElementById(`sf-status-${orderId}`);
    if (!statusEl) return;

    switch (status) {
      case 'paid':
        this.setStatus(statusEl, 'paid', '✅ Payment confirmed! Thank you.');
        this.stopPolling();
        this.stopExpiryCountdown();
        if (this.button) { this.button.textContent = '✅ Paid'; this.button.disabled = true; }
        this.container.dispatchEvent(new CustomEvent('stellarflow:paid', {
          bubbles: true, detail: { orderId },
        }));
        if (this.kitStateListener) {
          document.removeEventListener('stellarflow:kit-state', this.kitStateListener);
        }
        setTimeout(() => this.closeModal(), 3000);
        break;

      case 'review_required':
      case 'underpayment':
      case 'wrong_asset':
        this.setStatus(statusEl, 'review_required', '⚠️ Payment issue — merchant has been notified.');
        this.stopPolling();
        this.container.dispatchEvent(new CustomEvent('stellarflow:review', {
          bubbles: true, detail: { orderId, status },
        }));
        break;

      case 'expired':
        this.setStatus(statusEl, 'expired', '⏰ Quote expired. Please start over for a fresh price.');
        this.stopPolling();
        this.stopExpiryCountdown();
        break;

      default:
        // still pending — do nothing, spinner stays
        break;
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
    if (this.pollInterval) { clearInterval(this.pollInterval); this.pollInterval = null; }
  }

  stopExpiryCountdown() {
    if (this.expiryInterval) { clearInterval(this.expiryInterval); this.expiryInterval = null; }
  }

  // ─── Modal management ─────────────────────────────────────────────────────

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
      if (this.button) this.button.disabled = false;
    });
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) {
        this.closeModal();
        if (this.button) this.button.disabled = false;
      }
    });
    document.body.appendChild(backdrop);
    this.modal = backdrop;
  }

  showErrorModal(message) {
    this.showModal(`<div class="sf-error">❌ ${message}</div>`);
    this.container.dispatchEvent(new CustomEvent('stellarflow:error', {
      bubbles: true, detail: { message },
    }));
  }

  closeModal() {
    this.stopPolling();
    this.stopExpiryCountdown();
    if (this.kitStateListener) {
      document.removeEventListener('stellarflow:kit-state', this.kitStateListener);
      this.kitStateListener = null;
    }
    if (this.modal) { this.modal.remove(); this.modal = null; }
  }
}

// ─── Stellar logo icon ────────────────────────────────────────────────────────

const STELLAR_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
  <path d="M21.41 8.65l-.021.01L3.64 16.36l-.48-1.04 17.75-8.02c-.67-2.98-3.33-5.19-6.51-5.19-3.67 0-6.65 2.98-6.65 6.65 0 1.38.42 2.66 1.14 3.72L7.44 13.5C6.54 12.14 6 10.51 6 8.76 6 4.22 9.69.53 14.23.53c3.87 0 7.15 2.55 8.26 6.06l.01.03-1.09.03zM2.59 15.35l.02-.01 17.75-8.02.48 1.04L3.09 16.38c.67 2.98 3.33 5.19 6.51 5.19 3.67 0 6.65-2.98 6.65-6.65 0-1.38-.42-2.66-1.14-3.72l1.44-.02c.9 1.37 1.43 3 1.43 4.74 0 4.54-3.69 8.23-8.23 8.23-3.87 0-7.15-2.55-8.26-6.06l-.01-.03 1.09-.71z"/>
</svg>`;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Initialize all widgets on the page.
 * @param {string} [selector] CSS selector. Defaults to '[data-stellarflow]'.
 */
function init(selector) {
  injectStyles();
  const containers = document.querySelectorAll(selector || '[data-stellarflow]');
  containers.forEach((el) => {
    const config = {
      apiUrl: (el.dataset.apiUrl || '').replace(/\/$/, ''),
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

export { init, StellarFlowWidget };
