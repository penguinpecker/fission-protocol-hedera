// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {FissionRewardsMarket} from "../../src/core/FissionRewardsMarket.sol";
import {SY_SaucerSwapV2LP} from "../../src/sy/SY_SaucerSwapV2LP.sol";
import {MockUniswapV3PositionManager} from "../mocks/MockUniswapV3PositionManager.sol";
import {MockERC20} from "../mocks/MockSY.sol";
import {HtsTestHelper} from "../utils/HtsTestHelper.sol";

interface IMockBalanceBroken {
    function __setFacadeReadBroken(address account, bool broken) external;
}

/// @notice Headline regression suite for the PT freeze-by-default + `_ptBal`
///         mirror rework. PT is now freeze-by-default and tracked in `_ptBal`,
///         exactly like YT. This proves:
///           (a) a FROZEN (Ed25519-style, facade balanceOf reverts) PT holder
///               STILL accrues PT-side AMM fees and can claim a NON-ZERO amount;
///           (b) a frozen holder can sell PT via the operator path
///               (swapExactPtForSyFor), since the locked PT can't be pulled with
///               an allowance;
///           (c) invariant: sum of users' `_ptBal` == pt.totalSupply() minus the
///               pool's own PT holding.
contract FissionRewardsMarketPtFreezeTest is Test {
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
    address alice = address(0xA11CE);     // ECDSA control (facade works)
    address bob = address(0xB0B);         // Ed25519-style (facade reverts)
    address carol = address(0xCAF7);      // swapper / operator counterparty
    address periphery = address(0x9E217);

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

        // Set the freeze-exempt periphery (deploy-time admin action mirrored here).
        vm.prank(admin);
        market.setPeriphery(periphery);

        IERC20(syShare).transfer(admin, 200_000e6);
        IERC20(syShare).transfer(alice, 500_000e6);
        IERC20(syShare).transfer(bob, 500_000e6);
        IERC20(syShare).transfer(carol, 500_000e6);

        vm.startPrank(admin);
        IERC20(syShare).approve(address(market), type(uint256).max);
        market.split(100_000e6);
        market.initialize(100_000e6, 100_000e6, INITIAL_ANCHOR, LN_FEE_ROOT, RESERVE_PCT);
        vm.stopPrank();

        for (uint256 i = 0; i < 3; i++) {
            address u = [alice, bob, carol][i];
            vm.prank(u);
            IERC20(syShare).approve(address(market), type(uint256).max);
        }
    }

    function _previewPtViaMirror(address user) internal view returns (uint256) {
        uint256 bal = market.ptBalanceOf(user);
        uint256 g = market.ptAmmRewardIndex();
        uint256 u = market.userPtAmmIndex(user);
        return market.userAccruedPtAmm(user) + (bal > 0 && g > u ? (bal * (g - u)) / 1e18 : 0);
    }

    // ───────────── (a) FROZEN PT holder accrues + claims non-zero ─────────────

    /// @dev Bob is an Ed25519-style holder: his PT facade balanceOf reverts.
    ///      Pre-rework, PT-side accrual read the facade and Bob would forfeit all
    ///      PT-AMM fees. Post-rework, `_settlePtAmm` reads `_ptBal[bob]`, so he
    ///      accrues and claims a NON-ZERO amount.
    function test_frozenEd25519_ptHolder_accruesAndClaimsAmmFee() public {
        // Mark bob Ed25519-style — facade reads revert for him.
        IMockBalanceBroken(address(0x167)).__setFacadeReadBroken(bob, true);

        // Bob acquires PT by splitting. PT is delivered frozen + tracked.
        vm.prank(bob);
        market.split(50_000e6);

        // Facade reverts for bob, but the contract mirror is correct.
        vm.expectRevert(bytes("HTS_FACADE_ED25519"));
        IERC20(pt).balanceOf(bob);
        assertEq(market.ptBalanceOf(bob), 50_000e6, "PT mirror tracked");

        // Carol drives a swap → charges an AMM fee, growing the PT index.
        vm.prank(carol);
        market.swapExactSyForPt(50_000e6, 10_000e6, carol);

        assertGt(market.ptAmmRewardIndex(), 0, "PT index grew");

        // Bob's PT-AMM preview (via the mirror) is non-zero.
        uint256 preview = _previewPtViaMirror(bob);
        assertGt(preview, 0, "frozen holder accrues PT-AMM fee");

        // Bob claims — non-zero payout in SY-share, despite the reverting facade.
        // Pay to a clean sink address so the delta read isn't blocked by bob's
        // own facade-revert flag (the mock flags reads per-account, all tokens).
        address sink = address(0x5111);
        uint256 before = IERC20(syShare).balanceOf(sink);
        vm.prank(bob);
        (uint256 ptAmount, uint256 ytAmount) = market.claimAmmRewards(sink);
        assertGt(ptAmount, 0, "non-zero PT-side claim");
        assertEq(ptAmount, preview, "claim matches preview");
        assertEq(
            IERC20(syShare).balanceOf(sink) - before,
            ptAmount + ytAmount,
            "SY-share landed"
        );
    }

    // ───────────── (b) frozen holder sells PT via operator path ─────────────

    /// @dev Bob (frozen) authorizes periphery as operator, then periphery sells
    ///      Bob's frozen PT via swapExactPtForSyFor. The locked PT is wiped
    ///      directly out of Bob into the pool — no allowance needed.
    function test_frozenHolder_sellsPt_viaOperatorPath() public {
        IMockBalanceBroken(address(0x167)).__setFacadeReadBroken(bob, true);

        vm.prank(bob);
        market.split(50_000e6);
        assertEq(market.ptBalanceOf(bob), 50_000e6);

        // Bob opts in: periphery is his operator.
        vm.prank(bob);
        market.setOperator(periphery, true);

        // Periphery sells Bob's PT on his behalf → SY delivered to the periphery
        // (the production unwrap flow). AMM-02 restricts the operator path to
        // receiver ∈ {owner, periphery}; periphery is the realistic custodian and
        // its facade reads are not flagged broken.
        uint256 before = IERC20(syShare).balanceOf(periphery);
        vm.prank(periphery);
        uint256 syOut = market.swapExactPtForSyFor(bob, 20_000e6, 1, periphery);

        assertGt(syOut, 0, "operator sell produced SY");
        assertEq(market.ptBalanceOf(bob), 30_000e6, "PT mirror decremented");
        assertEq(IERC20(syShare).balanceOf(periphery) - before, syOut, "SY delivered to periphery");
    }

    /// @dev Owner can also sell their own PT directly via swapExactPtForSy
    ///      (wrapper) — the wipe-from-self path works without an allowance.
    function test_owner_sellsOwnPt_directly() public {
        vm.prank(alice);
        market.split(50_000e6);

        uint256 before = IERC20(syShare).balanceOf(alice);
        vm.prank(alice);
        uint256 syOut = market.swapExactPtForSy(20_000e6, 1, alice);

        assertGt(syOut, 0, "self-sell produced SY");
        assertEq(market.ptBalanceOf(alice), 30_000e6, "PT mirror decremented");
        assertEq(IERC20(syShare).balanceOf(alice) - before, syOut, "SY delivered");
    }

    /// @dev A non-operator caller cannot sell someone else's PT.
    function test_operatorSell_revertsForUnauthorizedCaller() public {
        vm.prank(alice);
        market.split(50_000e6);

        vm.prank(carol);
        vm.expectRevert(FissionRewardsMarket.NotAuthorized.selector);
        market.swapExactPtForSyFor(alice, 10_000e6, 1, carol);
    }

    // ───────────── AMM-02: operator cannot redirect a victim's proceeds ─────────

    /// @dev Approved operator selling the victim's PT MUST NOT be able to send the
    ///      SY proceeds to an attacker-controlled third address. Only owner or
    ///      periphery receivers are allowed on the operator path.
    function test_amm02_operatorCannotRedirectPtProceedsToThirdParty() public {
        vm.prank(alice);
        market.split(50_000e6);

        // alice opts carol in as operator (the AMM-02 attacker scenario).
        vm.prank(alice);
        market.setOperator(carol, true);

        address attacker = address(0xBADBAD);

        // Operator carol tries to drain alice's PT proceeds to `attacker`.
        vm.prank(carol);
        vm.expectRevert(FissionRewardsMarket.InvalidReceiver.selector);
        market.swapExactPtForSyFor(alice, 10_000e6, 1, attacker);

        // Same guard on the YT and addLiquidity operator paths.
        vm.prank(carol);
        vm.expectRevert(FissionRewardsMarket.InvalidReceiver.selector);
        market.swapExactYtForSyFor(alice, 10_000e6, 1, attacker);

        vm.prank(carol);
        vm.expectRevert(FissionRewardsMarket.InvalidReceiver.selector);
        market.addLiquidityFor(alice, 10_000e6, 10_000e6, 1, attacker);
    }

    /// @dev The legitimate operator flow still works: operator may deliver to the
    ///      owner themselves OR to the trusted periphery (its unwrap flow).
    function test_amm02_operatorReceiverOwnerAndPeripheryStillWork() public {
        vm.prank(alice);
        market.split(50_000e6);
        vm.prank(alice);
        market.setOperator(carol, true);

        // receiver == owner: allowed.
        uint256 beforeAlice = IERC20(syShare).balanceOf(alice);
        vm.prank(carol);
        uint256 syOut1 = market.swapExactPtForSyFor(alice, 10_000e6, 1, alice);
        assertGt(syOut1, 0, "operator->owner sell produced SY");
        assertEq(IERC20(syShare).balanceOf(alice) - beforeAlice, syOut1, "SY landed at owner");

        // receiver == periphery: allowed (the real production operator is the
        // periphery, delivering to itself for the downstream unwrap).
        uint256 beforePeri = IERC20(syShare).balanceOf(periphery);
        vm.prank(carol);
        uint256 syOut2 = market.swapExactPtForSyFor(alice, 10_000e6, 1, periphery);
        assertGt(syOut2, 0, "operator->periphery sell produced SY");
        assertEq(IERC20(syShare).balanceOf(periphery) - beforePeri, syOut2, "SY landed at periphery");
    }

    /// @dev When msg.sender == owner (self-sell) the receiver is unrestricted —
    ///      a user may always direct their OWN proceeds anywhere.
    function test_amm02_selfSellReceiverUnrestricted() public {
        vm.prank(alice);
        market.split(50_000e6);

        address anywhere = address(0xC0FFEE);
        uint256 before = IERC20(syShare).balanceOf(anywhere);
        vm.prank(alice);
        uint256 syOut = market.swapExactPtForSy(10_000e6, 1, anywhere);
        assertGt(syOut, 0, "self-sell produced SY");
        assertEq(IERC20(syShare).balanceOf(anywhere) - before, syOut, "SY delivered to chosen receiver");
    }

    // ───────────── (c) invariant: sum(_ptBal) == totalSupply - pool PT ───────

    /// @dev After a mix of split / buy / sell / merge across frozen and non-frozen
    ///      users, the sum of all tracked user balances must equal PT total
    ///      supply minus the pool's own PT holding.
    function test_invariant_userPtBalancesSumToSupplyMinusPool() public {
        IMockBalanceBroken(address(0x167)).__setFacadeReadBroken(bob, true);

        // Mix of operations.
        vm.prank(alice);
        market.split(40_000e6);
        vm.prank(bob);
        market.split(60_000e6);

        vm.prank(carol);
        market.swapExactSyForPt(30_000e6, 5_000e6, carol);  // carol buys PT (frozen, tracked)

        vm.prank(alice);
        market.swapExactPtForSy(10_000e6, 1, alice);        // alice sells some PT

        vm.prank(bob);
        market.merge(5_000e6);                              // bob merges PT+YT back

        _assertPtInvariant();
    }

    function _assertPtInvariant() internal view {
        uint256 supply = IERC20(pt).totalSupply();
        uint256 poolPt = market.ptBalanceOf(address(market));
        // The pool's own PT is held physically at address(market) but is NOT
        // tracked in _ptBal (mints/delivers skip self), so the contract's
        // ledger balance of PT == supply - sum(user _ptBal). We reconstruct
        // the pool's physical holding from totalPt reserve accounting and
        // assert: sum(user balances) + poolPhysical == supply.
        uint256 sumUsers =
            market.ptBalanceOf(admin)
            + market.ptBalanceOf(alice)
            + market.ptBalanceOf(bob)
            + market.ptBalanceOf(carol)
            + market.ptBalanceOf(periphery);

        // Pool's physical PT = total supply minus all user-held PT.
        uint256 poolPhysical = supply - sumUsers;

        // poolPt mirror is always 0 (self never tracked); the physical pool PT
        // equals the market reserve `totalPt` (pool-owned PT backing the curve).
        assertEq(poolPt, 0, "pool _ptBal mirror is untracked (0)");
        assertEq(sumUsers + poolPhysical, supply, "ledger closes");
        assertEq(poolPhysical, market.totalPt(), "pool physical PT == totalPt reserve");
    }
}
