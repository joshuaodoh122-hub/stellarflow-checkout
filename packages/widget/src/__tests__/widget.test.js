/**
 * widget.test.js
 *
 * Unit tests for the StellarFlow embeddable widget.
 * Runs in jsdom — no real network calls, no wallet kit.
 *
 * What is tested:
 *   - StellarFlow.init() discovers [data-stellarflow] containers
 *   - StellarFlow.init() ignores containers missing data-api-url
 *   - StellarFlow.init() supports a custom selector
 *   - StellarFlowWidget renders a checkout button into the container
 *   - StellarFlowWidget dispatches stellarflow:error on API failure
 *   - StellarFlowWidget skips rendering when apiUrl is missing
 */

import { init, StellarFlowWidget } from '../widget.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeContainer({ apiUrl = 'https://store.example.com', fiatAmount = '9.99', asset = 'XLM', label = 'Test Order' } = {}) {
  const el = document.createElement('div');
  el.setAttribute('data-stellarflow', '');
  if (apiUrl) el.setAttribute('data-api-url', apiUrl);
  el.setAttribute('data-fiat-amount', fiatAmount);
  el.setAttribute('data-asset', asset);
  el.setAttribute('data-label', label);
  document.body.appendChild(el);
  return el;
}

afterEach(() => {
  // Clean up DOM between tests
  document.body.innerHTML = '';
  // Clean up injected style tags
  document.head.innerHTML = '';
});

// ─── init() ──────────────────────────────────────────────────────────────────

describe('StellarFlow.init()', () => {
  it('finds all [data-stellarflow] containers and renders a button in each', () => {
    const c1 = makeContainer();
    const c2 = makeContainer({ label: 'Second Item' });

    init();

    expect(c1.querySelector('button')).not.toBeNull();
    expect(c2.querySelector('button')).not.toBeNull();
  });

  it('does not render into a container missing data-api-url', () => {
    const el = document.createElement('div');
    el.setAttribute('data-stellarflow', '');
    el.setAttribute('data-fiat-amount', '5');
    el.setAttribute('data-asset', 'XLM');
    // no data-api-url
    document.body.appendChild(el);

    init();

    // Should remain empty — no button injected
    expect(el.querySelector('button')).toBeNull();
  });

  it('respects a custom CSS selector', () => {
    const el = document.createElement('div');
    el.setAttribute('data-checkout', '');
    el.setAttribute('data-api-url', 'https://store.example.com');
    el.setAttribute('data-fiat-amount', '5');
    el.setAttribute('data-asset', 'XLM');
    el.setAttribute('data-label', 'Custom');
    document.body.appendChild(el);

    // Default selector should not pick it up
    init('[data-stellarflow]');
    expect(el.querySelector('button')).toBeNull();

    // Custom selector should
    init('[data-checkout]');
    expect(el.querySelector('button')).not.toBeNull();
  });

  it('renders into multiple independent containers without cross-contamination', () => {
    const c1 = makeContainer({ label: 'Item A' });
    const c2 = makeContainer({ label: 'Item B' });

    init();

    // Each container has its own button, not the other's
    const btns1 = c1.querySelectorAll('button');
    const btns2 = c2.querySelectorAll('button');
    expect(btns1.length).toBeGreaterThanOrEqual(1);
    expect(btns2.length).toBeGreaterThanOrEqual(1);
    // Containers don't share DOM
    expect(c1.contains(c2)).toBe(false);
  });
});

// ─── StellarFlowWidget ────────────────────────────────────────────────────────

describe('StellarFlowWidget.render()', () => {
  it('injects a Pay button into the container', () => {
    const el = makeContainer();
    const widget = new StellarFlowWidget(el, {
      apiUrl: 'https://store.example.com',
      fiatAmount: '9.99',
      asset: 'XLM',
      label: 'Test',
    });

    widget.render();

    const btn = el.querySelector('button');
    expect(btn).not.toBeNull();
    expect(btn.textContent).toMatch(/pay/i);
  });

  it('dispatches stellarflow:error when the checkout API call fails', async () => {
    const el = makeContainer();
    const widget = new StellarFlowWidget(el, {
      apiUrl: 'https://store.example.com',
      fiatAmount: '9.99',
      asset: 'XLM',
      label: 'Test',
    });
    widget.render();

    // Mock fetch to fail
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Internal server error' }),
    });

    const errorEvents = [];
    el.addEventListener('stellarflow:error', (e) => errorEvents.push(e.detail));

    // Trigger the checkout flow by clicking the Pay button
    const btn = el.querySelector('button');
    btn.click();

    // Wait for async fetch handling
    await new Promise((r) => setTimeout(r, 50));

    expect(errorEvents.length).toBeGreaterThanOrEqual(1);
    expect(errorEvents[0]).toHaveProperty('message');
  });
});
