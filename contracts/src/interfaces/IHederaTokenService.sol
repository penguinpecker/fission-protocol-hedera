// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title  IHederaTokenService — minimal subset of the Hedera HTS precompile at `0x167`.
/// @notice The full canonical interface ships with the `@hashgraph/smart-contracts` npm
///         package; we redeclare only the function selectors and structs we actually
///         use. Everything that doesn't fit our v1 protocol (NFTs, royalty fees, KYC,
///         pause keys, custom fees beyond what we explicitly set, expiry renewal,
///         delete, etc.) is intentionally omitted to keep the audit surface tight.
///
///         All amounts are int64 because the HTS precompile uses int64 internally
///         (Hedera consensus stores supply as a signed 63-bit integer per HIP-15).
///         Solidity wrappers must bounds-check before casting from uint256.
///
///         Function selectors match the official IHederaTokenService.sol byte-for-byte.
///         Reference: https://github.com/hashgraph/hedera-smart-contracts/blob/main/contracts/system-contracts/hedera-token-service/IHederaTokenService.sol
interface IHederaTokenService {
    /// @notice Hedera Token immutable + mutable spec passed to createFungibleToken.
    struct HederaToken {
        string name;
        string symbol;
        address treasury;        // Account that receives all newly-minted supply
        string memo;
        bool tokenSupplyType;    // false = INFINITE; true = FINITE
        int64 maxSupply;         // ignored when tokenSupplyType == false
        bool freezeDefault;      // if true, every account is frozen on association
        TokenKey[] tokenKeys;    // see KeyType bitmask below
        Expiry expiry;           // auto-renew + expiration
    }

    /// @notice Auto-renewal account + period. Set autoRenewAccount = treasury, period
    ///         = 7776000 (90 days) as the conservative default. Hedera will renew
    ///         automatically as long as autoRenewAccount has the HBAR to pay.
    struct Expiry {
        int64 second;            // 0 = use default
        address autoRenewAccount;
        int64 autoRenewPeriod;
    }

    /// @notice Bitmask values from HTS spec for keyType. OR multiple if one key serves
    ///         several roles (we do this for YT — Market is supply + freeze + wipe).
    /// @dev Keys we use: ADMIN=1 (we never set this — immutable), KYC=2, FREEZE=4,
    ///      WIPE=8, SUPPLY=16, FEE_SCHEDULE=32, PAUSE=64. We only ever set 4, 8, 16.
    struct TokenKey {
        uint256 keyType;         // bitmask
        KeyValue key;
    }

    /// @notice Exactly one of these fields is non-default. For our use:
    ///         contractId = address(this) when the supply contract is the key holder.
    struct KeyValue {
        bool inheritAccountKey;
        address contractId;      // ← we use this
        bytes ed25519;
        bytes ECDSA_secp256k1;
        address delegatableContractId;
    }

    /// @notice Create a fungible HTS token. Returns the token's EVM address (long-zero
    ///         alias of the Hedera token ID). Caller pays a network fee in HBAR
    ///         (~1 HBAR mainnet); that HBAR must be attached as msg.value.
    /// @param  token     immutable + mutable spec.
    /// @param  initialTotalSupply minted to the treasury at create time. We always
    ///                            pass 0 — supply is added later via mintToken.
    /// @param  decimals  immutable. Match the underlying asset (per ERC-5115 for SY).
    function createFungibleToken(
        HederaToken memory token,
        int64 initialTotalSupply,
        int32 decimals
    ) external payable returns (int32 responseCode, address tokenAddress);

    /// @notice Mint new units of a fungible token. Newly minted supply lands in the
    ///         token's treasury. To deliver to a non-treasury account, follow with
    ///         transferToken. `newTotalSupply` is the post-mint supply (capped at
    ///         maxSupply if FINITE). `serialNumbers` is empty for fungible mints.
    function mintToken(
        address token,
        int64 amount,
        bytes[] memory metadata        // ignored for fungible; pass empty
    ) external returns (int32 responseCode, int64 newTotalSupply, int64[] memory serialNumbers);

    /// @notice Burn from the TREASURY account only. To burn from a non-treasury
    ///         holder, use wipeTokenAccount instead (requires wipeKey).
    function burnToken(
        address token,
        int64 amount,
        int64[] memory serialNumbers   // ignored for fungible
    ) external returns (int32 responseCode, int64 newTotalSupply);

    /// @notice Force-burn from any holder. Requires wipeKey to be set on the token
    ///         and held by msg.sender. Bypasses freeze state — works on frozen
    ///         accounts. We use this for YT burn during merge / redeemAfterExpiry
    ///         because YT is permanently frozen.
    function wipeTokenAccount(
        address token,
        address account,
        int64 amount
    ) external returns (int32 responseCode);

    /// @notice Atomic A→B token transfer. Both accounts must be associated; both
    ///         must be unfrozen (or token has no freezeKey). Caller must have
    ///         allowance from `sender` (or be `sender`).
    function transferToken(
        address token,
        address sender,
        address recipient,
        int64 amount
    ) external returns (int32 responseCode);

    /// @notice Associate a token with an account, allowing the account to hold
    ///         non-zero balance. Required pre-receive for accounts whose
    ///         maxAutomaticTokenAssociations is 0 (legacy default). HIP-904 made
    ///         contracts auto-associate by default in Hedera Services 0.46+.
    function associateToken(
        address account,
        address token
    ) external returns (int32 responseCode);

    /// @notice Freeze an account for a token. Requires freezeKey. Frozen accounts
    ///         cannot transfer the token via any path except wipe.
    function freezeToken(
        address token,
        address account
    ) external returns (int32 responseCode);

    /// @notice Inverse of freezeToken.
    function unfreezeToken(
        address token,
        address account
    ) external returns (int32 responseCode);

    // ───────────────────── allowance flow ─────────────────────

    /// @notice Set HTS allowance: `spender` can transfer up to `amount` of `token`
    ///         on behalf of msg.sender. Routes through the precompile (the same
    ///         path that `IERC20(htsToken).approve(spender, amount)` takes via the
    ///         token's ERC-20 facade).
    function approve(
        address token,
        address spender,
        uint256 amount
    ) external returns (int32 responseCode);

    /// @notice Read HTS allowance.
    function allowance(
        address token,
        address owner,
        address spender
    ) external view returns (int32 responseCode, uint256 allowance);

    /// @notice Transfer `amount` of `token` from `from` to `to`, consuming
    ///         allowance(from → msg.sender). Distinct from `transferToken` which
    ///         requires msg.sender == from (or has allowance).
    function transferFrom(
        address token,
        address from,
        address to,
        uint256 amount
    ) external returns (int32 responseCode);
}
