// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {FissionMarketRewards} from "../../src/core/FissionMarketRewards.sol";
import {YieldToken} from "../../src/core/YieldToken.sol";
import {SY_SaucerSwapV2LP} from "../../src/sy/SY_SaucerSwapV2LP.sol";
import {MarketMath} from "../../src/libraries/MarketMath.sol";
import {IFissionMarket} from "../../src/interfaces/IFissionMarket.sol";
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
    FissionMarketRewards market;
    address pt;
    YieldToken yt;

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
            address(sy), expiry, SCALAR_ROOT, admin, treasury, 18, "Fission LP-V2", "fLP-V2"
        );
        yt = new YieldToken("fYT-V2", "fYT-V2", address(sy), expiry, address(market), 18);
        market.setTokens(address(yt), "fPT-V2", "fPT-V2");
        pt = market.pt();

        // Send admin 200k SY (admin will split 100k → 100k PT + 100k YT, then initialize
        // with the remaining 100k SY + 100k PT). Admin keeps 100k YT as residual.
        IERC20(address(sy)).transfer(admin, 200_000e6);
        // Actors get plenty of SY so tests can split sizeable amounts.
        IERC20(address(sy)).transfer(alice, 500_000e6);
        IERC20(address(sy)).transfer(bob, 500_000e6);
        IERC20(address(sy)).transfer(carol, 200_000e6);

        vm.startPrank(admin);
        IERC20(address(sy)).approve(address(market), type(uint256).max);
        IERC20(pt).approve(address(market), type(uint256).max);
        market.split(100_000e6);
        market.initialize(100_000e6, 100_000e6, INITIAL_ANCHOR, LN_FEE_ROOT, RESERVE_PCT);
        vm.stopPrank();
        // Admin now holds: 0 SY, 0 PT, 100_000e6 YT, plus LP shares from initialize.
        // Test contract holds the remaining ~1_550_000 SY but ZERO YT — clean.

        for (uint256 i = 0; i < 3; i++) {
            address u = [alice, bob, carol][i];
            vm.prank(u);
            IERC20(address(sy)).approve(address(market), type(uint256).max);
            vm.prank(u);
            IERC20(pt).approve(address(market), type(uint256).max);
        }
    }

    /// @dev Tests that need actor X to be the SOLE YT holder absorb admin's residual YT
    ///      first. Admin's 100k YT then becomes part of X's balance — no dangling
    ///      uncontrolled YT remains.
    function _absorbAdminYT(address recipient) internal {
        uint256 amt = yt.balanceOf(admin); // read first; vm.prank applies only to NEXT call
        vm.prank(admin);
        yt.transfer(recipient, amt);
    }

    /// @dev SY rewards distribute to ALL SY holders proportionally — Market is just one
    ///      holder. This helper computes the slice that flows into the Market and thus
    ///      becomes claimable by YT holders.
    function _marketShareOfInjected(uint256 injected) internal view returns (uint256) {
        uint256 marketSY = IERC20(address(sy)).balanceOf(address(market));
        uint256 totalSY = sy.totalSupply();
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
        new FissionMarketRewards(address(bad), expiry, SCALAR_ROOT, admin, treasury, 18, "x", "x");
    }

    function test_constructor_revertsOnZeroSy() public {
        vm.expectRevert(FissionMarketRewards.ZeroAddress.selector);
        new FissionMarketRewards(address(0), block.timestamp + 90 days, SCALAR_ROOT, admin, treasury, 18, "x", "x");
    }

    function test_constructor_revertsOnZeroAdmin() public {
        // OZ AccessControlDefaultAdminRules rejects zero admin BEFORE our ZeroAddress check fires.
        vm.expectRevert(abi.encodeWithSignature("AccessControlInvalidDefaultAdmin(address)", address(0)));
        new FissionMarketRewards(address(sy), block.timestamp + 90 days, SCALAR_ROOT, address(0), treasury, 18, "x", "x");
    }

    function test_constructor_revertsOnZeroTreasury() public {
        vm.expectRevert(FissionMarketRewards.ZeroAddress.selector);
        new FissionMarketRewards(address(sy), block.timestamp + 90 days, SCALAR_ROOT, admin, address(0), 18, "x", "x");
    }

    function test_constructor_revertsOnPastExpiry() public {
        vm.warp(1000);
        vm.expectRevert(FissionMarketRewards.MarketExpired.selector);
        new FissionMarketRewards(address(sy), 999, SCALAR_ROOT, admin, treasury, 18, "x", "x");
    }

    function test_constructor_revertsOnZeroScalarRoot() public {
        vm.expectRevert();
        new FissionMarketRewards(address(sy), block.timestamp + 90 days, 0, admin, treasury, 18, "x", "x");
    }

    // ───────────────────── revert paths ─────────────────────

    function test_setTokens_revertsIfNotFactory() public {
        FissionMarketRewards mkt = new FissionMarketRewards(
            address(sy), block.timestamp + 90 days, SCALAR_ROOT, admin, treasury, 18, "x", "x"
        );
        vm.prank(alice);
        vm.expectRevert(FissionMarketRewards.OnlyFactory.selector);
        mkt.setTokens(address(0x1), "p", "p");
    }

    function test_setTokens_revertsIfAlreadySet() public {
        // setUp already called setTokens
        vm.expectRevert(FissionMarketRewards.TokensAlreadySet.selector);
        market.setTokens(address(0x1), "p", "p");
    }

    function test_setTokens_revertsOnZeroYt() public {
        FissionMarketRewards mkt = new FissionMarketRewards(
            address(sy), block.timestamp + 90 days, SCALAR_ROOT, admin, treasury, 18, "x", "x"
        );
        vm.expectRevert(FissionMarketRewards.ZeroAddress.selector);
        mkt.setTokens(address(0), "p", "p");
    }

    function test_initialize_revertsIfTokensNotSet() public {
        FissionMarketRewards mkt = new FissionMarketRewards(
            address(sy), block.timestamp + 90 days, SCALAR_ROOT, admin, treasury, 18, "x", "x"
        );
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
            address(sy), block.timestamp + 90 days, SCALAR_ROOT, admin, treasury, 18, "x", "x"
        );
        // Need PT/YT set up first
        YieldToken y = new YieldToken("y", "y", address(sy), mkt.expiry(), address(mkt), 18);
        mkt.setTokens(address(y), "p", "p");

        vm.prank(admin);
        vm.expectRevert(FissionMarketRewards.ZeroAmount.selector);
        mkt.initialize(0, 1, INITIAL_ANCHOR, LN_FEE_ROOT, RESERVE_PCT);
    }

    function test_initialize_revertsOnReserveFeeTooHigh() public {
        FissionMarketRewards mkt = new FissionMarketRewards(
            address(sy), block.timestamp + 90 days, SCALAR_ROOT, admin, treasury, 18, "x", "x"
        );
        YieldToken y = new YieldToken("y", "y", address(sy), mkt.expiry(), address(mkt), 18);
        mkt.setTokens(address(y), "p", "p");

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

    function test_onYTBalanceChange_onlyYTReverts() public {
        vm.prank(alice);
        vm.expectRevert(FissionMarketRewards.OnlyYT.selector);
        market.onYTBalanceChange(alice, bob);
    }

    function test_supportsInterface_returnsTrueForIFissionMarket() public view {
        // Smoke test for ERC-165
        assertTrue(market.supportsInterface(type(IFissionMarket).interfaceId));
    }

    // ───────────────────── basic flows ─────────────────────

    function test_split_mintsPtAndYt_andSettlesRewards() public {
        vm.prank(alice);
        market.split(1_000e6);
        assertEq(IERC20(pt).balanceOf(alice), 1_000e6);
        assertEq(yt.balanceOf(alice), 1_000e6);
    }

    function test_merge_burnsPtAndYt() public {
        vm.prank(alice);
        market.split(1_000e6);
        vm.prank(alice);
        market.merge(500e6);
        assertEq(IERC20(pt).balanceOf(alice), 500e6);
        assertEq(yt.balanceOf(alice), 500e6);
    }

    function test_swapExactPtForSy_works() public {
        vm.prank(alice);
        market.split(5_000e6);
        uint256 prevSy = IERC20(address(sy)).balanceOf(alice);

        vm.prank(alice);
        uint256 syOut = market.swapExactPtForSy(500e6, 0, alice);

        assertGt(syOut, 0);
        assertEq(IERC20(address(sy)).balanceOf(alice), prevSy + syOut);
    }

    // ───────────────────── reward distribution ─────────────────────

    function test_singleYTHolder_collectsAllRewards() public {
        _absorbAdminYT(alice);
        vm.prank(alice);
        market.split(10_000e6);
        assertEq(yt.totalSupply(), yt.balanceOf(alice), "alice should be sole YT holder");

        uint256 expected = _marketShareOfInjected(100e6);
        _injectFees(100e6, 0);

        vm.prank(alice);
        (uint256 r0, uint256 r1) = market.claimRewards(alice);
        // Alice owns 100% of YT → she gets the entire share that flowed into the Market.
        assertApproxEqAbs(r0, expected, 1);
        assertEq(r1, 0);
    }

    function test_twoYTHolders_proRata() public {
        _absorbAdminYT(alice);
        vm.prank(alice);
        market.split(200_000e6);
        vm.prank(bob);
        market.split(100_000e6);
        // alice 300k YT, bob 100k YT → 3:1.

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
        _absorbAdminYT(alice);
        vm.prank(alice);
        market.split(100_000e6);
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

    function test_ytTransfer_settlesBothSides() public {
        _absorbAdminYT(alice);
        vm.prank(alice);
        market.split(100_000e6);
        // Alice sole YT holder pre-transfer.
        uint256 era1MarketShare = _marketShareOfInjected(100e6);
        _injectFees(100e6, 0);
        market.harvestRewards();

        // Alice transfers half her YT to bob — both sides settle.
        vm.prank(alice);
        yt.transfer(bob, 100_000e6);

        uint256 era2MarketShare = _marketShareOfInjected(40e6);
        _injectFees(40e6, 0);

        vm.prank(alice);
        (uint256 a0,) = market.claimRewards(alice);
        vm.prank(bob);
        (uint256 b0,) = market.claimRewards(bob);

        // alice: full era1 + half era2 ; bob: half era2.
        assertApproxEqAbs(a0, era1MarketShare + era2MarketShare / 2, 2);
        assertApproxEqAbs(b0, era2MarketShare / 2, 2);
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
        uint256 prevSy = IERC20(address(sy)).balanceOf(alice);

        // YT-burn is now rejected (M-2 audit fix). Pass ytIn=0; alice retains YT and
        // can keep claiming future rewards.
        vm.prank(alice);
        uint256 syOut = market.redeemAfterExpiry(50_000e6, 0, alice);

        assertEq(syOut, 50_000e6, "PT redeems 1:1 with SY");
        assertEq(IERC20(address(sy)).balanceOf(alice), prevSy + 50_000e6);

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
        uint256 lpBal = market.balanceOf(admin);
        assertGt(lpBal, 0);
        vm.warp(expiry + 1);

        uint256 prevSy = IERC20(address(sy)).balanceOf(admin);
        uint256 prevPt = IERC20(pt).balanceOf(admin);

        vm.prank(admin);
        (uint256 syOut, uint256 ptOut) = market.removeLiquidity(lpBal, 0, 0, admin);

        assertEq(ptOut, 0, "post-expiry LP exit returns SY only");
        assertGt(syOut, 0);
        assertEq(IERC20(address(sy)).balanceOf(admin), prevSy + syOut);
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
