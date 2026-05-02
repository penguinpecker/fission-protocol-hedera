// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {FissionMarket} from "../../src/core/FissionMarket.sol";
import {PrincipalToken} from "../../src/core/PrincipalToken.sol";
import {YieldToken} from "../../src/core/YieldToken.sol";
import {MockSY} from "../mocks/MockSY.sol";

/// @notice Handler that drives FissionMarket through bounded operations from an actor
///         pool. Inputs are clamped to ranges that won't trivially revert (zero amounts,
///         saturated proportions, expired-market trades), so call sequences exercise the
///         contract's "interesting" state space rather than dying on guard clauses.
/// @dev    Ghost variables track aggregates the invariant tests assert against. Do NOT
///         re-derive contract math here — the test would just verify the contract
///         agrees with itself.
contract FissionMarketHandler is Test {
    FissionMarket public market;
    PrincipalToken public pt;
    YieldToken public yt;
    MockSY public sy;

    address[] public actors;
    address public currentActor;

    // ─── ghosts ───
    uint256 public ghost_totalSyDeposited; // sum of SY pulled in via split + addLiq + swapSyForPt
    uint256 public ghost_totalSyWithdrawn; // sum of SY paid out via merge + removeLiq + swapPtForSy + claimYield + redeemAfterExpiry

    uint256 public callCount_split;
    uint256 public callCount_merge;
    uint256 public callCount_swapPtForSy;
    uint256 public callCount_swapSyForPt;
    uint256 public callCount_advanceRate;
    uint256 public callCount_claimYield;

    constructor(FissionMarket m, address[] memory _actors) {
        market = m;
        pt = m.pt();
        yt = m.yt();
        sy = MockSY(address(m.sy()));
        actors = _actors;
    }

    modifier useActor(uint256 seed) {
        currentActor = actors[seed % actors.length];
        _;
    }

    // ─────────── operations ───────────

    function split(uint256 amount, uint256 actorSeed) public useActor(actorSeed) {
        amount = bound(amount, 1e16, 10_000e18);
        uint256 syBal = sy.balanceOf(currentActor);
        if (amount > syBal) amount = syBal;
        if (amount < 1e16) return;

        vm.startPrank(currentActor);
        IERC20(address(sy)).approve(address(market), amount);
        market.split(amount);
        vm.stopPrank();

        callCount_split++;
        ghost_totalSyDeposited += amount;
    }

    function merge(uint256 amount, uint256 actorSeed) public useActor(actorSeed) {
        uint256 ptBal = pt.balanceOf(currentActor);
        uint256 ytBal = yt.balanceOf(currentActor);
        uint256 cap = ptBal < ytBal ? ptBal : ytBal;
        if (cap < 1e16) return;
        amount = bound(amount, 1e16, cap);

        vm.prank(currentActor);
        market.merge(amount);

        callCount_merge++;
        ghost_totalSyWithdrawn += amount;
    }

    function swapPtForSy(uint256 amount, uint256 actorSeed) public useActor(actorSeed) {
        uint256 ptBal = pt.balanceOf(currentActor);
        if (ptBal < 1e16) return;
        // Cap at 5% of pool reserves so we don't hit MAX_MARKET_PROPORTION.
        uint256 maxSafe = market.totalPt() / 20;
        amount = bound(amount, 1e16, ptBal < maxSafe ? ptBal : maxSafe);

        vm.startPrank(currentActor);
        IERC20(address(pt)).approve(address(market), amount);
        try market.swapExactPtForSy(amount, 0, currentActor) returns (uint256 syOut) {
            ghost_totalSyWithdrawn += syOut;
            callCount_swapPtForSy++;
        } catch {}
        vm.stopPrank();
    }

    function swapSyForPt(uint256 amount, uint256 actorSeed) public useActor(actorSeed) {
        uint256 syBal = sy.balanceOf(currentActor);
        if (syBal < 1e16) return;
        // Cap PT request at 5% of pool to avoid MAX_MARKET_PROPORTION.
        uint256 ptDesired = bound(amount, 1e16, market.totalPt() / 20);

        vm.startPrank(currentActor);
        IERC20(address(sy)).approve(address(market), syBal);
        try market.swapExactSyForPt(syBal, ptDesired, currentActor) returns (uint256 syIn) {
            ghost_totalSyDeposited += syIn;
            callCount_swapSyForPt++;
        } catch {}
        vm.stopPrank();
    }

    /// @notice Move SY's exchange rate up by 1-100 bps. Yield-accrual stress.
    function advanceRate(uint256 bps) public {
        // Only pre-expiry; post-expiry the index is frozen anyway.
        if (block.timestamp >= market.expiry()) return;
        bps = bound(bps, 1, 100);
        uint256 cur = sy.exchangeRate();
        uint256 next = cur + (cur * bps) / 10_000;
        sy.setExchangeRate(next);
        callCount_advanceRate++;
    }

    function claimYield(uint256 actorSeed) public useActor(actorSeed) {
        vm.prank(currentActor);
        try market.claimYield(currentActor) returns (uint256 amount) {
            ghost_totalSyWithdrawn += amount;
            callCount_claimYield++;
        } catch {}
    }
}
