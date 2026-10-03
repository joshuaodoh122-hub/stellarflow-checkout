# Escrow Testnet Proof

This file records the live testnet run of the StellarFlow Soroban escrow integration.

**The results section below is NOT YET RUN.** Only real output from a live run
belongs here. No placeholder hashes, no invented contract IDs.

---

## Prerequisites

1. Rust toolchain with `wasm32v1-none` target:
   ```bash
   rustup target add wasm32v1-none
   ```

2. Stellar CLI:
   ```bash
   # https://developers.stellar.org/docs/tools/stellar-cli
   cargo install --locked stellar-cli
   ```

3. Node.js ≥ 18 and this repo's dependencies installed:
   ```bash
   npm install
   ```

---

## Commands to run

### Step 1 — Build and deploy the escrow contract

```bash
cd contracts/escrow
cargo build --target wasm32v1-none --release

# Deploy to testnet (replace <FUNDED_ACCOUNT> with a funded testnet keypair secret)
stellar contract deploy \
  --wasm target/wasm32v1-none/release/stellarflow_escrow.wasm \
  --network testnet \
  --source <FUNDED_ACCOUNT>
# Note the contract ID printed (starts with C...)
```

### Step 2 — Configure environment

```bash
export ESCROW_CONTRACT_ID=<contract-id-from-step-1>
export SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
export STELLAR_NETWORK=testnet
export TOKEN_CONTRACT_ID=CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC
# optional: export RELEASE_API_KEY=<your-release-key>
# optional: export SERVER_URL=http://localhost:3000
```

### Step 3 — Start the demo server

```bash
cd packages/demo
ESCROW_CONTRACT_ID=$ESCROW_CONTRACT_ID \
SOROBAN_RPC_URL=$SOROBAN_RPC_URL \
npm run dev &
```

Wait for the server to print `[server] Listening on port 3000`.

### Step 4 — Run the testnet proof script

```bash
cd ../..
npx ts-node scripts/escrow-testnet-demo.ts 2>&1 | tee testnet-proof-output.txt
```

### Step 5 — Verify on Stellar Expert

The script prints links like:
```
https://stellar.expert/explorer/testnet/tx/<deposit-hash>
https://stellar.expert/explorer/testnet/tx/<release-hash>
```

Open each link and confirm:
- The deposit tx shows a `deposit` invocation on the escrow contract
- The release tx shows a `release` invocation and funds moving to the merchant
- The refund tx (Order B) shows a `refund` invocation and funds back to the payer

---

## What the script proves

1. **Full server lifecycle**: every step goes through server HTTP endpoints — no direct
   RPC calls from the script for release or refund.

2. **Negative check (Fix 1 live proof)**: a deposit signed with a wrong merchant address
   returns HTTP 400 from the server and nothing is submitted to chain. This proves the
   13-argument XDR validation is enforced in production, not just in tests.

3. **Order A (release)**: deposit → server validates all args → funds held on-chain →
   merchant signs release → server validates + submits → funds transferred to merchant →
   session status `fulfilled`.

4. **Order B (refund)**: deposit → merchant voluntary refund → server validates + submits →
   funds returned to payer → session status `refunded`.

---

## Results

**NOT YET RUN — to be filled with real output only.**

No hashes, contract IDs, or keypairs are fabricated here. When a live run is
performed, paste the full terminal output of Step 4 into this section and commit
the result.

```
# paste real output here
```

Contract ID used: *(not yet run)*

Payer: *(not yet run)*

Merchant: *(not yet run)*

| Step | Description | Tx Hash | Stellar Expert link |
|------|-------------|---------|---------------------|
| A3 | Deposit tx | *(not yet run)* | *(not yet run)* |
| A7 | Release tx | *(not yet run)* | *(not yet run)* |
| B3 | Deposit tx | *(not yet run)* | *(not yet run)* |
| B5 | Refund tx  | *(not yet run)* | *(not yet run)* |
