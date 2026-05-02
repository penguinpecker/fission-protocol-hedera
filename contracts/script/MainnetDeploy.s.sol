// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {FissionFactory} from "../src/core/FissionFactory.sol";
import {ActionRouter} from "../src/periphery/ActionRouter.sol";
import {SY_HBARX} from "../src/sy/SY_HBARX.sol";
import {SY_BonzoUSDC} from "../src/sy/SY_BonzoUSDC.sol";
import {SY_SaucerSwapV1LP} from "../src/sy/SY_SaucerSwapV1LP.sol";
import {MainnetAddresses} from "./MainnetAddresses.sol";

/// @title  MainnetDeploy — full Hedera mainnet deploy in one transaction batch.
/// @notice Deploys: FissionFactory, ActionRouter, SY_HBARX, SY_BonzoUSDC,
///         optionally SY_SaucerSwapV1LP if SAUCER_V1_LP env var is set.
///         Grants KEEPER_ROLE on each SY to KEEPER_ADDRESS.
///         Writes addresses to deployments/295.json.
/// @dev    Run preflight first:
///           forge script script/PreFlight.s.sol --rpc-url $HEDERA_MAINNET_RPC -vvv
///         Then deploy:
///           forge script script/MainnetDeploy.s.sol \
///             --rpc-url $HEDERA_MAINNET_RPC \
///             --private-key $HEDERA_OPERATOR_KEY \
///             --broadcast --slow -vvv
///
///         The script does NOT initialize markets or seed liquidity — those are
///         Safe-gated post-deploy actions (see docs/MAINNET_DEPLOY.md).
///         The script does NOT propose any SY for whitelist — that's a manual step
///         with the 7-day public review window.
contract MainnetDeploy is Script {
    function run() external {
        require(block.chainid == 295, "MainnetDeploy: not Hedera mainnet");

        address deployer = msg.sender;
        address factoryAdmin = vm.envAddress("FACTORY_ADMIN");
        address marketAdmin = vm.envAddress("MARKET_ADMIN");
        address marketTreasury = vm.envAddress("MARKET_TREASURY");
        address syAdmin = vm.envAddress("SY_ADMIN");
        address keeper = vm.envAddress("KEEPER_ADDRESS");

        // Sanity: refuse to deploy if any privileged role is the deployer EOA in production.
        // The Safe + Timelock should already be deployed; the deployer just hands off.
        require(factoryAdmin != deployer, "deployer should not own factory in prod");
        require(marketAdmin != deployer, "deployer should not own markets in prod");
        require(syAdmin != deployer, "deployer should not own SY in prod");

        address stader = vm.envOr("STADER_ORACLE_ADDRESS", MainnetAddresses.STADER_STAKING);
        address saucerLp = vm.envOr("SAUCER_V1_LP", address(0));
        address bonzoPool = vm.envOr("BONZO_POOL", MainnetAddresses.BONZO_POOL);
        address bonzoBusdc = vm.envOr("BONZO_BUSDC", MainnetAddresses.BONZO_BUSDC);
        address usdc = vm.envOr("USDC_ADDRESS", MainnetAddresses.USDC);

        console2.log("=== Fission Mainnet Deploy ===");
        console2.log("  deployer       =", deployer);
        console2.log("  factoryAdmin   =", factoryAdmin);
        console2.log("  marketAdmin    =", marketAdmin);
        console2.log("  marketTreasury =", marketTreasury);
        console2.log("  syAdmin        =", syAdmin);
        console2.log("  keeper         =", keeper);

        vm.startBroadcast();

        // ── Core ──
        FissionFactory factory = new FissionFactory(factoryAdmin, marketAdmin, marketTreasury);
        ActionRouter router = new ActionRouter();

        // ── SY adapters ──
        SY_HBARX syHbarx = new SY_HBARX(MainnetAddresses.HBARX, stader, syAdmin, 0);
        syHbarx.grantRole(syHbarx.KEEPER_ROLE(), keeper);

        SY_BonzoUSDC syBonzo = new SY_BonzoUSDC(
            "Fission SY-bUSDC", "fSY-bUSDC", bonzoBusdc, bonzoPool, usdc, syAdmin, 0
        );
        syBonzo.grantRole(syBonzo.KEEPER_ROLE(), keeper);

        SY_SaucerSwapV1LP sySaucer;
        if (saucerLp != address(0)) {
            sySaucer = new SY_SaucerSwapV1LP(
                "Fission SY-SaucerLP", "fSY-SS-LP", saucerLp, syAdmin, 0
            );
            sySaucer.grantRole(sySaucer.KEEPER_ROLE(), keeper);
        }

        vm.stopBroadcast();

        console2.log("=== Deployed ===");
        console2.log("Factory       :", address(factory));
        console2.log("Router        :", address(router));
        console2.log("SY_HBARX      :", address(syHbarx));
        console2.log("SY_BonzoUSDC  :", address(syBonzo));
        if (address(sySaucer) != address(0)) {
            console2.log("SY_SaucerSwapV1LP:", address(sySaucer));
        }

        // Persist addresses for the frontend / keeper to consume.
        string memory json = string.concat(
            "{\n",
            '  "chainId": 295,\n',
            '  "factory": "', vm.toString(address(factory)), '",\n',
            '  "router":  "', vm.toString(address(router)), '",\n',
            '  "sy_hbarx": "', vm.toString(address(syHbarx)), '",\n',
            '  "sy_bonzo_usdc": "', vm.toString(address(syBonzo)), '",\n',
            '  "sy_saucer_v1_lp": "', vm.toString(address(sySaucer)), '"\n',
            "}\n"
        );
        vm.writeFile("./deployments/295.json", json);
        console2.log("Wrote deployments/295.json");

        console2.log("\n=== POST-DEPLOY CHECKLIST ===");
        console2.log("1. From the Safe, propose each SY:");
        console2.log("   factory.proposeSY(syAddress)");
        console2.log("2. Wait 7 days (contract-enforced)");
        console2.log("3. From the Safe, confirm + create + initialize each market.");
        console2.log("4. Verify contracts on HashScan via Sourcify.");
        console2.log("5. Configure keeper with these addresses (see docs/MAINNET_DEPLOY.md).");
        console2.log("6. Update frontend NEXT_PUBLIC_FACTORY_ADDRESS + NEXT_PUBLIC_ROUTER_ADDRESS.");
        console2.log("7. Verify deployer EOA has been revoked from every privileged role.");
    }
}
