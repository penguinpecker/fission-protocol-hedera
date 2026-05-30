// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {FissionPeriphery} from "../../src/periphery/FissionPeriphery.sol";
import {FissionLens} from "../../src/periphery/FissionLens.sol";
import {FissionRewardsMarket} from "../../src/core/FissionRewardsMarket.sol";
import {SY_SaucerSwapV2LP} from "../../src/sy/SY_SaucerSwapV2LP.sol";
import {MockUniswapV3PositionManager} from "../mocks/MockUniswapV3PositionManager.sol";
import {MockERC20} from "../mocks/MockSY.sol";
import {HtsTestHelper} from "../utils/HtsTestHelper.sol";

/// @notice YT-LEVERAGE (2026-05-31). Proves the leveraged Buy-YT upgrade:
///         buySyForYt now deploys the user's FULL budget into YT (Pendle parity)
///         by fronting the gap from a working-capital reserve and replenishing it
///         from the PT sale — and that the reserve is conserved across every path.
contract FissionPeripheryYtLeverageTest is Test {
    MockERC20 token0;
    MockERC20 token1;
    MockUniswapV3PositionManager npm;
    SY_SaucerSwapV2LP sy;
    address syShare;
    FissionRewardsMarket market;
    FissionLens lens;
    FissionPeriphery periphery;
    address pt;
    address yt;
    address lp;

    address admin = address(0xAD);
    address treasury = address(0xBEEF);
    address owner_ = address(0x0FF1CE);
    address upgrader = address(0xDEAD);
    address user = address(0xA11CE);

    uint256 expiry;
    int256 constant SCALAR_ROOT = 75e18;
    int256 constant LN_FEE_ROOT = 0.0003e18;
    uint256 constant RESERVE_PCT = 80;
    int256 constant INITIAL_ANCHOR = 1.05e18;

    uint256 constant RESERVE_SEED = 50_000e6;

    function setUp() public {
        HtsTestHelper.installHtsPrecompile();

        MockERC20 a = new MockERC20("USDC", "USDC", 6);
        MockERC20 b = new MockERC20("WHBAR", "WHBAR", 6);
        if (address(a) < address(b)) (token0, token1) = (a, b);
        else (token0, token1) = (b, a);

        npm = new MockUniswapV3PositionManager();
        sy = new SY_SaucerSwapV2LP(
            "SY-V2LP", "SY-V2LP", address(token0), address(token1), 1500, -60, 60, address(npm), admin, 0
        );
        sy.initShareToken();
        syShare = sy.shareToken();

        token0.mint(address(this), 10_000_000e6);
        token1.mint(address(this), 10_000_000e6);
        token0.approve(address(sy), type(uint256).max);
        token1.approve(address(sy), type(uint256).max);
        sy.depositLiquidity(2_000_000e6, 2_000_000e6, 0, 0, address(this), 0);

        expiry = block.timestamp + 90 days;
        market = new FissionRewardsMarket(address(sy), expiry, SCALAR_ROOT, admin, treasury, 18, address(0));
        market.setTokens("fPT", "fPT", "fYT", "fYT", "fLP", "fLP");
        pt = market.pt();
        yt = market.yt();
        lp = market.lp();

        // Seed the curve AS ADMIN (split + initialize are ADMIN_ROLE-gated): give
        // admin 200k SY, split 100k -> PT+YT, initialize the pool with 100k SY +
        // 100k PT (admin keeps the YT).
        IERC20(syShare).transfer(admin, 200_000e6);
        vm.startPrank(admin);
        IERC20(syShare).approve(address(market), type(uint256).max);
        IERC20(pt).approve(address(market), type(uint256).max);
        market.split(100_000e6);
        market.initialize(100_000e6, 100_000e6, INITIAL_ANCHOR, LN_FEE_ROOT, RESERVE_PCT);
        vm.stopPrank();

        // Periphery behind a proxy.
        address[] memory none = new address[](0);
        FissionPeriphery impl = new FissionPeriphery();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(impl),
            abi.encodeCall(
                FissionPeriphery.initialize,
                (address(0x1001), address(token1), address(token0), address(0x1004), address(npm), owner_, upgrader, none)
            )
        );
        periphery = FissionPeriphery(payable(address(proxy)));

        // Freeze-exempt + register the periphery on the market.
        vm.prank(admin);
        market.setPeriphery(address(periphery));
        vm.prank(owner_);
        periphery.registerMarket(address(market));

        // Lens (view-only; impl callable directly).
        lens = new FissionLens();

        // Fund the working-capital reserve from this test contract's SY shares.
        IERC20(syShare).transfer(owner_, RESERVE_SEED);
        vm.startPrank(owner_);
        IERC20(syShare).approve(address(periphery), RESERVE_SEED);
        periphery.fundSyReserve(syShare, RESERVE_SEED);
        vm.stopPrank();
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    function _giveUserSy(uint256 amount) internal {
        IERC20(syShare).transfer(user, amount);
    }

    function _periBal() internal view returns (uint256) {
        return IERC20(syShare).balanceOf(address(periphery));
    }

    // ── 1. the headline: FULL budget deploys into YT, reserve restored ─────────

    function test_leverage_fullDeploymentAndReserveWhole() public {
        assertEq(_periBal(), RESERVE_SEED, "reserve seeded");
        assertEq(periphery.syReserve(syShare), RESERVE_SEED, "reserve booked");

        uint256 ytOut = 1_000e6;       // want the FULL 1000 YT
        uint256 budget = 1_000e6;      // willing to spend up to 1000 SY (>> the ~yield-slice cost)
        _giveUserSy(budget);

        uint256 userYtBefore = market.ytBalanceOf(user);

        vm.startPrank(user);
        IERC20(syShare).approve(address(periphery), budget);
        (uint256 ytDelivered, uint256 syPaid) = periphery.buySyForYt(address(market), ytOut, budget, user, 0);
        vm.stopPrank();

        // Full YT delivered (NOT the ~2% old split-and-refund behavior).
        assertEq(ytDelivered, ytOut, "ytDelivered == requested ytOut");
        assertEq(market.ytBalanceOf(user) - userYtBefore, ytOut, "user holds the FULL ytOut YT");

        // Leverage: net cost is the small yield slice, far below the gross ytOut.
        assertGt(syPaid, 0, "net cost positive");
        assertLt(syPaid, ytOut / 4, "net cost << ytOut (leveraged, not 1:1 gross)");

        // Reserve conserved EXACTLY — periphery holds precisely the reserve again.
        assertEq(_periBal(), RESERVE_SEED, "periphery SY balance back to exactly the reserve");
        assertEq(periphery.syReserve(syShare), RESERVE_SEED, "booked reserve unchanged");

        // User's unused budget refunded; net out-of-pocket == syPaid.
        assertEq(IERC20(syShare).balanceOf(user), budget - syPaid, "excess budget refunded");
    }

    // ── 2. budget cap: an under-budget call reverts, never over-charges ────────

    function test_budgetCap_revertsWhenBudgetTooSmall() public {
        uint256 ytOut = 1_000e6;
        uint256 tinyBudget = 1; // 1 wei — far below the real net cost
        _giveUserSy(tinyBudget);
        vm.startPrank(user);
        IERC20(syShare).approve(address(periphery), tinyBudget);
        // minSyFromPt = ytOut - 1 floors the PT sale unreachably high → swap reverts.
        vm.expectRevert();
        periphery.buySyForYt(address(market), ytOut, tinyBudget, user, 0);
        vm.stopPrank();
        // Reserve untouched after the revert.
        assertEq(_periBal(), RESERVE_SEED, "reserve intact after revert");
    }

    // ── 3. insufficient reserve: ytOut exceeds reserve + budget ────────────────

    function test_insufficientReserve_reverts() public {
        // Shrink the reserve so a WITHIN-CAP ytOut can still exceed reserve+budget
        // (otherwise _checkSize's TradeExceedsCap fires first on a huge ytOut).
        vm.prank(owner_);
        periphery.withdrawSyReserve(syShare, owner_, RESERVE_SEED - 100e6); // leave 100 SY
        uint256 ytOut = 1_000e6;  // ≤ 5% cap (5_000e6), but > reserve(100) + budget(50)
        uint256 budget = 50e6;
        _giveUserSy(budget);
        vm.startPrank(user);
        IERC20(syShare).approve(address(periphery), budget);
        vm.expectRevert(
            abi.encodeWithSelector(FissionPeriphery.InsufficientReserve.selector, ytOut, 100e6 + budget)
        );
        periphery.buySyForYt(address(market), ytOut, budget, user, 0);
        vm.stopPrank();
        assertEq(_periBal(), 100e6, "reserve intact at its reduced level");
    }

    // ── 4. unfunded reserve degrades to the safe non-leveraged path ────────────

    function test_unfundedReserve_requiresGrossBudget() public {
        // Drain the reserve back out.
        vm.prank(owner_);
        periphery.withdrawSyReserve(syShare, owner_, RESERVE_SEED);
        assertEq(periphery.syReserve(syShare), 0, "reserve emptied");
        assertEq(_periBal(), 0, "no SY held");

        uint256 ytOut = 1_000e6;
        // With no reserve, the user must front the full gross (budget >= ytOut).
        uint256 tooSmall = 500e6;
        _giveUserSy(ytOut); // give plenty so the only failure is the reserve check
        vm.startPrank(user);
        IERC20(syShare).approve(address(periphery), type(uint256).max);
        vm.expectRevert(
            abi.encodeWithSelector(FissionPeriphery.InsufficientReserve.selector, ytOut, tooSmall)
        );
        periphery.buySyForYt(address(market), ytOut, tooSmall, user, 0);

        // Fronting the gross (budget >= ytOut) succeeds — the old behavior.
        (uint256 ytDelivered,) = periphery.buySyForYt(address(market), ytOut, ytOut, user, 0);
        vm.stopPrank();
        assertEq(ytDelivered, ytOut, "gross-funded buy still delivers full YT");
    }

    // ── 5. reserve is NOT swept by buySyForLp's SY refund path ─────────────────

    function test_reserveSurvivesBuyLpSweep() public {
        uint256 syIn = 2_000e6;
        _giveUserSy(syIn);
        vm.startPrank(user);
        IERC20(syShare).approve(address(periphery), syIn);
        // buySyForLp ends by sweeping leftover SY to msg.sender — must NOT take the reserve.
        // args: (market, syIn, ptShareBps, ptOutFromSwap, minLpOut, receiver, deadline)
        periphery.buySyForLp(address(market), syIn, 5000, 900e6, 1, user, 0);
        vm.stopPrank();
        assertGe(_periBal(), RESERVE_SEED, "reserve survived the buySyForLp SY sweep");
        assertEq(periphery.syReserve(syShare), RESERVE_SEED, "booked reserve unchanged");
    }

    // ── 6. fund / withdraw reserve accounting ──────────────────────────────────

    function test_fundAndWithdrawReserveAccounting() public {
        uint256 extra = 10_000e6;
        IERC20(syShare).transfer(owner_, extra);
        vm.startPrank(owner_);
        IERC20(syShare).approve(address(periphery), extra);
        periphery.fundSyReserve(syShare, extra);
        assertEq(periphery.syReserve(syShare), RESERVE_SEED + extra, "reserve += extra");

        periphery.withdrawSyReserve(syShare, owner_, extra);
        assertEq(periphery.syReserve(syShare), RESERVE_SEED, "reserve -= extra");
        // Cannot withdraw more than booked.
        vm.expectRevert(
            abi.encodeWithSelector(FissionPeriphery.InsufficientReserve.selector, RESERVE_SEED + 1, RESERVE_SEED)
        );
        periphery.withdrawSyReserve(syShare, owner_, RESERVE_SEED + 1);
        vm.stopPrank();
    }

    // ── SIMULATION: same budget, OLD (split+refund) vs NEW (leveraged) ─────────

    function test_sim_beforeVsAfter() public {
        uint256 budget = 200e6; // 200 SY budget, same for both paths

        // BEFORE (old behavior): provide `budget` as syIn -> get `budget` YT, the
        // PT half is sold and refunded. Deployed-into-YT = budget - ptRefund.
        // Replicate the exact old path: split `budget`, sell `budget` PT.
        IERC20(syShare).transfer(address(this), 0); // no-op clarity
        uint256 oldYt = budget;                       // old delivered YT == syIn (1:1)
        // ptRefund the old path would return = sale proceeds of `budget` PT:
        uint256 oldPtRefund = lens.previewSwapExactPtForSy(address(market), budget);
        uint256 oldNetIntoYt = budget - oldPtRefund;  // what actually funded the YT

        // AFTER (leveraged): same budget deploys fully.
        (uint256 newYt, uint256 newNet) = lens.previewBuyYt(address(market), budget, periphery.maxTradeBps());

        console2.log("=== Buy-YT: spend 200 SY (6dp), BEFORE vs AFTER ===");
        console2.log("BEFORE  YT received   :", oldYt);
        console2.log("BEFORE  ~refunded SY  :", oldPtRefund);
        console2.log("BEFORE  net into YT   :", oldNetIntoYt);
        console2.log("AFTER   YT received   :", newYt);
        console2.log("AFTER   net cost SY   :", newNet);
        console2.log("leverage multiple (newYt/oldYt x1000):", (newYt * 1000) / oldYt);

        // The new path delivers many times more YT for ~the same money.
        assertGt(newYt, oldYt * 5, "leveraged buy delivers >5x the YT of the old split-and-refund");
        assertLe(newNet, budget, "new net cost within budget");
    }

    // ── 7. Lens previewBuyYt sizes a trade the contract then honors ────────────

    function test_previewBuyYt_matchesExecution() public {
        uint256 budget = 200e6;
        (uint256 ytPreview, uint256 netPreview) = lens.previewBuyYt(address(market), budget, periphery.maxTradeBps());
        assertGt(ytPreview, 0, "preview returns a YT amount");
        assertLe(netPreview, budget, "preview net cost within budget");
        // The previewed YT must be a leveraged multiple of the budget (>> 1:1).
        assertGt(ytPreview, budget, "previewed YT exceeds the SY budget (leverage)");

        // Execute with the previewed size + a small slippage cushion.
        uint256 maxSyIn = (budget * 105) / 100;
        _giveUserSy(maxSyIn);
        vm.startPrank(user);
        IERC20(syShare).approve(address(periphery), maxSyIn);
        (uint256 ytDelivered, uint256 syPaid) = periphery.buySyForYt(address(market), ytPreview, maxSyIn, user, 0);
        vm.stopPrank();
        assertEq(ytDelivered, ytPreview, "delivered the previewed YT");
        assertApproxEqRel(syPaid, netPreview, 0.02e18, "actual net ~ previewed net (within 2pct)");
        assertEq(_periBal(), RESERVE_SEED, "reserve whole");
    }

    // ── AUDIT-FIX #1: preview clamps to the on-chain cap so the buy never reverts ─

    function test_auditFix1_previewClampedToCapBuySucceeds() public {
        uint256 cap = (market.totalSy() * periphery.maxTradeBps()) / 10000; // on-chain 5% cap
        // A budget large enough that the UNCLAMPED (10%) ceiling would quote above the cap.
        uint256 bigBudget = 1_000e6;
        (uint256 ytPreview, uint256 netPreview) =
            lens.previewBuyYt(address(market), bigBudget, periphery.maxTradeBps());
        assertGt(ytPreview, 0, "preview returns YT");
        assertLe(ytPreview, cap, "preview clamped to the on-chain per-trade cap");

        // Buying exactly the previewed YT must SUCCEED (no TradeExceedsCap).
        uint256 maxSyIn = (netPreview * 105) / 100 + 1;
        _giveUserSy(maxSyIn);
        vm.startPrank(user);
        IERC20(syShare).approve(address(periphery), maxSyIn);
        (uint256 ytDelivered,) = periphery.buySyForYt(address(market), ytPreview, maxSyIn, user, 0);
        vm.stopPrank();
        assertEq(ytDelivered, ytPreview, "buy of previewed (cap-clamped) YT succeeds");
        assertEq(_periBal(), RESERVE_SEED, "reserve whole");
    }

    // ── AUDIT-FIX #2: a donated SY balance cannot brick the buy ────────────────

    function test_auditFix2_donationDoesNotBrickBuy() public {
        // Griefer donates SY straight to the periphery (un-booked, above reserve).
        IERC20(syShare).transfer(address(periphery), 5_000e6);

        uint256 ytOut = 1_000e6;
        uint256 budget = 1_000e6;
        _giveUserSy(budget);
        uint256 userYtBefore = market.ytBalanceOf(user);
        vm.startPrank(user);
        IERC20(syShare).approve(address(periphery), budget);
        (uint256 ytDelivered, uint256 syPaid) = periphery.buySyForYt(address(market), ytOut, budget, user, 0);
        vm.stopPrank();

        assertEq(ytDelivered, ytOut, "buy still delivers full YT despite donation");
        assertEq(market.ytBalanceOf(user) - userYtBefore, ytOut, "user got the YT");
        assertGt(syPaid, 0, "charged the real net cost (not skewed by donation)");
        assertLt(syPaid, ytOut / 4, "leverage intact");
        assertEq(periphery.syReserve(syShare), RESERVE_SEED, "booked reserve unchanged");
        assertGe(_periBal(), RESERVE_SEED, "reserve still backed");
    }

    // ── AUDIT-FIX #2b: owner can recover the donated excess, never the reserve ──

    function test_auditFix2b_sweepExcessRecoversDonationNotReserve() public {
        uint256 donation = 3_000e6;
        IERC20(syShare).transfer(address(periphery), donation);
        uint256 ownerBefore = IERC20(syShare).balanceOf(owner_);

        vm.prank(owner_);
        uint256 swept = periphery.sweepExcessSy(syShare, owner_);

        assertEq(swept, donation, "sweeps exactly the un-booked excess");
        assertEq(IERC20(syShare).balanceOf(owner_) - ownerBefore, donation, "owner received the donation");
        assertEq(_periBal(), RESERVE_SEED, "periphery left holding exactly the reserve");
        assertEq(periphery.syReserve(syShare), RESERVE_SEED, "booked reserve unchanged");
    }
}
