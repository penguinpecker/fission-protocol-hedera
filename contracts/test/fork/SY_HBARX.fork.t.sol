// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {SY_HBARX} from "../../src/sy/SY_HBARX.sol";
import {IStaderHBARX} from "../../src/interfaces/IStaderHBARX.sol";
import {IStandardizedYield} from "../../src/interfaces/IStandardizedYield.sol";

/// @title  SY_HBARX fork test against Hedera mainnet.
/// @notice Skipped automatically when `HEDERA_MAINNET_RPC` is not set in the environment.
///         When enabled, forks Hedera mainnet at the latest block, deploys SY_HBARX
///         pointing at the real HBARX token + Stader oracle, and verifies that
///         `staderOracle.getExchangeRate()` returns a sane value.
/// @dev    Run with:
///             HEDERA_MAINNET_RPC=https://mainnet.hashio.io/api forge test \
///                 --match-path 'test/fork/SY_HBARX*' --fork-url $HEDERA_MAINNET_RPC -vv
///         Hedera mainnet IDs (verified via hashscan.io):
///         - HBARX:                 0.0.834116  (EVM: 0x0000000000000000000000000000000000cba44)
///         - Stader Staking:        0.0.1027588 (EVM: 0x00000000000000000000000000000000000fb084) [UNCONFIRMED]
///         The Stader contract address is the published rate-source for HBARX. We pin
///         these constants here so a future automated address-update doesn't silently
///         break the fork harness.
contract SY_HBARX_ForkTest is Test {
    /// @notice HBARX token, EVM-aliased.
    address constant HBARX = 0x00000000000000000000000000000000000cbA44;

    /// @notice Stader staking contract that publishes `getExchangeRate()`.
    /// @dev    Verified 2026-05-02: Hedera `0.0.1412503` / EVM `0x...158d97`. Selector
    ///         `getExchangeRate() = 0xe6aa216c`, returns uint256 scaled to 8 decimals.
    address constant STADER_ORACLE = 0x0000000000000000000000000000000000158d97;

    address admin = address(0xAD);
    address keeper = address(0xCAFE);

    SY_HBARX sy;

    function setUp() public {
        // Skip if no fork URL — keeps `forge test` usable in plain dev/CI.
        string memory rpc = vm.envOr("HEDERA_MAINNET_RPC", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
        }

        // Each test transparently reuses the active fork created via `--fork-url`.
        sy = new SY_HBARX(HBARX, STADER_ORACLE, admin, 0);

        bytes32 keeperRole = sy.KEEPER_ROLE();
        vm.prank(admin);
        sy.grantRole(keeperRole, keeper);
    }

    /// @notice Read the live Stader rate; sanity-check it sits in a plausible band.
    /// @dev    Live verification 2026-05-02 returned 1400809589212691785 ≈ 1.4e18.
    ///         Stader's `getExchangeRate()` is scaled to 18 decimals (1e18 = 1.0 HBAR
    ///         per HBARX), NOT 8 as an earlier memo erroneously claimed.
    function test_fork_staderRateInRange() public view {
        uint256 rate = IStaderHBARX(STADER_ORACLE).getExchangeRate();
        assertGt(rate, 1.05e18, "Stader rate suspiciously low");
        assertLt(rate, 2.00e18, "Stader rate suspiciously high");
    }

    /// @notice The keeper posts the fresh Stader rate to the SY contract; TWAP medianises.
    function test_fork_postLiveRate() public {
        uint256 staderRate = IStaderHBARX(STADER_ORACLE).getExchangeRate();
        vm.prank(keeper);
        sy.postRate(staderRate);

        assertEq(sy.exchangeRate(), staderRate, "TWAP single-obs == genesis post");
        assertEq(sy.count(), 1);
    }

    /// @notice 5115 metadata is correctly populated for the live HBARX token.
    function test_fork_assetInfo() public view {
        (IStandardizedYield.AssetType t, address asset, uint8 dec) = sy.assetInfo();
        assertEq(uint256(t), uint256(IStandardizedYield.AssetType.TOKEN));
        assertEq(asset, HBARX);
        assertEq(dec, 8);
    }
}
