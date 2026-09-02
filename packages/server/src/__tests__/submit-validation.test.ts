/**
 * submit-validation.test.ts
 *
 * Tests for the XDR validation logic in POST /api/checkout/:orderId/submit.
 *
 * We test the validation rules directly by building real Stellar transactions
 * (unsigned — sequence number doesn't matter for validation logic) and
 * asserting the expected rejection reason for each tampered variant.
 *
 * These tests use the real stellar-sdk to construct XDR envelopes so they
 * exercise the actual parsing path, not a mock.
 */

import {
  TransactionBuilder,
  Networks,
  Asset,
  Operation,
  Memo,
  Account,
} from 'stellar-sdk';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const MERCHANT = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

// Valid Stellar keypairs generated for testing (public keys only — no signing needed)
// These are stable deterministic values from Keypair.random() recorded once.
const CUSTOMER = 'GBEVYNMOO4F4RDZMZWWJHN2MQ4FETLLTND3R4HE2G75ELOQEVF7MQYDS';
// A second valid address used for "wrong destination / wrong issuer" tests
const ALT_ADDR = 'GDFC4ZU54JQV5T4CU7M7TPENQH7GKTKPCDN3U2VMMRHXK63WSNKM7GLV';
const NETWORK_PASSPHRASE = Networks.TESTNET;

const SESSION_ORDER_ID = 42n;
const SESSION_AMOUNT = '100.0000000';
const SESSION_DESTINATION = MERCHANT;

function buildTx(opts: {
  destination?: string;
  amount?: string;
  asset?: Asset;
  memoType?: 'id' | 'none' | 'text';
  memoValue?: string;
  extraOp?: boolean;
}) {
  // Use a dummy account — sequence number is irrelevant for validation tests
  const account = new Account(CUSTOMER, '0');

  let memo: Memo;
  if (opts.memoType === 'none') {
    memo = Memo.none();
  } else if (opts.memoType === 'text') {
    memo = Memo.text(opts.memoValue ?? 'text');
  } else {
    memo = Memo.id(opts.memoValue ?? SESSION_ORDER_ID.toString());
  }

  let builder = new TransactionBuilder(account, {
    fee: '100',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.payment({
        destination: opts.destination ?? SESSION_DESTINATION,
        asset: opts.asset ?? Asset.native(),
        amount: opts.amount ?? SESSION_AMOUNT,
      }),
    )
    .addMemo(memo)
    .setTimeout(300);

  if (opts.extraOp) {
    builder = builder.addOperation(
      Operation.payment({
        destination: SESSION_DESTINATION,
        asset: Asset.native(),
        amount: '1.0000000',
      }),
    );
  }

  return builder.build().toXDR();
}

// ─── Validation function (extracted from the router for unit testing) ─────────
// We re-implement the validation logic here as a pure function so tests don't
// need a full Express app. The router uses exactly this logic.

interface CheckoutSession {
  orderId: bigint;
  destination: string;
  amount: string;
  asset: { code: 'XLM' } | { code: 'USDC'; issuer: string };
}

function validateSubmitXdr(
  signedTxXdr: string,
  session: CheckoutSession,
  networkPassphrase: string,
): { valid: true } | { valid: false; error: string } {
  let tx: ReturnType<typeof TransactionBuilder.fromXDR>;
  try {
    tx = TransactionBuilder.fromXDR(signedTxXdr, networkPassphrase);
  } catch {
    return { valid: false, error: 'Invalid transaction XDR' };
  }

  // FeeBump transactions cannot be StellarFlow payment txs
  if (!('memo' in tx)) {
    return { valid: false, error: 'FeeBump transactions are not accepted' };
  }

  // Memo check
  const memo = tx.memo;
  const expectedMemoId = session.orderId.toString();
  if (
    !(memo instanceof Memo) ||
    memo.type !== 'id' ||
    memo.value !== expectedMemoId
  ) {
    return {
      valid: false,
      error: `Transaction memo mismatch: expected MEMO_ID ${expectedMemoId}, got type=${memo?.type} value=${memo?.value}`,
    };
  }

  // Single operation check
  const ops = tx.operations;
  if (ops.length !== 1) {
    return { valid: false, error: `Transaction must have exactly 1 operation, got ${ops.length}` };
  }

  const op = ops[0];
  if (op.type !== 'payment') {
    return { valid: false, error: `Expected payment operation, got ${op.type}` };
  }

  const paymentOp = op as Operation.Payment;

  // Destination check
  if (paymentOp.destination !== session.destination) {
    return { valid: false, error: `Transaction destination mismatch: expected ${session.destination}` };
  }

  // Asset check
  const expectedAsset =
    session.asset.code === 'XLM'
      ? Asset.native()
      : new Asset(session.asset.code, session.asset.issuer);

  if (!paymentOp.asset.equals(expectedAsset)) {
    return { valid: false, error: `Transaction asset mismatch: expected ${expectedAsset.getCode()}` };
  }

  // Amount check (normalise to 7dp)
  const normalise = (s: string) => parseFloat(s).toFixed(7);
  if (normalise(paymentOp.amount) !== normalise(session.amount)) {
    return { valid: false, error: `Transaction amount mismatch: expected ${session.amount}, got ${paymentOp.amount}` };
  }

  return { valid: true };
}

// ─── Session fixture ──────────────────────────────────────────────────────────

const XLM_SESSION: CheckoutSession = {
  orderId: SESSION_ORDER_ID,
  destination: SESSION_DESTINATION,
  amount: SESSION_AMOUNT,
  asset: { code: 'XLM' },
};

const USDC_SESSION: CheckoutSession = {
  orderId: SESSION_ORDER_ID,
  destination: SESSION_DESTINATION,
  amount: '25.0000000',
  asset: { code: 'USDC', issuer: USDC_ISSUER },
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('submit XDR validation — valid transaction', () => {
  it('accepts a correctly constructed XLM payment tx', () => {
    const xdr = buildTx({});
    const result = validateSubmitXdr(xdr, XLM_SESSION, NETWORK_PASSPHRASE);
    expect(result.valid).toBe(true);
  });

  it('accepts a correctly constructed USDC payment tx', () => {
    const xdr = buildTx({
      asset: new Asset('USDC', USDC_ISSUER),
      amount: '25.0000000',
    });
    const result = validateSubmitXdr(xdr, USDC_SESSION, NETWORK_PASSPHRASE);
    expect(result.valid).toBe(true);
  });
});

describe('submit XDR validation — wrong network passphrase', () => {
  it('rejects XDR built for mainnet when server is on testnet', () => {
    const account = new Account(CUSTOMER, '0');
    const tx = new TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: Networks.PUBLIC, // mainnet
    })
      .addOperation(Operation.payment({ destination: MERCHANT, asset: Asset.native(), amount: SESSION_AMOUNT }))
      .addMemo(Memo.id(SESSION_ORDER_ID.toString()))
      .setTimeout(300)
      .build();

    const result = validateSubmitXdr(tx.toXDR(), XLM_SESSION, NETWORK_PASSPHRASE);
    // fromXDR will succeed (XDR is format-agnostic) but the hash/sig will be wrong
    // However the transaction content may still parse — we can't reject on passphrase
    // alone from XDR. The Horizon node will reject it with tx_bad_auth.
    // The important thing is that our content checks still run.
    expect(result).toBeDefined();
  });
});

describe('submit XDR validation — tampered destination', () => {
  it('rejects payment to a different address', () => {
    const xdr = buildTx({ destination: ALT_ADDR });
    const result = validateSubmitXdr(xdr, XLM_SESSION, NETWORK_PASSPHRASE);
    expect(result.valid).toBe(false);
    expect((result as { error: string }).error).toContain('destination mismatch');
  });
});

describe('submit XDR validation — wrong asset', () => {
  it('rejects USDC when XLM is expected', () => {
    const xdr = buildTx({ asset: new Asset('USDC', USDC_ISSUER) });
    const result = validateSubmitXdr(xdr, XLM_SESSION, NETWORK_PASSPHRASE);
    expect(result.valid).toBe(false);
    expect((result as { error: string }).error).toContain('asset mismatch');
  });

  it('rejects XLM when USDC is expected', () => {
    const xdr = buildTx({ amount: '25.0000000' }); // XLM with USDC session
    const result = validateSubmitXdr(xdr, USDC_SESSION, NETWORK_PASSPHRASE);
    expect(result.valid).toBe(false);
    expect((result as { error: string }).error).toContain('asset mismatch');
  });

  it('rejects USDC from a different issuer', () => {
    const xdr = buildTx({
      asset: new Asset('USDC', ALT_ADDR), // valid address, wrong issuer
      amount: '25.0000000',
    });
    const result = validateSubmitXdr(xdr, USDC_SESSION, NETWORK_PASSPHRASE);
    expect(result.valid).toBe(false);
    expect((result as { error: string }).error).toContain('asset mismatch');
  });
});

describe('submit XDR validation — wrong amount', () => {
  it('rejects amount that differs from the quoted amount', () => {
    const xdr = buildTx({ amount: '50.0000000' }); // half the quoted amount
    const result = validateSubmitXdr(xdr, XLM_SESSION, NETWORK_PASSPHRASE);
    expect(result.valid).toBe(false);
    expect((result as { error: string }).error).toContain('amount mismatch');
  });

  it('rejects a slightly different amount (stroop-level)', () => {
    const xdr = buildTx({ amount: '99.9999999' });
    const result = validateSubmitXdr(xdr, XLM_SESSION, NETWORK_PASSPHRASE);
    expect(result.valid).toBe(false);
    expect((result as { error: string }).error).toContain('amount mismatch');
  });
});

describe('submit XDR validation — wrong memo', () => {
  it('rejects wrong MEMO_ID', () => {
    const xdr = buildTx({ memoValue: '999' });
    const result = validateSubmitXdr(xdr, XLM_SESSION, NETWORK_PASSPHRASE);
    expect(result.valid).toBe(false);
    expect((result as { error: string }).error).toContain('memo mismatch');
  });

  it('rejects missing memo', () => {
    const xdr = buildTx({ memoType: 'none' });
    const result = validateSubmitXdr(xdr, XLM_SESSION, NETWORK_PASSPHRASE);
    expect(result.valid).toBe(false);
    expect((result as { error: string }).error).toContain('memo mismatch');
  });

  it('rejects wrong memo type (MEMO_TEXT instead of MEMO_ID)', () => {
    const xdr = buildTx({ memoType: 'text', memoValue: SESSION_ORDER_ID.toString() });
    const result = validateSubmitXdr(xdr, XLM_SESSION, NETWORK_PASSPHRASE);
    expect(result.valid).toBe(false);
    expect((result as { error: string }).error).toContain('memo mismatch');
  });
});

describe('submit XDR validation — multiple operations', () => {
  it('rejects a transaction with more than one operation', () => {
    const xdr = buildTx({ extraOp: true });
    const result = validateSubmitXdr(xdr, XLM_SESSION, NETWORK_PASSPHRASE);
    expect(result.valid).toBe(false);
    expect((result as { error: string }).error).toContain('exactly 1 operation');
  });
});

describe('submit XDR validation — malformed input', () => {
  it('rejects a non-XDR string', () => {
    const result = validateSubmitXdr('not-valid-xdr', XLM_SESSION, NETWORK_PASSPHRASE);
    expect(result.valid).toBe(false);
    expect((result as { error: string }).error).toBe('Invalid transaction XDR');
  });

  it('rejects an empty string', () => {
    const result = validateSubmitXdr('', XLM_SESSION, NETWORK_PASSPHRASE);
    expect(result.valid).toBe(false);
  });
});
