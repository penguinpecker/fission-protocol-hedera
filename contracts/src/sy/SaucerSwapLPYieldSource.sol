// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {SYBase} from "./SYBase.sol";
import {HtsHelpers} from "../libraries/HtsHelpers.sol";
import {IStandardizedYield} from "../interfaces/IStandardizedYield.sol";
import {IUniswapV3PositionManager} from "../interfaces/IUniswapV3PositionManager.sol";
import {PMath} from "../libraries/PMath.sol";

/// @title  SaucerSwapLPYieldSource — Pendle-Kyber-style SY for SaucerSwap V2 LP.
/// @notice Owns ONE V3-style NFT position with hard-coded `tickLower`/`tickUpper`.
///         Never rebalances. Shares are minted 1:1 with V3 `liquidity` units.
///         `exchangeRate()` returns `PMath.ONE` (1e18) — share price never moves.
///         All swap-fee yield is paid as reward tokens (token0 + token1).
///
///         Why this shape: V3-style concentrated-liquidity NFTs cannot be aggregated
///         into one appreciating per-share rate (range-specific feeGrowthInside).
///         Pendle's clean workaround for KyberElastic/Aerodrome-volatile SY adapters:
///         exchangeRate = 1, yield via the reward token side door. Preserves SY
///         monotonicity by construction.
///
/// @dev    Pre-approves token0/token1 → V3 NPM at `initShareToken()` time so the
///         per-deposit approve/reset cycle (4 child records) is eliminated forever.
///         The user-facing Periphery is responsible for querying the NPM's mint fee
///         and forwarding the correct msg.value — this adapter simply forwards what
///         it receives.
contract SaucerSwapLPYieldSource is SYBase {
    using SafeERC20 for IERC20;
    using PMath for uint256;

    bytes32 public constant HARVESTER_ROLE = keccak256("HARVESTER_ROLE");

    /// @dev 1e18-scale for reward-per-share index. Matches Pendle's precision.
    uint256 internal constant REWARD_SCALE = 1e18;

    /// @dev HTS allowance is int64, not uint256. Approving `type(uint256).max`
    ///      reverts on the precompile. Use 2^63 - 1 as practical infinity.
    uint256 internal constant MAX_HTS_APPROVE = uint256(uint64(type(int64).max));

    // ───────────────────── immutables ─────────────────────

    IUniswapV3PositionManager public immutable npm;
    address public immutable token0;
    address public immutable token1;
    uint24 public immutable poolFee;
    int24 public immutable tickLower;
    int24 public immutable tickUpper;

    uint8 internal immutable _token0Decimals;
    uint8 internal immutable _token1Decimals;

    // ───────────────────── position state ─────────────────────

    /// @notice The V3 NFT id this SY owns. `0` until first deposit.
    uint256 public positionTokenId;

    // ───────────────────── reward index state ─────────────────────

    uint256 public globalRewardIndex0;
    uint256 public globalRewardIndex1;

    mapping(address => uint256) public userRewardIndex0;
    mapping(address => uint256) public userRewardIndex1;

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
    error ZeroAddress();

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
    event ApprovedNpm(address indexed token, uint256 amount);

    // ───────────────────── construction ─────────────────────

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
            address(0), // no single underlying
            18, // 18-dec render of 128-bit V3 liquidity
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

    /// @dev Associate token0/token1 + pre-approve NPM. The V3 NPM mints
    ///      its position NFT to this contract; for that to land, this
    ///      contract MUST be deployed with maxAutomaticTokenAssociations=-1
    ///      (set via Hedera SDK ContractCreateFlow — Hashio JSON-RPC defaults
    ///      to 0 and the contract is immutable post-deploy).
    function _afterInitShareToken() internal override {
        HtsHelpers.associateIfNeeded(address(this), token0);
        HtsHelpers.associateIfNeeded(address(this), token1);

        IERC20(token0).forceApprove(address(npm), MAX_HTS_APPROVE);
        IERC20(token1).forceApprove(address(npm), MAX_HTS_APPROVE);
        emit ApprovedNpm(token0, MAX_HTS_APPROVE);
        emit ApprovedNpm(token1, MAX_HTS_APPROVE);
    }

    // ───────────────────── admin: HBAR sweep (X-2 fix) ─────────────────────

    error HbarSweepFailed();
    event HbarSwept(address indexed to, uint256 amount);

    /// @notice Sweep HBAR that accumulates in this contract from depositLiquidity
    ///         flows where the V3 NPM consumed less mint fee than the caller
    ///         forwarded. The Periphery sizes msg.value at v3NpmFeeBudget which
    ///         is a conservative upper bound; the excess lands here and stays
    ///         unrecoverable without this function.
    /// @dev    Admin-only. Trust-equivalent to the Market's admin role; for
    ///         the current single-admin operator this is the deployer. Transfer
    ///         to Timelock when scaling user TVL.
    function sweepHbar(address payable to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0 || amount > address(this).balance) revert AmountZero();
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert HbarSweepFailed();
        emit HbarSwept(to, amount);
    }

    /// @dev Accept HBAR refunded by the V3 NPM mint flow (the NPM checks
    ///      SELFBALANCE against the tinycents-priced mint fee; whatever
    ///      remains stays here).
    receive() external payable {}

    // ───────────────────── ERC-5115 deposit/redeem (disabled) ─────────────────────

    function deposit(address, address, uint256, uint256)
        external
        payable
        override
        returns (uint256)
    {
        revert UseDepositLiquidityInstead();
    }

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

    function _deposit(address, uint256) internal pure override returns (uint256) {
        revert UseDepositLiquidityInstead();
    }

    function _redeem(address, address, uint256) internal pure override returns (uint256) {
        revert UseRedeemLiquidityInstead();
    }

    // ───────────────────── dual-token deposit/redeem ─────────────────────

    /// @notice Deposit (amount0, amount1) into the V3 position; mint shares 1:1 with
    ///         liquidity added. Excess of either token is refunded.
    /// @dev    NO per-deposit approve/reset cycle — NPM is pre-approved max in
    ///         `_afterInitShareToken`. The caller (Periphery) is responsible for
    ///         providing the correct msg.value to cover the NPM mint fee.
    function depositLiquidity(
        uint256 amount0Desired,
        uint256 amount1Desired,
        uint256 amount0Min,
        uint256 amount1Min,
        address receiver,
        uint128 minLiquidity
    ) external payable nonReentrant whenNotPaused returns (uint128 liquidity) {
        if (receiver == address(0)) revert ZeroAddress();
        if (amount0Desired == 0 && amount1Desired == 0) revert AmountZero();

        // Pull tokens; both can be zero if V3 single-sided is appropriate.
        if (amount0Desired > 0) {
            IERC20(token0).safeTransferFrom(msg.sender, address(this), amount0Desired);
        }
        if (amount1Desired > 0) {
            IERC20(token1).safeTransferFrom(msg.sender, address(this), amount1Desired);
        }

        uint256 amount0Used;
        uint256 amount1Used;

        if (positionTokenId == 0) {
            IUniswapV3PositionManager.MintParams memory mp = IUniswapV3PositionManager.MintParams({
                token0: token0,
                token1: token1,
                fee: poolFee,
                tickLower: tickLower,
                tickUpper: tickUpper,
                amount0Desired: amount0Desired,
                amount1Desired: amount1Desired,
                amount0Min: amount0Min,
                amount1Min: amount1Min,
                recipient: address(this),
                deadline: block.timestamp
            });
            uint256 newTokenId;
            // NPM gates on SELFBALANCE >= tinycentsToTinybars(mintFee); periphery
            // queries the fee and forwards the correct msg.value.
            (newTokenId, liquidity, amount0Used, amount1Used) = npm.mint{value: msg.value}(mp);
            if (newTokenId == 0) revert MintFailed();
            positionTokenId = newTokenId;
            emit PositionMinted(newTokenId, liquidity, amount0Used, amount1Used);
        } else {
            // Harvest BEFORE adding so the existing shareholders are paid for
            // everything earned up to this block.
            _harvest();

            IUniswapV3PositionManager.IncreaseLiquidityParams memory ip =
                IUniswapV3PositionManager.IncreaseLiquidityParams({
                    tokenId: positionTokenId,
                    amount0Desired: amount0Desired,
                    amount1Desired: amount1Desired,
                    amount0Min: amount0Min,
                    amount1Min: amount1Min,
                    deadline: block.timestamp
                });
            (liquidity, amount0Used, amount1Used) = npm.increaseLiquidity{value: msg.value}(ip);
        }

        if (liquidity < minLiquidity) revert InsufficientLiquidityOut();
        if (liquidity == 0) revert InsufficientLiquidityOut();

        // Refund unused (no approval-reset needed — NPM pre-approved max).
        if (amount0Used < amount0Desired) {
            IERC20(token0).safeTransfer(msg.sender, amount0Desired - amount0Used);
        }
        if (amount1Used < amount1Desired) {
            IERC20(token1).safeTransfer(msg.sender, amount1Desired - amount1Used);
        }

        _mintShares(receiver, uint256(liquidity));

        emit DepositLiquidity(msg.sender, receiver, amount0Used, amount1Used, liquidity);
    }

    /// @notice Burn `shares` and pay out the corresponding (amount0, amount1) to receiver.
    /// @dev    SECURITY WARNING for direct callers (bypassing FissionPeriphery):
    ///         pass non-zero `amount0Min` / `amount1Min` floors. If the underlying
    ///         V3 pool position is drained (e.g. all underlying USDC + WHBAR has
    ///         been pulled out by other LPs or via emergency rescue), NPM
    ///         `decreaseLiquidity` may return (0, 0). Combined with `*Min = 0`,
    ///         the shares are burned for nothing.
    ///         FissionPeriphery's `unzapSyToHbar` enforces its own `minHbarOut`
    ///         downstream so this revert-protects the periphery flows. Direct
    ///         integrations must replicate that floor at the V3 level.
    function redeemLiquidity(uint256 shares, uint256 amount0Min, uint256 amount1Min, address receiver)
        external
        nonReentrant
        returns (uint256 amount0, uint256 amount1)
    {
        if (positionTokenId == 0) revert PositionNotInitialized();
        if (shares == 0) revert AmountZero();
        if (receiver == address(0)) revert ZeroAddress();

        _burnShares(msg.sender, shares);

        IUniswapV3PositionManager.DecreaseLiquidityParams memory dp =
            IUniswapV3PositionManager.DecreaseLiquidityParams({
                tokenId: positionTokenId,
                liquidity: uint128(shares),
                amount0Min: amount0Min,
                amount1Min: amount1Min,
                deadline: block.timestamp
            });
        (amount0, amount1) = npm.decreaseLiquidity(dp);

        // After decreaseLiquidity, tokensOwed = principal only — fees were drained
        // by the prior _harvest() and feeGrowthInside hasn't moved inside nonReentrant.
        npm.collect(IUniswapV3PositionManager.CollectParams({
            tokenId: positionTokenId,
            recipient: receiver,
            amount0Max: type(uint128).max,
            amount1Max: type(uint128).max
        }));

        emit RedeemLiquidity(msg.sender, receiver, shares, amount0, amount1);
    }

    // ───────────────────── exchangeRate (constant 1e18) ─────────────────────

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

    function assetInfo()
        external
        view
        override
        returns (AssetType assetType, address assetAddress, uint8 assetDecimals)
    {
        return (AssetType.LIQUIDITY, address(0), 18);
    }

    function yieldToken() external view override returns (address) {
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

    function accruedRewards(address user)
        external
        view
        override
        returns (uint256[] memory amounts)
    {
        amounts = new uint256[](2);
        uint256 bal = IERC20(shareToken).balanceOf(user);
        uint256 g0 = globalRewardIndex0;
        uint256 g1 = globalRewardIndex1;
        uint256 u0 = userRewardIndex0[user];
        uint256 u1 = userRewardIndex1[user];
        amounts[0] = accruedRewards0[user] + (g0 > u0 ? (bal * (g0 - u0)) / REWARD_SCALE : 0);
        amounts[1] = accruedRewards1[user] + (g1 > u1 ? (bal * (g1 - u1)) / REWARD_SCALE : 0);
    }

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

    function harvest() external nonReentrant {
        _harvest();
    }

    function _harvest() internal {
        if (positionTokenId == 0) return;

        uint256 ts = IERC20(shareToken).totalSupply();
        if (ts == 0) return;

        (uint256 c0, uint256 c1) = npm.collect(IUniswapV3PositionManager.CollectParams({
            tokenId: positionTokenId,
            recipient: address(this),
            amount0Max: type(uint128).max,
            amount1Max: type(uint128).max
        }));

        if (c0 == 0 && c1 == 0) return;

        if (c0 > 0) globalRewardIndex0 += (c0 * REWARD_SCALE) / ts;
        if (c1 > 0) globalRewardIndex1 += (c1 * REWARD_SCALE) / ts;

        emit Harvested(c0, c1);
    }

    // ───────────────────── per-user reward settlement ─────────────────────

    function _settleUserRewards(address user) internal {
        if (user == address(0) || user == address(this)) return;

        uint256 bal = IERC20(shareToken).balanceOf(user);
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

    function _beforeShareUpdate(address from, address to) internal override {
        _harvest();
        _settleUserRewards(from);
        _settleUserRewards(to);
    }
}
