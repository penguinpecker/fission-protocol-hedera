// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FissionMarket} from "./FissionMarket.sol";

/// @title  StandardMarketDeployer — bytecode-isolation helper for FissionFactory.
/// @notice Holds the `new FissionMarket(...)` initcode so FissionFactory's own
///         runtime stays under Hedera's 15M-gas-per-tx ContractCreate cap. The
///         factory delegates market creation to this contract via a single
///         external call. The deployed market's `factory` field is set to the
///         factory address passed in `factory_` (NOT this deployer).
contract StandardMarketDeployer {
    function deploy(
        address sy,
        uint256 expiry,
        int256 scalarRoot,
        address admin,
        address treasury,
        uint8 assetDecimals,
        address factory_
    ) external returns (FissionMarket m) {
        m = new FissionMarket(sy, expiry, scalarRoot, admin, treasury, assetDecimals, factory_);
    }
}
