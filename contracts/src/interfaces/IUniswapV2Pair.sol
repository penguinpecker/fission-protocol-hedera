// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title  IUniswapV2Pair — minimal interface to a SaucerSwap V1 pool (Uniswap V2 fork).
/// @notice SaucerSwap V1 LP tokens are HTS-fungible ERC-20-facade tokens. The pool
///         contract IS the LP token, exposing standard ERC-20 alongside the V2 reserve
///         readouts. We only read here; never write to the pool from a SY adapter.
interface IUniswapV2Pair {
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function totalSupply() external view returns (uint256);
    function token0() external view returns (address);
    function token1() external view returns (address);
}
