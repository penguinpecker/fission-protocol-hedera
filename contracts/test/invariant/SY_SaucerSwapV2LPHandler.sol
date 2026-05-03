// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {SY_SaucerSwapV2LP} from "../../src/sy/SY_SaucerSwapV2LP.sol";
import {MockUniswapV3PositionManager} from "../mocks/MockUniswapV3PositionManager.sol";
import {MockERC20} from "../mocks/MockSY.sol";

/// @notice Random-action handler that drives SY_SaucerSwapV2LP through deposits, redeems,
///         transfers, harvests, claims, and fee injections across N actors. The invariant
///         test asserts properties hold after every handler call.
contract SY_SaucerSwapV2LPHandler is CommonBase, StdCheats, StdUtils {
    SY_SaucerSwapV2LP public immutable sy;
    MockUniswapV3PositionManager public immutable npm;
    MockERC20 public immutable token0;
    MockERC20 public immutable token1;
    address[] public actors;

    /// @notice Sum of all token0 fees ever injected into the position. Used by the invariant
    ///         to verify conservation: claimed + claimable + sy-internal-balance = injected.
    uint256 public totalInjected0;
    uint256 public totalInjected1;

    /// @notice Sum of token0/1 ever paid out via claimRewards across all actors.
    uint256 public totalClaimed0;
    uint256 public totalClaimed1;

    /// @notice Per-call counters — visible in the foundry trace summary.
    uint256 public depositCount;
    uint256 public redeemCount;
    uint256 public transferCount;
    uint256 public claimCount;
    uint256 public harvestCount;
    uint256 public feeInjectCount;

    constructor(SY_SaucerSwapV2LP sy_, MockUniswapV3PositionManager npm_, MockERC20 t0, MockERC20 t1, address[] memory a) {
        sy = sy_;
        npm = npm_;
        token0 = t0;
        token1 = t1;
        actors = a;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function deposit(uint256 actorSeed, uint256 amount0, uint256 amount1) external {
        address a = _actor(actorSeed);
        amount0 = bound(amount0, 1, 100_000e6);
        amount1 = bound(amount1, 1, 100_000e6);

        // Top up actor balances; actors approve the SY in setUp.
        token0.mint(a, amount0);
        token1.mint(a, amount1);

        vm.prank(a);
        try sy.depositLiquidity(amount0, amount1, a, 0) {
            depositCount++;
        } catch {
            // Bounded rejections (paused etc.) are tolerated.
        }
    }

    function redeem(uint256 actorSeed, uint256 sharesSeed) external {
        address a = _actor(actorSeed);
        uint256 bal = sy.balanceOf(a);
        if (bal == 0) return;
        uint256 shares = bound(sharesSeed, 1, bal);

        vm.prank(a);
        try sy.redeemLiquidity(shares, a) {
            redeemCount++;
        } catch {}
    }

    function transferShares(uint256 fromSeed, uint256 toSeed, uint256 amtSeed) external {
        address from = _actor(fromSeed);
        address to = _actor(toSeed);
        if (from == to) return;
        uint256 bal = sy.balanceOf(from);
        if (bal == 0) return;
        uint256 amt = bound(amtSeed, 1, bal);

        vm.prank(from);
        try sy.transfer(to, amt) {
            transferCount++;
        } catch {}
    }

    function injectFees(uint256 a0, uint256 a1) external {
        if (sy.positionTokenId() == 0) return; // pre-first-deposit no-op
        a0 = bound(a0, 0, 10_000e6);
        a1 = bound(a1, 0, 10_000e6);
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
            feeInjectCount++;
        } catch {}
    }

    function harvest() external {
        try sy.harvest() {
            harvestCount++;
        } catch {}
    }

    function claim(uint256 actorSeed) external {
        address a = _actor(actorSeed);
        uint256 prev0 = token0.balanceOf(a);
        uint256 prev1 = token1.balanceOf(a);

        vm.prank(a);
        try sy.claimRewards(a) returns (uint256[] memory) {
            uint256 got0 = token0.balanceOf(a) - prev0;
            uint256 got1 = token1.balanceOf(a) - prev1;
            totalClaimed0 += got0;
            totalClaimed1 += got1;
            claimCount++;
        } catch {}
    }
}
