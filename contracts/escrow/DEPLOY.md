# StellarFlow Escrow Contract — Deployment Guide

This guide covers deploying the `stellarflow-escrow` Soroban contract to Stellar
testnet (for development) or mainnet (for production).

> ⚠️ **Mainnet deployment involves real funds. There is no undo.**
> Always test thoroughly on testnet first.

---

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Rust | stable (≥ 1.75) | [rustup.rs](https://rustup.rs) |
| wasm32v1-none target | — | `rustup target add wasm32v1-none` |
| stellar-cli | ≥ 25.2.0 | See below |
| A funded Stellar account | — | Testnet: [Stellar Lab](https://laboratory.stellar.org/#account-creator) |

### Install stellar-cli

```bash
# macOS/Linux — download the pre-built binary (fastest)
curl -L https://github.com/stellar/stellar-cli/releases/download/v28.1.0/stellar-cli-28.1.0-x86_64-unknown-linux-gnu.tar.gz \
  -o stellar-cli.tar.gz
tar xzf stellar-cli.tar.gz
sudo mv stellar /usr/local/bin/stellar
stellar --version  # stellar 28.1.0
```

---

## 1. Build the WASM

```bash
cd contracts/escrow

# Required by soroban-sdk's build script when invoking cargo directly
export SOROBAN_SDK_BUILD_SYSTEM_SUPPORTS_SPEC_SHAKING_V2=true

cargo build --target wasm32v1-none --release

# Artifact is at:
# target/wasm32v1-none/release/stellarflow_escrow.wasm
ls -lh target/wasm32v1-none/release/stellarflow_escrow.wasm
```

Or use the stellar CLI wrapper (handles the env var automatically):

```bash
stellar contract build
```

---

## 2. Configure stellar-cli identity

```bash
# Create a deployer identity (or use an existing one)
stellar keys generate deployer --network testnet --fund

# Verify the account is funded
stellar keys address deployer
```

---

## 3. Deploy to testnet

```bash
stellar contract deploy \
  --wasm target/wasm32v1-none/release/stellarflow_escrow.wasm \
  --source deployer \
  --network testnet
```

On success, stellar-cli prints the deployed **contract ID**, e.g.:

```
CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM
```

**Do not fabricate a contract ID.** The above is a placeholder. The real contract ID
is assigned by the network at deployment time and must be recorded from the CLI output.

---

## 4. Verify deployment

```bash
# Confirm the contract exists on-chain
stellar contract info \
  --contract-id <YOUR_CONTRACT_ID_HERE> \
  --network testnet
```

---

## 5. Use the contract

Once deployed, pass the contract ID to `EscrowClient` in your server:

```typescript
import { EscrowClient, HttpSorobanRpcClient, SOROBAN_RPC_URLS } from '@stellarflow/server';

const client = new EscrowClient({
  rpcClient: new HttpSorobanRpcClient(SOROBAN_RPC_URLS.testnet),
  contractId: '<YOUR_CONTRACT_ID_HERE>',
  network: 'testnet',
});
```

---

## 6. Mainnet deployment checklist

> ⚠️ **Real funds. No undo.**

Before deploying to mainnet:

- [ ] Full testnet regression pass (all 17 Rust tests + 34 TS tests green)
- [ ] Audit the contract for reentrancy, integer overflow, and storage exhaustion
- [ ] Document the deployed contract ID in a project-controlled registry
- [ ] Verify the WASM hash matches the source using:
  ```bash
  stellar contract info --contract-id <ID> --network mainnet
  sha256sum target/wasm32v1-none/release/stellarflow_escrow.wasm
  ```
- [ ] Set `STELLAR_NETWORK=mainnet` in the server config
- [ ] Test a small deposit+release cycle with a nominal amount before full production traffic

Mainnet deployment:

```bash
stellar contract deploy \
  --wasm target/wasm32v1-none/release/stellarflow_escrow.wasm \
  --source deployer \
  --network mainnet
```

---

## 7. No live testnet deployment in this PR

**This PR does not include a live testnet contract deployment.** The contract has
been built, tested locally (17/17 Rust tests + 34/34 TypeScript tests), and the CI
workflow is configured to build and test it on every push. A live testnet deployment
should be done as part of the v0.2 release process, after the PR is reviewed and
merged to a release branch.

This is consistent with the CONTRIBUTING.md practice of not fabricating contract IDs
or claiming a live deployment that has not actually been verified.
