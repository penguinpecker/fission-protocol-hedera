// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IAavePool} from "../../src/interfaces/IAavePool.sol";

/// @notice Bonzo / Aave V3 pool mock. Exposes settable per-reserve normalised income
///         in ray (1e27) precision for tests.
contract MockAavePool is IAavePool {
    mapping(address => uint256) public indexFor;

    function setIndex(address reserve, uint256 ray) external {
        indexFor[reserve] = ray;
    }

    function getReserveNormalizedIncome(address reserve) external view override returns (uint256) {
        return indexFor[reserve];
    }
}
