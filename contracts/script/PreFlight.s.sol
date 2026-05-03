// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {IStaderHBARX} from "../src/interfaces/IStaderHBARX.sol";
import {IUniswapV3PositionManager} from "../src/interfaces/IUniswapV3PositionManager.sol";
import {MainnetAddresses} from "./MainnetAddresses.sol";

/// @title  PreFlight -- read-only address validator. Run BEFORE any deploy.
/// @notice Reads each pinned mainnet address (from `MainnetAddresses` + env) and
///         confirms the contract responds to the ABI we'll be calling at runtime.
///         A single failure aborts -- the deploy script refuses to run downstream.
/// @dev    Run as:
///   forge script script/PreFlight.s.sol --rpc-url $HEDERA_MAINNET_RPC -vvv
///
///         No --broadcast -- pure simulation. Cheap, can run as often as needed.
///
///         v1 lineup checks: Stader (HBARX rate oracle) + SaucerSwap V2 NPM (V3 NFT
///         position manager). Bonzo + V1 LP checks dropped — those SY adapters were
///         removed from the launch lineup.
contract PreFlight is Script {
    error UnverifiedStader(uint256 reportedRate);
    error UnverifiedSaucerV2NPM(string reason);
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
            revert UnverifiedStader(0);
        }

        // ─── SaucerSwap V2 NPM ───────────────────────────────────────────
        address npm = vm.envOr("SAUCER_V2_NPM", MainnetAddresses.SAUCER_V2_NPM);
        if (npm == address(0)) revert EnvMissing("SAUCER_V2_NPM");
        console2.log("Probing SaucerSwap V2 NPM at:", npm);

        // We can't safely call `mint` from a view simulation (state-mutating); instead
        // probe `positions(uint256)` with a likely-existing tokenId (1) and verify the
        // tuple shape. If tokenId 1 doesn't exist, the call reverts — that's the V3
        // NPM behavior, also acceptable as proof of "not an EOA / not random contract".
        try IUniswapV3PositionManager(npm).positions(1) returns (
            uint96, address, address, address, uint24, int24, int24, uint128, uint256, uint256, uint128, uint128
        ) {
            console2.log("  OK (positions(1) returned the expected V3 tuple)");
        } catch (bytes memory reason) {
            // A revert on positions(1) is acceptable IF the contract has the selector —
            // V3 NPM reverts with `Invalid token ID` when the position doesn't exist.
            // What's NOT acceptable is the call landing on an EOA or a contract
            // missing the selector entirely. Distinguish via reason length.
            if (reason.length == 0) {
                // No revert reason at all → contract probably doesn't have the selector.
                revert UnverifiedSaucerV2NPM("positions(uint256) selector missing - wrong contract?");
            }
            console2.log("  OK (positions reverted with reason - selector exists, tokenId 1 unminted)");
        }

        // SaucerSwap V2 WHBAR-USDC pool address — sanity check it's a contract.
        address pool = vm.envOr("SAUCER_V2_POOL", MainnetAddresses.SAUCER_V2_WHBAR_USDC_POOL);
        console2.log("SaucerSwap V2 pool (sanity):", pool);
        if (pool.code.length == 0) {
            revert UnverifiedSaucerV2NPM("V2 pool address has no code");
        }
        console2.log("  OK (pool is a contract)");

        console2.log("=== preflight PASSED ===");
    }
}
