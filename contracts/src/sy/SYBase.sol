// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {AccessControlDefaultAdminRules} from
    "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";

import {IStandardizedYield} from "../interfaces/IStandardizedYield.sol";
import {PMath} from "../libraries/PMath.sol";

/// @title  SYBase — abstract ERC-5115 (Pendle superset) base.
/// @notice Implements the deposit/redeem skeleton, share accounting, and the reward-
///         index distribution pattern. Subclasses override:
///             - `_deposit(tokenIn, amountIn) -> sharesOut`
///             - `_redeem(receiver, tokenOut, shares) -> amountOut`
///             - `_previewDeposit / _previewRedeem`
///             - `exchangeRate`
///             - `_getTokensIn / _getTokensOut / isValidTokenIn / isValidTokenOut`
///             - `_assetInfo`
///             - reward functions (default: no rewards)
/// @dev    Round in the protocol's favour at every conversion. Decimals reflect the
///         underlying asset (per ERC-5115).
abstract contract SYBase is
    IStandardizedYield,
    ERC20,
    ReentrancyGuardTransient,
    Pausable,
    AccessControlDefaultAdminRules
{
    using SafeERC20 for IERC20;
    using PMath for uint256;

    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @dev Sentinel for native HBAR deposits/redeems on Hedera. Uses the same
    ///      address Aave / 1inch use for native-asset signalling. Reserved for a
    ///      future SY adapter that accepts HBAR directly; current adapters never
    ///      return `true` from `isValidTokenIn(NATIVE)`.
    address public constant NATIVE = address(0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE);

    /// @notice The yield-bearing token deposited into the SY (what the SY actually holds).
    address public immutable underlying;

    /// @notice Asset decimals — what `decimals()` reports per ERC-5115.
    uint8 private immutable _assetDecimals;

    error AmountZero();
    error TokenNotSupported(address token);
    error SlippageExceeded();
    error InsufficientSharesOut();

    constructor(
        string memory name_,
        string memory symbol_,
        address underlying_,
        uint8 decimals_,
        address admin_,
        uint48 adminTransferDelay_
    )
        ERC20(name_, symbol_)
        AccessControlDefaultAdminRules(adminTransferDelay_, admin_)
    {
        underlying = underlying_;
        _assetDecimals = decimals_;
        _grantRole(PAUSER_ROLE, admin_);
    }

    // ───────────────────── ERC-20 metadata ─────────────────────

    /// @inheritdoc ERC20
    /// @dev Per ERC-5115: SY decimals reflect the underlying asset.
    function decimals() public view virtual override returns (uint8) {
        return _assetDecimals;
    }

    // ───────────────────── deposit / redeem ─────────────────────

    function deposit(address receiver, address tokenIn, uint256 amountIn, uint256 minSharesOut)
        external
        payable
        virtual
        nonReentrant
        whenNotPaused
        returns (uint256 sharesOut)
    {
        if (amountIn == 0) revert AmountZero();
        if (!isValidTokenIn(tokenIn)) revert TokenNotSupported(tokenIn);

        // Pull tokens BEFORE the deposit hook so subclasses see the funds. Native HBAR
        // arrives via `msg.value`; ERC-20 must be transferred in.
        if (tokenIn == NATIVE) {
            require(msg.value == amountIn, "SY: msg.value mismatch");
        } else {
            require(msg.value == 0, "SY: HBAR not accepted");
            IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        }

        sharesOut = _deposit(tokenIn, amountIn);
        if (sharesOut < minSharesOut) revert SlippageExceeded();
        if (sharesOut == 0) revert InsufficientSharesOut();

        _mint(receiver, sharesOut);
        emit Deposit(msg.sender, receiver, tokenIn, amountIn, sharesOut);
    }

    function redeem(
        address receiver,
        uint256 shares,
        address tokenOut,
        uint256 minTokenOut,
        bool burnFromInternalBalance
    ) external virtual nonReentrant whenNotPaused returns (uint256 amountTokenOut) {
        if (shares == 0) revert AmountZero();
        if (!isValidTokenOut(tokenOut)) revert TokenNotSupported(tokenOut);

        if (burnFromInternalBalance) {
            // The "internal balance" pattern from Pendle: shares are already in the SY
            // contract (e.g. the Router transferred them in). Burn from SY's own balance.
            _burn(address(this), shares);
        } else {
            _burn(msg.sender, shares);
        }

        amountTokenOut = _redeem(receiver, tokenOut, shares);
        if (amountTokenOut < minTokenOut) revert SlippageExceeded();

        emit Redeem(msg.sender, receiver, tokenOut, shares, amountTokenOut);
    }

    // ───────────────────── abstract hooks ─────────────────────

    /// @dev Compute shares minted for a deposit. Funds are already pulled to `address(this)`.
    function _deposit(address tokenIn, uint256 amountIn) internal virtual returns (uint256 sharesOut);

    /// @dev Pay out `shares` worth of `tokenOut` to `receiver`. Shares are already burned.
    function _redeem(address receiver, address tokenOut, uint256 shares)
        internal
        virtual
        returns (uint256 amountTokenOut);

    function previewDeposit(address tokenIn, uint256 amountIn)
        external
        view
        virtual
        returns (uint256 sharesOut);

    function previewRedeem(address tokenOut, uint256 shares)
        external
        view
        virtual
        returns (uint256 amountTokenOut);

    function exchangeRate() external view virtual returns (uint256);

    function getTokensIn() external view virtual returns (address[] memory);
    function getTokensOut() external view virtual returns (address[] memory);
    function isValidTokenIn(address token) public view virtual returns (bool);
    function isValidTokenOut(address token) public view virtual returns (bool);

    function assetInfo()
        external
        view
        virtual
        returns (AssetType assetType, address assetAddress, uint8 assetDecimals);

    function yieldToken() external view virtual returns (address);

    // ───────────────────── rewards (default: none) ─────────────────────

    function getRewardTokens() external view virtual returns (address[] memory) {
        return new address[](0);
    }

    function claimRewards(address /*user*/ )
        external
        virtual
        returns (uint256[] memory rewardAmounts)
    {
        rewardAmounts = new uint256[](0);
        emit ClaimRewards(msg.sender, new address[](0), rewardAmounts);
    }

    function accruedRewards(address /*user*/ ) external view virtual returns (uint256[] memory) {
        return new uint256[](0);
    }

    function rewardIndexesCurrent() external virtual returns (uint256[] memory) {
        return new uint256[](0);
    }

    function rewardIndexesStored() external view virtual returns (uint256[] memory) {
        return new uint256[](0);
    }

    // ───────────────────── pause ─────────────────────

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // ───────────────────── ERC-165 ─────────────────────

    function supportsInterface(bytes4 interfaceId)
        public
        view
        virtual
        override(AccessControlDefaultAdminRules)
        returns (bool)
    {
        return interfaceId == type(IStandardizedYield).interfaceId
            || super.supportsInterface(interfaceId);
    }

    // No `receive()` — the SY base does not currently support native HBAR deposits.
    // When an adapter declares the NATIVE sentinel valid via `isValidTokenIn`, that
    // adapter overrides `deposit` (or this contract gains a receive in a future
    // revision). Until then, a raw HBAR send to an SY reverts — preventing the
    // attractive-nuisance / locked-ether failure mode Slither flags.
}
