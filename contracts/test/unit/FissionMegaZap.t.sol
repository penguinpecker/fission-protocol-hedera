// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {FissionMegaZap} from "../../src/periphery/FissionMegaZap.sol";
import {IFissionMarketCommon} from "../../src/interfaces/IFissionMarketCommon.sol";
import {IStandardizedYield} from "../../src/interfaces/IStandardizedYield.sol";
import {MockSY, MockERC20} from "../mocks/MockSY.sol";

/// @notice Minimal stub of FissionZap. Mints SY shares 1:1 with msg.value to the
///         configured receiver. Simulates the V3 swap as lossless for testing.
contract StubZap {
    MockSY public immutable sy;

    constructor(MockSY sy_) {
        sy = sy_;
    }

    function zapHbarToSy(
        address /*sy*/,
        uint256,
        uint256,
        uint256,
        uint128,
        address receiver
    ) external payable returns (uint256 shares) {
        shares = msg.value;
        sy.mint(receiver, shares);
    }

    receive() external payable {}
}

/// @notice Minimal stub router. Delivers PT/YT/LP to receiver according to a
///         configurable rate, simulating the real router's behaviour without
///         pulling in the FissionMarket setup.
contract StubRouter {
    MockSY public immutable sy;
    MockERC20 public immutable pt;
    MockERC20 public immutable yt;
    MockERC20 public immutable lp;

    constructor(MockSY sy_, MockERC20 pt_, MockERC20 yt_, MockERC20 lp_) {
        sy = sy_;
        pt = pt_;
        yt = yt_;
        lp = lp_;
    }

    function swapExactSyForPt(
        IFissionMarketCommon,
        uint256 syIn,
        uint256 minPtOut,
        address receiver,
        uint256 /*deadline*/
    ) external returns (uint256 syUsed) {
        // Pull SY in.
        require(sy.transferFrom(msg.sender, address(this), syIn), "sy pull");
        // Deliver PT 1:0.95 — simulates the small AMM premium.
        uint256 ptOut = (syIn * 95) / 100;
        require(ptOut >= minPtOut, "slippage");
        pt.mint(receiver, ptOut);
        // Use only 90% — refund the rest so the MegaZap sweep logic engages.
        syUsed = (syIn * 90) / 100;
        require(sy.transfer(msg.sender, syIn - syUsed), "refund");
    }

    function buyYT(
        IFissionMarketCommon,
        uint256 syBudget,
        uint256 /*minSyOutFromPtSale*/,
        address receiver,
        uint256 /*deadline*/
    ) external returns (uint256 ytOut, uint256 syRefund) {
        require(sy.transferFrom(msg.sender, address(this), syBudget), "sy pull");
        // Deliver YT 1:1 with the budget; refund 1% as the "PT-sale proceeds".
        ytOut = syBudget;
        yt.mint(receiver, ytOut);
        syRefund = syBudget / 100;
        require(sy.transfer(receiver, syRefund), "refund");
    }

    function addLiquidityProportional(
        IFissionMarketCommon,
        uint256 syIn,
        uint256 ptIn,
        uint256 minLpOut,
        address receiver,
        uint256 /*deadline*/
    ) external returns (uint256 lpOut) {
        require(sy.transferFrom(msg.sender, address(this), syIn), "sy pull");
        require(pt.transferFrom(msg.sender, address(this), ptIn), "pt pull");
        // LP minted as min(syIn, ptIn) — proportional ratio simulation.
        lpOut = syIn < ptIn ? syIn : ptIn;
        require(lpOut >= minLpOut, "slippage");
        lp.mint(receiver, lpOut);
    }
}

contract FissionMegaZapTest is Test {
    MockERC20 underlying;
    MockSY sy;
    MockERC20 pt;
    MockERC20 yt;
    MockERC20 lp;

    StubZap zapStub;
    StubRouter routerStub;
    FissionMegaZap mega;

    address alice = address(0xA1);

    // Stub market interface — the MegaZap reads ptAddr/sy from market on the LP
    // path. We need only that surface.
    function setUp() public {
        underlying = new MockERC20("USD", "USD", 18);
        sy = new MockSY(address(underlying), 18);
        pt = new MockERC20("PT", "PT", 18);
        yt = new MockERC20("YT", "YT", 18);
        lp = new MockERC20("LP", "LP", 18);

        zapStub = new StubZap(sy);
        routerStub = new StubRouter(sy, pt, yt, lp);
        mega = new FissionMegaZap(address(zapStub), address(routerStub));

        vm.deal(alice, 1000 ether);
    }

    // The MegaZap calls market.ptAddr() and market.sy() on the LP path. We
    // expose a tiny adapter that returns our stub addresses.
    function ptAddr() external view returns (address) { return address(pt); }
    function sy_addr() external view returns (address) { return address(sy); }

    /* ─────────────────────────────────────────────────────── PT path */

    function test_constructor_storesImmutables() public view {
        assertEq(address(mega.zap()), address(zapStub));
        assertEq(address(mega.router()), address(routerStub));
    }

    function test_constructor_revertsOnZeroAddress() public {
        vm.expectRevert(FissionMegaZap.ZeroAddress.selector);
        new FissionMegaZap(address(0), address(routerStub));

        vm.expectRevert(FissionMegaZap.ZeroAddress.selector);
        new FissionMegaZap(address(zapStub), address(0));
    }

    function test_zapHbarToPt_deliversPt() public {
        IFissionMarketCommon market = IFissionMarketCommon(address(0xDEAD)); // not used by stub
        uint256 minPtOut = 90 ether; // stub gives 95% so 100 ether SY → 95 PT

        vm.prank(alice);
        uint256 ptOut = mega.zapHbarToPt{value: 100 ether}(
            market,
            IStandardizedYield(address(sy)),
            minPtOut,
            alice,
            block.timestamp + 60
        );

        // PT credited.
        assertGe(pt.balanceOf(alice), minPtOut);
        // Function returned the conservative floor.
        assertEq(ptOut, minPtOut);
        // MegaZap holds no SY (any unused was swept back to receiver).
        assertEq(sy.balanceOf(address(mega)), 0);
    }

    function test_zapHbarToPt_revertsOnZeroValue() public {
        vm.prank(alice);
        vm.expectRevert(FissionMegaZap.ZeroAmount.selector);
        mega.zapHbarToPt{value: 0}(
            IFissionMarketCommon(address(0xDEAD)),
            IStandardizedYield(address(sy)),
            1,
            alice,
            block.timestamp + 60
        );
    }

    function test_zapHbarToPt_revertsOnZeroReceiver() public {
        vm.prank(alice);
        vm.expectRevert(FissionMegaZap.ZeroAddress.selector);
        mega.zapHbarToPt{value: 1 ether}(
            IFissionMarketCommon(address(0xDEAD)),
            IStandardizedYield(address(sy)),
            1,
            address(0),
            block.timestamp + 60
        );
    }

    function test_zapHbarToPt_revertsOnExpiredDeadline() public {
        vm.warp(1000);
        vm.prank(alice);
        vm.expectRevert(FissionMegaZap.DeadlineExpired.selector);
        mega.zapHbarToPt{value: 1 ether}(
            IFissionMarketCommon(address(0xDEAD)),
            IStandardizedYield(address(sy)),
            1,
            alice,
            999
        );
    }

    /* ─────────────────────────────────────────────────────── YT path */

    function test_zapHbarToYt_deliversYt() public {
        IFissionMarketCommon market = IFissionMarketCommon(address(0xDEAD));

        vm.prank(alice);
        (uint256 ytOut, uint256 syRefund) = mega.zapHbarToYt{value: 100 ether}(
            market,
            IStandardizedYield(address(sy)),
            0,
            alice,
            block.timestamp + 60
        );

        // YT delivered.
        assertEq(yt.balanceOf(alice), 100 ether);
        assertEq(ytOut, 100 ether);
        // 1% refund.
        assertEq(syRefund, 1 ether);
        assertEq(sy.balanceOf(alice), 1 ether);
        // MegaZap empty.
        assertEq(sy.balanceOf(address(mega)), 0);
    }

    function test_zapHbarToYt_revertsOnZeroValue() public {
        vm.prank(alice);
        vm.expectRevert(FissionMegaZap.ZeroAmount.selector);
        mega.zapHbarToYt{value: 0}(
            IFissionMarketCommon(address(0xDEAD)),
            IStandardizedYield(address(sy)),
            0,
            alice,
            block.timestamp + 60
        );
    }

    /* ─────────────────────────────────────────────────────── LP path */

    function test_zapHbarToLp_deliversLp() public {
        // Use this test contract's ptAddr() shim as the "market".
        IFissionMarketCommon market = IFissionMarketCommon(address(this));

        uint256 minLpOut = 1; // accept any; stub returns min(syIn,ptIn) ≈ 40e18

        vm.prank(alice);
        uint256 lpOut = mega.zapHbarToLp{value: 100 ether}(
            market,
            IStandardizedYield(address(sy)),
            5000, // 50/50 split
            minLpOut,
            alice,
            block.timestamp + 60
        );

        assertGt(lpOut, 0);
        assertGt(lp.balanceOf(alice), 0);
        // MegaZap residuals swept.
        assertEq(sy.balanceOf(address(mega)), 0);
        assertEq(pt.balanceOf(address(mega)), 0);
    }

    function test_zapHbarToLp_revertsOnBadPtShare() public {
        IFissionMarketCommon market = IFissionMarketCommon(address(this));

        vm.prank(alice);
        vm.expectRevert(FissionMegaZap.ZeroAmount.selector);
        mega.zapHbarToLp{value: 100 ether}(
            market,
            IStandardizedYield(address(sy)),
            0, // invalid
            1,
            alice,
            block.timestamp + 60
        );

        vm.prank(alice);
        vm.expectRevert(FissionMegaZap.ZeroAmount.selector);
        mega.zapHbarToLp{value: 100 ether}(
            market,
            IStandardizedYield(address(sy)),
            10_000, // invalid (would consume entire budget for PT)
            1,
            alice,
            block.timestamp + 60
        );
    }

    function test_zapHbarToLp_revertsOnZeroMinLp() public {
        IFissionMarketCommon market = IFissionMarketCommon(address(this));

        vm.prank(alice);
        vm.expectRevert(FissionMegaZap.ZeroAmount.selector);
        mega.zapHbarToLp{value: 100 ether}(
            market,
            IStandardizedYield(address(sy)),
            5000,
            0, // invalid minLpOut
            alice,
            block.timestamp + 60
        );
    }
}
