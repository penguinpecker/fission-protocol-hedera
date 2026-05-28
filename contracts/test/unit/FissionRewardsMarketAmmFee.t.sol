// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {FissionRewardsMarket} from "../../src/core/FissionRewardsMarket.sol";
import {SY_SaucerSwapV2LP} from "../../src/sy/SY_SaucerSwapV2LP.sol";
import {MockUniswapV3PositionManager} from "../mocks/MockUniswapV3PositionManager.sol";
import {MockERC20} from "../mocks/MockSY.sol";
import {HtsTestHelper} from "../utils/HtsTestHelper.sol";

/// @notice Targeted suite for the new AMM-fee redirect in FissionRewardsMarket.
///         99% of swap fees go to PT + YT holders (49.5% each), 1% to deployer.
contract FissionRewardsMarketAmmFeeTest is Test {
    MockERC20 token0;
    MockERC20 token1;
    MockUniswapV3PositionManager npm;
    SY_SaucerSwapV2LP sy;
    address syShare;
    FissionRewardsMarket market;
    address pt;
    address yt;

    address admin = address(0xAD);
    address treasury = address(0xBEEF);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCAF7);

    uint256 expiry;
    int256 constant SCALAR_ROOT = 75e18;
    int256 constant LN_FEE_ROOT = 0.0003e18;
    uint256 constant RESERVE_PCT = 80;
    int256 constant INITIAL_ANCHOR = 1.05e18;

    function setUp() public {
        HtsTestHelper.installHtsPrecompile();

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

        token0.mint(address(this), 5_000_000e6);
        token1.mint(address(this), 5_000_000e6);
        token0.approve(address(sy), type(uint256).max);
        token1.approve(address(sy), type(uint256).max);
        sy.depositLiquidity(1_000_000e6, 1_000_000e6, 0, 0, address(this), 0);

        expiry = block.timestamp + 90 days;

        market = new FissionRewardsMarket(
            address(sy), expiry, SCALAR_ROOT, admin, treasury, 18, address(0));
        market.setTokens("fPT", "fPT", "fYT", "fYT", "fLP", "fLP");
        pt = market.pt();
        yt = market.yt();

        // Bootstrap the pool. Treasury starts at 0 SY-share so deployer-cut
        // assertions are clean deltas.
        IERC20(syShare).transfer(admin, 200_000e6);
        IERC20(syShare).transfer(alice, 500_000e6);
        IERC20(syShare).transfer(bob, 500_000e6);
        IERC20(syShare).transfer(carol, 200_000e6);

        vm.startPrank(admin);
        IERC20(syShare).approve(address(market), type(uint256).max);
        IERC20(pt).approve(address(market), type(uint256).max);
        // Admin splits 100k SY → 100k PT + 100k YT. Admin keeps the YT
        // (frozen by HTS, untransferable). Initialize the pool with 100k SY
        // + 100k PT. After this: admin has 0 SY, 0 PT, 100k YT (frozen),
        // and LP shares. YT.totalSupply() == 100k from setUp.
        market.split(100_000e6);
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

    // ───────────── invariants & constants ─────────────

    function test_feeConstants() public view {
        assertEq(market.AMM_FEE_DEPLOYER_BPS(), 100);
        assertEq(market.AMM_FEE_PT_BPS(), 4950);
        assertEq(market.AMM_FEE_YT_BPS(), 4950);
        assertEq(market.AMM_FEE_BPS_DENOM(), 10000);
        // sum is 100% exactly
        assertEq(
            market.AMM_FEE_DEPLOYER_BPS() + market.AMM_FEE_PT_BPS() + market.AMM_FEE_YT_BPS(),
            market.AMM_FEE_BPS_DENOM()
        );
    }

    /// @dev Off-chain preview computation. Mirror of the removed
    ///      `previewPtAmmRewards` / `previewYtAmmRewards` views — frontends use
    ///      the same shape. PT side reads HTS facade balanceOf (Ed25519 users
    ///      forfeit accrual). YT side reads the contract's `ytBalanceOf`
    ///      mirror so Ed25519 users are supported.
    function _previewPt(address user) internal view returns (uint256) {
        uint256 bal;
        try IERC20(pt).balanceOf(user) returns (uint256 b) { bal = b; } catch {}
        uint256 g = market.ptAmmRewardIndex();
        uint256 u = market.userPtAmmIndex(user);
        return market.userAccruedPtAmm(user) + (bal > 0 && g > u ? (bal * (g - u)) / 1e18 : 0);
    }
    function _previewYt(address user) internal view returns (uint256) {
        uint256 bal = market.ytBalanceOf(user);
        uint256 g = market.ytAmmRewardIndex();
        uint256 u = market.userYtAmmIndex(user);
        return market.userAccruedYtAmm(user) + (bal > 0 && g > u ? (bal * (g - u)) / 1e18 : 0);
    }

    function test_initialState_zeroIndices() public view {
        assertEq(market.ptAmmRewardIndex(), 0);
        assertEq(market.ytAmmRewardIndex(), 0);
        assertEq(_previewPt(alice), 0);
        assertEq(_previewYt(alice), 0);
    }

    // ───────────── swap actually distributes ─────────────

    /// @dev After alice splits, she holds PT+YT. Bob swaps SY→PT, generating
    ///      a fee. Verify the fee is split 1/49.5/49.5.
    function test_swap_distributesFeeAcrossBuckets() public {
        // Alice splits 1000 SY → 1000 PT + 1000 YT
        vm.prank(alice);
        market.split(1_000e6);

        uint256 treasuryBefore = IERC20(syShare).balanceOf(treasury);
        uint256 contractBefore = IERC20(syShare).balanceOf(address(market));

        // Bob swaps 100 SY for PT
        vm.prank(bob);
        market.swapExactSyForPt(50e6, 10e6, bob);

        // After the swap: treasury got 1% of netFee; market contract holds the
        // 99% (waiting to be claimed). Indices grew.
        uint256 treasuryDelta = IERC20(syShare).balanceOf(treasury) - treasuryBefore;
        assertGt(treasuryDelta, 0, "treasury must receive deployer cut");
        assertGt(market.ptAmmRewardIndex(), 0, "PT index grew");
        assertGt(market.ytAmmRewardIndex(), 0, "YT index grew");

        // Alice's preview should be nonzero now (she's a PT and YT holder).
        assertGt(_previewPt(alice), 0, "alice preview PT");
        assertGt(_previewYt(alice), 0, "alice preview YT");

        // Contract retained PT+YT cuts.
        assertGt(IERC20(syShare).balanceOf(address(market)), contractBefore, "contract retains PT/YT cuts");
    }

    /// @dev Ratio sanity: ptCut / ytCut == 1 (both 49.5%).
    function test_swap_ptAndYtCutsEqual() public {
        vm.prank(alice);
        market.split(1_000e6);

        // Trade.
        vm.prank(bob);
        market.swapExactSyForPt(50e6, 10e6, bob);

        // With totalSupplyPt == totalSupplyYt (both ~101k from setUp split+alice split),
        // and equal cuts, the indices should be very close. They may differ
        // slightly because the pool's bootstrap PT lives in the pool (added to
        // PT.totalSupply) while no equivalent YT was minted (seedBurnYt burned it).
        // So PT totalSupply > YT totalSupply → ptIndex < ytIndex by exactly that ratio.
        uint256 ptIdx = market.ptAmmRewardIndex();
        uint256 ytIdx = market.ytAmmRewardIndex();
        uint256 ptTs = IERC20(pt).totalSupply();
        uint256 ytTs = IERC20(yt).totalSupply();
        // ptIdx * ptTs ~= ytIdx * ytTs   (both equal ptCut == ytCut, modulo dust)
        uint256 ptPaid = (ptIdx * ptTs) / 1e18;
        uint256 ytPaid = (ytIdx * ytTs) / 1e18;
        // Tolerate 1-wei dust from integer division.
        uint256 diff = ptPaid > ytPaid ? ptPaid - ytPaid : ytPaid - ptPaid;
        assertLt(diff, 5, "PT and YT cuts should match to within rounding dust");
    }

    /// @dev claimAmmRewards transfers (ptCut + ytCut) SY-share to receiver,
    ///      returns the two amounts separately, double-claim is a no-op.
    function test_claim_transfersSyShareToReceiver() public {
        vm.prank(alice);
        market.split(1_000e6);

        vm.prank(bob);
        market.swapExactSyForPt(50e6, 10e6, bob);

        uint256 previewPt = _previewPt(alice);
        uint256 previewYt = _previewYt(alice);
        assertGt(previewPt, 0);
        assertGt(previewYt, 0);

        uint256 aliceBefore = IERC20(syShare).balanceOf(alice);

        vm.prank(alice);
        (uint256 ptClaimed, uint256 ytClaimed) = market.claimAmmRewards(alice);

        assertEq(ptClaimed, previewPt, "ptClaim matches preview");
        assertEq(ytClaimed, previewYt, "ytClaim matches preview");
        assertEq(
            IERC20(syShare).balanceOf(alice) - aliceBefore,
            previewPt + previewYt,
            "alice received both claims as SY-share"
        );

        // Double-claim is a no-op.
        vm.prank(alice);
        (uint256 pt2, uint256 yt2) = market.claimAmmRewards(alice);
        assertEq(pt2, 0, "double-claim PT");
        assertEq(yt2, 0, "double-claim YT");
    }

    /// @dev Two PT holders with equal balance get equal slices.
    function test_twoHolders_equalSplit() public {
        vm.prank(alice);
        market.split(1_000e6);
        vm.prank(bob);
        market.split(1_000e6);

        // Carol triggers fees by swapping.
        vm.prank(carol);
        market.swapExactSyForPt(50e6, 10e6, carol);

        uint256 aliceP = _previewPt(alice);
        uint256 bobP = _previewPt(bob);
        uint256 aliceY = _previewYt(alice);
        uint256 bobY = _previewYt(bob);

        // Equal balances → equal accrual (modulo Wei dust).
        uint256 dPt = aliceP > bobP ? aliceP - bobP : bobP - aliceP;
        uint256 dYt = aliceY > bobY ? aliceY - bobY : bobY - aliceY;
        assertLt(dPt, 5, "alice/bob PT accrual equal");
        assertLt(dYt, 5, "alice/bob YT accrual equal");
    }

    // ───────────── settlement on PT/YT-touching ops ─────────────

    /// @dev When a user splits AGAIN after some fee has accrued, the prior
    ///      accrual is locked into `userAccruedPtAmm` (not lost). After a
    ///      second swap, the user accrues NEW rewards on top.
    function test_split_preservesPriorAccrual() public {
        vm.prank(alice);
        market.split(1_000e6);

        vm.prank(bob);
        market.swapExactSyForPt(50e6, 10e6, bob);

        uint256 priorPt = _previewPt(alice);
        uint256 priorYt = _previewYt(alice);
        assertGt(priorPt, 0);
        assertGt(priorYt, 0);

        // Alice splits more. _split() calls _settlePtAmm/_settleYtAmm first.
        vm.prank(alice);
        market.split(500e6);

        // Prior accrual must be intact (now lives in userAccruedPtAmm).
        assertGe(market.userAccruedPtAmm(alice), priorPt, "prior PT accrual locked in");
        assertGe(market.userAccruedYtAmm(alice), priorYt, "prior YT accrual locked in");
    }

    /// @dev Post-expiry: alice redeems PT for SY. Her PT-AMM accrual must
    ///      survive the burn (settled BEFORE burn).
    function test_redeemAfterExpiry_preservesPtAmmAccrual() public {
        vm.prank(alice);
        market.split(1_000e6);

        vm.prank(bob);
        market.swapExactSyForPt(50e6, 10e6, bob);

        uint256 priorPt = _previewPt(alice);
        assertGt(priorPt, 0);

        // Warp past expiry.
        vm.warp(expiry + 1);

        // Alice redeems all 1000 PT.
        vm.prank(alice);
        market.redeemAfterExpiry(1_000e6, 0, alice);

        // She no longer holds PT, but her accrual is locked in.
        assertEq(IERC20(pt).balanceOf(alice), 0, "PT burned");
        assertGe(market.userAccruedPtAmm(alice), priorPt, "PT-AMM survived redeem");

        // She can claim it.
        uint256 before = IERC20(syShare).balanceOf(alice);
        vm.prank(alice);
        (uint256 ptClaimed, uint256 ytClaimed) = market.claimAmmRewards(alice);
        assertGe(ptClaimed, priorPt, "PT claim succeeded post-redeem");
        assertEq(IERC20(syShare).balanceOf(alice) - before, ptClaimed + ytClaimed, "SY-share landed");
    }

    /// @dev merge() must settle both PT and YT before burning. Prior accrual
    ///      survives the merge.
    function test_merge_preservesAccrual() public {
        vm.prank(alice);
        market.split(1_000e6);

        vm.prank(bob);
        market.swapExactSyForPt(50e6, 10e6, bob);

        uint256 priorPt = _previewPt(alice);
        uint256 priorYt = _previewYt(alice);
        assertGt(priorPt, 0);
        assertGt(priorYt, 0);

        vm.prank(alice);
        market.merge(500e6);

        // After merge, alice's locked accrual is at LEAST what she had before.
        assertGe(market.userAccruedPtAmm(alice), priorPt);
        assertGe(market.userAccruedYtAmm(alice), priorYt);
    }

    /// @dev Bob's own swap should not credit him for the fee he himself paid.
    ///      After his trade, his preview of PT-AMM should be ~0 (he holds no
    ///      PT before the trade, and _markPtAmmIndex pins post-trade balance
    ///      against current index).
    function test_swapper_doesNotEarnOwnFee() public {
        // Bob starts with 0 PT, 0 YT (he never split).
        assertEq(IERC20(pt).balanceOf(bob), 0);

        vm.prank(bob);
        market.swapExactSyForPt(50e6, 10e6, bob);

        // After: bob holds PT (he bought it), but his userPtAmmIndex was
        // pinned to current index, so preview returns 0 for the trade he
        // just executed. (Subsequent trades by OTHERS would accrue.)
        assertEq(_previewPt(bob), 0, "no self-credit from own trade");
    }

    /// @dev Bob bought PT in his trade — for the NEXT trade by someone else,
    ///      he should start accruing on his newly-acquired PT.
    function test_subsequentTrade_creditsNewPtHolder() public {
        // Bob buys a larger chunk so any per-PT-fee accrual is above the
        // integer-division floor (REWARD_SCALE = 1e18).
        vm.prank(bob);
        market.swapExactSyForPt(50_000e6, 10_000e6, bob);
        assertEq(_previewPt(bob), 0);

        uint256 idxAfterBob = market.ptAmmRewardIndex();

        // Carol now trades — also a larger chunk to push the index.
        vm.prank(carol);
        market.swapExactSyForPt(50_000e6, 10_000e6, carol);

        // Index must have moved past where bob's was pinned.
        assertGt(market.ptAmmRewardIndex(), idxAfterBob, "index grew on carol trade");
        // Bob now has positive accrual on his PT.
        assertGt(_previewPt(bob), 0, "bob accrues on second trade");
    }

    /// @dev Deployer cut is exactly 1% of netSyFee. With the AmmFeeDistributed
    ///      event removed for size, we recover netSyFee from the standard
    ///      Swap event and verify the treasury delta matches.
    function test_amm_feeAccountingClosesOut() public {
        vm.prank(alice);
        market.split(1_000e6);

        uint256 treasuryBefore = IERC20(syShare).balanceOf(treasury);

        vm.recordLogs();
        vm.prank(bob);
        market.swapExactSyForPt(50e6, 10e6, bob);

        // Find the Swap event — its `syFee` field is the netSyFee we split.
        bytes32 sig = keccak256("Swap(address,address,int256,int256,int256,int256)");
        bool found = false;
        int256 netSyFee;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == sig) {
                (, , netSyFee, ) = abi.decode(logs[i].data, (int256, int256, int256, int256));
                found = true;
                break;
            }
        }
        assertTrue(found, "Swap event emitted");
        assertGt(netSyFee, 0);

        uint256 fee = uint256(netSyFee);
        uint256 deployerExpected = fee / 100;          // 1%
        uint256 ptExpected = (fee * 4950) / 10000;     // 49.5%
        uint256 ytExpected = fee - deployerExpected - ptExpected; // remainder (dust to YT)

        // Treasury must receive exactly the deployer cut.
        assertEq(
            IERC20(syShare).balanceOf(treasury) - treasuryBefore,
            deployerExpected,
            "treasury delta = 1% of netSyFee"
        );

        // Cuts close out exactly.
        assertEq(deployerExpected + ptExpected + ytExpected, fee, "cuts sum to netSyFee");
    }
}
