// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {FissionFactory} from "../../src/core/FissionFactory.sol";
import {StandardMarketDeployer} from "../../src/core/StandardMarketDeployer.sol";
import {RewardsMarketDeployer} from "../../src/core/RewardsMarketDeployer.sol";
import {FissionPeriphery} from "../../src/periphery/FissionPeriphery.sol";
import {FissionLens} from "../../src/periphery/FissionLens.sol";
import {FissionRewardsMarket} from "../../src/core/FissionRewardsMarket.sol";
import {SY_SaucerSwapV2LP} from "../../src/sy/SY_SaucerSwapV2LP.sol";
import {NetworkConfig} from "../../script/NetworkConfig.sol";

import {MockUniswapV3PositionManager} from "../mocks/MockUniswapV3PositionManager.sol";
import {MockERC20} from "../mocks/MockSY.sol";
import {HtsTestHelper} from "../utils/HtsTestHelper.sol";

/// @notice Non-broadcast dry-run of the rebuilt deploy ORDER + wiring that
///         script/Deploy.s.sol and script/MainnetDeploy.s.sol perform. Proves,
///         on a local EVM (HTS precompile mocked at 0x167):
///           1. each brain (Factory / Periphery / Lens) is deployable as
///              impl -> ERC1967Proxy -> initialize(...), and the proxy holds the
///              initialized state (impl ctor only _disableInitializers());
///           2. the bare implementations are locked (initialize reverts);
///           3. ActionRouter is NOT in the deploy graph (this file imports none);
///           4. after market-create, setPeriphery + registerMarket wire the
///              freeze-exempt periphery (MDS-2) and the post-deploy require()s
///              all hold;
///           5. PT is created WITH a freeze key (freeze-by-default rebuild).
///         NO vm.broadcast / no network. Pure logic validation.
contract DeployScriptsTest is Test {
    MockERC20 token0;
    MockERC20 token1;
    MockUniswapV3PositionManager npm;
    SY_SaucerSwapV2LP sy;

    address factoryAdmin = address(0xAD1);
    address marketAdmin = address(0xA4A);
    address marketTreasury = address(0x7);
    address peripheryOwner = address(0x0FF1CE);
    address upgradeAuthority = address(0xDEAD);

    uint256 constant SY_REVIEW_WINDOW = 0; // bootstrap (immediate) for the dry-run
    int256 constant SCALAR_ROOT = 75e18;

    function setUp() public {
        HtsTestHelper.installHtsPrecompile();

        MockERC20 a = new MockERC20("USDC", "USDC", 6);
        MockERC20 b = new MockERC20("WHBAR", "WHBAR", 6);
        if (address(a) < address(b)) (token0, token1) = (a, b);
        else (token0, token1) = (b, a);

        npm = new MockUniswapV3PositionManager();
        sy = new SY_SaucerSwapV2LP(
            "SY-V2LP", "SY-V2LP", address(token0), address(token1), 1500, -60, 60, address(npm), marketAdmin, 0
        );
        sy.initShareToken();

        token0.mint(address(this), 5_000_000e6);
        token1.mint(address(this), 5_000_000e6);
        token0.approve(address(sy), type(uint256).max);
        token1.approve(address(sy), type(uint256).max);
        sy.depositLiquidity(1_000_000e6, 1_000_000e6, 0, 0, address(this), 0);
    }

    /// @dev Mirrors the script deploy ORDER end-to-end.
    function test_DeployOrder_BrainProxies_Wiring_And_Asserts() public {
        // ── deployers ──
        StandardMarketDeployer standardDeployer = new StandardMarketDeployer();
        RewardsMarketDeployer rewardsDeployer = new RewardsMarketDeployer();

        // ── Brain 1: Factory (UUPS) ──
        FissionFactory factoryImpl = new FissionFactory();
        FissionFactory factory = FissionFactory(
            address(
                new ERC1967Proxy(
                    address(factoryImpl),
                    abi.encodeCall(
                        FissionFactory.initialize,
                        (
                            factoryAdmin,
                            marketAdmin,
                            marketTreasury,
                            standardDeployer,
                            rewardsDeployer,
                            SY_REVIEW_WINDOW
                        )
                    )
                )
            )
        );

        // ── Brain 2: Periphery (UUPS) ──
        FissionPeriphery peripheryImpl = new FissionPeriphery();
        FissionPeriphery periphery = FissionPeriphery(
            payable(
                address(
                    new ERC1967Proxy(
                        address(peripheryImpl),
                        abi.encodeCall(
                            FissionPeriphery.initialize,
                            (
                                address(0x1001), // WHBAR_CONTRACT (unused locally)
                                address(token1), // WHBAR token (mock)
                                address(token0), // USDC token (mock)
                                address(0x1004), // V2 router (unused locally)
                                address(npm), // V3 NPM
                                peripheryOwner,
                                upgradeAuthority,
                                new address[](0)
                            )
                        )
                    )
                )
            )
        );

        // ── Brain 3: Lens (UUPS) ──
        FissionLens lensImpl = new FissionLens();
        FissionLens lens =
            FissionLens(address(new ERC1967Proxy(address(lensImpl), abi.encodeCall(FissionLens.initialize, (upgradeAuthority)))));

        // ── brain read-backs (the script require()s) ──
        assertEq(factory.SY_REVIEW_WINDOW(), SY_REVIEW_WINDOW, "factory window");
        assertTrue(factory.hasRole(factory.DEFAULT_ADMIN_ROLE(), factoryAdmin), "factory admin");
        assertTrue(factory.hasRole(factory.UPGRADER_ROLE(), factoryAdmin), "factory upgrader");
        assertEq(periphery.owner(), peripheryOwner, "periphery owner");
        assertEq(periphery.upgradeAuthority(), upgradeAuthority, "periphery upgradeAuthority");
        assertEq(periphery.V3_NPM(), address(npm), "periphery npm");
        assertEq(lens.upgradeAuthority(), upgradeAuthority, "lens upgradeAuthority");

        // ── bare implementations are locked ──
        StandardMarketDeployer s2 = standardDeployer;
        RewardsMarketDeployer r2 = rewardsDeployer;
        vm.expectRevert(); // InvalidInitialization (impl ctor ran _disableInitializers)
        factoryImpl.initialize(factoryAdmin, marketAdmin, marketTreasury, s2, r2, SY_REVIEW_WINDOW);
        vm.expectRevert();
        lensImpl.initialize(upgradeAuthority);

        // ── create a market via the factory (factoryAdmin holds creator role) ──
        vm.startPrank(factoryAdmin);
        factory.proposeSY(address(sy));
        factory.confirmSY(address(sy)); // window == 0 -> immediate
        (, address marketAddr) =
            factory.createRewardsMarket(address(sy), block.timestamp + 90 days, SCALAR_ROOT, "DRYRUN");
        vm.stopPrank();

        FissionRewardsMarket market = FissionRewardsMarket(payable(marketAddr));

        // ── MDS-2: setPeriphery as the MARKET ADMIN, then register ──
        vm.prank(marketAdmin);
        market.setPeriphery(address(periphery));
        vm.prank(peripheryOwner);
        periphery.registerMarket(marketAddr);

        // ── wiring asserts (the script require()s) ──
        assertEq(market.periphery(), address(periphery), "market.periphery wiring");
        assertTrue(periphery.marketRegistered(marketAddr), "periphery registered");

        // ── PT created WITH a freeze key (freeze-by-default rebuild) ──
        address pt = market.pt();
        assertTrue(pt != address(0), "PT created");
        // The market (the freeze-key holder) created PT with withFreezeKey=true.
        // MockHederaTokenService records the freeze-key holder it was created
        // with; assert it is non-zero and equals the market. The authoritative
        // on-chain check is Mirror Node getTokenInfo (see runbook).
        address ptFreezeKey = IMockHts(address(0x167)).freezeKey(pt);
        assertTrue(ptFreezeKey != address(0), "PT must have a freeze key");
        assertEq(ptFreezeKey, marketAddr, "PT freeze key must be the market");

        // Sanity: YT is also freeze-keyed; LP is NOT (it is freely transferable).
        assertTrue(IMockHts(address(0x167)).freezeKey(market.yt()) != address(0), "YT freeze key");
        assertEq(IMockHts(address(0x167)).freezeKey(market.lp()), address(0), "LP must have no freeze key");
    }

    function test_NetworkConfig_Mainnet_Pinned() public pure {
        NetworkConfig.Config memory c = NetworkConfig.get(NetworkConfig.HEDERA_MAINNET);
        assertTrue(c.verified, "mainnet must be verified");
        assertEq(c.usdc, 0x000000000000000000000000000000000006f89a, "mainnet USDC");
        assertEq(c.v3Npm, 0x00000000000000000000000000000000003DDbb9, "mainnet NPM");
        assertEq(c.whbarToken, 0x0000000000000000000000000000000000163B5a, "mainnet WHBAR token");
        assertEq(c.whbarContract, 0x0000000000000000000000000000000000163B59, "mainnet WHBAR contract");
        assertEq(c.v2Router, 0x00000000000000000000000000000000003c437A, "mainnet V2 router");
    }

    function test_NetworkConfig_Testnet_Unverified() public pure {
        NetworkConfig.Config memory c = NetworkConfig.get(NetworkConfig.HEDERA_TESTNET);
        // Testnet addresses are research placeholders; verified MUST stay false
        // until on-chain-confirmed so the deploy scripts hard-gate broadcasts.
        assertTrue(!c.verified, "testnet must be unverified (TODO addresses)");
        assertTrue(c.v2Router != address(0), "testnet router placeholder set");
        assertTrue(c.usdc != address(0), "testnet usdc placeholder set");
    }

    function test_NetworkConfig_Unsupported_Reverts() public {
        NetworkConfigHarness h = new NetworkConfigHarness();
        vm.expectRevert(bytes("NetworkConfig: unsupported chainId"));
        h.get(1);
    }
}

/// @dev External wrapper so vm.expectRevert can catch the library revert (an
///      internal lib call is inlined at the same call depth as the cheatcode).
contract NetworkConfigHarness {
    function get(uint256 chainId) external pure returns (NetworkConfig.Config memory) {
        return NetworkConfig.get(chainId);
    }
}

/// @dev Test-only view into the mock HTS at 0x167 (freeze-key read-back).
interface IMockHts {
    function freezeKey(address token) external view returns (address);
}
