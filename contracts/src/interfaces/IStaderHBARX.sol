// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title  IStaderHBARX — minimal interface to Stader's HBARX exchange-rate oracle.
/// @notice Stader Labs operates HBARX as a liquid-staking derivative for HBAR.
///         The contract publishes the on-chain exchange rate as `getExchangeRate()`,
///         a 1e18-scaled HBAR-per-HBARX figure that grows as staking rewards accrue.
///         Source: https://www.staderlabs.com/docs-v1/hedera/HBARX/
/// @dev    Function selector + return shape verified against the live Stader contract.
///         The Stader contract address is supplied at SY-adapter construction; this
///         interface intentionally exposes only what we read.
interface IStaderHBARX {
    /// @notice Current HBAR-per-HBARX exchange rate (1e18-scaled).
    function getExchangeRate() external view returns (uint256);
}
