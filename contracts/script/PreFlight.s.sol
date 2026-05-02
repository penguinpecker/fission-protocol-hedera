// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {IStaderHBARX} from "../src/interfaces/IStaderHBARX.sol";
import {IUniswapV2Pair} from "../src/interfaces/IUniswapV2Pair.sol";
import {IAavePool} from "../src/interfaces/IAavePool.sol";
import {MainnetAddresses} from "./MainnetAddresses.sol";

/// @title  PreFlight -- read-only address validator. Run BEFORE any deploy.
/// @notice Reads each pinned mainnet address (from `MainnetAddresses` + env) and
///         confirms the contract responds to the ABI we'll be calling at runtime.
///         A single failure aborts -- the deploy script refuses to run downstream.
/// @dev    Run as:
///   forge script script/PreFlight.s.sol --rpc-url $HEDERA_MAINNET_RPC -vvv
///
///         No --broadcast -- pure simulation. Cheap, can run as often as needed.
contract PreFlight is Script {
    error UnverifiedStader(uint256 reportedRate);
    error UnverifiedSaucerV1Pool(string reason);
    error UnverifiedBonzo(string reason);
    error EnvMissing(string varName);

    function run() external view {
        console2.log("=== Fission preflight on chain", block.chainid, "===");
        require(block.chainid == 295 || block.chainid == 296, "preflight: not Hedera");

        // ─── Stader staking contract ─────────────────────────────────────
        address stader = vm.envOr("STADER_ORACLE_ADDRESS", MainnetAddresses.STADER_STAKING);
        console2.log("Probing Stader at:", stader);
        try IStaderHBARX(stader).getExchangeRate() returns (uint256 rate) {
            console2.log("  rate:", rate);
            if (rate < 1e18 || rate > 5e18) {
                revert UnverifiedStader(rate);
            }
            console2.log("  OK (rate is in plausible 1.0-5.0 HBAR/HBARX range)");
        } catch {
            console2.log("  FAILED -- getExchangeRate() did not return the expected shape.");
            console2.log("  Use a keeper that fetches from Stader's REST API and update SY_HBARX");
            console2.log("  to skip the on-chain circuit-breaker check (or implement a custom interface).");
            revert UnverifiedStader(0);
        }

        // ─── SaucerSwap V1 LP ────────────────────────────────────────────
        address saucerLp = vm.envOr("SAUCER_V1_LP", address(0));
        if (saucerLp != address(0)) {
            console2.log("Probing SaucerSwap V1 LP at:", saucerLp);
            try IUniswapV2Pair(saucerLp).getReserves() returns (uint112 r0, uint112 r1, uint32) {
                if (r0 == 0 || r1 == 0) revert UnverifiedSaucerV1Pool("zero reserves");
                console2.log("  reserve0:", uint256(r0));
                console2.log("  reserve1:", uint256(r1));
            } catch {
                revert UnverifiedSaucerV1Pool("getReserves reverted -- not a Uni V2 pool");
            }
            try IUniswapV2Pair(saucerLp).totalSupply() returns (uint256 ts) {
                if (ts == 0) revert UnverifiedSaucerV1Pool("zero totalSupply");
                console2.log("  totalSupply:", ts);
                console2.log("  OK");
            } catch {
                revert UnverifiedSaucerV1Pool("totalSupply reverted");
            }
        } else {
            console2.log("SaucerSwap V1 LP: SKIPPED (set SAUCER_V1_LP env var to enable)");
        }

        // ─── Bonzo lending pool ──────────────────────────────────────────
        address bonzoPool = vm.envOr("BONZO_POOL", MainnetAddresses.BONZO_POOL);
        address usdc = vm.envOr("USDC_ADDRESS", MainnetAddresses.USDC);
        console2.log("Probing Bonzo LendingPool at:", bonzoPool);
        try IAavePool(bonzoPool).getReserveNormalizedIncome(usdc) returns (uint256 ix) {
            if (ix < 1e27 || ix > 5e27) revert UnverifiedBonzo("ray index out of plausible range");
            console2.log("  USDC index (ray):", ix);
            console2.log("  OK");
        } catch {
            revert UnverifiedBonzo("getReserveNormalizedIncome reverted");
        }

        console2.log("=== preflight PASSED ===");
    }
}
