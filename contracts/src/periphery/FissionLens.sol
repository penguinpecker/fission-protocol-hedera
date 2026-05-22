// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {MarketMath} from "../libraries/MarketMath.sol";
import {IStandardizedYield} from "../interfaces/IStandardizedYield.sol";

/// @notice Read-only preview of FissionMarket / FissionMarketRewards swap outputs.
///         Mirrors the exact MarketMath path each `swapExact*` function uses,
///         so the frontend can compute `minSyOut` (or `minPtOut`) without
///         relying on its simple-interest approximation that drifts ~1.8% from
///         the Pendle V2 logit curve on the YT side.
///
///         Currently the dApp ships SellYtForm with a 5% buffer + 5% slippage
///         to absorb the model drift. With this lens, the frontend can quote
///         the exact on-chain output and let users submit at tight slippage
///         (e.g. 0.1%) without InsufficientOutput reverts.
///
/// @dev    Not state-changing, never reverts on bad math (returns 0 instead),
///         safe to call from any context including eth_call from any account.
interface IMarketLens {
    function getMarketState() external view returns (MarketMath.MarketState memory);
    function sy() external view returns (IStandardizedYield);
}

contract FissionLens {
    /// @notice Preview `swapExactYtForSy(ytIn)` output.
    /// @return syOut SY received by the caller (after the implicit YT-burn + PT-burn).
    /// @return syOwed Internal AMM cost (informational; syOut = ytIn - syOwed).
    function previewSwapExactYtForSy(address market, uint256 ytIn)
        external
        view
        returns (uint256 syOut, uint256 syOwed)
    {
        if (ytIn == 0) return (0, 0);
        IMarketLens m = IMarketLens(market);
        MarketMath.MarketState memory ms = m.getMarketState();
        int256 syIndex = int256(m.sy().exchangeRate());
        MarketMath.PreCompute memory pre = MarketMath.getMarketPreCompute(ms, syIndex, block.timestamp);
        (int256 netSy,,,) = MarketMath.executeTradeCore(ms, pre, int256(ytIn), block.timestamp);
        if (netSy >= 0) return (0, 0);
        syOwed = uint256(-netSy);
        if (syOwed >= ytIn) return (0, 0);
        syOut = ytIn - syOwed;
    }

    /// @notice Preview `swapExactPtForSy(ptIn)` output.
    function previewSwapExactPtForSy(address market, uint256 ptIn)
        external
        view
        returns (uint256 syOut)
    {
        if (ptIn == 0) return 0;
        IMarketLens m = IMarketLens(market);
        MarketMath.MarketState memory ms = m.getMarketState();
        int256 syIndex = int256(m.sy().exchangeRate());
        MarketMath.PreCompute memory pre = MarketMath.getMarketPreCompute(ms, syIndex, block.timestamp);
        (int256 netSy,,,) = MarketMath.executeTradeCore(ms, pre, -int256(ptIn), block.timestamp);
        if (netSy <= 0) return 0;
        syOut = uint256(netSy);
    }

    /// @notice Preview `swapExactSyForPt(syIn, ptOut)` cost (ptOut for syIn budget).
    /// @dev    Solves the inverse: caller passes `ptOut`, gets back `syUsed`.
    ///         If `syUsed > syBudget` the frontend should treat the budget as binding.
    function previewSwapExactSyForPt(address market, uint256 ptOut)
        external
        view
        returns (uint256 syUsed)
    {
        if (ptOut == 0) return 0;
        IMarketLens m = IMarketLens(market);
        MarketMath.MarketState memory ms = m.getMarketState();
        int256 syIndex = int256(m.sy().exchangeRate());
        MarketMath.PreCompute memory pre = MarketMath.getMarketPreCompute(ms, syIndex, block.timestamp);
        (int256 netSy,,,) = MarketMath.executeTradeCore(ms, pre, int256(ptOut), block.timestamp);
        if (netSy >= 0) return 0;
        syUsed = uint256(-netSy);
    }
}
