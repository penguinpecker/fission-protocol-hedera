// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {FissionFactory} from "../src/core/FissionFactory.sol";
import {StandardMarketDeployer} from "../src/core/StandardMarketDeployer.sol";
import {RewardsMarketDeployer} from "../src/core/RewardsMarketDeployer.sol";
import {FissionPeriphery} from "../src/periphery/FissionPeriphery.sol";
import {FissionLens} from "../src/periphery/FissionLens.sol";
import {SY_HBARX} from "../src/sy/SY_HBARX.sol";
import {SY_SaucerSwapV2LP} from "../src/sy/SY_SaucerSwapV2LP.sol";
import {MainnetAddresses} from "./MainnetAddresses.sol";
import {NetworkConfig} from "./NetworkConfig.sol";

/// @title  MainnetDeploy — full Hedera mainnet brain + SY deploy.
/// @notice Deploys the UUPS brain set (FissionFactory, FissionPeriphery,
///         FissionLens — each impl + ERC1967Proxy initialized atomically) plus
///         the two production SYs (SY_HBARX, SY_SaucerSwapV2LP). The legacy
///         ActionRouter is RETIRED (UUPS-2: it pulled user PT via transferFrom,
///         which reverts against freeze-by-default PT — the user-facing routes
///         now go through the freeze-exempt FissionPeriphery instead).
///
///         v1 mainnet market lineup (markets are gov-gated, NOT created here):
///           1. SY_HBARX            → FissionMarket          (rate-growth)
///           2. SY_SaucerSwapV2LP   → FissionRewardsMarket   (Pendle-Kyber)
///
///         External deps come from NetworkConfig.get(295) (the pinned mainnet
///         block) so the same address source feeds both the Periphery init and
///         the SY constructors.
///
///         NOTE (Hedera): the AUTHORITATIVE mainnet broadcast path is the SDK
///         script `scripts/deploy-rebuild-proxy.mjs` — big bytecode must go via
///         the FileService, ContractCreate caps at 15M gas, and HTS-precompile
///         value-forwarding (initShareToken / setTokens) needs SDK handling
///         that `forge --broadcast` does not model. This Forge script is the
///         canonical reference + fork/local dry-run of the proxy-deploy logic.
///
/// @dev    Run preflight first:
///           forge script script/PreFlight.s.sol --rpc-url $HEDERA_MAINNET_RPC -vvv
///         Then a dry-run (NO broadcast — see runbook for the real .mjs path):
///           forge script script/MainnetDeploy.s.sol --rpc-url $HEDERA_MAINNET_RPC -vvv
///
///         Markets / SY proposals / seed liquidity are Safe-gated post-deploy
///         actions — see the POST-DEPLOY CHECKLIST and docs/DEPLOY_RUNBOOK.md.
contract MainnetDeploy is Script {
    function run() external {
        require(block.chainid == NetworkConfig.HEDERA_MAINNET, "MainnetDeploy: not Hedera mainnet");

        address deployer = msg.sender;
        address factoryAdmin = vm.envAddress("FACTORY_ADMIN");
        address marketAdmin = vm.envAddress("MARKET_ADMIN");
        address marketTreasury = vm.envAddress("MARKET_TREASURY");
        address syAdmin = vm.envAddress("SY_ADMIN");
        address keeper = vm.envAddress("KEEPER_ADDRESS");
        address peripheryOwner = vm.envOr("PERIPHERY_OWNER", deployer);
        address upgradeAuthority = vm.envOr("UPGRADE_AUTHORITY", factoryAdmin);

        // By default, refuse if any privileged role is the deployer EOA — the
        // Safe / Hedera ThresholdKey account should already exist and the
        // deployer just hands off. Bypass with ALLOW_DEPLOYER_ADMIN=1 for a
        // deliberate operator-first solo deploy (handoff happens at the very
        // end). NOTE: PERIPHERY_OWNER is the HOT ops key and is allowed to be
        // the deployer even in prod — it has no upgrade/admin power (upgrade
        // authority is the separate UPGRADE_AUTHORITY).
        bool allowDeployerAdmin = vm.envOr("ALLOW_DEPLOYER_ADMIN", uint256(0)) == 1;
        if (!allowDeployerAdmin) {
            require(factoryAdmin != deployer, "deployer should not own factory in prod (ALLOW_DEPLOYER_ADMIN=1)");
            require(marketAdmin != deployer, "deployer should not own markets in prod (ALLOW_DEPLOYER_ADMIN=1)");
            require(syAdmin != deployer, "deployer should not own SY in prod (ALLOW_DEPLOYER_ADMIN=1)");
            require(upgradeAuthority != deployer, "deployer should not hold upgrade authority in prod (ALLOW_DEPLOYER_ADMIN=1)");
        }
        require(upgradeAuthority != address(0), "UPGRADE_AUTHORITY not set");
        require(peripheryOwner != address(0), "PERIPHERY_OWNER not set");

        // External deps: pinned mainnet block, with optional env override.
        NetworkConfig.Config memory cfg = NetworkConfig.get(NetworkConfig.HEDERA_MAINNET);
        cfg.v2Router = vm.envOr("SAUCER_V2_ROUTER", cfg.v2Router);
        cfg.v3Npm = vm.envOr("SAUCER_V2_NPM", cfg.v3Npm);
        cfg.whbarContract = vm.envOr("WHBAR_CONTRACT", cfg.whbarContract);
        cfg.whbarToken = vm.envOr("WHBAR_TOKEN", cfg.whbarToken);
        cfg.usdc = vm.envOr("USDC_TOKEN", cfg.usdc);

        address stader = vm.envOr("STADER_ORACLE_ADDRESS", MainnetAddresses.STADER_STAKING);
        require(cfg.v3Npm != address(0), "SAUCER_V2_NPM not set");

        // Tick range for the V2 LP SY (immutable — never rebalanced).
        int24 tickLower = int24(int256(vm.envOr("SAUCER_V2_TICK_LOWER", int256(MainnetAddresses.SAUCER_V2_TICK_LOWER_DEFAULT))));
        int24 tickUpper = int24(int256(vm.envOr("SAUCER_V2_TICK_UPPER", int256(MainnetAddresses.SAUCER_V2_TICK_UPPER_DEFAULT))));
        require(tickLower < tickUpper, "tick range inverted");

        // V3 pools sort token0 < token1 by address. Pre-pin canonical order.
        address t0 = cfg.usdc < cfg.whbarToken ? cfg.usdc : cfg.whbarToken;
        address t1 = cfg.usdc < cfg.whbarToken ? cfg.whbarToken : cfg.usdc;

        uint256 syReviewWindow = vm.envOr("SY_REVIEW_WINDOW", uint256(7 days));

        console2.log("=== Fission Mainnet Deploy (UUPS brains + SYs) ===");
        console2.log("  deployer        =", deployer);
        console2.log("  factoryAdmin    =", factoryAdmin);
        console2.log("  marketAdmin     =", marketAdmin);
        console2.log("  marketTreasury  =", marketTreasury);
        console2.log("  syAdmin         =", syAdmin);
        console2.log("  keeper          =", keeper);
        console2.log("  peripheryOwner  =", peripheryOwner);
        console2.log("  upgradeAuthority=", upgradeAuthority);
        console2.log("  v2Router        =", cfg.v2Router);
        console2.log("  v3Npm           =", cfg.v3Npm);
        console2.log("  whbarContract   =", cfg.whbarContract);
        console2.log("  whbarToken      =", cfg.whbarToken);
        console2.log("  usdc            =", cfg.usdc);
        console2.log("  syReviewWindow  =", syReviewWindow);

        // HTS createFungibleToken precompile fee — paid in HBAR via msg.value to
        // each SY's initShareToken(). ~2 HBAR per SY covers create + 90-day
        // auto-renew prepayment.
        uint256 SY_INIT_FEE = vm.envOr("SY_INIT_FEE", uint256(2 ether));

        vm.startBroadcast();

        // ── Core deployers ──
        StandardMarketDeployer standardDeployer = new StandardMarketDeployer();
        RewardsMarketDeployer rewardsDeployer = new RewardsMarketDeployer();

        // ── Brain 1: FissionFactory (UUPS) ──
        FissionFactory factoryImpl = new FissionFactory();
        ERC1967Proxy factoryProxy = new ERC1967Proxy(
            address(factoryImpl),
            abi.encodeCall(
                FissionFactory.initialize,
                (factoryAdmin, marketAdmin, marketTreasury, standardDeployer, rewardsDeployer, syReviewWindow)
            )
        );
        FissionFactory factory = FissionFactory(address(factoryProxy));

        // ── Brain 2: FissionPeriphery (UUPS) ── markets registered post-create.
        FissionPeriphery peripheryImpl = new FissionPeriphery();
        ERC1967Proxy peripheryProxy = new ERC1967Proxy(
            address(peripheryImpl),
            abi.encodeCall(
                FissionPeriphery.initialize,
                (
                    cfg.whbarContract,
                    cfg.whbarToken,
                    cfg.usdc,
                    cfg.v2Router,
                    cfg.v3Npm,
                    peripheryOwner,
                    upgradeAuthority,
                    new address[](0)
                )
            )
        );
        FissionPeriphery periphery = FissionPeriphery(payable(address(peripheryProxy)));

        // ── Brain 3: FissionLens (UUPS) ──
        FissionLens lensImpl = new FissionLens();
        ERC1967Proxy lensProxy = new ERC1967Proxy(
            address(lensImpl), abi.encodeCall(FissionLens.initialize, (upgradeAuthority))
        );
        FissionLens lens = FissionLens(address(lensProxy));

        // ── SY_HBARX (rate-growth) ──
        // Two-step: deploy (cheap, no precompile), then initShareToken with HBAR.
        SY_HBARX syHbarx = new SY_HBARX(MainnetAddresses.HBARX, stader, syAdmin, 0);
        syHbarx.initShareToken{value: SY_INIT_FEE}();
        syHbarx.grantRole(syHbarx.KEEPER_ROLE(), keeper);

        // ── SY_SaucerSwapV2LP (Pendle-Kyber pattern, no keeper) ──
        SY_SaucerSwapV2LP sySaucerV2 = new SY_SaucerSwapV2LP(
            "Fission SY-SaucerV2LP",
            "fSY-SS-V2",
            t0,
            t1,
            MainnetAddresses.SAUCER_V2_FEE,
            tickLower,
            tickUpper,
            cfg.v3Npm,
            syAdmin,
            0
        );
        sySaucerV2.initShareToken{value: SY_INIT_FEE}();

        vm.stopBroadcast();

        // ── Post-deploy assertions (read-backs) ──
        require(factory.SY_REVIEW_WINDOW() == syReviewWindow, "factory: SY_REVIEW_WINDOW mismatch");
        require(factory.hasRole(factory.DEFAULT_ADMIN_ROLE(), factoryAdmin), "factory: admin not set");
        require(factory.hasRole(factory.UPGRADER_ROLE(), factoryAdmin), "factory: upgrader not set");
        require(periphery.owner() == peripheryOwner, "periphery: owner mismatch");
        require(periphery.upgradeAuthority() == upgradeAuthority, "periphery: upgradeAuthority mismatch");
        require(periphery.upgradeAuthority() != address(0), "periphery: upgradeAuthority zero");
        require(periphery.WHBAR_CONTRACT() == cfg.whbarContract, "periphery: whbarContract mismatch");
        require(periphery.V2_ROUTER() == cfg.v2Router, "periphery: v2Router mismatch");
        require(periphery.V3_NPM() == cfg.v3Npm, "periphery: v3Npm mismatch");
        require(lens.upgradeAuthority() == upgradeAuthority, "lens: upgradeAuthority mismatch");

        console2.log("=== Deployed ===");
        console2.log("  Factory   (proxy):", address(factory));
        console2.log("  Factory   (impl) :", address(factoryImpl));
        console2.log("  Periphery (proxy):", address(periphery));
        console2.log("  Periphery (impl) :", address(peripheryImpl));
        console2.log("  Lens      (proxy):", address(lens));
        console2.log("  Lens      (impl) :", address(lensImpl));
        console2.log("  StandardDeployer :", address(standardDeployer));
        console2.log("  RewardsDeployer  :", address(rewardsDeployer));
        console2.log("  SY_HBARX         :", address(syHbarx));
        console2.log("  SY_SaucerSwapV2LP:", address(sySaucerV2));

        // Persist for the frontend / keeper. Router intentionally OMITTED — the
        // periphery proxy replaces it.
        string memory json = string.concat(
            "{\n",
            '  "chainId": 295,\n',
            '  "factory": "', vm.toString(address(factory)), '",\n',
            '  "periphery": "', vm.toString(address(periphery)), '",\n',
            '  "lens": "', vm.toString(address(lens)), '",\n',
            '  "sy_hbarx": "', vm.toString(address(syHbarx)), '",\n',
            '  "sy_saucer_v2_lp": "', vm.toString(address(sySaucerV2)), '"\n',
            "}\n"
        );
        vm.writeFile("./deployments/295.json", json);
        console2.log("Wrote deployments/295.json");

        console2.log("\n=== POST-DEPLOY CHECKLIST (Safe-gated) ===");
        console2.log("1. From the Safe, propose each SY: factory.proposeSY(sy_hbarx / sy_saucer_v2_lp)");
        console2.log("2. Wait SY_REVIEW_WINDOW (7 days, contract-enforced).");
        console2.log("3. From the Safe, confirmSY + createMarket / createRewardsMarket{value} per SY.");
        console2.log("4. CRITICAL (MDS-2): as the MARKET ADMIN, call market.setPeriphery(peripheryProxy)");
        console2.log("   for EACH market BEFORE registering / frontend cutover. periphery-routed");
        console2.log("   flows silently break without this (freeze-exempt wiring unset).");
        console2.log("5. As the periphery OWNER, periphery.registerMarket(market) for EACH market.");
        console2.log("6. Assert market.periphery() == periphery and periphery.marketRegistered(market).");
        console2.log("7. Verify PT was created WITH a freeze key (Mirror Node getTokenInfo).");
        console2.log("8. From the Safe, initialize each market with seed liquidity.");
        console2.log("9. Verify all contracts on HashScan via Sourcify (impl + proxy).");
        console2.log("10. Configure keeper for SY_HBARX postRate (NOT for V2 LP).");
        console2.log("11. Update frontend NEXT_PUBLIC_FACTORY_ADDRESS + NEXT_PUBLIC_PERIPHERY_ADDRESS + LENS.");
        console2.log("12. IRREVERSIBLE handoff (operator-last): revoke deployer EOA from EVERY");
        console2.log("    privileged role; confirm the Safe / ThresholdKey holds admin + upgrader.");
    }
}
