// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {FissionMarket} from "../../src/core/FissionMarket.sol";
import {YieldToken} from "../../src/core/YieldToken.sol";
import {MarketMath} from "../../src/libraries/MarketMath.sol";
import {MockSY, MockERC20} from "../mocks/MockSY.sol";
import {HtsTestHelper} from "../utils/HtsTestHelper.sol";

contract FissionMarketTest is Test {
    MockERC20 underlying;
    MockSY sy;
    FissionMarket market;
    /// @dev HTS-native PT — `pt` is the HTS token address. Use `IERC20(pt).balanceOf(...)`.
    address pt;
    address yt;

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
        // Install HTS precompile mock — Market.setTokens creates the HTS-native PT.
        HtsTestHelper.installHtsPrecompile();

        underlying = new MockERC20("USD", "USD", 18);
        sy = new MockSY(address(underlying), 18);
        // sy.exchangeRate starts at 1e18

        expiry = block.timestamp + 90 days;
        factory = address(this);

        // Deploy market; then YT pointing at it; then setTokens which creates PT internally.
        market = new FissionMarket(
            address(sy),
            expiry,
            SCALAR_ROOT,
            admin,
            treasury,
             18        );
        market.setTokens("Fission PT-0", "fPT-0", "Fission YT-0", "fYT-0", "lp", "lp");
        pt = market.pt();
        yt = market.yt();

        // Seed the factory (this contract) with SY+PT to call initialize.
        sy.mint(address(this), 1_000_000e6);
        // To get PT for initialize, we need to split SY first — but split mints PT/YT,
        // so we split here.
        IERC20(address(sy)).approve(address(market), type(uint256).max);
        // We can't split before initialize because split needs the pool? Let's check:
        // Actually split doesn't need the pool — it just mints PT+YT 1:1. Yes can split.

        // Plan: factory mints lots of SY for itself, splits half into PT, then transfers
        // some PT+SY to admin who initializes.
        market.split(500_000e6);
        // Now factory has 500_000 PT + 500_000 YT + 500_000 SY.
        IERC20(address(sy)).transfer(admin, 200_000e6);
        IERC20(pt).transfer(admin, 200_000e6);

        // Admin initializes with (100k SY, 100k PT). Anchor at 1.05e18.
        vm.startPrank(admin);
        IERC20(address(sy)).approve(address(market), 100_000e6);
        IERC20(pt).approve(address(market), 100_000e6);
        market.initialize(100_000e6, 100_000e6, INITIAL_ANCHOR, LN_FEE_ROOT, RESERVE_PCT);
        vm.stopPrank();

        // Distribute test balances to alice and bob.
        IERC20(address(sy)).transfer(alice, 100_000e6);
        IERC20(address(sy)).transfer(bob, 100_000e6);
    }

    // ───── construction + setup ─────

    function test_setup_state() public view {
        assertEq(address(market.sy()), address(sy));
        assertEq(market.expiry(), expiry);
        assertEq(market.scalarRoot(), SCALAR_ROOT);
        assertEq(market.factory(), address(this));
        assertEq(market.totalSy(), 100_000e6);
        assertEq(market.totalPt(), 100_000e6);
        assertGt(IERC20(market.lp()).totalSupply(), 0);
        assertGt(market.lastLnImpliedRate(), 0);
        assertEq(market.globalIndex(), 1e18); // sy.exchangeRate at init
    }

    function test_setTokens_oneShot() public {
        vm.expectRevert(FissionMarket.TokensAlreadySet.selector);
        market.setTokens("x", "x", "x", "x", "lp", "lp");
    }

    function test_setTokens_onlyFactory() public {
        // Deploy a fresh market with no tokens set.
        FissionMarket m2 = new FissionMarket(
            address(sy), expiry, SCALAR_ROOT, admin, treasury, 18
        );
        vm.prank(alice);
        vm.expectRevert(FissionMarket.OnlyFactory.selector);
        m2.setTokens("x", "x", "x", "x", "lp", "lp");
    }

    function test_initialize_oneShot() public {
        vm.prank(admin);
        vm.expectRevert(FissionMarket.AlreadyInitialized.selector);
        market.initialize(1, 1, INITIAL_ANCHOR, LN_FEE_ROOT, RESERVE_PCT);
    }

    // ───── split / merge ─────

    function test_split_mintsPtAndYt() public {
        vm.startPrank(alice);
        IERC20(address(sy)).approve(address(market), 1_000e6);
        market.split(1_000e6);
        vm.stopPrank();

        assertEq(IERC20(pt).balanceOf(alice), 1_000e6);
        assertEq(IERC20(yt).balanceOf(alice), 1_000e6);
        // Pool reserves unchanged by split.
        assertEq(market.totalSy(), 100_000e6);
        assertEq(market.totalPt(), 100_000e6);
    }

    function test_merge_burnsAndReturnsSY() public {
        vm.startPrank(alice);
        IERC20(address(sy)).approve(address(market), 1_000e6);
        market.split(1_000e6);
        uint256 syBefore = IERC20(address(sy)).balanceOf(alice);
        market.merge(1_000e6);
        uint256 syAfter = IERC20(address(sy)).balanceOf(alice);
        vm.stopPrank();

        assertEq(syAfter - syBefore, 1_000e6);
        assertEq(IERC20(pt).balanceOf(alice), 0);
        assertEq(IERC20(yt).balanceOf(alice), 0);
    }

    // ───── swaps ─────

    function test_swapExactPtForSy_works() public {
        // Alice needs PT first.
        vm.startPrank(alice);
        IERC20(address(sy)).approve(address(market), 5_000e6);
        market.split(5_000e6);
        IERC20(pt).approve(address(market), 5_000e6);

        uint256 syBefore = IERC20(address(sy)).balanceOf(alice);
        uint256 syOut = market.swapExactPtForSy(1_000e6, 0, alice);
        uint256 syAfter = IERC20(address(sy)).balanceOf(alice);
        vm.stopPrank();

        assertEq(syAfter - syBefore, syOut);
        assertGt(syOut, 0);
        // PT received pushes implied rate up; new lastLnImpliedRate > 0.
        assertGt(market.lastLnImpliedRate(), 0);
    }

    function test_swapExactSyForPt_works() public {
        vm.startPrank(alice);
        IERC20(address(sy)).approve(address(market), 5_000e6);
        uint256 ptBefore = IERC20(pt).balanceOf(alice);
        uint256 ptDesired = 500e6;
        uint256 syIn = market.swapExactSyForPt(5_000e6, ptDesired, alice);
        uint256 ptAfter = IERC20(pt).balanceOf(alice);
        vm.stopPrank();

        assertEq(ptAfter - ptBefore, ptDesired);
        assertGt(syIn, 0);
        assertLt(syIn, 5_000e6);
    }

    // ───── liquidity ─────

    function test_addLiquidity_proportional() public {
        // Alice splits + adds.
        vm.startPrank(alice);
        IERC20(address(sy)).approve(address(market), type(uint256).max);
        market.split(20_000e6);
        IERC20(pt).approve(address(market), type(uint256).max);

        uint256 lpBefore = IERC20(market.lp()).balanceOf(alice);
        uint256 lpOut = market.addLiquidity(10_000e6, 10_000e6, 0, alice);
        uint256 lpAfter = IERC20(market.lp()).balanceOf(alice);
        vm.stopPrank();

        assertEq(lpAfter - lpBefore, lpOut);
        assertGt(lpOut, 0);
        assertEq(market.totalSy(), 110_000e6);
        assertEq(market.totalPt(), 110_000e6);
    }

    function test_removeLiquidity_proportional() public {
        // Admin (who initialized) holds the LP. Burn half.
        uint256 lpBefore = IERC20(market.lp()).balanceOf(admin);
        uint256 lpToRemove = lpBefore / 2;
        assertGt(lpToRemove, 0, "admin should hold LP from init");

        vm.prank(admin);
        (uint256 syOut, uint256 ptOut) = market.removeLiquidity(lpToRemove, 0, 0, admin);

        // Should get ~half the reserves.
        assertGt(syOut, 49_000e6);
        assertLt(syOut, 51_000e6);
        assertGt(ptOut, 49_000e6);
        assertLt(ptOut, 51_000e6);
    }

    // ───── yield accrual ─────

    function test_yieldAccrual_basic() public {
        // Alice splits 1000 SY → 1000 PT + 1000 YT.
        vm.startPrank(alice);
        IERC20(address(sy)).approve(address(market), 1_000e6);
        market.split(1_000e6);
        vm.stopPrank();

        // Time passes, SY rate grows from 1.0 → 1.05.
        sy.setExchangeRate(1.05e18);

        // Alice claims yield.
        uint256 syBefore = IERC20(address(sy)).balanceOf(alice);
        vm.prank(alice);
        uint256 claimed = market.claimYield(alice);
        uint256 syAfter = IERC20(address(sy)).balanceOf(alice);

        // owed = 1000e6 * (1.05e18 - 1e18) / 1.05e18 = 1000 * 0.05 / 1.05 ≈ 47.62e18
        assertEq(syAfter - syBefore, claimed);
        assertGt(claimed, 47e6);
        assertLt(claimed, 48e6);
    }

    /// @notice YT is HTS-frozen (AMM-only) — direct user-to-user transfer reverts.
    ///         This is the design that closes the yield-leakage exploit: a user can't
    ///         sneak YT to a fresh address whose userIndex would be stale.
    function test_yt_frozen_userToUserTransferReverts() public {
        vm.startPrank(alice);
        IERC20(address(sy)).approve(address(market), 1_000e6);
        market.split(1_000e6);

        // Alice now holds 1000 frozen YT. Trying to transfer to bob reverts.
        vm.expectRevert(); // HtsCallFailed(ACCOUNT_FROZEN_FOR_TOKEN)
        IERC20(yt).transfer(bob, 1_000e6);
        vm.stopPrank();
    }

    // ───── post-expiry ─────

    function test_redeemAfterExpiry_paysProportional() public {
        // Alice splits 1000 SY → 1000 PT + 1000 YT. Rate grows to 1.05. Expiry passes.
        vm.startPrank(alice);
        IERC20(address(sy)).approve(address(market), 1_000e6);
        market.split(1_000e6);
        vm.stopPrank();

        sy.setExchangeRate(1.05e18);
        vm.warp(expiry + 1);

        uint256 syBefore = IERC20(address(sy)).balanceOf(alice);
        vm.prank(alice);
        uint256 syOut = market.redeemAfterExpiry(1_000e6, 1_000e6, alice);
        uint256 syAfter = IERC20(address(sy)).balanceOf(alice);

        // PT redeems for amount * 1e18 / globalIndex (frozen at 1.05e18).
        // = 1000 * 1e18 / 1.05e18 ≈ 952.38
        assertEq(syAfter - syBefore, syOut);
        assertGt(syOut, 952e6);
        assertLt(syOut, 953e6);
    }

    function test_swap_revertsAfterExpiry() public {
        vm.warp(expiry + 1);
        vm.prank(alice);
        vm.expectRevert(FissionMarket.MarketExpired.selector);
        market.swapExactPtForSy(1, 0, alice);
    }

    // ───── conservation ─────

    /// @dev After a sequence of ops, the solvency invariant must hold:
    ///      sy.balanceOf(market) * R >= IERC20(pt).totalSupply() * 1e18 + sumYieldOwed * R.
    function test_invariant_solvency_afterMixedOps() public {
        // Alice splits, swaps, merges, claims.
        vm.startPrank(alice);
        IERC20(address(sy)).approve(address(market), type(uint256).max);
        IERC20(pt).approve(address(market), type(uint256).max);

        market.split(5_000e6);
        market.swapExactPtForSy(500e6, 0, alice);
        sy.setExchangeRate(1.02e18);
        market.merge(1_000e6);
        market.claimYield(alice);
        vm.stopPrank();

        // Compute invariant terms.
        uint256 marketSy = IERC20(address(sy)).balanceOf(address(market));
        uint256 ptSupply = IERC20(pt).totalSupply();
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
        IERC20(pt).approve(address(market), type(uint256).max);
        market.split(1_000e6);
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
        market.swapExactPtForSy(10e6, 0, alice);
        vm.expectRevert(abi.encodeWithSignature("EnforcedPause()"));
        market.swapExactSyForPt(1e18, 1e18, alice);
        vm.expectRevert(abi.encodeWithSignature("EnforcedPause()"));
        market.addLiquidity(1e18, 1e18, 0, alice);

        // Escape hatches still work: merge + claimYield.
        market.merge(500e6);
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

    // ───── revert-path coverage ─────

    function test_constructor_revertsOnZeroSy() public {
        vm.expectRevert(FissionMarket.ZeroAddress.selector);
        new FissionMarket(address(0), block.timestamp + 90 days, SCALAR_ROOT, admin, treasury, 18);
    }

    function test_constructor_revertsOnZeroTreasury() public {
        vm.expectRevert(FissionMarket.ZeroAddress.selector);
        new FissionMarket(address(sy), block.timestamp + 90 days, SCALAR_ROOT, admin, address(0), 18);
    }

    function test_constructor_revertsOnPastExpiry() public {
        vm.warp(1000);
        vm.expectRevert(FissionMarket.MarketExpired.selector);
        new FissionMarket(address(sy), 999, SCALAR_ROOT, admin, treasury, 18);
    }

    function test_constructor_revertsOnZeroScalarRoot() public {
        vm.expectRevert();
        new FissionMarket(address(sy), block.timestamp + 90 days, 0, admin, treasury, 18);
    }

    // Removed test_setTokens_revertsOnZeroYt — Market now self-creates YT inside setTokens,
    // so there's no zero-yt input case to validate.

    function test_initialize_revertsIfTokensNotSet() public {
        FissionMarket m2 = new FissionMarket(
            address(sy), expiry, SCALAR_ROOT, admin, treasury, 18
        );
        vm.prank(admin);
        vm.expectRevert(FissionMarket.TokensNotSet.selector);
        m2.initialize(1, 1, INITIAL_ANCHOR, LN_FEE_ROOT, RESERVE_PCT);
    }

    function test_initialize_revertsOnZeroAmounts() public {
        FissionMarket m2 = new FissionMarket(
            address(sy), expiry, SCALAR_ROOT, admin, treasury, 18
        );
        m2.setTokens("p", "p", "y", "y", "lp", "lp");

        vm.prank(admin);
        vm.expectRevert(FissionMarket.ZeroAmount.selector);
        m2.initialize(0, 1, INITIAL_ANCHOR, LN_FEE_ROOT, RESERVE_PCT);
    }

    function test_initialize_revertsOnReserveFeeTooHigh() public {
        FissionMarket m2 = new FissionMarket(
            address(sy), expiry, SCALAR_ROOT, admin, treasury, 18
        );
        m2.setTokens("p", "p", "y", "y", "lp", "lp");
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(FissionMarket.ReserveFeeTooHigh.selector, 101, 100));
        m2.initialize(1e18, 1e18, INITIAL_ANCHOR, LN_FEE_ROOT, 101);
    }

    function test_split_revertsOnZeroAmount() public {
        vm.prank(alice);
        vm.expectRevert(FissionMarket.ZeroAmount.selector);
        market.split(0);
    }

    function test_split_revertsPostExpiry() public {
        vm.warp(expiry + 1);
        vm.prank(alice);
        vm.expectRevert(FissionMarket.MarketExpired.selector);
        market.split(1);
    }

    function test_merge_revertsOnZeroAmount() public {
        vm.prank(alice);
        vm.expectRevert(FissionMarket.ZeroAmount.selector);
        market.merge(0);
    }

    function test_merge_revertsPostExpiry() public {
        vm.warp(expiry + 1);
        vm.prank(alice);
        vm.expectRevert(FissionMarket.MarketExpired.selector);
        market.merge(1);
    }

    function test_swapPtForSy_revertsOnZeroAmount() public {
        vm.prank(alice);
        vm.expectRevert(FissionMarket.ZeroAmount.selector);
        market.swapExactPtForSy(0, 0, alice);
    }

    function test_swapPtForSy_revertsZeroReceiver() public {
        vm.startPrank(alice);
        IERC20(address(sy)).approve(address(market), 100e6);
        market.split(100e6);
        IERC20(pt).approve(address(market), 100e6);
        vm.expectRevert(FissionMarket.ZeroAddress.selector);
        market.swapExactPtForSy(10e6, 0, address(0));
        vm.stopPrank();
    }

    function test_swapPtForSy_revertsBelowMin() public {
        vm.startPrank(alice);
        IERC20(address(sy)).approve(address(market), 100e6);
        market.split(100e6);
        IERC20(pt).approve(address(market), 100e6);
        vm.expectRevert(FissionMarket.InsufficientOutput.selector);
        market.swapExactPtForSy(10e6, type(uint256).max, alice);
        vm.stopPrank();
    }

    function test_swapSyForPt_revertsOnZeroAmount() public {
        vm.prank(alice);
        vm.expectRevert(FissionMarket.ZeroAmount.selector);
        market.swapExactSyForPt(0, 0, alice);
    }

    function test_swapSyForPt_revertsZeroReceiver() public {
        vm.prank(alice);
        vm.expectRevert(FissionMarket.ZeroAddress.selector);
        market.swapExactSyForPt(1, 100, address(0));
    }

    function test_swapSyForPt_revertsAboveMax() public {
        vm.prank(alice);
        vm.expectRevert(FissionMarket.InsufficientOutput.selector);
        market.swapExactSyForPt(1, 1000e6, alice);
    }

    function test_addLiquidity_revertsOnZero() public {
        vm.prank(alice);
        vm.expectRevert(FissionMarket.ZeroAmount.selector);
        market.addLiquidity(0, 1, 0, alice);
    }

    function test_addLiquidity_revertsZeroReceiver() public {
        vm.prank(alice);
        vm.expectRevert(FissionMarket.ZeroAddress.selector);
        market.addLiquidity(1, 1, 0, address(0));
    }

    function test_addLiquidity_revertsPostExpiry() public {
        vm.warp(expiry + 1);
        vm.prank(alice);
        vm.expectRevert(FissionMarket.MarketExpired.selector);
        market.addLiquidity(1, 1, 0, alice);
    }

    function test_removeLiquidity_revertsOnZero() public {
        vm.prank(alice);
        vm.expectRevert(FissionMarket.ZeroAmount.selector);
        market.removeLiquidity(0, 0, 0, alice);
    }

    function test_removeLiquidity_revertsZeroReceiver() public {
        vm.prank(admin);
        vm.expectRevert(FissionMarket.ZeroAddress.selector);
        market.removeLiquidity(1, 0, 0, address(0));
    }

    function test_redeemAfterExpiry_revertsPreExpiry() public {
        vm.prank(alice);
        vm.expectRevert(FissionMarket.MarketNotExpired.selector);
        market.redeemAfterExpiry(1, 0, alice);
    }

    function test_redeemAfterExpiry_revertsZeroReceiver() public {
        vm.warp(expiry + 1);
        vm.prank(alice);
        vm.expectRevert(FissionMarket.ZeroAddress.selector);
        market.redeemAfterExpiry(1, 0, address(0));
    }

    function test_redeemAfterExpiry_revertsZeroAmount() public {
        vm.warp(expiry + 1);
        vm.prank(alice);
        vm.expectRevert(FissionMarket.ZeroAmount.selector);
        market.redeemAfterExpiry(0, 0, alice);
    }

    function test_claimYield_revertsZeroReceiver() public {
        vm.prank(alice);
        vm.expectRevert(FissionMarket.ZeroAddress.selector);
        market.claimYield(address(0));
    }

    function test_setTreasury_revertsZero() public {
        vm.prank(admin);
        vm.expectRevert(FissionMarket.ZeroAddress.selector);
        market.setTreasury(address(0));
    }

    function test_setTreasury_unauthorizedReverts() public {
        vm.prank(alice);
        vm.expectRevert();
        market.setTreasury(address(0xBABE));
    }

    function test_setFee_unauthorizedReverts() public {
        vm.prank(alice);
        vm.expectRevert();
        market.setFee(LN_FEE_ROOT, 80);
    }

    function test_unpause_unauthorizedReverts() public {
        vm.prank(admin);
        market.pause();
        vm.prank(alice);
        vm.expectRevert();
        market.unpause();
    }

    // Removed test_onYTBalanceChange_onlyYTReverts — the callback path is gone.
    // HTS YT has no _update hook; yield settlement is now explicit at every market
    // entry point that touches a user's YT balance.
}
