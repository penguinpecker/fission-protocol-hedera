// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {FissionLens} from "../../src/periphery/FissionLens.sol";
import {FissionPeriphery} from "../../src/periphery/FissionPeriphery.sol";
import {FissionFactory} from "../../src/core/FissionFactory.sol";
import {StandardMarketDeployer} from "../../src/core/StandardMarketDeployer.sol";
import {RewardsMarketDeployer} from "../../src/core/RewardsMarketDeployer.sol";
import {HtsTestHelper} from "../utils/HtsTestHelper.sol";
import {FactoryTestHelper} from "../utils/FactoryTestHelper.sol";

/// ───────────────────── v2 implementations for upgrade tests ─────────────────────
/// Each v2 adds exactly one extra view function and changes nothing about storage
/// layout, so we can prove (a) the upgrade authority gate, (b) state preservation,
/// and (c) the new function becomes callable post-upgrade.

contract FissionLensV2 is FissionLens {
    function version() external pure returns (string memory) {
        return "v2";
    }
}

contract FissionPeripheryV2 is FissionPeriphery {
    function version() external pure returns (string memory) {
        return "v2";
    }
}

contract FissionFactoryV2 is FissionFactory {
    function version() external pure returns (string memory) {
        return "v2";
    }
}

/// @notice Minimal stand-in for FissionRewardsMarket's Ed25519-safe read surface,
///         used to exercise FissionLens.previewPtBalance / previewPendingPtAmm
///         (and YT mirrors) without spinning up the full market + HTS harness.
contract MockRewardsMarketReads {
    mapping(address => uint256) public ptBalanceOf;
    mapping(address => uint256) public ytBalanceOf;
    uint256 public ptAmmRewardIndex;
    uint256 public ytAmmRewardIndex;
    mapping(address => uint256) public userPtAmmIndex;
    mapping(address => uint256) public userYtAmmIndex;
    mapping(address => uint256) public userAccruedPtAmm;
    mapping(address => uint256) public userAccruedYtAmm;

    function setPt(address u, uint256 bal, uint256 idx, uint256 accrued) external {
        ptBalanceOf[u] = bal;
        userPtAmmIndex[u] = idx;
        userAccruedPtAmm[u] = accrued;
    }

    function setYt(address u, uint256 bal, uint256 idx, uint256 accrued) external {
        ytBalanceOf[u] = bal;
        userYtAmmIndex[u] = idx;
        userAccruedYtAmm[u] = accrued;
    }

    function setGlobalIndices(uint256 ptIdx, uint256 ytIdx) external {
        ptAmmRewardIndex = ptIdx;
        ytAmmRewardIndex = ytIdx;
    }
}

contract FissionUpgradeableTest is Test {
    address admin = address(0xA11CE);
    address upgrader = address(0xDEAD);
    address hotOps = address(0x0FF1CE);
    address attacker = address(0xBAD);

    // ───────────────────── FissionLens ─────────────────────

    function _deployLens(address authority) internal returns (FissionLens) {
        FissionLens impl = new FissionLens();
        ERC1967Proxy proxy =
            new ERC1967Proxy(address(impl), abi.encodeCall(FissionLens.initialize, (authority)));
        return FissionLens(address(proxy));
    }

    function test_lens_proxyInitializes() public {
        FissionLens lens = _deployLens(upgrader);
        assertEq(lens.upgradeAuthority(), upgrader);
    }

    function test_lens_initializeRevertsTwice() public {
        FissionLens lens = _deployLens(upgrader);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        lens.initialize(attacker);
    }

    function test_lens_bareImplCannotInitialize() public {
        FissionLens impl = new FissionLens();
        // _disableInitializers() in the constructor locks the bare implementation.
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(attacker);
    }

    function test_lens_unauthorizedUpgradeReverts() public {
        FissionLens lens = _deployLens(upgrader);
        FissionLensV2 v2 = new FissionLensV2();
        vm.prank(attacker);
        vm.expectRevert(FissionLens.NotUpgradeAuthority.selector);
        lens.upgradeToAndCall(address(v2), "");
    }

    function test_lens_authorizedUpgradePreservesStateAndAddsFn() public {
        FissionLens lens = _deployLens(upgrader);
        assertEq(lens.upgradeAuthority(), upgrader);

        FissionLensV2 v2 = new FissionLensV2();
        vm.prank(upgrader);
        lens.upgradeToAndCall(address(v2), "");

        // Old state preserved through the upgrade.
        assertEq(lens.upgradeAuthority(), upgrader);
        // New function callable through the same proxy address.
        assertEq(FissionLensV2(address(lens)).version(), "v2");
    }

    function test_lens_setUpgradeAuthority() public {
        FissionLens lens = _deployLens(upgrader);
        vm.prank(attacker);
        vm.expectRevert(FissionLens.NotUpgradeAuthority.selector);
        lens.setUpgradeAuthority(attacker);

        vm.prank(upgrader);
        lens.setUpgradeAuthority(admin);
        assertEq(lens.upgradeAuthority(), admin);
    }

    function test_lens_edPreviews() public {
        FissionLens lens = _deployLens(upgrader);
        MockRewardsMarketReads m = new MockRewardsMarketReads();
        address user = address(0x1234);

        // bal=1000, userIdx=2e18, accrued=5; global=5e18 → unsettled=1000*(5-2)=3000
        m.setPt(user, 1000, 2e18, 5);
        m.setYt(user, 2000, 1e18, 7);
        m.setGlobalIndices(5e18, 4e18);

        assertEq(lens.previewPtBalance(address(m), user), 1000);
        assertEq(lens.previewYtBalance(address(m), user), 2000);
        // PT: 5 + 1000*(5e18-2e18)/1e18 = 5 + 3000 = 3005
        assertEq(lens.previewPendingPtAmm(address(m), user), 3005);
        // YT: 7 + 2000*(4e18-1e18)/1e18 = 7 + 6000 = 6007
        assertEq(lens.previewPendingYtAmm(address(m), user), 6007);
    }

    function test_lens_edPreviews_noUnsettledWhenIndexEqual() public {
        FissionLens lens = _deployLens(upgrader);
        MockRewardsMarketReads m = new MockRewardsMarketReads();
        address user = address(0x1234);
        m.setPt(user, 1000, 5e18, 9);
        m.setGlobalIndices(5e18, 0);
        // global == user index → only the already-accrued amount.
        assertEq(lens.previewPendingPtAmm(address(m), user), 9);
    }

    // ───────────────────── FissionPeriphery ─────────────────────

    address constant WHBAR_CONTRACT = address(0x1001);
    address constant WHBAR = address(0x1002);
    address constant USDC = address(0x1003);
    address constant V2_ROUTER = address(0x1004);
    address constant V3_NPM = address(0x1005);

    function _deployPeriphery(address owner_, address authority) internal returns (FissionPeriphery) {
        address[] memory none = new address[](0);
        FissionPeriphery impl = new FissionPeriphery();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(impl),
            abi.encodeCall(
                FissionPeriphery.initialize,
                (WHBAR_CONTRACT, WHBAR, USDC, V2_ROUTER, V3_NPM, owner_, authority, none)
            )
        );
        return FissionPeriphery(payable(address(proxy)));
    }

    function test_periphery_proxyInitializes() public {
        HtsTestHelper.installHtsPrecompile();
        FissionPeriphery p = _deployPeriphery(hotOps, upgrader);
        // Former immutables now live in proxy storage.
        assertEq(p.WHBAR_CONTRACT(), WHBAR_CONTRACT);
        assertEq(p.WHBAR(), WHBAR);
        assertEq(p.USDC(), USDC);
        assertEq(p.V2_ROUTER(), V2_ROUTER);
        assertEq(p.V3_NPM(), V3_NPM);
        assertEq(p.owner(), hotOps);
        assertEq(p.upgradeAuthority(), upgrader);
        // Defaults moved from inline initializers to initialize().
        assertEq(p.maxTradeBps(), 500);
        assertEq(p.v3NpmFeeBudget(), 5 * 1e8);
        // Protected tokens marked.
        assertTrue(p.isProtectedToken(USDC));
        assertTrue(p.isProtectedToken(WHBAR));
    }

    function test_periphery_initializeRevertsTwice() public {
        HtsTestHelper.installHtsPrecompile();
        FissionPeriphery p = _deployPeriphery(hotOps, upgrader);
        address[] memory none = new address[](0);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        p.initialize(WHBAR_CONTRACT, WHBAR, USDC, V2_ROUTER, V3_NPM, hotOps, upgrader, none);
    }

    function test_periphery_bareImplCannotInitialize() public {
        HtsTestHelper.installHtsPrecompile();
        FissionPeriphery impl = new FissionPeriphery();
        address[] memory none = new address[](0);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(WHBAR_CONTRACT, WHBAR, USDC, V2_ROUTER, V3_NPM, hotOps, upgrader, none);
    }

    function test_periphery_initializeRevertsZero() public {
        HtsTestHelper.installHtsPrecompile();
        address[] memory none = new address[](0);
        FissionPeriphery impl = new FissionPeriphery();
        // owner_ == 0 → ZeroAddress (bubbles through the proxy constructor).
        vm.expectRevert(FissionPeriphery.ZeroAddress.selector);
        new ERC1967Proxy(
            address(impl),
            abi.encodeCall(
                FissionPeriphery.initialize,
                (WHBAR_CONTRACT, WHBAR, USDC, V2_ROUTER, V3_NPM, address(0), upgrader, none)
            )
        );
        // upgradeAuthority_ == 0 → ZeroAddress.
        vm.expectRevert(FissionPeriphery.ZeroAddress.selector);
        new ERC1967Proxy(
            address(impl),
            abi.encodeCall(
                FissionPeriphery.initialize,
                (WHBAR_CONTRACT, WHBAR, USDC, V2_ROUTER, V3_NPM, hotOps, address(0), none)
            )
        );
    }

    function test_periphery_unauthorizedUpgradeReverts() public {
        HtsTestHelper.installHtsPrecompile();
        FissionPeriphery p = _deployPeriphery(hotOps, upgrader);
        FissionPeripheryV2 v2 = new FissionPeripheryV2();
        // Even the hot ops owner cannot upgrade — only the upgrade authority can.
        vm.prank(hotOps);
        vm.expectRevert(FissionPeriphery.NotUpgradeAuthority.selector);
        p.upgradeToAndCall(address(v2), "");

        vm.prank(attacker);
        vm.expectRevert(FissionPeriphery.NotUpgradeAuthority.selector);
        p.upgradeToAndCall(address(v2), "");
    }

    function test_periphery_authorizedUpgradePreservesStateAndAddsFn() public {
        HtsTestHelper.installHtsPrecompile();
        FissionPeriphery p = _deployPeriphery(hotOps, upgrader);

        // Mutate some state before upgrade so we can prove preservation.
        vm.prank(hotOps);
        p.setMaxTradeBps(750);
        assertEq(p.maxTradeBps(), 750);

        FissionPeripheryV2 v2 = new FissionPeripheryV2();
        vm.prank(upgrader);
        p.upgradeToAndCall(address(v2), "");

        // State preserved.
        assertEq(p.maxTradeBps(), 750);
        assertEq(p.owner(), hotOps);
        assertEq(p.upgradeAuthority(), upgrader);
        assertEq(p.WHBAR_CONTRACT(), WHBAR_CONTRACT);
        // New function callable.
        assertEq(FissionPeripheryV2(payable(address(p))).version(), "v2");
    }

    function test_periphery_existingBehaviorThroughProxy() public {
        HtsTestHelper.installHtsPrecompile();
        FissionPeriphery p = _deployPeriphery(hotOps, upgrader);

        // owner-gated config setters work through the proxy.
        vm.prank(hotOps);
        p.setV3NpmFeeBudget(7 * 1e8);
        assertEq(p.v3NpmFeeBudget(), 7 * 1e8);

        // non-owner blocked.
        vm.prank(attacker);
        vm.expectRevert(FissionPeriphery.NotOwner.selector);
        p.setMaxTradeBps(100);

        // two-step ownership transfer works through the proxy.
        vm.prank(hotOps);
        p.transferOwnership(admin);
        vm.prank(admin);
        p.acceptOwnership();
        assertEq(p.owner(), admin);
    }

    // ───────────────────── FissionFactory ─────────────────────

    bytes32 constant DEFAULT_ADMIN_ROLE = 0x00;

    function test_factory_proxyInitializes() public {
        FissionFactory f = FactoryTestHelper.deploy(admin, address(0xBA), address(0xBE));
        assertTrue(f.hasRole(DEFAULT_ADMIN_ROLE, admin));
        assertTrue(f.hasRole(f.SY_REVIEWER_ROLE(), admin));
        assertTrue(f.hasRole(f.MARKET_CREATOR_ROLE(), admin));
        assertEq(f.marketAdmin(), address(0xBA));
        assertEq(f.marketTreasury(), address(0xBE));
        assertEq(f.SY_REVIEW_WINDOW(), 7 days);
    }

    function test_factory_initializeRevertsTwice() public {
        FissionFactory f = FactoryTestHelper.deploy(admin, address(0xBA), address(0xBE));
        StandardMarketDeployer sd = new StandardMarketDeployer();
        RewardsMarketDeployer rd = new RewardsMarketDeployer();
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        f.initialize(attacker, address(0xBA), address(0xBE), sd, rd, 7 days);
    }

    function test_factory_bareImplCannotInitialize() public {
        FissionFactory impl = new FissionFactory();
        StandardMarketDeployer sd = new StandardMarketDeployer();
        RewardsMarketDeployer rd = new RewardsMarketDeployer();
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(admin, address(0xBA), address(0xBE), sd, rd, 7 days);
    }

    function test_factory_unauthorizedUpgradeReverts() public {
        FissionFactory f = FactoryTestHelper.deploy(admin, address(0xBA), address(0xBE));
        FissionFactoryV2 v2 = new FissionFactoryV2();
        bytes32 upgraderRole = f.UPGRADER_ROLE();
        // UUPS-1: the upgrade gate is now UPGRADER_ROLE, not DEFAULT_ADMIN_ROLE.
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, attacker, upgraderRole
            )
        );
        f.upgradeToAndCall(address(v2), "");
    }

    // ───────────────────── FissionFactory: UUPS-1 governance hardening ────────

    /// @dev UUPS-1(a): the DEFAULT_ADMIN_ROLE can never be renounced to nobody —
    ///      doing so would permanently brick governance + upgrade reassignment.
    function test_factory_cannotRenounceAdminRole() public {
        FissionFactory f = FactoryTestHelper.deploy(admin, address(0xBA), address(0xBE));
        vm.prank(admin);
        vm.expectRevert(FissionFactory.CannotRenounceAdmin.selector);
        f.renounceRole(DEFAULT_ADMIN_ROLE, admin);
        // Admin retains the role.
        assertTrue(f.hasRole(DEFAULT_ADMIN_ROLE, admin));
    }

    /// @dev UUPS-1(a): non-admin roles can still be renounced normally.
    function test_factory_canRenounceNonAdminRole() public {
        FissionFactory f = FactoryTestHelper.deploy(admin, address(0xBA), address(0xBE));
        bytes32 reviewerRole = f.SY_REVIEWER_ROLE();
        vm.prank(admin);
        f.renounceRole(reviewerRole, admin);
        assertFalse(f.hasRole(reviewerRole, admin));
    }

    /// @dev UUPS-1(b): upgrade authority lives in a dedicated UPGRADER_ROLE,
    ///      separate from DEFAULT_ADMIN_ROLE. A holder of admin-but-not-upgrader
    ///      cannot upgrade; a holder of upgrader-but-not-admin can.
    function test_factory_upgraderRoleDistinctFromAdmin() public {
        FissionFactory f = FactoryTestHelper.deploy(admin, address(0xBA), address(0xBE));
        bytes32 upgraderRole = f.UPGRADER_ROLE();

        // Decouple: grant admin role to a new pure-admin, then revoke UPGRADER
        // from it so it is admin-only; grant UPGRADER to a separate upgrader.
        address pureAdmin = address(0xA0);
        vm.startPrank(admin);
        f.grantRole(DEFAULT_ADMIN_ROLE, pureAdmin);
        f.grantRole(upgraderRole, upgrader);
        // Strip the bootstrap admin's upgrade power so authorities are fully split.
        f.revokeRole(upgraderRole, admin);
        vm.stopPrank();

        assertTrue(f.hasRole(DEFAULT_ADMIN_ROLE, pureAdmin), "pureAdmin is admin");
        assertFalse(f.hasRole(upgraderRole, pureAdmin), "pureAdmin is NOT upgrader");
        assertTrue(f.hasRole(upgraderRole, upgrader), "upgrader holds UPGRADER_ROLE");
        assertFalse(f.hasRole(DEFAULT_ADMIN_ROLE, upgrader), "upgrader is NOT admin");

        FissionFactoryV2 v2 = new FissionFactoryV2();

        // Pure-admin (no UPGRADER_ROLE) cannot upgrade.
        vm.prank(pureAdmin);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, pureAdmin, upgraderRole
            )
        );
        f.upgradeToAndCall(address(v2), "");

        // The bootstrap admin lost UPGRADER_ROLE → can no longer upgrade either.
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, admin, upgraderRole
            )
        );
        f.upgradeToAndCall(address(v2), "");

        // The dedicated upgrader (no admin) CAN upgrade.
        vm.prank(upgrader);
        f.upgradeToAndCall(address(v2), "");
        assertEq(FissionFactoryV2(address(f)).version(), "v2");
    }

    /// @dev UUPS-1(c): initialize must reject a zero admin.
    function test_factory_initializeRevertsZeroAdmin() public {
        FissionFactory impl = new FissionFactory();
        StandardMarketDeployer sd = new StandardMarketDeployer();
        RewardsMarketDeployer rd = new RewardsMarketDeployer();
        vm.expectRevert(FissionFactory.ZeroAddress.selector);
        new ERC1967Proxy(
            address(impl),
            abi.encodeCall(
                FissionFactory.initialize, (address(0), address(0xBA), address(0xBE), sd, rd, 7 days)
            )
        );
    }

    function test_factory_authorizedUpgradePreservesStateAndAddsFn() public {
        FissionFactory f = FactoryTestHelper.deploy(admin, address(0xBA), address(0xBE));
        // Cache the role id so it isn't fetched (consuming the prank) inside the
        // argument list of the pranked grantRole call.
        bytes32 reviewerRole = f.SY_REVIEWER_ROLE();

        // grant a role pre-upgrade to prove role storage survives.
        vm.prank(admin);
        f.grantRole(reviewerRole, address(0xCE));
        assertTrue(f.hasRole(reviewerRole, address(0xCE)));

        FissionFactoryV2 v2 = new FissionFactoryV2();
        vm.prank(admin);
        f.upgradeToAndCall(address(v2), "");

        // State preserved.
        assertTrue(f.hasRole(reviewerRole, address(0xCE)));
        assertTrue(f.hasRole(DEFAULT_ADMIN_ROLE, admin));
        assertEq(f.marketAdmin(), address(0xBA));
        assertEq(f.SY_REVIEW_WINDOW(), 7 days);
        // New function callable.
        assertEq(FissionFactoryV2(address(f)).version(), "v2");
    }

    function test_factory_existingBehaviorThroughProxy() public {
        FissionFactory f = FactoryTestHelper.deploy(admin, address(0xBA), address(0xBE));
        // admin-gated governance setter works through the proxy.
        vm.prank(admin);
        f.setMarketAdmin(address(0xC0FFEE));
        assertEq(f.marketAdmin(), address(0xC0FFEE));

        // non-admin blocked.
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, attacker, DEFAULT_ADMIN_ROLE
            )
        );
        f.setMarketTreasury(address(0xD00D));
    }
}
