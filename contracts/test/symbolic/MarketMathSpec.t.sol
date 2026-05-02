// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {MarketMath} from "../../src/libraries/MarketMath.sol";

/// @title  MarketMath symbolic specifications
/// @notice Tests are prefixed `prove_` so Halmos picks them up as proof obligations.
///         They also pass under `forge test` as bounded fuzz, giving a fast CI signal
///         even on machines without Halmos installed. Run symbolically with:
///             halmos --contract MarketMathSpec
contract MarketMathSpec is Test {
    function _baseMarket() internal pure returns (MarketMath.MarketState memory m) {
        m.totalSy = 1_000_000e18;
        m.totalPt = 1_000_000e18;
        m.totalLp = 1_000_000e18;
        m.expiry = 90 days;
        m.scalarRoot = 75e18;
        m.lnFeeRateRoot = 0.0003e18;
        m.reserveFeePercent = 80;
        m.lastLnImpliedRate = 0.04879e18;
    }

    /// Spec #1 — round-trip cost is non-negative.
    /// A user who buys then sells the same PT amount cannot extract value from the pool.
    function test_prove_roundTrip_costNonNegative(uint256 size) public pure {
        size = bound(size, 1e18, 50_000e18);

        MarketMath.MarketState memory m = _baseMarket();

        MarketMath.PreCompute memory pre1 = MarketMath.getMarketPreCompute(m, int256(1e18), 0);
        (int256 syPaid,,, int256 newRate) = MarketMath.executeTradeCore(m, pre1, int256(size), 0);

        m.totalPt -= int256(size);
        m.totalSy -= syPaid;
        m.lastLnImpliedRate = newRate;

        MarketMath.PreCompute memory pre2 = MarketMath.getMarketPreCompute(m, int256(1e18), 0);
        (int256 syReceived,,,) = MarketMath.executeTradeCore(m, pre2, -int256(size), 0);

        // syPaid is negative (user pays SY), syReceived is positive (user gets SY back).
        // Round-trip: -syPaid is what the user *paid* in absolute terms; syReceived is what
        // they got back. Cost = paid - received >= 0.
        assertGe(-syPaid, syReceived);
    }

    /// Spec #2 — fee never exceeds the gross trade value.
    function test_prove_fee_boundedByTrade(uint256 size) public pure {
        size = bound(size, 1e18, 100_000e18);
        MarketMath.MarketState memory m = _baseMarket();
        MarketMath.PreCompute memory pre = MarketMath.getMarketPreCompute(m, int256(1e18), 0);

        (int256 net, int256 fee, int256 reserve,) = MarketMath.executeTradeCore(m, pre, int256(size), 0);

        // |fee| ≤ |net|: the fee is the wedge between the no-fee price and the user-paid price.
        int256 absNet = net < 0 ? -net : net;
        assertLe(fee, absNet);
        assertLe(reserve, fee);
        assertGe(reserve, 0);
        assertGe(fee, 0);
    }

    /// Spec #3 — selling PT can never produce negative SY proceeds (no insolvency from sells).
    function test_prove_sellPt_nonNegativeProceeds(uint256 size) public pure {
        size = bound(size, 1e18, 100_000e18);
        MarketMath.MarketState memory m = _baseMarket();
        MarketMath.PreCompute memory pre = MarketMath.getMarketPreCompute(m, int256(1e18), 0);

        (int256 net,,,) = MarketMath.executeTradeCore(m, pre, -int256(size), 0);
        assertGe(net, 0);
    }

    /// Spec #4 — buying PT can never produce a positive SY refund (user always pays).
    function test_prove_buyPt_alwaysCosts(uint256 size) public pure {
        size = bound(size, 1e18, 100_000e18);
        MarketMath.MarketState memory m = _baseMarket();
        MarketMath.PreCompute memory pre = MarketMath.getMarketPreCompute(m, int256(1e18), 0);

        (int256 net,,,) = MarketMath.executeTradeCore(m, pre, int256(size), 0);
        assertLe(net, 0);
    }

    /// Spec #5 — proportional remove returns at most what was deposited.
    function test_prove_removeLiquidity_neverExceedsReserves(uint256 lpFraction) public pure {
        lpFraction = bound(lpFraction, 1, 1e18);
        MarketMath.MarketState memory m = _baseMarket();

        int256 lpToRemove = (m.totalLp * int256(lpFraction)) / 1e18;
        if (lpToRemove == 0) return;

        (int256 sy, int256 pt) = MarketMath.removeLiquidityCore(m, lpToRemove);
        assertLe(sy, m.totalSy);
        assertLe(pt, m.totalPt);
        assertGe(sy, 0);
        assertGe(pt, 0);
    }
}
