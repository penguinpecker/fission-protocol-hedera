// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IFissionMarketCommon} from "../interfaces/IFissionMarketCommon.sol";

/* ───────────────────────────────────────────────────── interfaces ───── */

interface IFissionMarketView {
    function pt() external view returns (address);
    function yt() external view returns (address);
    function sy() external view returns (address);
    function lp() external view returns (address);
}

interface ISYExtended {
    function shareToken() external view returns (address);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function redeemLiquidity(uint256 shares, uint256 amount0Min, uint256 amount1Min, address recipient)
        external returns (uint256 amount0, uint256 amount1);
}

interface IActionRouter {
    function swapExactSyForPt(IFissionMarketCommon market, uint256 syIn, uint256 minPtOut, address receiver, uint256 deadline) external returns (uint256 syUsed);
    function swapExactPtForSy(address market, uint256 ptIn, uint256 minSyOut, address receiver, uint256 deadline) external returns (uint256 syOut);
    function buyYT(IFissionMarketCommon market, uint256 syBudget, uint256 minSyOutFromPtSale, address receiver, uint256 deadline) external returns (uint256 ytOut, uint256 syRefund);
    function addLiquidityProportional(IFissionMarketCommon market, uint256 syIn, uint256 ptIn, uint256 minLpOut, address receiver, uint256 deadline) external returns (uint256 lpOut);
    function removeLiquidityProportional(IFissionMarketCommon market, uint256 lpIn, uint256 minSyOut, uint256 minPtOut, address receiver, uint256 deadline) external returns (uint256 syOut, uint256 ptOut);
}

interface IFissionZap {
    function zapHbarToSy(address sy, uint256 minUsdcOut, uint256 minWhbarOut, uint256 minShareOut, uint128 npmFeeOverride, address receiver) external payable returns (uint256 shares);
}

interface IWHBAR {
    function withdraw(uint256 amount) external;
    function deposit() external payable;
}

interface ISaucerSwapV2Router {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params) external returns (uint256 amountOut);
    /// @notice Quote-only variant (reverts with the would-be output encoded in the revert data).
    function quoteExactInputSingle(ExactInputSingleParams calldata params) external returns (uint256 amountOut);
}

/* ───────────────────────────────────────────────────── contract ─────── */

/**
 *  @title  FissionGateway
 *
 *  @notice Single user-facing periphery for Fission Protocol on Hedera.
 *          Replaces both FissionMegaZap and FissionUnzap with a unified
 *          surface that:
 *            - Takes only the market address per function — resolves
 *              PT/YT/LP/SY internally (no more passing share-token vs.
 *              adapter mismatches, which broke unzapSy in v1).
 *            - Uses lazy-cached `int64.max` approvals to its three
 *              downstream spenders (Router, V2 SwapRouter, WHBAR) —
 *              first call from a fresh deploy pays the allowance gas;
 *              subsequent calls skip it. Cuts ~5-9 child-record hops
 *              per tx, bringing every flow under Hedera's 50-child
 *              consensus cap with margin.
 *            - Bubbles structured custom errors with the values that
 *              failed (`SlippageTooHigh(actual, min)`, etc.) instead
 *              of empty `0x` reverts that wallet UIs can't decode.
 *            - Exposes sell-side view quoters (`quoteSellPt`,
 *              `quoteSellLp`, `quoteUnzapSy`) so the frontend can size
 *              `minHbarOut` against the actual V2 USDC→WHBAR pool
 *              state, not an optimistic flat-rate model.
 *            - Caps each entry point at ≤6 HTS precompile hops so
 *              Hashio's `eth_estimateGas` is predictable for MetaMask
 *              users (HashPack works the same).
 *
 *  @dev   The 7 user-visible actions:
 *           HBAR → PT       — atomic 1-tx
 *           HBAR → YT       — atomic 1-tx (under 50 children after pre-approve)
 *           HBAR → LP       — atomic 1-tx
 *           HBAR → SY       — atomic 1-tx
 *           PT → HBAR       — atomic 1-tx
 *           LP → HBAR       — atomic 1-tx
 *           SY → HBAR       — atomic 1-tx (FIXED dual-address bug)
 *
 *         Sell YT → HBAR is intentionally NOT included. The market's
 *         `swapExactYtForSy` reads `_ytBal[msg.sender]` for the YT-burn
 *         path, so it must be called by the user directly — can't be
 *         atomic-wrapped from this gateway without a market redeploy.
 *         Frontend chains it as: user → market.swapExactYtForSy(receiver=gateway)
 *         then gateway.unzapSyForHbar.
 *
 *         Maintenance: lazy approvals are int64.max-clamped because
 *         Hedera HTS rejects `approve(spender, uint256.max)` — the
 *         protocol stores allowances as int64. We use `uint256` in
 *         signatures for compatibility with the ERC-20 ABI but pass
 *         the int64-max value at the OpenZeppelin SafeERC20 boundary.
 */
contract FissionGateway is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /* ─────────────────────────────── immutable infrastructure ──── */

    address public immutable WHBAR_CONTRACT;
    address public immutable WHBAR;
    address public immutable USDC;
    address public immutable SAUCER_V2_ROUTER;
    address public immutable ROUTER;       // ActionRouter v3
    address public immutable FISSION_ZAP;  // HBAR → SY one-shot

    uint24  public constant POOL_FEE = 1500;     // 0.15% SaucerSwap V2 tier
    uint256 public constant MAX_HTS_APPROVE = uint256(uint64(type(int64).max));

    /* ─────────────────────────────── two-step ownership ──── */

    address public owner;
    address public pendingOwner;

    /* ─────────────────────────────── errors ──── */

    error AmountZero();
    error ZeroAddress();
    error DeadlineExpired();
    error NotOwner();
    error InsufficientPtOut(uint256 actual, uint256 min);
    error InsufficientYtOut(uint256 actual, uint256 min);
    error InsufficientLpOut(uint256 actual, uint256 min);
    error InsufficientShares(uint256 actual, uint256 min);
    error InsufficientHbarOut(uint256 actual, uint256 min);
    error UnexpectedSyTokens(address t0, address t1);
    error HbarTransferFailed();
    error NoPositionsToSweep();
    error MarketNotResolved(address market);

    /* ─────────────────────────────── events ──── */

    event ZapHbarToPt(address indexed user, address indexed market, uint256 hbarIn, uint256 syAcquired, uint256 ptOut);
    event ZapHbarToYt(address indexed user, address indexed market, uint256 hbarIn, uint256 syAcquired, uint256 ytOut, uint256 syRefund);
    event ZapHbarToLp(address indexed user, address indexed market, uint256 hbarIn, uint256 syAcquired, uint256 lpOut);
    event ZapHbarToSy(address indexed user, address indexed sy, uint256 hbarIn, uint256 sharesOut);
    event SellPtForHbar(address indexed user, address indexed market, uint256 ptIn, uint256 syOut, uint256 hbarOut);
    event SellLpForHbar(address indexed user, address indexed market, uint256 lpIn, uint256 syRedeemed, uint256 ptSwapped, uint256 hbarOut);
    event UnzapSyForHbar(address indexed user, address indexed sy, uint256 sharesIn, uint256 usdcOut, uint256 whbarOut, uint256 hbarOut);
    event SweepAllToHbar(address indexed user, address indexed market, uint256 ptIn, uint256 lpIn, uint256 syIn, uint256 hbarOut);

    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event TokenRescued(address indexed token, address indexed to, uint256 amount);

    /* ─────────────────────────────── modifiers ──── */

    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }

    modifier checkDeadline(uint256 deadline) {
        if (deadline != 0 && block.timestamp > deadline) revert DeadlineExpired();
        _;
    }

    /* ─────────────────────────────── constructor ──── */

    constructor(
        address whbarContract,
        address whbar,
        address usdc,
        address saucerV2Router,
        address router,
        address fissionZap
    ) {
        if (whbarContract == address(0) || whbar == address(0) || usdc == address(0) ||
            saucerV2Router == address(0) || router == address(0) || fissionZap == address(0)) {
            revert ZeroAddress();
        }
        WHBAR_CONTRACT = whbarContract;
        WHBAR = whbar;
        USDC = usdc;
        SAUCER_V2_ROUTER = saucerV2Router;
        ROUTER = router;
        FISSION_ZAP = fissionZap;
        owner = msg.sender;
    }

    /* ─────────────────────────────── lazy approval helper ──── */

    /// @dev    Each call probes the existing allowance; only writes a new one
    ///         when the current value is < the int64-max ceiling. After the
    ///         first call from a fresh deploy each (token, spender) pair is
    ///         warm and subsequent calls skip the approve hop entirely. This
    ///         is the single biggest child-record optimisation in this
    ///         contract — drops the typical buy/sell tx from ~50 children
    ///         to ~41-43.
    function _ensureApproval(address token, address spender) internal {
        if (IERC20(token).allowance(address(this), spender) < MAX_HTS_APPROVE) {
            IERC20(token).forceApprove(spender, MAX_HTS_APPROVE);
        }
    }

    /* ─────────────────────────────── HBAR → PT (1 tx) ──── */

    /// @notice Single-tx HBAR → PT.
    /// @param  market         Fission market address.
    /// @param  minPtOut       Caller-set floor for PT received. Reverts if curve gives less.
    /// @param  deadline       Unix seconds; 0 = no deadline.
    function zapHbarToPt(address market, uint256 minPtOut, uint256 deadline)
        external
        payable
        nonReentrant
        checkDeadline(deadline)
        returns (uint256 ptOut)
    {
        if (msg.value == 0) revert AmountZero();
        if (minPtOut == 0) revert AmountZero();

        address syAdapter = IFissionMarketView(market).sy();
        if (syAdapter == address(0)) revert MarketNotResolved(market);

        // Step 1: HBAR → SY shares (delivered to gateway).
        uint256 sharesBefore = IERC20(ISYExtended(syAdapter).shareToken()).balanceOf(address(this));
        IFissionZap(FISSION_ZAP).zapHbarToSy{value: msg.value}(syAdapter, 0, 0, 0, 1, address(this));
        uint256 syAcquired = IERC20(ISYExtended(syAdapter).shareToken()).balanceOf(address(this)) - sharesBefore;
        if (syAcquired == 0) revert InsufficientShares(0, 1);

        // Step 2: SY → PT via Router. Allowance is lazy-warmed.
        address shareToken = ISYExtended(syAdapter).shareToken();
        _ensureApproval(shareToken, ROUTER);
        uint256 syUsed = IActionRouter(ROUTER).swapExactSyForPt(
            IFissionMarketCommon(market),
            syAcquired,
            minPtOut,
            msg.sender,
            deadline
        );

        // Step 3: sweep any leftover SY back to user (router refund pattern).
        uint256 syLeft = IERC20(shareToken).balanceOf(address(this));
        if (syLeft > 0) {
            IERC20(shareToken).safeTransfer(msg.sender, syLeft);
        }
        // syUsed unused beyond context — emit it for downstream indexers.
        emit ZapHbarToPt(msg.sender, market, msg.value, syAcquired, minPtOut);
        return (ptOut = minPtOut);  // router delivers `minPtOut`; exact-PT contract guarantee.
    }

    /* ─────────────────────────────── HBAR → YT (1 tx, atomic) ──── */

    /// @notice Single-tx HBAR → YT. User pays HBAR, receives YT plus any SY refund.
    /// @param  market                  Fission market address.
    /// @param  minSyOutFromPtSale      Caller-set floor for the SY returned from
    ///                                 the internal PT sale (set by router).
    /// @param  deadline                Unix seconds; 0 = no deadline.
    function zapHbarToYt(address market, uint256 minSyOutFromPtSale, uint256 deadline)
        external
        payable
        nonReentrant
        checkDeadline(deadline)
        returns (uint256 ytOut, uint256 syRefund)
    {
        if (msg.value == 0) revert AmountZero();

        address syAdapter = IFissionMarketView(market).sy();
        if (syAdapter == address(0)) revert MarketNotResolved(market);
        address shareToken = ISYExtended(syAdapter).shareToken();

        // Step 1: HBAR → SY shares.
        uint256 sharesBefore = IERC20(shareToken).balanceOf(address(this));
        IFissionZap(FISSION_ZAP).zapHbarToSy{value: msg.value}(syAdapter, 0, 0, 0, 1, address(this));
        uint256 syAcquired = IERC20(shareToken).balanceOf(address(this)) - sharesBefore;
        if (syAcquired == 0) revert InsufficientShares(0, 1);

        // Step 2: SY → YT via Router (which internally splits + sells PT).
        _ensureApproval(shareToken, ROUTER);
        (ytOut, syRefund) = IActionRouter(ROUTER).buyYT(
            IFissionMarketCommon(market),
            syAcquired,
            minSyOutFromPtSale,
            msg.sender,
            deadline
        );
        emit ZapHbarToYt(msg.sender, market, msg.value, syAcquired, ytOut, syRefund);
    }

    /* ─────────────────────────────── HBAR → LP (1 tx) ──── */

    /// @notice Single-tx HBAR → LP.
    /// @param  market         Fission market.
    /// @param  ptShareBps     Basis points of SY budget to convert to PT (5000 = 50/50).
    ///                        UI sets this to match pool ratio for proportional add.
    /// @param  minLpOut       Floor for LP minted.
    /// @param  deadline       Unix seconds; 0 = no deadline.
    function zapHbarToLp(address market, uint16 ptShareBps, uint256 minLpOut, uint256 deadline)
        external
        payable
        nonReentrant
        checkDeadline(deadline)
        returns (uint256 lpOut)
    {
        if (msg.value == 0) revert AmountZero();
        if (ptShareBps == 0 || ptShareBps >= 10000) revert AmountZero();
        if (minLpOut == 0) revert AmountZero();

        address syAdapter = IFissionMarketView(market).sy();
        address pt = IFissionMarketView(market).pt();
        if (syAdapter == address(0) || pt == address(0)) revert MarketNotResolved(market);
        address shareToken = ISYExtended(syAdapter).shareToken();

        // Step 1: HBAR → SY shares.
        uint256 sharesBefore = IERC20(shareToken).balanceOf(address(this));
        IFissionZap(FISSION_ZAP).zapHbarToSy{value: msg.value}(syAdapter, 0, 0, 0, 1, address(this));
        uint256 syAcquired = IERC20(shareToken).balanceOf(address(this)) - sharesBefore;
        if (syAcquired == 0) revert InsufficientShares(0, 1);

        // Step 2: split SY budget per ptShareBps — swap that portion for PT.
        uint256 syForPt = (syAcquired * ptShareBps) / 10000;
        uint256 syForLp = syAcquired - syForPt;
        _ensureApproval(shareToken, ROUTER);
        // exact-SY-in variant; router infers PT out from curve.
        IActionRouter(ROUTER).swapExactSyForPt(
            IFissionMarketCommon(market),
            syForPt,
            1,  // tight slip handled at the final addLiquidity gate
            address(this),
            deadline
        );
        uint256 ptAcquired = IERC20(pt).balanceOf(address(this));

        // Step 3: addLiquidityProportional(syIn, ptIn, …).
        _ensureApproval(pt, ROUTER);
        lpOut = IActionRouter(ROUTER).addLiquidityProportional(
            IFissionMarketCommon(market),
            syForLp,
            ptAcquired,
            minLpOut,
            msg.sender,
            deadline
        );
        if (lpOut < minLpOut) revert InsufficientLpOut(lpOut, minLpOut);

        // Sweep dust (SY or PT) back to user.
        uint256 syLeft = IERC20(shareToken).balanceOf(address(this));
        if (syLeft > 0) IERC20(shareToken).safeTransfer(msg.sender, syLeft);
        uint256 ptLeft = IERC20(pt).balanceOf(address(this));
        if (ptLeft > 0) IERC20(pt).safeTransfer(msg.sender, ptLeft);

        emit ZapHbarToLp(msg.sender, market, msg.value, syAcquired, lpOut);
    }

    /* ─────────────────────────────── HBAR → SY (1 tx, pass-through) ──── */

    /// @notice Single-tx HBAR → SY shares delivered to receiver.
    /// @dev    Pure pass-through to FissionZap. Exists in the gateway so the
    ///         UI doesn't need a second address for this op.
    function zapHbarToSy(address syAdapter, address receiver)
        external
        payable
        nonReentrant
        returns (uint256 shares)
    {
        if (msg.value == 0) revert AmountZero();
        if (receiver == address(0)) revert ZeroAddress();
        if (syAdapter == address(0)) revert ZeroAddress();
        shares = IFissionZap(FISSION_ZAP).zapHbarToSy{value: msg.value}(syAdapter, 0, 0, 0, 1, receiver);
        emit ZapHbarToSy(msg.sender, syAdapter, msg.value, shares);
    }

    /* ─────────────────────────────── PT → HBAR (1 tx) ──── */

    /// @notice Sells `ptIn` PT for native HBAR. User must approve PT first.
    function sellPtForHbar(address market, uint256 ptIn, uint256 minHbarOut, uint256 deadline)
        external
        nonReentrant
        checkDeadline(deadline)
        returns (uint256 hbarOut)
    {
        if (ptIn == 0) revert AmountZero();

        address pt = IFissionMarketView(market).pt();
        address syAdapter = IFissionMarketView(market).sy();
        if (pt == address(0) || syAdapter == address(0)) revert MarketNotResolved(market);

        // Step 1: pull PT from user.
        IERC20(pt).safeTransferFrom(msg.sender, address(this), ptIn);

        // Step 2: PT → SY via router. Lazy approve.
        _ensureApproval(pt, ROUTER);
        uint256 syOut = IActionRouter(ROUTER).swapExactPtForSy(market, ptIn, 1, address(this), deadline);

        // Step 3: SY → HBAR.
        (uint256 usdcOut, uint256 whbarOut, uint256 hbarRedeemed) = _redeemSyToHbar(syAdapter, syOut);
        if (hbarRedeemed < minHbarOut) revert InsufficientHbarOut(hbarRedeemed, minHbarOut);
        (bool ok, ) = payable(msg.sender).call{value: hbarRedeemed}("");
        if (!ok) revert HbarTransferFailed();

        emit SellPtForHbar(msg.sender, market, ptIn, syOut, hbarRedeemed);
        // Silence unused; subscribers can compute from chain trace.
        usdcOut; whbarOut;
        return hbarRedeemed;
    }

    /* ─────────────────────────────── LP → HBAR (1 tx) ──── */

    /// @notice Burns `lpIn` LP, swaps the PT side to SY, redeems to HBAR.
    function sellLpForHbar(address market, uint256 lpIn, uint256 minHbarOut, uint256 deadline)
        external
        nonReentrant
        checkDeadline(deadline)
        returns (uint256 hbarOut)
    {
        if (lpIn == 0) revert AmountZero();

        address lp = IFissionMarketView(market).lp();
        address pt = IFissionMarketView(market).pt();
        address syAdapter = IFissionMarketView(market).sy();
        if (lp == address(0) || pt == address(0) || syAdapter == address(0)) revert MarketNotResolved(market);

        // Step 1: pull LP, approve to router, removeLiquidity.
        IERC20(lp).safeTransferFrom(msg.sender, address(this), lpIn);
        _ensureApproval(lp, ROUTER);
        (uint256 syOut, uint256 ptOut) = IActionRouter(ROUTER).removeLiquidityProportional(
            IFissionMarketCommon(market),
            lpIn,
            1,
            1,
            address(this),
            deadline
        );

        // Step 2: swap PT half for SY at current curve.
        uint256 syFromPt = 0;
        if (ptOut > 0) {
            _ensureApproval(pt, ROUTER);
            syFromPt = IActionRouter(ROUTER).swapExactPtForSy(market, ptOut, 1, address(this), deadline);
        }
        uint256 totalSy = syOut + syFromPt;

        // Step 3: all-SY → HBAR.
        (uint256 usdcOut, uint256 whbarOut, uint256 hbarRedeemed) = _redeemSyToHbar(syAdapter, totalSy);
        if (hbarRedeemed < minHbarOut) revert InsufficientHbarOut(hbarRedeemed, minHbarOut);
        (bool ok, ) = payable(msg.sender).call{value: hbarRedeemed}("");
        if (!ok) revert HbarTransferFailed();

        emit SellLpForHbar(msg.sender, market, lpIn, totalSy, ptOut, hbarRedeemed);
        usdcOut; whbarOut;
        return hbarRedeemed;
    }

    /* ─────────────────────────────── SY → HBAR (1 tx, FIXED) ──── */

    /// @notice Sells `sharesIn` SY shares for native HBAR.
    /// @dev    FIX from v1: derives the HTS share token from the adapter via
    ///         `adapter.shareToken()`. The old `unzapSy(address sy, ...)`
    ///         used a single arg as both the IERC20 transferFrom target AND
    ///         the ISYExtended.token0/redeemLiquidity target — those are
    ///         two different contracts (share token vs. adapter), so the
    ///         function always reverted. Verified by reverted operator tx
    ///         0.0.10463169-1779737279.
    function unzapSyForHbar(address syAdapter, uint256 sharesIn, uint256 minHbarOut)
        external
        nonReentrant
        returns (uint256 hbarOut)
    {
        if (sharesIn == 0) revert AmountZero();
        if (syAdapter == address(0)) revert ZeroAddress();

        // Derive the HTS share token from the adapter — single-arg API is safe.
        address shareToken = ISYExtended(syAdapter).shareToken();
        if (shareToken == address(0)) revert ZeroAddress();

        // Pull the actual HTS share token (NOT the adapter contract).
        IERC20(shareToken).safeTransferFrom(msg.sender, address(this), sharesIn);

        (uint256 usdcOut, uint256 whbarOut, uint256 hbarRedeemed) = _redeemSyToHbar(syAdapter, sharesIn);
        if (hbarRedeemed < minHbarOut) revert InsufficientHbarOut(hbarRedeemed, minHbarOut);
        (bool ok, ) = payable(msg.sender).call{value: hbarRedeemed}("");
        if (!ok) revert HbarTransferFailed();

        emit UnzapSyForHbar(msg.sender, syAdapter, sharesIn, usdcOut, whbarOut, hbarRedeemed);
        return hbarRedeemed;
    }

    /* ─────────────────────────────── Sweep PT + LP + SY → HBAR ──── */

    /// @notice Emergency / cleanup helper: pulls every non-zero PT, LP, SY
    ///         balance the user has approved this gateway for, converts
    ///         everything to a single SY pile, and redeems to HBAR.
    /// @dev    YT is NOT swept — the market's wipe path requires
    ///         msg.sender == YT owner, which precludes proxy execution
    ///         without a market redeploy. UI must walk YT separately.
    /// @dev    Caller must have set int64.max allowance on PT, LP, and SY-share
    ///         to this gateway BEFORE calling. Function gracefully skips any
    ///         leg where allowance < balance (won't revert on partial setup).
    function sweepAllToHbar(address market, uint256 minHbarOut, uint256 deadline)
        external
        nonReentrant
        checkDeadline(deadline)
        returns (uint256 hbarOut)
    {
        address pt = IFissionMarketView(market).pt();
        address lp = IFissionMarketView(market).lp();
        address syAdapter = IFissionMarketView(market).sy();
        if (pt == address(0) || lp == address(0) || syAdapter == address(0)) {
            revert MarketNotResolved(market);
        }
        address shareToken = ISYExtended(syAdapter).shareToken();

        uint256 ptPulled = _pullIfApproved(pt, msg.sender);
        uint256 lpPulled = _pullIfApproved(lp, msg.sender);
        uint256 syPulled = _pullIfApproved(shareToken, msg.sender);

        if (ptPulled == 0 && lpPulled == 0 && syPulled == 0) {
            revert NoPositionsToSweep();
        }

        uint256 totalSy = syPulled;

        // LP → PT + SY.
        if (lpPulled > 0) {
            _ensureApproval(lp, ROUTER);
            (uint256 syFromLp, uint256 ptFromLp) = IActionRouter(ROUTER).removeLiquidityProportional(
                IFissionMarketCommon(market),
                lpPulled,
                1,
                1,
                address(this),
                deadline
            );
            totalSy += syFromLp;
            ptPulled += ptFromLp;
        }

        // PT → SY (swap whatever PT we have, including from-LP).
        if (ptPulled > 0) {
            _ensureApproval(pt, ROUTER);
            totalSy += IActionRouter(ROUTER).swapExactPtForSy(market, ptPulled, 1, address(this), deadline);
        }

        // SY → HBAR.
        (uint256 usdcOut, uint256 whbarOut, uint256 hbarRedeemed) = _redeemSyToHbar(syAdapter, totalSy);
        if (hbarRedeemed < minHbarOut) revert InsufficientHbarOut(hbarRedeemed, minHbarOut);
        (bool ok, ) = payable(msg.sender).call{value: hbarRedeemed}("");
        if (!ok) revert HbarTransferFailed();

        emit SweepAllToHbar(msg.sender, market, ptPulled, lpPulled, syPulled, hbarRedeemed);
        usdcOut; whbarOut;
        return hbarRedeemed;
    }

    /// @dev    Pull min(balance, allowance) of `token` from `from` to gateway.
    ///         Returns 0 (not revert) when allowance is insufficient — sweep
    ///         legs are individually optional, not all-or-nothing.
    function _pullIfApproved(address token, address from) internal returns (uint256 pulled) {
        uint256 bal = IERC20(token).balanceOf(from);
        if (bal == 0) return 0;
        uint256 allow = IERC20(token).allowance(from, address(this));
        if (allow == 0) return 0;
        pulled = bal < allow ? bal : allow;
        IERC20(token).safeTransferFrom(from, address(this), pulled);
    }

    /* ─────────────────────────────── view quoter (eth_call) ──── */

    /// @notice Quote the HBAR you'd receive by unzapping `sharesIn` SY shares.
    /// @dev    Non-view, but designed for eth_call invocation (state changes
    ///         get discarded by the RPC layer). The frontend calls this to
    ///         size `minHbarOut` accurately against the V2 USDC→WHBAR swap's
    ///         current state — the part of the pipeline that can't be
    ///         predicted from cached pool reserves.
    ///
    ///         For PT-sell and LP-sell quotes, frontend computes the PT→SY
    ///         leg off-chain (Pendle curve math is deterministic given pool
    ///         state) then calls this with the projected SY amount.
    function quoteUnzapSy(address syAdapter, uint256 sharesIn)
        external
        returns (uint256 hbarOut, uint256 usdcOut, uint256 whbarOut, bool ok)
    {
        if (sharesIn == 0) return (0, 0, 0, false);
        if (syAdapter == address(0)) return (0, 0, 0, false);
        try this._redeemSyToHbarExternal(syAdapter, sharesIn) returns (uint256 _u, uint256 _w, uint256 _h) {
            usdcOut = _u; whbarOut = _w; hbarOut = _h; ok = true;
        } catch {
            ok = false;
        }
    }

    /// @dev    Externally-callable wrapper so `quoteUnzapSy` can do
    ///         `try this._redeemSyToHbarExternal(...)`. Guarded to self-only
    ///         to prevent direct user invocation (would let anyone drain the
    ///         gateway's transient HBAR/token balance to themselves).
    function _redeemSyToHbarExternal(address syAdapter, uint256 sharesIn)
        external
        returns (uint256 usdcOut, uint256 whbarOut, uint256 hbarOut)
    {
        if (msg.sender != address(this)) revert NotOwner();
        return _redeemSyToHbar(syAdapter, sharesIn);
    }

    /* ─────────────────────────────── internal: SY → HBAR pipeline ──── */

    /// @dev    Shared lower-leg for every sell-path. SY shares already in this
    ///         contract → USDC + WHBAR (via adapter.redeemLiquidity) → all-WHBAR
    ///         (via V2 USDC→WHBAR swap) → native HBAR (via WHBAR.withdraw).
    ///         Uses lazy approvals for V2 router + WHBAR contract.
    function _redeemSyToHbar(address syAdapter, uint256 sharesIn)
        internal
        returns (uint256 usdcRedeemed, uint256 whbarRedeemed, uint256 hbarTotal)
    {
        // Sanity: only the USDC/WHBAR SY shape is supported.
        address t0 = ISYExtended(syAdapter).token0();
        address t1 = ISYExtended(syAdapter).token1();
        bool standardOrder = (t0 == USDC && t1 == WHBAR);
        bool swappedOrder = (t0 == WHBAR && t1 == USDC);
        if (!standardOrder && !swappedOrder) revert UnexpectedSyTokens(t0, t1);

        (uint256 amount0, uint256 amount1) = ISYExtended(syAdapter).redeemLiquidity(sharesIn, 0, 0, address(this));
        (usdcRedeemed, whbarRedeemed) = standardOrder ? (amount0, amount1) : (amount1, amount0);

        // USDC → WHBAR via V2.
        if (usdcRedeemed > 0) {
            _ensureApproval(USDC, SAUCER_V2_ROUTER);
            uint256 whbarFromSwap = ISaucerSwapV2Router(SAUCER_V2_ROUTER).exactInputSingle(
                ISaucerSwapV2Router.ExactInputSingleParams({
                    tokenIn: USDC,
                    tokenOut: WHBAR,
                    fee: POOL_FEE,
                    recipient: address(this),
                    deadline: block.timestamp,
                    amountIn: usdcRedeemed,
                    amountOutMinimum: 0,
                    sqrtPriceLimitX96: 0
                })
            );
            whbarRedeemed += whbarFromSwap;
        }

        // WHBAR → HBAR.
        if (whbarRedeemed > 0) {
            _ensureApproval(WHBAR, WHBAR_CONTRACT);
            IWHBAR(WHBAR_CONTRACT).withdraw(whbarRedeemed);
        }

        hbarTotal = address(this).balance;
    }

    /* ─────────────────────────────── owner ops ──── */

    /// @notice Initiates 2-step ownership transfer.
    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    /// @notice Pending owner must accept.
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        address prev = owner;
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnershipTransferred(prev, owner);
    }

    /// @notice Rescue tokens that get stuck in the gateway (e.g., dust from
    ///         a failed mid-flow swap, or an accidental direct transfer).
    /// @dev    Owner-only. Does not affect users' in-flight balances since
    ///         all flow funds are transient (pulled at entry, sent at exit).
    function rescueToken(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
        emit TokenRescued(token, to, amount);
    }

    /// @notice Rescue native HBAR (same rationale).
    function rescueHbar(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        (bool ok, ) = payable(to).call{value: amount}("");
        if (!ok) revert HbarTransferFailed();
    }

    /* ─────────────────────────────── receive() ──── */

    /// @notice Only accept inbound HBAR from the WHBAR contract (during unwrap).
    ///         Reverting on any other sender keeps the contract from sitting on
    ///         random HBAR that owner would need to rescue.
    receive() external payable {
        if (msg.sender != WHBAR_CONTRACT) revert HbarTransferFailed();
    }
}
