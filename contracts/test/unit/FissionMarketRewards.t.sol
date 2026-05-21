// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {FissionMarketRewards} from "../../src/core/FissionMarketRewards.sol";
import {SY_SaucerSwapV2LP} from "../../src/sy/SY_SaucerSwapV2LP.sol";
import {MarketMath} from "../../src/libraries/MarketMath.sol";
import {IFissionMarketCommon} from "../../src/interfaces/IFissionMarketCommon.sol";
import {MockUniswapV3PositionManager} from "../mocks/MockUniswapV3PositionManager.sol";
import {MockERC20} from "../mocks/MockSY.sol";
import {HtsTestHelper} from "../utils/HtsTestHelper.sol";

/// @notice End-to-end FissionMarketRewards tests with the SY_SaucerSwapV2LP adapter
///         driving a real reward stream. Yield to YT holders is delivered as
///         (token0, token1) reward tokens, NOT via SY exchangeRate growth.
contract FissionMarketRewardsTest is Test {
    MockERC20 token0;
    MockERC20 token1;
    MockUniswapV3PositionManager npm;
    SY_SaucerSwapV2LP sy;
    address syShare;  // cached sy.shareToken() — vm.prank-safe
    FissionMarketRewards market;
    address pt;
    address yt;

    address admin = address(0xAD);
    address treasury = address(0xBEEF);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCAF7);
    address factory; // = test contract

    uint256 expiry;
    int256 constant SCALAR_ROOT = 75e18;
    int256 constant LN_FEE_ROOT = 0.0003e18;
    uint256 constant RESERVE_PCT = 80;
    int256 constant INITIAL_ANCHOR = 1.05e18;

    function setUp() public {
        HtsTestHelper.installHtsPrecompile();

        // Sort tokens.
        MockERC20 a = new MockERC20("USDC", "USDC", 6);
        MockERC20 b = new MockERC20("WHBAR", "WHBAR", 6);
        if (address(a) < address(b)) (token0, token1) = (a, b);
        else (token0, token1) = (b, a);

        npm = new MockUniswapV3PositionManager();
        sy = new SY_SaucerSwapV2LP(
            "SY-V2LP", "SY-V2LP",
            address(token0), address(token1),
            1500, -60, 60,
            address(npm), admin, 0
        );
        sy.initShareToken();
        syShare = sy.shareToken();

        // Mint underlying for the test contract; deposit into SY to bootstrap.
        token0.mint(address(this), 5_000_000e6);
        token1.mint(address(this), 5_000_000e6);
        token0.approve(address(sy), type(uint256).max);
        token1.approve(address(sy), type(uint256).max);
        sy.depositLiquidity(1_000_000e6, 1_000_000e6, 0, 0, address(this), 0);
        // Test contract now holds 2_000_000e6 SY shares.

        expiry = block.timestamp + 90 days;
        factory = address(this);

        market = new FissionMarketRewards(
            address(sy), expiry, SCALAR_ROOT, admin, treasury, 18, address(0));
        market.setTokens("fPT-V2", "fPT-V2", "fYT-V2", "fYT-V2", "lp", "lp");
        pt = market.pt();
        yt = market.yt();

        // Admin gets 200k SY → splits 100k → has 100k PT + 100k YT (frozen) + 100k SY
        // → seedBurnYt disposes the YT residual → initializes pool with 100k SY+PT.
        // After setUp: admin has 0 SY / 0 PT / 0 YT + LP shares. No dangling YT supply.
        IERC20(syShare).transfer(admin, 200_000e6);
        IERC20(syShare).transfer(alice, 500_000e6);
        IERC20(syShare).transfer(bob, 500_000e6);
        IERC20(syShare).transfer(carol, 200_000e6);

        vm.startPrank(admin);
        IERC20(syShare).approve(address(market), type(uint256).max);
        IERC20(pt).approve(address(market), type(uint256).max);
        market.split(100_000e6);
        market.seedBurnYt(100_000e6); // dispose of bootstrap YT residual
        market.initialize(100_000e6, 100_000e6, INITIAL_ANCHOR, LN_FEE_ROOT, RESERVE_PCT);
        vm.stopPrank();

        for (uint256 i = 0; i < 3; i++) {
            address u = [alice, bob, carol][i];
            vm.prank(u);
            IERC20(syShare).approve(address(market), type(uint256).max);
            vm.prank(u);
            IERC20(pt).approve(address(market), type(uint256).max);
        }
    }

    /// @dev With HTS-frozen YT, admin doesn't hold any YT post-setup (see setUp),
    ///      so the legacy `_absorbAdminYT` is a no-op. Kept as a no-op stub so existing
    ///      test signatures don't have to change.
    function _absorbAdminYT(address /* recipient */) internal pure {
        // intentionally empty
    }

    /// @dev SY rewards distribute to ALL SY holders proportionally — Market is just one
    ///      holder. This helper computes the slice that flows into the Market and thus
    ///      becomes claimable by YT holders.
    function _marketShareOfInjected(uint256 injected) internal view returns (uint256) {
        uint256 marketSY = IERC20(syShare).balanceOf(address(market));
        uint256 totalSY = IERC20(syShare).totalSupply();
        return (injected * marketSY) / totalSY;
    }

    // ───────────────────── construction ─────────────────────

    function test_constructor_pinsRewardTokens() public view {
        assertEq(market.rewardToken0(), address(token0));
        assertEq(market.rewardToken1(), address(token1));
    }

    function test_constructor_revertsOnNonRewardSY() public {
        // Build a fresh SY-like that returns wrong reward count.
        BadRewardSY bad = new BadRewardSY();
        vm.expectRevert(FissionMarketRewards.WrongRewardTokenCount.selector);
        new FissionMarketRewards(address(bad), expiry, SCALAR_ROOT, admin, treasury, 18, address(0));
    }

    function test_constructor_revertsOnZeroSy() public {
        vm.expectRevert(FissionMarketRewards.ZeroAddress.selector);
        new FissionMarketRewards(address(0), block.timestamp + 90 days, SCALAR_ROOT, admin, treasury, 18, address(0));
    }

    function test_constructor_revertsOnZeroAdmin() public {
        // OZ AccessControlDefaultAdminRules rejects zero admin BEFORE our ZeroAddress check fires.
        vm.expectRevert(abi.encodeWithSignature("AccessControlInvalidDefaultAdmin(address)", address(0)));
        new FissionMarketRewards(address(sy), block.timestamp + 90 days, SCALAR_ROOT, address(0), treasury, 18, address(0));
    }

    function test_constructor_revertsOnZeroTreasury() public {
        vm.expectRevert(FissionMarketRewards.ZeroAddress.selector);
        new FissionMarketRewards(address(sy), block.timestamp + 90 days, SCALAR_ROOT, admin, address(0), 18, address(0));
    }

    function test_constructor_revertsOnPastExpiry() public {
        vm.warp(1000);
        vm.expectRevert(FissionMarketRewards.MarketExpired.selector);
        new FissionMarketRewards(address(sy), 999, SCALAR_ROOT, admin, treasury, 18, address(0));
    }

    function test_constructor_revertsOnZeroScalarRoot() public {
        vm.expectRevert();
        new FissionMarketRewards(address(sy), block.timestamp + 90 days, 0, admin, treasury, 18, address(0));
    }

    // ───────────────────── revert paths ─────────────────────

    function test_setTokens_revertsIfNotFactory() public {
        FissionMarketRewards mkt = new FissionMarketRewards(
            address(sy), block.timestamp + 90 days, SCALAR_ROOT, admin, treasury, 18, address(0));
        vm.prank(alice);
        vm.expectRevert(FissionMarketRewards.OnlyFactory.selector);
        mkt.setTokens("p", "p", "y", "y", "lp", "lp");
    }

    function test_setTokens_revertsIfAlreadySet() public {
        // setUp already called setTokens
        vm.expectRevert(FissionMarketRewards.TokensAlreadySet.selector);
        market.setTokens("p", "p", "y", "y", "lp", "lp");
    }

    // Removed test_setTokens_revertsOnZeroYt — Market now self-creates YT, so there's
    // no zero-address input to validate.

    function test_initialize_revertsIfTokensNotSet() public {
        FissionMarketRewards mkt = new FissionMarketRewards(
            address(sy), block.timestamp + 90 days, SCALAR_ROOT, admin, treasury, 18, address(0));
        vm.prank(admin);
        vm.expectRevert(FissionMarketRewards.TokensNotSet.selector);
        mkt.initialize(1, 1, INITIAL_ANCHOR, LN_FEE_ROOT, RESERVE_PCT);
    }

    function test_initialize_revertsIfAlreadyInitialized() public {
        // setUp already initialized
        vm.prank(admin);
        vm.expectRevert(FissionMarketRewards.AlreadyInitialized.selector);
        market.initialize(1, 1, INITIAL_ANCHOR, LN_FEE_ROOT, RESERVE_PCT);
    }

    function test_initialize_revertsOnZeroAmounts() public {
        FissionMarketRewards mkt = new FissionMarketRewards(
            address(sy), block.timestamp + 90 days, SCALAR_ROOT, admin, treasury, 18, address(0));
        mkt.setTokens("p", "p", "y", "y", "lp", "lp");

        vm.prank(admin);
        vm.expectRevert(FissionMarketRewards.ZeroAmount.selector);
        mkt.initialize(0, 1, INITIAL_ANCHOR, LN_FEE_ROOT, RESERVE_PCT);
    }

    function test_initialize_revertsOnReserveFeeTooHigh() public {
        FissionMarketRewards mkt = new FissionMarketRewards(
            address(sy), block.timestamp + 90 days, SCALAR_ROOT, admin, treasury, 18, address(0));
        mkt.setTokens("p", "p", "y", "y", "lp", "lp");

        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(FissionMarketRewards.ReserveFeeTooHigh.selector, 101, 100));
        mkt.initialize(1e18, 1e18, INITIAL_ANCHOR, LN_FEE_ROOT, 101);
    }

    function test_split_revertsOnZeroAmount() public {
        vm.prank(alice);
        vm.expectRevert(FissionMarketRewards.ZeroAmount.selector);
        market.split(0);
    }

    function test_split_revertsPostExpiry() public {
        vm.warp(expiry + 1);
        vm.prank(alice);
        vm.expectRevert(FissionMarketRewards.MarketExpired.selector);
        market.split(1e6);
    }

    function test_merge_revertsOnZeroAmount() public {
        vm.prank(alice);
        vm.expectRevert(FissionMarketRewards.ZeroAmount.selector);
        market.merge(0);
    }

    function test_merge_revertsPostExpiry() public {
        vm.warp(expiry + 1);
        vm.prank(alice);
        vm.expectRevert(FissionMarketRewards.MarketExpired.selector);
        market.merge(1e6);
    }

    function test_swapPtForSy_revertsOnZeroAmount() public {
        vm.prank(alice);
        vm.expectRevert(FissionMarketRewards.ZeroAmount.selector);
        market.swapExactPtForSy(0, 0, alice);
    }

    function test_swapPtForSy_revertsOnZeroReceiver() public {
        vm.prank(alice);
        market.split(1_000e6);
        vm.prank(alice);
        vm.expectRevert(FissionMarketRewards.ZeroAddress.selector);
        market.swapExactPtForSy(100e6, 0, address(0));
    }

    function test_swapPtForSy_revertsBelowMinOut() public {
        vm.prank(alice);
        market.split(1_000e6);
        vm.prank(alice);
        vm.expectRevert(FissionMarketRewards.InsufficientOutput.selector);
        market.swapExactPtForSy(10e6, type(uint256).max, alice);
    }

    function test_swapSyForPt_revertsOnZeroAmount() public {
        vm.prank(alice);
        vm.expectRevert(FissionMarketRewards.ZeroAmount.selector);
        market.swapExactSyForPt(0, 0, alice);
    }

    function test_swapSyForPt_revertsAboveMaxIn() public {
        vm.prank(alice);
        vm.expectRevert(FissionMarketRewards.InsufficientOutput.selector);
        market.swapExactSyForPt(1, 100e6, alice);
    }

    function test_addLiquidity_revertsOnZero() public {
        vm.prank(alice);
        vm.expectRevert(FissionMarketRewards.ZeroAmount.selector);
        market.addLiquidity(0, 1, 0, alice);
    }

    function test_addLiquidity_revertsZeroReceiver() public {
        vm.prank(alice);
        vm.expectRevert(FissionMarketRewards.ZeroAddress.selector);
        market.addLiquidity(1, 1, 0, address(0));
    }

    function test_removeLiquidity_revertsOnZero() public {
        vm.prank(alice);
        vm.expectRevert(FissionMarketRewards.ZeroAmount.selector);
        market.removeLiquidity(0, 0, 0, alice);
    }

    function test_removeLiquidity_revertsZeroReceiver() public {
        vm.prank(admin);
        vm.expectRevert(FissionMarketRewards.ZeroAddress.selector);
        market.removeLiquidity(1, 0, 0, address(0));
    }

    function test_redeemAfterExpiry_revertsPreExpiry() public {
        vm.prank(alice);
        market.split(1e6);
        vm.prank(alice);
        vm.expectRevert(FissionMarketRewards.MarketNotExpired.selector);
        market.redeemAfterExpiry(1, 0, alice);
    }

    function test_redeemAfterExpiry_revertsZeroReceiver() public {
        vm.warp(expiry + 1);
        vm.prank(alice);
        vm.expectRevert(FissionMarketRewards.ZeroAddress.selector);
        market.redeemAfterExpiry(1, 0, address(0));
    }

    function test_redeemAfterExpiry_revertsOnZeroPt() public {
        vm.warp(expiry + 1);
        vm.prank(alice);
        vm.expectRevert(FissionMarketRewards.ZeroAmount.selector);
        market.redeemAfterExpiry(0, 0, alice);
    }

    function test_claimRewards_revertsZeroReceiver() public {
        vm.prank(alice);
        vm.expectRevert(FissionMarketRewards.ZeroAddress.selector);
        market.claimRewards(address(0));
    }

    function test_setTreasury_revertsZero() public {
        vm.prank(admin);
        vm.expectRevert(FissionMarketRewards.ZeroAddress.selector);
        market.setTreasury(address(0));
    }

    function test_setTreasury_unauthorizedReverts() public {
        vm.prank(alice);
        vm.expectRevert();
        market.setTreasury(address(0xBABE));
    }

    function test_setFee_revertsAboveMax() public {
        uint256 over = market.MAX_RESERVE_FEE_PERCENT() + 1;
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(FissionMarketRewards.ReserveFeeTooHigh.selector, over, 100));
        market.setFee(LN_FEE_ROOT, over);
    }

    function test_setFee_unauthorizedReverts() public {
        vm.prank(alice);
        vm.expectRevert();
        market.setFee(LN_FEE_ROOT, 80);
    }

    function test_pause_unauthorizedReverts() public {
        vm.prank(alice);
        vm.expectRevert();
        market.pause();
    }

    function test_unpause_unauthorizedReverts() public {
        vm.prank(admin);
        market.pause();
        // PAUSER_ROLE can pause but only DEFAULT_ADMIN_ROLE can unpause; alice has neither.
        vm.prank(alice);
        vm.expectRevert();
        market.unpause();
    }

    // Removed test_onYTBalanceChange_onlyYTReverts — callback path gone (HTS YT has
    // no _update hook). Rewards settlement is now explicit at every entry point.

    function test_supportsInterface_returnsTrueForIFissionMarket() public view {
        // Smoke test for ERC-165 — checks the IFissionMarketCommon interface ID.
        assertTrue(market.supportsInterface(type(IFissionMarketCommon).interfaceId));
    }

    // ───────────────────── basic flows ─────────────────────

    function test_split_mintsPtAndYt_andSettlesRewards() public {
        vm.prank(alice);
        market.split(1_000e6);
        assertEq(IERC20(pt).balanceOf(alice), 1_000e6);
        assertEq(IERC20(yt).balanceOf(alice), 1_000e6);
    }

    function test_merge_burnsPtAndYt() public {
        vm.prank(alice);
        market.split(1_000e6);
        vm.prank(alice);
        market.merge(500e6);
        assertEq(IERC20(pt).balanceOf(alice), 500e6);
        assertEq(IERC20(yt).balanceOf(alice), 500e6);
    }

    function test_swapExactPtForSy_works() public {
        vm.prank(alice);
        market.split(5_000e6);
        uint256 prevSy = IERC20(syShare).balanceOf(alice);

        vm.prank(alice);
        uint256 syOut = market.swapExactPtForSy(500e6, 0, alice);

        assertGt(syOut, 0);
        assertEq(IERC20(syShare).balanceOf(alice), prevSy + syOut);
    }

    // ───────────────────── reward distribution ─────────────────────

    function test_singleYTHolder_collectsAllRewards() public {
        _absorbAdminYT(alice);
        vm.prank(alice);
        market.split(10_000e6);
        assertEq(IERC20(yt).totalSupply(), IERC20(yt).balanceOf(alice), "alice should be sole YT holder");

        uint256 expected = _marketShareOfInjected(100e6);
        _injectFees(100e6, 0);

        vm.prank(alice);
        (uint256 r0, uint256 r1) = market.claimRewards(alice);
        // Alice owns 100% of YT → she gets the entire share that flowed into the Market.
        assertApproxEqAbs(r0, expected, 1);
        assertEq(r1, 0);
    }

    function test_twoYTHolders_proRata() public {
        // alice splits 300k, bob 100k → 3:1 YT ratio.
        vm.prank(alice);
        market.split(300_000e6);
        vm.prank(bob);
        market.split(100_000e6);

        uint256 marketShare0 = _marketShareOfInjected(400e6);
        uint256 marketShare1 = _marketShareOfInjected(200e6);
        _injectFees(400e6, 200e6);

        vm.prank(alice);
        (uint256 a0, uint256 a1) = market.claimRewards(alice);
        vm.prank(bob);
        (uint256 b0, uint256 b1) = market.claimRewards(bob);

        // 75/25 split of the Market's portion.
        assertApproxEqAbs(a0, (marketShare0 * 3) / 4, 2);
        assertApproxEqAbs(a1, (marketShare1 * 3) / 4, 2);
        assertApproxEqAbs(b0, marketShare0 / 4, 2);
        assertApproxEqAbs(b1, marketShare1 / 4, 2);
    }

    function test_lateJoiner_doesNotEarnPastRewards() public {
        // alice 200k YT pre-bob join.
        vm.prank(alice);
        market.split(200_000e6);
        // Alice sole YT holder.
        uint256 era1MarketShare = _marketShareOfInjected(100e6);
        _injectFees(100e6, 0);
        // Trigger a harvest via something that fires onYTBalanceChange — bob's split.

        vm.prank(bob);
        market.split(200_000e6);
        // Now alice 200k YT, bob 200k YT (50/50). Market's SY balance has changed too,
        // so era2's market share is recomputed.
        uint256 era2MarketShare = _marketShareOfInjected(80e6);
        _injectFees(80e6, 0);

        vm.prank(alice);
        (uint256 a0,) = market.claimRewards(alice);
        vm.prank(bob);
        (uint256 b0,) = market.claimRewards(bob);

        // alice: 100% of era1 + 50% of era2.
        // bob:   0% of era1   + 50% of era2.
        assertApproxEqAbs(a0, era1MarketShare + era2MarketShare / 2, 2);
        assertApproxEqAbs(b0, era2MarketShare / 2, 2);
    }

    /// @notice YT is HTS-frozen — direct user-to-user transfer is impossible. The
    ///         legacy "settle both sides on YT transfer" path no longer exists. The
    ///         frozen design deliberately rules out this scenario.
    function test_yt_frozen_userToUserTransferReverts() public {
        vm.prank(alice);
        market.split(100_000e6);

        vm.prank(alice);
        vm.expectRevert(); // HtsCallFailed(ACCOUNT_FROZEN_FOR_TOKEN)
        IERC20(yt).transfer(bob, 100_000e6);
    }

    function test_merge_settlesRewardsBeforeBurn() public {
        _absorbAdminYT(alice);
        vm.prank(alice);
        market.split(50_000e6);
        // Alice has 150k YT, 50k PT.
        uint256 expected0 = _marketShareOfInjected(100e6);
        uint256 expected1 = _marketShareOfInjected(50e6);
        _injectFees(100e6, 50e6);

        // Merge 50k (her matched pair) — settles her rewards first.
        vm.prank(alice);
        market.merge(50_000e6);

        vm.prank(alice);
        (uint256 r0, uint256 r1) = market.claimRewards(alice);
        // Alice was sole YT holder during the inject → gets the full Market portion.
        assertApproxEqAbs(r0, expected0, 1);
        assertApproxEqAbs(r1, expected1, 1);
    }

    function test_redeemAfterExpiry_pt1to1AndRewardsClaimable() public {
        _absorbAdminYT(alice);
        vm.prank(alice);
        market.split(50_000e6);
        uint256 expected0 = _marketShareOfInjected(50e6);
        uint256 expected1 = _marketShareOfInjected(25e6);
        _injectFees(50e6, 25e6);

        vm.warp(expiry + 1);
        uint256 prevSy = IERC20(syShare).balanceOf(alice);

        // YT-burn is now rejected (M-2 audit fix). Pass ytIn=0; alice retains YT and
        // can keep claiming future rewards.
        vm.prank(alice);
        uint256 syOut = market.redeemAfterExpiry(50_000e6, 0, alice);

        assertEq(syOut, 50_000e6, "PT redeems 1:1 with SY");
        assertEq(IERC20(syShare).balanceOf(alice), prevSy + 50_000e6);

        vm.prank(alice);
        (uint256 r0, uint256 r1) = market.claimRewards(alice);
        assertApproxEqAbs(r0, expected0, 1);
        assertApproxEqAbs(r1, expected1, 1);
    }

    function test_redeemAfterExpiry_revertsOnYTBurn() public {
        _absorbAdminYT(alice);
        vm.prank(alice);
        market.split(1_000e6);
        vm.warp(expiry + 1);
        // M-2 audit fix: passing ytIn > 0 is rejected — would forfeit future rewards.
        vm.prank(alice);
        vm.expectRevert(FissionMarketRewards.YTBurnNotPermitted.selector);
        market.redeemAfterExpiry(1_000e6, 1, alice);
    }

    // I-NEW-3 audit: block.timestamp == expiry boundary. preExpiry/afterExpiry must
    // be consistent — exactly at the boundary, redeemAfterExpiry succeeds and split/
    // swap revert.
    function test_expiryBoundary_redeemSucceedsAtExactExpiry() public {
        _absorbAdminYT(alice);
        vm.prank(alice);
        market.split(1_000e6);
        vm.warp(expiry); // exactly at boundary
        vm.prank(alice);
        uint256 syOut = market.redeemAfterExpiry(1_000e6, 0, alice);
        assertEq(syOut, 1_000e6);
    }

    function test_expiryBoundary_splitRevertsAtExactExpiry() public {
        vm.warp(expiry);
        vm.prank(alice);
        vm.expectRevert(FissionMarketRewards.MarketExpired.selector);
        market.split(1e6);
    }

    // H-4 audit fix: post-expiry removeLiquidity auto-redeems LP's PT share to SY,
    // so LP exits never compete with PT redeemers for SY backing.
    function test_removeLiquidity_autoRedeemsPTPostExpiry() public {
        // The admin is the sole LP (from setUp's initialize). After expiry, removing
        // all LP should yield SY only (ptOut == 0).
        uint256 lpBal = IERC20(market.lp()).balanceOf(admin);
        assertGt(lpBal, 0);
        vm.warp(expiry + 1);

        uint256 prevSy = IERC20(syShare).balanceOf(admin);
        uint256 prevPt = IERC20(pt).balanceOf(admin);

        vm.prank(admin);
        (uint256 syOut, uint256 ptOut) = market.removeLiquidity(lpBal, 0, 0, admin);

        assertEq(ptOut, 0, "post-expiry LP exit returns SY only");
        assertGt(syOut, 0);
        assertEq(IERC20(syShare).balanceOf(admin), prevSy + syOut);
        assertEq(IERC20(pt).balanceOf(admin), prevPt, "LP shouldn't receive any PT post-expiry");
    }

    // ───────────────────── pause ─────────────────────

    function test_pause_blocksEntryAllowsEscapeAndClaim() public {
        _absorbAdminYT(alice);
        vm.prank(alice);
        market.split(1_000e6);
        _injectFees(100e6, 0);

        vm.prank(admin);
        market.pause();

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSignature("EnforcedPause()"));
        market.split(1e6);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSignature("EnforcedPause()"));
        market.swapExactPtForSy(1e6, 0, alice);

        // Escape paths still work.
        vm.prank(alice);
        market.merge(500e6);
        vm.prank(alice);
        market.claimRewards(alice);
    }

    // ───────────────────── views ─────────────────────

    function test_previewRewards_matchesClaim() public {
        _absorbAdminYT(alice);
        vm.prank(alice);
        market.split(50_000e6);
        _injectFees(123e6, 77e6);
        market.harvestRewards();

        (uint256 v0, uint256 v1) = market.previewRewards(alice);
        vm.prank(alice);
        (uint256 c0, uint256 c1) = market.claimRewards(alice);
        assertEq(v0, c0);
        assertEq(v1, c1);
    }

    // ───────────────────── Ed25519 facade quirk (regression) ─────────────────────

    /// @notice On Hedera mainnet, `IERC20(htsToken).balanceOf(addr)` reverts when
    ///         `addr` is the long-zero EVM representation of an Ed25519 HAPI account.
    ///         Pre-fix, this silently zeroed out reward accrual for any Ed25519 user
    ///         (cosigner B at 0.0.10457309 was the first observed case on mainnet).
    ///         Post-fix, the Market tracks YT balances internally and is independent
    ///         of the facade. Both Ed25519 and ECDSA holders earn pro-rata rewards.
    function test_ed25519_user_earns_rewards_despite_facade_revert() public {
        address ecdsaUser = alice;          // facade balanceOf works
        address ed25519User = bob;          // facade balanceOf will revert
        IMockBalanceBroken(address(0x167)).__setFacadeReadBroken(ed25519User, true);

        // Both split equal amounts → 1:1 YT ratio.
        vm.prank(ecdsaUser);
        market.split(200_000e6);
        vm.prank(ed25519User);
        market.split(200_000e6);

        // Sanity: HTS facade reverts for Ed25519 user, works for ECDSA user.
        assertEq(IERC20(yt).balanceOf(ecdsaUser), 200_000e6, "ECDSA facade read");
        vm.expectRevert(bytes("HTS_FACADE_ED25519"));
        IERC20(yt).balanceOf(ed25519User);

        // Contract-tracked balance is correct for BOTH users.
        assertEq(market.ytBalanceOf(ecdsaUser), 200_000e6);
        assertEq(market.ytBalanceOf(ed25519User), 200_000e6);

        // Drive a reward cycle. Harvest pulls fees into the Market and bumps
        // globalRewardIndex; previewRewards is a static view that doesn't harvest.
        uint256 marketShare0 = _marketShareOfInjected(400e6);
        uint256 marketShare1 = _marketShareOfInjected(200e6);
        _injectFees(400e6, 200e6);
        market.harvestRewards();

        // previewRewards must not revert for the Ed25519 user (regression: it used
        // to internally call the reverting facade) and must compute the right slice.
        (uint256 pv0, uint256 pv1) = market.previewRewards(ed25519User);
        assertApproxEqAbs(pv0, marketShare0 / 2, 2, "preview r0");
        assertApproxEqAbs(pv1, marketShare1 / 2, 2, "preview r1");

        // claimRewards must actually pay out — pre-fix it returned (0, 0).
        vm.prank(ed25519User);
        (uint256 r0, uint256 r1) = market.claimRewards(ed25519User);
        assertApproxEqAbs(r0, marketShare0 / 2, 2, "ed25519 r0");
        assertApproxEqAbs(r1, marketShare1 / 2, 2, "ed25519 r1");

        // ECDSA control: same allocation, same payout.
        vm.prank(ecdsaUser);
        (uint256 c0, uint256 c1) = market.claimRewards(ecdsaUser);
        assertApproxEqAbs(c0, marketShare0 / 2, 2, "ecdsa r0");
        assertApproxEqAbs(c1, marketShare1 / 2, 2, "ecdsa r1");
    }

    // ───────────────────── M-1 audit fix (splitTo address(this) rejection) ─

    function test_splitTo_revertsOnMarketAsPtReceiver() public {
        vm.startPrank(alice);
        // alice still has SY from setUp transfer + approval.
        vm.expectRevert(FissionMarketRewards.ZeroAddress.selector);
        market.splitTo(10_000e6, address(market), alice);
        vm.stopPrank();
    }

    function test_splitTo_revertsOnMarketAsYtReceiver() public {
        vm.startPrank(alice);
        vm.expectRevert(FissionMarketRewards.ZeroAddress.selector);
        market.splitTo(10_000e6, alice, address(market));
        vm.stopPrank();
    }

    // ───────────────────── swapExactYtForSy (sell YT) ─────────────────────

    function test_sellYt_payoutMatchesYtIntrinsicValue() public {
        // alice splits → has 200k PT + 200k YT.
        vm.prank(alice);
        market.split(200_000e6);

        // Snapshot pre-sale balances.
        uint256 preSy = IERC20(syShare).balanceOf(alice);
        uint256 preYt = market.ytBalanceOf(alice);
        uint256 prePt = IERC20(pt).balanceOf(alice);
        uint256 totalPtPre = market.totalPt();
        uint256 totalSyPre = market.totalSy();

        uint256 sellAmount = 50_000e6;

        // Quote via swapExactSyForPt math: how many SY would you spend to buy
        // sellAmount PT? That's `syOwed`. User receives sellAmount - syOwed.
        vm.prank(alice);
        uint256 syOut = market.swapExactYtForSy(sellAmount, 0, alice);

        // Sanity: payout positive, less than 1:1 (PT trades at discount → YT has value).
        assertGt(syOut, 0, "got nothing");
        assertLt(syOut, sellAmount, "YT paid more than face - math inverted");

        // YT balance decreased by exact sell amount.
        assertEq(market.ytBalanceOf(alice), preYt - sellAmount, "internal YT bal");

        // PT balance unchanged — sell YT must NOT consume the user's PT.
        assertEq(IERC20(pt).balanceOf(alice), prePt, "PT must not move");

        // SY balance up by syOut.
        assertEq(IERC20(syShare).balanceOf(alice), preSy + syOut, "SY delta");

        // AMM pool: PT down by sellAmount, SY up by syOwed (=sellAmount - syOut)
        // minus reserve fee. We can't easily isolate the fee here, so check the
        // looser bound: totalPt decreased exactly sellAmount, totalSy increased.
        assertEq(market.totalPt(), totalPtPre - sellAmount, "AMM PT delta");
        assertGt(market.totalSy(), totalSyPre, "AMM SY increased");
    }

    function test_sellYt_revertsOnInsufficientYt() public {
        vm.prank(alice);
        market.split(10_000e6);
        // Alice has 10k YT but tries to sell 20k.
        vm.expectRevert(
            abi.encodeWithSelector(FissionMarketRewards.InsufficientYt.selector, 10_000e6, 20_000e6)
        );
        vm.prank(alice);
        market.swapExactYtForSy(20_000e6, 0, alice);
    }

    function test_sellYt_revertsBelowMinSyOut() public {
        vm.prank(alice);
        market.split(100_000e6);

        // Quote to know the intrinsic payout, then set minSyOut above it.
        // We don't have a `previewSellYt` view — use a high floor and expect revert.
        vm.expectRevert(FissionMarketRewards.InsufficientOutput.selector);
        vm.prank(alice);
        market.swapExactYtForSy(1_000e6, 1_000e6, alice); // demands 1:1 → too high
    }

    function test_sellYt_revertsOnZeroAmount() public {
        vm.prank(alice);
        vm.expectRevert(FissionMarketRewards.ZeroAmount.selector);
        market.swapExactYtForSy(0, 0, alice);
    }

    function test_sellYt_revertsZeroReceiver() public {
        vm.prank(alice);
        market.split(10_000e6);
        vm.expectRevert(FissionMarketRewards.ZeroAddress.selector);
        vm.prank(alice);
        market.swapExactYtForSy(1_000e6, 0, address(0));
    }

    function test_sellYt_revertsPostExpiry() public {
        vm.prank(alice);
        market.split(10_000e6);
        vm.warp(expiry + 1);
        vm.expectRevert(FissionMarketRewards.MarketExpired.selector);
        vm.prank(alice);
        market.swapExactYtForSy(1_000e6, 0, alice);
    }

    function test_sellYt_settlesRewardsBeforeBurn() public {
        // alice splits, fees accrue, then alice sells YT — she should retain her
        // accrued rewards.
        vm.prank(alice);
        market.split(100_000e6);

        _injectFees(100e6, 50e6);
        market.harvestRewards();

        (uint256 preview0Before, uint256 preview1Before) = market.previewRewards(alice);
        assertGt(preview0Before + preview1Before, 0, "test setup: alice should have accrued");

        vm.prank(alice);
        market.swapExactYtForSy(50_000e6, 0, alice);

        // She now has half the YT but the previously-accrued rewards are still claimable.
        vm.prank(alice);
        (uint256 r0, uint256 r1) = market.claimRewards(alice);
        assertApproxEqAbs(r0, preview0Before, 1, "settled r0 preserved");
        assertApproxEqAbs(r1, preview1Before, 1, "settled r1 preserved");
    }

    function test_sellYt_ed25519_userWorks() public {
        // The Ed25519 facade-revert quirk does not break Sell YT — the function
        // reads `_ytBal` (internal), not `IERC20(yt).balanceOf`.
        // We send the SY proceeds to a NON-Ed25519 address so we can assert on the
        // recipient's balance via the facade (the bug doesn't affect that read).
        address ed25519User = bob;
        address proceeds = address(0xCAFE);
        IMockBalanceBroken(address(0x167)).__setFacadeReadBroken(ed25519User, true);

        vm.prank(ed25519User);
        market.split(100_000e6);

        uint256 preProceeds = IERC20(syShare).balanceOf(proceeds);
        vm.prank(ed25519User);
        uint256 syOut = market.swapExactYtForSy(50_000e6, 0, proceeds);

        assertGt(syOut, 0);
        assertEq(IERC20(syShare).balanceOf(proceeds), preProceeds + syOut);
        assertEq(market.ytBalanceOf(ed25519User), 50_000e6);
    }

    function test_ed25519_user_merge_and_redeem_work() public {
        address ed25519User = bob;
        IMockBalanceBroken(address(0x167)).__setFacadeReadBroken(ed25519User, true);

        // Get PT+YT.
        vm.prank(ed25519User);
        market.split(100_000e6);
        assertEq(market.ytBalanceOf(ed25519User), 100_000e6);

        // Inject fees so there's a settle-able accrual.
        _injectFees(100e6, 50e6);

        // Merge half — pre-fix the `_burnYt` refreeze branch read the facade and
        // would revert for Ed25519 users.
        vm.prank(ed25519User);
        market.merge(50_000e6);
        assertEq(market.ytBalanceOf(ed25519User), 50_000e6);

        // Pending rewards from before the merge are still claimable.
        vm.prank(ed25519User);
        (uint256 r0, uint256 r1) = market.claimRewards(ed25519User);
        assertGt(r0 + r1, 0, "ed25519 user should have non-zero claim");
    }

    // ───────────────────── helpers ─────────────────────

    /// @dev Push fees into the SY's underlying V3 position, simulating swap accrual.
    function _injectFees(uint256 a0, uint256 a1) internal {
        if (a0 > 0) {
            token0.mint(address(this), a0);
            token0.approve(address(npm), a0);
        }
        if (a1 > 0) {
            token1.mint(address(this), a1);
            token1.approve(address(npm), a1);
        }
        npm.feeIn(sy.positionTokenId(), a0, a1);
    }
}

interface IMockBalanceBroken {
    function __setFacadeReadBroken(address account, bool broken) external;
}

/// @dev Minimal SY-shape that returns a 1-element reward array (≠ 2). Used to test the
///      `WrongRewardTokenCount` revert in the Market constructor.
contract BadRewardSY {
    function getRewardTokens() external pure returns (address[] memory r) {
        r = new address[](1);
        r[0] = address(0xBAD);
    }
    function exchangeRate() external pure returns (uint256) { return 1e18; }
    function assetInfo() external pure returns (uint8, address, uint8) {
        return (1, address(0), 18);
    }
}
