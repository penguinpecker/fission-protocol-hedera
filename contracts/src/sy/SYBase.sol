// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {AccessControlDefaultAdminRules} from
    "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";

import {IStandardizedYield} from "../interfaces/IStandardizedYield.sol";
import {IHederaTokenService} from "../interfaces/IHederaTokenService.sol";
import {HtsHelpers} from "../libraries/HtsHelpers.sol";
import {PMath} from "../libraries/PMath.sol";

/// @title  SYBase — abstract ERC-5115 (Pendle superset) base, Hedera HTS-native shares.
/// @notice Implements the deposit/redeem skeleton with HTS-native share tokens.
///         The SY contract is the share token's treasury + supplyKey + wipeKey holder.
///         `address(this)` is NOT the share token — call `shareToken()` for the HTS
///         token address (`IERC20(shareToken).balanceOf(user)` etc work via Hedera's
///         ERC-20 facade).
/// @dev    Subclasses override:
///             - `_deposit(tokenIn, amountIn) -> sharesOut`
///             - `_redeem(receiver, tokenOut, shares) -> amountOut`
///             - `_previewDeposit / _previewRedeem`
///             - `exchangeRate`
///             - `_getTokensIn / _getTokensOut / isValidTokenIn / isValidTokenOut`
///             - `_assetInfo`
///             - reward functions (default: no rewards)
///         Round in the protocol's favour at every conversion. Decimals reflect the
///         underlying asset (per ERC-5115).
abstract contract SYBase is
    IStandardizedYield,
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
    uint8 internal immutable _assetDecimals;

    /// @notice The HTS-native share token. SYBase is treasury + supplyKey + wipeKey.
    ///         Use `IERC20(shareToken).balanceOf(...)` for ERC-20 facade reads/writes.
    address public shareToken;

    /// @dev Stored at construction; consumed once by `initShareToken`.
    string private _pendingName;
    string private _pendingSymbol;

    error AmountZero();
    error TokenNotSupported(address token);
    error SlippageExceeded();
    error InsufficientSharesOut();
    error ShareTokenAlreadySet();
    error ShareTokenNotInitialized();

    /// @notice Constructor stores the share-token name + symbol and configures admin /
    ///         pauser. **Does NOT create the HTS share token** — that happens in a
    ///         separate `initShareToken()` call post-deploy.
    /// @dev    Why two-step: on Hedera consensus, `createFungibleToken` called from a
    ///         contract constructor produces a child TOKENCREATION HAPI tx whose
    ///         max_fee comes back as 0 (the `msg.value` forwarded to the precompile
    ///         doesn't propagate as the child's fee budget — confirmed empirically on
    ///         mainnet via both Hashio and the SDK). Calling the precompile from a
    ///         regular `external payable` function works correctly. So we defer the
    ///         token-create call out of the constructor. Until `initShareToken` is
    ///         called, every entry point that needs `shareToken` reverts with
    ///         `ShareTokenNotInitialized`.
    constructor(
        string memory name_,
        string memory symbol_,
        address underlying_,
        uint8 decimals_,
        address admin_,
        uint48 adminTransferDelay_
    ) AccessControlDefaultAdminRules(adminTransferDelay_, admin_) {
        underlying = underlying_;
        _assetDecimals = decimals_;
        _grantRole(PAUSER_ROLE, admin_);
        _pendingName = name_;
        _pendingSymbol = symbol_;
    }

    /// @notice One-shot post-deploy initializer. Creates the HTS-native share token
    ///         (SYBase = treasury + supplyKey + wipeKey, no freeze) and stores it in
    ///         `shareToken`. Caller must attach enough HBAR (~2 HBAR on mainnet) to
    ///         msg.value to cover the Hedera createFungible fee.
    /// @dev    Anyone can call (deploy script, EOA, or another contract) — the call is
    ///         idempotent via the `shareToken != 0` check, so there's no front-run
    ///         vector beyond paying the deploy fee for someone else.
    function initShareToken() external payable {
        if (shareToken != address(0)) revert ShareTokenAlreadySet();

        IHederaTokenService.TokenKey[] memory keys = new IHederaTokenService.TokenKey[](2);
        keys[0] = HtsHelpers.makeKey(16, address(this)); // SUPPLY
        keys[1] = HtsHelpers.makeKey(8, address(this));  // WIPE — for redeem-from-arbitrary

        IHederaTokenService.HederaToken memory spec = IHederaTokenService.HederaToken({
            name: _pendingName,
            symbol: _pendingSymbol,
            treasury: address(this),
            memo: "",
            tokenSupplyType: false,
            maxSupply: 0,
            freezeDefault: false,
            tokenKeys: keys,
            expiry: IHederaTokenService.Expiry({
                second: 0,
                autoRenewAccount: address(this),
                autoRenewPeriod: 7776000
            })
        });
        // Single token create: send the full msg.value to the precompile.
        shareToken = HtsHelpers.createFungible(spec, int32(uint32(_assetDecimals)), msg.value);
    }

    /// @dev Shared guard for entry points that mint/burn shares.
    function _requireInitialized() internal view {
        if (shareToken == address(0)) revert ShareTokenNotInitialized();
    }

    // ───────────────────── share-token mint / burn helpers ─────────────────────

    /// @dev Mint HTS shares to `to`: settle rewards FIRST (before balance changes),
    ///      then mint to treasury and transfer out.
    function _mintShares(address to, uint256 amount) internal {
        _requireInitialized();
        _beforeShareUpdate(address(0), to);
        HtsHelpers.mintToTreasury(shareToken, amount);
        if (to != address(this)) {
            HtsHelpers.transfer(shareToken, address(this), to, amount);
        }
    }

    /// @dev Burn HTS shares. Settle rewards FIRST. Treasury via burnFromTreasury;
    ///      arbitrary accounts via wipe. Wipe is required because `redeem` (with
    ///      `burnFromInternalBalance = false`) burns from `msg.sender` directly —
    ///      the equivalent of the old `_burn(from)` under unrestricted internal access.
    function _burnShares(address from, uint256 amount) internal {
        _requireInitialized();
        _beforeShareUpdate(from, address(0));
        if (from == address(this)) {
            HtsHelpers.burnFromTreasury(shareToken, amount);
        } else {
            HtsHelpers.wipeFrom(shareToken, from, amount);
        }
    }

    /// @dev Hook for subclasses (e.g. SY_SaucerSwapV2LP) to settle per-shareholder
    ///      reward indexes BEFORE share-balance changes. Replaces the OZ ERC-20
    ///      `_update` hook that no longer fires (HTS shares have no contract-level
    ///      transfer hook). Default: no-op (rate-based SYs don't need per-user
    ///      reward indexes — yield is baked into `exchangeRate`).
    /// @dev    LIMITATION: this hook fires on mint/burn only. Direct user-to-user HTS
    ///         transfers of share tokens DO NOT fire any settlement and can leak
    ///         rewards (recipient's stale userIndex over-claims). In production, all
    ///         SY share movements are mediated by the Market — users go through
    ///         `router.depositAndSplit` and `market.merge`, never holding raw SY
    ///         shares for long. Direct-deposit users should `claimRewards(self)`
    ///         BEFORE transferring shares to lock in their accrual.
    function _beforeShareUpdate(address from, address to) internal virtual {
        // default no-op
    }

    // ───────────────────── ERC-5115-compatible metadata ─────────────────────

    /// @notice Asset decimals — per ERC-5115, this reflects the underlying asset.
    /// @dev    The HTS share token has its own `decimals()` callable via the ERC-20
    ///         facade (`IERC20Metadata(shareToken).decimals()`); same value.
    function decimals() public view virtual returns (uint8) {
        return _assetDecimals;
    }

    // ───────────────────── deposit / redeem ─────────────────────

    /// @dev    M-1 audit fix: snapshot pre-balance and pass the actual delta to
    ///         `_deposit`. Without this, an HTS token with HIP-18 customFees (or any
    ///         fee-on-transfer ERC-20) would silently inflate share price — `_deposit`
    ///         would mint shares for the requested `amountIn` while the contract only
    ///         received `amountIn - fee`. The v1 lineup tokens (HBARX, USDC, WHBAR)
    ///         have no such fees, but the defence covers any future SY adapter.
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

        uint256 actualIn;
        if (tokenIn == NATIVE) {
            require(msg.value == amountIn, "SY: msg.value mismatch");
            actualIn = msg.value;
        } else {
            require(msg.value == 0, "SY: HBAR not accepted");
            uint256 prev = IERC20(tokenIn).balanceOf(address(this));
            IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
            actualIn = IERC20(tokenIn).balanceOf(address(this)) - prev;
        }

        sharesOut = _deposit(tokenIn, actualIn);
        if (sharesOut < minSharesOut) revert SlippageExceeded();
        if (sharesOut == 0) revert InsufficientSharesOut();

        _mintShares(receiver, sharesOut);
        emit Deposit(msg.sender, receiver, tokenIn, actualIn, sharesOut);
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
            // contract (e.g. the Router transferred them in). Burn from SY's treasury.
            _burnShares(address(this), shares);
        } else {
            _burnShares(msg.sender, shares);
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
