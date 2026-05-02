// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {SYBase} from "./SYBase.sol";
import {IStandardizedYield} from "../interfaces/IStandardizedYield.sol";
import {IAavePool} from "../interfaces/IAavePool.sol";
import {PMath} from "../libraries/PMath.sol";

/// @title  SY_BonzoUSDC — Standardized Yield for Bonzo Finance bUSDC (Aave V3 fork).
/// @notice Bonzo's bUSDC is a rebasing aToken: `balanceOf` grows as interest accrues.
///         The cleaner rate source is `pool.getReserveNormalizedIncome(USDC)`, an
///         Aave-style cumulative interest index returned in 1e27 (ray) precision and
///         monotonically non-decreasing under healthy operation.
/// @dev    Same hardening as SY_HBARX / SY_SaucerSwapV1LP: TWAP-6, 50 bps per-update
///         cap, 1 h interval, circuit breaker that auto-pauses when TWAP and a fresh
///         on-chain ray-index read diverge by > 200 bps.
///
///         `assetType = TOKEN` because USDC is an ordinary ERC-20 with a market price
///         (1 USD), not an LP token.
contract SY_BonzoUSDC is SYBase {
    using SafeERC20 for IERC20;
    using PMath for uint256;

    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");

    uint8 internal constant USDC_DECIMALS = 6; // Hedera USDC[HTS] is 6-dec

    uint256 public constant TWAP_LEN = 6;
    uint256 public constant MIN_POST_INTERVAL = 1 hours;
    uint256 public constant MAX_DELTA_BPS = 50;
    uint256 public constant CIRCUIT_BREAKER_BPS = 200;

    /// @notice Bonzo's lending pool contract.
    IAavePool public immutable pool;

    /// @notice The USDC reserve address in the Bonzo pool. Used as the key into
    ///         `getReserveNormalizedIncome`.
    address public immutable usdcReserve;

    /// @notice Captured at construction: the Aave ray index for the USDC reserve at
    ///         deploy time. The SY's `exchangeRate` is reported as a ratio against
    ///         this anchor, so it starts at 1e18 and grows from accrued interest.
    uint256 public immutable initialIndexRay;

    struct Observation {
        uint64 timestamp;
        uint192 rate;
    }

    Observation[TWAP_LEN] public observations;
    uint256 public head;
    uint256 public count;

    error PostTooFrequent(uint256 nextValidAt);
    error DeltaExceedsCap(uint256 oldRate, uint256 newRate, uint256 maxDeltaBps);
    error NoObservationsYet();
    error PoolUninitialized();

    event RatePosted(uint256 indexed observationIndex, uint256 oldTwap, uint256 newRate, uint256 newTwap);
    event CircuitBreakerActivated(uint256 twapRate, uint256 oracleRate, uint256 deviationBps);

    constructor(
        string memory name_,
        string memory symbol_,
        address bUsdcToken_,
        address pool_,
        address usdcReserve_,
        address admin_,
        uint48 adminTransferDelay_
    ) SYBase(name_, symbol_, bUsdcToken_, USDC_DECIMALS, admin_, adminTransferDelay_) {
        require(bUsdcToken_ != address(0), "SY: bUSDC zero");
        require(pool_ != address(0), "SY: pool zero");
        require(usdcReserve_ != address(0), "SY: usdc zero");
        pool = IAavePool(pool_);
        usdcReserve = usdcReserve_;

        uint256 ix = pool.getReserveNormalizedIncome(usdcReserve_);
        if (ix == 0) revert PoolUninitialized();
        initialIndexRay = ix;
    }

    // ───────────────────── deposit / redeem ─────────────────────

    function _deposit(address /*tokenIn*/, uint256 amountIn) internal view override returns (uint256 sharesOut) {
        uint256 rate = exchangeRate();
        sharesOut = amountIn.divWadDown(rate);
    }

    function _redeem(address receiver, address /*tokenOut*/, uint256 shares)
        internal
        override
        returns (uint256 amountOut)
    {
        uint256 rate = exchangeRate();
        amountOut = shares.mulWadDown(rate);
        IERC20(underlying).safeTransfer(receiver, amountOut);
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
        returns (uint256 amountOut)
    {
        amountOut = shares.mulWadDown(exchangeRate());
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
        // USDC is a token with a market price — declare TOKEN, not LIQUIDITY.
        return (AssetType.TOKEN, usdcReserve, USDC_DECIMALS);
    }

    function yieldToken() external view override returns (address) {
        return underlying;
    }

    // ───────────────────── rate machinery ─────────────────────

    function exchangeRate() public view override returns (uint256) {
        uint256 n = count;
        if (n == 0) revert NoObservationsYet();
        return _median(n);
    }

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

        // Circuit breaker — compare TWAP to fresh on-chain Aave ray index ratio.
        uint256 oldTwap = n > 0 ? _median(n) : newRate;
        try this._oracleIndexRatio() returns (uint256 oracleRate) {
            uint256 deviation = _absDeltaBps(oldTwap, oracleRate);
            if (deviation > CIRCUIT_BREAKER_BPS) {
                _pause();
                emit CircuitBreakerActivated(oldTwap, oracleRate, deviation);
                return;
            }
        } catch {
            // Pool unreachable: keeper can still post within bps caps.
        }

        uint256 idx = head;
        observations[idx] = Observation({timestamp: uint64(block.timestamp), rate: uint192(newRate)});
        head = (idx + 1) % TWAP_LEN;
        if (n < TWAP_LEN) {
            unchecked {
                count = n + 1;
            }
        }

        emit RatePosted(idx, oldTwap, newRate, _median(count));
        emit ExchangeRateUpdated(oldTwap, _median(count));
    }

    /// @notice External wrapper around the internal index read for `try/catch` framing.
    function _oracleIndexRatio() external view returns (uint256) {
        uint256 ix = pool.getReserveNormalizedIncome(usdcReserve);
        if (ix == 0) revert PoolUninitialized();
        // ix and initialIndexRay are both 1e27-scaled; ratio is a 1e18 fixed-point.
        return (ix * 1e18) / initialIndexRay;
    }

    // ───────────────────── internal helpers ─────────────────────

    function _absDeltaBps(uint256 a, uint256 b) internal pure returns (uint256) {
        if (a == b) return 0;
        (uint256 lo, uint256 hi) = a < b ? (a, b) : (b, a);
        return ((hi - lo) * PMath.BPS) / hi;
    }

    function _median(uint256 n) internal view returns (uint256) {
        uint256[TWAP_LEN] memory tmp;
        for (uint256 i = 0; i < n; i++) {
            tmp[i] = uint256(observations[i].rate);
        }
        for (uint256 i = 1; i < n; i++) {
            uint256 v = tmp[i];
            uint256 j = i;
            while (j > 0 && tmp[j - 1] > v) {
                tmp[j] = tmp[j - 1];
                j--;
            }
            tmp[j] = v;
        }
        return n % 2 == 1 ? tmp[n / 2] : tmp[(n / 2) - 1];
    }
}
