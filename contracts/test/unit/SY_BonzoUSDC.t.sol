// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {SY_BonzoUSDC} from "../../src/sy/SY_BonzoUSDC.sol";
import {IStandardizedYield} from "../../src/interfaces/IStandardizedYield.sol";
import {MockAavePool} from "../mocks/MockAavePool.sol";
import {MockERC20} from "../mocks/MockSY.sol";

contract SY_BonzoUSDC_Test is Test {
    MockAavePool pool;
    MockERC20 bUsdc;
    MockERC20 usdc;
    SY_BonzoUSDC sy;

    address admin = address(0xAD);
    address keeper = address(0xCAFE);
    address alice = address(0xA1);

    uint256 constant RAY = 1e27;

    function setUp() public {
        bUsdc = new MockERC20("Bonzo USDC", "bUSDC", 6);
        usdc = new MockERC20("USDC", "USDC", 6);
        pool = new MockAavePool();

        // Initial Bonzo income index = 1.05 (in ray = 1.05e27) — captures 5%
        // accrued interest already earned by the underlying reserve.
        pool.setIndex(address(usdc), RAY * 105 / 100);

        sy = new SY_BonzoUSDC(
            "Fission SY-bUSDC", "SY-bUSDC", address(bUsdc), address(pool), address(usdc), admin, 0
        );

        bytes32 keeperRole = sy.KEEPER_ROLE();
        vm.prank(admin);
        sy.grantRole(keeperRole, keeper);

        bUsdc.mint(alice, 1_000e6);
    }

    // ───── construction ─────

    function test_init() public view {
        assertEq(sy.underlying(), address(bUsdc));
        assertEq(address(sy.pool()), address(pool));
        assertEq(sy.usdcReserve(), address(usdc));
        assertEq(sy.decimals(), 6);
        assertGt(sy.initialIndexRay(), 0);
    }

    function test_assetInfo_isTOKEN() public view {
        // USDC has a market price — TOKEN, not LIQUIDITY.
        (IStandardizedYield.AssetType t, address asset, uint8 dec) = sy.assetInfo();
        assertEq(uint256(t), uint256(IStandardizedYield.AssetType.TOKEN));
        assertEq(asset, address(usdc));
        assertEq(dec, 6);
    }

    function test_revertsOnZeroIndex() public {
        MockAavePool empty = new MockAavePool();
        // index never set → 0
        vm.expectRevert(SY_BonzoUSDC.PoolUninitialized.selector);
        new SY_BonzoUSDC("x", "x", address(bUsdc), address(empty), address(usdc), admin, 0);
    }

    // ───── postRate machinery ─────

    function test_exchangeRate_revertsBeforeGenesis() public {
        vm.expectRevert(SY_BonzoUSDC.NoObservationsYet.selector);
        sy.exchangeRate();
    }

    function test_postRate_genesisAt1e18() public {
        // Genesis: ratio = current / initial = 1.05 / 1.05 = 1e18
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
        vm.expectRevert();
        sy.postRate(1.01e18); // 99 bps > 50 bps cap
        vm.stopPrank();
    }

    function test_circuitBreaker_firesWhenIndexJumps() public {
        // Genesis post.
        vm.prank(keeper);
        sy.postRate(1e18);

        // Now Aave index jumps by 5% — ratio becomes 1.05e18; from TWAP=1e18 that's 476 bps.
        pool.setIndex(address(usdc), RAY * 110 / 100); // 1.10/1.05 = ~1.048 ratio
        vm.warp(block.timestamp + 1 hours + 1);

        // Keeper attempts a within-bps-cap post. Circuit breaker fires → pause + drop.
        vm.prank(keeper);
        sy.postRate(1.001e18);

        assertTrue(sy.paused());
        assertEq(sy.count(), 1);
    }

    // ───── deposit / redeem ─────

    function test_deposit_redeem_roundTrip() public {
        vm.prank(keeper);
        sy.postRate(1e18);

        vm.startPrank(alice);
        IERC20(address(bUsdc)).approve(address(sy), 100e6);
        uint256 shares = sy.deposit(alice, address(bUsdc), 100e6, 0);
        uint256 out = sy.redeem(alice, shares, address(bUsdc), 0, false);
        vm.stopPrank();

        assertLe(out, 100e6);
        assertGe(out, 100e6 - 2);
    }
}
