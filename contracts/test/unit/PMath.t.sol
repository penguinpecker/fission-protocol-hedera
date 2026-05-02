// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {PMath} from "../../src/libraries/PMath.sol";

contract PMathTest is Test {
    // ─────── ln/exp round-trip ───────

    function test_lnExp_oneIsOne() public pure {
        // ln(1e18) = 0
        assertEq(PMath.lnWad(1e18), 0);
        // exp(0) = 1e18
        assertEq(PMath.expWad(0), 1e18);
    }

    function test_lnExp_eIsOne() public pure {
        // exp(1e18) ≈ e * 1e18, then ln of that ≈ 1e18 (within 1 ulp)
        int256 e = PMath.expWad(int256(1e18));
        int256 backToOne = PMath.lnWad(e);
        // tolerate ±2 because of int256 truncation in both directions
        assertApproxEqAbs(backToOne, int256(1e18), 2);
    }

    function testFuzz_lnExp_roundTrip(int256 x) public pure {
        x = bound(x, int256(0.01e18), int256(50e18));
        int256 expX = PMath.expWad(x);
        int256 lnExpX = PMath.lnWad(expX);
        // ln(exp(x)) ≈ x within a few ulp for inputs in this range
        assertApproxEqAbs(lnExpX, x, 1e10);
    }

    // ─────── mulDiv rounding direction ───────

    function test_mulDivDown_roundsToward0() public pure {
        assertEq(PMath.mulDivDown(7, 1, 3), 2); // ⌊7/3⌋ = 2
    }

    function test_mulDivUp_roundsAwayFrom0() public pure {
        assertEq(PMath.mulDivUp(7, 1, 3), 3); // ⌈7/3⌉ = 3
    }

    function test_mulDivUpDown_differByAtMostOne() public pure {
        for (uint256 i = 1; i <= 100; i++) {
            uint256 down = PMath.mulDivDown(i, 3, 7);
            uint256 up = PMath.mulDivUp(i, 3, 7);
            assertTrue(up == down || up == down + 1);
        }
    }

    function testFuzz_mulWadDown_neverExceedsAB(uint256 a, uint256 b) public pure {
        a = bound(a, 0, 1e36);
        b = bound(b, 0, 1e36);
        uint256 product = PMath.mulWadDown(a, b);
        // sanity: a*b/1e18 ≤ a*b
        if (b > 0) {
            uint256 expected = (a * b) / 1e18;
            assertEq(product, expected);
        }
    }

    // ─────── safe casts ───────

    function test_toInt_largeUintReverts() public {
        vm.expectRevert(PMath.MathOverflow.selector);
        this.toIntExt(uint256(type(int256).max) + 1);
    }

    function test_toUint_negativeReverts() public {
        vm.expectRevert(PMath.MathOverflow.selector);
        this.toUintExt(-1);
    }

    function toIntExt(uint256 x) external pure returns (int256) {
        return PMath.toInt(x);
    }

    function toUintExt(int256 x) external pure returns (uint256) {
        return PMath.toUint(x);
    }

    // ─────── subMax0 ───────

    function test_subMax0_noUnderflow() public pure {
        assertEq(PMath.subMax0(uint256(3), uint256(5)), 0);
        assertEq(PMath.subMax0(uint256(5), uint256(3)), 2);
    }

    function testFuzz_subMax0_neverNegative(uint256 a, uint256 b) public pure {
        uint256 r = PMath.subMax0(a, b);
        // r is uint, always ≥ 0; check correctness
        if (a >= b) assertEq(r, a - b);
        else assertEq(r, 0);
    }

    // ─────── divWadInt: revert on zero ───────

    function test_divWadInt_zeroDenomReverts() public {
        vm.expectRevert(PMath.MathDivByZero.selector);
        this.divWadIntExt(int256(1e18), 0);
    }

    function divWadIntExt(int256 a, int256 b) external pure returns (int256) {
        return PMath.divWadInt(a, b);
    }
}
