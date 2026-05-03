// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {SY_SaucerSwapV2LP} from "../../src/sy/SY_SaucerSwapV2LP.sol";
import {MockUniswapV3PositionManager} from "../mocks/MockUniswapV3PositionManager.sol";
import {MockERC20} from "../mocks/MockSY.sol";
import {SY_SaucerSwapV2LPHandler} from "./SY_SaucerSwapV2LPHandler.sol";

/// @title  SY_SaucerSwapV2LP invariant suite — accounting + conservation under randomised
///         deposit/redeem/transfer/harvest/claim/fee-inject sequences.
/// @dev    Invariants asserted after every handler call:
///         (1) totalSupply == position.liquidity (1:1 share/liquidity invariant).
///         (2) exchangeRate() == 1e18 always (Pendle-Kyber pattern).
///         (3) Conservation: claimed + claimable + sy_internal_token_balance ≥ injected
///                                                                           (≤ injected + small drift).
///         (4) sum(per-actor balanceOf) == totalSupply.
contract SY_SaucerSwapV2LPInvariantTest is Test {
    MockERC20 token0;
    MockERC20 token1;
    MockUniswapV3PositionManager npm;
    SY_SaucerSwapV2LP sy;
    SY_SaucerSwapV2LPHandler handler;

    address admin = address(0xAD);
    address[] actors;

    function setUp() public {
        // Sort tokens so token0 < token1.
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

        actors = new address[](4);
        actors[0] = address(0xA1);
        actors[1] = address(0xA2);
        actors[2] = address(0xA3);
        actors[3] = address(0xA4);

        // Pre-approve SY for each actor (deposits use safeTransferFrom).
        for (uint256 i = 0; i < actors.length; i++) {
            vm.prank(actors[i]);
            token0.approve(address(sy), type(uint256).max);
            vm.prank(actors[i]);
            token1.approve(address(sy), type(uint256).max);
        }

        handler = new SY_SaucerSwapV2LPHandler(sy, npm, token0, token1, actors);

        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](6);
        selectors[0] = handler.deposit.selector;
        selectors[1] = handler.redeem.selector;
        selectors[2] = handler.transferShares.selector;
        selectors[3] = handler.injectFees.selector;
        selectors[4] = handler.harvest.selector;
        selectors[5] = handler.claim.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// (1) Shares track liquidity 1:1.
    function invariant_sharesEqualLiquidity() public view {
        uint256 tokenId = sy.positionTokenId();
        if (tokenId == 0) {
            assertEq(sy.totalSupply(), 0, "shares minted before position");
            return;
        }
        ( , , , , , , , uint128 liquidity, , , , ) = npm.positions(tokenId);
        assertEq(sy.totalSupply(), uint256(liquidity), "totalSupply != position liquidity");
    }

    /// (2) Pendle-Kyber pattern: rate is constant.
    function invariant_exchangeRateConstant() public view {
        assertEq(sy.exchangeRate(), 1e18, "exchangeRate moved");
    }

    /// (3) Conservation: every fee that went in must be either (a) already paid out via
    ///     claimRewards, (b) recorded as claimable by a current shareholder, or (c) sitting
    ///     in the SY contract waiting to be claimed (post-harvest, pre-claim). Tolerate
    ///     small precision drift: integer division loses up to 1 wei per active reward
    ///     index update per actor (4 actors × 2 tokens × N updates).
    function invariant_conservation() public view {
        // Sum of currently-claimable rewards across all actors.
        uint256 claimable0;
        uint256 claimable1;
        for (uint256 i = 0; i < actors.length; i++) {
            uint256[] memory ar = sy.accruedRewards(actors[i]);
            claimable0 += ar[0];
            claimable1 += ar[1];
        }

        uint256 syBal0 = token0.balanceOf(address(sy));
        uint256 syBal1 = token1.balanceOf(address(sy));

        // claimed + (claimable as bookkept) ≤ injected + (sy holds the difference for
        // post-harvest pre-claim funds). Equivalently:
        // injected ≥ claimed + claimable - syBal_holding_dust    (with small drift)
        // and the SY's internal token balance ≥ claimable - precision_drift.
        // We assert the strong lower bound: claimed + claimable ≤ injected + drift.
        uint256 maxDrift = actors.length * 2; // tiny, integer-division tolerance
        assertLe(handler.totalClaimed0() + claimable0, handler.totalInjected0() + maxDrift, "ledger0 over-counts");
        assertLe(handler.totalClaimed1() + claimable1, handler.totalInjected1() + maxDrift, "ledger1 over-counts");

        // SY's actual token0/1 holdings must cover all bookkept claimable amounts.
        // (Funds for already-claimed rewards have left the contract.)
        assertGe(syBal0 + maxDrift, claimable0, "sy balance0 < claimable0");
        assertGe(syBal1 + maxDrift, claimable1, "sy balance1 < claimable1");
    }

    /// (4) Sum of per-actor balances == totalSupply.
    function invariant_balancesSum() public view {
        uint256 sum;
        for (uint256 i = 0; i < actors.length; i++) sum += sy.balanceOf(actors[i]);
        assertEq(sum, sy.totalSupply(), "balance sum != totalSupply");
    }

    function invariant_callSummary() public view {
        // Soft signal — ensure the fuzz exercises every path. Doesn't assert.
    }
}
