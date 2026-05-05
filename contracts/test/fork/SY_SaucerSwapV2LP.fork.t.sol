// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";

import {IUniswapV3PositionManager} from "../../src/interfaces/IUniswapV3PositionManager.sol";

/// @title  SaucerSwap V2 NPM + pool fork test against Hedera mainnet.
/// @notice Skipped automatically when `HEDERA_MAINNET_RPC` is not set in the environment.
///         When enabled, forks Hedera mainnet at the latest block and verifies that:
///           1. The NPM at `0x00000000000000000000000000000000003DDbb9` exposes the
///              expected V3 NonFungiblePositionManager ABI shape.
///           2. The WHBAR-USDC 0.15% pool address has bytecode (i.e. is a contract).
///           3. WHBAR / USDC HTS facade addresses have bytecode.
/// @dev    We do NOT construct `SY_SaucerSwapV2LP` here. The SY's constructor reads
///         `IERC20Metadata(token).decimals()` on USDC / WHBAR, which routes through
///         the Hedera HTS system contract at `0x167`. Foundry's fork EVM cannot
///         simulate the HTS precompile (it is a Hedera-native system contract, not
///         standard EVM), so `decimals()` reverts under `forge test --fork-url`. This
///         is a known infrastructure limitation, not a bug in the SY.
///
///         Real on-chain construction of the SY happens at deploy time via
///         `script/MainnetDeploy.s.sol` (broadcast tx on the live network, where the
///         HTS precompile is available). The constructor's decimals reads are then
///         exercised end-to-end in production.
///
///         Run with:
///             HEDERA_MAINNET_RPC=https://mainnet.hashio.io/api forge test \
///                 --match-path 'test/fork/SY_SaucerSwapV2LP*' --fork-url $HEDERA_MAINNET_RPC -vv
contract SY_SaucerSwapV2LP_ForkTest is Test {
    /// @notice SaucerSwap V2 NonFungiblePositionManager (Hedera `0.0.4053945`).
    ///         Verified 2026-05-02 via docs.saucerswap.finance + Mirror Node.
    address constant NPM = 0x00000000000000000000000000000000003DDbb9;

    /// @notice WHBAR-USDC 0.15% pool. token0 = USDC (6 dec), token1 = WHBAR (8 dec).
    address constant POOL = 0xC5B707348dA504E9Be1bD4E21525459830e7B11d;

    /// @notice USDC HTS facade (`0.0.456858`).
    address constant USDC = 0x000000000000000000000000000000000006f89a;

    /// @notice WHBAR HTS facade (`0.0.1456986`).
    address constant WHBAR = 0x0000000000000000000000000000000000163B5a;

    function setUp() public {
        string memory rpc = vm.envOr("HEDERA_MAINNET_RPC", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
        }
    }

    /// @notice The NPM exposes `positions(uint256)` with the SaucerSwap-V2 10-field tuple
    ///         (no leading `nonce`/`operator` vs canonical Uniswap V3).
    /// @dev    Earlier version of this test used the canonical 12-field shape and
    ///         relied on the catch-all `bytes memory reason` to mask a silent decode
    ///         failure — passing while the ABI was wrong. The 10-field shape was
    ///         verified live 2026-05-06 by decoding the raw response (320 bytes).
    function test_fork_npm_positionsSelector() public view {
        try IUniswapV3PositionManager(NPM).positions(74444) returns (
            address t0, address t1, uint24 fee,
            int24 tickLower, int24 tickUpper, uint128 liquidity,
            uint256, uint256, uint128, uint128
        ) {
            // Real Market 0 position; expectations from deployments/295.json.
            assertEq(t0, USDC, "position token0 != USDC");
            assertEq(t1, WHBAR, "position token1 != WHBAR");
            assertEq(fee, 1500, "position fee tier != 0.15%");
            assertEq(tickLower, -887220, "position tickLower != full-range");
            assertEq(tickUpper, 887220, "position tickUpper != full-range");
            assertGt(liquidity, 0, "position liquidity = 0");
        } catch (bytes memory reason) {
            // If positions() returns wrong-shape data, it'd surface as a decode
            // revert with non-empty reason; we want to fail loudly, not pass silently.
            revert(string.concat("NPM positions decode failed: ", vm.toString(reason)));
        }
    }

    /// @notice The NPM is a deployed contract on the live network.
    function test_fork_npm_hasCode() public view {
        assertGt(NPM.code.length, 0, "NPM address has no bytecode");
    }

    /// @notice The WHBAR-USDC 0.15% pool is a deployed contract on the live network.
    function test_fork_pool_hasCode() public view {
        assertGt(POOL.code.length, 0, "V2 pool address has no bytecode");
    }

    /// @notice WHBAR / USDC HTS facades are present.
    /// @dev    We verify bytecode existence only; calling `decimals()` here would
    ///         hit the same HTS precompile limitation that prevents the SY from
    ///         being constructed in fork mode (see contract NatSpec).
    function test_fork_htsFacades_haveCode() public view {
        assertGt(USDC.code.length, 0, "USDC HTS facade has no bytecode");
        assertGt(WHBAR.code.length, 0, "WHBAR HTS facade has no bytecode");
    }
}
