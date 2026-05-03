// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {FissionMarket} from "../../src/core/FissionMarket.sol";
import {PrincipalToken} from "../../src/core/PrincipalToken.sol";
import {YieldToken} from "../../src/core/YieldToken.sol";
import {MarketMath} from "../../src/libraries/MarketMath.sol";
import {MockSY, MockERC20} from "../mocks/MockSY.sol";

contract FissionMarketTest is Test {
    MockERC20 underlying;
    MockSY sy;
    FissionMarket market;
    PrincipalToken pt;
    YieldToken yt;

    address admin = address(0xAD);
    address treasury = address(0xBEEF);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address factory; // = test contract

    uint256 expiry;
    int256 constant SCALAR_ROOT = 75e18;
    int256 constant LN_FEE_ROOT = 0.0003e18; // ~0.03%
    uint256 constant RESERVE_PCT = 80;
    int256 constant INITIAL_ANCHOR = 1.05e18; // 5% implied yield ≈ exchange rate 1.05

    function setUp() public {
        underlying = new MockERC20("USD", "USD", 18);
        sy = new MockSY(address(underlying), 18);
        // sy.exchangeRate starts at 1e18

        expiry = block.timestamp + 90 days;
        factory = address(this);

        // Deploy market first; then PT/YT pointing at it; then setTokens.
        market = new FissionMarket(
            address(sy),
            expiry,
            SCALAR_ROOT,
            admin,
            treasury,
            18,
            "Fission LP-0",
            "fLP-0"
        );
        pt = new PrincipalToken("Fission PT-0", "fPT-0", address(sy), expiry, address(market), 18);
        yt = new YieldToken("Fission YT-0", "fYT-0", address(sy), expiry, address(market), 18);
        market.setTokens(address(pt), address(yt));

        // Seed the factory (this contract) with SY+PT to call initialize.
        sy.mint(address(this), 1_000_000e18);
        // To get PT for initialize, we need to split SY first — but split mints PT/YT,
        // so we split here.
        IERC20(address(sy)).approve(address(market), type(uint256).max);
        // We can't split before initialize because split needs the pool? Let's check:
        // Actually split doesn't need the pool — it just mints PT+YT 1:1. Yes can split.

        // Plan: factory mints lots of SY for itself, splits half into PT, then transfers
        // some PT+SY to admin who initializes.
        market.split(500_000e18);
        // Now factory has 500_000 PT + 500_000 YT + 500_000 SY.
        IERC20(address(sy)).transfer(admin, 200_000e18);
        IERC20(address(pt)).transfer(admin, 200_000e18);

        // Admin initializes with (100k SY, 100k PT). Anchor at 1.05e18.
        vm.startPrank(admin);
        IERC20(address(sy)).approve(address(market), 100_000e18);
        IERC20(address(pt)).approve(address(market), 100_000e18);
        market.initialize(100_000e18, 100_000e18, INITIAL_ANCHOR, LN_FEE_ROOT, RESERVE_PCT);
        vm.stopPrank();

        // Distribute test balances to alice and bob.
        IERC20(address(sy)).transfer(alice, 100_000e18);
        IERC20(address(sy)).transfer(bob, 100_000e18);
    }

    // ───── construction + setup ─────

    function test_setup_state() public view {
        assertEq(address(market.sy()), address(sy));
        assertEq(market.expiry(), expiry);
        assertEq(market.scalarRoot(), SCALAR_ROOT);
        assertEq(market.factory(), address(this));
        assertEq(market.totalSy(), 100_000e18);
        assertEq(market.totalPt(), 100_000e18);
        assertGt(market.totalSupply(), 0);
        assertGt(market.lastLnImpliedRate(), 0);
        assertEq(market.globalIndex(), 1e18); // sy.exchangeRate at init
    }

    function test_setTokens_oneShot() public {
        vm.expectRevert(FissionMarket.TokensAlreadySet.selector);
        market.setTokens(address(pt), address(yt));
    }

    function test_setTokens_onlyFactory() public {
        // Deploy a fresh market with no tokens set.
        FissionMarket m2 = new FissionMarket(
            address(sy), expiry, SCALAR_ROOT, admin, treasury, 18, "x", "x"
        );
        vm.prank(alice);
        vm.expectRevert(FissionMarket.OnlyFactory.selector);
        m2.setTokens(address(pt), address(yt));
    }

    function test_initialize_oneShot() public {
        vm.prank(admin);
        vm.expectRevert(FissionMarket.AlreadyInitialized.selector);
        market.initialize(1, 1, INITIAL_ANCHOR, LN_FEE_ROOT, RESERVE_PCT);
    }

    // ───── split / merge ─────

    function test_split_mintsPtAndYt() public {
        vm.startPrank(alice);
        IERC20(address(sy)).approve(address(market), 1_000e18);
        market.split(1_000e18);
        vm.stopPrank();

        assertEq(pt.balanceOf(alice), 1_000e18);
        assertEq(yt.balanceOf(alice), 1_000e18);
        // Pool reserves unchanged by split.
        assertEq(market.totalSy(), 100_000e18);
        assertEq(market.totalPt(), 100_000e18);
    }

    function test_merge_burnsAndReturnsSY() public {
        vm.startPrank(alice);
        IERC20(address(sy)).approve(address(market), 1_000e18);
        market.split(1_000e18);
        uint256 syBefore = IERC20(address(sy)).balanceOf(alice);
        market.merge(1_000e18);
        uint256 syAfter = IERC20(address(sy)).balanceOf(alice);
        vm.stopPrank();

        assertEq(syAfter - syBefore, 1_000e18);
        assertEq(pt.balanceOf(alice), 0);
        assertEq(yt.balanceOf(alice), 0);
    }

    // ───── swaps ─────

    function test_swapExactPtForSy_works() public {
        // Alice needs PT first.
        vm.startPrank(alice);
        IERC20(address(sy)).approve(address(market), 5_000e18);
        market.split(5_000e18);
        IERC20(address(pt)).approve(address(market), 5_000e18);

        uint256 syBefore = IERC20(address(sy)).balanceOf(alice);
        uint256 syOut = market.swapExactPtForSy(1_000e18, 0, alice);
        uint256 syAfter = IERC20(address(sy)).balanceOf(alice);
        vm.stopPrank();

        assertEq(syAfter - syBefore, syOut);
        assertGt(syOut, 0);
        // PT received pushes implied rate up; new lastLnImpliedRate > 0.
        assertGt(market.lastLnImpliedRate(), 0);
    }

    function test_swapExactSyForPt_works() public {
        vm.startPrank(alice);
        IERC20(address(sy)).approve(address(market), 5_000e18);
        uint256 ptBefore = pt.balanceOf(alice);
        uint256 ptDesired = 500e18;
        uint256 syIn = market.swapExactSyForPt(5_000e18, ptDesired, alice);
        uint256 ptAfter = pt.balanceOf(alice);
        vm.stopPrank();

        assertEq(ptAfter - ptBefore, ptDesired);
        assertGt(syIn, 0);
        assertLt(syIn, 5_000e18);
    }

    // ───── liquidity ─────

    function test_addLiquidity_proportional() public {
        // Alice splits + adds.
        vm.startPrank(alice);
        IERC20(address(sy)).approve(address(market), type(uint256).max);
        market.split(20_000e18);
        IERC20(address(pt)).approve(address(market), type(uint256).max);

        uint256 lpBefore = market.balanceOf(alice);
        uint256 lpOut = market.addLiquidity(10_000e18, 10_000e18, 0, alice);
        uint256 lpAfter = market.balanceOf(alice);
        vm.stopPrank();

        assertEq(lpAfter - lpBefore, lpOut);
        assertGt(lpOut, 0);
        assertEq(market.totalSy(), 110_000e18);
        assertEq(market.totalPt(), 110_000e18);
    }

    function test_removeLiquidity_proportional() public {
        // Admin (who initialized) holds the LP. Burn half.
        uint256 lpBefore = market.balanceOf(admin);
        uint256 lpToRemove = lpBefore / 2;
        assertGt(lpToRemove, 0, "admin should hold LP from init");

        vm.prank(admin);
        (uint256 syOut, uint256 ptOut) = market.removeLiquidity(lpToRemove, 0, 0, admin);

        // Should get ~half the reserves.
        assertGt(syOut, 49_000e18);
        assertLt(syOut, 51_000e18);
        assertGt(ptOut, 49_000e18);
        assertLt(ptOut, 51_000e18);
    }

    // ───── yield accrual ─────

    function test_yieldAccrual_basic() public {
        // Alice splits 1000 SY → 1000 PT + 1000 YT.
        vm.startPrank(alice);
        IERC20(address(sy)).approve(address(market), 1_000e18);
        market.split(1_000e18);
        vm.stopPrank();

        // Time passes, SY rate grows from 1.0 → 1.05.
        sy.setExchangeRate(1.05e18);

        // Alice claims yield.
        uint256 syBefore = IERC20(address(sy)).balanceOf(alice);
        vm.prank(alice);
        uint256 claimed = market.claimYield(alice);
        uint256 syAfter = IERC20(address(sy)).balanceOf(alice);

        // owed = 1000e18 * (1.05e18 - 1e18) / 1.05e18 = 1000 * 0.05 / 1.05 ≈ 47.62e18
        assertEq(syAfter - syBefore, claimed);
        assertGt(claimed, 47e18);
        assertLt(claimed, 48e18);
    }

    function test_yieldAccrual_settledOnYTTransfer() public {
        // Alice splits, gets 1000 YT. Rate grows. Alice transfers YT to bob.
        // Yield up to that point should stay with alice; future yield accrues to bob.
        vm.startPrank(alice);
        IERC20(address(sy)).approve(address(market), 1_000e18);
        market.split(1_000e18);
        vm.stopPrank();

        sy.setExchangeRate(1.05e18);

        // Transfer YT — onYTBalanceChange settles alice's accrued yield.
        vm.prank(alice);
        yt.transfer(bob, 1_000e18);

        // Alice should have userOwed > 0 now (the yield earned at 1.05).
        assertGt(market.userOwed(alice), 47e18);
        assertLt(market.userOwed(alice), 48e18);

        // Rate grows again to 1.10.
        sy.setExchangeRate(1.10e18);

        // Bob claims; should get yield from 1.05 → 1.10 only.
        // owed = 1000e18 * (1.10 - 1.05) / 1.10 ≈ 45.45e18
        vm.prank(bob);
        uint256 bobClaimed = market.claimYield(bob);
        assertGt(bobClaimed, 45e18);
        assertLt(bobClaimed, 46e18);
    }

    // ───── post-expiry ─────

    function test_redeemAfterExpiry_paysProportional() public {
        // Alice splits 1000 SY → 1000 PT + 1000 YT. Rate grows to 1.05. Expiry passes.
        vm.startPrank(alice);
        IERC20(address(sy)).approve(address(market), 1_000e18);
        market.split(1_000e18);
        vm.stopPrank();

        sy.setExchangeRate(1.05e18);
        vm.warp(expiry + 1);

        uint256 syBefore = IERC20(address(sy)).balanceOf(alice);
        vm.prank(alice);
        uint256 syOut = market.redeemAfterExpiry(1_000e18, 1_000e18, alice);
        uint256 syAfter = IERC20(address(sy)).balanceOf(alice);

        // PT redeems for amount * 1e18 / globalIndex (frozen at 1.05e18).
        // = 1000 * 1e18 / 1.05e18 ≈ 952.38
        assertEq(syAfter - syBefore, syOut);
        assertGt(syOut, 952e18);
        assertLt(syOut, 953e18);
    }

    function test_swap_revertsAfterExpiry() public {
        vm.warp(expiry + 1);
        vm.prank(alice);
        vm.expectRevert(FissionMarket.MarketExpired.selector);
        market.swapExactPtForSy(1, 0, alice);
    }

    // ───── conservation ─────

    /// @dev After a sequence of ops, the solvency invariant must hold:
    ///      sy.balanceOf(market) * R >= pt.totalSupply() * 1e18 + sumYieldOwed * R.
    function test_invariant_solvency_afterMixedOps() public {
        // Alice splits, swaps, merges, claims.
        vm.startPrank(alice);
        IERC20(address(sy)).approve(address(market), type(uint256).max);
        IERC20(address(pt)).approve(address(market), type(uint256).max);

        market.split(5_000e18);
        market.swapExactPtForSy(500e18, 0, alice);
        sy.setExchangeRate(1.02e18);
        market.merge(1_000e18);
        market.claimYield(alice);
        vm.stopPrank();

        // Compute invariant terms.
        uint256 marketSy = IERC20(address(sy)).balanceOf(address(market));
        uint256 ptSupply = pt.totalSupply();
        uint256 R = sy.exchangeRate();

        // Asset value = marketSy * R / 1e18.
        // Liabilities = ptSupply * 1e18 / 1e18 (in asset = ptSupply since 1 PT = 1 asset)
        //             + userOwed * R / 1e18 (denom in asset).
        uint256 assetValue = (marketSy * R) / 1e18;
        uint256 ptLiability = ptSupply; // each PT redeems for 1 asset
        uint256 yieldLiabilityAsset = (market.userOwed(alice) * R) / 1e18;

        assertGe(assetValue, ptLiability + yieldLiabilityAsset, "solvency violated");
    }

    // ───── pause ─────

    function test_pause_blocksEntryButLeavesEscapeHatchesOpen() public {
        // Alice enters before pause: splits 1_000 SY → 1_000 PT + 1_000 YT.
        vm.startPrank(alice);
        IERC20(address(sy)).approve(address(market), type(uint256).max);
        IERC20(address(pt)).approve(address(market), type(uint256).max);
        market.split(1_000e18);
        vm.stopPrank();

        // Pauser pauses (admin holds PAUSER_ROLE by construction).
        vm.prank(admin);
        market.pause();
        assertTrue(market.paused());

        // Entry paths revert.
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSignature("EnforcedPause()"));
        market.split(1e18);
        vm.expectRevert(abi.encodeWithSignature("EnforcedPause()"));
        market.swapExactPtForSy(10e18, 0, alice);
        vm.expectRevert(abi.encodeWithSignature("EnforcedPause()"));
        market.swapExactSyForPt(1e18, 1e18, alice);
        vm.expectRevert(abi.encodeWithSignature("EnforcedPause()"));
        market.addLiquidity(1e18, 1e18, 0, alice);

        // Escape hatches still work: merge + claimYield.
        market.merge(500e18);
        market.claimYield(alice);
        vm.stopPrank();

        // Unpause requires DEFAULT_ADMIN_ROLE.
        vm.prank(alice);
        vm.expectRevert();
        market.unpause();
        vm.prank(admin);
        market.unpause();
        assertFalse(market.paused());
    }

    function test_pause_onlyPauser() public {
        vm.prank(alice);
        vm.expectRevert();
        market.pause();
    }

    function test_setFee_revertsAboveMaxReservePercent() public {
        uint256 over = market.MAX_RESERVE_FEE_PERCENT() + 1;
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(FissionMarket.ReserveFeeTooHigh.selector, over, 100));
        market.setFee(LN_FEE_ROOT, over);
    }
}
