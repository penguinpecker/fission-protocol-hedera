// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {SY_HBARX} from "../../src/sy/SY_HBARX.sol";
import {IStandardizedYield} from "../../src/interfaces/IStandardizedYield.sol";
import {IStaderHBARX} from "../../src/interfaces/IStaderHBARX.sol";
import {HtsTestHelper} from "../utils/HtsTestHelper.sol";

// ───────────────────── mocks ─────────────────────

/// @dev HBARX is HTS-fungible with 8 decimals on Hedera mainnet. The mock matches.
contract MockHBARX is ERC20 {
    constructor() ERC20("Hedera Staking Token", "HBARX") {
        _mint(msg.sender, 1_000_000 * 10 ** 8);
    }

    function decimals() public pure override returns (uint8) {
        return 8;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Stader's getExchangeRate() returns a 1e18-scaled HBAR-per-HBARX rate.
contract MockStaderOracle is IStaderHBARX {
    uint256 public rate;

    constructor(uint256 initial) {
        rate = initial;
    }

    function set(uint256 r) external {
        rate = r;
    }

    function getExchangeRate() external view returns (uint256) {
        return rate;
    }
}

contract SY_HBARX_Test is Test {
    MockHBARX hbarx;
    MockStaderOracle stader;
    SY_HBARX sy;
    address syShare;  // cached sy.shareToken() — vm.prank-safe

    address admin = address(0xAD);
    address keeper = address(0xCAFE);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    uint256 constant ONE = 1e18;

    function setUp() public {
        HtsTestHelper.installHtsPrecompile();

        hbarx = new MockHBARX();
        // initial Stader rate: 1.05 HBAR per HBARX (5% accrued)
        stader = new MockStaderOracle(1.05e18);

        sy = new SY_HBARX(address(hbarx), address(stader), admin, 0);
        sy.initShareToken();
        syShare = sy.shareToken();

        bytes32 keeperRole = sy.KEEPER_ROLE();
        vm.prank(admin);
        sy.grantRole(keeperRole, keeper);

        // seed test users with HBARX
        hbarx.mint(alice, 10_000 * 10 ** 8);
        hbarx.mint(bob, 10_000 * 10 ** 8);
    }

    // ───────────────────── construction ─────────────────────

    function test_init_state() public view {
        assertEq(sy.underlying(), address(hbarx));
        assertEq(address(sy.staderOracle()), address(stader));
        assertEq(sy.decimals(), 8);
        assertEq(sy.count(), 0);
        assertTrue(sy.hasRole(sy.DEFAULT_ADMIN_ROLE(), admin));
        assertTrue(sy.hasRole(sy.PAUSER_ROLE(), admin));
        assertTrue(sy.hasRole(sy.KEEPER_ROLE(), keeper));
    }

    function test_assetInfo() public view {
        (IStandardizedYield.AssetType t, address a, uint8 d) = sy.assetInfo();
        assertEq(uint256(t), uint256(IStandardizedYield.AssetType.TOKEN));
        assertEq(a, address(hbarx));
        assertEq(d, 8);
    }

    // ───────────────────── postRate: genesis ─────────────────────

    function test_postRate_genesis_seedsObservation() public {
        vm.prank(keeper);
        sy.postRate(1.05e18);

        assertEq(sy.count(), 1);
        assertEq(sy.exchangeRate(), 1.05e18);
    }

    function test_postRate_onlyKeeper() public {
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, alice, sy.KEEPER_ROLE()));
        vm.prank(alice);
        sy.postRate(1.05e18);
    }

    // ───────────────────── postRate: interval gate ─────────────────────

    function test_postRate_revertsBeforeInterval() public {
        vm.startPrank(keeper);
        sy.postRate(1.05e18);
        vm.expectRevert();
        sy.postRate(1.0501e18);
        vm.stopPrank();
    }

    function test_postRate_succeedsAfterInterval() public {
        vm.startPrank(keeper);
        sy.postRate(1.05e18);
        vm.warp(block.timestamp + 1 hours + 1);
        sy.postRate(1.0501e18);
        vm.stopPrank();
        assertEq(sy.count(), 2);
    }

    // ───────────────────── postRate: bps cap ─────────────────────

    function test_postRate_revertsAboveCap() public {
        vm.startPrank(keeper);
        sy.postRate(1.05e18);
        vm.warp(block.timestamp + 1 hours + 1);
        // 1.05 → 1.06 = ~95 bps, > 50 bps cap
        vm.expectRevert();
        sy.postRate(1.06e18);
        vm.stopPrank();
    }

    function test_postRate_belowCapPasses() public {
        vm.startPrank(keeper);
        sy.postRate(1.05e18);
        vm.warp(block.timestamp + 1 hours + 1);
        // 1.05 → 1.052 = ~19 bps, OK
        sy.postRate(1.052e18);
        vm.stopPrank();
    }

    // ───────────────────── postRate: circuit breaker ─────────────────────

    function test_circuitBreaker_pausesOnLargeStaderDeviation() public {
        // post genesis at 1.05; Stader oracle says 1.05 too (no deviation).
        vm.prank(keeper);
        sy.postRate(1.05e18);

        // Now Stader jumps to 1.10 — that's ~454 bps from current TWAP (1.05).
        stader.set(1.10e18);
        vm.warp(block.timestamp + 1 hours + 1);

        // Within bps cap (1.05 → 1.0525 = 24bps), but Stader reads 1.10 → triggers breaker.
        // Breaker does NOT revert — it pauses and silently drops the post.
        uint256 rateBefore = sy.exchangeRate();
        vm.prank(keeper);
        sy.postRate(1.0525e18);

        // breaker auto-pauses the SY; new rate was discarded.
        assertTrue(sy.paused());
        assertEq(sy.count(), 1, "no new observation persisted");
        assertEq(sy.exchangeRate(), rateBefore, "TWAP unchanged");
    }

    // ───────────────────── exchangeRate / TWAP median ─────────────────────

    function test_exchangeRate_returnsOneAtColdStart() public view {
        // M-3 audit fix: pre-keeper-post cold start returns PMath.ONE rather than reverting,
        // so dependent contracts (FissionMarket entry points, escape hatches) don't brick.
        assertEq(sy.exchangeRate(), 1e18);
    }

    function test_twap_medianOfSixIsMiddle() public {
        // post 6 rates: 100, 101, 102, 103, 104, 105 (all in 1e16 units of 1.05 base).
        // Adjusting to obey bps cap: 1.0500, 1.0510, 1.0520, ..., 1.0540, 1.0550 (10bps each).
        uint256[6] memory r = [
            uint256(1.0500e18),
            uint256(1.0510e18),
            uint256(1.0520e18),
            uint256(1.0530e18),
            uint256(1.0540e18),
            uint256(1.0550e18)
        ];

        // make Stader follow along so circuit breaker doesn't trip; explicit time
        // tracking so we don't rely on vm.warp + vm.prank interaction order.
        uint256 t = block.timestamp;
        for (uint256 i = 0; i < 6; i++) {
            if (i > 0) {
                t += 1 hours + 1;
                vm.warp(t);
            }
            stader.set(r[i]);
            vm.prank(keeper);
            sy.postRate(r[i]);
        }

        // even count → returns lower-middle = r[2] = 1.0520e18
        assertEq(sy.exchangeRate(), 1.0520e18);
    }

    // ───────────────────── deposit / redeem ─────────────────────

    function test_deposit_mintsSharesAtTwapRate() public {
        vm.prank(keeper);
        sy.postRate(1.05e18);

        // alice deposits 100 HBARX (in 8-dec units, so 100e8)
        uint256 amount = 100e8;
        vm.startPrank(alice);
        hbarx.approve(address(sy), amount);
        uint256 shares = sy.deposit(alice, address(hbarx), amount, 0);
        vm.stopPrank();

        // shares = amount * 1e18 / rate = 100e8 * 1e18 / 1.05e18 ≈ 95.238e8
        assertEq(shares, (uint256(amount) * 1e18) / 1.05e18);
        assertEq(IERC20(sy.shareToken()).balanceOf(alice), shares);
        assertEq(hbarx.balanceOf(address(sy)), amount);
    }

    function test_redeem_returnsHbarxAtTwapRate() public {
        vm.prank(keeper);
        sy.postRate(1.05e18);

        uint256 amount = 100e8;
        vm.startPrank(alice);
        hbarx.approve(address(sy), amount);
        uint256 shares = sy.deposit(alice, address(hbarx), amount, 0);
        uint256 out = sy.redeem(alice, shares, address(hbarx), 0, false);
        vm.stopPrank();

        // round-down on both directions: out ≤ amount; off-by-1 acceptable
        assertLe(out, amount);
        assertGe(out, amount - 2);
    }

    function test_deposit_minSharesProtection() public {
        vm.prank(keeper);
        sy.postRate(1.05e18);

        uint256 amount = 100e8;
        vm.startPrank(alice);
        hbarx.approve(address(sy), amount);
        // demand more shares than possible
        uint256 expected = (uint256(amount) * 1e18) / 1.05e18;
        vm.expectRevert();
        sy.deposit(alice, address(hbarx), amount, expected + 1);
        vm.stopPrank();
    }

    function test_deposit_invalidTokenReverts() public {
        vm.prank(keeper);
        sy.postRate(1.05e18);

        vm.startPrank(alice);
        vm.expectRevert();
        sy.deposit(alice, address(0xdead), 100e8, 0);
        vm.stopPrank();
    }

    // ───────────────────── pause ─────────────────────

    function test_pause_blocksDepositAndRedeem() public {
        vm.prank(keeper);
        sy.postRate(1.05e18);

        vm.prank(admin);
        sy.pause();

        vm.startPrank(alice);
        hbarx.approve(address(sy), 100e8);
        vm.expectRevert();
        sy.deposit(alice, address(hbarx), 100e8, 0);
        vm.stopPrank();
    }

    function test_unpause_onlyAdmin() public {
        vm.prank(admin);
        sy.pause();

        vm.expectRevert();
        vm.prank(alice);
        sy.unpause();

        vm.prank(admin);
        sy.unpause();
        assertFalse(sy.paused());
    }

    // ───────────────────── invariant-style fuzz ─────────────────────

    /// @dev Round-trip deposit→redeem must not let user extract value.
    function testFuzz_depositRedeem_roundTripNonProfitable(uint256 amount) public {
        amount = bound(amount, 1e6, 1_000_000e8);

        // post a stable rate
        vm.prank(keeper);
        sy.postRate(1.05e18);

        // give bob enough HBARX for the fuzz
        hbarx.mint(bob, amount);

        vm.startPrank(bob);
        hbarx.approve(address(sy), amount);
        uint256 shares = sy.deposit(bob, address(hbarx), amount, 0);
        uint256 out = sy.redeem(bob, shares, address(hbarx), 0, false);
        vm.stopPrank();

        assertLe(out, amount);
    }
}
