// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {FissionFactory} from "../src/core/FissionFactory.sol";
import {ActionRouter} from "../src/periphery/ActionRouter.sol";
import {SY_HBARX} from "../src/sy/SY_HBARX.sol";
import {SY_SaucerSwapV2LP} from "../src/sy/SY_SaucerSwapV2LP.sol";
import {MainnetAddresses} from "./MainnetAddresses.sol";

/// @title  MainnetDeploy — full Hedera mainnet deploy in one transaction batch.
/// @notice Deploys: FissionFactory, ActionRouter, SY_HBARX, SY_SaucerSwapV2LP.
///         Grants KEEPER_ROLE on SY_HBARX (V2 LP SY needs no keeper — fees are
///         pulled by users via `harvest()` + market reward forwarding).
///         Writes addresses to `deployments/295.json`.
///
///         v1 mainnet market lineup:
///           1. SY_HBARX            → FissionMarket          (rate-growth pattern)
///           2. SY_SaucerSwapV2LP   → FissionMarketRewards   (Pendle-Kyber pattern)
///
///         Bonzo USDC and SaucerSwap V1 LP markets were dropped pre-launch — see
///         memory/research_hedera_sy_underlyings.md for the rationale.
/// @dev    Run preflight first:
///           forge script script/PreFlight.s.sol --rpc-url $HEDERA_MAINNET_RPC -vvv
///         Then deploy:
///           forge script script/MainnetDeploy.s.sol \
///             --rpc-url $HEDERA_MAINNET_RPC \
///             --private-key $HEDERA_OPERATOR_KEY \
///             --broadcast --slow -vvv
///
///         The script does NOT initialize markets, propose SYs, or seed liquidity —
///         those are Safe-gated post-deploy actions (see docs/MAINNET_DEPLOY.md).
contract MainnetDeploy is Script {
    function run() external {
        require(block.chainid == 295, "MainnetDeploy: not Hedera mainnet");

        address deployer = msg.sender;
        address factoryAdmin = vm.envAddress("FACTORY_ADMIN");
        address marketAdmin = vm.envAddress("MARKET_ADMIN");
        address marketTreasury = vm.envAddress("MARKET_TREASURY");
        address syAdmin = vm.envAddress("SY_ADMIN");
        address keeper = vm.envAddress("KEEPER_ADDRESS");

        // By default, refuse if any privileged role is the deployer EOA — the Safe or
        // Hedera ThresholdKey account should already exist and the deployer just hands
        // off. Bypass with `ALLOW_DEPLOYER_ADMIN=1` for a deliberate solo deploy where
        // the operator accepts the single-key-rotation-later model. Make sure you set
        // it ONLY when you mean it; admin transfer is two-step + delayed via OZ
        // AccessControlDefaultAdminRules so rotation is recoverable.
        bool allowDeployerAdmin = vm.envOr("ALLOW_DEPLOYER_ADMIN", uint256(0)) == 1;
        if (!allowDeployerAdmin) {
            require(factoryAdmin != deployer, "deployer should not own factory in prod (ALLOW_DEPLOYER_ADMIN=1 to override)");
            require(marketAdmin != deployer, "deployer should not own markets in prod (ALLOW_DEPLOYER_ADMIN=1 to override)");
            require(syAdmin != deployer, "deployer should not own SY in prod (ALLOW_DEPLOYER_ADMIN=1 to override)");
        }

        address stader = vm.envOr("STADER_ORACLE_ADDRESS", MainnetAddresses.STADER_STAKING);
        address npm = vm.envOr("SAUCER_V2_NPM", MainnetAddresses.SAUCER_V2_NPM);
        address pool = vm.envOr("SAUCER_V2_POOL", MainnetAddresses.SAUCER_V2_WHBAR_USDC_POOL);
        require(npm != address(0), "SAUCER_V2_NPM not set");
        require(pool != address(0), "SAUCER_V2_POOL not set");

        // Tick range for the V2 LP SY (immutable — never rebalanced).
        int24 tickLower = int24(int256(vm.envOr("SAUCER_V2_TICK_LOWER", int256(MainnetAddresses.SAUCER_V2_TICK_LOWER_DEFAULT))));
        int24 tickUpper = int24(int256(vm.envOr("SAUCER_V2_TICK_UPPER", int256(MainnetAddresses.SAUCER_V2_TICK_UPPER_DEFAULT))));
        require(tickLower < tickUpper, "tick range inverted");

        // V3 pools sort token0 < token1 by address. We pre-pin the WHBAR-USDC 0.15%
        // pool's tokens so we can pass them in the canonical order without an external
        // pool read at script time. If pool token addresses ever shift (they don't —
        // immutable in V3), the SY constructor would still revert via TokensIdentical /
        // ZeroAddress / InvalidTickRange.
        address t0 = MainnetAddresses.USDC < MainnetAddresses.WHBAR ? MainnetAddresses.USDC : MainnetAddresses.WHBAR;
        address t1 = MainnetAddresses.USDC < MainnetAddresses.WHBAR ? MainnetAddresses.WHBAR : MainnetAddresses.USDC;

        console2.log("=== Fission Mainnet Deploy ===");
        console2.log("  deployer       =", deployer);
        console2.log("  factoryAdmin   =", factoryAdmin);
        console2.log("  marketAdmin    =", marketAdmin);
        console2.log("  marketTreasury =", marketTreasury);
        console2.log("  syAdmin        =", syAdmin);
        console2.log("  keeper         =", keeper);
        console2.log("  saucerNpm      =", npm);
        console2.log("  saucerPool     =", pool);
        console2.log("  saucerToken0   =", t0);
        console2.log("  saucerToken1   =", t1);
        console2.log("  tickLower      =", int256(tickLower));
        console2.log("  tickUpper      =", int256(tickUpper));

        // HTS createFungibleToken precompile fee — paid in HBAR via msg.value at the
        // SY constructor. Hedera mainnet charges roughly 1 HBAR per createFungible;
        // we attach 2 HBAR per SY as a safety margin for future fee bumps. Excess
        // stays inside the SY contract and can be reclaimed by admin via a sweep
        // helper if ever added.
        uint256 SY_CREATE_FEE = 2 ether; // 2 HBAR

        vm.startBroadcast();

        // ── Core ──
        FissionFactory factory = new FissionFactory(factoryAdmin, marketAdmin, marketTreasury);
        ActionRouter router = new ActionRouter();

        // ── SY_HBARX (rate-growth) ──
        SY_HBARX syHbarx = new SY_HBARX{value: SY_CREATE_FEE}(MainnetAddresses.HBARX, stader, syAdmin, 0);
        syHbarx.grantRole(syHbarx.KEEPER_ROLE(), keeper);

        // ── SY_SaucerSwapV2LP (Pendle-Kyber pattern, no keeper) ──
        SY_SaucerSwapV2LP sySaucerV2 = new SY_SaucerSwapV2LP{value: SY_CREATE_FEE}(
            "Fission SY-SaucerV2LP",
            "fSY-SS-V2",
            t0,
            t1,
            MainnetAddresses.SAUCER_V2_FEE,
            tickLower,
            tickUpper,
            npm,
            syAdmin,
            0
        );
        // No keeper role grant — SY_SaucerSwapV2LP exposes a public `harvest()` and
        // doesn't post any rate. The market's reward distribution pulls automatically.

        vm.stopBroadcast();

        console2.log("=== Deployed ===");
        console2.log("Factory          :", address(factory));
        console2.log("Router           :", address(router));
        console2.log("SY_HBARX         :", address(syHbarx));
        console2.log("SY_SaucerSwapV2LP:", address(sySaucerV2));

        // Persist for the frontend / keeper.
        string memory json = string.concat(
            "{\n",
            '  "chainId": 295,\n',
            '  "factory": "', vm.toString(address(factory)), '",\n',
            '  "router":  "', vm.toString(address(router)), '",\n',
            '  "sy_hbarx": "', vm.toString(address(syHbarx)), '",\n',
            '  "sy_saucer_v2_lp": "', vm.toString(address(sySaucerV2)), '"\n',
            "}\n"
        );
        vm.writeFile("./deployments/295.json", json);
        console2.log("Wrote deployments/295.json");

        console2.log("\n=== POST-DEPLOY CHECKLIST ===");
        console2.log("1. From the Safe, propose each SY:");
        console2.log("   factory.proposeSY(sy_hbarx)");
        console2.log("   factory.proposeSY(sy_saucer_v2_lp)");
        console2.log("2. Wait 7 days (contract-enforced).");
        console2.log("3. From the Safe, confirm + create each market:");
        console2.log("   factory.confirmSY(sy_hbarx)");
        console2.log("   factory.createMarket(sy_hbarx, expiry, scalarRoot, suffix)");
        console2.log("   factory.confirmSY(sy_saucer_v2_lp)");
        console2.log("   factory.createRewardsMarket(sy_saucer_v2_lp, expiry, scalarRoot, suffix)");
        console2.log("4. From the Safe, initialize each market with seed liquidity.");
        console2.log("5. Verify all contracts on HashScan via Sourcify.");
        console2.log("6. Configure keeper for SY_HBARX postRate (NOT for V2 LP).");
        console2.log("7. Update frontend NEXT_PUBLIC_FACTORY_ADDRESS + NEXT_PUBLIC_ROUTER_ADDRESS.");
        console2.log("8. Verify deployer EOA has been revoked from every privileged role.");
    }
}
