// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {AccessControlDefaultAdminRules} from
    "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";

import {IFissionMarket} from "../interfaces/IFissionMarket.sol";
import {IFissionMarketCommon} from "../interfaces/IFissionMarketCommon.sol";
import {IStandardizedYield} from "../interfaces/IStandardizedYield.sol";
import {PrincipalToken} from "./PrincipalToken.sol";
import {YieldToken} from "./YieldToken.sol";
import {MarketMath} from "../libraries/MarketMath.sol";
import {PMath} from "../libraries/PMath.sol";

/// @title  FissionMarketRewards — sister Market for reward-bearing SYs.
/// @notice Same AMM / split / merge / LP / expiry mechanics as `FissionMarket`. The
///         difference is the YT yield path: this Market is for SYs whose `exchangeRate()`
///         is constant (Pendle-Kyber pattern) and whose yield is paid out via
///         `getRewardTokens()` / `claimRewards()` (e.g. `SY_SaucerSwapV2LP` distributes
///         token0 + token1 swap fees as reward tokens).
///
///         Yield distribution: every YT-balance change harvests pending SY rewards into
///         the Market, then settles per-YT-holder reward indexes against `yt.totalSupply()`.
///         YT holders claim their accrued reward tokens via `claimRewards(receiver)`.
///         LP holders earn AMM swap fees only — by design, all SY-derived rewards flow
///         to YT (matching Pendle's Kyber Elastic market behaviour).
///
///         PT redemption at expiry is 1:1 with SY because `exchangeRate ≡ 1e18`. There
///         is no `globalIndex` to track or freeze.
///
///         The reward-token surface is fixed at exactly TWO reward tokens to match the
///         shape of `SY_SaucerSwapV2LP` and Pendle's typical V3-LP wrappers (2-asset
///         pools). Reward addresses are read from the SY at construction and pinned
///         immutable; if the SY ever changes its reward set, this Market will not pick
///         that up — re-deploy a new Market for the new SY.
contract FissionMarketRewards is
    IFissionMarket,
    IFissionMarketCommon,
    ERC20,
    ReentrancyGuardTransient,
    Pausable,
    AccessControlDefaultAdminRules
{
    using PMath for uint256;
    using PMath for int256;
    using SafeERC20 for IERC20;

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    uint256 public constant MAX_RESERVE_FEE_PERCENT = 100;

    /// @dev 1e18-scale for reward-per-share index (matches SY adapter scale).
    uint256 internal constant REWARD_SCALE = 1e18;

    // ───────────────────── immutables ─────────────────────

    IStandardizedYield public immutable sy;
    uint256 public immutable expiry;
    int256 public immutable scalarRoot;
    address public immutable factory;
    uint8 internal immutable _assetDecimals;

    /// @notice The two reward tokens this Market distributes — pinned at construction
    ///         from `sy.getRewardTokens()`. Index 0 / 1 ordering matches the SY's.
    address public immutable rewardToken0;
    address public immutable rewardToken1;

    // ───────────────────── one-shot setters ─────────────────────

    PrincipalToken public pt;
    YieldToken public yt;

    // ───────────────────── AMM pool state ─────────────────────

    uint256 public totalPt;
    uint256 public totalSy;
    int256 public lastLnImpliedRate;

    int256 public lnFeeRateRoot;
    uint256 public reserveFeePercent;
    address public treasury;

    // ───────────────────── reward distribution state ─────────────────────

    /// @notice Cumulative reward-per-YT for each reward token, scaled by REWARD_SCALE.
    uint256 public globalRewardIndex0;
    uint256 public globalRewardIndex1;

    /// @notice Last-seen `globalRewardIndex{0,1}` per user.
    mapping(address => uint256) public userRewardIndex0;
    mapping(address => uint256) public userRewardIndex1;

    /// @notice Settled-but-unclaimed rewards in token0/token1 units per user.
    mapping(address => uint256) public userAccruedReward0;
    mapping(address => uint256) public userAccruedReward1;

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
    error WrongRewardTokenCount();
    error ReserveFeeTooHigh(uint256 given, uint256 max);
    error SYRateBelowOne(uint256 syRate);
    error YTBurnNotPermitted();

    // ───────────────────── events ─────────────────────

    event TokensInitialized(address indexed pt, address indexed yt);
    event Initialized(uint256 syAmount, uint256 ptAmount, uint256 lpAmount, int256 lnFeeRateRoot, uint256 reserveFeePercent);
    event Split(address indexed user, uint256 amount);
    event Merge(address indexed user, uint256 amount);
    event LiquidityAdded(address indexed user, address indexed receiver, uint256 syIn, uint256 ptIn, uint256 lpOut);
    event LiquidityRemoved(address indexed user, address indexed receiver, uint256 lpIn, uint256 syOut, uint256 ptOut);
    event Swap(address indexed user, address indexed receiver, int256 ptDelta, int256 syDelta, int256 syFee, int256 syToReserve);
    event RewardsHarvested(uint256 amount0, uint256 amount1);
    event RewardsClaimed(address indexed user, address indexed receiver, uint256 amount0, uint256 amount1);
    event HarvestSkipped(bytes reason);
    event RedeemedAfterExpiry(address indexed user, address indexed receiver, uint256 ptIn, uint256 ytIn, uint256 syOut);
    event TreasuryUpdated(address indexed prev, address indexed next);
    event FeeUpdated(int256 lnFeeRateRoot, uint256 reserveFeePercent);

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

        // Snapshot the SY's reward set at construction. Must be exactly 2 — this Market
        // is purpose-built for V3-LP-style SYs which have token0 + token1.
        address[] memory rewards = IStandardizedYield(sy_).getRewardTokens();
        if (rewards.length != 2) revert WrongRewardTokenCount();
        rewardToken0 = rewards[0];
        rewardToken1 = rewards[1];

        _grantRole(ADMIN_ROLE, admin_);
        _grantRole(PAUSER_ROLE, admin_);
    }

    /// @notice LP shares are 18 decimals — independent of the SY/asset decimals.
    function decimals() public pure override returns (uint8) {
        return 18;
    }

    function assetDecimals() external view returns (uint8) {
        return _assetDecimals;
    }

    // ───────────────────── one-shot setup ─────────────────────

    function setTokens(address pt_, address yt_) external {
        if (msg.sender != factory) revert OnlyFactory();
        if (address(pt) != address(0)) revert TokensAlreadySet();
        if (pt_ == address(0) || yt_ == address(0)) revert ZeroAddress();
        pt = PrincipalToken(pt_);
        yt = YieldToken(yt_);
        emit TokensInitialized(pt_, yt_);
    }

    /// @notice Address-typed sibling of `pt()` — used by ActionRouter via IFissionMarketCommon.
    function ptAddr() external view returns (address) {
        return address(pt);
    }

    /// @notice Address-typed sibling of `yt()` — used by ActionRouter via IFissionMarketCommon.
    function ytAddr() external view returns (address) {
        return address(yt);
    }

    function initialize(uint256 syIn, uint256 ptIn, int256 initialAnchor, int256 lnFeeRateRoot_, uint256 reserveFeePercent_)
        external
        nonReentrant
        whenNotPaused
        onlyRole(ADMIN_ROLE)
        returns (uint256 lpOut)
    {
        if (block.timestamp >= expiry) revert MarketExpired();
        if (address(pt) == address(0)) revert TokensNotSet();
        if (totalSupply() != 0) revert AlreadyInitialized();
        if (syIn == 0 || ptIn == 0) revert ZeroAmount();
        if (reserveFeePercent_ > MAX_RESERVE_FEE_PERCENT) revert ReserveFeeTooHigh(reserveFeePercent_, MAX_RESERVE_FEE_PERCENT);
        MarketMath.validateLnFeeRateRoot(lnFeeRateRoot_);

        // For SY_SaucerSwapV2LP, exchangeRate is constant 1e18 by design — but enforce
        // the floor anyway as defence-in-depth for any future SY adapter wired through
        // the rewards-bearing path. (H-1 audit fix.)
        uint256 syIndexU = sy.exchangeRate();
        if (syIndexU < PMath.ONE) revert SYRateBelowOne(syIndexU);

        IERC20(address(sy)).safeTransferFrom(msg.sender, address(this), syIn);
        IERC20(address(pt)).safeTransferFrom(msg.sender, address(this), ptIn);

        uint256 lpRaw = PMath.sqrt(syIn * ptIn);
        if (lpRaw <= MarketMath.MINIMUM_LIQUIDITY) revert InsufficientLiquidity();
        lpOut = lpRaw - MarketMath.MINIMUM_LIQUIDITY;
        _mint(address(0xdEaD), MarketMath.MINIMUM_LIQUIDITY);
        _mint(msg.sender, lpOut);

        totalSy = syIn;
        totalPt = ptIn;
        lnFeeRateRoot = lnFeeRateRoot_;
        reserveFeePercent = reserveFeePercent_;

        // Compute and persist initial implied rate. The SY's exchangeRate is constant
        // 1e18, so this fixes the curve at deploy-time anchor.
        MarketMath.MarketState memory ms = _loadState();
        int256 syIndex = int256(sy.exchangeRate());
        lastLnImpliedRate = MarketMath.setInitialLnImpliedRate(ms, syIndex, initialAnchor, block.timestamp);

        emit Initialized(syIn, ptIn, lpOut, lnFeeRateRoot_, reserveFeePercent_);
    }

    // ───────────────────── split / merge ─────────────────────

    /// @notice 1 SY → 1 PT + 1 YT. No fee, no AMM math.
    /// @dev    Settles caller's reward accrual BEFORE minting YT.
    /// @dev    Pre-initialize splits are intentionally permitted; same rationale as
    ///         FissionMarket.split (bootstrap flow needs to mint PT before initialize).
    function split(uint256 amount) external nonReentrant whenNotPaused returns (uint256) {
        if (block.timestamp >= expiry) revert MarketExpired();
        if (amount == 0) revert ZeroAmount();
        if (address(pt) == address(0)) revert TokensNotSet();

        // Harvest + settle BEFORE the YT mint so the new shares earn from this point.
        _harvestRewards();
        _settleRewards(msg.sender);

        IERC20(address(sy)).safeTransferFrom(msg.sender, address(this), amount);
        pt.mint(msg.sender, amount);
        yt.mint(msg.sender, amount);

        emit Split(msg.sender, amount);
        return amount;
    }

    /// @notice 1 PT + 1 YT → 1 SY. Pre-expiry only. Always callable (escape hatch).
    function merge(uint256 amount) external nonReentrant returns (uint256) {
        if (block.timestamp >= expiry) revert MarketExpired();
        if (amount == 0) revert ZeroAmount();
        if (address(pt) == address(0)) revert TokensNotSet();

        _harvestRewards();
        _settleRewards(msg.sender);

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
        whenNotPaused
        returns (uint256 syOut)
    {
        if (block.timestamp >= expiry) revert MarketExpired();
        if (ptIn == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();

        IERC20(address(pt)).safeTransferFrom(msg.sender, address(this), ptIn);

        MarketMath.MarketState memory ms = _loadState();
        int256 syIndex = int256(sy.exchangeRate()); // 1e18 always
        MarketMath.PreCompute memory pre = MarketMath.getMarketPreCompute(ms, syIndex, block.timestamp);

        (int256 netSy, int256 netSyFee, int256 netSyToReserve, int256 newRate) =
            MarketMath.executeTradeCore(ms, pre, -int256(ptIn), block.timestamp);

        if (netSy <= 0) revert InsufficientOutput();
        syOut = uint256(netSy);
        if (syOut < minSyOut) revert InsufficientOutput();

        totalPt += ptIn;
        totalSy -= syOut;
        lastLnImpliedRate = newRate;

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
        whenNotPaused
        returns (uint256 syIn)
    {
        if (block.timestamp >= expiry) revert MarketExpired();
        if (ptOut == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();

        MarketMath.MarketState memory ms = _loadState();
        int256 syIndex = int256(sy.exchangeRate());
        MarketMath.PreCompute memory pre = MarketMath.getMarketPreCompute(ms, syIndex, block.timestamp);

        (int256 netSy, int256 netSyFee, int256 netSyToReserve, int256 newRate) =
            MarketMath.executeTradeCore(ms, pre, int256(ptOut), block.timestamp);

        if (netSy >= 0) revert InsufficientOutput();
        syIn = uint256(-netSy);
        if (syIn > syInMax) revert InsufficientOutput();

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
        whenNotPaused
        returns (uint256 lpOut)
    {
        if (block.timestamp >= expiry) revert MarketExpired();
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

    /// @notice Burn LP, return SY + PT proportional pre-expiry. Post-expiry, auto-redeem
    ///         the PT share 1:1 to SY (exchangeRate is constant 1e18 in this Market).
    /// @dev    H-4 audit fix (Pendle V3 fidelity): without auto-redemption, an LP could
    ///         race ahead of post-expiry PT redeemers and dump the received PT
    ///         externally, leaving PT-redeem txs reverting on insufficient SY backing.
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

        _burn(msg.sender, lpIn);
        totalSy -= syOut;
        totalPt -= ptOut;

        if (block.timestamp >= expiry) {
            // exchangeRate ≡ 1e18 → 1 PT redeems for 1 SY. Auto-redeem the LP's PT
            // share so LP exits never compete with PT-redeemers for SY backing.
            pt.burn(address(this), ptOut);
            syOut += ptOut;
            ptOut = 0;
        }

        if (syOut < minSyOut || ptOut < minPtOut) revert InsufficientOutput();

        IERC20(address(sy)).safeTransfer(receiver, syOut);
        if (ptOut > 0) IERC20(address(pt)).safeTransfer(receiver, ptOut);

        emit LiquidityRemoved(msg.sender, receiver, lpIn, syOut, ptOut);
    }

    // ───────────────────── reward harvesting / accrual ─────────────────────

    /// @notice Pull pending rewards from SY into this Market and bump global indexes.
    ///         Anyone can call — cheap public maintenance hook.
    function harvestRewards() external nonReentrant {
        _harvestRewards();
    }

    /// @dev Internal harvest. Called BEFORE every YT-balance change so accrual is
    ///      always settled against an up-to-date global index.
    /// @dev    Pendle semantics for reward-bearing markets: rewards keep flowing to YT
    ///         holders indefinitely. Post-expiry, YT has no SY claim but a YT holder
    ///         that hasn't yet redeemed/burned still earns its share of any incoming
    ///         rewards. This is intentional — freezing post-expiry would create a race
    ///         where pre-expiry-accrued-but-not-yet-harvested fees would be forfeited
    ///         by the last harvester. Users should redeem at expiry to free their YT
    ///         and stop subsidising late harvests, but the protocol does NOT force it.
    /// @dev    H-2 audit defence: `sy.claimRewards` is wrapped in try/catch. If the SY
    ///         (or its underlying V3 NPM) ever bricks the claim path, YT transfers /
    ///         mints / burns must STILL succeed — otherwise users cannot escape via
    ///         merge / redeemAfterExpiry. We skip this harvest cycle and keep going.
    /// @dev    H-3 audit defence: when `yt.totalSupply() == 0` we do NOT pull rewards
    ///         from the SY. Pulling them would orphan them in this contract permanently
    ///         (next harvest snapshots them as `prev`, so they're never credited to any
    ///         shareholder). With this guard, the SY keeps holding them until the first
    ///         YT actually exists and a future harvest credits them naturally.
    function _harvestRewards() internal {
        if (address(yt) == address(0)) return;

        uint256 ts = yt.totalSupply();
        if (ts == 0) return;

        uint256[] memory amounts;
        try sy.claimRewards(address(this)) returns (uint256[] memory a) {
            amounts = a;
        } catch (bytes memory reason) {
            emit HarvestSkipped(reason);
            return;
        }

        // M-NEW-1 audit fix (audit pass 2): use the SY's reported amounts as the
        // authoritative source instead of `balance-delta`. If a future reward token
        // were to carry a transfer hook (ERC-777, HIP-18 custom-fee callback, etc.)
        // and re-entered Market.claimRewards mid-transfer, balance delta would be
        // shorted by the re-entrant payout — leaving part of the harvested amount
        // uncredited to globalRewardIndex. Using `amounts` directly is invariant
        // under that re-entry: the SY committed to having transferred exactly that
        // much, period. Co-holders never get diluted.
        uint256 r0 = amounts.length > 0 ? amounts[0] : 0;
        uint256 r1 = amounts.length > 1 ? amounts[1] : 0;

        if (r0 == 0 && r1 == 0) return;

        if (r0 > 0) globalRewardIndex0 += (r0 * REWARD_SCALE) / ts;
        if (r1 > 0) globalRewardIndex1 += (r1 * REWARD_SCALE) / ts;
        emit RewardsHarvested(r0, r1);
    }

    /// @dev Lock in `user`'s accruable share of (globalIndex - userIndex) using their
    ///      CURRENT YT balance, then advance their userIndex. Must be called BEFORE the
    ///      YT balance moves.
    /// @dev    L-NEW-1 audit fix: skip `address(this)` (in addition to address(0) and
    ///         dead) so any Market-held YT (none in current code path, but defensive)
    ///         doesn't accumulate stuck dust.
    function _settleRewards(address user) internal {
        if (user == address(0) || user == address(0xdEaD) || user == address(this)) return;
        if (address(yt) == address(0)) return;

        uint256 bal = yt.balanceOf(user);
        uint256 g0 = globalRewardIndex0;
        uint256 g1 = globalRewardIndex1;
        uint256 u0 = userRewardIndex0[user];
        uint256 u1 = userRewardIndex1[user];

        if (bal > 0) {
            if (g0 > u0) userAccruedReward0[user] += (bal * (g0 - u0)) / REWARD_SCALE;
            if (g1 > u1) userAccruedReward1[user] += (bal * (g1 - u1)) / REWARD_SCALE;
        }
        userRewardIndex0[user] = g0;
        userRewardIndex1[user] = g1;
    }

    /// @notice YT callback — fires on every YT mint/burn/transfer. Settles BOTH sides.
    function onYTBalanceChange(address from, address to) external {
        if (msg.sender != address(yt)) revert OnlyYT();
        _harvestRewards();
        _settleRewards(from);
        _settleRewards(to);
    }

    /// @notice Claim reward tokens earned by `msg.sender`'s historical YT holdings.
    function claimRewards(address receiver)
        external
        nonReentrant
        returns (uint256 amount0, uint256 amount1)
    {
        if (receiver == address(0)) revert ZeroAddress();

        _harvestRewards();
        _settleRewards(msg.sender);

        amount0 = userAccruedReward0[msg.sender];
        amount1 = userAccruedReward1[msg.sender];

        if (amount0 > 0) {
            userAccruedReward0[msg.sender] = 0;
            IERC20(rewardToken0).safeTransfer(receiver, amount0);
        }
        if (amount1 > 0) {
            userAccruedReward1[msg.sender] = 0;
            IERC20(rewardToken1).safeTransfer(receiver, amount1);
        }

        emit RewardsClaimed(msg.sender, receiver, amount0, amount1);
    }

    /// @notice View — accrued + pending rewards for `user` if they were to claim now.
    ///         Does NOT trigger a harvest; for the harvest-included version, the caller
    ///         can call `harvestRewards()` first then read this.
    function previewRewards(address user) external view returns (uint256 amount0, uint256 amount1) {
        uint256 bal = yt.balanceOf(user);
        uint256 g0 = globalRewardIndex0;
        uint256 g1 = globalRewardIndex1;
        uint256 u0 = userRewardIndex0[user];
        uint256 u1 = userRewardIndex1[user];
        amount0 = userAccruedReward0[user] + (bal > 0 && g0 > u0 ? (bal * (g0 - u0)) / REWARD_SCALE : 0);
        amount1 = userAccruedReward1[user] + (bal > 0 && g1 > u1 ? (bal * (g1 - u1)) / REWARD_SCALE : 0);
    }

    // ───────────────────── post-expiry redemption ─────────────────────

    /// @notice Burn PT at expiry; receive SY 1:1.
    /// @dev    PT redeems 1:1 with SY because `exchangeRate ≡ 1e18`.
    /// @dev    M-2 audit fix: YT burn is intentionally NOT supported here. In a
    ///         reward-bearing market, rewards keep flowing to YT holders forever; a
    ///         user who burns YT permanently destroys that future income stream. To
    ///         prevent the footgun we reject any `ytIn > 0`. If a user truly wants to
    ///         dispose of YT, they can transfer it to a sink address — but they should
    ///         continue to claim rewards while they hold it.
    function redeemAfterExpiry(uint256 ptIn, uint256 ytIn, address receiver)
        external
        nonReentrant
        returns (uint256 syOut)
    {
        if (block.timestamp < expiry) revert MarketNotExpired();
        if (receiver == address(0)) revert ZeroAddress();
        if (ytIn != 0) revert YTBurnNotPermitted();
        if (ptIn == 0) revert ZeroAmount();

        // Settle the caller's pending rewards before any state change.
        _harvestRewards();
        _settleRewards(msg.sender);

        pt.burn(msg.sender, ptIn);
        syOut = ptIn; // 1:1 — exchangeRate is constant 1

        IERC20(address(sy)).safeTransfer(receiver, syOut);
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
        if (reserveFeePercent_ > MAX_RESERVE_FEE_PERCENT) revert ReserveFeeTooHigh(reserveFeePercent_, MAX_RESERVE_FEE_PERCENT);
        lnFeeRateRoot = lnFeeRateRoot_;
        reserveFeePercent = reserveFeePercent_;
        emit FeeUpdated(lnFeeRateRoot_, reserveFeePercent_);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // ───────────────────── views ─────────────────────

    function getMarketState() external view returns (MarketMath.MarketState memory) {
        return _loadState();
    }

    function _loadState() internal view returns (MarketMath.MarketState memory ms) {
        // L-7 audit fix: safe-cast helpers.
        ms.totalPt = PMath.toInt(totalPt);
        ms.totalSy = PMath.toInt(totalSy);
        ms.totalLp = PMath.toInt(totalSupply());
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
