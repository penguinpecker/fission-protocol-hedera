// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {MarketMath} from "../../src/libraries/MarketMath.sol";
import {PMath} from "../../src/libraries/PMath.sol";

/// @title  MarketMathMutationKills — targeted assertions to kill specific Gambit
///         survivors from the 2026-05-06 partial mutation run.
/// @notice Each test below is named after the specific mutation it kills. The
///         assertions are tighter than the existing fuzz tests because survivors
///         pass the broad fuzz invariants but break specific exact-value math.
///         Triage of the 13 MarketMath survivors lives in
///         audits/mutation/mutation-results.md.
contract MarketMathMutationKillsTest is Test {
    int256 internal constant IONE = 1e18;
    uint256 internal constant ONE = 1e18;

    // Stable market fixture — same shape as MarketMathTest but with values
    // chosen so derived quantities have exact, hand-computable expectations.
    function _market() internal pure returns (MarketMath.MarketState memory m) {
        m.totalSy = 1_000_000e18;
        m.totalPt = 1_000_000e18;
        m.totalLp = 1_000_000e18;
        m.expiry = 90 days;
        m.scalarRoot = 75e18;
        m.lnFeeRateRoot = 0.0003e18;
        m.reserveFeePercent = 80;
        m.lastLnImpliedRate = 0.04879e18; // ≈ ln(1.05)
    }

    // ─────── kills #21, #22, #24, #26 (fee math) ───────

    /// @notice Kills #21 (`netSyFee = 1`), #22 (`* → +`), #24 (`/ → %`),
    ///         #26 (swap-args of `/`). These mutations all break the fee /
    ///         reserve-fee computation; assertions below pin exact relationships.
    function test_kill_feeMath_buyPT() public pure {
        MarketMath.MarketState memory m = _market();
        MarketMath.PreCompute memory pre = MarketMath.getMarketPreCompute(m, IONE, 0);

        // Buy 1000 PT — same trade size as the existing happy-path test.
        int256 netPt = 1000e18;
        (int256 netSy, int256 netSyFee, int256 netSyToReserve, ) =
            MarketMath.executeTradeCore(m, pre, netPt, 0);

        // Direction sanity: buying PT means user pays SY (negative).
        assertLt(netSy, 0, "buying PT should pay SY");

        // Fee must be > 1e9 wei (well above the 1-wei collapse from #21).
        // 1000 PT * 0.0003 fee_root ≈ ~0.3 SY fee, which is 3e17. Pin > 1e10.
        assertGt(netSyFee, int256(1e10), "kill #21: fee collapsed to ~1");
        assertLt(netSyFee, _abs(netSy) / 10, "fee shouldn't exceed 10% of trade size");

        // Reserve fee = netSyFee * reserveFeePercent / 100 — exact relation.
        assertEq(
            netSyToReserve,
            (netSyFee * int256(m.reserveFeePercent)) / 100,
            "kill #24/#26: reserve fee != netSyFee * pct / 100"
        );

        // Reserve fee must be non-zero (catches #21 collapsing to 1).
        assertGt(netSyToReserve, 0, "reserve fee must be positive");

        // Reserve fee must be ≤ total fee (kills #26's swap-args which inverts).
        assertLe(netSyToReserve, netSyFee, "reserve fee can't exceed total fee");
    }

    /// @notice Reverse-direction trade: also exercises `_abs` on the fee delta
    ///         (kills #43, #44 — _abs sign mutations).
    function test_kill_feeMath_sellPT_andAbs() public pure {
        MarketMath.MarketState memory m = _market();
        MarketMath.PreCompute memory pre = MarketMath.getMarketPreCompute(m, IONE, 0);

        // Sell 1000 PT.
        int256 netPt = -1000e18;
        (int256 netSy, int256 netSyFee, int256 netSyToReserve, ) =
            MarketMath.executeTradeCore(m, pre, netPt, 0);

        assertGt(netSy, 0, "selling PT should receive SY");

        // Fee always positive — _abs(preFeeAsset - postFeeAsset) is the only
        // way to compute |delta| since the operands have opposite signs in
        // the buy vs sell cases. Mutating `-x → ++x` or `--x` would corrupt
        // _abs(negative) and produce a wrong fee here.
        assertGt(netSyFee, int256(1e10), "kill #43/#44: _abs sign mutation breaks sell-side fee");
        assertEq(
            netSyToReserve,
            (netSyFee * int256(m.reserveFeePercent)) / 100,
            "kill #24/#26: reserve fee math wrong on sell side"
        );
    }

    // ─────── kills #33, #34, #35 (addLiquidityCore first-add: syUsed) ───────

    /// @notice First-add to an empty pool: syUsed MUST equal syDesired exactly
    ///         (no slippage, no proportional adjustment). Mutating to 0 or 1
    ///         (#33-#35) breaks the LP minted = sqrt(syDesired*ptDesired)
    ///         relationship downstream.
    function test_kill_addLiquidity_firstAdd_usedEqualsDesired() public pure {
        MarketMath.MarketState memory empty;
        empty.totalSy = 0;
        empty.totalPt = 0;
        empty.totalLp = 0;

        int256 syDesired = 1_000e18;
        int256 ptDesired = 1_500e18;
        (int256 lpOut, int256 syUsed, int256 ptUsed, ) =
            MarketMath.addLiquidityCore(empty, syDesired, ptDesired);

        assertEq(syUsed, syDesired, "kill #33-#35: first-add syUsed must == syDesired");
        assertEq(ptUsed, ptDesired, "first-add ptUsed must == ptDesired");

        // LP = sqrt(sy*pt) - MIN_LIQUIDITY = sqrt(1500e36) - 1000.
        // sqrt(1500e36) ≈ 1.2247e21 = 1224744871391589049098.
        uint256 expectedSqrt = PMath.sqrt(uint256(syDesired) * uint256(ptDesired));
        assertEq(uint256(lpOut), expectedSqrt - MarketMath.MINIMUM_LIQUIDITY, "lp out math");
    }

    // ─────── kills #36, #37 (addLiquidityCore subsequent: ptUsed via lpFromSy) ───────

    /// @notice Subsequent add where SY is the binding constraint
    ///         (lpFromSy < lpFromPt): ptUsed = lpFromSy * totalPt / totalLp.
    ///         Mutating `/ → -` (#36) or `* → /` (#37) breaks this exact relation.
    function test_kill_addLiquidity_subsequent_ptUsedFormula() public pure {
        MarketMath.MarketState memory m = _market();

        // Provide proportionally less SY than PT — lpFromSy will be the min.
        int256 syDesired = 100e18; // 0.0001 of pool
        int256 ptDesired = 200e18; // 0.0002 of pool
        (int256 lpOut, int256 syUsed, int256 ptUsed, ) =
            MarketMath.addLiquidityCore(m, syDesired, ptDesired);

        // syUsed = syDesired (we used all the SY).
        assertEq(syUsed, syDesired);

        // lpFromSy = syDesired * totalLp / totalSy = 100e18 * 1e24 / 1e24 = 100e18
        int256 expectedLp = (syDesired * m.totalLp) / m.totalSy;
        assertEq(lpOut, expectedLp);

        // ptUsed = lpFromSy * totalPt / totalLp = 100e18 * 1e24 / 1e24 = 100e18
        int256 expectedPtUsed = (lpOut * m.totalPt) / m.totalLp;
        assertEq(ptUsed, expectedPtUsed, "kill #36/#37: ptUsed formula must hold");
    }

    // ─────── kills #45 (ttx subtraction → exponentiation) ───────

    /// @notice The mutation `expiry - now → expiry ** now` would either revert
    ///         (overflow) or produce wildly wrong rateScalar. Pin rateScalar
    ///         to a tight expected band so any deviation fails.
    function test_kill_ttxSubtraction_rateScalarPinned() public pure {
        MarketMath.MarketState memory m = _market();
        // expiry = 90d, now = 0 → ttx = 90d. rateScalar = 75e18 * 365d / 90d ≈ 304e18.
        MarketMath.PreCompute memory pre = MarketMath.getMarketPreCompute(m, IONE, 0);

        // Tight band: 304.0e18 to 304.5e18 (true value 304.166e18).
        assertGt(pre.rateScalar, 304e18, "kill #45: rateScalar low bound");
        assertLt(pre.rateScalar, 304_500_000_000_000_000_000, "rateScalar upper bound");

        // Sanity at a different now_ — ttx = 60d → rateScalar = 75e18 * 365 / 60 ≈ 456e18.
        MarketMath.PreCompute memory pre2 = MarketMath.getMarketPreCompute(m, IONE, 30 days);
        assertGt(pre2.rateScalar, 455e18);
        assertLt(pre2.rateScalar, 457e18);
    }

    // ─────── kills #48 (initial-rate floor in setInitialLnImpliedRate) ───────

    /// @notice Mutating `if (exchangeRate < IONE) revert` to `if (false) revert`
    ///         removes the rate-below-1 guard in setInitialLnImpliedRate.
    ///         Construct an init scenario where the seeded proportion would
    ///         produce exchangeRate < IONE and assert revert.
    function test_kill_initialRateFloor() public {
        MarketMath.MarketState memory m;
        m.totalSy = 1_000_000e18;
        // SY-heavy pool: PT scarce → proportion tiny → logProportion very
        // negative → exchange rate below IONE even with positive anchor.
        m.totalPt = 100e18;
        m.expiry = 90 days;
        m.scalarRoot = 75e18;

        int256 initialAnchor = 0.5e18; // well below the 1e18 floor.

        // Library calls happen via JUMP, not external CALL — vm.expectRevert
        // only intercepts external calls. Wrap in setInitialLnImpliedRateExt.
        vm.expectRevert(MarketMath.MarketExchangeRateBelowOne.selector);
        this.setInitialLnImpliedRateExt(m, IONE, initialAnchor, 0);
    }

    function setInitialLnImpliedRateExt(
        MarketMath.MarketState memory m,
        int256 syIndex,
        int256 initialAnchor,
        uint256 now_
    ) external pure returns (int256) {
        return MarketMath.setInitialLnImpliedRate(m, syIndex, initialAnchor, now_);
    }

    // ─────── helper ───────

    function _abs(int256 x) internal pure returns (int256) {
        return x < 0 ? -x : x;
    }
}
