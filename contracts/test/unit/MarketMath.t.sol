// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {MarketMath} from "../../src/libraries/MarketMath.sol";
import {PMath} from "../../src/libraries/PMath.sol";

/// @notice Unit + fuzz tests for the Pendle-faithful AMM math library.
contract MarketMathTest is Test {
    using PMath for int256;

    // realistic market shape: 1M SY, 1M PT, 90-day market, 5% implied yield
    function _baseMarket() internal pure returns (MarketMath.MarketState memory m) {
        m.totalSy = 1_000_000e18;
        m.totalPt = 1_000_000e18;
        m.totalLp = 1_000_000e18;
        m.expiry = 90 days; // we'll set `now_` = 0
        m.scalarRoot = 75e18; // typical Pendle scalar
        m.lnFeeRateRoot = 0.0003e18; // ~0.03 % fee
        m.reserveFeePercent = 80; // 80 % of fees to reserve (Pendle default)
        // start at 5 % implied → lnImpliedRate = ln(1.05) ≈ 0.04879
        m.lastLnImpliedRate = 0.04879e18;
    }

    // ─────── pre-compute consistency ───────

    function test_preCompute_basicShape() public pure {
        MarketMath.MarketState memory m = _baseMarket();
        MarketMath.PreCompute memory pre = MarketMath.getMarketPreCompute(m, int256(1e18), 0);

        // rateScalar = scalarRoot · YEAR / ttx ; 75e18 · 365.25 / 90 ≈ 304e18
        // (we use 365 days flat per IMPLIED_RATE_TIME, so 75 * 365/90 ≈ 304.17)
        assertGt(pre.rateScalar, 300e18);
        assertLt(pre.rateScalar, 310e18);

        // totalAsset == totalSy when syIndex == 1e18
        assertEq(pre.totalAsset, m.totalSy);

        // feeRate > 1e18 because lnFeeRateRoot > 0
        assertGt(pre.feeRate, int256(1e18));

        // rateAnchor must produce an exchangeRate ≥ 1 at current proportion
        // implicit: getMarketPreCompute would have reverted if not.
        assertGt(pre.rateAnchor, 0);
    }

    function test_preCompute_revertsAfterExpiry() public {
        MarketMath.MarketState memory m = _baseMarket();
        vm.expectRevert(MarketMath.MarketExpired.selector);
        this.preComputeExt(m, int256(1e18), m.expiry);
    }

    function preComputeExt(MarketMath.MarketState memory m, int256 syIndex, uint256 now_)
        external
        pure
        returns (MarketMath.PreCompute memory)
    {
        return MarketMath.getMarketPreCompute(m, syIndex, now_);
    }

    // ─────── trade direction sanity ───────

    function test_buyPt_paysSy() public pure {
        MarketMath.MarketState memory m = _baseMarket();
        int256 syIndex = 1e18;
        MarketMath.PreCompute memory pre = MarketMath.getMarketPreCompute(m, syIndex, 0);

        // user buys 1000 PT
        int256 ptIn = 1000e18;
        (int256 netSy, int256 fee, int256 reserve, int256 newRate) =
            MarketMath.executeTradeCore(m, pre, ptIn, 0);

        // buying PT → user pays SY → netSyToAccount is negative
        assertLt(netSy, 0);
        // fee always positive
        assertGt(fee, 0);
        // reserve ≤ fee
        assertLe(reserve, fee);
        // Buying PT shrinks PT supply in the pool ⇒ PT trades at less of a discount
        // ⇒ implied yield (lnImpliedRate) goes DOWN.
        assertLt(newRate, m.lastLnImpliedRate);
    }

    function test_sellPt_receivesSy() public pure {
        MarketMath.MarketState memory m = _baseMarket();
        int256 syIndex = 1e18;
        MarketMath.PreCompute memory pre = MarketMath.getMarketPreCompute(m, syIndex, 0);

        // user sells 1000 PT
        int256 ptOut = -1000e18;
        (int256 netSy, int256 fee, int256 reserve, int256 newRate) =
            MarketMath.executeTradeCore(m, pre, ptOut, 0);

        // selling PT → user receives SY → netSyToAccount is positive
        assertGt(netSy, 0);
        assertGt(fee, 0);
        assertLe(reserve, fee);
        // Selling PT inflates PT supply in the pool ⇒ PT trades at a steeper discount
        // ⇒ implied yield (lnImpliedRate) goes UP.
        assertGt(newRate, m.lastLnImpliedRate);
    }

    // ─────── core invariant: trade is monotone in size ───────
    /// Buying more PT must cost more SY.
    function testFuzz_buyPt_monotoneCost(uint256 ptIn1, uint256 ptIn2) public pure {
        ptIn1 = bound(ptIn1, 1e18, 100_000e18);
        ptIn2 = bound(ptIn2, ptIn1 + 1e18, 200_000e18);

        MarketMath.MarketState memory m = _baseMarket();
        MarketMath.PreCompute memory pre = MarketMath.getMarketPreCompute(m, int256(1e18), 0);

        (int256 netSy1,,,) = MarketMath.executeTradeCore(m, pre, int256(ptIn1), 0);
        (int256 netSy2,,,) = MarketMath.executeTradeCore(m, pre, int256(ptIn2), 0);

        // both negative (paying); larger trade pays more (more negative)
        assertLt(netSy2, netSy1);
    }

    /// Selling more PT must yield more SY.
    function testFuzz_sellPt_monotoneProceeds(uint256 ptOut1, uint256 ptOut2) public pure {
        ptOut1 = bound(ptOut1, 1e18, 100_000e18);
        ptOut2 = bound(ptOut2, ptOut1 + 1e18, 200_000e18);

        MarketMath.MarketState memory m = _baseMarket();
        MarketMath.PreCompute memory pre = MarketMath.getMarketPreCompute(m, int256(1e18), 0);

        (int256 netSy1,,,) = MarketMath.executeTradeCore(m, pre, -int256(ptOut1), 0);
        (int256 netSy2,,,) = MarketMath.executeTradeCore(m, pre, -int256(ptOut2), 0);

        // both positive (receiving); larger trade receives more
        assertGt(netSy2, netSy1);
    }

    // ─────── PT saturation guard ───────

    function test_buyPt_revertsAtSaturation() public {
        MarketMath.MarketState memory m = _baseMarket();
        MarketMath.PreCompute memory pre = MarketMath.getMarketPreCompute(m, int256(1e18), 0);

        // buy 99 % of PT — should hit MAX_MARKET_PROPORTION
        int256 huge = (m.totalPt * 99) / 100;
        vm.expectRevert();
        this.executeTradeExt(m, pre, huge, 0);
    }

    function executeTradeExt(
        MarketMath.MarketState memory m,
        MarketMath.PreCompute memory pre,
        int256 netPt,
        uint256 now_
    ) external pure returns (int256, int256, int256, int256) {
        return MarketMath.executeTradeCore(m, pre, netPt, now_);
    }

    // ─────── lastLnImpliedRate persistence semantics ───────
    /// After a trade, applying the *same* trade size in the opposite direction at the
    /// new lastLnImpliedRate should bring us close to where we started.
    function test_tradeRoundTrip_approximatelyReverses() public pure {
        MarketMath.MarketState memory m = _baseMarket();
        MarketMath.PreCompute memory pre = MarketMath.getMarketPreCompute(m, int256(1e18), 0);

        int256 size = 1_000e18;
        (int256 netSyA,,, int256 newRate) = MarketMath.executeTradeCore(m, pre, size, 0);

        // apply to market state
        m.totalPt -= size;
        m.totalSy -= netSyA; // netSyA negative when buying ⇒ totalSy increases
        m.lastLnImpliedRate = newRate;

        MarketMath.PreCompute memory pre2 = MarketMath.getMarketPreCompute(m, int256(1e18), 0);
        (int256 netSyB,,,) = MarketMath.executeTradeCore(m, pre2, -size, 0);

        // round-trip cost in SY is the bid-ask: > 0 (we lost a bit to fees).
        // Sum (paid + received) is negative: SY net out of user's pocket.
        int256 roundTripCost = -netSyA - netSyB;
        assertGt(roundTripCost, 0);
        // Should be on the order of 2× the fee on the trade (one each direction)
        assertLt(roundTripCost, 100e18); // sanity ceiling
    }

    // ─────── liquidity ───────

    function test_addLiquidity_first() public pure {
        MarketMath.MarketState memory empty;
        empty.expiry = 90 days;
        empty.scalarRoot = 75e18;

        (int256 lp, int256 sy, int256 pt,) = MarketMath.addLiquidityCore(empty, 1_000e18, 1_000e18);
        assertGt(lp, 0);
        assertEq(sy, 1_000e18);
        assertEq(pt, 1_000e18);
    }

    function test_removeLiquidity_proportional() public pure {
        MarketMath.MarketState memory m = _baseMarket();
        int256 lpToRemove = m.totalLp / 10;
        (int256 sy, int256 pt) = MarketMath.removeLiquidityCore(m, lpToRemove);
        // proportional: 10 % of each reserve
        assertEq(sy, m.totalSy / 10);
        assertEq(pt, m.totalPt / 10);
    }
}
