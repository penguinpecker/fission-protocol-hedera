// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IUniswapV3PositionManager} from "../../src/interfaces/IUniswapV3PositionManager.sol";

/// @notice Minimal Uniswap V3 / SaucerSwap V2 NPM mock for SY tests. NOT a real V3
///         simulator — we only model the parts the SY adapter touches:
///           - mint creates a position with caller-controlled (amount0Used, amount1Used,
///             liquidity) so tests can control deposit ratios.
///           - increaseLiquidity adds to an existing position with the same controllable
///             ratio.
///           - decreaseLiquidity reduces position liquidity, returns principal token
///             amounts proportionally to liquidity removed (no price math).
///           - collect transfers tokensOwed to recipient.
///           - feeIn(amount0, amount1) is a test helper to simulate swap-fee accrual
///             on the position by bumping tokensOwed.
contract MockUniswapV3PositionManager is IUniswapV3PositionManager {
    using SafeERC20 for IERC20;

    struct Position {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint128 tokensOwed0;
        uint128 tokensOwed1;
        // Track principal underlying liquidity in raw token units so decreaseLiquidity
        // can return proportional amounts back.
        uint256 reserve0; // total token0 currently backing the position liquidity
        uint256 reserve1; // total token1 currently backing the position liquidity
    }

    /// @notice Knobs the test can set to control how mint/increaseLiquidity convert
    ///         (amount0Desired, amount1Desired) → (amount0Used, amount1Used, liquidity).
    /// @dev    `liquidityRatio_e18` = liquidity per unit of (amount0Used + amount1Used).
    ///         Default = 1e18 (1 unit token = 1 unit liquidity).
    uint256 public liquidityRatioE18 = 1e18;
    /// @notice Fraction of amount0Desired actually used (rest refunded). e18-scaled.
    uint256 public token0UseRatioE18 = 1e18;
    /// @notice Fraction of amount1Desired actually used (rest refunded). e18-scaled.
    uint256 public token1UseRatioE18 = 1e18;

    uint256 public nextTokenId = 1;
    mapping(uint256 => Position) internal _positions;

    function setLiquidityRatio(uint256 e18) external {
        liquidityRatioE18 = e18;
    }

    function setUseRatios(uint256 t0E18, uint256 t1E18) external {
        require(t0E18 <= 1e18 && t1E18 <= 1e18, "use ratio > 1");
        token0UseRatioE18 = t0E18;
        token1UseRatioE18 = t1E18;
    }

    /// @notice Test helper — simulate fees accruing to a position from swaps.
    function feeIn(uint256 tokenId, uint256 amount0, uint256 amount1) external {
        Position storage p = _positions[tokenId];
        require(p.liquidity > 0, "no position");
        if (amount0 > 0) {
            IERC20(p.token0).safeTransferFrom(msg.sender, address(this), amount0);
            p.tokensOwed0 += uint128(amount0);
        }
        if (amount1 > 0) {
            IERC20(p.token1).safeTransferFrom(msg.sender, address(this), amount1);
            p.tokensOwed1 += uint128(amount1);
        }
    }

    function mint(MintParams calldata params)
        external
        payable
        override
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        amount0 = (params.amount0Desired * token0UseRatioE18) / 1e18;
        amount1 = (params.amount1Desired * token1UseRatioE18) / 1e18;
        liquidity = uint128(((amount0 + amount1) * liquidityRatioE18) / 1e18);
        require(liquidity >= params.amount0Min || liquidity >= params.amount1Min || (params.amount0Min == 0 && params.amount1Min == 0), "slip");
        require(amount0 >= params.amount0Min, "slip0");
        require(amount1 >= params.amount1Min, "slip1");

        if (amount0 > 0) IERC20(params.token0).safeTransferFrom(msg.sender, address(this), amount0);
        if (amount1 > 0) IERC20(params.token1).safeTransferFrom(msg.sender, address(this), amount1);

        tokenId = nextTokenId++;
        _positions[tokenId] = Position({
            token0: params.token0,
            token1: params.token1,
            fee: params.fee,
            tickLower: params.tickLower,
            tickUpper: params.tickUpper,
            liquidity: liquidity,
            tokensOwed0: 0,
            tokensOwed1: 0,
            reserve0: amount0,
            reserve1: amount1
        });
    }

    function increaseLiquidity(IncreaseLiquidityParams calldata params)
        external
        payable
        override
        returns (uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        Position storage p = _positions[params.tokenId];
        require(p.liquidity > 0, "no position");

        amount0 = (params.amount0Desired * token0UseRatioE18) / 1e18;
        amount1 = (params.amount1Desired * token1UseRatioE18) / 1e18;
        liquidity = uint128(((amount0 + amount1) * liquidityRatioE18) / 1e18);
        require(amount0 >= params.amount0Min, "slip0");
        require(amount1 >= params.amount1Min, "slip1");

        if (amount0 > 0) IERC20(p.token0).safeTransferFrom(msg.sender, address(this), amount0);
        if (amount1 > 0) IERC20(p.token1).safeTransferFrom(msg.sender, address(this), amount1);

        p.liquidity += liquidity;
        p.reserve0 += amount0;
        p.reserve1 += amount1;
    }

    function decreaseLiquidity(DecreaseLiquidityParams calldata params)
        external
        override
        returns (uint256 amount0, uint256 amount1)
    {
        Position storage p = _positions[params.tokenId];
        require(p.liquidity >= params.liquidity, "insufficient");
        if (params.liquidity == 0) return (0, 0);

        // Pro-rata principal extraction (no price math — preserves the test's setup ratios).
        amount0 = (uint256(p.reserve0) * params.liquidity) / p.liquidity;
        amount1 = (uint256(p.reserve1) * params.liquidity) / p.liquidity;

        require(amount0 >= params.amount0Min, "slip0");
        require(amount1 >= params.amount1Min, "slip1");

        p.reserve0 -= amount0;
        p.reserve1 -= amount1;
        p.liquidity -= params.liquidity;

        // Move principal to tokensOwed; collect() pays it out.
        p.tokensOwed0 += uint128(amount0);
        p.tokensOwed1 += uint128(amount1);
    }

    function collect(CollectParams calldata params)
        external
        override
        returns (uint256 amount0, uint256 amount1)
    {
        Position storage p = _positions[params.tokenId];
        amount0 = p.tokensOwed0 < params.amount0Max ? p.tokensOwed0 : params.amount0Max;
        amount1 = p.tokensOwed1 < params.amount1Max ? p.tokensOwed1 : params.amount1Max;
        if (amount0 > 0) {
            p.tokensOwed0 -= uint128(amount0);
            IERC20(p.token0).safeTransfer(params.recipient, amount0);
        }
        if (amount1 > 0) {
            p.tokensOwed1 -= uint128(amount1);
            IERC20(p.token1).safeTransfer(params.recipient, amount1);
        }
    }

    function positions(uint256 tokenId)
        external
        view
        override
        returns (
            address token0_,
            address token1_,
            uint24 fee,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        )
    {
        Position storage p = _positions[tokenId];
        return (
            p.token0,
            p.token1,
            p.fee,
            p.tickLower,
            p.tickUpper,
            p.liquidity,
            0,
            0,
            p.tokensOwed0,
            p.tokensOwed1
        );
    }
}
