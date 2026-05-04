// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {FissionMarketRewards} from "../../src/core/FissionMarketRewards.sol";
import {SY_SaucerSwapV2LP} from "../../src/sy/SY_SaucerSwapV2LP.sol";
import {MockUniswapV3PositionManager} from "../mocks/MockUniswapV3PositionManager.sol";
import {MockERC20} from "../mocks/MockSY.sol";

/// @notice Random-action handler for FissionMarketRewards invariants. Each actor can
///         split, merge, transfer YT, harvest, claim rewards, or trigger fee accrual at
///         the SY position level. The harness keeps a running ledger of injected and
///         claimed reward amounts so the conservation invariant can verify the books.
contract FissionMarketRewardsHandler is CommonBase, StdCheats, StdUtils {
    FissionMarketRewards public immutable market;
    SY_SaucerSwapV2LP public immutable sy;
    MockUniswapV3PositionManager public immutable npm;
    MockERC20 public immutable token0;
    MockERC20 public immutable token1;
    address public immutable yt;
    /// @dev HTS-native PT — `pt` is the HTS token address. Use `IERC20(pt).balanceOf(...)`.
    address public immutable pt;
    address public immutable syShare;
    address[] public actors;

    uint256 public totalInjected0;
    uint256 public totalInjected1;
    uint256 public totalClaimed0;
    uint256 public totalClaimed1;

    constructor(
        FissionMarketRewards market_,
        SY_SaucerSwapV2LP sy_,
        MockUniswapV3PositionManager npm_,
        MockERC20 t0,
        MockERC20 t1,
        address[] memory actors_
    ) {
        market = market_;
        sy = sy_;
        npm = npm_;
        token0 = t0;
        token1 = t1;
        yt = market_.yt();
        pt = market_.pt();
        syShare = sy_.shareToken();
        actors = actors_;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

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
        uint256 ptBal = IERC20(pt).balanceOf(a);
        uint256 ytBal = IERC20(yt).balanceOf(a);
        uint256 cap = ptBal < ytBal ? ptBal : ytBal;
        if (cap == 0) return;
        uint256 amount = bound(amtSeed, 1, cap);

        vm.prank(a);
        try market.merge(amount) {} catch {}
    }

    function transferYT(uint256 fromSeed, uint256 toSeed, uint256 amtSeed) external {
        address from = _actor(fromSeed);
        address to = _actor(toSeed);
        if (from == to) return;
        uint256 bal = IERC20(yt).balanceOf(from);
        if (bal == 0) return;
        uint256 amt = bound(amtSeed, 1, bal);

        vm.prank(from);
        try IERC20(yt).transfer(to, amt) {} catch {}
    }

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
}
