// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title  IFissionMarket — minimal callback surface used by the YieldToken.
/// @notice The YT calls `onYTBalanceChange` BEFORE every balance update so the Market
///         can settle accrued yield against the previous balances of `from` and `to`.
///         Once accrual is settled, the actual mint / transfer / burn proceeds.
/// @dev    `from == address(0)` for mints; `to == address(0)` for burns. The Market
///         skips address(0) inside `_accrueUser`.
interface IFissionMarket {
    function onYTBalanceChange(address from, address to) external;
}
