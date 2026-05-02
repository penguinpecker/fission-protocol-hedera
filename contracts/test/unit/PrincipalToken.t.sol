// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {PrincipalToken} from "../../src/core/PrincipalToken.sol";

contract PrincipalTokenTest is Test {
    PrincipalToken pt;
    address sy = address(0xBEEF);
    address market = address(0xCAFE);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    uint256 expiry;

    function setUp() public {
        expiry = block.timestamp + 90 days;
        pt = new PrincipalToken("Fission PT-0", "fPT-0", sy, expiry, market, 18);
    }

    // ───── construction ─────

    function test_init() public view {
        assertEq(pt.name(), "Fission PT-0");
        assertEq(pt.symbol(), "fPT-0");
        assertEq(pt.decimals(), 18);
        assertEq(pt.sy(), sy);
        assertEq(pt.expiry(), expiry);
        assertEq(pt.market(), market);
        assertFalse(pt.isExpired());
    }

    function test_revertsOnZeroSY() public {
        vm.expectRevert(PrincipalToken.ZeroAddress.selector);
        new PrincipalToken("X", "X", address(0), expiry, market, 18);
    }

    function test_revertsOnZeroMarket() public {
        vm.expectRevert(PrincipalToken.ZeroAddress.selector);
        new PrincipalToken("X", "X", sy, expiry, address(0), 18);
    }

    // ───── mint / burn gating ─────

    function test_mint_onlyMarket() public {
        vm.prank(alice);
        vm.expectRevert(PrincipalToken.OnlyMarket.selector);
        pt.mint(alice, 1e18);

        vm.prank(market);
        pt.mint(alice, 1e18);
        assertEq(pt.balanceOf(alice), 1e18);
    }

    function test_burn_onlyMarket() public {
        vm.prank(market);
        pt.mint(alice, 5e18);

        vm.prank(alice);
        vm.expectRevert(PrincipalToken.OnlyMarket.selector);
        pt.burn(alice, 1e18);

        vm.prank(market);
        pt.burn(alice, 2e18);
        assertEq(pt.balanceOf(alice), 3e18);
    }

    // ───── transfers always work, even when "paused" elsewhere ─────

    function test_transfer_unrestricted() public {
        vm.prank(market);
        pt.mint(alice, 10e18);

        vm.prank(alice);
        pt.transfer(bob, 4e18);

        assertEq(pt.balanceOf(alice), 6e18);
        assertEq(pt.balanceOf(bob), 4e18);
    }

    function test_transfer_postExpiry() public {
        vm.prank(market);
        pt.mint(alice, 1e18);

        vm.warp(expiry + 1);
        assertTrue(pt.isExpired());

        vm.prank(alice);
        pt.transfer(bob, 1e18); // still works
        assertEq(pt.balanceOf(bob), 1e18);
    }

    // ───── isExpired flips at expiry ─────

    function test_expiryBoundary() public {
        assertFalse(pt.isExpired());
        vm.warp(expiry - 1);
        assertFalse(pt.isExpired());
        vm.warp(expiry);
        assertTrue(pt.isExpired()); // >= expiry
    }
}
