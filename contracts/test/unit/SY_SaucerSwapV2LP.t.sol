// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {SY_SaucerSwapV2LP} from "../../src/sy/SY_SaucerSwapV2LP.sol";
import {SYBase} from "../../src/sy/SYBase.sol";
import {IStandardizedYield} from "../../src/interfaces/IStandardizedYield.sol";
import {MockUniswapV3PositionManager} from "../mocks/MockUniswapV3PositionManager.sol";
import {MockERC20} from "../mocks/MockSY.sol";
import {HtsTestHelper} from "../utils/HtsTestHelper.sol";

contract SY_SaucerSwapV2LPTest is Test {
    // Token0 sorts lower; both 6-dec for ease (matches USDC/USDT convention; in
    // production WHBAR is 8-dec and USDC is 6, but the SY's reward index math is
    // decimal-agnostic so we keep it uniform here for clarity).
    MockERC20 token0; // "USDC"
    MockERC20 token1; // "WHBAR" (using 6-dec mock for arithmetic clarity)
    MockUniswapV3PositionManager npm;
    SY_SaucerSwapV2LP sy;
    address syShare;  // cached sy.shareToken() — vm.prank-safe

    address admin = address(0xAD);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCAF7);

    int24 constant TICK_LOWER = -60;
    int24 constant TICK_UPPER = 60;
    uint24 constant POOL_FEE = 1500;

    function setUp() public {
        HtsTestHelper.installHtsPrecompile();

        // Sort by address so token0 < token1 ordering matches V3 convention.
        MockERC20 a = new MockERC20("USDC", "USDC", 6);
        MockERC20 b = new MockERC20("WHBAR", "WHBAR", 6);
        if (address(a) < address(b)) {
            token0 = a;
            token1 = b;
        } else {
            token0 = b;
            token1 = a;
        }
        npm = new MockUniswapV3PositionManager();

        sy = new SY_SaucerSwapV2LP(
            "Fission SY-V2LP",
            "SY-V2LP",
            address(token0),
            address(token1),
            POOL_FEE,
            TICK_LOWER,
            TICK_UPPER,
            address(npm),
            admin,
            0
        );
        syShare = sy.shareToken();

        // Stock everyone with both tokens.
        for (uint256 i = 0; i < 4; i++) {
            address u = [alice, bob, carol, address(this)][i];
            token0.mint(u, 1_000_000e6);
            token1.mint(u, 1_000_000e6);
            vm.prank(u);
            token0.approve(address(sy), type(uint256).max);
            vm.prank(u);
            token1.approve(address(sy), type(uint256).max);
        }
    }

    // ───────────────────── construction ─────────────────────

    function test_constructor_setsImmutables() public view {
        assertEq(sy.token0(), address(token0));
        assertEq(sy.token1(), address(token1));
        assertEq(sy.poolFee(), POOL_FEE);
        assertEq(sy.tickLower(), TICK_LOWER);
        assertEq(sy.tickUpper(), TICK_UPPER);
        assertEq(address(sy.npm()), address(npm));
        assertEq(sy.positionTokenId(), 0);
    }

    function test_constructor_revertsOnIdenticalTokens() public {
        vm.expectRevert(SY_SaucerSwapV2LP.TokensIdentical.selector);
        new SY_SaucerSwapV2LP(
            "X", "X", address(token0), address(token0), POOL_FEE, TICK_LOWER, TICK_UPPER,
            address(npm), admin, 0
        );
    }

    function test_constructor_revertsOnInvertedTicks() public {
        vm.expectRevert(SY_SaucerSwapV2LP.InvalidTickRange.selector);
        new SY_SaucerSwapV2LP(
            "X", "X", address(token0), address(token1), POOL_FEE, 100, -100,
            address(npm), admin, 0
        );
    }

    function test_constructor_revertsOnZeroAddresses() public {
        vm.expectRevert(SY_SaucerSwapV2LP.ZeroAddress.selector);
        new SY_SaucerSwapV2LP(
            "X", "X", address(0), address(token1), POOL_FEE, TICK_LOWER, TICK_UPPER,
            address(npm), admin, 0
        );
    }

    // ───────────────────── exchangeRate constant ─────────────────────

    function test_exchangeRate_isAlways1e18() public view {
        assertEq(sy.exchangeRate(), 1e18);
    }

    // ───────────────────── ERC-5115 deposit/redeem disabled ─────────────────────

    function test_deposit_revertsWithUseLiquidity() public {
        vm.expectRevert(SY_SaucerSwapV2LP.UseDepositLiquidityInstead.selector);
        sy.deposit(address(this), address(token0), 1, 0);
    }

    function test_redeem_revertsWithUseLiquidity() public {
        vm.expectRevert(SY_SaucerSwapV2LP.UseRedeemLiquidityInstead.selector);
        sy.redeem(address(this), 1, address(token0), 0, false);
    }

    function test_previewDeposit_reverts() public {
        vm.expectRevert(SY_SaucerSwapV2LP.UseDepositLiquidityInstead.selector);
        sy.previewDeposit(address(token0), 1);
    }

    function test_previewRedeem_reverts() public {
        vm.expectRevert(SY_SaucerSwapV2LP.UseRedeemLiquidityInstead.selector);
        sy.previewRedeem(address(token0), 1);
    }

    // ───────────────────── first deposit (mints NFT) ─────────────────────

    function test_firstDeposit_mintsPositionAndShares() public {
        vm.prank(alice);
        uint128 liq = sy.depositLiquidity(1_000e6, 1_000e6, 0, 0, alice, 0);

        // 1:1 mock: liquidity = (a0+a1) * 1e18 / 1e18 = 2_000e6
        assertEq(uint256(liq), 2_000e6);
        assertEq(IERC20(sy.shareToken()).balanceOf(alice), 2_000e6);
        assertEq(IERC20(sy.shareToken()).totalSupply(), 2_000e6);
        assertGt(sy.positionTokenId(), 0);
    }

    function test_firstDeposit_zeroAmountsRevert() public {
        vm.prank(alice);
        vm.expectRevert(SYBase.AmountZero.selector);
        sy.depositLiquidity(0, 0, 0, 0, alice, 0);
    }

    function test_firstDeposit_zeroReceiverReverts() public {
        vm.prank(alice);
        vm.expectRevert(SY_SaucerSwapV2LP.ZeroAddress.selector);
        sy.depositLiquidity(1e6, 1e6, 0, 0, address(0), 0);
    }

    function test_firstDeposit_singleSidedToken0() public {
        vm.prank(alice);
        uint128 liq = sy.depositLiquidity(1_000e6, 0, 0, 0, alice, 0);
        assertEq(uint256(liq), 1_000e6);
    }

    function test_firstDeposit_singleSidedToken1() public {
        vm.prank(alice);
        uint128 liq = sy.depositLiquidity(0, 1_000e6, 0, 0, alice, 0);
        assertEq(uint256(liq), 1_000e6);
    }

    function test_firstDeposit_minLiquidityNotMetReverts() public {
        vm.prank(alice);
        vm.expectRevert(SY_SaucerSwapV2LP.InsufficientLiquidityOut.selector);
        sy.depositLiquidity(1e6, 1e6, 0, 0, alice, type(uint128).max);
    }

    function test_firstDeposit_refundsUnusedTokens() public {
        // Set NPM to use only 50% of token0 desired.
        npm.setUseRatios(0.5e18, 1e18);
        uint256 prevBal0 = token0.balanceOf(alice);

        vm.prank(alice);
        sy.depositLiquidity(1_000e6, 1_000e6, 0, 0, alice, 0);

        // alice should have spent 500e6 token0 (used) + 0 refund missing = total 500e6 spent.
        assertEq(token0.balanceOf(alice), prevBal0 - 500e6);
    }

    // ───────────────────── subsequent deposit (increase) ─────────────────────

    function test_subsequentDeposit_addsLiquidityToSamePosition() public {
        vm.prank(alice);
        sy.depositLiquidity(1_000e6, 1_000e6, 0, 0, alice, 0);
        uint256 tokenId = sy.positionTokenId();

        vm.prank(bob);
        uint128 liq2 = sy.depositLiquidity(500e6, 500e6, 0, 0, bob, 0);

        assertEq(uint256(liq2), 1_000e6);
        assertEq(sy.positionTokenId(), tokenId, "tokenId must not change");
        assertEq(IERC20(sy.shareToken()).balanceOf(bob), 1_000e6);
        assertEq(IERC20(sy.shareToken()).totalSupply(), 3_000e6);
    }

    // ───────────────────── redeem ─────────────────────

    function test_redeem_partialReturnsProportionalAmounts() public {
        vm.prank(alice);
        sy.depositLiquidity(1_000e6, 1_000e6, 0, 0, alice, 0);

        uint256 prevBal0 = token0.balanceOf(alice);
        uint256 prevBal1 = token1.balanceOf(alice);

        vm.prank(alice);
        (uint256 a0, uint256 a1) = sy.redeemLiquidity(1_000e6, 0, 0, alice);

        assertEq(a0, 500e6);
        assertEq(a1, 500e6);
        assertEq(token0.balanceOf(alice), prevBal0 + 500e6);
        assertEq(token1.balanceOf(alice), prevBal1 + 500e6);
        assertEq(IERC20(sy.shareToken()).balanceOf(alice), 1_000e6);
    }

    function test_redeem_fullEmptiesAlice() public {
        vm.prank(alice);
        sy.depositLiquidity(1_000e6, 1_000e6, 0, 0, alice, 0);

        vm.prank(alice);
        sy.redeemLiquidity(2_000e6, 0, 0, alice);

        assertEq(IERC20(sy.shareToken()).balanceOf(alice), 0);
        assertEq(IERC20(sy.shareToken()).totalSupply(), 0);
    }

    function test_redeem_revertsBeforeFirstDeposit() public {
        vm.prank(alice);
        vm.expectRevert(SY_SaucerSwapV2LP.PositionNotInitialized.selector);
        sy.redeemLiquidity(1, 0, 0, alice);
    }

    function test_redeem_zeroAmountReverts() public {
        vm.prank(alice);
        sy.depositLiquidity(1_000e6, 1_000e6, 0, 0, alice, 0);
        vm.prank(alice);
        vm.expectRevert(SYBase.AmountZero.selector);
        sy.redeemLiquidity(0, 0, 0, alice);
    }

    function test_redeem_zeroReceiverReverts() public {
        vm.prank(alice);
        sy.depositLiquidity(1_000e6, 1_000e6, 0, 0, alice, 0);
        vm.prank(alice);
        vm.expectRevert(SY_SaucerSwapV2LP.ZeroAddress.selector);
        sy.redeemLiquidity(100, 0, 0, address(0));
    }

    // ───────────────────── harvest ─────────────────────

    function test_harvest_noFeesIsNoOp() public {
        vm.prank(alice);
        sy.depositLiquidity(1_000e6, 1_000e6, 0, 0, alice, 0);

        sy.harvest();
        assertEq(sy.globalRewardIndex0(), 0);
        assertEq(sy.globalRewardIndex1(), 0);
    }

    function test_harvest_token0FeesUpdateOnlyIndex0() public {
        vm.prank(alice);
        sy.depositLiquidity(1_000e6, 1_000e6, 0, 0, alice, 0);
        // Total supply = 2_000e6.

        // Inject 100e6 token0 fees into the position.
        token0.mint(address(this), 100e6);
        token0.approve(address(npm), 100e6);
        npm.feeIn(sy.positionTokenId(), 100e6, 0);

        sy.harvest();
        // index0 += 100e6 * 1e18 / 2_000e6 = 5e16
        assertEq(sy.globalRewardIndex0(), 5e16);
        assertEq(sy.globalRewardIndex1(), 0);
    }

    function test_harvest_bothTokensFees() public {
        vm.prank(alice);
        sy.depositLiquidity(1_000e6, 1_000e6, 0, 0, alice, 0);

        token0.mint(address(this), 200e6);
        token1.mint(address(this), 100e6);
        token0.approve(address(npm), 200e6);
        token1.approve(address(npm), 100e6);
        npm.feeIn(sy.positionTokenId(), 200e6, 100e6);

        sy.harvest();
        assertEq(sy.globalRewardIndex0(), 1e17); // 200e6 / 2_000e6 * 1e18
        assertEq(sy.globalRewardIndex1(), 5e16);
    }

    // ───────────────────── reward distribution ─────────────────────

    function test_singleHolder_claimGetsAllFees() public {
        vm.prank(alice);
        sy.depositLiquidity(1_000e6, 1_000e6, 0, 0, alice, 0);

        _injectFees(100e6, 50e6);

        uint256 prev0 = token0.balanceOf(alice);
        uint256 prev1 = token1.balanceOf(alice);

        vm.prank(alice);
        uint256[] memory amounts = sy.claimRewards(alice);

        assertEq(amounts[0], 100e6);
        assertEq(amounts[1], 50e6);
        assertEq(token0.balanceOf(alice), prev0 + 100e6);
        assertEq(token1.balanceOf(alice), prev1 + 50e6);
    }

    function test_twoHolders_proRataDistribution() public {
        // alice 75%, bob 25% of supply.
        vm.prank(alice);
        sy.depositLiquidity(1_500e6, 1_500e6, 0, 0, alice, 0); // 3_000e6 liq
        vm.prank(bob);
        sy.depositLiquidity(500e6, 500e6, 0, 0, bob, 0); // 1_000e6 liq
        // Total 4_000e6.

        _injectFees(400e6, 0);

        vm.prank(alice);
        uint256[] memory aliceAmt = sy.claimRewards(alice);
        vm.prank(bob);
        uint256[] memory bobAmt = sy.claimRewards(bob);

        // alice 3000/4000 * 400e6 = 300e6, bob 1000/4000 * 400e6 = 100e6.
        assertEq(aliceAmt[0], 300e6);
        assertEq(bobAmt[0], 100e6);
        assertEq(aliceAmt[1], 0);
        assertEq(bobAmt[1], 0);
    }

    function test_lateJoiner_doesNotEarnPastFees() public {
        vm.prank(alice);
        sy.depositLiquidity(1_000e6, 1_000e6, 0, 0, alice, 0); // 2_000e6 liq

        _injectFees(100e6, 0); // alice's era
        // Note: harvest happens implicitly inside the next deposit because position
        // already exists.

        vm.prank(bob);
        sy.depositLiquidity(1_000e6, 1_000e6, 0, 0, bob, 0); // 2_000e6 liq
        // Total now 4_000e6.

        _injectFees(80e6, 0); // post-bob era

        vm.prank(alice);
        uint256[] memory a = sy.claimRewards(alice);
        vm.prank(bob);
        uint256[] memory b = sy.claimRewards(bob);

        // alice: 100e6 (whole) + 40e6 (half of 80e6) = 140e6
        // bob:   0          + 40e6 (half of 80e6)   = 40e6
        assertEq(a[0], 140e6);
        assertEq(b[0], 40e6);
    }

    /// @notice Safe SY-share transfer flow post-HTS-migration: BOTH parties call
    ///         `claimRewards(self)` BEFORE the transfer. This settles both userIndexes
    ///         to the current global — alice's accrual is paid out, bob's index moves
    ///         off zero. After the transfer, future fees split correctly per balance.
    /// @dev    Without claim-from-receiver-too: bob's userIndex stays 0, so on his next
    ///         claim he over-claims as if he'd held shares from genesis. This is the
    ///         intentional limitation of HTS-native shares (no `_update` hook).
    function test_transfer_safeFlow_bothClaimBeforeTransfer() public {
        vm.prank(alice);
        sy.depositLiquidity(1_000e6, 1_000e6, 0, 0, alice, 0); // 2_000e6 liq

        _injectFees(100e6, 0);

        // alice claims (collects 100e6, sets her index).
        vm.prank(alice);
        sy.claimRewards(alice);
        // bob claims with 0 balance — pays 0, but moves his userIndex to current global.
        // This is the critical step that makes the subsequent transfer safe.
        vm.prank(bob);
        sy.claimRewards(bob);

        address shareToken = sy.shareToken();
        vm.prank(alice);
        IERC20(shareToken).transfer(bob, 1_000e6);

        _injectFees(40e6, 0);

        vm.prank(alice);
        uint256[] memory a = sy.claimRewards(alice);
        vm.prank(bob);
        uint256[] memory b = sy.claimRewards(bob);

        // alice: 20e6 (her half of post-transfer 40e6).
        // bob:   20e6 (his half).
        assertEq(a[0], 20e6);
        assertEq(b[0], 20e6);
    }

    function test_redeem_settlesRewardsBeforeBurn() public {
        vm.prank(alice);
        sy.depositLiquidity(1_000e6, 1_000e6, 0, 0, alice, 0); // 2_000e6 liq

        _injectFees(100e6, 50e6);

        // alice redeems all — her rewards are settled and remain claimable.
        vm.prank(alice);
        sy.redeemLiquidity(2_000e6, 0, 0, alice);

        vm.prank(alice);
        uint256[] memory a = sy.claimRewards(alice);
        assertEq(a[0], 100e6);
        assertEq(a[1], 50e6);
    }

    function test_claim_zeroBalanceIsNoOp() public {
        // Even before any deposits, claim returns zeros without reverting.
        vm.prank(carol);
        uint256[] memory a = sy.claimRewards(carol);
        assertEq(a[0], 0);
        assertEq(a[1], 0);
    }

    function test_accruedRewards_view_matchesClaim() public {
        vm.prank(alice);
        sy.depositLiquidity(1_000e6, 1_000e6, 0, 0, alice, 0);
        _injectFees(123e6, 77e6);
        sy.harvest();

        uint256[] memory v = sy.accruedRewards(alice);
        vm.prank(alice);
        uint256[] memory c = sy.claimRewards(alice);
        assertEq(v[0], c[0]);
        assertEq(v[1], c[1]);
    }

    // ───────────────────── ERC-5115 metadata ─────────────────────

    function test_assetInfo_isLiquidityType() public view {
        (IStandardizedYield.AssetType t, address addr, uint8 d) = sy.assetInfo();
        assertEq(uint256(t), uint256(IStandardizedYield.AssetType.LIQUIDITY));
        assertEq(addr, address(0));
        assertEq(d, 18);
    }

    function test_getTokensIn_isEmpty() public view {
        assertEq(sy.getTokensIn().length, 0);
    }

    function test_getTokensOut_isBoth() public view {
        address[] memory t = sy.getTokensOut();
        assertEq(t.length, 2);
        assertEq(t[0], address(token0));
        assertEq(t[1], address(token1));
    }

    function test_getRewardTokens_isBoth() public view {
        address[] memory t = sy.getRewardTokens();
        assertEq(t.length, 2);
        assertEq(t[0], address(token0));
        assertEq(t[1], address(token1));
    }

    // ───────────────────── pause ─────────────────────

    function test_pause_blocksDepositButAllowsRedeemAndClaim() public {
        vm.prank(alice);
        sy.depositLiquidity(1_000e6, 1_000e6, 0, 0, alice, 0);
        _injectFees(100e6, 0);

        vm.prank(admin);
        sy.pause();

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSignature("EnforcedPause()"));
        sy.depositLiquidity(1e6, 1e6, 0, 0, bob, 0);

        // Redeem still works (escape hatch).
        vm.prank(alice);
        sy.redeemLiquidity(500e6, 0, 0, alice);

        // Claim still works.
        vm.prank(alice);
        uint256[] memory a = sy.claimRewards(alice);
        assertEq(a[0], 100e6);
    }

    // ───────────────────── transfer-time harvest (Bug A regression) ─────

    /// @notice Both-parties-claim-before-transfer protects alice's accrual AND prevents
    ///         bob from over-claiming pre-transfer fees on his stale userIndex.
    function test_transfer_bothClaim_protectsBothSides() public {
        vm.prank(alice);
        sy.depositLiquidity(1_000e6, 1_000e6, 0, 0, alice, 0);

        _injectFees(100e6, 0);

        // Alice claims her accrual; bob claims-with-0-balance to set his userIndex.
        sy.harvest();
        vm.prank(alice);
        sy.claimRewards(alice);
        vm.prank(bob);
        sy.claimRewards(bob);

        address shareToken = sy.shareToken();
        vm.prank(alice);
        IERC20(shareToken).transfer(bob, 1_000e6);

        vm.prank(alice);
        uint256[] memory a = sy.claimRewards(alice);
        vm.prank(bob);
        uint256[] memory b = sy.claimRewards(bob);

        assertEq(a[0], 0, "alice already claimed her pre-transfer share");
        assertEq(b[0], 0, "bob's userIndex was set to current global before he received shares");
    }

    // ───────────────────── redeem slippage (Bug C) ─────────────────────

    function test_redeem_revertsBelowAmount0Min() public {
        vm.prank(alice);
        sy.depositLiquidity(1_000e6, 1_000e6, 0, 0, alice, 0);

        // Redeem 1_000e6 = half supply → mock returns 500e6 of each. Demand 600e6 → revert.
        vm.prank(alice);
        vm.expectRevert(bytes("slip0"));
        sy.redeemLiquidity(1_000e6, 600e6, 0, alice);
    }

    function test_redeem_revertsBelowAmount1Min() public {
        vm.prank(alice);
        sy.depositLiquidity(1_000e6, 1_000e6, 0, 0, alice, 0);

        vm.prank(alice);
        vm.expectRevert(bytes("slip1"));
        sy.redeemLiquidity(1_000e6, 0, 600e6, alice);
    }

    function test_redeem_succeedsAtExactMin() public {
        vm.prank(alice);
        sy.depositLiquidity(1_000e6, 1_000e6, 0, 0, alice, 0);

        vm.prank(alice);
        (uint256 a0, uint256 a1) = sy.redeemLiquidity(1_000e6, 500e6, 500e6, alice);
        assertEq(a0, 500e6);
        assertEq(a1, 500e6);
    }

    // ───────────────────── helpers ─────────────────────

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
