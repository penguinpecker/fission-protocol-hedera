// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {AccessControlDefaultAdminRules} from
    "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";

import {IFissionMarket} from "../interfaces/IFissionMarket.sol";
import {IStandardizedYield} from "../interfaces/IStandardizedYield.sol";
import {PrincipalToken} from "./PrincipalToken.sol";
import {YieldToken} from "./YieldToken.sol";
import {MarketMath} from "../libraries/MarketMath.sol";
import {PMath} from "../libraries/PMath.sol";

/// @title  FissionMarket — per-maturity AMM with yield-accruing YT.
/// @notice Holds SY, mints/burns PT+YT, runs the Pendle V2 logit-curve AMM, distributes
///         yield to YT holders via a global-index pattern, and handles post-expiry
///         redemption. Itself an ERC-20 LP token (18 decimals, independent of the SY).
/// @dev    State is split across three storage regions so each user-facing function
///         touches as little as possible:
///           1. Immutables           — sy, expiry, scalarRoot, factory, asset decimals.
///           2. AMM pool             — totalPt / totalSy / lastLnImpliedRate.
///           3. Yield accrual        — globalIndex, userIndex, userOwed.
///         Conservation invariant (all in asset units, scaled by 1e18):
///             `sy.balanceOf(market) * sy.exchangeRate()  >=
///                  pt.totalSupply() * 1e18 + sum(userOwed) * sy.exchangeRate()`
contract FissionMarket is
    IFissionMarket,
    ERC20,
    ReentrancyGuardTransient,
    AccessControlDefaultAdminRules
{
    using PMath for uint256;
    using PMath for int256;
    using SafeERC20 for IERC20;

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    // ───────────────────── immutables ─────────────────────

    IStandardizedYield public immutable sy;
    uint256 public immutable expiry;
    int256 public immutable scalarRoot;
    address public immutable factory;
    uint8 internal immutable _assetDecimals;

    // ───────────────────── one-shot setters ─────────────────────

    PrincipalToken public pt;
    YieldToken public yt;

    // ───────────────────── AMM pool state ─────────────────────

    /// @notice PT held in the AMM pool reserve. Equals `pt.balanceOf(this)` always.
    uint256 public totalPt;
    /// @notice SY held in the AMM pool reserve. NOT the same as `sy.balanceOf(this)` —
    ///         the market also holds non-pool SY backing user-held PT/YT and unclaimed
    ///         yield, plus PT redemption value post-expiry.
    uint256 public totalSy;
    /// @notice Persisted ln(impliedRate) anchor between trades.
    int256 public lastLnImpliedRate;

    int256 public lnFeeRateRoot;
    uint256 public reserveFeePercent;
    address public treasury;

    // ───────────────────── yield accrual ─────────────────────

    /// @notice Last seen sy.exchangeRate(). Monotonic via max() on update; frozen at expiry.
    uint256 public globalIndex;
    bool public expiryIndexFrozen;
    mapping(address => uint256) public userIndex;
    mapping(address => uint256) public userOwed; // SY-share units

    // ───────────────────── errors ─────────────────────

    error TokensAlreadySet();
    error TokensNotSet();
    error AlreadyInitialized();
    error NotInitialized();
    error MarketExpired();
    error MarketNotExpired();
    error OnlyYT();
    error OnlyFactory();
    error InsufficientOutput();
    error InsufficientLiquidity();
    error ZeroAmount();
    error ZeroAddress();

    // ───────────────────── events ─────────────────────

    event TokensInitialized(address indexed pt, address indexed yt);
    event Initialized(uint256 syAmount, uint256 ptAmount, uint256 lpAmount, int256 lnFeeRateRoot, uint256 reserveFeePercent);
    event Split(address indexed user, uint256 amount);
    event Merge(address indexed user, uint256 amount);
    event LiquidityAdded(address indexed user, address indexed receiver, uint256 syIn, uint256 ptIn, uint256 lpOut);
    event LiquidityRemoved(address indexed user, address indexed receiver, uint256 lpIn, uint256 syOut, uint256 ptOut);
    event Swap(address indexed user, address indexed receiver, int256 ptDelta, int256 syDelta, int256 syFee, int256 syToReserve);
    event YieldClaimed(address indexed user, address indexed receiver, uint256 amount);
    event RedeemedAfterExpiry(address indexed user, address indexed receiver, uint256 ptIn, uint256 ytIn, uint256 syOut);
    event TreasuryUpdated(address indexed prev, address indexed next);
    event FeeUpdated(int256 lnFeeRateRoot, uint256 reserveFeePercent);

    // ───────────────────── modifiers ─────────────────────

    modifier onlyFactory() {
        if (msg.sender != factory) revert OnlyFactory();
        _;
    }

    modifier onlyYT() {
        if (msg.sender != address(yt)) revert OnlyYT();
        _;
    }

    modifier preExpiry() {
        if (block.timestamp >= expiry) revert MarketExpired();
        _;
    }

    modifier afterExpiry() {
        if (block.timestamp < expiry) revert MarketNotExpired();
        _;
    }

    // ───────────────────── construction ─────────────────────

    constructor(
        address sy_,
        uint256 expiry_,
        int256 scalarRoot_,
        address admin_,
        address treasury_,
        uint8 assetDecimals_,
        string memory lpName,
        string memory lpSymbol
    ) ERC20(lpName, lpSymbol) AccessControlDefaultAdminRules(0, admin_) {
        if (sy_ == address(0) || admin_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        if (expiry_ <= block.timestamp) revert MarketExpired();
        if (scalarRoot_ <= 0) revert MarketMath.MarketRateScalarBelowZero();

        sy = IStandardizedYield(sy_);
        expiry = expiry_;
        scalarRoot = scalarRoot_;
        treasury = treasury_;
        _assetDecimals = assetDecimals_;
        factory = msg.sender;
        _grantRole(ADMIN_ROLE, admin_);
    }

    /// @notice LP shares are 18 decimals — independent of the SY/asset decimals.
    function decimals() public pure override returns (uint8) {
        return 18;
    }

    /// @notice Asset decimals (matches sy.decimals(), per ERC-5115).
    function assetDecimals() external view returns (uint8) {
        return _assetDecimals;
    }

    // ───────────────────── one-shot setup ─────────────────────

    function setTokens(address pt_, address yt_) external onlyFactory {
        if (address(pt) != address(0)) revert TokensAlreadySet();
        if (pt_ == address(0) || yt_ == address(0)) revert ZeroAddress();
        pt = PrincipalToken(pt_);
        yt = YieldToken(yt_);
        emit TokensInitialized(pt_, yt_);
    }

    /// @notice Seed initial liquidity and set the implied-rate anchor. Call once after
    ///         setTokens. Caller (factory) supplies SY+PT and receives LP shares; this
    ///         is the only path that can mint LP from nothing.
    /// @notice Seed initial liquidity. Restricted to ADMIN_ROLE so the factory can
    ///         deploy Market+PT+YT first and the protocol's Safe later seeds with its own
    ///         capital — no factory custody of seed funds.
    function initialize(uint256 syIn, uint256 ptIn, int256 initialAnchor, int256 lnFeeRateRoot_, uint256 reserveFeePercent_)
        external
        nonReentrant
        onlyRole(ADMIN_ROLE)
        preExpiry
        returns (uint256 lpOut)
    {
        if (address(pt) == address(0)) revert TokensNotSet();
        if (totalSupply() != 0) revert AlreadyInitialized();
        if (syIn == 0 || ptIn == 0) revert ZeroAmount();
        if (reserveFeePercent_ > 100) revert InsufficientLiquidity();
        MarketMath.validateLnFeeRateRoot(lnFeeRateRoot_);

        IERC20(address(sy)).safeTransferFrom(msg.sender, address(this), syIn);
        IERC20(address(pt)).safeTransferFrom(msg.sender, address(this), ptIn);

        uint256 lpRaw = PMath.sqrt(syIn * ptIn);
        if (lpRaw <= MarketMath.MINIMUM_LIQUIDITY) revert InsufficientLiquidity();
        lpOut = lpRaw - MarketMath.MINIMUM_LIQUIDITY;
        // burn-to-DEAD donation defence (Uniswap v2 pattern)
        _mint(address(0xdEaD), MarketMath.MINIMUM_LIQUIDITY);
        _mint(msg.sender, lpOut);

        totalSy = syIn;
        totalPt = ptIn;
        lnFeeRateRoot = lnFeeRateRoot_;
        reserveFeePercent = reserveFeePercent_;

        // Compute and persist initial implied rate.
        MarketMath.MarketState memory ms = _loadState();
        int256 syIndex = int256(sy.exchangeRate());
        lastLnImpliedRate = MarketMath.setInitialLnImpliedRate(ms, syIndex, initialAnchor, block.timestamp);

        // Initialize global yield index.
        globalIndex = uint256(syIndex);

        emit Initialized(syIn, ptIn, lpOut, lnFeeRateRoot_, reserveFeePercent_);
    }

    // ───────────────────── split / merge ─────────────────────

    /// @notice 1 SY → 1 PT + 1 YT. No fee, no AMM math.
    function split(uint256 amount) external nonReentrant preExpiry returns (uint256) {
        if (amount == 0) revert ZeroAmount();
        if (address(pt) == address(0)) revert TokensNotSet();

        _accrue(msg.sender);

        IERC20(address(sy)).safeTransferFrom(msg.sender, address(this), amount);
        pt.mint(msg.sender, amount);
        yt.mint(msg.sender, amount);

        emit Split(msg.sender, amount);
        return amount;
    }

    /// @notice 1 PT + 1 YT → 1 SY. Pre-expiry only.
    function merge(uint256 amount) external nonReentrant preExpiry returns (uint256) {
        if (amount == 0) revert ZeroAmount();
        if (address(pt) == address(0)) revert TokensNotSet();

        _accrue(msg.sender);

        pt.burn(msg.sender, amount);
        yt.burn(msg.sender, amount);
        IERC20(address(sy)).safeTransfer(msg.sender, amount);

        emit Merge(msg.sender, amount);
        return amount;
    }

    // ───────────────────── swaps ─────────────────────

    function swapExactPtForSy(uint256 ptIn, uint256 minSyOut, address receiver)
        external
        nonReentrant
        preExpiry
        returns (uint256 syOut)
    {
        if (ptIn == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();

        // Pull PT first so subsequent state reflects updated balance.
        IERC20(address(pt)).safeTransferFrom(msg.sender, address(this), ptIn);

        MarketMath.MarketState memory ms = _loadState();
        int256 syIndex = int256(sy.exchangeRate());
        MarketMath.PreCompute memory pre = MarketMath.getMarketPreCompute(ms, syIndex, block.timestamp);

        // Selling PT: netPtToAccount = -ptIn ; netSyToAccount > 0.
        (int256 netSy, int256 netSyFee, int256 netSyToReserve, int256 newRate) =
            MarketMath.executeTradeCore(ms, pre, -int256(ptIn), block.timestamp);

        if (netSy <= 0) revert InsufficientOutput();
        syOut = uint256(netSy);
        if (syOut < minSyOut) revert InsufficientOutput();

        // Persist pool state.
        totalPt += ptIn;
        totalSy -= syOut;
        lastLnImpliedRate = newRate;

        // Pay user; route reserve fee to treasury.
        IERC20(address(sy)).safeTransfer(receiver, syOut);
        if (netSyToReserve > 0) {
            IERC20(address(sy)).safeTransfer(treasury, uint256(netSyToReserve));
            totalSy -= uint256(netSyToReserve);
        }

        emit Swap(msg.sender, receiver, -int256(ptIn), netSy, netSyFee, netSyToReserve);
    }

    function swapExactSyForPt(uint256 syInMax, uint256 ptOut, address receiver)
        external
        nonReentrant
        preExpiry
        returns (uint256 syIn)
    {
        if (ptOut == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();

        MarketMath.MarketState memory ms = _loadState();
        int256 syIndex = int256(sy.exchangeRate());
        MarketMath.PreCompute memory pre = MarketMath.getMarketPreCompute(ms, syIndex, block.timestamp);

        // Buying PT: netPtToAccount = +ptOut ; netSyToAccount < 0 (user pays).
        (int256 netSy, int256 netSyFee, int256 netSyToReserve, int256 newRate) =
            MarketMath.executeTradeCore(ms, pre, int256(ptOut), block.timestamp);

        if (netSy >= 0) revert InsufficientOutput();
        syIn = uint256(-netSy);
        if (syIn > syInMax) revert InsufficientOutput();

        // Pull SY from user, send PT.
        IERC20(address(sy)).safeTransferFrom(msg.sender, address(this), syIn);
        IERC20(address(pt)).safeTransfer(receiver, ptOut);

        totalPt -= ptOut;
        totalSy += syIn;
        lastLnImpliedRate = newRate;

        if (netSyToReserve > 0) {
            IERC20(address(sy)).safeTransfer(treasury, uint256(netSyToReserve));
            totalSy -= uint256(netSyToReserve);
        }

        emit Swap(msg.sender, receiver, int256(ptOut), netSy, netSyFee, netSyToReserve);
    }

    // ───────────────────── liquidity ─────────────────────

    function addLiquidity(uint256 syIn, uint256 ptIn, uint256 minLpOut, address receiver)
        external
        nonReentrant
        preExpiry
        returns (uint256 lpOut)
    {
        if (syIn == 0 || ptIn == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();
        if (totalSupply() == 0) revert NotInitialized();

        MarketMath.MarketState memory ms = _loadState();
        (int256 lpToMint, int256 syUsed, int256 ptUsed,) =
            MarketMath.addLiquidityCore(ms, int256(syIn), int256(ptIn));

        lpOut = uint256(lpToMint);
        if (lpOut < minLpOut) revert InsufficientOutput();

        IERC20(address(sy)).safeTransferFrom(msg.sender, address(this), uint256(syUsed));
        IERC20(address(pt)).safeTransferFrom(msg.sender, address(this), uint256(ptUsed));

        totalSy += uint256(syUsed);
        totalPt += uint256(ptUsed);
        _mint(receiver, lpOut);

        emit LiquidityAdded(msg.sender, receiver, uint256(syUsed), uint256(ptUsed), lpOut);
    }

    function removeLiquidity(uint256 lpIn, uint256 minSyOut, uint256 minPtOut, address receiver)
        external
        nonReentrant
        returns (uint256 syOut, uint256 ptOut)
    {
        if (lpIn == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();

        MarketMath.MarketState memory ms = _loadState();
        (int256 syOutI, int256 ptOutI) = MarketMath.removeLiquidityCore(ms, int256(lpIn));
        syOut = uint256(syOutI);
        ptOut = uint256(ptOutI);
        if (syOut < minSyOut || ptOut < minPtOut) revert InsufficientOutput();

        _burn(msg.sender, lpIn);
        totalSy -= syOut;
        totalPt -= ptOut;

        IERC20(address(sy)).safeTransfer(receiver, syOut);
        IERC20(address(pt)).safeTransfer(receiver, ptOut);

        emit LiquidityRemoved(msg.sender, receiver, lpIn, syOut, ptOut);
    }

    // ───────────────────── yield accrual ─────────────────────

    /// @notice Bring the global yield index up to the current SY rate, but freeze it at expiry.
    function _updateGlobalIndex() internal {
        if (expiryIndexFrozen) return;
        if (block.timestamp >= expiry) {
            // First post-expiry call freezes the index permanently. Use the *current*
            // sy.exchangeRate as the freeze value; this is the rate PT redeems against.
            uint256 cur = sy.exchangeRate();
            if (cur > globalIndex) globalIndex = cur;
            expiryIndexFrozen = true;
            return;
        }
        uint256 c = sy.exchangeRate();
        if (c > globalIndex) globalIndex = c;
    }

    /// @notice Settle accrued yield for `user` against their YT balance and old userIndex.
    /// @dev    Expects `_updateGlobalIndex()` already called this tx.
    function _accrueUser(address user) internal {
        if (user == address(0) || user == address(0xdEaD)) return;
        uint256 gi = globalIndex;
        uint256 ui = userIndex[user];
        if (ui == 0) {
            userIndex[user] = gi;
            return;
        }
        if (gi > ui && address(yt) != address(0)) {
            uint256 ytBal = yt.balanceOf(user);
            if (ytBal > 0) {
                // owed in SY-share units = ytBal * (gi - ui) / gi
                uint256 owed = (ytBal * (gi - ui)) / gi;
                if (owed > 0) userOwed[user] += owed;
            }
            userIndex[user] = gi;
        }
    }

    /// @dev Combined update + accrue, used by every external entry point.
    function _accrue(address user) internal {
        _updateGlobalIndex();
        _accrueUser(user);
    }

    /// @notice Callback from YieldToken. Settles accrued yield BEFORE balance updates.
    function onYTBalanceChange(address from, address to) external onlyYT {
        _updateGlobalIndex();
        _accrueUser(from);
        _accrueUser(to);
    }

    function claimYield(address receiver) external nonReentrant returns (uint256 amount) {
        if (receiver == address(0)) revert ZeroAddress();
        _accrue(msg.sender);
        amount = userOwed[msg.sender];
        if (amount == 0) return 0;
        userOwed[msg.sender] = 0;
        IERC20(address(sy)).safeTransfer(receiver, amount);
        emit YieldClaimed(msg.sender, receiver, amount);
    }

    /// @notice View — accrued yield for `user` if they were to claim now.
    function previewYield(address user) external view returns (uint256) {
        uint256 gi = globalIndex;
        if (!expiryIndexFrozen && block.timestamp < expiry) {
            uint256 c = sy.exchangeRate();
            if (c > gi) gi = c;
        }
        uint256 ui = userIndex[user];
        if (ui == 0) return userOwed[user];
        uint256 extra;
        if (gi > ui && address(yt) != address(0)) {
            uint256 ytBal = yt.balanceOf(user);
            if (ytBal > 0) extra = (ytBal * (gi - ui)) / gi;
        }
        return userOwed[user] + extra;
    }

    // ───────────────────── post-expiry redemption ─────────────────────

    /// @notice Burn equal PT and YT at expiry; receive SY at the frozen-at-expiry rate.
    /// @dev    Per PT:  SY out = `amount * 1e18 / globalIndex` (since globalIndex is the
    ///         frozen exchangeRate ≥ 1, redemption pays slightly fewer SY shares than
    ///         pre-expiry merge would have — the difference is the fixed yield earned).
    function redeemAfterExpiry(uint256 ptIn, uint256 ytIn, address receiver)
        external
        nonReentrant
        afterExpiry
        returns (uint256 syOut)
    {
        if (receiver == address(0)) revert ZeroAddress();
        if (ptIn == 0 && ytIn == 0) revert ZeroAmount();

        _accrue(msg.sender);

        if (ptIn > 0) {
            pt.burn(msg.sender, ptIn);
            // PT redemption: each PT pays out 1e18 / globalIndex SY-shares.
            syOut = (ptIn * 1e18) / globalIndex;
        }
        if (ytIn > 0) {
            yt.burn(msg.sender, ytIn);
            // YT itself has no redeemable value post-expiry; user collects their yield via claimYield.
        }

        if (syOut > 0) {
            IERC20(address(sy)).safeTransfer(receiver, syOut);
        }
        emit RedeemedAfterExpiry(msg.sender, receiver, ptIn, ytIn, syOut);
    }

    // ───────────────────── governance ─────────────────────

    function setTreasury(address newTreasury) external onlyRole(ADMIN_ROLE) {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    function setFee(int256 lnFeeRateRoot_, uint256 reserveFeePercent_) external onlyRole(ADMIN_ROLE) {
        MarketMath.validateLnFeeRateRoot(lnFeeRateRoot_);
        if (reserveFeePercent_ > 100) revert InsufficientLiquidity();
        lnFeeRateRoot = lnFeeRateRoot_;
        reserveFeePercent = reserveFeePercent_;
        emit FeeUpdated(lnFeeRateRoot_, reserveFeePercent_);
    }

    // ───────────────────── views ─────────────────────

    function getMarketState() external view returns (MarketMath.MarketState memory) {
        return _loadState();
    }

    function _loadState() internal view returns (MarketMath.MarketState memory ms) {
        ms.totalPt = int256(totalPt);
        ms.totalSy = int256(totalSy);
        ms.totalLp = int256(totalSupply());
        ms.expiry = expiry;
        ms.scalarRoot = scalarRoot;
        ms.lnFeeRateRoot = lnFeeRateRoot;
        ms.reserveFeePercent = reserveFeePercent;
        ms.lastLnImpliedRate = lastLnImpliedRate;
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        virtual
        override(AccessControlDefaultAdminRules)
        returns (bool)
    {
        return interfaceId == type(IFissionMarket).interfaceId
            || super.supportsInterface(interfaceId);
    }
}
