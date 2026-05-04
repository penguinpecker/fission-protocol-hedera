// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {FissionMarket} from "../../src/core/FissionMarket.sol";
import {YieldToken} from "../../src/core/YieldToken.sol";
import {MockSY, MockERC20} from "../mocks/MockSY.sol";
import {FissionMarketHandler} from "./FissionMarketHandler.sol";
import {HtsTestHelper} from "../utils/HtsTestHelper.sol";

/// @title  FissionMarket invariant suite — solvency + accounting consistency.
/// @notice Drives the market through randomised handler sequences; asserts the core
///         invariants hold at every step.
/// @dev    Per `foundry.toml` default profile: 256 invariant runs × 500 depth.
///         CI profile bumps to 1024 × 500. Run `FOUNDRY_PROFILE=deep forge test`
///         pre-audit for 5000 × 1000.
contract FissionMarketInvariantTest is Test {
    MockERC20 underlying;
    MockSY sy;
    FissionMarket market;
    address pt;
    address yt;
    FissionMarketHandler handler;

    address admin = address(0xAD);
    address treasury = address(0xBEEF);
    address[] actors;

    function setUp() public {
        HtsTestHelper.installHtsPrecompile();

        actors = new address[](3);
        actors[0] = address(0xA1);
        actors[1] = address(0xA2);
        actors[2] = address(0xA3);

        underlying = new MockERC20("USD", "USD", 18);
        sy = new MockSY(address(underlying), 18);

        market = new FissionMarket(
            address(sy), block.timestamp + 90 days, 75e18, admin, treasury, 18, "fLP-0", "fLP-0"
        );
        market.setTokens("fPT-0", "fPT-0", "fYT-0", "fYT-0");
        pt = market.pt();
        yt = market.yt();

        // Mint SY to this contract, split half, then admin initializes pool.
        sy.mint(address(this), 1_000_000e6);
        IERC20(address(sy)).approve(address(market), type(uint256).max);
        market.split(500_000e6);

        IERC20(address(sy)).transfer(admin, 200_000e6);
        IERC20(pt).transfer(admin, 200_000e6);

        vm.startPrank(admin);
        IERC20(address(sy)).approve(address(market), 100_000e6);
        IERC20(pt).approve(address(market), 100_000e6);
        market.initialize(100_000e6, 100_000e6, 1.05e18, 0.0003e18, 80);
        vm.stopPrank();

        // Fund actors with SY. YT is HTS-frozen — only the Market can move it. Actors
        // get YT (and PT) by calling market.split themselves below.
        for (uint256 i = 0; i < actors.length; i++) {
            sy.mint(actors[i], 50_000e6);
        }
        for (uint256 i = 0; i < actors.length; i++) {
            vm.startPrank(actors[i]);
            IERC20(address(sy)).approve(address(market), type(uint256).max);
            market.split(5_000e6);
            vm.stopPrank();
        }

        handler = new FissionMarketHandler(market, actors);

        // Restrict fuzz to handler operations only (don't fuzz the market directly).
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](6);
        selectors[0] = handler.split.selector;
        selectors[1] = handler.merge.selector;
        selectors[2] = handler.swapPtForSy.selector;
        selectors[3] = handler.swapSyForPt.selector;
        selectors[4] = handler.advanceRate.selector;
        selectors[5] = handler.claimYield.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// @notice Solvency — the asset value of SY held by the market must always cover
    ///         the PT principal claim plus all unclaimed yield owed to actors.
    function invariant_solvency() public view {
        uint256 marketSy = IERC20(address(sy)).balanceOf(address(market));
        uint256 ptSupply = IERC20(pt).totalSupply();
        uint256 R = sy.exchangeRate();

        // Asset value of market's SY holdings.
        uint256 assetValue = (marketSy * R) / 1e18;

        // PT redemption liability — each PT redeems for 1 asset.
        uint256 ptLiability = ptSupply;

        // Yield owed across all actors (the handler updates indexes naturally via
        // operations, so userOwed reflects realised yield; remaining accrued-but-
        // not-yet-realised yield only kicks in at next interaction).
        uint256 yieldLiabilitySY;
        for (uint256 i = 0; i < actors.length; i++) {
            yieldLiabilitySY += market.userOwed(actors[i]);
        }
        uint256 yieldLiabilityAsset = (yieldLiabilitySY * R) / 1e18;

        assertGe(assetValue + 1, ptLiability + yieldLiabilityAsset, "solvency violated");
    }

    /// @notice The market's PT balance equals the pool's `totalPt` accounting figure.
    function invariant_poolPtMatchesBalance() public view {
        assertEq(IERC20(pt).balanceOf(address(market)), market.totalPt(), "totalPt drift");
    }

    /// @notice PT and YT supplies move together when minted/burned via split/merge.
    ///         (Swaps move only PT in/out of pool; supplies don't change.)
    ///         Since redeemAfterExpiry can burn PT alone, this only holds pre-expiry.
    function invariant_ptYtSupplyParityPreExpiry() public view {
        if (block.timestamp >= market.expiry()) return;
        assertEq(IERC20(pt).totalSupply(), IERC20(yt).totalSupply(), "PT/YT supply diverged pre-expiry");
    }

    /// @notice Handler call summary — useful to see which paths got exercised.
    function invariant_callsExercisedAll() public view {
        // Not a hard invariant; just emit a signal in the trace if any path stayed cold.
        // We don't assert here because some runs may legitimately skip a path due to bounds.
    }
}
