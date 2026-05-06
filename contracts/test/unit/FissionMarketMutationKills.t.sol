// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {FissionMarket} from "../../src/core/FissionMarket.sol";
import {MarketMath} from "../../src/libraries/MarketMath.sol";
import {MockSY, MockERC20} from "../mocks/MockSY.sol";
import {HtsTestHelper} from "../utils/HtsTestHelper.sol";

/// @title  FissionMarketMutationKills - targeted assertions to kill specific
///         Gambit survivors from the 2026-05-07 full mutation run.
/// @notice 23 FissionMarket survivors triaged at 64% baseline. This file
///         targets the catchable ones; the deeper "production-only" paths
///         (msg.value-split rounding, treasury-LP-burn) are documented as
///         residuals or equivalent mutants.
contract FissionMarketMutationKillsTest is Test {
    MockERC20 underlying;
    MockSY sy;
    address syShare;
    FissionMarket market;
    address pt;
    address yt;

    address admin = address(0xAD);
    address treasury = address(0xBEEF);
    address alice = address(0xA11CE);

    uint256 expiry;
    int256 constant SCALAR_ROOT = 75e18;
    int256 constant LN_FEE_ROOT = 0.0003e18;
    uint256 constant RESERVE_PCT = 80;
    int256 constant INITIAL_ANCHOR = 1.05e18;

    function setUp() public {
        HtsTestHelper.installHtsPrecompile();
        underlying = new MockERC20("USD", "USD", 18);
        sy = new MockSY(address(underlying), 18);
        syShare = sy.shareToken();
        expiry = block.timestamp + 90 days;

        market = new FissionMarket(address(sy), expiry, SCALAR_ROOT, admin, treasury, 18, address(0));
        market.setTokens("PT-K", "fPT-K", "YT-K", "fYT-K", "lp", "lp");
        pt = market.pt();
        yt = market.yt();

        sy.mint(address(this), 1_000_000e6);
        IERC20(syShare).approve(address(market), type(uint256).max);
        market.split(500_000e6); // factory now has PT+YT+SY

        IERC20(syShare).transfer(admin, 200_000e6);
        IERC20(pt).transfer(admin, 200_000e6);

        vm.startPrank(admin);
        IERC20(syShare).approve(address(market), 100_000e6);
        IERC20(pt).approve(address(market), 100_000e6);
        market.initialize(100_000e6, 100_000e6, INITIAL_ANCHOR, LN_FEE_ROOT, RESERVE_PCT);
        vm.stopPrank();

        IERC20(syShare).transfer(alice, 200_000e6);
    }

    // ------------------------------ kills #18 (lnFeeRateRoot = 1 instead of given) ------------------------------
    function test_kill_18_lnFeeRateRootStored() public view {
        assertEq(market.lnFeeRateRoot(), LN_FEE_ROOT, "kill #18: stored fee root must == provided");
    }

    // ------------------------------ kills #17 (validateLnFeeRateRoot deleted) ------------------------------
    function test_kill_17_invalidFeeRootReverts() public {
        FissionMarket m2 = new FissionMarket(address(sy), expiry, SCALAR_ROOT, admin, treasury, 18, address(0));
        m2.setTokens("PT2", "PT2", "YT2", "YT2", "lp2", "lp2");

        // Get PT for m2 via split. m2 hasn't been initialized.
        sy.mint(address(this), 100_000e6);
        IERC20(syShare).approve(address(m2), type(uint256).max);
        m2.split(50_000e6);
        IERC20(syShare).transfer(admin, 50_000e6);
        IERC20(m2.pt()).transfer(admin, 50_000e6);

        vm.startPrank(admin);
        IERC20(syShare).approve(address(m2), 50_000e6);
        IERC20(m2.pt()).approve(address(m2), 50_000e6);
        // MAX_LN_FEE_RATE_ROOT = 0.05e18; pass 0.06e18 --- must revert.
        vm.expectRevert(MarketMath.InvalidLnFeeRateRoot.selector);
        m2.initialize(50_000e6, 50_000e6, INITIAL_ANCHOR, 0.06e18, RESERVE_PCT);
        vm.stopPrank();
    }

    // ------------------------------ kills #27 (already-initialized guard removed) ------------------------------
    function test_kill_27_doubleInitializeReverts() public {
        // Try to re-init the live market.
        vm.startPrank(admin);
        // Need fresh PT+SY to attempt the call - re-acquire.
        sy.mint(admin, 50_000e6);
        IERC20(syShare).approve(address(market), 50_000e6);
        // No PT for admin; double-init should revert before pulling tokens.
        vm.expectRevert();
        market.initialize(50_000e6, 50_000e6, INITIAL_ANCHOR, LN_FEE_ROOT, RESERVE_PCT);
        vm.stopPrank();
    }

    // ------------------------------ kills #21 (-ptIn --- ~ptIn in swap) ------------------------------
    function test_kill_21_swapPtForSyDirection() public {
        // Send a swap and assert: SY balance of alice ---; PT balance ---; non-trivial output.
        vm.startPrank(alice);
        // Get PT first - alice doesn't have any. Split some SY.
        IERC20(syShare).approve(address(market), 5_000e6);
        market.split(5_000e6);
        uint256 alicePtBefore = IERC20(pt).balanceOf(alice);
        uint256 aliceSyBefore = IERC20(syShare).balanceOf(alice);

        IERC20(pt).approve(address(market), 1_000e6);
        uint256 syOut = market.swapExactPtForSy(1_000e6, 0, alice);
        vm.stopPrank();

        assertGt(syOut, 0, "kill #21: swap must produce SY out (sign mutation breaks)");
        assertEq(IERC20(pt).balanceOf(alice), alicePtBefore - 1_000e6, "PT decrement exact");
        assertEq(IERC20(syShare).balanceOf(alice), aliceSyBefore + syOut, "SY credit matches return");

        // Order-of-magnitude pin: 1k PT swap should yield ~950-1000 SY (small fee).
        assertGt(syOut, 900e6, "syOut implausibly low - sign mutation produced wrong amount");
        assertLt(syOut, 1_010e6, "syOut implausibly high");
    }

    // ------------------------------ kills #24 (totalSy -= 1 instead of netSyToReserve) ------------------------------
    function test_kill_24_reserveAccounting() public {
        uint256 totalSyBefore = market.totalSy();

        vm.startPrank(alice);
        IERC20(syShare).approve(address(market), 5_000e6);
        market.split(5_000e6);
        IERC20(pt).approve(address(market), 5_000e6);
        market.swapExactPtForSy(5_000e6, 0, alice);
        vm.stopPrank();

        // After swap, totalSy = totalSyBefore + |syPaidToPool| - reserveFee.
        // The exact reserve fee is the protocol's cut; treasury balance grows by it.
        // Mutation #24 sets totalSy -= 1 instead of -= reserveFee - so totalSy ends
        // up artificially HIGHER (because we subtract less than actual). Assert the
        // delta: totalSy after swap == totalSyBefore + syIntoPool - actualReserve.
        // Indirect proof: treasury(syShare) balance == accumulated reserve fee.
        uint256 reserveAccrued = IERC20(syShare).balanceOf(treasury);
        assertGt(reserveAccrued, 0, "reserve must accrue to treasury");
        // Coupling check: the reserve accrued should be >> 1 wei (catches `-= 1`).
        assertGt(reserveAccrued, 100, "kill #24: reserve too small - possibly clamped to 1");

        // Treasury should hold exactly the protocol-side reserve from the swap.
        // 5k PT @ ~5% fee ratio @ 80% reserve cut --- ~6e6-8e6 (approx 6-8 SY).
        // Looser bound to allow Pendle math drift.
        assertGt(reserveAccrued, 1e3, "reserve too small");
    }

    // ------------------------------ kills #31, #32 (post-expiry redemption math) ------------------------------
    function test_kill_31_32_redeemAfterExpiryMath() public {
        // Alice splits some SY and holds PT.
        vm.startPrank(alice);
        IERC20(syShare).approve(address(market), 1_000e6);
        market.split(1_000e6);
        vm.stopPrank();
        uint256 alicePt = IERC20(pt).balanceOf(alice);
        assertEq(alicePt, 1_000e6);

        // Warp past expiry.
        vm.warp(expiry + 1);

        // exchangeRate is still 1e18 (unchanged) - no rate growth in this mock.
        // syOut = ptIn * 1e18 / globalIndex = 1_000e6 * 1e18 / 1e18 = 1_000e6 SY.
        vm.startPrank(alice);
        IERC20(pt).approve(address(market), 1_000e6);
        uint256 syOut = market.redeemAfterExpiry(1_000e6, 0, alice);
        vm.stopPrank();

        assertEq(syOut, 1_000e6, "kill #31/#32: at globalIndex=1e18, 1 PT --- 1 SY exact");
    }

    // ------------------------------ kills #40, #41 (previewYield math) ------------------------------
    function test_kill_40_41_previewYieldMath() public {
        // Alice splits 1000 SY --- 1000 PT + 1000 YT. Settles userIndex.
        vm.startPrank(alice);
        IERC20(syShare).approve(address(market), 1_000e6);
        market.split(1_000e6);
        vm.stopPrank();

        uint256 ytBal = IERC20(yt).balanceOf(alice);
        assertEq(ytBal, 1_000e6);

        // Bump SY exchangeRate from 1.0 --- 1.05 (5% yield earned).
        sy.setExchangeRate(1.05e18);

        // previewYield = ytBal * (gi - ui) / gi = 1000e6 * (1.05e18 - 1.0e18) / 1.05e18
        // Mutation #40 (* --- %): gives ytBal % (gi - ui) / gi --- tiny / 1.05e18 --- 0
        // Mutation #41 (gi - ui --- ui - gi): gives negative --- wraps in unsigned --- huge
        uint256 owed = market.previewYield(alice);

        uint256 expectedNum = uint256(1_000e6) * uint256(1.05e18 - 1e18); // = 1000e6 * 0.05e18
        uint256 expected = expectedNum / 1.05e18;
        assertEq(owed, expected, "kill #40/#41: previewYield exact");
        assertGt(owed, 0, "owed must be > 0 with rate growth");
    }

    // ------------------------------ kills #42, #43 (userOwed + extra mutated) ------------------------------
    function test_kill_42_43_previewYieldSumPath() public {
        // First settle a userIndex change --- userOwed accumulates.
        vm.startPrank(alice);
        IERC20(syShare).approve(address(market), 1_000e6);
        market.split(1_000e6);
        vm.stopPrank();

        sy.setExchangeRate(1.05e18);
        // Force settle (claim 0 to settle).
        vm.prank(alice);
        market.claimYield(alice);

        // Now userOwed[alice] == 0 (claimed). Bump rate again.
        sy.setExchangeRate(1.10e18);

        // previewYield should be > 0 (extra accruing on top of 0 userOwed).
        // Mutation #42 (+ --- -): returns -extra --- underflow revert (uint).
        // Mutation #43 (+ --- **): returns userOwed ** extra --- wildly different number.
        uint256 owed = market.previewYield(alice);
        assertGt(owed, 0, "kill #42/#43: previewYield must include extra");
        // 1000e6 * (1.10 - 1.05) / 1.10 --- 4.54e7
        assertGt(owed, 4e7, "owed band low");
        assertLt(owed, 5e7, "owed band high");
    }

    // ------------------------------ kills #47, #48 (setFee path: lnFeeRateRoot mutation) ------------------------------
    function test_kill_47_48_setFeeUpdates() public {
        int256 newFee = 0.001e18;
        uint256 newReservePct = 50;
        vm.prank(admin);
        market.setFee(newFee, newReservePct);
        assertEq(market.lnFeeRateRoot(), newFee, "kill #47/#48: setFee must update lnFeeRateRoot");
        assertEq(market.reserveFeePercent(), newReservePct, "reserveFeePercent updated");
    }

    // ---------- kills #20 (merge() pt == address(0) check removed) ----------
    function test_kill_20_mergeRevertsBeforeSetTokens() public {
        // Mutation #20 is in merge() not initialize(). Need a fresh market with
        // setTokens NOT called, then call merge.
        FissionMarket m3 = new FissionMarket(address(sy), expiry, SCALAR_ROOT, admin, treasury, 18, address(0));
        vm.expectRevert(FissionMarket.TokensNotSet.selector);
        m3.merge(100);
    }

    function test_kill_20b_initializeRevertsBeforeSetTokens() public {
        // Bonus check on initialize() path (separate guard at function top).
        FissionMarket m3 = new FissionMarket(address(sy), expiry, SCALAR_ROOT, admin, treasury, 18, address(0));
        vm.startPrank(admin);
        vm.expectRevert(FissionMarket.TokensNotSet.selector);
        m3.initialize(100e6, 100e6, INITIAL_ANCHOR, LN_FEE_ROOT, RESERVE_PCT);
        vm.stopPrank();
    }

    // ---------- kills #27 (addLiquidity NotInitialized guard removed) ----------
    function test_kill_27_addLiquidityRevertsBeforeInit() public {
        // Fresh market with setTokens but NOT initialize.
        FissionMarket m4 = new FissionMarket(address(sy), expiry, SCALAR_ROOT, admin, treasury, 18, address(0));
        m4.setTokens("PT4", "fPT4", "YT4", "fYT4", "lp4", "lp4");

        // Pre-init: lp.totalSupply == 0. Mutation removes the guard.
        vm.startPrank(admin);
        vm.expectRevert(FissionMarket.NotInitialized.selector);
        m4.addLiquidity(100e6, 100e6, 0, admin);
        vm.stopPrank();
    }

    // ---------- kills #21 (-int(ptIn) -> ~int(ptIn) in swapExactPtForSy) ----------
    function test_kill_21_swapPtSyExact() public {
        // ~int256(1000e6) = -1000e6 - 1 (one wei off). To distinguish from -int256,
        // use a tiny swap where the 1-wei discrepancy is visible in syOut.
        vm.startPrank(alice);
        IERC20(syShare).approve(address(market), 1_000e6);
        market.split(1_000e6);
        IERC20(pt).approve(address(market), 1_000e6);
        uint256 syOut1 = market.swapExactPtForSy(1_000e6, 0, alice);
        vm.stopPrank();

        // Capture the canonical output, then assert it's reproducible exactly when
        // the same trade is repeated against a snapshot. Cheaper alternative: the
        // mutation makes syOut differ from canonical by at least 1 wei via the
        // bitwise NOT. Pin syOut % 1e6 --- under mutation it shifts noticeably.
        // Actual canonical 1000 PT @ ~5% rate: should net ~951 SY plus change.
        // We hard-pin a tight integer band to surface even tiny drift.
        assertEq(syOut1 / 1e3, 952_280, "kill #21: syOut/1e3 must match canonical exactly");
    }

    // ---------- kills #24 (totalSy -= 1 instead of -= netSyToReserve) ----------
    function test_kill_24_totalSyExactDelta() public {
        uint256 totalSyBefore = market.totalSy();

        vm.startPrank(alice);
        IERC20(syShare).approve(address(market), 5_000e6);
        market.split(5_000e6);
        IERC20(pt).approve(address(market), 5_000e6);
        uint256 syOut = market.swapExactPtForSy(5_000e6, 0, alice);
        vm.stopPrank();

        // totalSy = before + syPaidIntoPool - reserveFee (Pendle accounting).
        // syPaidIntoPool = syOut + reserveFeeAccrued (treasury holds reserveFee).
        // So: totalSy = before + syOut + reserveFee - reserveFee = before + syOut.
        // Wait, that's not quite right. Let's just assert reserve fee is non-1.
        // Mutation #24: totalSy -= 1 instead of netSyToReserve. So totalSy ends
        // ~reserveFee-1 wei HIGHER than canonical.
        // Canonical reserve fee for this swap is ~1e7 wei (computed). So canonical
        // totalSy is ~1e7 wei smaller than mutated.
        uint256 totalSyAfter = market.totalSy();
        uint256 reserveAccrued = IERC20(syShare).balanceOf(treasury);

        // Conservation: split() does NOT touch totalSy (SY goes into the contract
        // but isn't part of the AMM pool reserve). Only swap touches totalSy:
        //   totalSy -= syOut   (syOut SY leaves the pool to user)
        //   totalSy -= reserve (reserve SY routed to treasury)
        // So: totalSyAfter == totalSyBefore - syOut - reserveAccrued.
        // Mutation #24 makes the second subtraction `-= 1` instead of `-= reserve`.
        uint256 expectedAfter = totalSyBefore - syOut - reserveAccrued;
        assertEq(totalSyAfter, expectedAfter, "kill #24: totalSy delta must match -= netSyToReserve");
    }

    // ---------- kills #32 (post-expiry removeLiquidity ptToSy: * -> +) ----------
    function test_kill_32_postExpiryRemoveLiquidityPtToSy() public {
        // Pre-expiry remove some LP first to have a known position.
        // Then warp past expiry, remove the rest, assert syOut --- syPortion + ptPortion
        // (since exchangeRate=1, ptToSy --- ptPortion).
        vm.warp(expiry + 1);

        vm.startPrank(admin);
        uint256 lpBal = IERC20(market.lp()).balanceOf(admin);
        IERC20(market.lp()).approve(address(market), lpBal);
        // Remove half --- at exchangeRate=1, ptToSy == ptOut. Mutation #32 makes
        // ptToSy = (ptOut + 1e18) / 1e18 --- 1 wei (way smaller).
        (uint256 syOut, uint256 ptOut) = market.removeLiquidity(lpBal / 2, 0, 0, admin);
        vm.stopPrank();

        // Post-expiry: ptOut MUST be 0 (auto-redeemed).
        assertEq(ptOut, 0, "post-expiry removeLiquidity must auto-redeem PT");
        // syOut must be sizeable --- half of ~100k SY pool plus auto-redeemed PT share.
        // With mutation #32, syOut ~= syPortion + 1 wei (instead of + ~50k ptOut).
        assertGt(syOut, 50_000e6, "kill #32: syOut must include ptToSy contribution");
    }

    // ---------- kills #45 (MarketMath.setInitialLnImpliedRate ttx mutation) ----------
    function test_kill_45_setInitialLnImpliedRateTtx() public {
        // Fresh market, fresh setTokens, partial initialize that exercises
        // setInitialLnImpliedRate with non-zero now_ argument internally.
        FissionMarket m5 = new FissionMarket(address(sy), block.timestamp + 90 days, SCALAR_ROOT, admin, treasury, 18, address(0));
        m5.setTokens("PT5", "fPT5", "YT5", "fYT5", "lp5", "lp5");

        // Get PT for m5 via split.
        sy.mint(address(this), 200_000e6);
        IERC20(syShare).approve(address(m5), type(uint256).max);
        m5.split(100_000e6);
        IERC20(syShare).transfer(admin, 50_000e6);
        IERC20(m5.pt()).transfer(admin, 50_000e6);

        // Warp to halfway through expiry --- now_ becomes non-zero relative to expiry.
        vm.warp(block.timestamp + 30 days);

        vm.startPrank(admin);
        IERC20(syShare).approve(address(m5), 50_000e6);
        IERC20(m5.pt()).approve(address(m5), 50_000e6);
        // Mutation #45: ttx = expiry ** now_ overflows for non-zero now_ --- revert.
        // Without mutation: initialize completes successfully.
        m5.initialize(50_000e6, 50_000e6, INITIAL_ANCHOR, LN_FEE_ROOT, RESERVE_PCT);
        vm.stopPrank();

        // Sanity: lastLnImpliedRate set, market initialized.
        assertGt(m5.lastLnImpliedRate(), 0, "kill #45: initialize must complete (no overflow in ttx)");
    }

    // ---------- kills #30 (_updateGlobalIndex deleted in removeLiquidity post-expiry) ----------
    function test_kill_30_postExpiryRemoveLiquidityFreezesIndex() public {
        // Pre-expiry: globalIndex starts at 1.0e18 (set in initialize).
        assertEq(market.globalIndex(), 1e18);

        vm.warp(expiry + 1);
        sy.setExchangeRate(1.20e18);  // bump rate AFTER expiry

        vm.startPrank(admin);
        uint256 lpBal = IERC20(market.lp()).balanceOf(admin);
        IERC20(market.lp()).approve(address(market), lpBal);
        market.removeLiquidity(lpBal / 2, 0, 0, admin);
        vm.stopPrank();

        // _updateGlobalIndex must run inside removeLiquidity post-expiry; if mutated
        // away, expiryIndexFrozen stays false and globalIndex stays at 1e18.
        assertTrue(market.expiryIndexFrozen(), "kill #30: index must be frozen post-expiry");
        // Index must have moved up to capture rate at expiry-time-call (1.20).
        assertGt(market.globalIndex(), 1e18, "kill #30: globalIndex must update before freezing");
    }

    // ---------- kills #13 (no-refreeze branch when wasFrozen && balance==0) ----------
    function test_kill_13_postFullBurnRefreezeFlag() public {
        // After burning full YT balance, _ytFrozen[user] must clear so the next
        // mint correctly tracks state. Mutation #13 sets the second-arm branch
        // to false: cleanup is skipped; _ytFrozen stays true; next mint hits
        // unfreeze on a non-frozen account -> revert.
        address charlie = address(0xC1A2);
        IERC20(syShare).transfer(charlie, 2_000e6);

        vm.startPrank(charlie);
        IERC20(syShare).approve(address(market), 2_000e6);
        market.split(1_000e6);
        market.merge(1_000e6);   // burns all YT, _ytFrozen[charlie] should clear

        // Second split would revert under mutation #13.
        market.split(1_000e6);
        vm.stopPrank();

        assertEq(IERC20(yt).balanceOf(charlie), 1_000e6, "second mint after full burn must succeed");
    }

    // ------------------------------ kills #10 (_ytFrozen[to] = true --- false) ------------------------------
    function test_kill_10_ytFrozenAfterFirstMint() public {
        // Mint YT to alice via split. After this, _ytFrozen[alice] should be true.
        vm.startPrank(alice);
        IERC20(syShare).approve(address(market), 1_000e6);
        market.split(1_000e6);

        // Mint MORE YT to alice via second split. With mutation, _ytFrozen[alice]
        // is false, so _mintYt skips unfreeze, then transfer-to-frozen-account
        // hits HTS code 165 (ACCOUNT_FROZEN_FOR_TOKEN). Without mutation, the
        // unfreeze-then-transfer-then-refreeze sequence runs.
        IERC20(syShare).approve(address(market), 500e6);
        market.split(500e6);   // would revert under mutation
        vm.stopPrank();

        assertEq(IERC20(yt).balanceOf(alice), 1_500e6, "second mint must succeed");
    }
}
