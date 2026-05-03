// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @notice Subset of Hedera response codes returned by the HTS precompile at 0x167.
///         Full list lives in Hedera's `IHederaResponseCodes.sol` — we re-declare the
///         ones we actually check against to keep the import surface tiny and
///         compile-time safe (no transitive dependency on the Hedera npm package).
library HederaResponseCodes {
    int32 internal constant SUCCESS = 22;
    int32 internal constant TOKEN_NOT_ASSOCIATED_TO_ACCOUNT = 184;
    int32 internal constant ACCOUNT_FROZEN_FOR_TOKEN = 165;
    int32 internal constant TREASURY_MUST_OWN_BURNED_NFT = 270;
    int32 internal constant INVALID_TOKEN_ID = 167;
    int32 internal constant TOKEN_HAS_NO_SUPPLY_KEY = 217;
    int32 internal constant TOKEN_HAS_NO_FREEZE_KEY = 219;
    int32 internal constant TOKEN_HAS_NO_WIPE_KEY = 222;
    int32 internal constant INSUFFICIENT_TOKEN_BALANCE = 178;
    int32 internal constant TOKEN_MAX_SUPPLY_REACHED = 257;
}
