# Escrow Testnet Proof

This file records the live testnet run of the StellarFlow Soroban escrow integration.

**Run date:** 2026-11-23  
**Network:** Stellar testnet (`Test SDF Network ; September 2015`)  
**Soroban RPC:** `https://soroban-testnet.stellar.org`

---

## Contract

| Field | Value |
|-------|-------|
| Contract ID | `CAEWW3XEBPQB2QIOWFZS6A2FRJR4Y6E75BWJYUEQQITO7Q4BT5KPODNB` |
| Explorer | [lab.stellar.org](https://lab.stellar.org/r/testnet/contract/CAEWW3XEBPQB2QIOWFZS6A2FRJR4Y6E75BWJYUEQQITO7Q4BT5KPODNB) |
| WASM file | `target/wasm32v1-none/release/stellarflow_escrow.wasm` |
| WASM size | 13038 bytes |
| WASM SHA-256 hash | `a74369ff5b2f3ea1782edda28d0374113545639a255e51a2a3bdac38fc19ccc1` |
| Exported functions | `deposit`, `extend_escrow_ttl`, `get_escrow`, `refund`, `release` (5) |
| Built with | `stellar contract build` (stellar-cli 30.0.1) |
| Source commit | `487b672` (merge of PR #32; contract source unchanged since PR #30/#31) |

---

## Deploy transactions

| Step | Tx hash | Stellar Expert link |
|------|---------|---------------------|
| Upload WASM | `aac2ad1312f53f09c2a5acc83f1ff28dceab3e8c902efeb012c5e0c4201c15ea` | [view](https://stellar.expert/explorer/testnet/tx/aac2ad1312f53f09c2a5acc83f1ff28dceab3e8c902efeb012c5e0c4201c15ea) |
| Create contract | `8a615b1811720764bbb95d9d3f04a536e4a3a1b719ee314072f46d155acc6719` | [view](https://stellar.expert/explorer/testnet/tx/8a615b1811720764bbb95d9d3f04a536e4a3a1b719ee314072f46d155acc6719) |

---

## Prerequisites

1. Rust toolchain with `wasm32v1-none` target:
   ```bash
   rustup target add wasm32v1-none
   ```

2. Stellar CLI 30.0.1 (the version used for this run):
   ```bash
   # Download the pre-built binary
   curl -L https://github.com/stellar/stellar-cli/releases/download/v30.0.1/stellar-cli-30.0.1-x86_64-unknown-linux-gnu.tar.gz \
     -o stellar-cli.tar.gz
   tar xzf stellar-cli.tar.gz
   sudo mv stellar /usr/local/bin/stellar
   stellar --version  # stellar 30.0.1
   ```

3. Node.js ≥ 18 and this repo's dependencies:
   ```bash
   npm install
   ```

---

## Commands that were run

### Step 1 — Build the escrow contract

```bash
# From the repo root; stellar contract build handles the wasm32v1-none target automatically
stellar contract build
# Artifact: target/wasm32v1-none/release/stellarflow_escrow.wasm  (13038 bytes)
```

### Step 2 — Deploy to testnet

```bash
# Upload WASM
stellar contract upload \
  --wasm target/wasm32v1-none/release/stellarflow_escrow.wasm \
  --source <funded-deployer-identity> \
  --network testnet
# → aac2ad1312f53f09c2a5acc83f1ff28dceab3e8c902efeb012c5e0c4201c15ea

# Create contract instance
stellar contract deploy \
  --wasm-hash aac2ad1312f53f09c2a5acc83f1ff28dceab3e8c902efeb012c5e0c4201c15ea \
  --source <funded-deployer-identity> \
  --network testnet
# → CAEWW3XEBPQB2QIOWFZS6A2FRJR4Y6E75BWJYUEQQITO7Q4BT5KPODNB
```

### Step 3 — Configure environment

```bash
export ESCROW_CONTRACT_ID=CAEWW3XEBPQB2QIOWFZS6A2FRJR4Y6E75BWJYUEQQITO7Q4BT5KPODNB
export SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
export STELLAR_NETWORK=testnet
export TOKEN_CONTRACT_ID=CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC
```

### Step 4 — Start the demo server

```bash
# MERCHANT_ADDRESS must be a funded testnet account; friendbot funds are created
# dynamically by the demo script for payer/merchant accounts within the script itself.
# The demo server only needs to know the escrow contract and RPC endpoint:
cd packages/demo
ESCROW_CONTRACT_ID=$ESCROW_CONTRACT_ID \
SOROBAN_RPC_URL=$SOROBAN_RPC_URL \
STELLAR_NETWORK=testnet \
npm run dev &
# Wait for: [server] Listening on port 3000
```

### Step 5 — Run the testnet proof script

```bash
cd ../..
npx ts-node scripts/escrow-testnet-demo.ts 2>&1 | tee testnet-proof-output.txt
```

---

## Full terminal output

This is the unedited output from the successful run on 2026-11-23:

```
╔════════════════════════════════════════════════════════╗
║     StellarFlow Escrow Testnet Demo                    ║
╚════════════════════════════════════════════════════════╝

Server:  http://localhost:3000
Token:   CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC
Amount:  10000000 stroops (1 XLM)

──────────────────────────────────────────────────────────────
  Step 0: Generate and fund payer + merchant
──────────────────────────────────────────────────────────────
Payer:           GDFQLCZFZRXWUYWLYR6ZTMNT6VYWBMVJS2QLXEHRGFEOFCZV2NXH4UMK
Merchant:        GCJDDBPR62KZAPPULIC36O2ABS36PENZ2O5NMY66V6POOHW35VKPNFHK
Wrong merchant:  GBV4TKLRNFKCL33NP3DVATS3W5NGMN5LSWX4WXSCCNY4HHX6RUWXCAP6

[friendbot] Funded GDFQLCZF…

[friendbot] Funded GCJDDBPR…

──────────────────────────────────────────────────────────────
  Negative check: deposit with wrong merchant → must be rejected 400
──────────────────────────────────────────────────────────────

[negative check result] {
  "status": 400,
  "error": "arg[1] merchant mismatch: expected GCJDDBPR62KZAPPULIC36O2ABS36PENZ2O5NMY66V6POOHW35VKPNFHK, got GBV4TKLRNFKCL33NP3DVATS3W5NGMN5LSWX4WXSCCNY4HHX6RUWXCAP6"
}

✅ Negative check passed — wrong merchant correctly rejected with 400

──────────────────────────────────────────────────────────────
  Order A: deposit → release (happy path)
──────────────────────────────────────────────────────────────

Step A1: POST /api/escrow — create session

[createA] {
  "orderId": "047d1b5ea53543645755eb45076217fdd32712c851c8baa0378dd408604bad42",
  "status": "pending"
}

Step A2: Payer signs deposit XDR

Step A3: POST /api/escrow/:id/submit

[submitA] {
  "txHash": "b6f03fef022a9f271fbb45234a8a5c3dc5622a639ece62b993a5fac36a531178",
  "status": "deposited"
}
  ✓ Deposit tx: b6f03fef022a9f271fbb45234a8a5c3dc5622a639ece62b993a5fac36a531178

Step A4: GET /api/escrow/:id — confirm Held

[statusA (after deposit)] {
  "status": "deposited",
  "onChainStatus": "Held"
}

Step A5: POST /api/escrow/:id/release — get unsigned release XDR

Step A6: Merchant signs release XDR

Step A7: POST /api/escrow/:id/release/submit (via server — NOT rpc directly)

[releaseSubmitA] {
  "txHash": "82b0b39b1ae1df736dfc8855d133186720a18af601f638982e3fadcdc1024796",
  "status": "fulfilled"
}
  ✓ Release tx: 82b0b39b1ae1df736dfc8855d133186720a18af601f638982e3fadcdc1024796

[statusA (after release)] {
  "status": "fulfilled"
}

──────────────────────────────────────────────────────────────
  Order B: deposit → merchant voluntary refund
──────────────────────────────────────────────────────────────

Step B1: POST /api/escrow — create session

Step B2: Payer signs and submits deposit
  ✓ Deposit tx: d6c8d8c674b0328722b387008e8fd84cf4b4cc43acd34e0016f1f56549fb94cf

Step B3: POST /api/escrow/:id/refund (merchant caller)

Step B4: Merchant signs refund XDR

Step B5: POST /api/escrow/:id/refund/submit (via server — NOT rpc directly)

[refundSubmitB] {
  "txHash": "053d09407d2791cba27321d88c770bb92709ac7b45366e8e546e2dcdbaac373c",
  "status": "refunded"
}
  ✓ Refund tx: 053d09407d2791cba27321d88c770bb92709ac7b45366e8e546e2dcdbaac373c

──────────────────────────────────────────────────────────────
  Summary
──────────────────────────────────────────────────────────────

✅ Negative check (wrong merchant rejected):
   Order ID:    99bff4da5147b8db529858f55d2d089b68bc08f8e76016c377e34ed5b04b055a  → 400 returned, nothing submitted

✅ Order A (release):
   Order ID:    047d1b5ea53543645755eb45076217fdd32712c851c8baa0378dd408604bad42
   Deposit tx:  b6f03fef022a9f271fbb45234a8a5c3dc5622a639ece62b993a5fac36a531178
   Release tx:  82b0b39b1ae1df736dfc8855d133186720a18af601f638982e3fadcdc1024796

✅ Order B (refund):
   Order ID:    b93e3435a05138a35501c15494839e7e9f7dbd7057e2d0b950ad6313a727696f
   Deposit tx:  d6c8d8c674b0328722b387008e8fd84cf4b4cc43acd34e0016f1f56549fb94cf
   Refund tx:   053d09407d2791cba27321d88c770bb92709ac7b45366e8e546e2dcdbaac373c

Verify on Stellar Expert:
  https://stellar.expert/explorer/testnet/tx/b6f03fef022a9f271fbb45234a8a5c3dc5622a639ece62b993a5fac36a531178
  https://stellar.expert/explorer/testnet/tx/82b0b39b1ae1df736dfc8855d133186720a18af601f638982e3fadcdc1024796
  https://stellar.expert/explorer/testnet/tx/d6c8d8c674b0328722b387008e8fd84cf4b4cc43acd34e0016f1f56549fb94cf
  https://stellar.expert/explorer/testnet/tx/053d09407d2791cba27321d88c770bb92709ac7b45366e8e546e2dcdbaac373c
```

---

## Accounts

These were throwaway testnet accounts funded by Friendbot for this run. No secrets are recorded here.

| Role | Address |
|------|---------|
| Payer | `GDFQLCZFZRXWUYWLYR6ZTMNT6VYWBMVJS2QLXEHRGFEOFCZV2NXH4UMK` |
| Merchant | `GCJDDBPR62KZAPPULIC36O2ABS36PENZ2O5NMY66V6POOHW35VKPNFHK` |
| Wrong merchant (negative check) | `GBV4TKLRNFKCL33NP3DVATS3W5NGMN5LSWX4WXSCCNY4HHX6RUWXCAP6` |

Token: native XLM Stellar Asset Contract `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC`  
Amount: 10000000 stroops (1 XLM)

---

## Transaction table

| Step | Description | Order ID | Tx hash | Stellar Expert |
|------|-------------|----------|---------|----------------|
| Negative check | Wrong merchant → 400, nothing submitted | `99bff4da5147b8db529858f55d2d089b68bc08f8e76016c377e34ed5b04b055a` | — | — |
| A3 | Order A deposit | `047d1b5ea53543645755eb45076217fdd32712c851c8baa0378dd408604bad42` | `b6f03fef022a9f271fbb45234a8a5c3dc5622a639ece62b993a5fac36a531178` | [view](https://stellar.expert/explorer/testnet/tx/b6f03fef022a9f271fbb45234a8a5c3dc5622a639ece62b993a5fac36a531178) |
| A7 | Order A release | `047d1b5ea53543645755eb45076217fdd32712c851c8baa0378dd408604bad42` | `82b0b39b1ae1df736dfc8855d133186720a18af601f638982e3fadcdc1024796` | [view](https://stellar.expert/explorer/testnet/tx/82b0b39b1ae1df736dfc8855d133186720a18af601f638982e3fadcdc1024796) |
| B2 | Order B deposit | `b93e3435a05138a35501c15494839e7e9f7dbd7057e2d0b950ad6313a727696f` | `d6c8d8c674b0328722b387008e8fd84cf4b4cc43acd34e0016f1f56549fb94cf` | [view](https://stellar.expert/explorer/testnet/tx/d6c8d8c674b0328722b387008e8fd84cf4b4cc43acd34e0016f1f56549fb94cf) |
| B5 | Order B refund | `b93e3435a05138a35501c15494839e7e9f7dbd7057e2d0b950ad6313a727696f` | `053d09407d2791cba27321d88c770bb92709ac7b45366e8e546e2dcdbaac373c` | [view](https://stellar.expert/explorer/testnet/tx/053d09407d2791cba27321d88c770bb92709ac7b45366e8e546e2dcdbaac373c) |

---

## What this proves

1. **Full server lifecycle.** Every step went through server HTTP endpoints — no direct RPC calls from the script for release or refund. The server validated each XDR, submitted the signed transaction, polled for confirmation, and returned the result.

2. **Negative check (arg[1] merchant mismatch).** A deposit signed with a wrong merchant address returned HTTP 400 from the server and nothing was submitted to chain. This proves the 13-argument XDR validation is enforced in production, not just in tests.

3. **Order A (deposit → release).** Payer deposited 1 XLM into the escrow contract. The server confirmed the on-chain status was `Held`. The merchant signed a release, and the server validated and submitted it. The session reached `fulfilled`.

4. **Order B (deposit → merchant voluntary refund).** Payer deposited 1 XLM. The merchant signed a refund, and the server validated and submitted it. The session reached `refunded`.

5. **Status decoding from real on-chain shapes.** The `scValToNative` shape `["Held"]` (a one-element string array) was decoded correctly by the server, confirming PR #34's fix worked end-to-end. This was the bug that caused an earlier run on the same day to fail.

---

## What this does NOT prove

- **Timeout-based payer refund path.** Only a merchant voluntary refund (Order B) was tested. The payer self-refund after `timeout_ledgers` was not exercised.
- **`extend_escrow_ttl`.** This function was not called in the demo.
- **Event contents on-chain.** The script confirms transaction outcomes via the server and the on-chain `get_escrow` state; it does not inspect emitted contract events.
- **Any token other than native XLM.** The run used the native XLM SAC (`CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC`) only.
- **Mainnet.** This was a testnet run only. Testnet accounts and funds have no real-world value.
- **Load or concurrency.** This was a single sequential run.
- **Security audit.** Neither the contract nor the server has been professionally audited. Use on mainnet is at your own risk.

---

## Problems found by live runs earlier the same day

Two bugs were found and fixed before this successful run:

**PR #33 — Confirmation polling / SDK parse error.**  
An earlier deposit (`f750064c91f2671fd4ee0646d9cc4171f0694846bf54789cb6b3c6d57d2bc6bc`) confirmed on-chain but the server returned a false `504 POLL_TIMEOUT`. The root cause was two issues: (1) the polling loop treated every `getTransaction` error as "pending" instead of distinguishing a network error from a parse error, and (2) `stellar-sdk@12.3.0` (the version in use at the time) could not parse current testnet transaction metadata, throwing `Bad union switch: 4`. The fix added a raw-status fallback that reads only the `result.status` string when the SDK throws, and upgraded to `@stellar/stellar-sdk` (the scoped package, v17). That deposit left one throwaway 1 XLM escrow held on testnet from the failed run; it is not part of the evidence in this document.

**PR #34 — Status enum decoding.**  
After the polling fix, `get_escrow` calls succeeded on-chain but the server rejected them with `400 SIMULATION_FAILED: Cannot decode escrow status: ["Held"]`. The `scValToNative` function in `@stellar/stellar-sdk@17` decodes a Soroban unit-variant enum as a one-element string array `['Held']`, not a plain string or `{ tag }` object as the decoder expected. The fix added a third branch accepting `['Held' | 'Released' | 'Refunded']`, covered by 23 new tests built from real SDK values.

Both PRs were merged to `main` before the successful run documented here.

---

*Transaction hashes and IDs in this file are copied from the live run output above. This environment could not reach the Stellar testnet to re-verify them via RPC at the time of writing.*
