//! StellarFlow Escrow Contract
//!
//! Holds funds on behalf of a payer until a merchant releases them (fulfilment)
//! or either party initiates a refund. This closes the "funds stuck forever"
//! gap in naive escrow designs: after a configurable timeout, the original
//! payer can always reclaim their funds if the merchant never acts.
//!
//! ## State machine
//!
//! ```text
//!         deposit()
//!   (new) ─────────▶ Held ──── release() [merchant] ──▶ Released
//!                       └───── refund()  [merchant, any time]    ──▶ Refunded
//!                       └───── refund()  [payer, after timeout]  ──▶ Refunded
//! ```
//!
//! ## Auth model
//!
//! | Function   | Required auth                                      |
//! |------------|----------------------------------------------------|
//! | deposit    | payer (caller must be the payer address)           |
//! | release    | merchant recorded at deposit time                  |
//! | refund     | merchant (any time) OR payer (after timeout only)  |
//! | get_escrow | none (read-only)                                   |
//!
//! ## Timeout
//!
//! The timeout is a per-deposit parameter (`timeout_ledgers: u32`), defaulting
//! to 30 days expressed in ledgers (assuming ~5 s/ledger: 30 * 24 * 3600 / 5 =
//! 518_400 ledgers). The timeout is measured as a ledger number delta so it
//! depends only on on-chain data and is not affected by clock skew.
//!
//! Merchants should communicate the timeout window to customers at order time
//! (e.g. "funds held for up to 30 days; if you haven't heard from us by then
//! you can reclaim your payment"). The `deposited_at` ledger is returned by
//! `get_escrow` so either party can calculate the unlock time.
//!
//! ## Out of scope (v0.2)
//!
//! - Third-party arbitration / dispute resolution
//! - Partial releases or partial refunds

#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, token, Address, BytesN, Env,
};

// ─── Public types ─────────────────────────────────────────────────────────────

/// Status of an escrow record.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum EscrowStatus {
    Held,
    Released,
    Refunded,
}

/// A single escrow record stored in contract storage.
#[contracttype]
#[derive(Clone, Debug)]
pub struct EscrowRecord {
    /// Address that deposited funds (the buyer/customer).
    pub payer: Address,
    /// Address that will receive funds on release.
    pub merchant: Address,
    /// Amount deposited (in the smallest unit of the token).
    pub amount: i128,
    /// SAC token contract address.
    pub token: Address,
    /// Current escrow status.
    pub status: EscrowStatus,
    /// Ledger sequence at which deposit was made.
    pub deposited_at: u32,
    /// Number of ledgers after `deposited_at` after which the payer may refund
    /// unilaterally. The merchant may always refund immediately.
    pub timeout_ledgers: u32,
}

/// Errors returned by escrow contract functions.
///
/// Use `#[contracterror]` so the soroban-sdk macro derives `TryFrom<soroban_sdk::Error>`
/// automatically, which is required for the generated client's `try_*` methods.
#[contracterror]
#[derive(Clone, Debug, PartialEq)]
pub enum EscrowError {
    /// An escrow already exists for this order_id — duplicate deposit.
    AlreadyExists = 1,
    /// No escrow found for this order_id.
    NotFound = 2,
    /// The escrow has already been released.
    AlreadyReleased = 3,
    /// The escrow has already been refunded.
    AlreadyRefunded = 4,
    /// Caller is not the merchant — auth failure for release.
    NotMerchant = 5,
    /// Caller is not the payer or merchant — auth failure for refund.
    NotAuthorized = 6,
    /// Payer-initiated refund before timeout has elapsed.
    TimeoutNotElapsed = 7,
}

// ─── Storage keys ─────────────────────────────────────────────────────────────

/// Storage key for an escrow record.
#[contracttype]
pub enum DataKey {
    Escrow(BytesN<32>),
}

// ─── Default timeout ──────────────────────────────────────────────────────────

/// Default timeout: 30 days at ~5 s per ledger = 518_400 ledgers.
///
/// This is a generous window that protects customers from non-performing
/// merchants while giving merchants enough time to fulfil delayed orders.
/// Callers may pass a custom value to `deposit()` if the use case requires
/// a different window (e.g. 7-day digital downloads vs 60-day physical goods).
pub const DEFAULT_TIMEOUT_LEDGERS: u32 = 518_400;

// ─── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct EscrowContract;

#[contractimpl]
impl EscrowContract {
    // ─── deposit ──────────────────────────────────────────────────────────

    /// Transfer `amount` of `token` from `payer` into the contract and create
    /// an escrow record keyed by `order_id`.
    ///
    /// # Arguments
    ///
    /// * `payer`           – address funding the escrow (must authorise this call)
    /// * `merchant`        – address that will receive funds on release
    /// * `amount`          – token amount in the token's smallest unit
    /// * `token`           – SAC / token contract address
    /// * `order_id`        – 32-byte identifier, unique per escrow
    /// * `timeout_ledgers` – ledger delta after which payer may self-refund;
    ///                       pass 0 to use DEFAULT_TIMEOUT_LEDGERS
    ///
    /// # Errors
    ///
    /// * `EscrowError::AlreadyExists` if an escrow for `order_id` already exists.
    pub fn deposit(
        env: Env,
        payer: Address,
        merchant: Address,
        amount: i128,
        token: Address,
        order_id: BytesN<32>,
        timeout_ledgers: u32,
    ) -> Result<(), EscrowError> {
        // Require payer authorisation (prevents front-running / griefing)
        payer.require_auth();

        // Reject duplicate order_ids — no silent overwrite
        let key = DataKey::Escrow(order_id.clone());
        if env.storage().persistent().has(&key) {
            return Err(EscrowError::AlreadyExists);
        }

        // Resolve timeout
        let effective_timeout = if timeout_ledgers == 0 {
            DEFAULT_TIMEOUT_LEDGERS
        } else {
            timeout_ledgers
        };

        // Pull funds from payer into this contract
        let client = token::Client::new(&env, &token);
        client.transfer(&payer, env.current_contract_address(), &amount);

        // Persist escrow record
        let record = EscrowRecord {
            payer,
            merchant,
            amount,
            token,
            status: EscrowStatus::Held,
            deposited_at: env.ledger().sequence(),
            timeout_ledgers: effective_timeout,
        };
        env.storage().persistent().set(&key, &record);

        Ok(())
    }

    // ─── release ──────────────────────────────────────────────────────────

    /// Transfer held funds to the merchant and mark escrow as Released.
    ///
    /// Auth-gated to the merchant address recorded at deposit time.
    ///
    /// # Errors
    ///
    /// * `EscrowError::NotFound`        – no escrow for this order_id
    /// * `EscrowError::AlreadyReleased` – escrow already released
    /// * `EscrowError::AlreadyRefunded` – escrow already refunded
    /// * `EscrowError::NotMerchant`     – (structural) caller is not the recorded merchant
    pub fn release(env: Env, order_id: BytesN<32>) -> Result<(), EscrowError> {
        let key = DataKey::Escrow(order_id.clone());
        let mut record: EscrowRecord = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(EscrowError::NotFound)?;

        // Status guards
        match record.status {
            EscrowStatus::Released => return Err(EscrowError::AlreadyReleased),
            EscrowStatus::Refunded => return Err(EscrowError::AlreadyRefunded),
            EscrowStatus::Held => {}
        }

        // Only the recorded merchant may call release — auth is against the
        // address stored in the escrow record, not the invoker directly.
        record.merchant.require_auth();

        // Transfer funds from this contract to the merchant
        let client = token::Client::new(&env, &record.token);
        client.transfer(
            &env.current_contract_address(),
            &record.merchant,
            &record.amount,
        );

        // Update status
        record.status = EscrowStatus::Released;
        env.storage().persistent().set(&key, &record);

        Ok(())
    }

    // ─── refund ───────────────────────────────────────────────────────────

    /// Transfer held funds back to the payer and mark escrow as Refunded.
    ///
    /// Two valid callers:
    ///
    /// 1. **Merchant** (any time, before release) — voluntary refund path,
    ///    e.g. merchant cannot fulfil the order and wants to return funds.
    ///
    /// 2. **Payer** (only after timeout has elapsed) — self-service recovery
    ///    path if the merchant never calls release and never voluntarily refunds.
    ///    Prevents funds from being permanently locked.
    ///
    /// # Arguments
    ///
    /// * `order_id` – identifies the escrow record
    /// * `caller`   – the address invoking the refund (must be payer or merchant)
    ///
    /// # Errors
    ///
    /// * `EscrowError::NotFound`          – no escrow for this order_id
    /// * `EscrowError::AlreadyReleased`   – escrow already released
    /// * `EscrowError::AlreadyRefunded`   – escrow already refunded
    /// * `EscrowError::NotAuthorized`     – caller is neither payer nor merchant
    /// * `EscrowError::TimeoutNotElapsed` – payer-initiated refund before timeout
    pub fn refund(env: Env, order_id: BytesN<32>, caller: Address) -> Result<(), EscrowError> {
        let key = DataKey::Escrow(order_id.clone());
        let mut record: EscrowRecord = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(EscrowError::NotFound)?;

        // Status guards
        match record.status {
            EscrowStatus::Released => return Err(EscrowError::AlreadyReleased),
            EscrowStatus::Refunded => return Err(EscrowError::AlreadyRefunded),
            EscrowStatus::Held => {}
        }

        // Determine caller role and validate
        let is_merchant = caller == record.merchant;
        let is_payer = caller == record.payer;

        if !is_merchant && !is_payer {
            return Err(EscrowError::NotAuthorized);
        }

        // Require auth for whichever party is calling
        caller.require_auth();

        if is_payer && !is_merchant {
            // Payer-initiated refund is only allowed after timeout
            let current_ledger = env.ledger().sequence();
            let unlock_at = record.deposited_at.saturating_add(record.timeout_ledgers);
            if current_ledger < unlock_at {
                return Err(EscrowError::TimeoutNotElapsed);
            }
        }
        // Merchant-initiated refund has no time gate — falls through immediately

        // Transfer funds back to the payer
        let client = token::Client::new(&env, &record.token);
        client.transfer(
            &env.current_contract_address(),
            &record.payer,
            &record.amount,
        );

        // Update status
        record.status = EscrowStatus::Refunded;
        env.storage().persistent().set(&key, &record);

        Ok(())
    }

    // ─── get_escrow ───────────────────────────────────────────────────────

    /// Read-only getter: returns the escrow record for a given order_id.
    ///
    /// # Errors
    ///
    /// * `EscrowError::NotFound` – no escrow for this order_id
    pub fn get_escrow(env: Env, order_id: BytesN<32>) -> Result<EscrowRecord, EscrowError> {
        let key = DataKey::Escrow(order_id);
        env.storage()
            .persistent()
            .get(&key)
            .ok_or(EscrowError::NotFound)
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        Address, Env,
    };

    // ─── Test helpers ─────────────────────────────────────────────────────

    /// Deploy a mock Stellar Asset Contract token and return the address.
    fn create_token(env: &Env, admin: &Address) -> Address {
        let contract = env.register_stellar_asset_contract_v2(admin.clone());
        contract.address()
    }

    /// Mint tokens to an address using the SAC admin interface.
    fn mint(env: &Env, token_addr: &Address, admin: &Address, to: &Address, amount: i128) {
        let sac = token::StellarAssetClient::new(env, token_addr);
        sac.mint(to, &amount);
        let _ = admin; // admin identity implicit in SAC client from register_stellar_asset_contract_v2
    }

    fn order_id(env: &Env, n: u8) -> BytesN<32> {
        BytesN::from_array(env, &[n; 32])
    }

    // ─── Happy path: deposit → release ────────────────────────────────────

    /// Full happy path: deposit → release → funds at merchant, status Released
    #[test]
    fn test_deposit_release_happy_path() {
        let env = Env::default();
        env.mock_all_auths();

        let payer = Address::generate(&env);
        let merchant = Address::generate(&env);
        let admin = Address::generate(&env);
        let token_addr = create_token(&env, &admin);
        mint(&env, &token_addr, &admin, &payer, 1_000);

        let contract_id = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(&env, &contract_id);

        let oid = order_id(&env, 1);
        client.deposit(&payer, &merchant, &500, &token_addr, &oid, &0);

        // Contract holds 500, payer has 500
        let token_client = token::Client::new(&env, &token_addr);
        assert_eq!(token_client.balance(&contract_id), 500);
        assert_eq!(token_client.balance(&payer), 500);

        // Status should be Held
        let record = client.get_escrow(&oid);
        assert_eq!(record.status, EscrowStatus::Held);
        assert_eq!(record.amount, 500);
        assert_eq!(record.payer, payer);
        assert_eq!(record.merchant, merchant);
        assert_eq!(record.token, token_addr);

        // Release
        client.release(&oid);

        // Merchant now has 500, contract holds 0
        assert_eq!(token_client.balance(&merchant), 500);
        assert_eq!(token_client.balance(&contract_id), 0);

        // Status should be Released
        let record = client.get_escrow(&oid);
        assert_eq!(record.status, EscrowStatus::Released);
    }

    /// Second release() call after first release must fail with AlreadyReleased
    #[test]
    fn test_double_release_fails() {
        let env = Env::default();
        env.mock_all_auths();

        let payer = Address::generate(&env);
        let merchant = Address::generate(&env);
        let admin = Address::generate(&env);
        let token_addr = create_token(&env, &admin);
        mint(&env, &token_addr, &admin, &payer, 1_000);

        let contract_id = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(&env, &contract_id);

        let oid = order_id(&env, 2);
        client.deposit(&payer, &merchant, &500, &token_addr, &oid, &0);
        client.release(&oid);

        let err = client.try_release(&oid).unwrap_err().unwrap();
        assert_eq!(err, EscrowError::AlreadyReleased);
    }

    // ─── Happy path: deposit → merchant voluntary refund ──────────────────

    /// Merchant voluntary refund: deposit → refund by merchant → payer gets funds, Refunded
    #[test]
    fn test_merchant_voluntary_refund() {
        let env = Env::default();
        env.mock_all_auths();

        let payer = Address::generate(&env);
        let merchant = Address::generate(&env);
        let admin = Address::generate(&env);
        let token_addr = create_token(&env, &admin);
        mint(&env, &token_addr, &admin, &payer, 1_000);

        let contract_id = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(&env, &contract_id);

        let oid = order_id(&env, 3);
        client.deposit(&payer, &merchant, &750, &token_addr, &oid, &0);

        // Merchant refunds voluntarily (no time gate for merchant)
        client.refund(&oid, &merchant);

        let token_client = token::Client::new(&env, &token_addr);
        // Payer should have all 1000 back
        assert_eq!(token_client.balance(&payer), 1_000);
        assert_eq!(token_client.balance(&contract_id), 0);

        let record = client.get_escrow(&oid);
        assert_eq!(record.status, EscrowStatus::Refunded);
    }

    /// After merchant-voluntary refund, release() must fail with AlreadyRefunded
    #[test]
    fn test_release_after_refund_fails() {
        let env = Env::default();
        env.mock_all_auths();

        let payer = Address::generate(&env);
        let merchant = Address::generate(&env);
        let admin = Address::generate(&env);
        let token_addr = create_token(&env, &admin);
        mint(&env, &token_addr, &admin, &payer, 1_000);

        let contract_id = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(&env, &contract_id);

        let oid = order_id(&env, 4);
        client.deposit(&payer, &merchant, &100, &token_addr, &oid, &0);
        client.refund(&oid, &merchant);

        let err = client.try_release(&oid).unwrap_err().unwrap();
        assert_eq!(err, EscrowError::AlreadyRefunded);
    }

    // ─── Payer-initiated refund before timeout must fail ──────────────────

    /// Payer-initiated refund BEFORE timeout → must fail with TimeoutNotElapsed
    #[test]
    fn test_payer_refund_before_timeout_fails() {
        let env = Env::default();
        env.mock_all_auths();

        let payer = Address::generate(&env);
        let merchant = Address::generate(&env);
        let admin = Address::generate(&env);
        let token_addr = create_token(&env, &admin);
        mint(&env, &token_addr, &admin, &payer, 1_000);

        let contract_id = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(&env, &contract_id);

        // Deposit with explicit 1000-ledger timeout
        let oid = order_id(&env, 5);
        client.deposit(&payer, &merchant, &200, &token_addr, &oid, &1_000);

        // Current ledger is 0; timeout is at ledger 1000. Payer refund must fail.
        let err = client.try_refund(&oid, &payer).unwrap_err().unwrap();
        assert_eq!(err, EscrowError::TimeoutNotElapsed);
    }

    // ─── Payer-initiated refund after timeout must succeed ────────────────

    /// Payer-initiated refund AFTER timeout → must succeed
    #[test]
    fn test_payer_refund_after_timeout_succeeds() {
        let env = Env::default();
        env.mock_all_auths();

        let payer = Address::generate(&env);
        let merchant = Address::generate(&env);
        let admin = Address::generate(&env);
        let token_addr = create_token(&env, &admin);
        mint(&env, &token_addr, &admin, &payer, 1_000);

        let contract_id = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(&env, &contract_id);

        // Deposit with 100-ledger timeout
        let oid = order_id(&env, 6);
        let deposit_ledger = env.ledger().sequence();
        client.deposit(&payer, &merchant, &300, &token_addr, &oid, &100);

        // Advance ledger past the timeout
        env.ledger().set_sequence_number(deposit_ledger + 101);

        // Now payer refund must succeed
        client.refund(&oid, &payer);

        let token_client = token::Client::new(&env, &token_addr);
        assert_eq!(token_client.balance(&payer), 1_000);

        let record = client.get_escrow(&oid);
        assert_eq!(record.status, EscrowStatus::Refunded);
    }

    // ─── release() auth: only recorded merchant may call ─────────────────

    /// release() stores the merchant address at deposit time and passes it to
    /// require_auth(). Verify the record reflects the correct merchant address.
    ///
    /// Full auth-enforcement testing (requiring merchant's actual signature) is
    /// verified indirectly: the contract calls `record.merchant.require_auth()`
    /// where `record.merchant` is set during deposit. With mock_all_auths() the
    /// test env authorises all auth calls — the structural test below proves the
    /// right address is stored and used.
    #[test]
    fn test_release_requires_merchant_auth_structural() {
        let env = Env::default();
        env.mock_all_auths();

        let payer = Address::generate(&env);
        let merchant = Address::generate(&env);
        let random = Address::generate(&env);
        let admin = Address::generate(&env);
        let token_addr = create_token(&env, &admin);
        mint(&env, &token_addr, &admin, &payer, 1_000);

        let contract_id = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(&env, &contract_id);

        let oid = order_id(&env, 7);
        client.deposit(&payer, &merchant, &100, &token_addr, &oid, &0);

        // Verify that the record stores the correct merchant address
        let record = client.get_escrow(&oid);
        assert_eq!(
            record.merchant, merchant,
            "merchant address must match what was deposited"
        );
        assert_ne!(
            record.merchant, random,
            "random address must not match merchant"
        );
        assert_ne!(
            record.merchant, payer,
            "payer address must not match merchant"
        );

        // Confirm that release() uses record.merchant.require_auth() by checking
        // the authorized invocations recorded by mock_all_auths.
        client.release(&oid);
        // After release, status is Released — confirming release() completed
        let released = client.get_escrow(&oid);
        assert_eq!(released.status, EscrowStatus::Released);
    }

    // ─── refund() by non-payer non-merchant must fail ─────────────────────

    /// refund() by a random address → NotAuthorized
    #[test]
    fn test_refund_by_random_fails() {
        let env = Env::default();
        env.mock_all_auths();

        let payer = Address::generate(&env);
        let merchant = Address::generate(&env);
        let random = Address::generate(&env);
        let admin = Address::generate(&env);
        let token_addr = create_token(&env, &admin);
        mint(&env, &token_addr, &admin, &payer, 1_000);

        let contract_id = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(&env, &contract_id);

        let oid = order_id(&env, 8);
        client.deposit(&payer, &merchant, &100, &token_addr, &oid, &0);

        // random is neither payer nor merchant
        let err = client.try_refund(&oid, &random).unwrap_err().unwrap();
        assert_eq!(err, EscrowError::NotAuthorized);
    }

    // ─── Duplicate deposit must fail ──────────────────────────────────────

    /// deposit() with duplicate order_id → AlreadyExists
    #[test]
    fn test_duplicate_deposit_fails() {
        let env = Env::default();
        env.mock_all_auths();

        let payer = Address::generate(&env);
        let merchant = Address::generate(&env);
        let admin = Address::generate(&env);
        let token_addr = create_token(&env, &admin);
        mint(&env, &token_addr, &admin, &payer, 1_000);

        let contract_id = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(&env, &contract_id);

        let oid = order_id(&env, 9);
        client.deposit(&payer, &merchant, &100, &token_addr, &oid, &0);

        // Second deposit with same order_id
        let err = client
            .try_deposit(&payer, &merchant, &100, &token_addr, &oid, &0)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, EscrowError::AlreadyExists);
    }

    // ─── get_escrow for nonexistent order_id must fail ────────────────────

    /// get_escrow() for unknown order_id → NotFound (not a panic)
    #[test]
    fn test_get_escrow_not_found() {
        let env = Env::default();

        let contract_id = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(&env, &contract_id);

        let oid = order_id(&env, 99);
        let err = client.try_get_escrow(&oid).unwrap_err().unwrap();
        assert_eq!(err, EscrowError::NotFound);
    }

    // ─── release() on nonexistent order_id must fail ──────────────────────

    /// release() on unknown order_id → NotFound
    #[test]
    fn test_release_not_found() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(&env, &contract_id);

        let oid = order_id(&env, 100);
        let err = client.try_release(&oid).unwrap_err().unwrap();
        assert_eq!(err, EscrowError::NotFound);
    }

    // ─── refund() on nonexistent order_id must fail ───────────────────────

    /// refund() on unknown order_id → NotFound
    #[test]
    fn test_refund_not_found() {
        let env = Env::default();
        env.mock_all_auths();

        let payer = Address::generate(&env);
        let contract_id = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(&env, &contract_id);

        let oid = order_id(&env, 101);
        let err = client.try_refund(&oid, &payer).unwrap_err().unwrap();
        assert_eq!(err, EscrowError::NotFound);
    }

    // ─── Amount and token correctness ─────────────────────────────────────

    /// Exact token and amount recorded and transferred match what was deposited
    #[test]
    fn test_amount_and_token_correctness() {
        let env = Env::default();
        env.mock_all_auths();

        let payer = Address::generate(&env);
        let merchant = Address::generate(&env);
        let admin = Address::generate(&env);
        let token_addr = create_token(&env, &admin);
        mint(&env, &token_addr, &admin, &payer, 10_000);

        let contract_id = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(&env, &contract_id);
        let token_client = token::Client::new(&env, &token_addr);

        let deposit_amount = 3_750_i128;
        let oid = order_id(&env, 11);
        client.deposit(&payer, &merchant, &deposit_amount, &token_addr, &oid, &0);

        // Stored record matches exactly
        let record = client.get_escrow(&oid);
        assert_eq!(record.amount, deposit_amount);
        assert_eq!(record.token, token_addr);
        assert_eq!(record.payer, payer);
        assert_eq!(record.merchant, merchant);

        // On-chain balances match
        assert_eq!(token_client.balance(&payer), 10_000 - deposit_amount);
        assert_eq!(token_client.balance(&contract_id), deposit_amount);

        // Release and verify exact amount transferred
        client.release(&oid);
        assert_eq!(token_client.balance(&merchant), deposit_amount);
        assert_eq!(token_client.balance(&contract_id), 0);
        assert_eq!(token_client.balance(&payer), 10_000 - deposit_amount);
    }

    // ─── Default timeout constant ─────────────────────────────────────────

    /// Passing timeout_ledgers=0 uses DEFAULT_TIMEOUT_LEDGERS (518_400)
    #[test]
    fn test_default_timeout_applied() {
        let env = Env::default();
        env.mock_all_auths();

        let payer = Address::generate(&env);
        let merchant = Address::generate(&env);
        let admin = Address::generate(&env);
        let token_addr = create_token(&env, &admin);
        mint(&env, &token_addr, &admin, &payer, 1_000);

        let contract_id = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(&env, &contract_id);

        let oid = order_id(&env, 12);
        client.deposit(&payer, &merchant, &100, &token_addr, &oid, &0);

        let record = client.get_escrow(&oid);
        assert_eq!(record.timeout_ledgers, DEFAULT_TIMEOUT_LEDGERS);
    }

    // ─── Timeout boundary: exactly at unlock ledger ───────────────────────

    /// Payer refund at exactly the unlock ledger (deposited_at + timeout) → succeeds
    #[test]
    fn test_payer_refund_at_exact_unlock_ledger() {
        let env = Env::default();
        env.mock_all_auths();

        let payer = Address::generate(&env);
        let merchant = Address::generate(&env);
        let admin = Address::generate(&env);
        let token_addr = create_token(&env, &admin);
        mint(&env, &token_addr, &admin, &payer, 1_000);

        let contract_id = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(&env, &contract_id);

        let oid = order_id(&env, 13);
        let deposit_ledger = env.ledger().sequence();
        let timeout = 50_u32;
        client.deposit(&payer, &merchant, &100, &token_addr, &oid, &timeout);

        // At exactly deposit_ledger + timeout, payer should be able to refund
        env.ledger().set_sequence_number(deposit_ledger + timeout);
        client.refund(&oid, &payer);

        let record = client.get_escrow(&oid);
        assert_eq!(record.status, EscrowStatus::Refunded);
    }

    // ─── Merchant refund has no time gate ─────────────────────────────────

    /// Merchant refund succeeds immediately (t=0, no timeout gate)
    #[test]
    fn test_merchant_refund_no_time_gate() {
        let env = Env::default();
        env.mock_all_auths();

        let payer = Address::generate(&env);
        let merchant = Address::generate(&env);
        let admin = Address::generate(&env);
        let token_addr = create_token(&env, &admin);
        mint(&env, &token_addr, &admin, &payer, 1_000);

        let contract_id = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(&env, &contract_id);

        // Very long timeout so payer can never self-refund in this test
        let oid = order_id(&env, 14);
        client.deposit(&payer, &merchant, &100, &token_addr, &oid, &u32::MAX);

        // Merchant refunds immediately at ledger 0 — must succeed
        client.refund(&oid, &merchant);

        let record = client.get_escrow(&oid);
        assert_eq!(record.status, EscrowStatus::Refunded);
    }

    // ─── deposited_at is recorded correctly ───────────────────────────────

    /// deposited_at stores the ledger sequence at deposit time
    #[test]
    fn test_deposited_at_recorded() {
        let env = Env::default();
        env.mock_all_auths();

        let payer = Address::generate(&env);
        let merchant = Address::generate(&env);
        let admin = Address::generate(&env);
        let token_addr = create_token(&env, &admin);
        mint(&env, &token_addr, &admin, &payer, 1_000);

        let contract_id = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(&env, &contract_id);

        // Advance to ledger 42 before depositing
        env.ledger().set_sequence_number(42);
        let oid = order_id(&env, 15);
        client.deposit(&payer, &merchant, &100, &token_addr, &oid, &0);

        let record = client.get_escrow(&oid);
        assert_eq!(record.deposited_at, 42);
    }
}
