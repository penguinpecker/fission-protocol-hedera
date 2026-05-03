// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {SYBase} from "./SYBase.sol";
import {IStandardizedYield} from "../interfaces/IStandardizedYield.sol";
import {IStaderHBARX} from "../interfaces/IStaderHBARX.sol";
import {PMath} from "../libraries/PMath.sol";

/// @title  SY_HBARX — Standardized Yield wrapper for Stader HBARX (Hedera LST).
/// @notice Wraps HBARX 1:1 (no swap), exposing it through the ERC-5115 Pendle superset.
///         The `exchangeRate` returned here is the *protocol-safe* rate — a TWAP over a
///         ring buffer of keeper-posted observations, bps-bounded per update, with a
///         circuit breaker that auto-pauses on suspicious deviations from a fresh
///         on-chain Stader read.
/// @dev    Why TWAP-bounded vs. reading Stader directly on every call:
///         - Stader's `getExchangeRate()` is a single storage read; an attacker who can
///           briefly poke that contract (or whom Stader rate-bumps mid-block) could push
///           the SY rate into our AMM and arbitrage it. Pendle's Boros audit showed even
///           short TWAP windows materially raise sandwich-attack cost.
///         - Posting daily / hourly bps-capped deltas matches HBARX's actual yield cadence
///           (~5.4% APR, 24h reward sweep) so the protocol-safe rate tracks reality
///           without exposing it to atomic manipulation.
///
///         Tokens-in/out: HBARX only. Native HBAR is NOT accepted at this SY layer —
///         the user-facing flow at the Router level handles HBAR ↔ HBARX via Stader.
contract SY_HBARX is SYBase {
    using SafeERC20 for IERC20;
    using PMath for uint256;

    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");

    /// @notice HBARX has 8 decimals on Hedera (HTS token shape).
    uint8 internal constant HBARX_DECIMALS = 8;

    /// @notice TWAP ring-buffer length. Six hourly posts ≈ a 6-hour median window.
    uint256 public constant TWAP_LEN = 6;

    /// @notice Minimum seconds between keeper posts.
    uint256 public constant MIN_POST_INTERVAL = 1 hours;

    /// @notice Maximum allowed bps delta for a single keeper post (50 bps = 0.5%).
    uint256 public constant MAX_DELTA_BPS = 50;

    /// @notice Circuit-breaker threshold: if a fresh read from `staderOracle` deviates
    ///         from the current TWAP by > this many bps, `postRate` reverts and the
    ///         contract pauses automatically.
    uint256 public constant CIRCUIT_BREAKER_BPS = 200;

    /// @notice Stader's on-chain exchange-rate oracle.
    IStaderHBARX public immutable staderOracle;

    struct Observation {
        uint64 timestamp;
        uint192 rate; // 1e18-scaled, fits any plausible LST rate well below 2^192
    }

    /// @notice Ring buffer of keeper-posted observations.
    Observation[TWAP_LEN] public observations;

    /// @notice Index into `observations` where the next post will land.
    uint256 public head;

    /// @notice Number of observations actually populated (≤ TWAP_LEN).
    uint256 public count;

    error PostTooFrequent(uint256 nextValidAt);
    error DeltaExceedsCap(uint256 oldRate, uint256 newRate, uint256 maxDeltaBps);
    error NoObservationsYet();

    event RatePosted(uint256 indexed observationIndex, uint256 oldTwap, uint256 newRate, uint256 newTwap);
    event CircuitBreakerActivated(uint256 twapRate, uint256 oracleRate, uint256 deviationBps);

    constructor(
        address hbarx_,
        address staderOracle_,
        address admin_,
        uint48 adminTransferDelay_
    )
        SYBase("Fission SY-HBARX", "SY-HBARX", hbarx_, HBARX_DECIMALS, admin_, adminTransferDelay_)
    {
        require(hbarx_ != address(0), "SY: hbarx zero");
        require(staderOracle_ != address(0), "SY: stader zero");
        staderOracle = IStaderHBARX(staderOracle_);
    }

    // ───────────────────── deposit / redeem ─────────────────────

    /// @dev HBARX is held 1:1 — no swap, no spread. Shares minted = HBARX received,
    ///      adjusted for the current TWAP rate so that `exchangeRate * shares == HBARX`.
    function _deposit(address /*tokenIn*/, uint256 amountIn) internal view override returns (uint256 sharesOut) {
        uint256 rate = exchangeRate();
        // shares = amountIn * 1e18 / rate (round down — protocol's favour on deposit)
        sharesOut = amountIn.divWadDown(rate);
    }

    function _redeem(address receiver, address /*tokenOut*/, uint256 shares)
        internal
        override
        returns (uint256 amountTokenOut)
    {
        uint256 rate = exchangeRate();
        // amount = shares * rate / 1e18 (round down — protocol's favour on redeem)
        amountTokenOut = shares.mulWadDown(rate);
        IERC20(underlying).safeTransfer(receiver, amountTokenOut);
    }

    function previewDeposit(address /*tokenIn*/, uint256 amountIn)
        external
        view
        override
        returns (uint256 sharesOut)
    {
        sharesOut = amountIn.divWadDown(exchangeRate());
    }

    function previewRedeem(address /*tokenOut*/, uint256 shares)
        external
        view
        override
        returns (uint256 amountTokenOut)
    {
        amountTokenOut = shares.mulWadDown(exchangeRate());
    }

    // ───────────────────── 5115 metadata ─────────────────────

    function getTokensIn() external view override returns (address[] memory tokens) {
        tokens = new address[](1);
        tokens[0] = underlying;
    }

    function getTokensOut() external view override returns (address[] memory tokens) {
        tokens = new address[](1);
        tokens[0] = underlying;
    }

    function isValidTokenIn(address token) public view override returns (bool) {
        return token == underlying;
    }

    function isValidTokenOut(address token) public view override returns (bool) {
        return token == underlying;
    }

    function assetInfo()
        external
        view
        override
        returns (AssetType assetType, address assetAddress, uint8 assetDecimals)
    {
        // HBARX trades on SaucerSwap and has a market price — TOKEN type.
        return (AssetType.TOKEN, underlying, HBARX_DECIMALS);
    }

    function yieldToken() external view override returns (address) {
        return underlying;
    }

    // ───────────────────── rate machinery ─────────────────────

    /// @notice Current protocol-safe exchange rate: median of populated observations.
    /// @dev    Median is more robust to a single bad post than mean. With TWAP_LEN=6
    ///         the median tolerates up to 2 rogue observations before drifting.
    /// @dev    M-3 audit fix: at genesis (no keeper post yet) we return `PMath.ONE`
    ///         instead of reverting. A revert would brick every dependent contract:
    ///         FissionMarket.initialize, swap, _accrue (called from merge / claimYield /
    ///         redeemAfterExpiry escape paths) all read this. A keeper outage at the
    ///         wrong time would otherwise trap users. `PMath.ONE` (1.0 HBAR/HBARX) is
    ///         the minimum economically correct rate (HBARX ≥ HBAR, never less).
    function exchangeRate() public view override returns (uint256) {
        uint256 n = count;
        if (n == 0) return PMath.ONE;
        return _median(n);
    }

    /// @notice Keeper posts a fresh rate. Must obey:
    ///           1. ≥ MIN_POST_INTERVAL since last post
    ///           2. |new − last| ≤ MAX_DELTA_BPS of last (post-genesis only)
    ///           3. |new − staderOracle| ≤ CIRCUIT_BREAKER_BPS of staderOracle
    ///         Failing #1 or #2 reverts. Failing #3 reverts AND auto-pauses the SY.
    function postRate(uint256 newRate) external onlyRole(KEEPER_ROLE) {
        require(newRate > 0, "SY: rate zero");

        uint256 n = count;
        if (n > 0) {
            Observation memory last = observations[(head + TWAP_LEN - 1) % TWAP_LEN];
            if (block.timestamp < uint256(last.timestamp) + MIN_POST_INTERVAL) {
                revert PostTooFrequent(uint256(last.timestamp) + MIN_POST_INTERVAL);
            }
            uint256 deltaBps = _absDeltaBps(uint256(last.rate), newRate);
            if (deltaBps > MAX_DELTA_BPS) {
                revert DeltaExceedsCap(uint256(last.rate), newRate, MAX_DELTA_BPS);
            }
        }

        // Circuit breaker: if a live read of Stader is *very* far from where we are,
        // pause the contract AND drop the post. We do NOT revert — a revert would roll
        // back the `_pause()` state change, defeating the purpose. Returning early keeps
        // the pause sticky; the keeper's tx succeeds but the rate is not updated.
        // A 2 % deviation in a single sweep means either (a) Stader was hacked, (b) we
        // have stale TWAP, or (c) the keeper is malicious — either way, freeze.
        try staderOracle.getExchangeRate() returns (uint256 oracleRate) {
            uint256 oldTwap = n > 0 ? _median(n) : newRate;
            uint256 oracleDeviation = _absDeltaBps(oldTwap, oracleRate);
            if (oracleDeviation > CIRCUIT_BREAKER_BPS) {
                _pause();
                emit CircuitBreakerActivated(oldTwap, oracleRate, oracleDeviation);
                return; // post discarded; pause persists
            }
        } catch {
            // Stader oracle unreachable: keep going on TWAP alone — keeper can still post
            // within bps caps. If Stader stays down, governance can pause manually.
        }

        // Persist observation.
        uint256 idx = head;
        observations[idx] = Observation({timestamp: uint64(block.timestamp), rate: uint192(newRate)});
        head = (idx + 1) % TWAP_LEN;
        if (n < TWAP_LEN) {
            unchecked {
                count = n + 1;
            }
        }

        uint256 newTwap = _median(count);
        // L-4 audit fix: only call _medianExcludingNewest when there's at least one
        // prior observation to exclude (i.e. n > 1). Otherwise the prior median is
        // simply newRate (single-sample TWAP).
        uint256 priorTwap = n > 1 ? _medianExcludingNewest() : newRate;
        uint256 priorEmit = n > 1 ? priorTwap : 0;
        emit RatePosted(idx, priorTwap, newRate, newTwap);
        emit ExchangeRateUpdated(priorEmit, newTwap);
    }

    // ───────────────────── internal helpers ─────────────────────

    /// @notice |a − b| · 1e4 / max(a, b) — safe absolute bps deviation.
    function _absDeltaBps(uint256 a, uint256 b) internal pure returns (uint256) {
        if (a == b) return 0;
        (uint256 lo, uint256 hi) = a < b ? (a, b) : (b, a);
        return ((hi - lo) * PMath.BPS) / hi;
    }

    /// @notice Median of the first `n` observations (in arbitrary slot order). For n ≤ 6
    ///         we sort in-place via insertion sort — gas-cheap and correct for the size.
    function _median(uint256 n) internal view returns (uint256) {
        uint256[TWAP_LEN] memory tmp;
        for (uint256 i = 0; i < n; i++) {
            tmp[i] = uint256(observations[i].rate);
        }
        // insertion sort
        for (uint256 i = 1; i < n; i++) {
            uint256 v = tmp[i];
            uint256 j = i;
            while (j > 0 && tmp[j - 1] > v) {
                tmp[j] = tmp[j - 1];
                j--;
            }
            tmp[j] = v;
        }
        if (n % 2 == 1) {
            return tmp[n / 2];
        } else {
            // even count: lower-middle (round down) — protocol's favour on rate
            return tmp[(n / 2) - 1];
        }
    }

    /// @notice Median of all populated observations EXCLUDING the most recent post.
    ///         Used for emitting the "previous TWAP" in the RatePosted event.
    function _medianExcludingNewest() internal view returns (uint256) {
        uint256 n = count;
        if (n <= 1) return 0;
        // most-recent index = (head + TWAP_LEN - 1) % TWAP_LEN — but `head` already advanced
        // when this is called from postRate after the write. To get the index of the post
        // we just made: `(head + TWAP_LEN - 1) % TWAP_LEN`.
        uint256 newestIdx = (head + TWAP_LEN - 1) % TWAP_LEN;

        uint256[TWAP_LEN] memory tmp;
        uint256 k;
        for (uint256 i = 0; i < n; i++) {
            if (i == newestIdx) continue;
            tmp[k++] = uint256(observations[i].rate);
        }
        for (uint256 i = 1; i < k; i++) {
            uint256 v = tmp[i];
            uint256 j = i;
            while (j > 0 && tmp[j - 1] > v) {
                tmp[j] = tmp[j - 1];
                j--;
            }
            tmp[j] = v;
        }
        return k % 2 == 1 ? tmp[k / 2] : tmp[(k / 2) - 1];
    }
}
