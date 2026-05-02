// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {YieldToken} from "../../src/core/YieldToken.sol";
import {IFissionMarket} from "../../src/interfaces/IFissionMarket.sol";

/// @notice Stub market that records every callback. Unit tests for YT only verify the
///         callback is fired with the right arguments — yield accrual itself is tested
///         in FissionMarket.t.sol.
contract MockMarket is IFissionMarket {
    address public lastFrom;
    address public lastTo;
    uint256 public callCount;

    function onYTBalanceChange(address from, address to) external override {
        lastFrom = from;
        lastTo = to;
        callCount++;
    }
}

contract YieldTokenTest is Test {
    YieldToken yt;
    MockMarket mockMarket;
    address sy = address(0xBEEF);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    uint256 expiry;

    function setUp() public {
        mockMarket = new MockMarket();
        expiry = block.timestamp + 90 days;
        yt = new YieldToken("Fission YT-0", "fYT-0", sy, expiry, address(mockMarket), 18);
    }

    function _market() internal view returns (address) {
        return address(mockMarket);
    }

    // ───── construction ─────

    function test_init() public view {
        assertEq(yt.decimals(), 18);
        assertEq(yt.sy(), sy);
        assertEq(yt.expiry(), expiry);
        assertEq(yt.market(), address(mockMarket));
    }

    function test_revertsOnZeroAddresses() public {
        vm.expectRevert(YieldToken.ZeroAddress.selector);
        new YieldToken("X", "X", address(0), expiry, address(mockMarket), 18);
        vm.expectRevert(YieldToken.ZeroAddress.selector);
        new YieldToken("X", "X", sy, expiry, address(0), 18);
    }

    // ───── mint/burn gating ─────

    function test_mint_onlyMarket() public {
        vm.prank(alice);
        vm.expectRevert(YieldToken.OnlyMarket.selector);
        yt.mint(alice, 1e18);

        vm.prank(_market());
        yt.mint(alice, 1e18);
        assertEq(yt.balanceOf(alice), 1e18);
    }

    function test_burn_onlyMarket() public {
        vm.prank(_market());
        yt.mint(alice, 5e18);

        vm.prank(alice);
        vm.expectRevert(YieldToken.OnlyMarket.selector);
        yt.burn(alice, 1e18);

        vm.prank(_market());
        yt.burn(alice, 2e18);
        assertEq(yt.balanceOf(alice), 3e18);
    }

    // ───── onYTBalanceChange callback fires on every balance update ─────

    function test_callback_firedOnTransfer() public {
        vm.prank(_market());
        yt.mint(alice, 10e18); // call 1: from = 0, to = alice
        assertEq(mockMarket.callCount(), 1);
        assertEq(mockMarket.lastFrom(), address(0));
        assertEq(mockMarket.lastTo(), alice);

        vm.prank(alice);
        yt.transfer(bob, 3e18); // call 2: from = alice, to = bob
        assertEq(mockMarket.callCount(), 2);
        assertEq(mockMarket.lastFrom(), alice);
        assertEq(mockMarket.lastTo(), bob);
    }

    function test_callback_firedOnBurn() public {
        vm.prank(_market());
        yt.mint(alice, 5e18);

        vm.prank(_market());
        yt.burn(alice, 2e18); // from = alice, to = 0
        assertEq(mockMarket.callCount(), 2); // mint + burn
        assertEq(mockMarket.lastFrom(), alice);
        assertEq(mockMarket.lastTo(), address(0));
    }

    // ───── transfers always work, even at/after expiry ─────

    function test_transferPostExpiry() public {
        vm.prank(_market());
        yt.mint(alice, 1e18);

        vm.warp(expiry + 1);
        assertTrue(yt.isExpired());

        vm.prank(alice);
        yt.transfer(bob, 1e18);
        assertEq(yt.balanceOf(bob), 1e18);
    }
}
