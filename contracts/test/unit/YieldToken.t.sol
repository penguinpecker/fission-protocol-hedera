// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {YieldToken} from "../../src/core/YieldToken.sol";

contract YieldTokenTest is Test {
    YieldToken yt;
    address sy = address(0xBEEF);
    address market = address(0xCAFE);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    uint256 expiry;

    function setUp() public {
        expiry = block.timestamp + 90 days;
        yt = new YieldToken("Fission YT-0", "fYT-0", sy, expiry, market);
    }

    // ───── construction ─────

    function test_init() public view {
        assertEq(yt.decimals(), 18);
        assertEq(yt.sy(), sy);
        assertEq(yt.expiry(), expiry);
        assertEq(yt.market(), market);
    }

    function test_revertsOnZeroAddresses() public {
        vm.expectRevert(YieldToken.ZeroAddress.selector);
        new YieldToken("X", "X", address(0), expiry, market);
        vm.expectRevert(YieldToken.ZeroAddress.selector);
        new YieldToken("X", "X", sy, expiry, address(0));
    }

    // ───── mint/burn gating ─────

    function test_mint_onlyMarket() public {
        vm.prank(alice);
        vm.expectRevert(YieldToken.OnlyMarket.selector);
        yt.mint(alice, 1e18);

        vm.prank(market);
        yt.mint(alice, 1e18);
        assertEq(yt.balanceOf(alice), 1e18);
    }

    function test_burn_onlyMarket() public {
        vm.prank(market);
        yt.mint(alice, 5e18);

        vm.prank(alice);
        vm.expectRevert(YieldToken.OnlyMarket.selector);
        yt.burn(alice, 1e18);

        vm.prank(market);
        yt.burn(alice, 2e18);
        assertEq(yt.balanceOf(alice), 3e18);
    }

    // ───── YTTransfer event (used by indexers / Market accrual) ─────

    function test_transfer_emitsYTTransferEvent() public {
        vm.prank(market);
        yt.mint(alice, 10e18);

        vm.recordLogs();
        vm.prank(alice);
        yt.transfer(bob, 3e18);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        // first log is ERC20 Transfer, second is YTTransfer
        bool foundYT;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == keccak256("YTTransfer(address,address,uint256)")) {
                foundYT = true;
                assertEq(address(uint160(uint256(logs[i].topics[1]))), alice);
                assertEq(address(uint160(uint256(logs[i].topics[2]))), bob);
                assertEq(abi.decode(logs[i].data, (uint256)), 3e18);
            }
        }
        assertTrue(foundYT, "YTTransfer event missing");
    }

    function test_mint_emitsYTTransferEvent() public {
        vm.recordLogs();
        vm.prank(market);
        yt.mint(alice, 5e18);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == keccak256("YTTransfer(address,address,uint256)")) {
                // mint: from = address(0), to = alice
                assertEq(address(uint160(uint256(logs[i].topics[1]))), address(0));
                assertEq(address(uint160(uint256(logs[i].topics[2]))), alice);
                found = true;
            }
        }
        assertTrue(found);
    }

    // ───── transfers always work, even at/after expiry ─────

    function test_transferPostExpiry() public {
        vm.prank(market);
        yt.mint(alice, 1e18);

        vm.warp(expiry + 1);
        assertTrue(yt.isExpired());

        vm.prank(alice);
        yt.transfer(bob, 1e18);
        assertEq(yt.balanceOf(bob), 1e18);
    }
}
