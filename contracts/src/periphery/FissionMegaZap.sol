// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {IStandardizedYield} from "../interfaces/IStandardizedYield.sol";
import {IFissionMarketCommon} from "../interfaces/IFissionMarketCommon.sol";

/// @title  FissionMegaZap — atomic HBAR → PT / YT / LP zap.
/// @notice Collapses the 2-4-tx HBAR-source chain the dApp currently drives
///         (associate → zap-to-SY → approve → swap/buy/addLiquidity) into one
///         on-chain function call. The user signs once; the MegaZap orchestrates
///         the whole flow inside a single transaction.
///
///         Internally:
///           1. Forward msg.value to `FissionZap.zapHbarToSy(..., receiver=this)`.
///              The MegaZap receives SY shares directly.
///           2. Read the MegaZap's own SY-share balance (the V3 swap inside the
///              Zap is lossy, so trusting the static estimate would underflow
///              one of the downstream legs). Use the post-balance verbatim.
///           3. Approve the SY-share token (NOT the SY contract — that was the
///              v2 router bug) to the v3 ActionRouter and call the matching
///              router entry: `swapExactSyForPt` / `buyYT` / `addLiquidityProportional`.
///           4. The router delivers the destination token (PT, YT, or LP)
///              straight to the user's wallet; the MegaZap holds nothing across
///              the call.
///
///         No admin, no pause, no fees. Stateless. Re-deploy on every
///         FissionZap or Router upgrade.
/// @dev    The MegaZap MUST be deployed with `maxAutomaticTokenAssociations = -1`
///         (HIP-904) so it can receive the SY-share HTS token mid-tx without an
///         explicit pre-associate. All ERC-20 approvals use `SafeERC20.forceApprove`.
///         Every external entry is `nonReentrant`.
interface IFissionZap {
    function zapHbarToSy(
        address sy,
        uint256 usdcMinOut,
        uint256 amount0Min,
        uint256 amount1Min,
        uint128 minShares,
        address receiver
    ) external payable returns (uint256 shares);
}

interface IActionRouterV3 {
    function swapExactSyForPt(
        IFissionMarketCommon market,
        uint256 syIn,
        uint256 ptOut,
        address receiver,
        uint256 deadline
    ) external returns (uint256 syUsed);

    function buyYT(
        IFissionMarketCommon market,
        uint256 syBudget,
        uint256 minSyOutFromPtSale,
        address receiver,
        uint256 deadline
    ) external returns (uint256 ytOut, uint256 syRefund);

    function addLiquidityProportional(
        IFissionMarketCommon market,
        uint256 syIn,
        uint256 ptIn,
        uint256 minLpOut,
        address receiver,
        uint256 deadline
    ) external returns (uint256 lpOut);
}

contract FissionMegaZap is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    IFissionZap public immutable zap;
    IActionRouterV3 public immutable router;

    error DeadlineExpired();
    error InsufficientOutput();
    error ZeroAmount();
    error ZeroAddress();

    event ZappedToPt(
        address indexed user,
        address indexed market,
        uint256 hbarTinybarsIn,
        uint256 syAcquired,
        uint256 syUsed,
        uint256 ptDelivered
    );
    event ZappedToYt(
        address indexed user,
        address indexed market,
        uint256 hbarTinybarsIn,
        uint256 syAcquired,
        uint256 ytDelivered,
        uint256 syRefund
    );
    event ZappedToLp(
        address indexed user,
        address indexed market,
        uint256 hbarTinybarsIn,
        uint256 syAcquired,
        uint256 syForLp,
        uint256 ptAcquired,
        uint256 lpDelivered
    );

    modifier checkDeadline(uint256 deadline) {
        if (deadline != 0 && block.timestamp > deadline) revert DeadlineExpired();
        _;
    }

    constructor(address zap_, address router_) {
        if (zap_ == address(0) || router_ == address(0)) revert ZeroAddress();
        zap = IFissionZap(zap_);
        router = IActionRouterV3(router_);
    }

    /* ───────────────────────────────────────────────── HBAR → PT */

    /// @notice Single-tx HBAR → PT. The user pays HBAR (msg.value),
    ///         receives PT directly to `receiver`.
    /// @dev    The FissionZap charges a 5-HBAR NPM fee out of msg.value; the
    ///         caller must include that on top of the desired SY-buying budget.
    function zapHbarToPt(
        IFissionMarketCommon market,
        IStandardizedYield sy,
        uint256 minPtOut,
        address receiver,
        uint256 deadline
    )
        external
        payable
        nonReentrant
        checkDeadline(deadline)
        returns (uint256 ptOut)
    {
        if (msg.value == 0) revert ZeroAmount();
        if (minPtOut == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();

        // Step 1: HBAR → SY. MegaZap is the receiver of SY shares.
        zap.zapHbarToSy{value: msg.value}(address(sy), 0, 0, 0, 1, address(this));

        // Step 2: Read actual SY received (the V3 swap inside the zap is
        // lossy — trust the balance, not any pre-computed estimate).
        IERC20 syShare = IERC20(sy.shareToken());
        uint256 syAcquired = syShare.balanceOf(address(this));
        if (syAcquired == 0) revert InsufficientOutput();

        // Step 3: Approve SY-share to the router and execute the swap.
        // PT is delivered to `receiver` directly by the router.
        syShare.forceApprove(address(router), syAcquired);
        uint256 syUsed = router.swapExactSyForPt(
            market,
            syAcquired,
            minPtOut,
            receiver,
            deadline
        );

        // The router refunds unused SY to msg.sender (this contract). Sweep
        // any leftover SY back to the user so the MegaZap stays stateless.
        uint256 syLeft = syShare.balanceOf(address(this));
        if (syLeft > 0) {
            syShare.safeTransfer(receiver, syLeft);
        }

        // ptOut is unobservable from inside the router call (it returns syUsed
        // for the exact-PT variant). The on-chain effect is `minPtOut` PT
        // delivered to `receiver`; emit `minPtOut` as the guaranteed minimum
        // so downstream consumers know what's safe to assume.
        ptOut = minPtOut;
        emit ZappedToPt(msg.sender, address(market), msg.value, syAcquired, syUsed, ptOut);
    }

    /* ───────────────────────────────────────────────── HBAR → YT */

    /// @notice Single-tx HBAR → YT. The user pays HBAR (msg.value),
    ///         receives YT plus any SY refund from the internal PT sale.
    function zapHbarToYt(
        IFissionMarketCommon market,
        IStandardizedYield sy,
        uint256 minSyOutFromPtSale,
        address receiver,
        uint256 deadline
    )
        external
        payable
        nonReentrant
        checkDeadline(deadline)
        returns (uint256 ytOut, uint256 syRefund)
    {
        if (msg.value == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();

        zap.zapHbarToSy{value: msg.value}(address(sy), 0, 0, 0, 1, address(this));

        IERC20 syShare = IERC20(sy.shareToken());
        uint256 syAcquired = syShare.balanceOf(address(this));
        if (syAcquired == 0) revert InsufficientOutput();

        syShare.forceApprove(address(router), syAcquired);
        (ytOut, syRefund) = router.buyYT(
            market,
            syAcquired,
            minSyOutFromPtSale,
            receiver,
            deadline
        );

        emit ZappedToYt(msg.sender, address(market), msg.value, syAcquired, ytOut, syRefund);
    }

    /* ───────────────────────────────────────────────── HBAR → LP */

    /// @notice Single-tx HBAR → LP. The user pays HBAR (msg.value); the MegaZap
    ///         mints SY, splits the budget per `ptShareBps`, swaps half to PT
    ///         (via the router's `swapExactSyForPt`), and provides proportional
    ///         liquidity. LP shares go directly to `receiver`.
    /// @param  ptShareBps Basis points of the SY budget converted to PT
    ///         (5000 = 50/50). Caller must pick this to match the current pool
    ///         ratio — UI computes it from `totalSy` / `totalPt`. Out-of-range
    ///         values revert.
    function zapHbarToLp(
        IFissionMarketCommon market,
        IStandardizedYield sy,
        uint16 ptShareBps,
        uint256 minLpOut,
        address receiver,
        uint256 deadline
    )
        external
        payable
        nonReentrant
        checkDeadline(deadline)
        returns (uint256 lpOut)
    {
        if (msg.value == 0) revert ZeroAmount();
        if (minLpOut == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();
        if (ptShareBps == 0 || ptShareBps >= 10_000) revert ZeroAmount();

        // Step 1: HBAR → SY → MegaZap.
        zap.zapHbarToSy{value: msg.value}(address(sy), 0, 0, 0, 1, address(this));

        IERC20 syShare = IERC20(sy.shareToken());
        IERC20 pt = IERC20(market.ptAddr());

        uint256 syAcquired = syShare.balanceOf(address(this));
        if (syAcquired == 0) revert InsufficientOutput();

        // Step 2: Split SY budget. `syForSwap` becomes PT via router; `syForLp`
        // stays as SY for the proportional deposit.
        uint256 syForSwap = (syAcquired * ptShareBps) / 10_000;
        if (syForSwap == 0 || syForSwap >= syAcquired) revert InsufficientOutput();

        // Approve syForSwap to router, then swap for PT. PT is delivered to
        // this contract (we still need it for the addLiquidity call).
        syShare.forceApprove(address(router), syForSwap);
        // `ptOut` = 1 effectively asks the router for any PT — slippage is
        // bounded by the outer `minLpOut`, which falls if PT received is too
        // small to match the LP ratio. We pass a conservative floor of 1 to
        // make the router's `ptOut == 0` revert harmless.
        router.swapExactSyForPt(market, syForSwap, 1, address(this), deadline);

        // Step 3: Read actual balances after the swap (slippage may have left
        // residual SY in the MegaZap if the router refunded the unused
        // portion of syForSwap; combine that with the held-back syForLp).
        uint256 syOnHand = syShare.balanceOf(address(this));
        uint256 ptOnHand = pt.balanceOf(address(this));
        if (syOnHand == 0 || ptOnHand == 0) revert InsufficientOutput();

        // Step 4: Approve and call the router's addLiquidityProportional. LP
        // goes directly to the user.
        syShare.forceApprove(address(router), syOnHand);
        pt.forceApprove(address(router), ptOnHand);
        lpOut = router.addLiquidityProportional(
            market,
            syOnHand,
            ptOnHand,
            minLpOut,
            receiver,
            deadline
        );

        // The market.addLiquidity primitive pulls SY + PT at the current pool
        // ratio and may leave a small residual on one side (the side whose
        // input exceeded the ratio). Sweep both residuals back to the user.
        uint256 syDust = syShare.balanceOf(address(this));
        if (syDust > 0) syShare.safeTransfer(receiver, syDust);
        uint256 ptDust = pt.balanceOf(address(this));
        if (ptDust > 0) pt.safeTransfer(receiver, ptDust);

        emit ZappedToLp(
            msg.sender,
            address(market),
            msg.value,
            syAcquired,
            syOnHand,
            ptOnHand,
            lpOut
        );
    }

    /// @notice Accept HBAR refunds (FissionZap sweeps unused HBAR back).
    receive() external payable {}
}
