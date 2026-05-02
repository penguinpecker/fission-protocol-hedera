// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FixedPointMathLib} from "@solady/utils/FixedPointMathLib.sol";

/// @title PMath — primitive 1e18 fixed-point math for Fission Protocol.
/// @notice Wraps Solady's lnWad/expWad/mulDiv with explicit rounding-direction
///         helpers. Every conversion in the protocol must round in the protocol's
///         favour; the down/up suffixes here make that explicit at the call site.
/// @dev    Solady's primitives are the audited foundation. This library exists
///         only to add intent-revealing wrappers and small helpers (subMax0,
///         safe casts) that get used across MarketMath / SY / Market.
library PMath {
    int256 internal constant IONE = 1e18;
    uint256 internal constant ONE = 1e18;
    uint256 internal constant BPS = 10_000;

    error MathOverflow();
    error MathDivByZero();

    // ───────────────────── ln / exp (signed wad) ─────────────────────

    function lnWad(int256 x) internal pure returns (int256) {
        return FixedPointMathLib.lnWad(x);
    }

    function expWad(int256 x) internal pure returns (int256) {
        return FixedPointMathLib.expWad(x);
    }

    // ───────────────────── unsigned mulDiv ───────────────────────────

    /// @notice ⌊a · b / d⌋ — round down (favour holder of larger amount in / smaller amount out).
    function mulDivDown(uint256 a, uint256 b, uint256 d) internal pure returns (uint256) {
        return FixedPointMathLib.mulDiv(a, b, d);
    }

    /// @notice ⌈a · b / d⌉ — round up (favour holder owed something out, charge more in).
    function mulDivUp(uint256 a, uint256 b, uint256 d) internal pure returns (uint256) {
        return FixedPointMathLib.mulDivUp(a, b, d);
    }

    /// @notice ⌊a · b / 1e18⌋ — common 1e18-scaled multiplication.
    function mulWadDown(uint256 a, uint256 b) internal pure returns (uint256) {
        return FixedPointMathLib.mulDiv(a, b, ONE);
    }

    function mulWadUp(uint256 a, uint256 b) internal pure returns (uint256) {
        return FixedPointMathLib.mulDivUp(a, b, ONE);
    }

    function divWadDown(uint256 a, uint256 b) internal pure returns (uint256) {
        return FixedPointMathLib.mulDiv(a, ONE, b);
    }

    function divWadUp(uint256 a, uint256 b) internal pure returns (uint256) {
        return FixedPointMathLib.mulDivUp(a, ONE, b);
    }

    // ───────────────────── signed mulWad / divWad ────────────────────

    /// @notice (a · b) / 1e18 with truncation toward zero, signed.
    /// @dev    Solidity's `/` for int256 truncates toward zero — sufficient when
    ///         the rounding direction is documented at the call site.
    function mulWadInt(int256 a, int256 b) internal pure returns (int256) {
        unchecked {
            return (a * b) / IONE;
        }
    }

    /// @notice (a · 1e18) / b, truncating toward zero, signed. Reverts on b == 0.
    function divWadInt(int256 a, int256 b) internal pure returns (int256) {
        if (b == 0) revert MathDivByZero();
        unchecked {
            return (a * IONE) / b;
        }
    }

    // ───────────────────── safe casts ────────────────────────────────

    function toInt(uint256 x) internal pure returns (int256) {
        if (x > uint256(type(int256).max)) revert MathOverflow();
        return int256(x);
    }

    function toUint(int256 x) internal pure returns (uint256) {
        if (x < 0) revert MathOverflow();
        // forge-lint: disable-next-line(unsafe-typecast)
        // safe: explicit non-negativity check immediately above.
        return uint256(x);
    }

    // ───────────────────── min/max/sat-sub ───────────────────────────

    function min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    function max(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a : b;
    }

    function subMax0(uint256 a, uint256 b) internal pure returns (uint256) {
        unchecked {
            return a > b ? a - b : 0;
        }
    }

    function abs(int256 x) internal pure returns (uint256) {
        unchecked {
            return uint256(x < 0 ? -x : x);
        }
    }

    // ───────────────────── square root ───────────────────────────────

    function sqrt(uint256 x) internal pure returns (uint256) {
        return FixedPointMathLib.sqrt(x);
    }
}
