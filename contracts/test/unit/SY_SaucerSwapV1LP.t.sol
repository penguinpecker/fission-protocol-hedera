// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {SY_SaucerSwapV1LP} from "../../src/sy/SY_SaucerSwapV1LP.sol";
import {IStandardizedYield} from "../../src/interfaces/IStandardizedYield.sol";
import {MockSaucerV1Pool} from "../mocks/MockSaucerV1Pool.sol";
import {MockERC20} from "../mocks/MockSY.sol";

contract SY_SaucerSwapV1LP_Test is Test {
    MockSaucerV1Pool pool;
    SY_SaucerSwapV1LP sy;

    address admin = address(0xAD);
    address keeper = address(0xCAFE);
    address alice = address(0xA1);

    function setUp() public {
        // HBAR (8 dec) and USDC (6 dec) — token addresses don't matter for the LP math.
        pool = new MockSaucerV1Pool(address(0xAA), address(0xBB));

        // Seed pool with 1M LP supply backed by reserves of (10000 token0 ≈ 10000e8, 5000 token1 ≈ 5000e6).
        // Choose numbers so sqrt(r0*r1) is an exact integer for clean assertions.
        // r0 = 10_000e8 = 1e12, r1 = 5_000e6 = 5e9. r0*r1 = 5e21, sqrt = 7.07e10 (approx).
        // ts = 1e12 (1M LP at 8 dec).
        pool.setReserves(uint112(1e12), uint112(5e9));
        pool.mint(address(this), 1e12);
        // Mint alice's LP BEFORE SY construction so the captured initialVirtualPrice
        // already reflects the full totalSupply. Otherwise post-construction mints
        // dilute the on-chain virtual price relative to initialVirtualPrice and the
        // ratio drifts below 1.0 even with no fee growth.
        pool.mint(alice, 100e8);

        sy = new SY_SaucerSwapV1LP("Fission SY-SaucerLP", "SY-SS", address(pool), admin, 0);

        bytes32 keeperRole = sy.KEEPER_ROLE();
        vm.prank(admin);
        sy.grantRole(keeperRole, keeper);
    }

    // ───── construction ─────

    function test_init_capturesVirtualPrice() public view {
        assertEq(sy.underlying(), address(pool));
        assertEq(address(sy.pool()), address(pool));
        assertEq(sy.decimals(), 8);
        assertGt(sy.initialVirtualPrice(), 0);
        assertEq(sy.count(), 0);
    }

    function test_assetInfo_isLIQUIDITY() public view {
        // CRITICAL: LP-backed SY MUST report LIQUIDITY so downstream PT/YT consumers
        // know not to price PT against the LP token directly.
        (IStandardizedYield.AssetType t, address asset, uint8 dec) = sy.assetInfo();
        assertEq(uint256(t), uint256(IStandardizedYield.AssetType.LIQUIDITY));
        assertEq(asset, address(pool));
        assertEq(dec, 8);
    }

    function test_revertsOnEmptyPool() public {
        MockSaucerV1Pool empty = new MockSaucerV1Pool(address(0xAA), address(0xBB));
        vm.expectRevert(SY_SaucerSwapV1LP.PoolUninitialized.selector);
        new SY_SaucerSwapV1LP("x", "x", address(empty), admin, 0);
    }

    // ───── postRate machinery ─────

    function test_exchangeRate_revertsBeforeGenesis() public {
        vm.expectRevert(SY_SaucerSwapV1LP.NoObservationsYet.selector);
        sy.exchangeRate();
    }

    function test_postRate_genesisAt1e18() public {
        // At genesis, virtual price = initialVirtualPrice → ratio = 1e18.
        vm.prank(keeper);
        sy.postRate(1e18);
        assertEq(sy.exchangeRate(), 1e18);
    }

    function test_postRate_intervalGate() public {
        vm.startPrank(keeper);
        sy.postRate(1e18);
        vm.expectRevert();
        sy.postRate(1.0001e18);
        vm.stopPrank();
    }

    function test_postRate_bpsCap() public {
        vm.startPrank(keeper);
        sy.postRate(1e18);
        vm.warp(block.timestamp + 1 hours + 1);
        // 1.0 → 1.01 = 99 bps, > 50 bps cap
        vm.expectRevert();
        sy.postRate(1.01e18);
        vm.stopPrank();
    }

    function test_circuitBreaker_firesWhenPoolDivergesFromTwap() public {
        // Genesis: TWAP = 1e18, oracle ratio = 1e18 (k unchanged).
        vm.prank(keeper);
        sy.postRate(1e18);

        // Now boost the pool's k: keep r0 the same, increase r1 by 5%.
        // sqrt(k) grows ~2.5%. Oracle ratio jumps to ~1.025e18 → > 200 bps from 1.0.
        pool.setReserves(uint112(1e12), uint112(uint256(5e9) * 105 / 100));
        vm.warp(block.timestamp + 1 hours + 1);

        // Keeper attempts to post a rate within bps cap. Circuit breaker should fire.
        vm.prank(keeper);
        sy.postRate(1.001e18); // 10 bps move; well within bps cap

        assertTrue(sy.paused());
        assertEq(sy.count(), 1, "post should have been dropped");
    }

    function test_twap_growsAsRatesPosted() public {
        uint256[5] memory r = [
            uint256(1.0000e18),
            uint256(1.0010e18),
            uint256(1.0020e18),
            uint256(1.0030e18),
            uint256(1.0040e18)
        ];

        uint256 t = block.timestamp;
        for (uint256 i = 0; i < r.length; i++) {
            if (i > 0) {
                t += 1 hours + 1;
                vm.warp(t);
            }
            vm.prank(keeper);
            sy.postRate(r[i]);
        }
        // Median of 5 = middle = r[2] = 1.002e18
        assertEq(sy.exchangeRate(), 1.002e18);
    }

    // ───── deposit / redeem ─────

    function test_deposit_redeem_roundTrip() public {
        vm.prank(keeper);
        sy.postRate(1e18);

        vm.startPrank(alice);
        IERC20(address(pool)).approve(address(sy), 100e8);
        uint256 shares = sy.deposit(alice, address(pool), 100e8, 0);
        uint256 lpBack = sy.redeem(alice, shares, address(pool), 0, false);
        vm.stopPrank();

        assertLe(lpBack, 100e8);
        assertGe(lpBack, 100e8 - 2);
    }

    function test_deposit_invalidTokenReverts() public {
        vm.prank(keeper);
        sy.postRate(1e18);
        vm.expectRevert();
        vm.prank(alice);
        sy.deposit(alice, address(0xdead), 1, 0);
    }
}
