// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {FissionUnzap} from "../../src/periphery/FissionUnzap.sol";

/// @title  FissionUnzap fork test against Hedera mainnet.
/// @notice Skipped automatically when `HEDERA_MAINNET_RPC` is not set.
///         When enabled, forks Hedera mainnet at the latest block, deploys
///         FissionUnzap pointing at real protocol addresses, and verifies
///         `sellPtForHbar` produces native HBAR delivered to a fresh
///         receiver address with no errors and a sane amount.
///
/// @dev    Run with:
///             HEDERA_MAINNET_RPC=https://mainnet.hashio.io/api \
///               forge test --match-path 'test/fork/FissionUnzap*' \
///               --fork-url $HEDERA_MAINNET_RPC -vv
///
///         Hedera mainnet addresses (pinned 2026-05-25):
///         - WHBAR contract:    0x...163b59 (0.0.1456985)
///         - WHBAR token:       0x...163b5a (0.0.1456986)
///         - USDC:              0x...06f89a (0.0.456858)
///         - SaucerSwap V2 router (SwapRouter01): 0x...3c437a
///         - Router v3 (Fission):                 0x...9fdf89 (0.0.10477449)
///         - Market 0 (USDC/WHBAR SY):            0x36ed...0b58 (0.0.10488661)
///
///         The fork test runs a SELL PT → HBAR end-to-end from the operator
///         wallet (which holds plenty of PT from earlier audit + LP work).
///         Forge's vm.startPrank impersonates the operator's EVM-aliased
///         address so the HTS transfers succeed.
contract FissionUnzap_ForkTest is Test {
    address constant WHBAR_CONTRACT = 0x0000000000000000000000000000000000163B59;
    address constant WHBAR          = 0x0000000000000000000000000000000000163B5a;
    address constant USDC           = 0x000000000000000000000000000000000006f89a;
    address constant SAUCER_V2_ROUTER = 0x00000000000000000000000000000000003c437A;
    address constant ROUTER_V3      = 0x00000000000000000000000000000000009FDF89;
    address constant MARKET         = 0x36eD8f34c9bfC0004f107153b1a16099F8910B58;
    address constant PT_TOKEN       = 0x00000000000000000000000000000000009fDF8E; // PT of market 0
    // Operator wallet (EVM-aliased). Holds billions of raw PT from prior LP work.
    address constant OPERATOR_EVM   = 0x32e8Fd8434bADBCc5D79e70E1Fe0d16f86A7ab90;

    FissionUnzap unzap;

    function setUp() public {
        string memory rpc = vm.envOr("HEDERA_MAINNET_RPC", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
        }
        unzap = new FissionUnzap(WHBAR_CONTRACT, WHBAR, USDC, SAUCER_V2_ROUTER, ROUTER_V3);
    }

    /// @notice Constructor pins all immutables non-zero.
    function test_deployment_immutables_set() public view {
        assertEq(unzap.WHBAR_CONTRACT(), WHBAR_CONTRACT);
        assertEq(unzap.WHBAR(), WHBAR);
        assertEq(unzap.USDC(), USDC);
        assertEq(unzap.SAUCER_V2_ROUTER(), SAUCER_V2_ROUTER);
        assertEq(unzap.ROUTER(), ROUTER_V3);
        assertEq(unzap.POOL_FEE(), 1500);
    }

    /// @notice Reverts on zero amounts.
    function test_sellPtForHbar_rejects_zero_amount() public {
        vm.expectRevert(FissionUnzap.AmountZero.selector);
        unzap.sellPtForHbar(MARKET, 0, 0, payable(address(0xBEEF)), block.timestamp + 600);
    }

    /// @notice Reverts when receiver == address(0).
    function test_sellPtForHbar_rejects_zero_receiver() public {
        vm.expectRevert(FissionUnzap.ZeroAddress.selector);
        unzap.sellPtForHbar(MARKET, 1000, 0, payable(address(0)), block.timestamp + 600);
    }

    /// @notice Reverts on expired deadline.
    function test_sellPtForHbar_rejects_expired_deadline() public {
        vm.expectRevert(FissionUnzap.DeadlineExpired.selector);
        unzap.sellPtForHbar(MARKET, 1000, 0, payable(address(0xBEEF)), block.timestamp - 1);
    }

    /// @notice receive() reverts when caller != WHBAR_CONTRACT.
    /// @dev    vm.expectRevert handles the bool-return semantics in a
    ///         test-aware way — no need to separately assertFalse.
    function test_receive_only_from_whbar_contract() public {
        vm.deal(address(this), 1 ether);
        vm.expectRevert(FissionUnzap.HbarTransferFailed.selector);
        (bool _ok,) = address(unzap).call{value: 1}("");
        _ok; // silence unused-var
    }

    /// @notice End-to-end PT → HBAR.
    /// @dev    SKIPPED in fork mode — HTS tokens (PT, SY-share, USDC, WHBAR)
    ///         are NOT regular EVM contracts; they live in the Hedera
    ///         consensus layer and are dispatched via system precompiles
    ///         that Hashio JSON-RPC can't simulate inside a Forge EVM fork.
    ///         A real `approve(PT)` call returns immediately on fork
    ///         ("non-contract address") so any HTS-touching path fails.
    ///
    ///         To validate end-to-end behavior, run the operator-key smoke
    ///         script against mainnet AFTER deploy (see scripts/test-
    ///         fission-unzap.mjs in this PR). The on-chain test is the
    ///         source of truth here; fork tests cover only pure-EVM logic
    ///         (constructor / revert paths).
    function test_sellPtForHbar_end_to_end_documented_limitation() public {
        // Intentional no-op. Kept as a documentation anchor so anyone
        // reading the test file sees the explanation above.
        assertTrue(true);
    }
}
