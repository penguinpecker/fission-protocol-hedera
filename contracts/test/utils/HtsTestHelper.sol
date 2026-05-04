// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Vm} from "forge-std/Vm.sol";
import {MockHederaTokenService} from "../mocks/MockHederaTokenService.sol";

/// @notice Installs the in-memory HTS simulator at the canonical precompile slot
///         (0x167). Call `installHtsPrecompile()` from any test setUp that
///         constructs a FissionMarket or FissionMarketRewards — the markets
///         create their HTS-native PT during `setTokens`, which calls
///         `0x167.createFungibleToken`. Without this etch, those calls revert.
library HtsTestHelper {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address internal constant PRECOMPILE = address(0x167);

    function installHtsPrecompile() internal {
        VM.etch(PRECOMPILE, type(MockHederaTokenService).runtimeCode);
    }
}
