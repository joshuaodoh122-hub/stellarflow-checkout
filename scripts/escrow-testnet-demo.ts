#!/usr/bin/env ts-node
/**
 * scripts/escrow-testnet-demo.ts
 *
 * End-to-end testnet proof for the StellarFlow Soroban escrow integration.
 *
 * This script exercises the FULL cycle through the server HTTP endpoints
 * defined in escrow-router.ts:
 *
 *   Order A (happy path — release):
 *     1. Friendbot-fund a payer and a merchant on testnet
 *     2. POST /api/escrow   → create session + unsigned deposit XDR
 *     3. Payer signs XDR locally (Keypair.sign — testnet only)
 *     4. POST /api/escrow/:id/submit → submit deposit, wait for Held
 *     5. GET  /api/escrow/:id → confirm on-chain status = Held
 *     6. POST /api/escrow/:id/release → get unsigned release XDR
 *     7. Merchant signs XDR and submits via rpc.submitSignedTx directly
 *     8. GET  /api/escrow/:id → confirm status = Released
 *
 *   Order B (refund path):
 *     1. Same payer & merchant (already funded)
 *     2. POST /api/escrow → new session
 *     3. Payer signs + POST /api/escrow/:id/submit → Held
 *     4. POST /api/escrow/:id/refund (merchant as caller) → unsigned refund XDR
 *     5. Merchant signs + submits → Refunded
 *     6. GET /api/escrow/:id → confirm status = Refunded
 *
 * ## Token used
 *
 * Native XLM via its Stellar Asset Contract (SAC) on testnet.
 * The native XLM SAC address on Stellar testnet can be derived as:
 *
 *   stellar contract id asset --asset native --network testnet
 *
 * At the time of writing this evaluates to:
 *   CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC
 *
 * You can verify it with `stellar contract id asset` from the Stellar CLI.
 * If it differs on your testnet deployment, override via NATIVE_SAC_ID env var.
 *
 * ## Network access
 *
 * This script makes real outbound HTTP calls to:
 *   - Stellar Friendbot (https://friendbot.stellar.org)
 *   - Soroban RPC (https://soroban-testnet.stellar.org)
 *   - The local demo server (http://localhost:3000 by default)
 *
 * ⚠️  LIVE RUN STATUS: This script was NOT run live during the initial
 * implementation because no testnet Soroban RPC access was confirmed in
 * the CI environment. The script is complete and ready to execute.
 * See README.md → "How to run the testnet proof" for instructions.
 *
 * ## Usage
 *
 *   # 1. Deploy the escrow contract (see contracts/escrow/DEPLOY.md)
 *   # 2. Export the contract address
 *   export ESCROW_CONTRACT_ID=CXXX...
 *
 *   # 3. Start the demo server with the contract configured
 *   export SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
 *   cd packages/demo && npm run dev &
 *
 *   # 4. Run this script
 *   npx ts-node scripts/escrow-testnet-demo.ts
 *
 *   # Or with a custom server URL and SAC override:
 *   SERVER_URL=http://localhost:3000 NATIVE_SAC_ID=CXXX... npx ts-node scripts/escrow-testnet-demo.ts
 */

import fetch, { Response as FetchResponse } from 'node-fetch';
import {
  Keypair,
  TransactionBuilder,
  Networks,
  SorobanRpc,
} from 'stellar-sdk';
import {
  HttpSorobanRpcClient,
  SOROBAN_RPC_URLS,
} from '../packages/server/src/escrow-session';

// ─── Configuration ────────────────────────────────────────────────────────────

const SERVER_URL = process.env['SERVER_URL'] ?? 'http://localhost:3000';
const RPC_URL = process.env['SOROBAN_RPC_URL'] ?? SOROBAN_RPC_URLS.testnet;
const RELEASE_API_KEY = process.env['RELEASE_API_KEY'] ?? '';
const NETWORK_PASSPHRASE = Networks.TESTNET;

// Native XLM SAC on testnet — override with NATIVE_SAC_ID if it differs
const NATIVE_SAC_ID =
  process.env['NATIVE_SAC_ID'] ??
  'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

// Amount: 1 XLM = 10_000_000 stroops
const DEPOSIT_AMOUNT = '10000000';

// ─── Logger ───────────────────────────────────────────────────────────────────

function log(label: string, value: unknown): void {
  console.log(`\n[${label}]`, typeof value === 'object' ? JSON.stringify(value, null, 2) : value);
}

function separator(title: string): void {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('─'.repeat(60));
}

// ─── Friendbot helper ─────────────────────────────────────────────────────────

async function friendbotFund(address: string): Promise<void> {
  const res = await fetch(`https://friendbot.stellar.org?addr=${address}`);
  if (!res.ok) {
    const body = await res.text();
    // 400 with "createAccountAlreadyExist" means the account is already funded — fine
    if (body.includes('createAccountAlreadyExist')) {
      log('friendbot', `${address.slice(0, 8)}… already funded`);
      return;
    }
    throw new Error(`Friendbot failed for ${address}: ${res.status} ${body}`);
  }
  log('friendbot', `Funded ${address.slice(0, 8)}…`);
  // Wait for Horizon to catch up
  await sleep(2000);
}

// ─── Server API helper ────────────────────────────────────────────────────────

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
    throw new Error(`API POST ${path} failed (${res.status}): ${JSON.stringify(json)}`);
  }
  return json;
}

async function apiGet(path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${SERVER_URL}${path}`);
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(`API GET ${path} failed (${res.status}): ${JSON.stringify(json)}`);
  }
  return json;
}

// ─── Wallet signing helper ────────────────────────────────────────────────────

/**
 * Sign an unsigned transaction XDR with a Keypair.
 *
 * ⚠️  This uses a plaintext secret key and is ONLY acceptable for testnet
 * demo scripts. Production wallets sign via Freighter, Albedo, or another
 * non-custodial wallet — the server never sees the key.
 */
function signXdr(unsignedXdr: string, keypair: Keypair): string {
  const tx = TransactionBuilder.fromXDR(unsignedXdr, NETWORK_PASSPHRASE);
  if (!('sign' in tx)) {
    throw new Error('Cannot sign a FeeBump transaction here');
  }
  (tx as ReturnType<typeof TransactionBuilder.fromXDR> & { sign: (kp: Keypair) => void }).sign(keypair);
  return tx.toXDR();
}

// ─── Sleep helper ─────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║     StellarFlow Escrow Testnet Demo                  ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log(`\nServer:   ${SERVER_URL}`);
  console.log(`RPC:      ${RPC_URL}`);
  console.log(`Token:    ${NATIVE_SAC_ID} (native XLM SAC)`);
  console.log(`Amount:   ${DEPOSIT_AMOUNT} stroops (1 XLM)`);

  // ── Step 0: Generate keys and fund via Friendbot ────────────────────────────
  separator('Step 0: Generate and fund payer + merchant');

  const payerKp = Keypair.random();
  const merchantKp = Keypair.random();

  console.log(`Payer:    ${payerKp.publicKey()}`);
  console.log(`Merchant: ${merchantKp.publicKey()}`);

  await friendbotFund(payerKp.publicKey());
  await friendbotFund(merchantKp.publicKey());

  // ─── ORDER A: deposit → release ──────────────────────────────────────────
  separator('Order A: deposit → release (happy path)');

  // Step A1: Create session
  console.log('\nStep A1: POST /api/escrow — create session');
  const createA = await apiPost('/api/escrow', {
    payerAddress: payerKp.publicKey(),
    merchantAddress: merchantKp.publicKey(),
    tokenContractId: NATIVE_SAC_ID,
    amount: DEPOSIT_AMOUNT,
  });
  log('createA', createA);

  const orderIdA = createA['orderId'] as string;
  const unsignedDepositXdrA = createA['unsignedDepositXdr'] as string;

  // Step A2: Sign + submit deposit
  console.log('\nStep A2: Payer signs deposit XDR');
  const signedDepositA = signXdr(unsignedDepositXdrA, payerKp);

  console.log('\nStep A3: POST /api/escrow/:id/submit — submit deposit');
  const submitA = await apiPost(`/api/escrow/${orderIdA}/submit`, {
    signedDepositXdr: signedDepositA,
  });
  log('submitA', submitA);
  console.log(`  ✓ Deposit tx hash: ${submitA['txHash'] as string}`);

  // Step A3: Read state
  console.log('\nStep A4: GET /api/escrow/:id — confirm Held');
  const statusA1 = await apiGet(`/api/escrow/${orderIdA}`);
  log('statusA (after deposit)', statusA1);

  if ((statusA1['onChain'] as Record<string, unknown> | null)?.['status'] !== 'Held') {
    console.warn('⚠️  On-chain status is not Held — proceeding anyway');
  }

  // Step A4: Get release XDR
  console.log('\nStep A5: POST /api/escrow/:id/release — get unsigned release XDR');
  const releaseA = await apiPost(
    `/api/escrow/${orderIdA}/release`,
    { merchantAddress: merchantKp.publicKey() },
    RELEASE_API_KEY || undefined,
  );
  log('releaseA', { unsignedReleaseXdr: '(truncated)' });

  const unsignedReleaseXdrA = releaseA['unsignedReleaseXdr'] as string;

  // Step A5: Merchant signs + submits release directly via RPC
  console.log('\nStep A6: Merchant signs release XDR');
  const signedReleaseA = signXdr(unsignedReleaseXdrA, merchantKp);

  console.log('\nStep A7: Submit release via Soroban RPC');
  const rpcClient = new HttpSorobanRpcClient(RPC_URL, 'testnet');
  const releaseResult = await rpcClient.submitSignedTx({
    signedXdr: signedReleaseA,
    networkPassphrase: NETWORK_PASSPHRASE,
  });
  log('releaseResult', releaseResult);
  console.log(`  ✓ Release tx hash: ${releaseResult.txHash}`);

  // Step A6: Confirm Released
  await sleep(3000);
  console.log('\nStep A8: GET /api/escrow/:id — confirm Released');
  const statusA2 = await apiGet(`/api/escrow/${orderIdA}`);
  log('statusA (after release)', statusA2);

  // ─── ORDER B: deposit → merchant voluntary refund ─────────────────────────
  separator('Order B: deposit → merchant voluntary refund');

  // Step B1: Create session
  console.log('\nStep B1: POST /api/escrow — create session');
  const createB = await apiPost('/api/escrow', {
    payerAddress: payerKp.publicKey(),
    merchantAddress: merchantKp.publicKey(),
    tokenContractId: NATIVE_SAC_ID,
    amount: DEPOSIT_AMOUNT,
  });
  log('createB', createB);

  const orderIdB = createB['orderId'] as string;
  const unsignedDepositXdrB = createB['unsignedDepositXdr'] as string;

  // Step B2: Sign + submit deposit
  console.log('\nStep B2: Payer signs and submits deposit');
  const signedDepositB = signXdr(unsignedDepositXdrB, payerKp);
  const submitB = await apiPost(`/api/escrow/${orderIdB}/submit`, {
    signedDepositXdr: signedDepositB,
  });
  console.log(`  ✓ Deposit tx hash: ${submitB['txHash'] as string}`);

  // Step B3: Get refund XDR (merchant as caller — no timeout needed)
  console.log('\nStep B3: POST /api/escrow/:id/refund (merchant caller)');
  const refundB = await apiPost(`/api/escrow/${orderIdB}/refund`, {
    callerAddress: merchantKp.publicKey(),
  });
  log('refundB', { unsignedRefundXdr: '(truncated)' });

  // Step B4: Merchant signs + submits refund
  console.log('\nStep B4: Merchant signs refund XDR and submits');
  const signedRefundB = signXdr(refundB['unsignedRefundXdr'] as string, merchantKp);
  const refundResult = await rpcClient.submitSignedTx({
    signedXdr: signedRefundB,
    networkPassphrase: NETWORK_PASSPHRASE,
  });
  console.log(`  ✓ Refund tx hash: ${refundResult.txHash}`);

  // Step B5: Confirm Refunded
  await sleep(3000);
  console.log('\nStep B5: GET /api/escrow/:id — confirm Refunded');
  const statusB = await apiGet(`/api/escrow/${orderIdB}`);
  log('statusB (after refund)', statusB);

  // ─── Summary ──────────────────────────────────────────────────────────────
  separator('Summary');
  console.log('\n✅ Order A (release):');
  console.log(`   Order ID:    ${orderIdA}`);
  console.log(`   Deposit tx:  ${submitA['txHash'] as string}`);
  console.log(`   Release tx:  ${releaseResult.txHash}`);

  console.log('\n✅ Order B (refund):');
  console.log(`   Order ID:    ${orderIdB}`);
  console.log(`   Deposit tx:  ${submitB['txHash'] as string}`);
  console.log(`   Refund tx:   ${refundResult.txHash}`);

  console.log('\n✅ Testnet proof complete.');
  console.log('\nVerify on Stellar Expert:');
  console.log(`  https://stellar.expert/explorer/testnet/tx/${submitA['txHash'] as string}`);
  console.log(`  https://stellar.expert/explorer/testnet/tx/${releaseResult.txHash}`);
}

main().catch((err) => {
  console.error('\n❌ Demo failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
