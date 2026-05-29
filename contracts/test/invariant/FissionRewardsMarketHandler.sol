// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {FissionRewardsMarket} from "../../src/core/FissionRewardsMarket.sol";
import {SY_SaucerSwapV2LP} from "../../src/sy/SY_SaucerSwapV2LP.sol";
import {MockUniswapV3PositionManager} from "../mocks/MockUniswapV3PositionManager.sol";
import {MockERC20} from "../mocks/MockSY.sol";

/// @notice AMM-01: random-action handler for the PRODUCTION `FissionRewardsMarket`
///         (freeze-by-default PT tracked in `_ptBal`, operator model, full curve
///         AMM). Exercises split / merge / swap (both directions) / addLiquidity /
///         removeLiquidity / operator-sell / reward+AMM-fee accrual+claim so the
///         invariant suite drives the NEW mechanics — not the legacy
///         `FissionMarketRewards`.
///
///         `operator` is one designated actor that every other actor opts in via
///         `setOperator`, so the operator-mediated sell paths are reachable. The
///         handler also tracks the injected / claimed reward-token ledger.
contract FissionRewardsMarketHandler is CommonBase, StdCheats, StdUtils {
    FissionRewardsMarket public immutable market;
    SY_SaucerSwapV2LP public immutable sy;
    MockUniswapV3PositionManager public immutable npm;
    MockERC20 public immutable token0;
    MockERC20 public immutable token1;
    address public immutable yt;
    /// @dev HTS-native PT — `pt` is the HTS token address.
    address public immutable pt;
    address public immutable lp;
    address public immutable syShare;
    address[] public actors;
    address public immutable operator;

    uint256 public totalInjected0;
    uint256 public totalInjected1;
    uint256 public totalClaimed0;
    uint256 public totalClaimed1;

    constructor(
        FissionRewardsMarket market_,
        SY_SaucerSwapV2LP sy_,
        MockUniswapV3PositionManager npm_,
        MockERC20 t0,
        MockERC20 t1,
        address[] memory actors_,
        address operator_
    ) {
        market = market_;
        sy = sy_;
        npm = npm_;
        token0 = t0;
        token1 = t1;
        yt = market_.yt();
        pt = market_.pt();
        lp = market_.lp();
        syShare = sy_.shareToken();
        actors = actors_;
        operator = operator_;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    // ───────────────────── split / merge ─────────────────────

    function split(uint256 actorSeed, uint256 amtSeed) external {
        address a = _actor(actorSeed);
        uint256 syBal = IERC20(syShare).balanceOf(a);
        if (syBal == 0) return;
        uint256 amount = bound(amtSeed, 1, syBal);

        vm.prank(a);
        try market.split(amount) {} catch {}
    }

    function merge(uint256 actorSeed, uint256 amtSeed) external {
        address a = _actor(actorSeed);
        // PT is frozen-by-default; use the contract-tracked ledger, not the facade.
        uint256 ptBal = market.ptBalanceOf(a);
        uint256 ytBal = market.ytBalanceOf(a);
        uint256 cap = ptBal < ytBal ? ptBal : ytBal;
        if (cap == 0) return;
        uint256 amount = bound(amtSeed, 1, cap);

        vm.prank(a);
        try market.merge(amount) {} catch {}
    }

    // ───────────────────── curve swaps ─────────────────────

    function buyPt(uint256 actorSeed, uint256 amtSeed) external {
        address a = _actor(actorSeed);
        uint256 syBal = IERC20(syShare).balanceOf(a);
        if (syBal == 0) return;
        uint256 ptOut = bound(amtSeed, 1, 50_000e6);

        vm.prank(a);
        try market.swapExactSyForPt(syBal, ptOut, a) {} catch {}
    }

    /// @dev Self-sell PT — owner path, no operator needed; freeze-wipe-from-self.
    function sellPt(uint256 actorSeed, uint256 amtSeed) external {
        address a = _actor(actorSeed);
        uint256 ptBal = market.ptBalanceOf(a);
        if (ptBal == 0) return;
        uint256 ptIn = bound(amtSeed, 1, ptBal);

        vm.prank(a);
        try market.swapExactPtForSy(ptIn, 1, a) {} catch {}
    }

    function sellYt(uint256 actorSeed, uint256 amtSeed) external {
        address a = _actor(actorSeed);
        uint256 ytBal = market.ytBalanceOf(a);
        if (ytBal == 0) return;
        uint256 ytIn = bound(amtSeed, 1, ytBal);

        vm.prank(a);
        try market.swapExactYtForSy(ytIn, 1, a) {} catch {}
    }

    /// @dev Operator-mediated PT sell. The actor must have opted the operator in
    ///      (done in setUp); receiver is constrained to the owner (AMM-02).
    function operatorSellPt(uint256 actorSeed, uint256 amtSeed) external {
        address a = _actor(actorSeed);
        if (a == operator) return;
        uint256 ptBal = market.ptBalanceOf(a);
        if (ptBal == 0) return;
        uint256 ptIn = bound(amtSeed, 1, ptBal);

        vm.prank(operator);
        try market.swapExactPtForSyFor(a, ptIn, 1, a) {} catch {}
    }

    // ───────────────────── liquidity ─────────────────────

    function addLiq(uint256 actorSeed, uint256 sySeed, uint256 ptSeed) external {
        address a = _actor(actorSeed);
        uint256 syBal = IERC20(syShare).balanceOf(a);
        uint256 ptBal = market.ptBalanceOf(a);
        if (syBal == 0 || ptBal == 0) return;
        uint256 syIn = bound(sySeed, 1, syBal);
        uint256 ptIn = bound(ptSeed, 1, ptBal);

        vm.prank(a);
        try market.addLiquidity(syIn, ptIn, 0, a) {} catch {}
    }

    function removeLiq(uint256 actorSeed, uint256 amtSeed) external {
        address a = _actor(actorSeed);
        uint256 lpBal = IERC20(lp).balanceOf(a);
        if (lpBal == 0) return;
        uint256 lpIn = bound(amtSeed, 1, lpBal);

        vm.prank(a);
        try market.removeLiquidity(lpIn, 0, 0, a) {} catch {}
    }

    // ───────────────────── reward / fee plumbing ─────────────────────

    function injectFees(uint256 a0, uint256 a1) external {
        if (sy.positionTokenId() == 0) return;
        a0 = bound(a0, 0, 1_000e6);
        a1 = bound(a1, 0, 1_000e6);
        if (a0 == 0 && a1 == 0) return;

        if (a0 > 0) {
            token0.mint(address(this), a0);
            token0.approve(address(npm), a0);
        }
        if (a1 > 0) {
            token1.mint(address(this), a1);
            token1.approve(address(npm), a1);
        }
        try npm.feeIn(sy.positionTokenId(), a0, a1) {
            totalInjected0 += a0;
            totalInjected1 += a1;
        } catch {}
    }

    function harvest() external {
        try market.harvestRewards() {} catch {}
    }

    function claim(uint256 actorSeed) external {
        address a = _actor(actorSeed);
        uint256 prev0 = token0.balanceOf(a);
        uint256 prev1 = token1.balanceOf(a);
        vm.prank(a);
        try market.claimRewards(a) returns (uint256, uint256) {
            totalClaimed0 += token0.balanceOf(a) - prev0;
            totalClaimed1 += token1.balanceOf(a) - prev1;
        } catch {}
    }

    function claimAmm(uint256 actorSeed) external {
        address a = _actor(actorSeed);
        vm.prank(a);
        try market.claimAmmRewards(a) returns (uint256, uint256) {} catch {}
    }
}
