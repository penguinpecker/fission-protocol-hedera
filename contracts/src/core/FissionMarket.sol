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

    /// @notice Hard cap on `reserveFeePercent` — fraction of the swap fee routed to
    ///         treasury, expressed in percent (1..100). Anything above 100 would route
    ///         more than the full fee.
    uint256 public constant MAX_RESERVE_FEE_PERCENT = 100;

    // ───────────────────── immutables ─────────────────────

    IStandardizedYield public immutable sy;
    uint256 public immutable expiry;
    int256 public immutable scalarRoot;
    address public immutable factory;
    uint8 internal immutable _assetDecimals;

    // ───────────────────── one-shot setters ─────────────────────

    /// @notice The HTS-native PT token. Market is treasury + supplyKey + wipeKey holder.
    ///         `pt.balanceOf(user)` etc. work via the Hedera ERC-20 facade.
    address public pt;

    /// @notice The HTS-native YT token. Market is treasury + supplyKey + freezeKey + wipeKey.
    ///         freezeDefault = FALSE — required because HIP-904 auto-association inherits
    ///         the freeze default; with default=true a recipient gets auto-frozen at the
    ///         exact moment of transfer, deadlocking the mint. The Market explicitly
    ///         freezes every recipient AFTER each transfer (`_ytFrozen[to] = true`),
    ///         making subsequent transfers fail with `ACCOUNT_FROZEN_FOR_TOKEN` and
    ///         requiring all moves to route through Market — closing the yield-leakage
    ///         exploit (no fresh-address sneak transfers). For repeat mints to an
    ///         already-frozen recipient, `_mintYt` unfreezes → transfers → refreezes.
    address public yt;

    /// @dev True after Market has frozen this account on YT — i.e. they've previously
    ///      received YT. Used to decide whether `_mintYt` needs to unfreeze first.
    mapping(address => bool) internal _ytFrozen;

    /// @notice Contract-tracked YT balances. The Hedera HTS ERC-20 facade's
    ///         `balanceOf(addr)` reverts (or returns 0) when `addr` is the long-zero
    ///         EVM representation of an Ed25519 HAPI account — meaning yield accrual
    ///         that read `IERC20(yt).balanceOf(user)` would silently see zero for
    ///         Ed25519 holders and never owe them their share. Because YT is
    ///         freeze-by-default and only this Market can mint/burn it, this mapping
    ///         is the authoritative source for yield distribution and is independent
    ///         of the HTS facade's caller-resolution quirks.
    mapping(address => uint256) internal _ytBal;

    /// @notice The HTS-native LP token. Market is treasury + supplyKey + wipeKey holder.
    ///         No freeze key — LP is freely transferable (pausing trading would strand
    ///         users on secondary markets).
    address public lp;

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
    error OnlyFactory();
    error InsufficientOutput();
    error InsufficientLiquidity();
    error ZeroAmount();
    error ZeroAddress();
    error ReserveFeeTooHigh(uint256 given, uint256 max);
    error SYRateBelowOne(uint256 syRate);
    error InsufficientYt(uint256 have, uint256 want);

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

    // onlyYT removed — HTS YT has no _update hook so the legacy callback is gone.

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
        // factory_ == address(0) → fall back to msg.sender for backward-compat with
        // tests / scripts that deploy FissionMarket directly without a deployer.
        factory = factory_ == address(0) ? msg.sender : factory_;
        _grantRole(ADMIN_ROLE, admin_);
        _grantRole(PAUSER_ROLE, admin_);
    }

    /// @notice Asset decimals (matches sy.decimals(), per ERC-5115). LP HTS token has
    ///         its own decimals (18) set at HTS creation; query via `IERC20(lp)`.
    function assetDecimals() external view returns (uint8) {
        return _assetDecimals;
    }

    // ───────────────────── one-shot setup ─────────────────────

    /// @notice One-shot setup: Market self-creates BOTH HTS-native PT (transferable)
    ///         and HTS-native YT (frozen, AMM-only). Caller must attach HBAR to
    ///         msg.value covering the two createFungible network fees (~2 HBAR mainnet;
    ///         0 in mock tests).
    /// @dev    Trust: Market holds supply + wipe keys on PT; supply + freeze + wipe on YT.
    ///         The freeze key gives Market the authority to unfreeze/refreeze on demand —
    ///         used during YT mint to ferry tokens through `freezeDefault = true`.
    ///         Wipe is used for burn-from-arbitrary-user (merge/redeemAfterExpiry/swap).
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
        onlyFactory
    {
        if (pt != address(0)) revert TokensAlreadySet();

        // Split msg.value across the 3 HTS token creates. Sending msg.value to each
        // would attempt to drain `address(this).balance` three times — only the first
        // call would have funds; the other two would revert. Each token (with 90d
        // auto-renew) costs ~15 HBAR mainnet, so caller should send ≥45 HBAR.
        uint256 perToken = msg.value / 3;

        // PT: transferable HTS token. SUPPLY + WIPE keys.
        pt = _createHtsToken(ptName, ptSymbol, false, true, _assetDecimals, perToken);
        // YT: AMM-only HTS token. SUPPLY + FREEZE + WIPE, freezeDefault=FALSE
        // (HIP-904 auto-associate race — see `yt` storage docstring).
        yt = _createHtsToken(ytName, ytSymbol, true, true, _assetDecimals, perToken);
        // LP: transferable HTS token, 18 decimals (independent of SY decimals).
        // Last call gets msg.value - 2*perToken so any rounding remainder is included.
        lp = _createHtsToken(lpName, lpSymbol, false, true, 18, msg.value - 2 * perToken);

        // Associate the SY shareToken so initialize() / split() / swaps can transfer
        // SY shares INTO this market. PT/YT/LP self-associate as treasury at create
        // time; only the externally-issued SY shareToken needs an explicit associate.
        HtsHelpers.associateIfNeeded(address(this), sy.shareToken());

        emit TokensInitialized(pt, yt);
    }

    /// @dev Build a fungible HTS token spec. `withFreezeKey` adds key bit 4; `withWipeKey`
    ///      adds key bit 8. SUPPLY (16) is always added. Treasury = this Market.
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
        keys[idx++] = HtsHelpers.makeKey(16, address(this)); // SUPPLY
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

    /// @notice Address-typed sibling of `pt()` — used by ActionRouter via IFissionMarketCommon.
    function ptAddr() external view returns (address) {
        return pt;
    }

    /// @notice Address-typed sibling of `yt()` — used by ActionRouter via IFissionMarketCommon.
    function ytAddr() external view returns (address) {
        return yt;
    }

    /// @dev Mint HTS PT to `to`: mint to treasury, transfer out (PT is unfrozen).
    function _mintPt(address to, uint256 amount) internal {
        HtsHelpers.mintToTreasury(pt, amount);
        if (to != address(this)) {
            HtsHelpers.transfer(pt, address(this), to, amount);
        }
    }

    /// @dev Burn HTS PT: treasury via burnFromTreasury; arbitrary accounts via wipe.
    function _burnPt(address from, uint256 amount) internal {
        if (from == address(this)) {
            HtsHelpers.burnFromTreasury(pt, amount);
        } else {
            HtsHelpers.wipeFrom(pt, from, amount);
        }
    }

    /// @dev Mint HTS YT to `to`. First-time recipients: HIP-904 auto-association
    ///      brings them in unfrozen (freezeDefault=false), transfer succeeds, then
    ///      Market freezes them. Repeat recipients are already frozen — Market
    ///      unfreezes first.
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

    /// @dev Burn HTS YT: wipe REQUIRES the account to be unfrozen first
    ///      (Hedera HTS returns code 165 = ACCOUNT_FROZEN_FOR_TOKEN otherwise).
    ///      Unfreeze, wipe, and refreeze if YT remains.
    function _burnYt(address from, uint256 amount) internal {
        if (from == address(this)) {
            HtsHelpers.burnFromTreasury(yt, amount);
        } else {
            bool wasFrozen = _ytFrozen[from];
            if (wasFrozen) HtsHelpers.unfreeze(yt, from);
            HtsHelpers.wipeFrom(yt, from, amount);
            _ytBal[from] -= amount;
            // Use internal `_ytBal` instead of the HTS facade — the facade reverts
            // for Ed25519 long-zero EVM addresses.
            if (wasFrozen && _ytBal[from] > 0) {
                HtsHelpers.freeze(yt, from);
            } else if (wasFrozen) {
                _ytFrozen[from] = false;
            }
            return;
        }
        _ytBal[from] -= amount;
    }

    /// @notice Contract-tracked YT balance. Use this for any consumer that needs a
    ///         reliable per-user YT balance on Hedera — `IERC20(yt).balanceOf(addr)`
    ///         is unreliable when `addr` is the long-zero EVM representation of an
    ///         Ed25519 HAPI account.
    function ytBalanceOf(address user) external view returns (uint256) {
        return _ytBal[user];
    }

    /// @dev Mint HTS LP to `to`: mint to treasury, transfer out (LP is unfrozen).
    function _mintLp(address to, uint256 amount) internal {
        HtsHelpers.mintToTreasury(lp, amount);
        if (to != address(this)) {
            HtsHelpers.transfer(lp, address(this), to, amount);
        }
    }

    /// @dev Burn HTS LP. Treasury via burnFromTreasury; arbitrary accounts via wipe.
    function _burnLp(address from, uint256 amount) internal {
        if (from == address(this)) {
            HtsHelpers.burnFromTreasury(lp, amount);
        } else {
            HtsHelpers.wipeFrom(lp, from, amount);
        }
    }

    /// @notice Admin-gated wipe of caller's own YT. Used during bootstrap to dispose
    ///         of the YT minted as a side-effect of `split` (admin needs PT to call
    ///         `initialize`, but split also produces matching YT). Settles accrued
    ///         yield first so the caller's claim isn't silently destroyed.
    /// @dev    NOT a general "burn-my-YT" footgun — gated to ADMIN_ROLE which is the
    ///         protocol's Safe in production. Regular users dispose of YT via `merge`
    ///         (requires matching PT) or by holding it for residual yield post-expiry.
    function seedBurnYt(uint256 amount) external onlyRole(ADMIN_ROLE) {
        if (amount == 0) revert ZeroAmount();
        _accrue(msg.sender);
        _burnYt(msg.sender, amount);
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
        whenNotPaused
        onlyRole(ADMIN_ROLE)
        preExpiry
        returns (uint256 lpOut)
    {
        if (pt == address(0)) revert TokensNotSet();
        if (lp != address(0) && IERC20(lp).totalSupply() != 0) revert AlreadyInitialized();
        if (syIn == 0 || ptIn == 0) revert ZeroAmount();
        if (reserveFeePercent_ > MAX_RESERVE_FEE_PERCENT) revert ReserveFeeTooHigh(reserveFeePercent_, MAX_RESERVE_FEE_PERCENT);
        MarketMath.validateLnFeeRateRoot(lnFeeRateRoot_);

        // Compute initial SY rate up-front so we can floor-check it BEFORE pulling
        // funds. (H-1 audit fix.) An SY rate < 1e18 at init would cause PT redemption
        // post-expiry to pay > 1 SY per PT, draining backing and breaking solvency.
        uint256 syIndexU = sy.exchangeRate();
        if (syIndexU < PMath.ONE) revert SYRateBelowOne(syIndexU);

        IERC20(sy.shareToken()).safeTransferFrom(msg.sender, address(this), syIn);
        IERC20(pt).safeTransferFrom(msg.sender, address(this), ptIn);

        uint256 lpRaw = PMath.sqrt(syIn * ptIn);
        if (lpRaw <= MarketMath.MINIMUM_LIQUIDITY) revert InsufficientLiquidity();
        lpOut = lpRaw - MarketMath.MINIMUM_LIQUIDITY;
        // burn-to-DEAD donation defence (Uniswap v2 pattern)
        // Lock MINIMUM_LIQUIDITY in market treasury (no withdraw path → permanent
        // lock). On Hedera, 0xdEaD isn't HTS-associated with the LP, so transfers
        // there revert with code 184 (TOKEN_NOT_ASSOCIATED_TO_ACCOUNT).
        _mintLp(address(this), MarketMath.MINIMUM_LIQUIDITY);
        _mintLp(msg.sender, lpOut);

        totalSy = syIn;
        totalPt = ptIn;
        lnFeeRateRoot = lnFeeRateRoot_;
        reserveFeePercent = reserveFeePercent_;

        // Compute and persist initial implied rate.
        MarketMath.MarketState memory ms = _loadState();
        int256 syIndex = int256(syIndexU);
        lastLnImpliedRate = MarketMath.setInitialLnImpliedRate(ms, syIndex, initialAnchor, block.timestamp);

        // Initialize global yield index.
        globalIndex = uint256(syIndex);

        emit Initialized(syIn, ptIn, lpOut, lnFeeRateRoot_, reserveFeePercent_);
    }

    // ───────────────────── split / merge ─────────────────────

    /// @notice 1 SY → 1 PT + 1 YT. No fee, no AMM math.
    /// @dev    Pre-initialize splits are intentionally permitted: the bootstrap flow
    ///         is "admin splits a small seed amount → uses the PT to call
    ///         `initialize`". The audit-noted L-2 sentinel collision (userIndex == 0
    ///         vs globalIndex == 0) is harmless after the M-3 cold-start fix:
    ///         `sy.exchangeRate()` now returns `PMath.ONE` at genesis, so the first
    ///         `_updateGlobalIndex` call sets `globalIndex = 1e18` immediately.
    function split(uint256 amount) external nonReentrant whenNotPaused preExpiry returns (uint256) {
        return _split(amount, msg.sender, msg.sender);
    }

    /// @notice Split with explicit recipients for PT and YT. Used by ActionRouter so YT
    ///         can be minted directly to the end user (it's frozen — the router can't
    ///         custody-and-forward like it does for PT). PT receiver is typically the
    ///         router (which then sells/forwards), YT receiver is the end user.
    function splitTo(uint256 amount, address ptReceiver, address ytReceiver)
        external
        nonReentrant
        whenNotPaused
        preExpiry
        returns (uint256)
    {
        if (ptReceiver == address(0) || ytReceiver == address(0)) revert ZeroAddress();
        return _split(amount, ptReceiver, ytReceiver);
    }

    function _split(uint256 amount, address ptReceiver, address ytReceiver) internal returns (uint256) {
        if (amount == 0) revert ZeroAmount();
        if (pt == address(0)) revert TokensNotSet();

        // Accrue against the YT recipient — they're the one whose userIndex will move.
        _accrue(ytReceiver);

        IERC20(sy.shareToken()).safeTransferFrom(msg.sender, address(this), amount);
        _mintPt(ptReceiver, amount);
        _mintYt(ytReceiver, amount);

        emit Split(msg.sender, amount);
        return amount;
    }

    /// @notice 1 PT + 1 YT → 1 SY. Pre-expiry only.
    function merge(uint256 amount) external nonReentrant preExpiry returns (uint256) {
        if (amount == 0) revert ZeroAmount();
        if (pt == address(0)) revert TokensNotSet();

        _accrue(msg.sender);

        _burnPt(msg.sender, amount);
        _burnYt(msg.sender, amount);
        IERC20(sy.shareToken()).safeTransfer(msg.sender, amount);

        emit Merge(msg.sender, amount);
        return amount;
    }

    // ───────────────────── swaps ─────────────────────

    function swapExactPtForSy(uint256 ptIn, uint256 minSyOut, address receiver)
        external
        nonReentrant
        whenNotPaused
        preExpiry
        returns (uint256 syOut)
    {
        if (ptIn == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();

        // Pull PT first so subsequent state reflects updated balance.
        IERC20(pt).safeTransferFrom(msg.sender, address(this), ptIn);

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
        IERC20(sy.shareToken()).safeTransfer(receiver, syOut);
        if (netSyToReserve > 0) {
            IERC20(sy.shareToken()).safeTransfer(treasury, uint256(netSyToReserve));
            totalSy -= uint256(netSyToReserve);
        }

        emit Swap(msg.sender, receiver, -int256(ptIn), netSy, netSyFee, netSyToReserve);
    }

    /// @notice Sell YT pre-expiry for SY. Atomically: AMM "buys" `ytIn` PT from
    ///         its own pool, the Market pairs that PT with the user's YT and burns
    ///         both (merge semantics), the released backing SY funds (a) the AMM
    ///         settlement (`syOwed`) and (b) the user's sale proceeds (`ytIn - syOwed`).
    /// @dev    Settles accrued yield via `_accrue` first so the user keeps the
    ///         yield earned while they held the YT.
    /// @dev    `_ytBal[msg.sender]` is the source of truth (Ed25519-safe — see the
    ///         `_ytBal` storage doc for why we don't read the HTS facade here).
    function swapExactYtForSy(uint256 ytIn, uint256 minSyOut, address receiver)
        external
        nonReentrant
        whenNotPaused
        preExpiry
        returns (uint256 syOut)
    {
        if (ytIn == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();

        uint256 userYt = _ytBal[msg.sender];
        if (userYt < ytIn) revert InsufficientYt(userYt, ytIn);

        // Settle accrued yield on the pre-burn YT balance so the user keeps it.
        _accrue(msg.sender);

        // Curve: same math as `swapExactSyForPt(ptOut=ytIn)` — AMM conceptually sells
        // `ytIn` PT (out of pool) for `syOwed` SY (received back).
        MarketMath.MarketState memory ms = _loadState();
        int256 syIndex = int256(sy.exchangeRate());
        MarketMath.PreCompute memory pre = MarketMath.getMarketPreCompute(ms, syIndex, block.timestamp);
        (int256 netSy, int256 netSyFee, int256 netSyToReserve, int256 newRate) =
            MarketMath.executeTradeCore(ms, pre, int256(ytIn), block.timestamp);

        if (netSy >= 0) revert InsufficientOutput();
        uint256 syOwed = uint256(-netSy);
        if (syOwed >= ytIn) revert InsufficientOutput();
        syOut = ytIn - syOwed;
        if (syOut < minSyOut) revert InsufficientOutput();

        // AMM-pool accounting: -ytIn PT (pool sold them), +syOwed SY (pool received).
        totalPt -= ytIn;
        totalSy += syOwed;
        lastLnImpliedRate = newRate;

        // Burn the PT from the pool's inventory + wipe the user's YT (paired merge).
        _burnPt(address(this), ytIn);
        _burnYt(msg.sender, ytIn);

        // Pay user their sale proceeds.
        IERC20(sy.shareToken()).safeTransfer(receiver, syOut);

        if (netSyToReserve > 0) {
            IERC20(sy.shareToken()).safeTransfer(treasury, uint256(netSyToReserve));
            totalSy -= uint256(netSyToReserve);
        }

        emit Swap(msg.sender, receiver, int256(ytIn), netSy, netSyFee, netSyToReserve);
    }

    function swapExactSyForPt(uint256 syInMax, uint256 ptOut, address receiver)
        external
        nonReentrant
        whenNotPaused
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
        IERC20(sy.shareToken()).safeTransferFrom(msg.sender, address(this), syIn);
        IERC20(pt).safeTransfer(receiver, ptOut);

        totalPt -= ptOut;
        totalSy += syIn;
        lastLnImpliedRate = newRate;

        if (netSyToReserve > 0) {
            IERC20(sy.shareToken()).safeTransfer(treasury, uint256(netSyToReserve));
            totalSy -= uint256(netSyToReserve);
        }

        emit Swap(msg.sender, receiver, int256(ptOut), netSy, netSyFee, netSyToReserve);
    }

    // ───────────────────── liquidity ─────────────────────

    function addLiquidity(uint256 syIn, uint256 ptIn, uint256 minLpOut, address receiver)
        external
        nonReentrant
        whenNotPaused
        preExpiry
        returns (uint256 lpOut)
    {
        if (syIn == 0 || ptIn == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();
        if (lp == address(0) || IERC20(lp).totalSupply() == 0) revert NotInitialized();

        MarketMath.MarketState memory ms = _loadState();
        (int256 lpToMint, int256 syUsed, int256 ptUsed,) =
            MarketMath.addLiquidityCore(ms, int256(syIn), int256(ptIn));

        lpOut = uint256(lpToMint);
        if (lpOut < minLpOut) revert InsufficientOutput();

        IERC20(sy.shareToken()).safeTransferFrom(msg.sender, address(this), uint256(syUsed));
        IERC20(pt).safeTransferFrom(msg.sender, address(this), uint256(ptUsed));

        totalSy += uint256(syUsed);
        totalPt += uint256(ptUsed);
        _mintLp(receiver, lpOut);

        emit LiquidityAdded(msg.sender, receiver, uint256(syUsed), uint256(ptUsed), lpOut);
    }

    /// @notice Burn LP, return SY + PT proportional pre-expiry. Post-expiry, auto-redeem
    ///         the PT share to SY at the frozen rate so LP exits don't compete with PT
    ///         redeemers for the SY backing.
    /// @dev    H-4 audit fix (Pendle V3 fidelity): without this, post-expiry an LP could
    ///         race ahead of `redeemAfterExpiry` callers, drain `totalSy`, and dump the
    ///         received PT in a secondary market — leaving PT-redeemers' txs reverting
    ///         on safeTransfer when SY backing fell short. Auto-redeem at the frozen
    ///         globalIndex makes this impossible.
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

        _burnLp(msg.sender, lpIn);
        totalSy -= syOut;
        totalPt -= ptOut;

        if (block.timestamp >= expiry) {
            // Freeze the global index if not yet frozen, then auto-redeem the PT share
            // to SY at the frozen rate. LP receives SY only.
            _updateGlobalIndex();
            uint256 ptToSy = (ptOut * PMath.ONE) / globalIndex;
            // Burn the PT slice we just allocated to the LP — it never leaves the contract.
            // (We didn't `safeTransfer` it out yet, so it's still in the market's PT
            // balance from past splits / past trades.)
            _burnPt(address(this), ptOut);
            syOut += ptToSy;
            ptOut = 0;
        }

        if (syOut < minSyOut || ptOut < minPtOut) revert InsufficientOutput();

        IERC20(sy.shareToken()).safeTransfer(receiver, syOut);
        if (ptOut > 0) IERC20(pt).safeTransfer(receiver, ptOut);

        emit LiquidityRemoved(msg.sender, receiver, lpIn, syOut, ptOut);
    }

    // ───────────────────── yield accrual ─────────────────────

    /// @notice Bring the global yield index up to the current SY rate, but freeze it at expiry.
    /// @dev    H-1 defence: the index is also floored at 1e18, so a buggy/manipulated SY
    ///         that briefly returns < 1e18 cannot cause PT to redeem for > 1 SY.
    function _updateGlobalIndex() internal {
        if (expiryIndexFrozen) return;
        if (block.timestamp >= expiry) {
            uint256 cur = sy.exchangeRate();
            if (cur < PMath.ONE) cur = PMath.ONE;
            if (cur > globalIndex) globalIndex = cur;
            expiryIndexFrozen = true;
            return;
        }
        uint256 c = sy.exchangeRate();
        if (c < PMath.ONE) c = PMath.ONE;
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
        if (gi > ui && yt != address(0)) {
            // Use internal `_ytBal` instead of the HTS facade — see `_ytBal` doc.
            uint256 ytBal = _ytBal[user];
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

    function claimYield(address receiver) external nonReentrant returns (uint256 amount) {
        if (receiver == address(0)) revert ZeroAddress();
        _accrue(msg.sender);
        amount = userOwed[msg.sender];
        if (amount == 0) return 0;
        userOwed[msg.sender] = 0;
        IERC20(sy.shareToken()).safeTransfer(receiver, amount);
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
        if (gi > ui && yt != address(0)) {
            uint256 ytBal = _ytBal[user];
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
            _burnPt(msg.sender, ptIn);
            // PT redemption: each PT pays out 1e18 / globalIndex SY-shares.
            syOut = (ptIn * 1e18) / globalIndex;
        }
        if (ytIn > 0) {
            _burnYt(msg.sender, ytIn);
            // YT itself has no redeemable value post-expiry; user collects their yield via claimYield.
        }

        if (syOut > 0) {
            IERC20(sy.shareToken()).safeTransfer(receiver, syOut);
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
        if (reserveFeePercent_ > MAX_RESERVE_FEE_PERCENT) revert ReserveFeeTooHigh(reserveFeePercent_, MAX_RESERVE_FEE_PERCENT);
        lnFeeRateRoot = lnFeeRateRoot_;
        reserveFeePercent = reserveFeePercent_;
        emit FeeUpdated(lnFeeRateRoot_, reserveFeePercent_);
    }

    /// @notice Pause new entry into the market. While paused: `initialize`, `split`,
    ///         `swapExactPtForSy`, `swapExactSyForPt`, and `addLiquidity` revert.
    /// @dev    `merge`, `removeLiquidity`, `claimYield`, `redeemAfterExpiry`, and the
    ///         YT-balance accrual callback remain callable so users can always exit
    ///         and collect what they're owed even with the market paused.
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
        // L-7 audit fix: PMath.toInt reverts on uint256→int256 overflow rather than
        // silently wrapping to a negative value (which would corrupt the AMM math).
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
