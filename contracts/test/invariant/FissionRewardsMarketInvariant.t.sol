// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {FissionRewardsMarket} from "../../src/core/FissionRewardsMarket.sol";
import {SY_SaucerSwapV2LP} from "../../src/sy/SY_SaucerSwapV2LP.sol";
import {MockUniswapV3PositionManager} from "../mocks/MockUniswapV3PositionManager.sol";
import {MockERC20} from "../mocks/MockSY.sol";
import {FissionRewardsMarketHandler} from "./FissionRewardsMarketHandler.sol";
import {HtsTestHelper} from "../utils/HtsTestHelper.sol";

/// @title  AMM-01 — invariant suite for the PRODUCTION `FissionRewardsMarket`.
///         The legacy `FissionMarketRewards` suite remains, but the invariants
///         that matter for v1 must exercise the reworked code: freeze-by-default
///         PT in the `_ptBal` ledger, the operator model, and the full curve AMM.
///
///         Invariants asserted:
///           (1) PT ledger closes: sum(user `_ptBal`) + pool physical PT
///               (== market.totalPt()) == pt.totalSupply().  [the brief's core ask]
///           (2) Solvency: market SY balance >= PT.totalSupply() (every PT
///               redeemable 1:1 at/after expiry).
///           (3) PT/YT supply parity pre-expiry.
///           (4) Reward-token conservation (ledger never over-counts; market
///               always covers bookkept-claimable).
contract FissionRewardsMarketInvariantTest is Test {
    MockERC20 token0;
    MockERC20 token1;
    MockUniswapV3PositionManager npm;
    SY_SaucerSwapV2LP sy;
    address syShare;
    FissionRewardsMarket market;
    address pt;
    address yt;
    FissionRewardsMarketHandler handler;

    address admin = address(0xAD);
    address treasury = address(0xBEEF);
    address[] actors;
    address operator = address(0x09E2);

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
            "SY-V2LP", "SY-V2LP", address(token0), address(token1), 1500, -60, 60, address(npm), admin, 0
        );
        sy.initShareToken();
        syShare = sy.shareToken();

        token0.mint(address(this), 5_000_000e6);
        token1.mint(address(this), 5_000_000e6);
        token0.approve(address(sy), type(uint256).max);
        token1.approve(address(sy), type(uint256).max);
        sy.depositLiquidity(1_000_000e6, 1_000_000e6, 0, 0, address(this), 0);

        uint256 expiry_ = block.timestamp + 90 days;
        market =
            new FissionRewardsMarket(address(sy), expiry_, SCALAR_ROOT, admin, treasury, 18, address(0));
        market.setTokens("rPT", "rPT", "rYT", "rYT", "rLP", "rLP");
        pt = market.pt();
        yt = market.yt();

        actors = new address[](3);
        actors[0] = address(0xA1);
        actors[1] = address(0xA2);
        actors[2] = address(0xA3);

        IERC20(syShare).transfer(admin, 200_000e6);
        for (uint256 i = 0; i < actors.length; i++) {
            IERC20(syShare).transfer(actors[i], 300_000e6);
        }

        // Admin splits + initializes the curve.
        vm.startPrank(admin);
        IERC20(syShare).approve(address(market), type(uint256).max);
        market.split(100_000e6);
        market.initialize(100_000e6, 100_000e6, INITIAL_ANCHOR, LN_FEE_ROOT, RESERVE_PCT);
        vm.stopPrank();

        // Actors approve SY to the market and opt the operator in (AMM-02 / the
        // operator sell path). SY is transferable so a normal allowance suffices.
        for (uint256 i = 0; i < actors.length; i++) {
            vm.prank(actors[i]);
            IERC20(syShare).approve(address(market), type(uint256).max);
            vm.prank(actors[i]);
            market.setOperator(operator, true);
        }

        handler = new FissionRewardsMarketHandler(market, sy, npm, token0, token1, actors, operator);

        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](12);
        selectors[0] = handler.split.selector;
        selectors[1] = handler.merge.selector;
        selectors[2] = handler.buyPt.selector;
        selectors[3] = handler.sellPt.selector;
        selectors[4] = handler.sellYt.selector;
        selectors[5] = handler.operatorSellPt.selector;
        selectors[6] = handler.addLiq.selector;
        selectors[7] = handler.removeLiq.selector;
        selectors[8] = handler.injectFees.selector;
        selectors[9] = handler.harvest.selector;
        selectors[10] = handler.claim.selector;
        selectors[11] = handler.claimAmm.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// (1) THE PT LEDGER INVARIANT (brief's core ask):
    ///     sum(user `_ptBal`) + pool physical PT == pt.totalSupply().
    ///     Pool-held PT is never tracked in `_ptBal` (self is skipped on
    ///     mint/deliver), and the pool's physical holding == market.totalPt().
    function invariant_ptLedgerCloses() public view {
        uint256 supply = IERC20(pt).totalSupply();

        uint256 sumUsers = market.ptBalanceOf(admin) + market.ptBalanceOf(address(this));
        for (uint256 i = 0; i < actors.length; i++) {
            sumUsers += market.ptBalanceOf(actors[i]);
        }
        sumUsers += market.ptBalanceOf(operator);

        // The pool's own _ptBal mirror is always 0 (self never tracked).
        assertEq(market.ptBalanceOf(address(market)), 0, "pool _ptBal mirror must be 0");

        // pool physical PT == totalPt reserve; the ledger must close.
        assertEq(sumUsers + market.totalPt(), supply, "PT ledger does not close");
    }

    /// (2) Solvency — market holds enough SY to redeem every PT 1:1.
    function invariant_solvency() public view {
        uint256 marketSY = IERC20(syShare).balanceOf(address(market));
        assertGe(marketSY, IERC20(pt).totalSupply(), "solvency violated");
    }

    /// (3) PT/YT supply parity pre-expiry (split/merge move them in lockstep; the
    ///     AMM swaps burn PT against the pool but keep the YT-vs-pool-PT accounting
    ///     consistent so user-facing supplies stay paired until expiry).
    function invariant_ptYtSupplyParityPreExpiry() public view {
        if (block.timestamp >= market.expiry()) return;
        assertEq(IERC20(pt).totalSupply(), IERC20(yt).totalSupply(), "PT/YT diverged");
    }

    /// (4) Reward-token conservation.
    function invariant_rewardConservation() public view {
        uint256 claimable0;
        uint256 claimable1;
        for (uint256 i = 0; i < actors.length; i++) {
            (uint256 c0, uint256 c1) = market.previewRewards(actors[i]);
            claimable0 += c0;
            claimable1 += c1;
        }
        (uint256 ac0, uint256 ac1) = market.previewRewards(admin);
        claimable0 += ac0;
        claimable1 += ac1;

        uint256 mBal0 = token0.balanceOf(address(market));
        uint256 mBal1 = token1.balanceOf(address(market));

        uint256 maxDrift = (actors.length + 1) * 4;

        assertGe(mBal0 + maxDrift, claimable0, "market insolvent on token0");
        assertGe(mBal1 + maxDrift, claimable1, "market insolvent on token1");

        assertLe(
            handler.totalClaimed0() + claimable0, handler.totalInjected0() + maxDrift, "ledger0 over-counts"
        );
        assertLe(
            handler.totalClaimed1() + claimable1, handler.totalInjected1() + maxDrift, "ledger1 over-counts"
        );
    }
}
