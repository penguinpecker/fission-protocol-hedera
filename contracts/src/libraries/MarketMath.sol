// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {PMath} from "./PMath.sol";

/// @title MarketMath — Pendle V2 logit-curve AMM math, faithful port.
/// @author Fission Protocol contributors. Math design © Pendle Labs;
///         see https://github.com/pendle-finance/pendle-core-v2-public —
///         in particular `contracts/core/Market/MarketMathCore.sol`.
/// @notice The pool persists `lastLnImpliedRate` between trades. On each swap
///         a `rateAnchor` is recomputed from `(lastLnImpliedRate, current
///         proportion)`, so the curve **anchors** to the most recent trade and
///         does not drift purely from time decay between blocks. The new
///         post-trade implied rate is written back to `lastLnImpliedRate`.
/// @dev    Sign convention follows Pendle: positive `netPtToAccount` means the
///         user is *buying* PT (paying SY); negative means *selling* PT
///         (receiving SY). All amounts are denominated in 1e18-scaled units.
///         Asset-side values use the SY's `exchangeRate` as the conversion factor.
library MarketMath {
    using PMath for int256;
    using PMath for uint256;

    // ───────────────────── constants ─────────────────────

    int256 internal constant IONE = 1e18;
    uint256 internal constant ONE = 1e18;

    /// @notice Reference timeframe for implied-rate scaling. Pendle uses 365 days exactly.
    uint256 internal constant IMPLIED_RATE_TIME = 365 days;

    /// @notice PT proportion ceiling — above this the curve becomes unstable.
    int256 internal constant MAX_MARKET_PROPORTION = 0.96e18;

    /// @notice Minimum LP burned to address(1) at pool init (donation-attack defence).
    uint256 internal constant MINIMUM_LIQUIDITY = 1_000;

    /// @notice Maximum allowed `lnFeeRateRoot` ≈ ln(1.05) — caps governance fee at ~5 % per
    ///         year-equivalent. Stops a malicious / mistaken governance from setting fees that
    ///         move price by orders of magnitude.
    int256 internal constant MAX_LN_FEE_RATE_ROOT = 0.05e18;

    // ───────────────────── errors ─────────────────────

    error MarketExpired();
    error MarketProportionMustNotEqualOne();
    error MarketProportionTooHigh();
    error MarketRateScalarBelowZero();
    error MarketExchangeRateBelowOne();
    error InsufficientLiquidity();
    error InvalidLnFeeRateRoot();

    // ───────────────────── types ─────────────────────

    /// @notice Persisted per-market AMM state.
    struct MarketState {
        int256  totalPt;              // PT held by the market
        int256  totalSy;              // SY held by the market
        int256  totalLp;              // LP token total supply
        uint256 expiry;               // immutable (set at market creation)
        int256  scalarRoot;           // immutable (set at market creation)
        int256  lnFeeRateRoot;        // governance, capped by MAX_LN_FEE_RATE_ROOT
        uint256 reserveFeePercent;    // 0..100, % of fees diverted to treasury
        int256  lastLnImpliedRate;    // ← persistent anchor; updated after every trade
    }

    /// @notice Cached values derived from MarketState + SY index at the start of a trade.
    struct PreCompute {
        int256 rateScalar;
        int256 totalAsset;            // = totalSy * syIndex / 1e18
        int256 rateAnchor;
        int256 feeRate;               // multiplicative fee on the exchange rate
    }

    // ───────────────────── pre-trade compute ─────────────────────

    /// @notice Compute `(rateScalar, totalAsset, rateAnchor, feeRate)` for the current state.
    /// @param market  current persisted market state
    /// @param syIndex SY exchange rate (1e18-scaled), supplied by caller
    /// @param now_    current block timestamp
    function getMarketPreCompute(MarketState memory market, int256 syIndex, uint256 now_)
        internal
        pure
        returns (PreCompute memory pre)
    {
        if (now_ >= market.expiry) revert MarketExpired();
        uint256 ttx = market.expiry - now_;

        pre.rateScalar = _getRateScalar(market.scalarRoot, ttx);
        pre.totalAsset = (market.totalSy * syIndex) / IONE;
        pre.rateAnchor = _getRateAnchor(market.totalPt, market.lastLnImpliedRate, pre.totalAsset, pre.rateScalar, ttx);
        pre.feeRate = _getExchangeRateFromImpliedRate(market.lnFeeRateRoot, ttx);
    }

    /// @notice rateScalar(t) = scalarRoot · IMPLIED_RATE_TIME / t.
    /// @dev    Curve gets *steeper* as expiry approaches — small proportion changes
    ///         at maturity move implied rate less in absolute terms.
    function _getRateScalar(int256 scalarRoot, uint256 ttx) private pure returns (int256 r) {
        r = (scalarRoot * int256(IMPLIED_RATE_TIME)) / int256(ttx);
        if (r <= 0) revert MarketRateScalarBelowZero();
    }

    /// @notice Recover the rate anchor that produces `lastLnImpliedRate` at the *current* proportion.
    function _getRateAnchor(
        int256 totalPt,
        int256 lastLnImpliedRate,
        int256 totalAsset,
        int256 rateScalar,
        uint256 ttx
    ) private pure returns (int256 rateAnchor) {
        int256 newExchangeRate = _getExchangeRateFromImpliedRate(lastLnImpliedRate, ttx);
        if (newExchangeRate < IONE) revert MarketExchangeRateBelowOne();

        int256 proportion = totalPt.divWadInt(totalPt + totalAsset);
        int256 lnProportion = _logProportion(proportion);
        rateAnchor = newExchangeRate - lnProportion.divWadInt(rateScalar);
    }

    /// @notice exchangeRate(impliedRate, t) = exp(lnImpliedRate · t / YEAR).
    function _getExchangeRateFromImpliedRate(int256 lnImpliedRate, uint256 ttx)
        private
        pure
        returns (int256)
    {
        int256 rt = (lnImpliedRate * int256(ttx)) / int256(IMPLIED_RATE_TIME);
        return PMath.expWad(rt);
    }

    /// @notice Inverse: extract lnImpliedRate from a post-trade exchange rate.
    function _getLnImpliedRate(int256 exchangeRate, uint256 ttx) private pure returns (int256) {
        int256 lnRate = PMath.lnWad(exchangeRate);
        return (lnRate * int256(IMPLIED_RATE_TIME)) / int256(ttx);
    }

    /// @notice ln(p / (1−p)) — the logit transform of `proportion`.
    function _logProportion(int256 proportion) private pure returns (int256) {
        if (proportion == IONE) revert MarketProportionMustNotEqualOne();
        int256 logitP = proportion.divWadInt(IONE - proportion);
        return PMath.lnWad(logitP);
    }

    // ───────────────────── execute trade ─────────────────────

    /// @notice Compute the SY amounts for a trade of `netPtToAccount` PT, and produce the
    ///         updated `lastLnImpliedRate` for persistence.
    /// @param market           current state (read-only — caller persists the new state)
    /// @param pre              cached pre-compute for this block
    /// @param netPtToAccount   positive ⇒ user buys PT (pays SY); negative ⇒ user sells PT
    /// @return netSyToAccount  positive ⇒ user receives SY; negative ⇒ user pays SY
    /// @return netSyFee        total fee in SY (always positive)
    /// @return netSyToReserve  reserve fee in SY (always positive, ≤ netSyFee)
    /// @return newLnImpliedRate post-trade lnImpliedRate to persist on the market
    function executeTradeCore(MarketState memory market, PreCompute memory pre, int256 netPtToAccount, uint256 now_)
        internal
        pure
        returns (int256 netSyToAccount, int256 netSyFee, int256 netSyToReserve, int256 newLnImpliedRate)
    {
        if (now_ >= market.expiry) revert MarketExpired();
        uint256 ttx = market.expiry - now_;

        int256 newPt = market.totalPt - netPtToAccount;
        if (newPt <= 0) revert InsufficientLiquidity();

        int256 proportion = newPt.divWadInt(newPt + pre.totalAsset);
        if (proportion > MAX_MARKET_PROPORTION) revert MarketProportionTooHigh();

        int256 preFeeExchangeRate = _logProportion(proportion).divWadInt(pre.rateScalar) + pre.rateAnchor;
        if (preFeeExchangeRate < IONE) revert MarketExchangeRateBelowOne();

        // Asset-denominated amount user receives or pays before fee. Sign mirrors `-netPtToAccount`.
        int256 preFeeAssetToAccount = (-netPtToAccount).divWadInt(preFeeExchangeRate);

        int256 postFeeAssetToAccount;
        int256 postFeeExchangeRate;

        if (netPtToAccount > 0) {
            // User is buying PT (paying SY). Charge by *raising* the effective rate
            //   ⇒ user pays MORE asset. postRate = preRate / feeRate (feeRate < 1e18 here? No —
            //   feeRate = exp(lnFeeRateRoot · IMPLIED_RATE_TIME / t), with lnFeeRateRoot > 0,
            //   so feeRate > 1e18; therefore preRate / feeRate < preRate).
            // The Pendle convention: postFeeExchangeRate = preFeeExchangeRate / feeRate when buying.
            postFeeExchangeRate = preFeeExchangeRate.divWadInt(pre.feeRate);
            if (postFeeExchangeRate < IONE) revert MarketExchangeRateBelowOne();
            postFeeAssetToAccount = (-netPtToAccount).divWadInt(postFeeExchangeRate);
        } else {
            // User is selling PT (receiving SY). postFeeExchangeRate = preFeeExchangeRate * feeRate
            //   ⇒ effective rate higher ⇒ same PT yields LESS SY back.
            postFeeExchangeRate = preFeeExchangeRate.mulWadInt(pre.feeRate);
            postFeeAssetToAccount = (-netPtToAccount).divWadInt(postFeeExchangeRate);
        }

        // Asset-side fee = preFeeAssetToAccount − postFeeAssetToAccount, always positive in
        // absolute terms. We compute as |fee| and convert to SY using `pre.totalAsset` ratio.
        int256 feeAsset = _abs(preFeeAssetToAccount - postFeeAssetToAccount);

        // Convert asset → SY:  syAmount = assetAmount * totalSy / totalAsset.
        // (For non-zero totalAsset; reverts upstream if totalAsset == 0 due to divWadInt below.)
        netSyToAccount = (postFeeAssetToAccount * market.totalSy) / pre.totalAsset;
        netSyFee = (feeAsset * market.totalSy) / pre.totalAsset;
        netSyToReserve = (netSyFee * int256(market.reserveFeePercent)) / 100;

        newLnImpliedRate = _getLnImpliedRate(postFeeExchangeRate, ttx);
    }

    // ───────────────────── add / remove liquidity ─────────────────────

    /// @notice Proportional liquidity add — does NOT move `lastLnImpliedRate`.
    function addLiquidityCore(MarketState memory market, int256 syDesired, int256 ptDesired)
        internal
        pure
        returns (int256 netLpToAccount, int256 syUsed, int256 ptUsed, int256 netSyToReserve)
    {
        if (syDesired <= 0 || ptDesired <= 0) revert InsufficientLiquidity();
        // M-4 audit fix: cap inputs at int128 max so the first-add `syDesired * ptDesired`
        // multiplication can't overflow uint256 (each factor fits in 128 bits → product
        // fits in 256). Practical Pendle markets never seed beyond this; the guard is
        // pure safety.
        if (syDesired > type(int128).max || ptDesired > type(int128).max) revert InsufficientLiquidity();

        if (market.totalLp == 0) {
            // First-add: LP = sqrt(syDesired · ptDesired) − MINIMUM_LIQUIDITY
            uint256 product = uint256(syDesired) * uint256(ptDesired);
            uint256 sqrtL = PMath.sqrt(product);
            if (sqrtL <= MINIMUM_LIQUIDITY) revert InsufficientLiquidity();
            netLpToAccount = int256(sqrtL - MINIMUM_LIQUIDITY);
            syUsed = syDesired;
            ptUsed = ptDesired;
        } else {
            // Subsequent: take min ratio. Caller is expected to refund unused side or revert.
            int256 lpFromSy = (syDesired * market.totalLp) / market.totalSy;
            int256 lpFromPt = (ptDesired * market.totalLp) / market.totalPt;
            if (lpFromSy < lpFromPt) {
                netLpToAccount = lpFromSy;
                syUsed = syDesired;
                ptUsed = (lpFromSy * market.totalPt) / market.totalLp;
            } else {
                netLpToAccount = lpFromPt;
                ptUsed = ptDesired;
                syUsed = (lpFromPt * market.totalSy) / market.totalLp;
            }
        }
        if (netLpToAccount <= 0) revert InsufficientLiquidity();
        netSyToReserve = 0;
    }

    /// @notice Proportional liquidity remove — does NOT move `lastLnImpliedRate`.
    function removeLiquidityCore(MarketState memory market, int256 lpToRemove)
        internal
        pure
        returns (int256 netSyToAccount, int256 netPtToAccount)
    {
        if (lpToRemove <= 0 || lpToRemove > market.totalLp) revert InsufficientLiquidity();
        netSyToAccount = (lpToRemove * market.totalSy) / market.totalLp;
        netPtToAccount = (lpToRemove * market.totalPt) / market.totalLp;
    }

    // ───────────────────── helpers ─────────────────────

    function _abs(int256 x) private pure returns (int256) {
        return x < 0 ? -x : x;
    }

    /// @notice Computes the initial `lastLnImpliedRate` for a freshly initialised market.
    /// @dev    Caller supplies the desired starting implied rate (the "seeded" yield curve).
    function setInitialLnImpliedRate(
        MarketState memory market,
        int256 syIndex,
        int256 initialAnchor,
        uint256 now_
    ) internal pure returns (int256 lnImpliedRate) {
        if (now_ >= market.expiry) revert MarketExpired();
        uint256 ttx = market.expiry - now_;

        int256 totalAsset = (market.totalSy * syIndex) / IONE;
        int256 proportion = market.totalPt.divWadInt(market.totalPt + totalAsset);

        int256 rateScalar = _getRateScalar(market.scalarRoot, ttx);
        int256 lnProp = _logProportion(proportion);
        int256 exchangeRate = lnProp.divWadInt(rateScalar) + initialAnchor;
        if (exchangeRate < IONE) revert MarketExchangeRateBelowOne();

        lnImpliedRate = _getLnImpliedRate(exchangeRate, ttx);
    }

    /// @notice Sanity check the governance-set `lnFeeRateRoot`.
    function validateLnFeeRateRoot(int256 lnFeeRateRoot) internal pure {
        if (lnFeeRateRoot < 0 || lnFeeRateRoot > MAX_LN_FEE_RATE_ROOT) {
            revert InvalidLnFeeRateRoot();
        }
    }
}
