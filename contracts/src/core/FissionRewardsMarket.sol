// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {AccessControlDefaultAdminRules} from
    "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";

import {IFissionMarketCommon} from "../interfaces/IFissionMarketCommon.sol";
import {IStandardizedYield} from "../interfaces/IStandardizedYield.sol";
import {IHederaTokenService} from "../interfaces/IHederaTokenService.sol";
import {HtsHelpers} from "../libraries/HtsHelpers.sol";
import {MarketMath} from "../libraries/MarketMath.sol";
import {PMath} from "../libraries/PMath.sol";

/// @title  FissionRewardsMarket — Pendle V2 market for reward-bearing SYs.
/// @notice Same AMM/split/merge/LP/expiry mechanics as the yield-bearing Market.
///         The difference is yield distribution: yield is paid via the SY's
///         reward tokens (e.g. SaucerSwap V2 LP fees in token0+token1), not
///         baked into exchangeRate. exchangeRate is constant 1e18.
///
///         New in this build:
///         - setOperator / swapExactYtForSyFor — Periphery acts on behalf of
///           the YT owner (otherwise YT freeze-by-default blocks atomic exits).
///         - CurveProportionOutOfBounds(actual, max) — structured error with
///           the proportion value, replaces the bare MarketProportionTooHigh.
///         - RewardsMarket-specific events for indexer cleanliness.
contract FissionRewardsMarket is
    IFissionMarketCommon,
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

    uint256 internal constant REWARD_SCALE = 1e18;

    // ───────────────────── immutables ─────────────────────

    IStandardizedYield public immutable sy;
    uint256 public immutable expiry;
    int256 public immutable scalarRoot;
    address public immutable factory;
    uint8 internal immutable _assetDecimals;

    address public immutable rewardToken0;
    address public immutable rewardToken1;

    // ───────────────────── one-shot setters ─────────────────────

    address public pt;
    address public yt;
    address public lp;

    /// @dev Cached after setTokens so we skip 11 staticcalls to `sy.shareToken()`
    ///      across the swap/split/merge/redeem paths and shave bytecode.
    address public shareToken;

    /// @dev Set after Market freezes this account on YT (mint side-effect).
    mapping(address => bool) internal _ytFrozen;

    /// @dev Authoritative YT balances — the HTS facade's balanceOf reverts for
    ///      Ed25519 long-zero EVM addresses, so reward accrual relies on this
    ///      tracked balance instead.
    mapping(address => uint256) internal _ytBal;

    // ───────────────────── operator approvals (NEW) ─────────────────────

    /// @notice owner => operator => approved. Set via `setOperator`.
    /// @dev    Operators can call `swapExactYtForSyFor(owner, …)` and
    ///         `splitTo(…, owner, owner)` on behalf of `owner`. They CANNOT
    ///         claim rewards (that always pays msg.sender's own accrual).
    mapping(address => mapping(address => bool)) public isOperator;

    // ───────────────────── AMM pool state ─────────────────────

    uint256 public totalPt;
    uint256 public totalSy;
    int256 public lastLnImpliedRate;

    int256 public lnFeeRateRoot;
    uint256 public reserveFeePercent;
    address public treasury;

    // ───────────────────── reward distribution state ─────────────────────

    // V3 NFT fee distribution (USDC + WHBAR from SaucerSwap pool fees) — goes
    // to YT holders proportional to YT balance × index growth.
    uint256 public globalRewardIndex0;
    uint256 public globalRewardIndex1;

    mapping(address => uint256) public userRewardIndex0;
    mapping(address => uint256) public userRewardIndex1;

    mapping(address => uint256) public userAccruedReward0;
    mapping(address => uint256) public userAccruedReward1;

    // ─── AMM swap-fee distribution to PT + YT holders (2026-05-29) ───
    // Each swap charges netSyFee (paid in SY-share units). Distribution:
    //   - AMM_FEE_DEPLOYER_BPS (1%)        → treasury (deployer wallet)
    //   - AMM_FEE_PT_BPS       (49.5%)     → PT holders via ptAmmRewardIndex
    //   - AMM_FEE_YT_BPS       (49.5%)     → YT holders via ytAmmRewardIndex
    // Rewards are paid in shareToken (SY).
    //
    // The legacy `reserveFeePercent` knob is now superseded — `_distributeAmmFee`
    // ignores it. Kept on storage for backwards compatibility (no migration
    // hazard) and so `setFee` continues to work for `lnFeeRateRoot`.
    uint256 public constant AMM_FEE_DEPLOYER_BPS = 100;   // 1%
    uint256 public constant AMM_FEE_PT_BPS       = 4950;  // 49.5%
    uint256 public constant AMM_FEE_YT_BPS       = 4950;  // 49.5%
    uint256 public constant AMM_FEE_BPS_DENOM    = 10000;

    uint256 public ptAmmRewardIndex;  // SY-share fees accrued per PT held (Q-scaled by REWARD_SCALE)
    uint256 public ytAmmRewardIndex;  // SY-share fees accrued per YT held

    mapping(address => uint256) public userPtAmmIndex;
    mapping(address => uint256) public userYtAmmIndex;

    mapping(address => uint256) public userAccruedPtAmm;
    mapping(address => uint256) public userAccruedYtAmm;

    // ───────────────────── errors ─────────────────────

    error TokensAlreadySet();
    error TokensNotSet();
    error AlreadyInitialized();
    error NotInitialized();
    error MarketExpired();
    error MarketNotExpired();
    error OnlyFactory();
    error InsufficientOutput();
    error InsufficientLiquidity();
    error ZeroAmount();
    error ZeroAddress();
    error WrongRewardTokenCount();
    error ReserveFeeTooHigh();
    error SYRateBelowOne();
    error YTBurnNotPermitted();
    error InsufficientYt();
    error NotAuthorized();

    // ───────────────────── events ─────────────────────

    event TokensInitialized(address indexed pt, address indexed yt, address indexed lp);
    event Initialized(uint256 syAmount, uint256 ptAmount, uint256 lpAmount, int256 lnFeeRateRoot, uint256 reserveFeePercent);
    event Split(address indexed user, address indexed ptReceiver, address indexed ytReceiver, uint256 amount);
    event Merge(address indexed user, uint256 amount);
    event LiquidityAdded(address indexed user, address indexed receiver, uint256 syIn, uint256 ptIn, uint256 lpOut);
    event LiquidityRemoved(address indexed user, address indexed receiver, uint256 lpIn, uint256 syOut, uint256 ptOut);
    /// @dev ptDelta sign: positive = user buying PT; negative = user selling PT.
    event Swap(address indexed user, address indexed receiver, int256 ptDelta, int256 syDelta, int256 syFee, int256 syToReserve);
    event RewardsClaimed(address indexed user, address indexed receiver, uint256 amount0, uint256 amount1);
    event RedeemedAfterExpiry(address indexed user, address indexed receiver, uint256 ptIn, uint256 syOut);

    // ───────────────────── construction ─────────────────────

    constructor(
        address sy_,
        uint256 expiry_,
        int256 scalarRoot_,
        address admin_,
        address treasury_,
        uint8 assetDecimals_,
        address factory_
    ) AccessControlDefaultAdminRules(0, admin_) {
        if (sy_ == address(0) || admin_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        if (expiry_ <= block.timestamp) revert MarketExpired();
        if (scalarRoot_ <= 0) revert MarketMath.MarketRateScalarBelowZero();

        sy = IStandardizedYield(sy_);
        expiry = expiry_;
        scalarRoot = scalarRoot_;
        treasury = treasury_;
        _assetDecimals = assetDecimals_;
        factory = factory_ == address(0) ? msg.sender : factory_;

        address[] memory rewards = IStandardizedYield(sy_).getRewardTokens();
        if (rewards.length != 2) revert WrongRewardTokenCount();
        rewardToken0 = rewards[0];
        rewardToken1 = rewards[1];

        _grantRole(ADMIN_ROLE, admin_);
        _grantRole(PAUSER_ROLE, admin_);
    }

    function assetDecimals() external view returns (uint8) {
        return _assetDecimals;
    }

    // ───────────────────── operator (NEW) ─────────────────────

    /// @notice Approve / revoke `operator` to act on msg.sender's behalf for
    ///         YT-side operations (`swapExactYtForSyFor`, etc).
    function setOperator(address operator, bool approved) external {
        if (operator == address(0)) revert ZeroAddress();
        isOperator[msg.sender][operator] = approved;
    }

    function _requireOwnerOrOperator(address owner) internal view {
        if (msg.sender != owner && !isOperator[owner][msg.sender]) {
            revert NotAuthorized();
        }
    }

    // ───────────────────── one-shot setup ─────────────────────

    function setTokens(
        string calldata ptName,
        string calldata ptSymbol,
        string calldata ytName,
        string calldata ytSymbol,
        string calldata lpName,
        string calldata lpSymbol
    )
        external
        payable
    {
        if (msg.sender != factory) revert OnlyFactory();
        if (pt != address(0)) revert TokensAlreadySet();

        uint256 perToken = msg.value / 3;

        pt = _createHtsToken(ptName, ptSymbol, false, true, _assetDecimals, perToken);
        yt = _createHtsToken(ytName, ytSymbol, true, true, _assetDecimals, perToken);
        lp = _createHtsToken(lpName, lpSymbol, false, true, 18, msg.value - 2 * perToken);

        address st = sy.shareToken();
        shareToken = st;
        HtsHelpers.associateIfNeeded(address(this), st);
        HtsHelpers.associateIfNeeded(address(this), rewardToken0);
        HtsHelpers.associateIfNeeded(address(this), rewardToken1);

        emit TokensInitialized(pt, yt, lp);
    }

    function _createHtsToken(
        string memory name_,
        string memory symbol_,
        bool withFreezeKey,
        bool withWipeKey,
        uint8 dec,
        uint256 value
    ) internal returns (address htsToken) {
        uint256 keyCount = 1 + (withFreezeKey ? 1 : 0) + (withWipeKey ? 1 : 0);
        IHederaTokenService.TokenKey[] memory keys = new IHederaTokenService.TokenKey[](keyCount);
        uint256 idx;
        keys[idx++] = HtsHelpers.makeKey(16, address(this));
        if (withFreezeKey) keys[idx++] = HtsHelpers.makeKey(4, address(this));
        if (withWipeKey) keys[idx++] = HtsHelpers.makeKey(8, address(this));

        IHederaTokenService.HederaToken memory spec = IHederaTokenService.HederaToken({
            name: name_,
            symbol: symbol_,
            treasury: address(this),
            memo: "",
            tokenSupplyType: false,
            maxSupply: 0,
            freezeDefault: false,
            tokenKeys: keys,
            expiry: IHederaTokenService.Expiry({second: 0, autoRenewAccount: address(this), autoRenewPeriod: 7776000})
        });
        return HtsHelpers.createFungible(spec, int32(uint32(dec)), value);
    }

    function ptAddr() external view returns (address) {
        return pt;
    }

    function ytAddr() external view returns (address) {
        return yt;
    }

    function ytBalanceOf(address user) external view returns (uint256) {
        return _ytBal[user];
    }

    function _mintPt(address to, uint256 amount) internal {
        HtsHelpers.mintToTreasury(pt, amount);
        if (to != address(this)) {
            HtsHelpers.transfer(pt, address(this), to, amount);
        }
    }

    function _burnPt(address from, uint256 amount) internal {
        if (from == address(this)) {
            HtsHelpers.burnFromTreasury(pt, amount);
        } else {
            HtsHelpers.wipeFrom(pt, from, amount);
        }
    }

    function _mintYt(address to, uint256 amount) internal {
        HtsHelpers.mintToTreasury(yt, amount);
        if (to != address(this)) {
            if (_ytFrozen[to]) {
                HtsHelpers.unfreeze(yt, to);
            }
            HtsHelpers.transfer(yt, address(this), to, amount);
            HtsHelpers.freeze(yt, to);
            _ytFrozen[to] = true;
        }
        _ytBal[to] += amount;
    }

    function _burnYt(address from, uint256 amount) internal {
        if (from == address(this)) {
            HtsHelpers.burnFromTreasury(yt, amount);
        } else {
            bool wasFrozen = _ytFrozen[from];
            if (wasFrozen) HtsHelpers.unfreeze(yt, from);
            HtsHelpers.wipeFrom(yt, from, amount);
            _ytBal[from] -= amount;
            if (wasFrozen && _ytBal[from] > 0) {
                HtsHelpers.freeze(yt, from);
            } else if (wasFrozen) {
                _ytFrozen[from] = false;
            }
            return;
        }
        _ytBal[from] -= amount;
    }

    function _mintLp(address to, uint256 amount) internal {
        HtsHelpers.mintToTreasury(lp, amount);
        if (to != address(this)) {
            HtsHelpers.transfer(lp, address(this), to, amount);
        }
    }

    function _burnLp(address from, uint256 amount) internal {
        if (from == address(this)) {
            HtsHelpers.burnFromTreasury(lp, amount);
        } else {
            HtsHelpers.wipeFrom(lp, from, amount);
        }
    }

    function initialize(uint256 syIn, uint256 ptIn, int256 initialAnchor, int256 lnFeeRateRoot_, uint256 reserveFeePercent_)
        external
        nonReentrant
        whenNotPaused
        onlyRole(ADMIN_ROLE)
        returns (uint256 lpOut)
    {
        if (block.timestamp >= expiry) revert MarketExpired();
        if (pt == address(0)) revert TokensNotSet();
        if (lp != address(0) && IERC20(lp).totalSupply() != 0) revert AlreadyInitialized();
        if (syIn == 0 || ptIn == 0) revert ZeroAmount();
        if (reserveFeePercent_ > MAX_RESERVE_FEE_PERCENT) revert ReserveFeeTooHigh();
        MarketMath.validateLnFeeRateRoot(lnFeeRateRoot_);

        uint256 syIndexU = sy.exchangeRate();
        if (syIndexU < PMath.ONE) revert SYRateBelowOne();

        IERC20(shareToken).safeTransferFrom(msg.sender, address(this), syIn);
        IERC20(pt).safeTransferFrom(msg.sender, address(this), ptIn);

        uint256 lpRaw = PMath.sqrt(syIn * ptIn);
        if (lpRaw <= MarketMath.MINIMUM_LIQUIDITY) revert InsufficientLiquidity();
        lpOut = lpRaw - MarketMath.MINIMUM_LIQUIDITY;
        _mintLp(address(this), MarketMath.MINIMUM_LIQUIDITY);
        _mintLp(msg.sender, lpOut);

        totalSy = syIn;
        totalPt = ptIn;
        lnFeeRateRoot = lnFeeRateRoot_;
        reserveFeePercent = reserveFeePercent_;

        MarketMath.MarketState memory ms = _loadState();
        int256 syIndex = int256(sy.exchangeRate());
        lastLnImpliedRate = MarketMath.setInitialLnImpliedRate(ms, syIndex, initialAnchor, block.timestamp);

        emit Initialized(syIn, ptIn, lpOut, lnFeeRateRoot_, reserveFeePercent_);
    }

    // ───────────────────── split / merge ─────────────────────

    function split(uint256 amount) external nonReentrant whenNotPaused returns (uint256) {
        return _split(amount, msg.sender, msg.sender);
    }

    function splitTo(uint256 amount, address ptReceiver, address ytReceiver)
        external
        nonReentrant
        whenNotPaused
        returns (uint256)
    {
        if (ptReceiver == address(0) || ytReceiver == address(0)) revert ZeroAddress();
        if (ptReceiver == address(this) || ytReceiver == address(this)) revert ZeroAddress();
        return _split(amount, ptReceiver, ytReceiver);
    }

    function _split(uint256 amount, address ptReceiver, address ytReceiver) internal returns (uint256) {
        if (block.timestamp >= expiry) revert MarketExpired();
        if (amount == 0) revert ZeroAmount();
        if (pt == address(0)) revert TokensNotSet();

        _harvestRewards();
        _settleRewards(ytReceiver);

        // Lock in PRE-mint AMM accrual for both receivers, then mark to current
        // after the mint so they earn from FUTURE growth on their new balance.
        _settlePtAmm(ptReceiver);
        _settleYtAmm(ytReceiver);

        IERC20(shareToken).safeTransferFrom(msg.sender, address(this), amount);
        _mintPt(ptReceiver, amount);
        _mintYt(ytReceiver, amount);

        _markPtAmmIndex(ptReceiver);
        _markYtAmmIndex(ytReceiver);

        emit Split(msg.sender, ptReceiver, ytReceiver, amount);
        return amount;
    }

    function merge(uint256 amount) external nonReentrant returns (uint256) {
        if (block.timestamp >= expiry) revert MarketExpired();
        if (amount == 0) revert ZeroAmount();
        if (pt == address(0)) revert TokensNotSet();

        _harvestRewards();
        _settleRewards(msg.sender);

        // Lock in PRE-burn AMM accrual.
        _settlePtAmm(msg.sender);
        _settleYtAmm(msg.sender);

        _burnPt(msg.sender, amount);
        _burnYt(msg.sender, amount);
        IERC20(shareToken).safeTransfer(msg.sender, amount);

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

        // Settle msg.sender's PT-AMM accrual on their PRE-transfer balance.
        _settlePtAmm(msg.sender);

        IERC20(pt).safeTransferFrom(msg.sender, address(this), ptIn);

        MarketMath.MarketState memory ms = _loadState();
        int256 syIndex = int256(sy.exchangeRate());
        MarketMath.PreCompute memory pre = MarketMath.getMarketPreCompute(ms, syIndex, block.timestamp);

        (int256 netSy, int256 netSyFee, , int256 newRate) =
            MarketMath.executeTradeCore(ms, pre, -int256(ptIn), block.timestamp);

        if (netSy <= 0) revert InsufficientOutput();
        syOut = uint256(netSy);
        if (syOut < minSyOut) revert InsufficientOutput();

        totalPt += ptIn;
        totalSy -= syOut;
        lastLnImpliedRate = newRate;

        IERC20(shareToken).safeTransfer(receiver, syOut);

        // 99% to PT+YT, 1% to deployer — see `_distributeAmmFee` and the
        // AMM_FEE_*_BPS constants.
        if (netSyFee > 0) {
            totalSy -= uint256(netSyFee);
            _distributeAmmFee(netSyFee);
        }

        // Mark msg.sender's PT-AMM index to current (skip-credit) so they
        // don't claim back a slice of the fee they just paid.
        _markPtAmmIndex(msg.sender);

        emit Swap(msg.sender, receiver, -int256(ptIn), netSy, netSyFee, 0);
    }

    /// @notice msg.sender sells THEIR YT for SY pre-expiry. See `swapExactYtForSyFor`
    ///         for the operator-callable variant.
    function swapExactYtForSy(uint256 ytIn, uint256 minSyOut, address receiver)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 syOut)
    {
        return _swapYtForSy(msg.sender, ytIn, minSyOut, receiver);
    }

    /// @notice Operator-callable variant. Caller must be `owner` OR `isOperator[owner][caller]`.
    /// @dev    Enables Periphery to atomically wipe `owner`'s YT and deliver the SY
    ///         (or downstream HBAR) without needing YT to be transferable. owner
    ///         opts in once via `setOperator(periphery, true)`.
    function swapExactYtForSyFor(address owner, uint256 ytIn, uint256 minSyOut, address receiver)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 syOut)
    {
        _requireOwnerOrOperator(owner);
        return _swapYtForSy(owner, ytIn, minSyOut, receiver);
    }

    function _swapYtForSy(address owner, uint256 ytIn, uint256 minSyOut, address receiver)
        internal
        returns (uint256 syOut)
    {
        if (block.timestamp >= expiry) revert MarketExpired();
        if (ytIn == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();

        uint256 ownerYt = _ytBal[owner];
        if (ownerYt < ytIn) revert InsufficientYt();

        _harvestRewards();
        _settleRewards(owner);
        _settleYtAmm(owner); // PRE-wipe accrual lock

        MarketMath.MarketState memory ms = _loadState();
        int256 syIndex = int256(sy.exchangeRate());
        MarketMath.PreCompute memory pre = MarketMath.getMarketPreCompute(ms, syIndex, block.timestamp);
        (int256 netSy, int256 netSyFee, , int256 newRate) =
            MarketMath.executeTradeCore(ms, pre, int256(ytIn), block.timestamp);

        if (netSy >= 0) revert InsufficientOutput();
        uint256 syOwed = uint256(-netSy);
        if (syOwed >= ytIn) revert InsufficientOutput();
        syOut = ytIn - syOwed;
        if (syOut < minSyOut) revert InsufficientOutput();

        totalPt -= ytIn;
        totalSy += syOwed;
        lastLnImpliedRate = newRate;

        _burnPt(address(this), ytIn);
        _burnYt(owner, ytIn);

        IERC20(shareToken).safeTransfer(receiver, syOut);

        if (netSyFee > 0) {
            totalSy -= uint256(netSyFee);
            _distributeAmmFee(netSyFee);
        }

        // Mark owner's YT-AMM index (skip-credit) so they don't claim a slice
        // of the fee just charged on this same wipe.
        _markYtAmmIndex(owner);

        emit Swap(owner, receiver, int256(ytIn), netSy, netSyFee, 0);
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

        // Settle receiver's PT-AMM accrual on their PRE-receipt balance.
        _settlePtAmm(receiver);

        MarketMath.MarketState memory ms = _loadState();
        int256 syIndex = int256(sy.exchangeRate());
        MarketMath.PreCompute memory pre = MarketMath.getMarketPreCompute(ms, syIndex, block.timestamp);

        (int256 netSy, int256 netSyFee, , int256 newRate) =
            MarketMath.executeTradeCore(ms, pre, int256(ptOut), block.timestamp);

        if (netSy >= 0) revert InsufficientOutput();
        syIn = uint256(-netSy);
        if (syIn > syInMax) revert InsufficientOutput();

        IERC20(shareToken).safeTransferFrom(msg.sender, address(this), syIn);
        IERC20(pt).safeTransfer(receiver, ptOut);

        totalPt -= ptOut;
        totalSy += syIn;
        lastLnImpliedRate = newRate;

        if (netSyFee > 0) {
            totalSy -= uint256(netSyFee);
            _distributeAmmFee(netSyFee);
        }

        // Mark receiver's PT-AMM index to current (skip-credit) so they don't
        // claim the fee that was just charged in this trade — receiver only
        // becomes a PT holder AFTER the fee is distributed; they earn future
        // fees, not this one.
        _markPtAmmIndex(receiver);

        emit Swap(msg.sender, receiver, int256(ptOut), netSy, netSyFee, 0);
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
        if (lp == address(0) || IERC20(lp).totalSupply() == 0) revert NotInitialized();

        // msg.sender's PT balance is about to decrease — settle their PT-AMM
        // accrual on the PRE-transfer balance.
        _settlePtAmm(msg.sender);

        MarketMath.MarketState memory ms = _loadState();
        (int256 lpToMint, int256 syUsed, int256 ptUsed,) =
            MarketMath.addLiquidityCore(ms, int256(syIn), int256(ptIn));

        lpOut = uint256(lpToMint);
        if (lpOut < minLpOut) revert InsufficientOutput();

        IERC20(shareToken).safeTransferFrom(msg.sender, address(this), uint256(syUsed));
        IERC20(pt).safeTransferFrom(msg.sender, address(this), uint256(ptUsed));

        totalSy += uint256(syUsed);
        totalPt += uint256(ptUsed);
        _mintLp(receiver, lpOut);

        emit LiquidityAdded(msg.sender, receiver, uint256(syUsed), uint256(ptUsed), lpOut);
    }

    function removeLiquidity(uint256 lpIn, uint256 minSyOut, uint256 minPtOut, address receiver)
        external
        nonReentrant
        returns (uint256 syOut, uint256 ptOut)
    {
        if (lpIn == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();

        // Settle receiver's PT-AMM accrual BEFORE they receive new PT (if
        // ptOut > 0). For post-expiry the auto-redeem zeroes ptOut and the
        // settle becomes a no-op-equivalent.
        _settlePtAmm(receiver);

        MarketMath.MarketState memory ms = _loadState();
        (int256 syOutI, int256 ptOutI) = MarketMath.removeLiquidityCore(ms, int256(lpIn));
        syOut = uint256(syOutI);
        ptOut = uint256(ptOutI);

        _burnLp(msg.sender, lpIn);
        totalSy -= syOut;
        totalPt -= ptOut;

        if (block.timestamp >= expiry) {
            // exchangeRate ≡ 1e18 → auto-redeem the LP's PT share to SY so LP exits
            // never compete with PT-redeemers for SY backing.
            _burnPt(address(this), ptOut);
            syOut += ptOut;
            ptOut = 0;
        }

        if (syOut < minSyOut || ptOut < minPtOut) {
            revert InsufficientOutput();
        }

        IERC20(shareToken).safeTransfer(receiver, syOut);
        if (ptOut > 0) {
            IERC20(pt).safeTransfer(receiver, ptOut);
            // Mark receiver's PT-AMM index to current (skip-credit) on the
            // newly-received PT.
            _markPtAmmIndex(receiver);
        }

        emit LiquidityRemoved(msg.sender, receiver, lpIn, syOut, ptOut);
    }

    // ───────────────────── reward harvesting / accrual ─────────────────────

    function harvestRewards() external nonReentrant {
        _harvestRewards();
    }

    function _harvestRewards() internal {
        if (yt == address(0)) return;

        uint256 ts = IERC20(yt).totalSupply();
        if (ts == 0) return;

        uint256[] memory amounts;
        try sy.claimRewards(address(this)) returns (uint256[] memory a) {
            amounts = a;
        } catch {
            return;
        }

        uint256 r0 = amounts.length > 0 ? amounts[0] : 0;
        uint256 r1 = amounts.length > 1 ? amounts[1] : 0;
        if (r0 == 0 && r1 == 0) return;

        if (r0 > 0) globalRewardIndex0 += (r0 * REWARD_SCALE) / ts;
        if (r1 > 0) globalRewardIndex1 += (r1 * REWARD_SCALE) / ts;
    }

    function _settleRewards(address user) internal {
        if (user == address(0) || user == address(0xdEaD) || user == address(this)) return;
        if (yt == address(0)) return;

        uint256 bal = _ytBal[user];
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

    function previewRewards(address user) external view returns (uint256 amount0, uint256 amount1) {
        uint256 bal = _ytBal[user];
        uint256 g0 = globalRewardIndex0;
        uint256 g1 = globalRewardIndex1;
        uint256 u0 = userRewardIndex0[user];
        uint256 u1 = userRewardIndex1[user];
        amount0 = userAccruedReward0[user] + (bal > 0 && g0 > u0 ? (bal * (g0 - u0)) / REWARD_SCALE : 0);
        amount1 = userAccruedReward1[user] + (bal > 0 && g1 > u1 ? (bal * (g1 - u1)) / REWARD_SCALE : 0);
    }

    // ───────────────────── AMM-fee distribution to PT + YT holders ─────────

    /// @notice Splits `netSyFee` (in SY-share units) into deployer (1%) +
    ///         PT-holder (49.5%) + YT-holder (49.5%) buckets. Updates the
    ///         per-token reward indices and transfers the deployer cut.
    ///         Net effect on the pool: `totalSy -= netSyFee` (i.e. the
    ///         entire fee leaves the pool — PT+YT portions held by THIS
    ///         contract until users claim).
    /// @dev    Callers must already have removed `netSyFee` from their
    ///         local accounting. Returns 0 if `netSyFee <= 0`.
    function _distributeAmmFee(int256 netSyFee) internal {
        if (netSyFee <= 0) return;
        uint256 fee = uint256(netSyFee);

        uint256 deployerCut = (fee * AMM_FEE_DEPLOYER_BPS) / AMM_FEE_BPS_DENOM;
        uint256 ptCut       = (fee * AMM_FEE_PT_BPS)       / AMM_FEE_BPS_DENOM;
        uint256 ytCut       = fee - deployerCut - ptCut; // dust to YT

        // 1% to deployer (immediate transfer)
        if (deployerCut > 0) {
            IERC20(shareToken).safeTransfer(treasury, deployerCut);
        }

        // 49.5% to PT holders (accrue via index; stays in contract until claim)
        // Denominator is PT.totalSupply() — same shape as the YT side. The
        // pool's own PT (held at address(this)) also accrues via this index
        // but `_settlePtAmm` skips address(this), so that slice is forfeit
        // (stays in contract; bounded by pool-PT / totalSupply). Using
        // `totalPt` here would over-distribute when outstanding user-PT
        // exceeds pool-PT, since users would each claim more than their
        // proportional slice.
        if (ptCut > 0) {
            address ptToken = pt;
            uint256 ptTs;
            if (ptToken != address(0)) {
                ptTs = IERC20(ptToken).totalSupply();
            }
            if (ptTs > 0) {
                ptAmmRewardIndex += (ptCut * REWARD_SCALE) / ptTs;
            }
        }

        // 49.5% to YT holders (accrue via index)
        if (ytCut > 0) {
            uint256 ytTs;
            address ytToken = yt;
            if (ytToken != address(0)) {
                ytTs = IERC20(ytToken).totalSupply();
            }
            if (ytTs > 0) {
                ytAmmRewardIndex += (ytCut * REWARD_SCALE) / ytTs;
            }
        }
    }

    /// @dev Settle pending PT-side AMM rewards for `user`. Skips address(this)
    ///      so pool-held PT doesn't accrue to the contract. Ed25519 users
    ///      whose HTS facade balanceOf reverts forfeit accrual (bal=0).
    function _settlePtAmm(address user) internal {
        if (user == address(this)) return;

        uint256 bal;
        try IERC20(pt).balanceOf(user) returns (uint256 b) { bal = b; } catch {}

        uint256 g = ptAmmRewardIndex;
        uint256 u = userPtAmmIndex[user];
        if (bal > 0 && g > u) {
            userAccruedPtAmm[user] += (bal * (g - u)) / REWARD_SCALE;
        }
        userPtAmmIndex[user] = g;
    }

    /// @dev Settle pending YT-side AMM rewards. Uses `_ytBal` mirror so Ed25519
    ///      users are supported.
    function _settleYtAmm(address user) internal {
        if (user == address(this)) return;

        uint256 bal = _ytBal[user];
        uint256 g = ytAmmRewardIndex;
        uint256 u = userYtAmmIndex[user];
        if (bal > 0 && g > u) {
            userAccruedYtAmm[user] += (bal * (g - u)) / REWARD_SCALE;
        }
        userYtAmmIndex[user] = g;
    }

    /// @dev Mark user's index to current WITHOUT crediting accrual. Callers
    ///      have already filtered dead addresses via the prior `_settle*` call,
    ///      so we skip the redundant check here to save bytecode.
    function _markPtAmmIndex(address user) internal {
        if (user == address(this)) return;
        userPtAmmIndex[user] = ptAmmRewardIndex;
    }

    function _markYtAmmIndex(address user) internal {
        if (user == address(this)) return;
        userYtAmmIndex[user] = ytAmmRewardIndex;
    }

    /// @notice Claim accrued PT-side AND YT-side AMM rewards (paid in SY-share).
    ///         Returns the amounts paid for each side. Pass receiver = msg.sender
    ///         to claim to self. Frontend can preview by reading
    ///         `userAccruedPtAmm(user) + ptUnsettled` (and YT analogue) directly.
    function claimAmmRewards(address receiver) external nonReentrant returns (uint256 ptAmount, uint256 ytAmount) {
        if (receiver == address(0)) revert ZeroAddress();

        _settlePtAmm(msg.sender);
        ptAmount = userAccruedPtAmm[msg.sender];
        if (ptAmount > 0) userAccruedPtAmm[msg.sender] = 0;

        _settleYtAmm(msg.sender);
        ytAmount = userAccruedYtAmm[msg.sender];
        if (ytAmount > 0) userAccruedYtAmm[msg.sender] = 0;

        uint256 total = ptAmount + ytAmount;
        if (total > 0) {
            IERC20(shareToken).safeTransfer(receiver, total);
        }
    }

    // ───────────────────── post-expiry redemption ─────────────────────

    function redeemAfterExpiry(uint256 ptIn, uint256 ytIn, address receiver)
        external
        nonReentrant
        returns (uint256 syOut)
    {
        if (block.timestamp < expiry) revert MarketNotExpired();
        if (receiver == address(0)) revert ZeroAddress();
        if (ytIn != 0) revert YTBurnNotPermitted();
        if (ptIn == 0) revert ZeroAmount();

        _harvestRewards();
        _settleRewards(msg.sender);
        // Lock in PRE-burn PT-AMM accrual so users redeeming get their
        // accumulated AMM-fee share.
        _settlePtAmm(msg.sender);

        _burnPt(msg.sender, ptIn);
        syOut = ptIn;

        IERC20(shareToken).safeTransfer(receiver, syOut);
        emit RedeemedAfterExpiry(msg.sender, receiver, ptIn, syOut);
    }

    // ───────────────────── governance ─────────────────────

    function setTreasury(address newTreasury) external onlyRole(ADMIN_ROLE) {
        if (newTreasury == address(0)) revert ZeroAddress();
        treasury = newTreasury;
    }

    function setFee(int256 lnFeeRateRoot_, uint256 reserveFeePercent_) external onlyRole(ADMIN_ROLE) {
        MarketMath.validateLnFeeRateRoot(lnFeeRateRoot_);
        if (reserveFeePercent_ > MAX_RESERVE_FEE_PERCENT) revert ReserveFeeTooHigh();
        lnFeeRateRoot = lnFeeRateRoot_;
        reserveFeePercent = reserveFeePercent_;
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
        ms.totalPt = PMath.toInt(totalPt);
        ms.totalSy = PMath.toInt(totalSy);
        ms.totalLp = PMath.toInt(IERC20(lp).totalSupply());
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
        return interfaceId == type(IFissionMarketCommon).interfaceId
            || super.supportsInterface(interfaceId);
    }
}
