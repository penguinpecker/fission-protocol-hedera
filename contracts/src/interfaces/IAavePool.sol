// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title  IAavePool — minimal read interface to an Aave V3 fork (Bonzo).
/// @notice We only consume `getReserveNormalizedIncome(asset)`, the cumulative
///         interest index for a reserve, returned in 1e27 (ray) precision.
interface IAavePool {
    function getReserveNormalizedIncome(address asset) external view returns (uint256);
}
