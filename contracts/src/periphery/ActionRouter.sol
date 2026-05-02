// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {IStandardizedYield} from "../interfaces/IStandardizedYield.sol";
import {FissionMarket} from "../core/FissionMarket.sol";
import {PrincipalToken} from "../core/PrincipalToken.sol";
import {YieldToken} from "../core/YieldToken.sol";

/// @title  ActionRouter — user-facing entry for multi-step flows.
/// @notice Single-tx flows for the common strategies. Every external entry takes a
///         `deadline` (revert past it) and a `minOut` (revert below it). The router
///         holds no state and only takes custody of tokens for the duration of a single
///         function call — no LP shares, no PT/YT held across blocks.
/// @dev    Not upgradeable in v1. If we need to change the router, we deploy a new
///         contract and ask users to re-approve. UUPS adds complexity (storage slots,
///         init guards) we don't need until the router gains durable state.
contract ActionRouter is ReentrancyGuardTransient {
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

    /// @notice Wrap an underlying asset into SY, then split SY into PT + YT.
    /// @param market         target FissionMarket
    /// @param tokenIn        underlying asset (must be in `sy.getTokensIn()`)
    /// @param amountIn       amount of `tokenIn` to deposit
    /// @param minPyOut       minimum PT (== YT) output; revert if less
    /// @param receiver       where to send PT and YT
    /// @param deadline       UNIX timestamp; 0 = no deadline
    function depositAndSplit(
        FissionMarket market,
        address tokenIn,
        uint256 amountIn,
        uint256 minPyOut,
        address receiver,
        uint256 deadline
    )
        external
        payable
        nonReentrant
        checkDeadline(deadline)
        returns (uint256 ptOut, uint256 ytOut)
    {
        if (amountIn == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();

        IStandardizedYield sy = market.sy();

        // Native HBAR (msg.value) is not routed through this v1 — only ERC-20 tokenIn.
        // A future helper can add HBAR ↔ WHBAR auto-wrap.
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);

        // Approve SY to pull and deposit.
        IERC20(tokenIn).forceApprove(address(sy), amountIn);
        uint256 shares = sy.deposit(address(this), tokenIn, amountIn, 0);

        // Approve market and split.
        IERC20(address(sy)).forceApprove(address(market), shares);
        market.split(shares);

        ptOut = shares;
        ytOut = shares;
        if (ptOut < minPyOut) revert SlippageExceeded();

        // Send PT and YT to receiver.
        IERC20(address(market.pt())).safeTransfer(receiver, ptOut);
        IERC20(address(market.yt())).safeTransfer(receiver, ytOut);
    }

    // ───────────────────── PT trades ─────────────────────

    /// @notice Pay SY exact, receive PT.
    function swapExactSyForPt(
        FissionMarket market,
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
        IERC20(address(sy)).safeTransferFrom(msg.sender, address(this), syIn);
        IERC20(address(sy)).forceApprove(address(market), syIn);

        syUsed = market.swapExactSyForPt(syIn, ptOut, receiver);
        // syUsed <= syIn — refund the rest.
        if (syUsed < syIn) {
            IERC20(address(sy)).safeTransfer(msg.sender, syIn - syUsed);
        }
    }

    /// @notice Sell PT exact, receive SY.
    function swapExactPtForSy(
        FissionMarket market,
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

        IERC20 pt = IERC20(address(market.pt()));
        pt.safeTransferFrom(msg.sender, address(this), ptIn);
        pt.forceApprove(address(market), ptIn);

        syOut = market.swapExactPtForSy(ptIn, minSyOut, receiver);
    }

    // ───────────────────── YT trade (long yield) ─────────────────────

    /// @notice "Buy YT" — pay `syBudget`, receive YT plus any SY refund. The mechanism:
    ///         1. Split `syBudget` SY into `syBudget` PT + `syBudget` YT.
    ///         2. Sell the PT in the pool for SY at the current implied rate.
    ///         3. Return (`syBudget` YT, SY proceeds from PT sale) to the user.
    ///         The user's net cost = `syBudget − syRefund`, in exchange for `syBudget` YT.
    /// @dev    The PT sale is bounded by `minSyOutFromPtSale` slippage. If too low, the
    ///         whole flow reverts — user keeps their SY.
    function buyYT(
        FissionMarket market,
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
        IERC20 pt = IERC20(address(market.pt()));
        IERC20 yt = IERC20(address(market.yt()));

        IERC20(address(sy)).safeTransferFrom(msg.sender, address(this), syBudget);

        // Split SY → PT + YT.
        IERC20(address(sy)).forceApprove(address(market), syBudget);
        market.split(syBudget);
        ytOut = syBudget;

        // Sell PT in the pool. Slippage on the PT sale.
        pt.forceApprove(address(market), syBudget);
        syRefund = market.swapExactPtForSy(syBudget, minSyOutFromPtSale, receiver);

        // Forward YT to user.
        yt.safeTransfer(receiver, ytOut);
    }

    // ───────────────────── liquidity ─────────────────────

    function addLiquidityProportional(
        FissionMarket market,
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

        IERC20 sy = IERC20(address(market.sy()));
        IERC20 pt = IERC20(address(market.pt()));

        sy.safeTransferFrom(msg.sender, address(this), syIn);
        pt.safeTransferFrom(msg.sender, address(this), ptIn);
        sy.forceApprove(address(market), syIn);
        pt.forceApprove(address(market), ptIn);

        lpOut = market.addLiquidity(syIn, ptIn, minLpOut, receiver);
    }

    function removeLiquidityProportional(
        FissionMarket market,
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

        IERC20(address(market)).safeTransferFrom(msg.sender, address(this), lpIn);
        // The market burns its own LP via _burn(msg.sender, lpIn) — msg.sender of
        // removeLiquidity is the router. So the LP must be in the router's balance.
        (syOut, ptOut) = market.removeLiquidity(lpIn, minSyOut, minPtOut, receiver);
    }

    // ───────────────────── post-expiry ─────────────────────

    /// @notice After expiry, redeem PT (and optional YT for closure) into SY, then
    ///         unwrap SY into the underlying token in one tx.
    function redeemAfterExpiryAndUnwrap(
        FissionMarket market,
        uint256 ptIn,
        uint256 ytIn,
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
        if (ptIn == 0 && ytIn == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();

        IStandardizedYield sy = market.sy();
        IERC20 pt = IERC20(address(market.pt()));
        IERC20 yt = IERC20(address(market.yt()));

        if (ptIn > 0) {
            pt.safeTransferFrom(msg.sender, address(this), ptIn);
            pt.forceApprove(address(market), ptIn);
        }
        if (ytIn > 0) {
            yt.safeTransferFrom(msg.sender, address(this), ytIn);
            yt.forceApprove(address(market), ytIn);
        }

        uint256 syOut = market.redeemAfterExpiry(ptIn, ytIn, address(this));
        if (syOut == 0) {
            return 0;
        }

        IERC20(address(sy)).forceApprove(address(sy), syOut);
        amountOut = sy.redeem(receiver, syOut, tokenOut, minTokenOut, false);
    }

    /// @notice Unwrap an SY balance the user already holds back into the underlying token.
    /// @dev    Used after the user claims yield directly via `market.claimYield(self)`.
    ///         Single-tx claim+unwrap requires `claimYieldFor(user)` on the market — that's
    ///         a future market revision; for v1 it's two txs (claim, then this).
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

        IERC20(address(sy)).safeTransferFrom(msg.sender, address(this), shares);
        IERC20(address(sy)).forceApprove(address(sy), shares);
        amountOut = sy.redeem(receiver, shares, tokenOut, minTokenOut, false);
    }
}
