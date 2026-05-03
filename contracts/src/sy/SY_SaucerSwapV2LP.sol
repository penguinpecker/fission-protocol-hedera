// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {SYBase} from "./SYBase.sol";
import {IStandardizedYield} from "../interfaces/IStandardizedYield.sol";
import {IUniswapV3PositionManager} from "../interfaces/IUniswapV3PositionManager.sol";
import {PMath} from "../libraries/PMath.sol";

/// @title  SY_SaucerSwapV2LP — Pendle-Kyber-style SY for SaucerSwap V2 (V3-fork) LP.
/// @notice Owns ONE NFT position with hard-coded `tickLower`/`tickUpper`. Never rebalances.
///         Shares are minted 1:1 with V3 `liquidity` units. `exchangeRate()` returns
///         `PMath.ONE` (1e18) — the share price never moves. All swap-fee yield is paid
///         out as reward tokens (token0 + token1) via the ERC-5115 reward surface.
///
///         Why this shape — see Pendle's `PendleKyberElasticSY` / `PendleAerodromeVolatileSY`:
///         V3-style concentrated-liquidity NFTs cannot be aggregated into one fungible
///         per-share appreciating rate (range-specific `feeGrowthInside`). The clean
///         workaround Pendle adopted is "exchangeRate = 1, yield via the reward token
///         side door". This preserves SY monotonicity by construction (the rate literally
///         never changes), at the cost of: (a) yield is not compounded into PT/SY price,
///         (b) when price drifts out of range the position earns zero until it returns.
///
/// @dev    Standard ERC-5115 single-tokenIn `deposit`/`redeem` are NOT supported here —
///         V3 LP requires a (token0, token1) pair, which doesn't fit the single-token
///         interface. Use `depositLiquidity` / `redeemLiquidity` instead. `getTokensIn()`
///         returns an empty array to signal this; downstream Routers must dispatch on
///         `assetType == LIQUIDITY` and call the dedicated entry points.
///
///         Reward distribution: standard pro-rata-by-share index pattern. The OZ ERC20
///         `_update(from, to, value)` hook settles both sides' pending rewards before
///         every mint/burn/transfer, so transfers carry no reward leakage.
///
///         Re-entrancy / fee-accounting safety: every state-changing entry calls
///         `_harvest()` BEFORE updating any shares, so the global reward index always
///         reflects all fees accrued up to the current block before a new shareholder
///         set takes effect. This is the same ordering Pendle's KyberElastic uses.
contract SY_SaucerSwapV2LP is SYBase {
    using SafeERC20 for IERC20;
    using PMath for uint256;

    // ───────────────────── roles ─────────────────────

    bytes32 public constant HARVESTER_ROLE = keccak256("HARVESTER_ROLE");

    // ───────────────────── reward index scale ─────────────────────

    /// @dev 1e18-scale for reward-per-share index. Same precision Pendle uses.
    uint256 internal constant REWARD_SCALE = 1e18;

    // ───────────────────── immutables ─────────────────────

    /// @notice The SaucerSwap V2 NonFungiblePositionManager.
    IUniswapV3PositionManager public immutable npm;

    address public immutable token0;
    address public immutable token1;
    uint24 public immutable poolFee;
    int24 public immutable tickLower;
    int24 public immutable tickUpper;

    uint8 internal immutable _token0Decimals;
    uint8 internal immutable _token1Decimals;

    // ───────────────────── position state ─────────────────────

    /// @notice The V3 NFT id this SY owns. `0` until first deposit (NPM token IDs start
    ///         at 1, so 0 is a safe sentinel).
    uint256 public positionTokenId;

    // ───────────────────── reward index state ─────────────────────

    /// @notice Cumulative reward-per-share for token0/token1, scaled by REWARD_SCALE.
    uint256 public globalRewardIndex0;
    uint256 public globalRewardIndex1;

    /// @notice Last `globalRewardIndex{0,1}` observed for each user.
    mapping(address => uint256) public userRewardIndex0;
    mapping(address => uint256) public userRewardIndex1;

    /// @notice Settled-but-unclaimed rewards in token0/token1 units.
    mapping(address => uint256) public accruedRewards0;
    mapping(address => uint256) public accruedRewards1;

    // ───────────────────── errors ─────────────────────

    error UseDepositLiquidityInstead();
    error UseRedeemLiquidityInstead();
    error TokensIdentical();
    error InvalidTickRange();
    error MintFailed();
    error InsufficientLiquidityOut();
    error PositionNotInitialized();

    // ───────────────────── events ─────────────────────

    event PositionMinted(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
    event DepositLiquidity(
        address indexed caller,
        address indexed receiver,
        uint256 amount0Used,
        uint256 amount1Used,
        uint128 liquidity
    );
    event RedeemLiquidity(
        address indexed caller,
        address indexed receiver,
        uint256 shares,
        uint256 amount0Out,
        uint256 amount1Out
    );
    event Harvested(uint256 amount0, uint256 amount1);

    // ───────────────────── construction ─────────────────────

    /// @param token0_ V3 pool token0 (lower address sort).
    /// @param token1_ V3 pool token1 (higher address sort).
    /// @param fee_ V3 pool fee tier (e.g. 1500 = 0.15%).
    /// @param tickLower_ immutable lower tick of the SY's position.
    /// @param tickUpper_ immutable upper tick of the SY's position.
    /// @param npm_ the SaucerSwap V2 NonFungiblePositionManager.
    constructor(
        string memory name_,
        string memory symbol_,
        address token0_,
        address token1_,
        uint24 fee_,
        int24 tickLower_,
        int24 tickUpper_,
        address npm_,
        address admin_,
        uint48 adminTransferDelay_
    )
        SYBase(
            name_,
            symbol_,
            address(0), // see assetInfo() — no single underlying
            18, // SY share decimals; V3 liquidity is 128-bit unitless, render as 18-dec
            admin_,
            adminTransferDelay_
        )
    {
        if (token0_ == token1_) revert TokensIdentical();
        if (token0_ == address(0) || token1_ == address(0) || npm_ == address(0)) revert ZeroAddress();
        if (tickLower_ >= tickUpper_) revert InvalidTickRange();

        token0 = token0_;
        token1 = token1_;
        poolFee = fee_;
        tickLower = tickLower_;
        tickUpper = tickUpper_;
        npm = IUniswapV3PositionManager(npm_);

        _token0Decimals = IERC20Metadata(token0_).decimals();
        _token1Decimals = IERC20Metadata(token1_).decimals();

        _grantRole(HARVESTER_ROLE, admin_);
    }

    error ZeroAddress();

    // ───────────────────── ERC-5115 deposit/redeem (intentionally disabled) ─────────────────────

    /// @inheritdoc IStandardizedYield
    /// @dev Single-token deposit doesn't fit V3 LP. Use `depositLiquidity`.
    function deposit(address, address, uint256, uint256)
        external
        payable
        override
        returns (uint256)
    {
        revert UseDepositLiquidityInstead();
    }

    /// @inheritdoc IStandardizedYield
    /// @dev Single-token redeem doesn't fit V3 LP. Use `redeemLiquidity`.
    function redeem(address, uint256, address, uint256, bool)
        external
        override
        returns (uint256)
    {
        revert UseRedeemLiquidityInstead();
    }

    function previewDeposit(address, uint256) external pure override returns (uint256) {
        revert UseDepositLiquidityInstead();
    }

    function previewRedeem(address, uint256) external pure override returns (uint256) {
        revert UseRedeemLiquidityInstead();
    }

    /// @dev Abstract in SYBase. Never reached because external `deposit` is overridden
    ///      to revert; required only to satisfy the compiler.
    function _deposit(address, uint256) internal pure override returns (uint256) {
        revert UseDepositLiquidityInstead();
    }

    /// @dev Same as `_deposit` — unreachable but required by the abstract base.
    function _redeem(address, address, uint256) internal pure override returns (uint256) {
        revert UseRedeemLiquidityInstead();
    }

    // ───────────────────── dual-token deposit/redeem ─────────────────────

    /// @notice Deposit (amount0, amount1) into the V3 position; mint shares 1:1 with
    ///         liquidity added. Excess of either token is refunded.
    /// @param amount0Desired max token0 the caller commits.
    /// @param amount1Desired max token1 the caller commits.
    /// @param receiver who gets the SY shares.
    /// @param minLiquidity slippage protection — revert if minted liquidity is below this.
    function depositLiquidity(
        uint256 amount0Desired,
        uint256 amount1Desired,
        address receiver,
        uint128 minLiquidity
    ) external nonReentrant whenNotPaused returns (uint128 liquidity) {
        if (receiver == address(0)) revert ZeroAddress();
        if (amount0Desired == 0 && amount1Desired == 0) revert AmountZero();

        // Pull tokens; both can be zero if the user wants single-sided (V3 allows it
        // when the active tick is outside the range on the appropriate side).
        if (amount0Desired > 0) {
            IERC20(token0).safeTransferFrom(msg.sender, address(this), amount0Desired);
            IERC20(token0).forceApprove(address(npm), amount0Desired);
        }
        if (amount1Desired > 0) {
            IERC20(token1).safeTransferFrom(msg.sender, address(this), amount1Desired);
            IERC20(token1).forceApprove(address(npm), amount1Desired);
        }

        uint256 amount0Used;
        uint256 amount1Used;

        if (positionTokenId == 0) {
            // First-ever deposit — mint the SY's one position NFT.
            IUniswapV3PositionManager.MintParams memory mp = IUniswapV3PositionManager.MintParams({
                token0: token0,
                token1: token1,
                fee: poolFee,
                tickLower: tickLower,
                tickUpper: tickUpper,
                amount0Desired: amount0Desired,
                amount1Desired: amount1Desired,
                amount0Min: 0,
                amount1Min: 0,
                recipient: address(this),
                deadline: block.timestamp
            });
            uint256 newTokenId;
            (newTokenId, liquidity, amount0Used, amount1Used) = npm.mint(mp);
            if (newTokenId == 0) revert MintFailed();
            positionTokenId = newTokenId;
            emit PositionMinted(newTokenId, liquidity, amount0Used, amount1Used);
        } else {
            // Subsequent deposits — harvest BEFORE adding liquidity so the existing
            // shareholder set is paid for everything earned up to this block.
            _harvest();

            IUniswapV3PositionManager.IncreaseLiquidityParams memory ip =
                IUniswapV3PositionManager.IncreaseLiquidityParams({
                    tokenId: positionTokenId,
                    amount0Desired: amount0Desired,
                    amount1Desired: amount1Desired,
                    amount0Min: 0,
                    amount1Min: 0,
                    deadline: block.timestamp
                });
            (liquidity, amount0Used, amount1Used) = npm.increaseLiquidity(ip);
        }

        if (liquidity < minLiquidity) revert InsufficientLiquidityOut();
        if (liquidity == 0) revert InsufficientLiquidityOut();

        // Clear approvals + refund unused.
        if (amount0Desired > 0) IERC20(token0).forceApprove(address(npm), 0);
        if (amount1Desired > 0) IERC20(token1).forceApprove(address(npm), 0);
        if (amount0Used < amount0Desired) {
            IERC20(token0).safeTransfer(msg.sender, amount0Desired - amount0Used);
        }
        if (amount1Used < amount1Desired) {
            IERC20(token1).safeTransfer(msg.sender, amount1Desired - amount1Used);
        }

        // _update hook (overridden below) settles `receiver`'s rewards using their
        // pre-mint balance, then updates their userIndex to current global. Future
        // accrual starts cleanly from the new balance.
        _mint(receiver, uint256(liquidity));

        emit DepositLiquidity(msg.sender, receiver, amount0Used, amount1Used, liquidity);
    }

    /// @notice Burn `shares` and pay out the corresponding (amount0, amount1) to receiver.
    /// @dev    Harvests pending fees first, then decreases liquidity by exactly `shares`
    ///         (since shares == liquidity 1:1), then collects principal to receiver.
    /// @param  amount0Min slippage floor — V3 NPM reverts if it'd return less token0.
    /// @param  amount1Min slippage floor — V3 NPM reverts if it'd return less token1.
    /// @dev    Slippage matters here because V3 redemption amounts depend on the pool's
    ///         tick at execution time. A sandwich attacker can swap to skew the tick,
    ///         take profit on the user's lopsided redeem, and swap back. The min params
    ///         force the NPM to revert if amounts come out below the user's tolerance.
    function redeemLiquidity(uint256 shares, uint256 amount0Min, uint256 amount1Min, address receiver)
        external
        nonReentrant
        returns (uint256 amount0, uint256 amount1)
    {
        if (positionTokenId == 0) revert PositionNotInitialized();
        if (shares == 0) revert AmountZero();
        if (receiver == address(0)) revert ZeroAddress();

        // Harvest first so caller's pending rewards are settled at burn time
        // (the _update hook needs an up-to-date globalRewardIndex).
        _harvest();

        _burn(msg.sender, shares);

        IUniswapV3PositionManager.DecreaseLiquidityParams memory dp =
            IUniswapV3PositionManager.DecreaseLiquidityParams({
                tokenId: positionTokenId,
                liquidity: uint128(shares),
                amount0Min: amount0Min,
                amount1Min: amount1Min,
                deadline: block.timestamp
            });
        (amount0, amount1) = npm.decreaseLiquidity(dp);

        // After decreaseLiquidity, the V3 NPM has tokensOwed = (amount0, amount1) of
        // PRINCIPAL only — fees were drained by the _harvest() above and feeGrowthInside
        // hasn't moved (we're inside nonReentrant; no swap can interleave).
        npm.collect(IUniswapV3PositionManager.CollectParams({
            tokenId: positionTokenId,
            recipient: receiver,
            amount0Max: type(uint128).max,
            amount1Max: type(uint128).max
        }));

        emit RedeemLiquidity(msg.sender, receiver, shares, amount0, amount1);
    }

    // ───────────────────── exchangeRate (constant 1e18) ─────────────────────

    /// @inheritdoc IStandardizedYield
    /// @dev Pendle-Kyber pattern — share price never moves. All yield exits via rewards.
    function exchangeRate() public pure override returns (uint256) {
        return PMath.ONE;
    }

    // ───────────────────── ERC-5115 metadata ─────────────────────

    function getTokensIn() external pure override returns (address[] memory) {
        return new address[](0);
    }

    function getTokensOut() external view override returns (address[] memory tokens) {
        tokens = new address[](2);
        tokens[0] = token0;
        tokens[1] = token1;
    }

    function isValidTokenIn(address) public pure override returns (bool) {
        return false;
    }

    function isValidTokenOut(address token) public view override returns (bool) {
        return token == token0 || token == token1;
    }

    /// @inheritdoc IStandardizedYield
    /// @dev `LIQUIDITY` because the share is backed by a multi-asset LP position; there
    ///      is no single asset price feed that can value 1 SY share. Routers / pricing
    ///      consumers MUST detect this and not attempt to quote SY in a single asset.
    function assetInfo()
        external
        view
        override
        returns (AssetType assetType, address assetAddress, uint8 assetDecimals)
    {
        return (AssetType.LIQUIDITY, address(0), 18);
    }

    function yieldToken() external view override returns (address) {
        // No fungible "yield token" — yield is a basket. Surface token0 by convention
        // (matches Pendle's pattern of returning the position's principal token0).
        return token0;
    }

    // ───────────────────── reward surface (ERC-5115) ─────────────────────

    function getRewardTokens() external view override returns (address[] memory tokens) {
        tokens = new address[](2);
        tokens[0] = token0;
        tokens[1] = token1;
    }

    function claimRewards(address user)
        external
        override
        nonReentrant
        returns (uint256[] memory amounts)
    {
        // Always harvest first so the user's settlement reflects all fees up to now.
        _harvest();
        _settleUserRewards(user);

        amounts = new uint256[](2);
        amounts[0] = accruedRewards0[user];
        amounts[1] = accruedRewards1[user];

        if (amounts[0] > 0) {
            accruedRewards0[user] = 0;
            IERC20(token0).safeTransfer(user, amounts[0]);
        }
        if (amounts[1] > 0) {
            accruedRewards1[user] = 0;
            IERC20(token1).safeTransfer(user, amounts[1]);
        }

        address[] memory tokens = new address[](2);
        tokens[0] = token0;
        tokens[1] = token1;
        emit ClaimRewards(user, tokens, amounts);
    }

    /// @inheritdoc IStandardizedYield
    /// @dev View — does NOT trigger a harvest. Returns settled + still-pending rewards
    ///      computed off the current cached `globalRewardIndex`. For the harvest-included
    ///      version the user can call `harvest()` first then read this.
    function accruedRewards(address user)
        external
        view
        override
        returns (uint256[] memory amounts)
    {
        amounts = new uint256[](2);
        uint256 bal = balanceOf(user);
        uint256 g0 = globalRewardIndex0;
        uint256 g1 = globalRewardIndex1;
        uint256 u0 = userRewardIndex0[user];
        uint256 u1 = userRewardIndex1[user];
        amounts[0] = accruedRewards0[user] + (g0 > u0 ? (bal * (g0 - u0)) / REWARD_SCALE : 0);
        amounts[1] = accruedRewards1[user] + (g1 > u1 ? (bal * (g1 - u1)) / REWARD_SCALE : 0);
    }

    /// @inheritdoc IStandardizedYield
    /// @dev Harvests before returning current indexes (matches Pendle's spec).
    function rewardIndexesCurrent() external override returns (uint256[] memory indexes) {
        _harvest();
        indexes = new uint256[](2);
        indexes[0] = globalRewardIndex0;
        indexes[1] = globalRewardIndex1;
    }

    function rewardIndexesStored() external view override returns (uint256[] memory indexes) {
        indexes = new uint256[](2);
        indexes[0] = globalRewardIndex0;
        indexes[1] = globalRewardIndex1;
    }

    // ───────────────────── harvest ─────────────────────

    /// @notice Public harvest. Anyone can call (cheap, beneficial — pulls fees from the
    ///         V3 position into the SY and credits them to the global reward index).
    function harvest() external nonReentrant {
        _harvest();
    }

    /// @dev Internal harvest — must be called BEFORE any share-set change so the global
    ///      index is up-to-date when the new shareholder set takes effect.
    function _harvest() internal {
        if (positionTokenId == 0) return;

        (uint256 c0, uint256 c1) = npm.collect(IUniswapV3PositionManager.CollectParams({
            tokenId: positionTokenId,
            recipient: address(this),
            amount0Max: type(uint128).max,
            amount1Max: type(uint128).max
        }));

        if (c0 == 0 && c1 == 0) return;

        uint256 ts = totalSupply();
        if (ts == 0) {
            // No shares to receive. Funds sit in this contract; admin can sweep later
            // via a dedicated rescue path (intentionally not added here — keep surface tight).
            emit Harvested(c0, c1);
            return;
        }

        if (c0 > 0) globalRewardIndex0 += (c0 * REWARD_SCALE) / ts;
        if (c1 > 0) globalRewardIndex1 += (c1 * REWARD_SCALE) / ts;

        emit Harvested(c0, c1);
    }

    // ───────────────────── per-user reward settlement ─────────────────────

    /// @dev Lock in `user`'s accruable share of (globalIndex - userIndex) as `accruedRewards`,
    ///      then advance their userIndex. Must be called BEFORE balance changes.
    function _settleUserRewards(address user) internal {
        if (user == address(0)) return; // mint source / burn destination

        uint256 bal = balanceOf(user);
        uint256 g0 = globalRewardIndex0;
        uint256 g1 = globalRewardIndex1;
        uint256 u0 = userRewardIndex0[user];
        uint256 u1 = userRewardIndex1[user];

        if (bal > 0) {
            if (g0 > u0) accruedRewards0[user] += (bal * (g0 - u0)) / REWARD_SCALE;
            if (g1 > u1) accruedRewards1[user] += (bal * (g1 - u1)) / REWARD_SCALE;
        }
        userRewardIndex0[user] = g0;
        userRewardIndex1[user] = g1;
    }

    /// @dev OZ ERC20 v5 single hook — fires on every mint/burn/transfer. Harvest pending
    ///      V3 fees FIRST so the global index is current, then settle both sides against
    ///      that index. Without the harvest, a raw `transfer(bob, x)` would settle alice
    ///      and bob against a stale `globalRewardIndex`, letting bob earn a slice of
    ///      pre-transfer fees and stripping alice of her rightful share. The deposit /
    ///      redeem / claim flows already harvest explicitly, but a vanilla SY-share
    ///      transfer needs this safety net.
    /// @dev    `_harvest()` is idempotent within a single tx — `collect` returns 0 the
    ///      second time. So the explicit harvest in deposit/redeem/claim isn't redundant
    ///      with this hook; it just makes the second call cheap (~3K gas).
    function _update(address from, address to, uint256 value) internal override {
        _harvest();
        _settleUserRewards(from);
        _settleUserRewards(to);
        super._update(from, to, value);
    }
}
