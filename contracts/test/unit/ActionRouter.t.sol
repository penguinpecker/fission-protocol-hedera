// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ActionRouter} from "../../src/periphery/ActionRouter.sol";
import {FissionMarket} from "../../src/core/FissionMarket.sol";
import {IFissionMarketCommon} from "../../src/interfaces/IFissionMarketCommon.sol";
import {MockSY, MockERC20} from "../mocks/MockSY.sol";
import {HtsTestHelper} from "../utils/HtsTestHelper.sol";

contract ActionRouterTest is Test {
    MockERC20 underlying;
    MockSY sy;
    address syShare;  // cached sy.shareToken() — vm.prank-safe
    FissionMarket market;
    address pt;
    address yt;
    ActionRouter router;

    address admin = address(0xAD);
    address treasury = address(0xBE);
    address alice = address(0xA1);

    function setUp() public {
        HtsTestHelper.installHtsPrecompile();

        underlying = new MockERC20("USD", "USD", 18);
        sy = new MockSY(address(underlying), 18);
        syShare = sy.shareToken();

        market = new FissionMarket(
            address(sy), block.timestamp + 90 days, 75e18, admin, treasury, 18, address(0));
        market.setTokens("fPT", "fPT", "fYT", "fYT", "fLP", "fLP");
        pt = market.pt();
        yt = market.yt();

        // Seed pool. Test contract is the deployer.
        sy.mint(address(this), 1_000_000e6);
        IERC20(syShare).approve(address(market), type(uint256).max);
        market.split(500_000e6);
        IERC20(syShare).transfer(admin, 200_000e6);
        IERC20(pt).transfer(admin, 200_000e6);

        vm.startPrank(admin);
        IERC20(syShare).approve(address(market), 100_000e6);
        IERC20(pt).approve(address(market), 100_000e6);
        market.initialize(100_000e6, 100_000e6, 1.05e18, 0.0003e18, 80);
        vm.stopPrank();

        router = new ActionRouter();

        // Fund alice with underlying USD.
        underlying.mint(alice, 100_000e6);
    }

    // ───── deadline ─────

    function test_deadline_revertsPastDeadline() public {
        vm.startPrank(alice);
        underlying.approve(address(router), 1_000e6);
        vm.warp(block.timestamp + 1);
        uint256 oldDeadline = block.timestamp - 1;
        vm.expectRevert(ActionRouter.DeadlineExpired.selector);
        router.depositAndSplit(market, address(underlying), 1_000e6, 0, alice, oldDeadline);
        vm.stopPrank();
    }

    function test_deadline_zeroSkipsCheck() public {
        vm.startPrank(alice);
        underlying.approve(address(router), 1_000e6);
        // deadline = 0 means no check
        router.depositAndSplit(market, address(underlying), 1_000e6, 0, alice, 0);
        vm.stopPrank();
    }

    // ───── depositAndSplit ─────

    function test_depositAndSplit_underlyingToPtYt() public {
        vm.startPrank(alice);
        underlying.approve(address(router), 1_000e6);
        (uint256 ptOut, uint256 ytOut) = router.depositAndSplit(
            market, address(underlying), 1_000e6, 0, alice, block.timestamp + 60
        );
        vm.stopPrank();

        // 1:1 deposit (mock SY) and 1:1 split → 1000 PT and 1000 YT.
        assertEq(ptOut, 1_000e6);
        assertEq(ytOut, 1_000e6);
        assertEq(IERC20(pt).balanceOf(alice), 1_000e6);
        assertEq(IERC20(yt).balanceOf(alice), 1_000e6);
        // Router holds nothing.
        assertEq(IERC20(syShare).balanceOf(address(router)), 0);
        assertEq(IERC20(pt).balanceOf(address(router)), 0);
        assertEq(IERC20(yt).balanceOf(address(router)), 0);
    }

    function test_depositAndSplit_slippage() public {
        vm.startPrank(alice);
        underlying.approve(address(router), 1_000e6);
        vm.expectRevert(ActionRouter.SlippageExceeded.selector);
        router.depositAndSplit(market, address(underlying), 1_000e6, 1_001e6, alice, 0);
        vm.stopPrank();
    }

    // ───── swapExactSyForPt ─────

    function test_swapExactSyForPt_buysPt() public {
        // Alice gets some SY first.
        vm.startPrank(alice);
        underlying.approve(address(router), 5_000e6);
        router.depositAndSplit(market, address(underlying), 5_000e6, 0, alice, 0);

        // Now alice has 5000 PT + 5000 YT. Use SY (from a fresh deposit) to buy more PT.
        underlying.approve(address(sy), 5_000e6);
        sy.deposit(alice, address(underlying), 5_000e6, 0);

        IERC20(syShare).approve(address(router), 5_000e6);
        uint256 ptBefore = IERC20(pt).balanceOf(alice);
        uint256 ptDesired = 1_000e6;
        uint256 syUsed = router.swapExactSyForPt(market, 5_000e6, ptDesired, alice, 0);
        uint256 ptAfter = IERC20(pt).balanceOf(alice);
        vm.stopPrank();

        assertEq(ptAfter - ptBefore, ptDesired);
        assertGt(syUsed, 0);
        assertLt(syUsed, 5_000e6);
        // Refund returned to alice (IERC20(syShare).balanceOf(router) == 0 invariant).
        assertEq(IERC20(syShare).balanceOf(address(router)), 0);
    }

    // ───── buyYT (long yield) ─────

    function test_buyYT_userGetsYTAndRefund() public {
        vm.startPrank(alice);
        underlying.approve(address(sy), 10_000e6);
        sy.deposit(alice, address(underlying), 10_000e6, 0);
        // Alice has 10000 SY now.

        IERC20(syShare).approve(address(router), 5_000e6);
        uint256 syBefore = IERC20(syShare).balanceOf(alice);
        (uint256 ytOut, uint256 syRefund) = router.buyYT(market, 5_000e6, 0, alice, 0);
        uint256 syAfter = IERC20(syShare).balanceOf(alice);
        vm.stopPrank();

        // ytOut = 5_000 (split is 1:1). syRefund = SY received from PT sale.
        assertEq(ytOut, 5_000e6);
        assertEq(IERC20(yt).balanceOf(alice), 5_000e6);

        // Net SY out of alice's pocket = 5_000 - syRefund.
        // syBefore was 10_000 (after deposit), alice paid 5_000 SY in, got syRefund back.
        assertEq(syAfter, syBefore - 5_000e6 + syRefund);
        assertGt(syRefund, 0);
        assertLt(syRefund, 5_000e6); // PT sells at a discount; refund < SY paid
    }

    function test_buyYT_slippageOnPtSale() public {
        vm.startPrank(alice);
        underlying.approve(address(sy), 5_000e6);
        sy.deposit(alice, address(underlying), 5_000e6, 0);

        IERC20(syShare).approve(address(router), 5_000e6);
        // Demand impossible-high min SY out from PT sale; should revert in market.
        vm.expectRevert();
        router.buyYT(market, 5_000e6, 5_000e6, alice, 0);
        vm.stopPrank();
    }

    // ───── liquidity ─────

    function test_addLiquidityProportional() public {
        vm.startPrank(alice);
        underlying.approve(address(router), 10_000e6);
        router.depositAndSplit(market, address(underlying), 10_000e6, 0, alice, 0);

        // Alice has 10k PT + 10k YT. Add 5k SY + 5k PT proportionally.
        underlying.approve(address(sy), 5_000e6);
        sy.deposit(alice, address(underlying), 5_000e6, 0);

        IERC20(syShare).approve(address(router), 5_000e6);
        IERC20(pt).approve(address(router), 5_000e6);
        uint256 lpBefore = IERC20(market.lp()).balanceOf(alice);
        uint256 lpOut = router.addLiquidityProportional(market, 5_000e6, 5_000e6, 0, alice, 0);
        uint256 lpAfter = IERC20(market.lp()).balanceOf(alice);
        vm.stopPrank();

        assertEq(lpAfter - lpBefore, lpOut);
        assertGt(lpOut, 0);
    }

    function test_removeLiquidityProportional() public {
        // Admin owns LP from initialize. Transfer some to alice and have her remove.
        // Cache lp() before prank — vm.prank is single-shot, would otherwise be
        // consumed by the view call and the transfer would run as test-contract.
        address lpToken = market.lp();
        vm.prank(admin);
        IERC20(lpToken).transfer(alice, 10_000e6);

        vm.startPrank(alice);
        IERC20(lpToken).approve(address(router), 10_000e6);
        (uint256 syOut, uint256 ptOut) = router.removeLiquidityProportional(
            market, 10_000e6, 0, 0, alice, 0
        );
        vm.stopPrank();

        assertGt(syOut, 0);
        assertGt(ptOut, 0);
        // Router holds nothing afterwards.
        assertEq(IERC20(syShare).balanceOf(address(router)), 0);
        assertEq(IERC20(pt).balanceOf(address(router)), 0);
    }

    // ───── post-expiry ─────

    function test_redeemAfterExpiryAndUnwrap() public {
        // Alice splits 1000 USD → 1000 PT + 1000 YT.
        vm.startPrank(alice);
        underlying.approve(address(router), 1_000e6);
        router.depositAndSplit(market, address(underlying), 1_000e6, 0, alice, 0);
        vm.stopPrank();

        // Time passes; rate grows; expiry hits.
        sy.setExchangeRate(1.05e18);
        vm.warp(market.expiry() + 1);

        // Alice redeems PT via router with unwrap to underlying. YT is HTS-frozen, so
        // the router doesn't accept it — alice keeps her YT (and any residual yield it
        // tracks). The router only handles PT redemption + SY-to-underlying unwrap.
        vm.startPrank(alice);
        IERC20(pt).approve(address(router), 1_000e6);
        uint256 underBefore = underlying.balanceOf(alice);
        uint256 amountOut = router.redeemAfterExpiryAndUnwrap(
            market, 1_000e6, address(underlying), 0, alice, 0
        );
        uint256 underAfter = underlying.balanceOf(alice);
        vm.stopPrank();

        // Mock SY redeems 1:1 (shares→underlying), so amountOut == syOut
        // syOut = 1000 * 1e18 / 1.05e18 ≈ 952.38.
        assertEq(underAfter - underBefore, amountOut);
        assertGt(amountOut, 952e6);
        assertLt(amountOut, 953e6);
    }

    // ───── unwrapSY ─────

    function test_unwrapSY_sharesToUnderlying() public {
        vm.startPrank(alice);
        underlying.approve(address(sy), 500e6);
        sy.deposit(alice, address(underlying), 500e6, 0);

        IERC20(syShare).approve(address(router), 500e6);
        uint256 underBefore = underlying.balanceOf(alice);
        uint256 amountOut = router.unwrapSY(sy, 500e6, address(underlying), 0, alice, 0);
        uint256 underAfter = underlying.balanceOf(alice);
        vm.stopPrank();

        assertEq(underAfter - underBefore, amountOut);
        assertEq(amountOut, 500e6); // mock is 1:1
    }

    // ───── zero-address / amount guards ─────

    function test_zeroAmount_reverts() public {
        vm.startPrank(alice);
        underlying.approve(address(router), 1);
        vm.expectRevert(ActionRouter.ZeroAmount.selector);
        router.depositAndSplit(market, address(underlying), 0, 0, alice, 0);
        vm.stopPrank();
    }

    function test_zeroReceiver_reverts() public {
        vm.startPrank(alice);
        underlying.approve(address(router), 1_000e6);
        vm.expectRevert(ActionRouter.ZeroAddress.selector);
        router.depositAndSplit(market, address(underlying), 1_000e6, 0, address(0), 0);
        vm.stopPrank();
    }

    // ───── revert-path coverage (per-function guard tests) ─────

    function test_swapExactSyForPt_revertsZeroAmounts() public {
        vm.prank(alice);
        vm.expectRevert(ActionRouter.ZeroAmount.selector);
        router.swapExactSyForPt(market, 0, 1, alice, 0);
    }

    function test_swapExactSyForPt_revertsZeroReceiver() public {
        vm.prank(alice);
        vm.expectRevert(ActionRouter.ZeroAddress.selector);
        router.swapExactSyForPt(market, 1, 1, address(0), 0);
    }

    function test_swapExactPtForSy_revertsZeroAmount() public {
        vm.prank(alice);
        vm.expectRevert(ActionRouter.ZeroAmount.selector);
        router.swapExactPtForSy(market, 0, 0, alice, 0);
    }

    function test_swapExactPtForSy_revertsZeroReceiver() public {
        vm.prank(alice);
        vm.expectRevert(ActionRouter.ZeroAddress.selector);
        router.swapExactPtForSy(market, 1, 0, address(0), 0);
    }

    function test_buyYT_revertsZeroBudget() public {
        vm.prank(alice);
        vm.expectRevert(ActionRouter.ZeroAmount.selector);
        router.buyYT(market, 0, 0, alice, 0);
    }

    function test_buyYT_revertsZeroReceiver() public {
        vm.prank(alice);
        vm.expectRevert(ActionRouter.ZeroAddress.selector);
        router.buyYT(market, 1, 0, address(0), 0);
    }

    function test_addLiquidity_revertsZero() public {
        vm.prank(alice);
        vm.expectRevert(ActionRouter.ZeroAmount.selector);
        router.addLiquidityProportional(market, 0, 1, 0, alice, 0);
    }

    function test_addLiquidity_revertsZeroReceiver() public {
        vm.prank(alice);
        vm.expectRevert(ActionRouter.ZeroAddress.selector);
        router.addLiquidityProportional(market, 1, 1, 0, address(0), 0);
    }

    function test_removeLiquidityProp_revertsZero() public {
        vm.prank(alice);
        vm.expectRevert(ActionRouter.ZeroAmount.selector);
        router.removeLiquidityProportional(market, 0, 0, 0, alice, 0);
    }

    function test_removeLiquidityProp_revertsZeroReceiver() public {
        vm.prank(alice);
        vm.expectRevert(ActionRouter.ZeroAddress.selector);
        router.removeLiquidityProportional(market, 1, 0, 0, address(0), 0);
    }

    function test_redeemAfterExpiry_revertsZeroAmounts() public {
        vm.warp(market.expiry() + 1);
        vm.prank(alice);
        vm.expectRevert(ActionRouter.ZeroAmount.selector);
        router.redeemAfterExpiryAndUnwrap(market, 0, address(underlying), 0, alice, 0);
    }

    function test_redeemAfterExpiry_revertsZeroReceiver() public {
        vm.warp(market.expiry() + 1);
        vm.prank(alice);
        vm.expectRevert(ActionRouter.ZeroAddress.selector);
        router.redeemAfterExpiryAndUnwrap(market, 1, address(underlying), 0, address(0), 0);
    }

    // ───── interface parameterization ─────

    /// @notice The router accepts any contract that implements `IFissionMarketCommon`.
    ///         Both `FissionMarket` and `FissionMarketRewards` inherit it. This test
    ///         exercises the address-typed accessor path the router relies on, so a
    ///         silent ABI-shape regression (e.g. removing `ptAddr()`) trips here too.
    function test_interface_marketSatisfiesIFissionMarketCommon() public view {
        IFissionMarketCommon iface = IFissionMarketCommon(address(market));
        assertEq(iface.ptAddr(), pt);
        assertEq(iface.ytAddr(), yt);
        assertEq(address(iface.sy()), address(sy));
    }
}
