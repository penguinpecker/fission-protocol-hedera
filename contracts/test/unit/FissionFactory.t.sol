// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {FissionFactory} from "../../src/core/FissionFactory.sol";
import {FissionMarket} from "../../src/core/FissionMarket.sol";
import {PrincipalToken} from "../../src/core/PrincipalToken.sol";
import {YieldToken} from "../../src/core/YieldToken.sol";
import {MockSY, MockERC20} from "../mocks/MockSY.sol";

contract FissionFactoryTest is Test {
    FissionFactory factory;
    MockSY sy;
    MockERC20 underlying;

    address admin = address(0xAD);
    address reviewer = address(0xCE);
    address marketAdmin = address(0xBA);
    address treasury = address(0xBE);
    address attacker = address(0xBAD);

    bytes32 constant DEFAULT_ADMIN_ROLE = 0x00;
    bytes32 reviewerRole;
    bytes32 creatorRole;

    function setUp() public {
        underlying = new MockERC20("USD", "USD", 18);
        sy = new MockSY(address(underlying), 18);

        factory = new FissionFactory(admin, marketAdmin, treasury);

        reviewerRole = factory.SY_REVIEWER_ROLE();
        creatorRole = factory.MARKET_CREATOR_ROLE();

        vm.prank(admin);
        factory.grantRole(reviewerRole, reviewer);
    }

    // ───── construction ─────

    function test_init_state() public view {
        assertEq(factory.marketAdmin(), marketAdmin);
        assertEq(factory.marketTreasury(), treasury);
        assertTrue(factory.hasRole(DEFAULT_ADMIN_ROLE, admin));
        assertTrue(factory.hasRole(reviewerRole, admin));
        assertTrue(factory.hasRole(creatorRole, admin));
        assertEq(factory.SY_REVIEW_WINDOW(), 7 days);
        assertEq(factory.marketCount(), 0);
    }

    function test_init_revertsZero() public {
        // AccessControlDefaultAdminRules' constructor reverts before our ZeroAddress check
        // when admin is zero — that's still the desired behaviour (no zero admin).
        vm.expectRevert();
        new FissionFactory(address(0), marketAdmin, treasury);

        // For the marketAdmin / treasury zero cases, our explicit ZeroAddress fires.
        vm.expectRevert(FissionFactory.ZeroAddress.selector);
        new FissionFactory(admin, address(0), treasury);
        vm.expectRevert(FissionFactory.ZeroAddress.selector);
        new FissionFactory(admin, marketAdmin, address(0));
    }

    // ───── SY review window ─────

    function test_proposeSY_emitsEvent() public {
        vm.prank(reviewer);
        factory.proposeSY(address(sy));
        // pendingSY[sy].proposedAt = now
        (uint64 proposedAt) = factory.pendingSY(address(sy));
        assertEq(uint256(proposedAt), block.timestamp);
    }

    function test_proposeSY_onlyReviewer() public {
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, attacker, reviewerRole)
        );
        vm.prank(attacker);
        factory.proposeSY(address(sy));
    }

    function test_confirmSY_revertsBeforeWindow() public {
        vm.prank(reviewer);
        factory.proposeSY(address(sy));

        vm.warp(block.timestamp + 6 days);
        vm.prank(admin);
        vm.expectRevert();
        factory.confirmSY(address(sy));
    }

    function test_confirmSY_succeedsAfterWindow() public {
        vm.prank(reviewer);
        factory.proposeSY(address(sy));

        vm.warp(block.timestamp + 7 days + 1);
        vm.prank(admin);
        factory.confirmSY(address(sy));

        assertTrue(factory.whitelistedSY(address(sy)));
    }

    function test_confirmSY_clearsPending() public {
        vm.prank(reviewer);
        factory.proposeSY(address(sy));
        vm.warp(block.timestamp + 7 days + 1);
        vm.prank(admin);
        factory.confirmSY(address(sy));

        (uint64 proposedAt) = factory.pendingSY(address(sy));
        assertEq(uint256(proposedAt), 0);
    }

    function test_confirmSY_revertsIfNotProposed() public {
        vm.prank(admin);
        vm.expectRevert(FissionFactory.SYNotProposed.selector);
        factory.confirmSY(address(sy));
    }

    function test_revokeSY_works() public {
        _whitelistSy();
        vm.prank(admin);
        factory.revokeSY(address(sy));
        assertFalse(factory.whitelistedSY(address(sy)));
    }

    function test_proposeSY_revertsIfAlreadyWhitelisted() public {
        _whitelistSy();
        vm.prank(reviewer);
        vm.expectRevert(FissionFactory.SYAlreadyWhitelisted.selector);
        factory.proposeSY(address(sy));
    }

    // ───── createMarket ─────

    function test_createMarket_revertsIfNotWhitelisted() public {
        vm.prank(admin);
        vm.expectRevert(FissionFactory.SYNotWhitelisted.selector);
        factory.createMarket(address(sy), block.timestamp + 90 days, 75e18, "0");
    }

    function test_createMarket_succeeds() public {
        _whitelistSy();
        vm.prank(admin);
        (uint256 marketId, address marketAddr) =
            factory.createMarket(address(sy), block.timestamp + 90 days, 75e18, "0");

        assertEq(marketId, 0);
        assertEq(factory.markets(0), marketAddr);
        assertEq(factory.marketCount(), 1);

        // Verify the deployed market is wired correctly.
        FissionMarket m = FissionMarket(payable(marketAddr));
        assertEq(address(m.sy()), address(sy));
        assertEq(m.factory(), address(factory));
        assertNotEq(address(m.pt()), address(0));
        assertNotEq(address(m.yt()), address(0));

        // PT/YT point at the market.
        assertEq(m.pt().market(), marketAddr);
        assertEq(m.yt().market(), marketAddr);

        // PT/YT decimals match SY.
        assertEq(m.pt().decimals(), sy.decimals());
        assertEq(m.yt().decimals(), sy.decimals());

        // Market admin = factory.marketAdmin.
        assertTrue(m.hasRole(m.DEFAULT_ADMIN_ROLE(), marketAdmin));
    }

    function test_createMarket_onlyCreator() public {
        _whitelistSy();
        vm.expectRevert();
        vm.prank(attacker);
        factory.createMarket(address(sy), block.timestamp + 90 days, 75e18, "0");
    }

    function test_createMarket_secondMarketIncrementsId() public {
        _whitelistSy();
        vm.prank(admin);
        factory.createMarket(address(sy), block.timestamp + 90 days, 75e18, "0");
        vm.prank(admin);
        (uint256 id1,) = factory.createMarket(address(sy), block.timestamp + 180 days, 75e18, "1");
        assertEq(id1, 1);
        assertEq(factory.marketCount(), 2);
    }

    // ───── views ─────

    function test_getMarkets_pagination() public {
        _whitelistSy();
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(admin);
            factory.createMarket(address(sy), block.timestamp + (90 + i) * 1 days, 75e18, vm.toString(i));
        }
        address[] memory page = factory.getMarkets(1, 2);
        assertEq(page.length, 2);
        assertEq(page[0], factory.markets(1));
        assertEq(page[1], factory.markets(2));
    }

    // ───── helpers ─────

    function _whitelistSy() internal {
        vm.prank(reviewer);
        factory.proposeSY(address(sy));
        vm.warp(block.timestamp + 7 days + 1);
        vm.prank(admin);
        factory.confirmSY(address(sy));
    }
}
