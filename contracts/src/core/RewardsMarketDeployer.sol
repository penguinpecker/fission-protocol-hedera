// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FissionMarketRewards} from "./FissionMarketRewards.sol";

/// @title  RewardsMarketDeployer — bytecode-isolation helper for FissionFactory.
/// @notice Holds the `new FissionMarketRewards(...)` initcode so FissionFactory's
///         own runtime stays under Hedera's 15M-gas-per-tx ContractCreate cap.
contract RewardsMarketDeployer {
    function deploy(
        address sy,
        uint256 expiry,
        int256 scalarRoot,
        address admin,
        address treasury,
        uint8 assetDecimals,
        address factory_
    ) external returns (FissionMarketRewards m) {
        m = new FissionMarketRewards(sy, expiry, scalarRoot, admin, treasury, assetDecimals, factory_);
    }
}
