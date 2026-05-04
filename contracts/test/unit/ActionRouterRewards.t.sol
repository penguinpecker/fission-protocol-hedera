// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ActionRouter} from "../../src/periphery/ActionRouter.sol";
import {FissionMarketRewards} from "../../src/core/FissionMarketRewards.sol";
import {PrincipalToken} from "../../src/core/PrincipalToken.sol";
import {YieldToken} from "../../src/core/YieldToken.sol";
import {SY_SaucerSwapV2LP} from "../../src/sy/SY_SaucerSwapV2LP.sol";
import {MockUniswapV3PositionManager} from "../mocks/MockUniswapV3PositionManager.sol";
import {MockERC20} from "../mocks/MockSY.sol";

/// @notice Behavioral check that ActionRouter parameterized on IFissionMarketCommon
///         actually drives FissionMarketRewards end-to-end (not just FissionMarket).
///         The router's interface refactor would be a no-op without proof that
///         storage layout, callback wiring, and reward bookkeeping survive a real
///         router-driven trade against the rewards-market kind.
contract ActionRouterRewardsTest is Test {
    MockERC20 token0;
    MockERC20 token1;
    MockUniswapV3PositionManager npm;
    SY_SaucerSwapV2LP sy;
    FissionMarketRewards market;
    PrincipalToken pt;
    YieldToken yt;
    ActionRouter router;

    address admin = address(0xAD);
    address treasury = address(0xBEEF);
    address alice = address(0xA11CE);

    uint256 expiry;
    int256 constant SCALAR_ROOT = 75e18;
    int256 constant LN_FEE_ROOT = 0.0003e18;
    uint256 constant RESERVE_PCT = 80;
    int256 constant INITIAL_ANCHOR = 1.05e18;

    function setUp() public {
        // Deterministic token0 < token1 sort for Uniswap-style ordering.
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

        // Bootstrap: this contract seeds the SY with 2_000_000 shares.
        token0.mint(address(this), 5_000_000e6);
        token1.mint(address(this), 5_000_000e6);
        token0.approve(address(sy), type(uint256).max);
        token1.approve(address(sy), type(uint256).max);
        sy.depositLiquidity(1_000_000e6, 1_000_000e6, 0, 0, address(this), 0);

        expiry = block.timestamp + 90 days;

        market = new FissionMarketRewards(
            address(sy), expiry, SCALAR_ROOT, admin, treasury, 18, "Fission LP-V2", "fLP-V2"
        );
        pt = new PrincipalToken("fPT-V2", "fPT-V2", address(sy), expiry, address(market), 18);
        yt = new YieldToken("fYT-V2", "fYT-V2", address(sy), expiry, address(market), 18);
        market.setTokens(address(pt), address(yt));

        // Admin gets SY to bootstrap the pool.
        IERC20(address(sy)).transfer(admin, 200_000e6);
        // Alice gets SY for the router-driven flow.
        IERC20(address(sy)).transfer(alice, 200_000e6);

        vm.startPrank(admin);
        IERC20(address(sy)).approve(address(market), type(uint256).max);
        IERC20(address(pt)).approve(address(market), type(uint256).max);
        market.split(100_000e6);
        market.initialize(100_000e6, 100_000e6, INITIAL_ANCHOR, LN_FEE_ROOT, RESERVE_PCT);
        vm.stopPrank();

        router = new ActionRouter();
    }

    /// @notice Router-driven buyYT against a rewards market. The interface refactor
    ///         is dead unless this path actually settles: split SY → PT+YT, sell PT
    ///         in the rewards-market AMM, return YT + SY refund to the user.
    function test_buyYT_routesThroughRewardsMarket() public {
        uint256 syBudget = 1_000e6;

        vm.startPrank(alice);
        IERC20(address(sy)).approve(address(router), syBudget);
        (uint256 ytOut, uint256 syRefund) = router.buyYT(
            market, // implicit conversion to IFissionMarketCommon
            syBudget,
            0, // accept any SY refund > 0
            alice,
            block.timestamp + 60
        );
        vm.stopPrank();

        // Alice receives full YT exposure for `syBudget` SY split.
        assertEq(ytOut, syBudget, "ytOut == syBudget");
        assertEq(yt.balanceOf(alice), syBudget, "alice YT");

        // PT was sold in the AMM — alice received some SY back.
        assertGt(syRefund, 0, "non-zero SY refund");
        assertLt(syRefund, syBudget, "refund < budget (PT sells below par pre-expiry)");
        assertEq(IERC20(address(sy)).balanceOf(alice), 200_000e6 - syBudget + syRefund, "alice SY");

        // Router holds nothing.
        assertEq(IERC20(address(sy)).balanceOf(address(router)), 0, "router SY");
        assertEq(pt.balanceOf(address(router)), 0, "router PT");
        assertEq(yt.balanceOf(address(router)), 0, "router YT");
    }

    /// @notice Router-driven swapExactPtForSy against a rewards market. Alice splits
    ///         directly first (router's depositAndSplit can't help — V3 LP SY rejects
    ///         single-token deposits), then sells PT through the router.
    function test_swapExactPtForSy_routesThroughRewardsMarket() public {
        // Alice splits 5_000 SY → 5_000 PT + 5_000 YT directly.
        vm.startPrank(alice);
        IERC20(address(sy)).approve(address(market), 5_000e6);
        market.split(5_000e6);

        // Now sell 1_000 PT via the router.
        uint256 syBefore = IERC20(address(sy)).balanceOf(alice);
        IERC20(address(pt)).approve(address(router), 1_000e6);
        uint256 syOut = router.swapExactPtForSy(
            market, // implicit conversion to IFissionMarketCommon
            1_000e6,
            0,
            alice,
            block.timestamp + 60
        );
        vm.stopPrank();

        assertGt(syOut, 0, "non-zero SY out");
        assertLt(syOut, 1_000e6, "PT sells below par pre-expiry");
        assertEq(
            IERC20(address(sy)).balanceOf(alice),
            syBefore + syOut,
            "alice SY credited"
        );
        assertEq(pt.balanceOf(alice), 4_000e6, "alice PT decreased by 1k");
    }
}
