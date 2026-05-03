// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {FissionMarketRewards} from "../../src/core/FissionMarketRewards.sol";
import {PrincipalToken} from "../../src/core/PrincipalToken.sol";
import {YieldToken} from "../../src/core/YieldToken.sol";
import {SY_SaucerSwapV2LP} from "../../src/sy/SY_SaucerSwapV2LP.sol";
import {MockUniswapV3PositionManager} from "../mocks/MockUniswapV3PositionManager.sol";
import {MockERC20} from "../mocks/MockSY.sol";
import {FissionMarketRewardsHandler} from "./FissionMarketRewardsHandler.sol";

/// @title  FissionMarketRewards invariant suite — random handler asserts:
///         (1) Solvency: market's SY balance ≥ PT.totalSupply().
///         (2) PT/YT supply parity pre-expiry (split/merge are the only mint/burn paths
///             pre-expiry; both move them in lockstep).
///         (3) Reward conservation: claimed + bookkept-claimable + market-internal
///             token balance ≥ market's share of injected fees, within a small drift.
///             We bound this from above (ledger doesn't over-count) and from below
///             (market always holds enough tokens to cover claimable).
contract FissionMarketRewardsInvariantTest is Test {
    MockERC20 token0;
    MockERC20 token1;
    MockUniswapV3PositionManager npm;
    SY_SaucerSwapV2LP sy;
    FissionMarketRewards market;
    PrincipalToken pt;
    YieldToken yt;
    FissionMarketRewardsHandler handler;

    address admin = address(0xAD);
    address treasury = address(0xBEEF);
    address[] actors;

    int256 constant SCALAR_ROOT = 75e18;
    int256 constant LN_FEE_ROOT = 0.0003e18;
    uint256 constant RESERVE_PCT = 80;
    int256 constant INITIAL_ANCHOR = 1.05e18;

    function setUp() public {
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

        token0.mint(address(this), 5_000_000e6);
        token1.mint(address(this), 5_000_000e6);
        token0.approve(address(sy), type(uint256).max);
        token1.approve(address(sy), type(uint256).max);
        sy.depositLiquidity(1_000_000e6, 1_000_000e6, 0, 0, address(this), 0);

        uint256 expiry_ = block.timestamp + 90 days;
        market = new FissionMarketRewards(
            address(sy), expiry_, SCALAR_ROOT, admin, treasury, 18, "fLP-V2", "fLP-V2"
        );
        pt = new PrincipalToken("fPT-V2", "fPT-V2", address(sy), expiry_, address(market), 18);
        yt = new YieldToken("fYT-V2", "fYT-V2", address(sy), expiry_, address(market), 18);
        market.setTokens(address(pt), address(yt));

        actors = new address[](3);
        actors[0] = address(0xA1);
        actors[1] = address(0xA2);
        actors[2] = address(0xA3);

        // Distribute SY to admin + actors.
        IERC20(address(sy)).transfer(admin, 200_000e6);
        for (uint256 i = 0; i < actors.length; i++) {
            IERC20(address(sy)).transfer(actors[i], 200_000e6);
        }

        // Admin splits + initializes.
        vm.startPrank(admin);
        IERC20(address(sy)).approve(address(market), type(uint256).max);
        IERC20(address(pt)).approve(address(market), type(uint256).max);
        market.split(100_000e6);
        market.initialize(100_000e6, 100_000e6, INITIAL_ANCHOR, LN_FEE_ROOT, RESERVE_PCT);
        vm.stopPrank();

        // Actors approve.
        for (uint256 i = 0; i < actors.length; i++) {
            vm.prank(actors[i]);
            IERC20(address(sy)).approve(address(market), type(uint256).max);
            vm.prank(actors[i]);
            IERC20(address(pt)).approve(address(market), type(uint256).max);
        }

        handler = new FissionMarketRewardsHandler(market, sy, npm, token0, token1, actors);

        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](6);
        selectors[0] = handler.split.selector;
        selectors[1] = handler.merge.selector;
        selectors[2] = handler.transferYT.selector;
        selectors[3] = handler.injectFees.selector;
        selectors[4] = handler.harvest.selector;
        selectors[5] = handler.claim.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// (1) Solvency — market always holds enough SY to redeem every PT 1:1.
    function invariant_solvency() public view {
        uint256 marketSY = IERC20(address(sy)).balanceOf(address(market));
        assertGe(marketSY, pt.totalSupply(), "solvency violated");
    }

    /// (2) PT/YT supplies stay paired pre-expiry.
    function invariant_ptYtSupplyParityPreExpiry() public view {
        if (block.timestamp >= market.expiry()) return;
        assertEq(pt.totalSupply(), yt.totalSupply(), "PT/YT diverged");
    }

    /// (3) Reward ledger upper bound: total tokens that have left the market (claimed) +
    ///     tokens still owed (bookkept claimable + market-held buffer for unsettled
    ///     accrual) cannot exceed what the market has actually received from SY harvests.
    ///     We assert via the market's actual token balance: claimed + held >= claimable
    ///     (market always covers claimable), and claimed + claimable <= harvested
    ///     (claimable to date plus paid out to date = the SY-distributed total).
    function invariant_rewardConservation() public view {
        uint256 claimable0;
        uint256 claimable1;
        for (uint256 i = 0; i < actors.length; i++) {
            (uint256 c0, uint256 c1) = market.previewRewards(actors[i]);
            claimable0 += c0;
            claimable1 += c1;
        }
        // Admin is also a YT holder (residual from setUp).
        (uint256 ac0, uint256 ac1) = market.previewRewards(admin);
        claimable0 += ac0;
        claimable1 += ac1;

        uint256 mBal0 = token0.balanceOf(address(market));
        uint256 mBal1 = token1.balanceOf(address(market));

        uint256 maxDrift = (actors.length + 1) * 4;

        // Market holds enough to cover everything bookkept claimable.
        assertGe(mBal0 + maxDrift, claimable0, "market insolvent on token0");
        assertGe(mBal1 + maxDrift, claimable1, "market insolvent on token1");

        // The market's claimed + still-claimable totals can never exceed the gross
        // amount the SY has paid out to the market (which itself is a fraction of
        // injected — the rest goes to other SY holders). We bound by the upper limit
        // of injected (Market's max possible share = total injected).
        assertLe(
            handler.totalClaimed0() + claimable0,
            handler.totalInjected0() + maxDrift,
            "ledger0 over-counts"
        );
        assertLe(
            handler.totalClaimed1() + claimable1,
            handler.totalInjected1() + maxDrift,
            "ledger1 over-counts"
        );
    }
}
