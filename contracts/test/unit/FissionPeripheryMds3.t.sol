// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {FissionPeriphery} from "../../src/periphery/FissionPeriphery.sol";
import {FissionMarket} from "../../src/core/FissionMarket.sol";
import {FissionRewardsMarket} from "../../src/core/FissionRewardsMarket.sol";
import {SY_SaucerSwapV2LP} from "../../src/sy/SY_SaucerSwapV2LP.sol";
import {MockUniswapV3PositionManager} from "../mocks/MockUniswapV3PositionManager.sol";
import {MockERC20} from "../mocks/MockSY.sol";
import {HtsTestHelper} from "../utils/HtsTestHelper.sol";

/// @notice MDS-3: the periphery's operator sell paths (`sellPtForSy` /
///         `sellYtForSy`) call the rewards-market-only selectors
///         `swapExactPtForSyFor` / `swapExactYtForSyFor`. A STANDARD
///         `FissionMarket` lacks those, so the periphery must (a) classify the
///         market at registration and (b) revert with a clear
///         `OperatorSellUnsupported` error rather than a raw selector miss.
contract FissionPeripheryMds3Test is Test {
    MockERC20 token0;
    MockERC20 token1;
    MockUniswapV3PositionManager npm;
    SY_SaucerSwapV2LP sy;
    address syShare;

    FissionRewardsMarket rewardsMarket;
    FissionMarket standardMarket;
    FissionPeriphery periphery;

    address admin = address(0xAD);
    address treasury = address(0xBEEF);
    address owner_ = address(0x0FF1CE);
    address upgrader = address(0xDEAD);
    address user = address(0xA11CE);

    uint256 expiry;
    int256 constant SCALAR_ROOT = 75e18;

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

        expiry = block.timestamp + 90 days;

        rewardsMarket =
            new FissionRewardsMarket(address(sy), expiry, SCALAR_ROOT, admin, treasury, 18, address(0));
        rewardsMarket.setTokens("rPT", "rPT", "rYT", "rYT", "rLP", "rLP");

        standardMarket = new FissionMarket(address(sy), expiry, SCALAR_ROOT, admin, treasury, 18, address(0));
        standardMarket.setTokens("sPT", "sPT", "sYT", "sYT", "sLP", "sLP");

        // Deploy periphery behind a proxy; USDC/WHBAR are the mock underlyings so
        // registration's force-approvals resolve against real mock tokens.
        address[] memory none = new address[](0);
        FissionPeriphery impl = new FissionPeriphery();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(impl),
            abi.encodeCall(
                FissionPeriphery.initialize,
                (
                    address(0x1001), // WHBAR_CONTRACT (unused here)
                    address(token1), // WHBAR token (mock)
                    address(token0), // USDC token (mock)
                    address(0x1004), // V2 router (unused)
                    address(npm), // V3 NPM
                    owner_,
                    upgrader,
                    none
                )
            )
        );
        periphery = FissionPeriphery(payable(address(proxy)));

        vm.startPrank(owner_);
        periphery.registerMarket(address(rewardsMarket));
        periphery.registerMarket(address(standardMarket));
        vm.stopPrank();
    }

    /// @dev The registration-time probe correctly classifies each market type.
    function test_mds3_marketTypeProbeClassifiesCorrectly() public view {
        assertTrue(periphery.isRewardsMarket(address(rewardsMarket)), "rewards market flagged");
        assertFalse(periphery.isRewardsMarket(address(standardMarket)), "standard market NOT flagged");
    }

    /// @dev sellPtForSy on a STANDARD market reverts with the explicit MDS-3 error
    ///      instead of a raw missing-selector revert.
    function test_mds3_sellPtForSy_revertsOnStandardMarket() public {
        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(FissionPeriphery.OperatorSellUnsupported.selector, address(standardMarket))
        );
        periphery.sellPtForSy(address(standardMarket), 1_000e6, 1, user, 0);
    }

    /// @dev sellYtForSy on a STANDARD market likewise reverts cleanly.
    function test_mds3_sellYtForSy_revertsOnStandardMarket() public {
        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(FissionPeriphery.OperatorSellUnsupported.selector, address(standardMarket))
        );
        periphery.sellYtForSy(address(standardMarket), 1_000e6, 1, user, 0);
    }

    /// @dev On a REWARDS market the MDS-3 guard does NOT trip — the call proceeds
    ///      past the guard into the market (and fails later only for an unrelated
    ///      reason, never `OperatorSellUnsupported`).
    function test_mds3_rewardsMarketPassesGuard() public {
        // Caller has not opted the periphery in as operator, so the market itself
        // reverts NotAuthorized — proving we got PAST the periphery's MDS-3 guard.
        vm.prank(user);
        vm.expectRevert(FissionRewardsMarket.NotAuthorized.selector);
        periphery.sellPtForSy(address(rewardsMarket), 1_000e6, 1, user, 0);
    }
}
