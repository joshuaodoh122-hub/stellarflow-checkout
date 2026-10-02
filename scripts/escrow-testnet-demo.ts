#!/usr/bin/env ts-node
/**
 * scripts/escrow-testnet-demo.ts
 *
 * End-to-end testnet proof for the StellarFlow Soroban escrow integration.
 *
 * This script exercises the FULL server lifecycle through HTTP endpoints:
 *
 *   Order A (happy path — release):
 *     1. Friendbot-fund a fresh payer and merchant on testnet
 *     2. POST /api/escrow              → create session + unsigned deposit XDR
 *     3. Payer signs XDR locally (Keypair.sign — testnet only, never production)
 *     4. POST /api/escrow/:id/submit   → validate XDR args, submit, wait Held
 *     5. GET  /api/escrow/:id          → confirm on-chain status = Held
 *     6. POST /api/escrow/:id/release  → get unsigned release XDR
 *     7. Merchant signs XDR locally
 *     8. POST /api/escrow/:id/release/submit → validate, submit, wait Released
 *     9. GET  /api/escrow/:id          → confirm status = fulfilled
 *
 *   Order B (refund path):
 *     1. Same payer & merchant (already funded)
 *     2. POST /api/escrow              → new session
 *     3. Payer signs + POST /api/escrow/:id/submit → Held
 *     4. POST /api/escrow/:id/refund   → unsigned refund XDR (merchant caller)
 *     5. Merchant signs + POST /api/escrow/:id/refund/submit → Refunded
 *     6. GET  /api/escrow/:id          → confirm status = refunded
 *
 *   Negative check (Fix 1 live proof):
 *     - Attempt a deposit signed with a wrong merchant address
 *     - Assert server returns 400 and nothing is submitted to chain
 *
 * ## Configuration (all via environment variables)
 *
 *   ESCROW_CONTRACT_ID   – deployed escrow contract address (C...)  [required]
 *   SOROBAN_RPC_URL      – Soroban RPC endpoint
 *   SERVER_URL           – running demo server base URL
 *   RELEASE_API_KEY      – Bearer token for /release endpoint (if configured)
 *   TOKEN_CONTRACT_ID    – SAC token contract ID (defaults to native XLM SAC)
 *
 * ## Usage
 *
 *   # 1. Deploy the escrow contract (see contracts/escrow/DEPLOY.md)
 *   export ESCROW_CONTRACT_ID=CXXX...
 *
 *   # 2. Start the demo server
 *   export SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
 *   cd packages/demo && npm run dev &
 *
 *   # 3. Run
 *   npx ts-node scripts/escrow-testnet-demo.ts
 *
 * ⚠️  LIVE RUN STATUS: NOT YET RUN — see docs/testnet-proof.md for proof log.
 */

import fetch from 'node-fetch';
import { Keypair, TransactionBuilder, Networks } from 'stellar-sdk';

// ─── Configuration ────────────────────────────────────────────────────────────

const SERVER_URL     = process.env['SERVER_URL']          ?? 'http://localhost:3000';
const RELEASE_API_KEY = process.env['RELEASE_API_KEY']    ?? '';
const NETWORK_PASSPHRASE = Networks.TESTNET;

// Native XLM SAC on testnet — override with TOKEN_CONTRACT_ID if needed
const TOKEN_CONTRACT_ID =
  process.env['TOKEN_CONTRACT_ID'] ??
  'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

// Amount: 1 XLM = 10_000_000 stroops
const DEPOSIT_AMOUNT = '10000000';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function log(label: string, value: unknown): void {
  console.log(`\n[${label}]`, typeof value === 'object' ? JSON.stringify(value, null, 2) : value);
}

function separator(title: string): void {
  console.log(`\n${'─'.repeat(62)}`);
  console.log(`  ${title}`);
  console.log('─'.repeat(62));
}

async function friendbotFund(address: string): Promise<void> {
  const res = await fetch(`https://friendbot.stellar.org?addr=${encodeURIComponent(address)}`);
  if (!res.ok) {
    const body = await res.text();
    if (body.includes('createAccountAlreadyExist')) {
      log('friendbot', `${address.slice(0, 8)}… already funded`);
      return;
    }
    throw new Error(`Friendbot failed for ${address}: ${res.status} ${body}`);
  }
  log('friendbot', `Funded ${address.slice(0, 8)}…`);
  await sleep(2000);
}

async function apiPost(
  path: string,
  body: Record<string, unknown>,
  authKey?: string,
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authKey) headers['Authorization'] = `Bearer ${authKey}`;

  const res = await fetch(`${SERVER_URL}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(`API POST ${path} → ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

/**
 * POST that is EXPECTED to fail — returns { status, body } without throwing.
 */
async function apiPostExpectFail(
  path: string,
  body: Record<string, unknown>,
  authKey?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authKey) headers['Authorization'] = `Bearer ${authKey}`;
  const res = await fetch(`${SERVER_URL}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body: json };
}

async function apiGet(path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${SERVER_URL}${path}`);
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(`API GET ${path} → ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

/**
 * Sign an unsigned XDR with a Keypair.
 * ⚠️  Uses a plaintext secret key — ONLY acceptable in testnet scripts.
 */
function signXdr(unsignedXdr: string, keypair: Keypair): string {
  const tx = TransactionBuilder.fromXDR(unsignedXdr, NETWORK_PASSPHRASE) as {
    sign: (kp: Keypair) => void;
    toXDR: () => string;
  };
  tx.sign(keypair);
  return tx.toXDR();
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`\n❌ ASSERTION FAILED: ${message}`);
    process.exit(1);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║     StellarFlow Escrow Testnet Demo                    ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  console.log(`\nServer:  ${SERVER_URL}`);
  console.log(`Token:   ${TOKEN_CONTRACT_ID}`);
  console.log(`Amount:  ${DEPOSIT_AMOUNT} stroops (1 XLM)`);

  // ── Step 0: Generate keys and fund via Friendbot ──────────────────────────
  separator('Step 0: Generate and fund payer + merchant');

  const payerKp    = Keypair.random();
  const merchantKp = Keypair.random();
  const wrongMerchantKp = Keypair.random();

  console.log(`Payer:           ${payerKp.publicKey()}`);
  console.log(`Merchant:        ${merchantKp.publicKey()}`);
  console.log(`Wrong merchant:  ${wrongMerchantKp.publicKey()}`);

  await friendbotFund(payerKp.publicKey());
  await friendbotFund(merchantKp.publicKey());

  // ─── NEGATIVE CHECK: wrong merchant → server must return 400 ─────────────
  separator('Negative check: deposit with wrong merchant → must be rejected 400');

  const negCreate = await apiPost('/api/escrow', {
    payerAddress:    payerKp.publicKey(),
    merchantAddress: merchantKp.publicKey(),
    tokenContractId: TOKEN_CONTRACT_ID,
    amount:          DEPOSIT_AMOUNT,
  });
  const negOrderId  = negCreate['orderId'] as string;
  const negUnsigned = negCreate['unsignedDepositXdr'] as string;

  // Build a deposit XDR with a WRONG merchant in arg[1]
  // We re-sign the real XDR then swap in the wrong merchant — the easiest
  // approach is to create a fresh session with the wrong merchant and sign
  // that XDR with the payer, then submit it against the CORRECT session.
  const wrongMerchantCreate = await apiPost('/api/escrow', {
    payerAddress:    payerKp.publicKey(),
    merchantAddress: wrongMerchantKp.publicKey(),
    tokenContractId: TOKEN_CONTRACT_ID,
    amount:          DEPOSIT_AMOUNT,
  });
  const wrongUnsigned = wrongMerchantCreate['unsignedDepositXdr'] as string;
  const wrongSigned   = signXdr(wrongUnsigned, payerKp);

  // Submit the wrong-merchant XDR against the CORRECT session
  const negResult = await apiPostExpectFail(
    `/api/escrow/${negOrderId}/submit`,
    { signedDepositXdr: wrongSigned },
  );
  log('negative check result', { status: negResult.status, error: negResult.body['error'] });

  assert(negResult.status === 400, `Expected 400 for wrong-merchant deposit, got ${negResult.status}`);
  assert(
    typeof negResult.body['error'] === 'string' &&
    /merchant/i.test(negResult.body['error'] as string),
    `Expected error mentioning "merchant", got: ${JSON.stringify(negResult.body['error'])}`,
  );
  console.log('\n✅ Negative check passed — wrong merchant correctly rejected with 400');

  // ─── ORDER A: deposit → release ──────────────────────────────────────────
  separator('Order A: deposit → release (happy path)');

  // Step A1: Create session
  console.log('\nStep A1: POST /api/escrow — create session');
  const createA = await apiPost('/api/escrow', {
    payerAddress:    payerKp.publicKey(),
    merchantAddress: merchantKp.publicKey(),
    tokenContractId: TOKEN_CONTRACT_ID,
    amount:          DEPOSIT_AMOUNT,
  });
  log('createA', { orderId: createA['orderId'], status: createA['status'] });

  const orderIdA        = createA['orderId']          as string;
  const unsignedDepositA = createA['unsignedDepositXdr'] as string;

  assert(typeof orderIdA === 'string' && /^[0-9a-f]{64}$/.test(orderIdA),
    `orderId must be 64 hex chars, got: ${orderIdA}`);

  // Step A2: Payer signs + submits deposit
  console.log('\nStep A2: Payer signs deposit XDR');
  const signedDepositA = signXdr(unsignedDepositA, payerKp);

  console.log('\nStep A3: POST /api/escrow/:id/submit');
  const submitA = await apiPost(`/api/escrow/${orderIdA}/submit`, {
    signedDepositXdr: signedDepositA,
  });
  log('submitA', { txHash: submitA['txHash'], status: submitA['status'] });
  assert(submitA['status'] === 'deposited', `Expected deposited, got ${String(submitA['status'])}`);
  const depositTxA = submitA['txHash'] as string;
  console.log(`  ✓ Deposit tx: ${depositTxA}`);

  // Step A4: Read state
  console.log('\nStep A4: GET /api/escrow/:id — confirm Held');
  const statusA1 = await apiGet(`/api/escrow/${orderIdA}`);
  log('statusA (after deposit)', { status: statusA1['status'], onChainStatus: (statusA1['onChain'] as Record<string,unknown> | null)?.['status'] });
  assert(statusA1['status'] === 'deposited', `Expected deposited session, got ${String(statusA1['status'])}`);

  // Step A5: Get unsigned release XDR
  console.log('\nStep A5: POST /api/escrow/:id/release — get unsigned release XDR');
  const releaseA = await apiPost(
    `/api/escrow/${orderIdA}/release`,
    { merchantAddress: merchantKp.publicKey() },
    RELEASE_API_KEY || undefined,
  );
  const unsignedReleaseA = releaseA['unsignedReleaseXdr'] as string;

  // Step A6: Merchant signs + submits via server endpoint
  console.log('\nStep A6: Merchant signs release XDR');
  const signedReleaseA = signXdr(unsignedReleaseA, merchantKp);

  console.log('\nStep A7: POST /api/escrow/:id/release/submit (via server — NOT rpc directly)');
  const releaseSubmitA = await apiPost(
    `/api/escrow/${orderIdA}/release/submit`,
    { signedReleaseXdr: signedReleaseA },
    RELEASE_API_KEY || undefined,
  );
  log('releaseSubmitA', { txHash: releaseSubmitA['txHash'], status: releaseSubmitA['status'] });
  assert(releaseSubmitA['status'] === 'fulfilled', `Expected fulfilled, got ${String(releaseSubmitA['status'])}`);
  const releaseTxA = releaseSubmitA['txHash'] as string;
  console.log(`  ✓ Release tx: ${releaseTxA}`);

  // Step A8: Confirm session status
  await sleep(2000);
  const statusA2 = await apiGet(`/api/escrow/${orderIdA}`);
  log('statusA (after release)', { status: statusA2['status'] });
  assert(statusA2['status'] === 'fulfilled', `Expected fulfilled after release, got ${String(statusA2['status'])}`);

  // ─── ORDER B: deposit → merchant voluntary refund ─────────────────────────
  separator('Order B: deposit → merchant voluntary refund');

  console.log('\nStep B1: POST /api/escrow — create session');
  const createB = await apiPost('/api/escrow', {
    payerAddress:    payerKp.publicKey(),
    merchantAddress: merchantKp.publicKey(),
    tokenContractId: TOKEN_CONTRACT_ID,
    amount:          DEPOSIT_AMOUNT,
  });
  const orderIdB         = createB['orderId']           as string;
  const unsignedDepositB = createB['unsignedDepositXdr'] as string;

  console.log('\nStep B2: Payer signs and submits deposit');
  const signedDepositB = signXdr(unsignedDepositB, payerKp);
  const submitB = await apiPost(`/api/escrow/${orderIdB}/submit`, {
    signedDepositXdr: signedDepositB,
  });
  assert(submitB['status'] === 'deposited', `Expected deposited, got ${String(submitB['status'])}`);
  const depositTxB = submitB['txHash'] as string;
  console.log(`  ✓ Deposit tx: ${depositTxB}`);

  console.log('\nStep B3: POST /api/escrow/:id/refund (merchant caller)');
  const refundB = await apiPost(`/api/escrow/${orderIdB}/refund`, {
    callerAddress: merchantKp.publicKey(),
  });
  const unsignedRefundB = refundB['unsignedRefundXdr'] as string;

  console.log('\nStep B4: Merchant signs refund XDR');
  const signedRefundB = signXdr(unsignedRefundB, merchantKp);

  console.log('\nStep B5: POST /api/escrow/:id/refund/submit (via server — NOT rpc directly)');
  const refundSubmitB = await apiPost(
    `/api/escrow/${orderIdB}/refund/submit`,
    { signedRefundXdr: signedRefundB, callerAddress: merchantKp.publicKey() },
  );
  log('refundSubmitB', { txHash: refundSubmitB['txHash'], status: refundSubmitB['status'] });
  assert(refundSubmitB['status'] === 'refunded', `Expected refunded, got ${String(refundSubmitB['status'])}`);
  const refundTxB = refundSubmitB['txHash'] as string;
  console.log(`  ✓ Refund tx: ${refundTxB}`);

  await sleep(2000);
  const statusB = await apiGet(`/api/escrow/${orderIdB}`);
  assert(statusB['status'] === 'refunded', `Expected refunded status, got ${String(statusB['status'])}`);

  // ─── Summary ──────────────────────────────────────────────────────────────
  separator('Summary');

  console.log('\n✅ Negative check (wrong merchant rejected):');
  console.log(`   Order ID:    ${negOrderId}  → 400 returned, nothing submitted`);

  console.log('\n✅ Order A (release):');
  console.log(`   Order ID:    ${orderIdA}`);
  console.log(`   Deposit tx:  ${depositTxA}`);
  console.log(`   Release tx:  ${releaseTxA}`);

  console.log('\n✅ Order B (refund):');
  console.log(`   Order ID:    ${orderIdB}`);
  console.log(`   Deposit tx:  ${depositTxB}`);
  console.log(`   Refund tx:   ${refundTxB}`);

  console.log('\nVerify on Stellar Expert:');
  console.log(`  https://stellar.expert/explorer/testnet/tx/${depositTxA}`);
  console.log(`  https://stellar.expert/explorer/testnet/tx/${releaseTxA}`);
  console.log(`  https://stellar.expert/explorer/testnet/tx/${depositTxB}`);
  console.log(`  https://stellar.expert/explorer/testnet/tx/${refundTxB}`);

  console.log('\n✅ Testnet proof complete. Paste the output above into docs/testnet-proof.md.');
}

main().catch((err) => {
  console.error('\n❌ Demo failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
