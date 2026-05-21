// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {IStandardizedYield} from "../interfaces/IStandardizedYield.sol";
import {IFissionMarketCommon} from "../interfaces/IFissionMarketCommon.sol";

/// @title  ActionRouterV3 — user-facing entry for multi-step flows (v3, addLiquidity fix).
/// @notice Identical to `ActionRouter` (v2 at `0.0.10475923`) except for `addLiquidityProportional`,
///         which previously cast `market.sy()` (the SY contract address) as `IERC20`.
///         On Hedera the SY contract is NOT the share token — the share is a separate
///         HTS-native fungible exposed via `sy.shareToken()`. The transferFrom against
///         the SY contract directly reverted on every Add-LP attempt, forcing the dApp
///         to route around the router and call `market.addLiquidity` directly.
///
///         v3 swaps the three offending lines in `addLiquidityProportional` to use
///         `IERC20(market.sy().shareToken())`. All other entries are byte-for-byte
///         identical to v2; the constructor, admin model, error set, modifiers, and
///         remaining function bodies are unchanged so existing approvals and ABIs
///         continue to apply.
/// @dev    Deployed with `maxAutomaticTokenAssociations = -1` (HIP-904) and admin-keyed
///         to the operator at deploy time. Admin transfers to the Timelock alongside
///         the rest of the v3 contract set during the next handoff window.
contract ActionRouterV3 is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    error DeadlineExpired();
    error SlippageExceeded();
    error ZeroAmount();
    error ZeroAddress();

    modifier checkDeadline(uint256 deadline) {
        if (deadline != 0 && block.timestamp > deadline) revert DeadlineExpired();
        _;
    }

    // ───────────────────── deposit + split ─────────────────────

    function depositAndSplit(
        IFissionMarketCommon market,
        address tokenIn,
        uint256 amountIn,
        uint256 minPyOut,
        address receiver,
        uint256 deadline
    )
        external
        nonReentrant
        checkDeadline(deadline)
        returns (uint256 ptOut, uint256 ytOut)
    {
        if (amountIn == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();

        IStandardizedYield sy = market.sy();

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenIn).forceApprove(address(sy), amountIn);
        uint256 shares = sy.deposit(address(this), tokenIn, amountIn, 0);

        IERC20(sy.shareToken()).forceApprove(address(market), shares);
        market.splitTo(shares, receiver, receiver);

        ptOut = shares;
        ytOut = shares;
        if (ptOut < minPyOut) revert SlippageExceeded();
    }

    // ───────────────────── PT trades ─────────────────────

    function swapExactSyForPt(
        IFissionMarketCommon market,
        uint256 syIn,
        uint256 ptOut,
        address receiver,
        uint256 deadline
    )
        external
        nonReentrant
        checkDeadline(deadline)
        returns (uint256 syUsed)
    {
        if (syIn == 0 || ptOut == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();

        IStandardizedYield sy = market.sy();
        IERC20(sy.shareToken()).safeTransferFrom(msg.sender, address(this), syIn);
        IERC20(sy.shareToken()).forceApprove(address(market), syIn);

        syUsed = market.swapExactSyForPt(syIn, ptOut, receiver);
        if (syUsed < syIn) {
            IERC20(sy.shareToken()).safeTransfer(msg.sender, syIn - syUsed);
        }
    }

    function swapExactPtForSy(
        IFissionMarketCommon market,
        uint256 ptIn,
        uint256 minSyOut,
        address receiver,
        uint256 deadline
    )
        external
        nonReentrant
        checkDeadline(deadline)
        returns (uint256 syOut)
    {
        if (ptIn == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();

        IERC20 pt = IERC20(market.ptAddr());
        pt.safeTransferFrom(msg.sender, address(this), ptIn);
        pt.forceApprove(address(market), ptIn);

        syOut = market.swapExactPtForSy(ptIn, minSyOut, receiver);
    }

    // ───────────────────── YT trade (long yield) ─────────────────────
    //
    // NOTE: `swapExactYtForSy` is NOT a router action — YT is freeze-by-default
    // and can't be transferred to the Router for proxying. The dApp calls
    // `FissionMarket.swapExactYtForSy(ytIn, minSyOut, receiver)` directly on the
    // Market contract, which wipes the user's YT in-place via its WIPE key.

    function buyYT(
        IFissionMarketCommon market,
        uint256 syBudget,
        uint256 minSyOutFromPtSale,
        address receiver,
        uint256 deadline
    )
        external
        nonReentrant
        checkDeadline(deadline)
        returns (uint256 ytOut, uint256 syRefund)
    {
        if (syBudget == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();

        IStandardizedYield sy = market.sy();
        IERC20 pt = IERC20(market.ptAddr());

        IERC20(sy.shareToken()).safeTransferFrom(msg.sender, address(this), syBudget);

        IERC20(sy.shareToken()).forceApprove(address(market), syBudget);
        market.splitTo(syBudget, address(this), receiver);
        ytOut = syBudget;

        pt.forceApprove(address(market), syBudget);
        syRefund = market.swapExactPtForSy(syBudget, minSyOutFromPtSale, receiver);
    }

    // ───────────────────── liquidity (v3 fix) ─────────────────────

    /// @notice Provide proportional SY + PT, receive LP. **v3 fix:** pulls the
    ///         SY *share* (HTS token via `sy.shareToken()`) instead of the SY
    ///         *contract* address — that was the v2 bug.
    function addLiquidityProportional(
        IFissionMarketCommon market,
        uint256 syIn,
        uint256 ptIn,
        uint256 minLpOut,
        address receiver,
        uint256 deadline
    )
        external
        nonReentrant
        checkDeadline(deadline)
        returns (uint256 lpOut)
    {
        if (syIn == 0 || ptIn == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();

        IERC20 syShare = IERC20(market.sy().shareToken());
        IERC20 pt = IERC20(market.ptAddr());

        syShare.safeTransferFrom(msg.sender, address(this), syIn);
        pt.safeTransferFrom(msg.sender, address(this), ptIn);
        syShare.forceApprove(address(market), syIn);
        pt.forceApprove(address(market), ptIn);

        lpOut = market.addLiquidity(syIn, ptIn, minLpOut, receiver);
    }

    function removeLiquidityProportional(
        IFissionMarketCommon market,
        uint256 lpIn,
        uint256 minSyOut,
        uint256 minPtOut,
        address receiver,
        uint256 deadline
    )
        external
        nonReentrant
        checkDeadline(deadline)
        returns (uint256 syOut, uint256 ptOut)
    {
        if (lpIn == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();

        IERC20(market.lp()).safeTransferFrom(msg.sender, address(this), lpIn);
        (syOut, ptOut) = market.removeLiquidity(lpIn, minSyOut, minPtOut, receiver);
    }

    // ───────────────────── post-expiry ─────────────────────

    function redeemAfterExpiryAndUnwrap(
        IFissionMarketCommon market,
        uint256 ptIn,
        address tokenOut,
        uint256 minTokenOut,
        address receiver,
        uint256 deadline
    )
        external
        nonReentrant
        checkDeadline(deadline)
        returns (uint256 amountOut)
    {
        if (ptIn == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();

        IStandardizedYield sy = market.sy();
        IERC20 pt = IERC20(market.ptAddr());

        pt.safeTransferFrom(msg.sender, address(this), ptIn);
        pt.forceApprove(address(market), ptIn);

        uint256 syOut = market.redeemAfterExpiry(ptIn, 0, address(this));
        if (syOut == 0) {
            return 0;
        }

        IERC20(sy.shareToken()).forceApprove(address(sy), syOut);
        amountOut = sy.redeem(receiver, syOut, tokenOut, minTokenOut, false);
    }

    function unwrapSY(
        IStandardizedYield sy,
        uint256 shares,
        address tokenOut,
        uint256 minTokenOut,
        address receiver,
        uint256 deadline
    )
        external
        nonReentrant
        checkDeadline(deadline)
        returns (uint256 amountOut)
    {
        if (shares == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();

        IERC20(sy.shareToken()).safeTransferFrom(msg.sender, address(this), shares);
        IERC20(sy.shareToken()).forceApprove(address(sy), shares);
        amountOut = sy.redeem(receiver, shares, tokenOut, minTokenOut, false);
    }
}
