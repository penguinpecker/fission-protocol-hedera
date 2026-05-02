// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {SYBase} from "./SYBase.sol";
import {IStandardizedYield} from "../interfaces/IStandardizedYield.sol";
import {IUniswapV2Pair} from "../interfaces/IUniswapV2Pair.sol";
import {PMath} from "../libraries/PMath.sol";

/// @title  SY_SaucerSwapV1LP — Standardized Yield wrapper for SaucerSwap V1 LP tokens.
/// @notice The "ERC-20 read trick" for SaucerSwap. V2 LP positions are NFTs and don't
///         expose a per-share rate; V1 LPs are HTS-fungible ERC-20 facade tokens whose
///         per-share value grows monotonically from swap fees. The on-chain virtual
///         price `sqrt(r0 * r1) * 1e18 / totalSupply` captures fee-only growth (price
///         changes preserve k under x*y=k, and 0.3% fee swaps add to k).
/// @dev    `assetType = LIQUIDITY` per ERC-5115 — downstream PT/YT consumers must NOT
///         price PT against the LP token directly; they need a custom oracle. This
///         is critical for the Pendle-style market: the AMM internally treats `1 SY
///         share ≈ 1 LP token of value`, but in *asset* terms one needs an HBAR or
///         USDC oracle to know what "1 LP" is worth.
///
///         Rate machinery mirrors `SY_HBARX`: TWAP-6 ring buffer, 50 bps per-update
///         cap, 1 h min interval, circuit breaker that auto-pauses on > 200 bps
///         deviation between TWAP and a fresh on-chain virtual-price read. The keeper
///         posts via `postRate(newRate)`; off-chain it reads `_currentVirtualPrice()`
///         and computes the ratio against the SY's `initialVirtualPrice`.
contract SY_SaucerSwapV1LP is SYBase {
    using SafeERC20 for IERC20;
    using PMath for uint256;

    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");

    uint8 internal constant LP_DECIMALS = 8; // SaucerSwap V1 LP tokens are 8-dec on Hedera

    uint256 public constant TWAP_LEN = 6;
    uint256 public constant MIN_POST_INTERVAL = 1 hours;
    uint256 public constant MAX_DELTA_BPS = 50;
    uint256 public constant CIRCUIT_BREAKER_BPS = 200;

    /// @notice The SaucerSwap V1 pool / LP token contract (same address — V1 pools ARE
    ///         the LP token, like Uniswap V2).
    IUniswapV2Pair public immutable pool;

    /// @notice Captured at construction: `sqrt(r0 * r1) * 1e18 / totalSupply` of the
    ///         underlying pool. The SY's `exchangeRate()` is reported as a ratio against
    ///         this anchor, so it starts at 1e18 and grows from fees.
    uint256 public immutable initialVirtualPrice;

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
        address lpToken_,
        address admin_,
        uint48 adminTransferDelay_
    ) SYBase(name_, symbol_, lpToken_, LP_DECIMALS, admin_, adminTransferDelay_) {
        require(lpToken_ != address(0), "SY: lp zero");
        pool = IUniswapV2Pair(lpToken_);

        uint256 vp = _currentVirtualPrice();
        if (vp == 0) revert PoolUninitialized();
        initialVirtualPrice = vp;
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
        // CRITICAL: LIQUIDITY — downstream consumers must use a custom oracle, not
        // try to price `assetAddress` directly.
        return (AssetType.LIQUIDITY, underlying, LP_DECIMALS);
    }

    function yieldToken() external view override returns (address) {
        return underlying;
    }

    // ───────────────────── rate machinery ─────────────────────

    /// @notice Median TWAP over the populated ring buffer. Reverts if no posts yet.
    function exchangeRate() public view override returns (uint256) {
        uint256 n = count;
        if (n == 0) revert NoObservationsYet();
        return _median(n);
    }

    /// @notice Keeper posts a fresh rate. Same machinery as SY_HBARX.
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

        // Circuit breaker: compare TWAP to fresh on-chain virtual price.
        uint256 oldTwap = n > 0 ? _median(n) : newRate;
        try this._oracleVirtualPriceRatio() returns (uint256 oracleRate) {
            uint256 deviation = _absDeltaBps(oldTwap, oracleRate);
            if (deviation > CIRCUIT_BREAKER_BPS) {
                _pause();
                emit CircuitBreakerActivated(oldTwap, oracleRate, deviation);
                return;
            }
        } catch {
            // Pool unreadable: keeper can still post within bps caps.
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

    /// @notice External wrapper around the internal virtual-price read so the circuit
    ///         breaker can `try/catch` it. Not for general consumption.
    function _oracleVirtualPriceRatio() external view returns (uint256) {
        uint256 vp = _currentVirtualPrice();
        if (vp == 0) revert PoolUninitialized();
        return (vp * 1e18) / initialVirtualPrice;
    }

    // ───────────────────── internal helpers ─────────────────────

    /// @notice Reads the pool's current `sqrt(r0 * r1) * 1e18 / totalSupply`.
    /// @dev    Returns 0 if the pool has no liquidity (totalSupply == 0). Callers must
    ///         handle that path.
    function _currentVirtualPrice() internal view returns (uint256) {
        (uint112 r0, uint112 r1,) = pool.getReserves();
        uint256 ts = pool.totalSupply();
        if (ts == 0) return 0;
        uint256 prod = uint256(r0) * uint256(r1);
        if (prod == 0) return 0;
        return (PMath.sqrt(prod) * 1e18) / ts;
    }

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
