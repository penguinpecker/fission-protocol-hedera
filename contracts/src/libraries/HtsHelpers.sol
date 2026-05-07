// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IHederaTokenService} from "../interfaces/IHederaTokenService.sol";
import {HederaResponseCodes} from "../interfaces/IHederaResponseCodes.sol";

/// @title  HtsHelpers — typed Solidity wrappers around the HTS precompile.
/// @notice Every helper:
///           1. Bounds-checks uint256 inputs before casting to int64 (HTS native width).
///           2. Calls the precompile via the typed interface.
///           3. Reverts with `HtsCallFailed(code)` on any non-SUCCESS response.
///         This pushes ALL "is this safe to mint/transfer" checks into one place.
///
///         The precompile address is `0x167` — a Hedera system contract present on
///         mainnet/testnet/previewnet. NOT simulated by Foundry's revm; unit tests
///         use `vm.etch(0x167, mockBytecode)` to install MockHederaTokenService.
library HtsHelpers {
    address internal constant PRECOMPILE = address(0x167);

    /// @notice HTS amounts are int64. uint256 → int64 cast must not overflow.
    int64 internal constant MAX_AMOUNT = type(int64).max; // 9_223_372_036_854_775_807

    error HtsCallFailed(int32 code);
    error AmountOverflowsInt64(uint256 amount);

    // ───────────────────── safe cast ─────────────────────

    function _toInt64(uint256 amount) private pure returns (int64) {
        if (amount > uint256(uint64(MAX_AMOUNT))) revert AmountOverflowsInt64(amount);
        return int64(uint64(amount));
    }

    function _check(int32 code) private pure {
        if (code != HederaResponseCodes.SUCCESS) revert HtsCallFailed(code);
    }

    // ───────────────────── token creation ─────────────────────

    /// @notice Build a TokenKey entry for a contract-held key. We always pass
    ///         keys this way: the supply / freeze / wipe authority is the contract
    ///         that holds the key, NOT an EOA.
    /// @param  keyType bitmask: 4=FREEZE, 8=WIPE, 16=SUPPLY. OR them for multi-role.
    function makeKey(uint256 keyType, address contractKeyHolder)
        internal
        pure
        returns (IHederaTokenService.TokenKey memory)
    {
        return IHederaTokenService.TokenKey({
            keyType: keyType,
            key: IHederaTokenService.KeyValue({
                inheritAccountKey: false,
                contractId: contractKeyHolder,
                ed25519: bytes(""),
                ECDSA_secp256k1: bytes(""),
                delegatableContractId: address(0)
            })
        });
    }

    /// @notice Wrapper around createFungibleToken that reverts on failure and returns
    ///         the new HTS token address. Caller passes the exact HBAR amount to attach
    ///         to this call (covers the network fee + auto-renew prepay; ~15 HBAR
    ///         mainnet for token + 90d). Critical: when a contract creates multiple
    ///         tokens in one tx (e.g. Market.setTokens for PT/YT/LP), msg.value must
    ///         be split between the calls — sending msg.value to each would drain the
    ///         contract balance on the first call.
    function createFungible(
        IHederaTokenService.HederaToken memory spec,
        int32 decimals,
        uint256 value
    ) internal returns (address htsToken) {
        // initialTotalSupply = 0 always — we mint on demand via mintToken.
        (int32 code, address tokenAddress) =
            IHederaTokenService(PRECOMPILE).createFungibleToken{value: value}(spec, 0, decimals);
        _check(code);
        return tokenAddress;
    }

    // ───────────────────── mint / burn / wipe ─────────────────────

    /// @notice Mint `amount` of `token` to its treasury. Caller must hold the supply
    ///         key (verified by HTS). Returns the new total supply.
    function mintToTreasury(address token, uint256 amount) internal returns (uint256 newTotal) {
        int64 amt = _toInt64(amount);
        (int32 code, int64 newSupply, ) =
            IHederaTokenService(PRECOMPILE).mintToken(token, amt, new bytes[](0));
        _check(code);
        return uint256(uint64(newSupply));
    }

    /// @notice Burn `amount` of `token` from the treasury. Caller must hold the
    ///         supply key. Returns the new total supply.
    function burnFromTreasury(address token, uint256 amount) internal returns (uint256 newTotal) {
        int64 amt = _toInt64(amount);
        (int32 code, int64 newSupply) =
            IHederaTokenService(PRECOMPILE).burnToken(token, amt, new int64[](0));
        _check(code);
        return uint256(uint64(newSupply));
    }

    /// @notice Force-burn `amount` of `token` from a specific account. Caller must
    ///         hold the wipe key. Bypasses freeze state — works on frozen accounts
    ///         (this is why YT uses wipe for merge/redeem instead of burn).
    function wipeFrom(address token, address account, uint256 amount) internal {
        int64 amt = _toInt64(amount);
        int32 code = IHederaTokenService(PRECOMPILE).wipeTokenAccount(token, account, amt);
        _check(code);
    }

    // ───────────────────── transfer ─────────────────────

    /// @notice Transfer `amount` of `token` from `from` to `to`. Both accounts must
    ///         be associated and unfrozen. Caller must equal `from` OR have HTS
    ///         allowance from `from`.
    function transfer(address token, address from, address to, uint256 amount) internal {
        int64 amt = _toInt64(amount);
        int32 code = IHederaTokenService(PRECOMPILE).transferToken(token, from, to, amt);
        _check(code);
    }

    // ───────────────────── association ─────────────────────

    function associate(address account, address token) internal {
        int32 code = IHederaTokenService(PRECOMPILE).associateToken(account, token);
        _check(code);
    }

    /// @notice Same as `associate` but tolerates already-associated state (response
    ///         code 194 = TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT). Use in idempotent
    ///         init paths where the same call may be replayed (e.g. setTokens after
    ///         a partial revert).
    function associateIfNeeded(address account, address token) internal {
        int32 code = IHederaTokenService(PRECOMPILE).associateToken(account, token);
        // 22 = SUCCESS, 194 = TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT (treat as success).
        if (code != HederaResponseCodes.SUCCESS && code != int32(194)) {
            revert HtsCallFailed(code);
        }
    }

    // ───────────────────── freeze / unfreeze ─────────────────────

    function freeze(address token, address account) internal {
        int32 code = IHederaTokenService(PRECOMPILE).freezeToken(token, account);
        _check(code);
    }

    function unfreeze(address token, address account) internal {
        int32 code = IHederaTokenService(PRECOMPILE).unfreezeToken(token, account);
        _check(code);
    }

    // transferThroughFreeze removed 2026-05-07: was dead code (no production
    // caller) and inherently broken — unconditional unfreeze/freeze on both
    // sides would 197-revert on Hedera mainnet whenever either party was not
    // already frozen (e.g. unfrozen treasury). Live YT mint/burn paths
    // (FissionMarket._mintYt / _burnYt) implement the unfreeze→op→refreeze
    // sequence with the necessary `if (wasFrozen)` checks; that's the safe
    // pattern to copy if a similar helper is ever needed again.

    // ───────────────────── allowance ─────────────────────

    function approve(address token, address spender, uint256 amount) internal {
        int32 code = IHederaTokenService(PRECOMPILE).approve(token, spender, amount);
        _check(code);
    }

    /// @notice Pull `amount` of `token` from `from` to `to`, using msg.sender's
    ///         allowance from `from`. The allowance MUST have been granted prior
    ///         via `approve` (either directly to the precompile or through the
    ///         token's ERC-20 facade — both route to the same allowance store).
    function transferFrom(address token, address from, address to, uint256 amount) internal {
        int32 code = IHederaTokenService(PRECOMPILE).transferFrom(token, from, to, amount);
        _check(code);
    }
}
