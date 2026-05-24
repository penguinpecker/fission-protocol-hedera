// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice One-tx "sell PT/LP/SY for native HBAR" composition layer.
///
///         Mirror of FissionZap: takes the position-token (PT or LP or SY
///         shares), unwinds it through the protocol stack, and delivers
///         native HBAR to the user's wallet. Solves the UX gap where
///         router.swapExactPtForSy returns SY shares — useful inside the
///         protocol but opaque to users who started with HBAR and expect
///         to receive HBAR.
///
///         Composition order for sellPtForHbar:
///           1. Pull PT from user (HTS transferFrom; user pre-approves)
///           2. router_v3.swapExactPtForSy → SY held by this contract
///           3. sy.redeemLiquidity → USDC + WHBAR collected here
///           4. SaucerSwap V2 exactInputSingle: USDC → WHBAR (single tier)
///           5. WHBAR_CONTRACT.withdraw → native HBAR held by this contract
///           6. payable(receiver).call{value: hbarOut}("") → wallet
///
///         For YT this contract exposes `unzapSy` only — YT is HTS-frozen
///         and can ONLY be wiped by the market when msg.sender holds it,
///         so the unzap can't proxy. Frontend chains:
///           a. user → market.swapExactYtForSy(receiver=user) → SY in wallet
///           b. user → approve(SY → unzap) → unzap.unzapSy(...)
///         (2 user signatures, but each is a simple atomic step.)
///
///         No admin role; no upgrade path. If SaucerSwap routes change,
///         deploy a new unzap and switch the frontend over.
///
/// @dev    Designed to mirror FissionZap's auditable-by-inspection style.
///         All external calls are to addresses pinned at construction.
///         Reentrancy guard is belt-and-suspenders given the multi-step
///         flow + token transfers.

interface ISYRedeemLiquidity {
    function redeemLiquidity(
        uint256 shares,
        uint256 amount0Min,
        uint256 amount1Min,
        address receiver
    ) external returns (uint256 amount0, uint256 amount1);

    /// @dev Used so the unzap can resolve token0/token1 at call time rather
    ///      than assuming an order — protects against a future SY deploy
    ///      with swapped USDC/WHBAR positions.
    function token0() external view returns (address);
    function token1() external view returns (address);
}

interface IActionRouterV3 {
    function swapExactPtForSy(
        address market,
        uint256 ptIn,
        uint256 minSyOut,
        address receiver,
        uint256 deadline
    ) external returns (uint256 syOut);

    function removeLiquidityProportional(
        address market,
        uint256 lpIn,
        uint256 minSyOut,
        uint256 minPtOut,
        address receiver,
        uint256 deadline
    ) external returns (uint256 syOut, uint256 ptOut);
}

interface IFissionMarket {
    function sy() external view returns (address);
    function pt() external view returns (address);
    function lp() external view returns (address);
}

interface IWHBAR {
    /// @notice Unwraps WHBAR back to native HBAR sent to msg.sender.
    function withdraw(uint256 amount) external;
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
    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);
}

contract FissionUnzap is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // Pinned mainnet addresses (Hedera). Match the FissionZap deployment;
    // if SaucerSwap migrates routers or the WHBAR-USDC fee tier changes,
    // deploy a new unzap rather than upgrading.
    address public immutable WHBAR_CONTRACT;   // unwraps WHBAR → HBAR
    address public immutable WHBAR;            // HTS token address
    address public immutable USDC;             // HTS token address
    address public immutable SAUCER_V2_ROUTER; // SwapRouter01
    address public immutable ROUTER;           // ActionRouter v3 (Fission)

    uint24 public constant POOL_FEE = 1500; // 0.15% (USDC/WHBAR tier)

    error AmountZero();
    error ZeroAddress();
    error DeadlineExpired();
    error InsufficientHbarOut(uint256 received, uint256 minimum);
    error UnexpectedSyTokens(address token0_, address token1_);
    error HbarTransferFailed();

    event SellPtForHbar(
        address indexed user,
        address indexed market,
        uint256 ptIn,
        uint256 syOut,
        uint256 usdcRedeemed,
        uint256 whbarRedeemed,
        uint256 hbarOut
    );
    event UnzapSyForHbar(
        address indexed user,
        address indexed sy,
        uint256 sharesIn,
        uint256 usdcRedeemed,
        uint256 whbarRedeemed,
        uint256 hbarOut
    );
    event SellLpForHbar(
        address indexed user,
        address indexed market,
        uint256 lpIn,
        uint256 syOut,
        uint256 ptOut,
        uint256 ptSyOut,
        uint256 hbarOut
    );

    modifier checkDeadline(uint256 deadline) {
        if (deadline != 0 && block.timestamp > deadline) revert DeadlineExpired();
        _;
    }

    constructor(
        address whbarContract,
        address whbar,
        address usdc,
        address saucerV2Router,
        address router
    ) {
        if (
            whbarContract == address(0) ||
            whbar == address(0) ||
            usdc == address(0) ||
            saucerV2Router == address(0) ||
            router == address(0)
        ) revert ZeroAddress();
        WHBAR_CONTRACT = whbarContract;
        WHBAR = whbar;
        USDC = usdc;
        SAUCER_V2_ROUTER = saucerV2Router;
        ROUTER = router;
    }

    // ─────────────────── PT → HBAR (1 tx) ───────────────────

    /// @notice Sells `ptIn` PT for native HBAR delivered to `receiver`.
    /// @dev User must `approve(this, ptIn)` on the PT HTS token first. The
    ///      unzap forces an approve to the router internally per call so
    ///      this contract never holds standing allowances against tokens
    ///      it didn't pull this tx.
    function sellPtForHbar(
        address market,
        uint256 ptIn,
        uint256 minHbarOut,
        address payable receiver,
        uint256 deadline
    ) external nonReentrant checkDeadline(deadline) returns (uint256 hbarOut) {
        if (ptIn == 0) revert AmountZero();
        if (receiver == address(0)) revert ZeroAddress();

        address pt = IFissionMarket(market).pt();
        address sy = IFissionMarket(market).sy();

        // Step 1: pull PT.
        IERC20(pt).safeTransferFrom(msg.sender, address(this), ptIn);

        // Step 2: PT → SY via router.
        IERC20(pt).forceApprove(ROUTER, ptIn);
        uint256 syOut = IActionRouterV3(ROUTER).swapExactPtForSy(
            market,
            ptIn,
            1, // minSyOut handled by minHbarOut at the end
            address(this),
            deadline
        );

        // Steps 3-6: SY → USDC + WHBAR → all-WHBAR → HBAR → receiver.
        (uint256 usdcRedeemed, uint256 whbarRedeemed, uint256 hbarRedeemed) =
            _redeemSyToHbar(sy, syOut);

        if (hbarRedeemed < minHbarOut) {
            revert InsufficientHbarOut(hbarRedeemed, minHbarOut);
        }

        // Step 7: send HBAR.
        (bool ok,) = receiver.call{value: hbarRedeemed}("");
        if (!ok) revert HbarTransferFailed();

        emit SellPtForHbar(msg.sender, market, ptIn, syOut, usdcRedeemed, whbarRedeemed, hbarRedeemed);
        return hbarRedeemed;
    }

    // ─────────────────── SY → HBAR (1 tx, helper) ───────────────────

    /// @notice Pulls `sharesIn` SY shares and delivers HBAR to `receiver`.
    /// @dev    Use cases:
    ///           - YT-sellers chain this after calling
    ///             market.swapExactYtForSy directly (2 user signatures).
    ///           - Anyone who already holds SY (incl. from earlier zap)
    ///             can cash out to HBAR in one tx.
    function unzapSy(
        address sy,
        uint256 sharesIn,
        uint256 minHbarOut,
        address payable receiver
    ) external nonReentrant returns (uint256 hbarOut) {
        if (sharesIn == 0) revert AmountZero();
        if (receiver == address(0)) revert ZeroAddress();

        // Pull SY shares (HTS token).
        IERC20(sy).safeTransferFrom(msg.sender, address(this), sharesIn);

        (uint256 usdcRedeemed, uint256 whbarRedeemed, uint256 hbarRedeemed) =
            _redeemSyToHbar(sy, sharesIn);

        if (hbarRedeemed < minHbarOut) {
            revert InsufficientHbarOut(hbarRedeemed, minHbarOut);
        }

        (bool ok,) = receiver.call{value: hbarRedeemed}("");
        if (!ok) revert HbarTransferFailed();

        emit UnzapSyForHbar(msg.sender, sy, sharesIn, usdcRedeemed, whbarRedeemed, hbarRedeemed);
        return hbarRedeemed;
    }

    // ─────────────────── LP → HBAR (1 tx) ───────────────────

    /// @notice Burns `lpIn` LP, redeems both halves (SY + PT) to HBAR.
    /// @dev    Composition: removeLiquidityProportional → SY half routed
    ///         straight through _redeemSyToHbar; PT half routed through
    ///         router.swapExactPtForSy then merged into the SY pool before
    ///         the single redeem call. One redeemLiquidity instead of two
    ///         keeps the gas envelope reasonable.
    function sellLpForHbar(
        address market,
        uint256 lpIn,
        uint256 minHbarOut,
        address payable receiver,
        uint256 deadline
    ) external nonReentrant checkDeadline(deadline) returns (uint256 hbarOut) {
        if (lpIn == 0) revert AmountZero();
        if (receiver == address(0)) revert ZeroAddress();

        address lp = IFissionMarket(market).lp();
        address pt = IFissionMarket(market).pt();
        address sy = IFissionMarket(market).sy();

        // Pull LP from user.
        IERC20(lp).safeTransferFrom(msg.sender, address(this), lpIn);
        IERC20(lp).forceApprove(ROUTER, lpIn);

        // Remove proportional liquidity → SY + PT to this contract.
        (uint256 syHalf, uint256 ptHalf) = IActionRouterV3(ROUTER).removeLiquidityProportional(
            market,
            lpIn,
            1, // mins gated by the final HBAR floor
            1,
            address(this),
            deadline
        );

        // PT → SY via router.
        uint256 ptSyOut = 0;
        if (ptHalf > 0) {
            IERC20(pt).forceApprove(ROUTER, ptHalf);
            ptSyOut = IActionRouterV3(ROUTER).swapExactPtForSy(
                market,
                ptHalf,
                1,
                address(this),
                deadline
            );
        }

        uint256 totalSy = syHalf + ptSyOut;
        (uint256 usdcRedeemed, uint256 whbarRedeemed, uint256 hbarRedeemed) =
            _redeemSyToHbar(sy, totalSy);

        if (hbarRedeemed < minHbarOut) {
            revert InsufficientHbarOut(hbarRedeemed, minHbarOut);
        }

        (bool ok,) = receiver.call{value: hbarRedeemed}("");
        if (!ok) revert HbarTransferFailed();

        emit SellLpForHbar(msg.sender, market, lpIn, syHalf, ptHalf, ptSyOut, hbarRedeemed);
        // silence unused-var warnings when compiler optimizer doesn't fold them
        usdcRedeemed; whbarRedeemed;
        return hbarRedeemed;
    }

    // ─────────────────── internal: SY → HBAR ───────────────────

    /// @dev Burns SY shares held by THIS contract → redeems V3 LP to
    ///      USDC + WHBAR → swaps USDC to WHBAR via SaucerSwap V2 →
    ///      withdraws all WHBAR to native HBAR. Returns the breakdown
    ///      for event emission; the HBAR sits in this contract for the
    ///      caller to forward.
    function _redeemSyToHbar(address sy, uint256 sharesIn)
        internal
        returns (uint256 usdcRedeemed, uint256 whbarRedeemed, uint256 hbarTotal)
    {
        // Resolve token positions on the SY at call time so we don't bake
        // assumptions about which is token0 vs token1. The SaucerSwap V2
        // USDC/WHBAR pool was deployed with USDC=token0, WHBAR=token1 but
        // a future SY deploy might invert them.
        address t0 = ISYRedeemLiquidity(sy).token0();
        address t1 = ISYRedeemLiquidity(sy).token1();
        // Defensive: this unzap is hard-coded for the USDC/WHBAR SY. If
        // someone deploys a different SY (HBARX, EURC, etc.) we don't
        // know how to unwind it; revert clearly instead of mis-routing.
        bool standardOrder = (t0 == USDC && t1 == WHBAR);
        bool swappedOrder = (t0 == WHBAR && t1 == USDC);
        if (!standardOrder && !swappedOrder) {
            revert UnexpectedSyTokens(t0, t1);
        }

        (uint256 amount0, uint256 amount1) =
            ISYRedeemLiquidity(sy).redeemLiquidity(sharesIn, 0, 0, address(this));

        (usdcRedeemed, whbarRedeemed) = standardOrder
            ? (amount0, amount1)
            : (amount1, amount0);

        // Swap USDC → WHBAR via SaucerSwap V2 (single-hop, 0.15% tier).
        // Skip if no USDC was redeemed (e.g., position fully in WHBAR side).
        if (usdcRedeemed > 0) {
            IERC20(USDC).forceApprove(SAUCER_V2_ROUTER, usdcRedeemed);
            uint256 whbarFromSwap = ISaucerSwapV2Router(SAUCER_V2_ROUTER).exactInputSingle(
                ISaucerSwapV2Router.ExactInputSingleParams({
                    tokenIn: USDC,
                    tokenOut: WHBAR,
                    fee: POOL_FEE,
                    recipient: address(this),
                    deadline: block.timestamp,
                    amountIn: usdcRedeemed,
                    amountOutMinimum: 0, // gated by final minHbarOut at caller
                    sqrtPriceLimitX96: 0
                })
            );
            whbarRedeemed += whbarFromSwap;
        }

        // Unwrap all WHBAR → native HBAR.
        // WHBAR contract pulls WHBAR from us via transferFrom (it's the
        // spender of its own burn flow), so allowance must be granted
        // FIRST. Verified empirically: omitting this caused
        // SPENDER_DOES_NOT_HAVE_ALLOWANCE on smoke tx
        // 0.0.10463169@1779659550 (the bug that delayed v1).
        if (whbarRedeemed > 0) {
            IERC20(WHBAR).forceApprove(WHBAR_CONTRACT, whbarRedeemed);
            IWHBAR(WHBAR_CONTRACT).withdraw(whbarRedeemed);
        }

        hbarTotal = address(this).balance;
    }

    /// @dev Accept native HBAR from WHBAR.withdraw. Restrict to the
    ///      WHBAR_CONTRACT to prevent accidental dust deposits from
    ///      randoms that could later be swept by the next caller.
    receive() external payable {
        if (msg.sender != WHBAR_CONTRACT) revert HbarTransferFailed();
    }
}
