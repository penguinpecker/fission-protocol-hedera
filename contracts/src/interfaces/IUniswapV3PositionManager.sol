// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title  IUniswapV3PositionManager — minimal interface for SaucerSwap V2 NPM.
/// @notice SaucerSwap V2 is a Uniswap V3 fork; the NonFungiblePositionManager ABI
///         matches Uniswap's. We only declare the functions our SY actually calls.
interface IUniswapV3PositionManager {
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    struct IncreaseLiquidityParams {
        uint256 tokenId;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    struct DecreaseLiquidityParams {
        uint256 tokenId;
        uint128 liquidity;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);

    function increaseLiquidity(IncreaseLiquidityParams calldata params)
        external
        payable
        returns (uint128 liquidity, uint256 amount0, uint256 amount1);

    function decreaseLiquidity(DecreaseLiquidityParams calldata params)
        external
        returns (uint256 amount0, uint256 amount1);

    function collect(CollectParams calldata params)
        external
        returns (uint256 amount0, uint256 amount1);

    /// @notice Returns the position's full state.
    /// @dev    SaucerSwap V2 (Hedera 0.0.4053945) deviates from canonical Uniswap V3:
    ///         it drops the leading `nonce (uint96)` and `operator (address)` fields,
    ///         returning 10 fields starting at `token0`. Verified live 2026-05-06 by
    ///         decoding `cast call 0x...3DDbb9 "positions(uint256)" 74444` — response
    ///         length 320 bytes (10 × 32). Production code does NOT call this function,
    ///         so the interface mismatch had no runtime impact, but a fork test using
    ///         the canonical 12-field shape silently swallowed the decode error and
    ///         appeared to pass.
    function positions(uint256 tokenId)
        external
        view
        returns (
            address token0,
            address token1,
            uint24 fee,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        );
}
