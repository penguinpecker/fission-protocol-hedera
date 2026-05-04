// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IStandardizedYield} from "./IStandardizedYield.sol";

/// @title  IFissionMarketCommon — shared market surface used by ActionRouter.
/// @notice Both `FissionMarket` (yield-bearing) and `FissionMarketRewards` (reward-bearing,
///         constant-rate) implement this superset. The router parameterizes on this so a
///         single set of trade/liquidity helpers works for both market kinds.
/// @dev    `ptAddr()` / `ytAddr()` are address-typed siblings of the auto-generated
///         `pt()` / `yt()` getters (which return concrete contract types and would clash
///         with this interface). They exist only to satisfy this interface; consumers
///         that want typed access keep using `pt()` / `yt()` directly.
interface IFissionMarketCommon {
    function sy() external view returns (IStandardizedYield);
    function ptAddr() external view returns (address);
    function ytAddr() external view returns (address);

    function split(uint256 amount) external returns (uint256);
    function splitTo(uint256 amount, address ptReceiver, address ytReceiver) external returns (uint256);
    function merge(uint256 amount) external returns (uint256);

    function swapExactPtForSy(uint256 ptIn, uint256 minSyOut, address receiver)
        external
        returns (uint256 syOut);

    function swapExactSyForPt(uint256 syInMax, uint256 ptOut, address receiver)
        external
        returns (uint256 syUsed);

    function addLiquidity(uint256 syIn, uint256 ptIn, uint256 minLpOut, address receiver)
        external
        returns (uint256 lpOut);

    function removeLiquidity(uint256 lpIn, uint256 minSyOut, uint256 minPtOut, address receiver)
        external
        returns (uint256 syOut, uint256 ptOut);

    function redeemAfterExpiry(uint256 ptIn, uint256 ytIn, address receiver)
        external
        returns (uint256 syOut);
}
