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
import {NetworkConfig} from "./NetworkConfig.sol";

/// @title  Deploy — first-time deploy of the UUPS brain set on Hedera.
/// @notice Deploys the three upgradeable "brains" — FissionFactory,
///         FissionPeriphery, FissionLens — each as an implementation + an
///         ERC1967Proxy initialized atomically in the proxy constructor. The
///         legacy ActionRouter is RETIRED (it pulled user PT via transferFrom,
///         which reverts against freeze-by-default PT — UUPS-2).
///
///         The SAME logic runs on Hedera testnet (296) and mainnet (295); the
///         only difference is the external-address block, which comes from
///         `NetworkConfig.get(block.chainid)`.
///
///         NOTE (Hedera): on real Hedera consensus the operational mainnet path
///         is the SDK script `scripts/deploy-rebuild-proxy.mjs`, because big
///         contract bytecode must go through the FileService and ContractCreate
///         has a 15M-gas cap + value-forwarding quirks that `forge --broadcast`
///         does not model. This Forge script is the canonical reference + a
///         clean local-EVM / fork dry-run of the proxy-deploy + wiring logic.
///
/// @dev    Reads gov addresses from env (default = deployer on a solo deploy):
///           FACTORY_ADMIN, MARKET_ADMIN, MARKET_TREASURY
///           PERIPHERY_OWNER       (hot ops key)          default = deployer
///           UPGRADE_AUTHORITY     (admin/timelock)       default = FACTORY_ADMIN
///         Optional override of any external dep (else NetworkConfig):
///           SAUCER_V2_ROUTER, SAUCER_V2_NPM, WHBAR_CONTRACT, WHBAR_TOKEN, USDC_TOKEN
///         Optional bootstrap mode (testnet / immediate-ship only) — when
///         BOOTSTRAP_MARKET=1 AND SY_REVIEW_WINDOW is 0, the script also:
///           propose+confirm a pre-deployed SY (env SY_ADDRESS), create a
///           market, call market.setPeriphery(peripheryProxy), and assert
///           the wiring. Requires the deployer to be MARKET_CREATOR / market
///           ADMIN (i.e. ALLOW_DEPLOYER_ADMIN=1 / solo testnet).
///
///         Run (testnet dry-run, NO broadcast):
///           forge script script/Deploy.s.sol --rpc-url $HEDERA_TESTNET_RPC -vvv
///         Broadcast is intentionally left to the operator + the .mjs path.
contract Deploy is Script {
    function run() external {
        address deployer = msg.sender;
        address factoryAdmin = vm.envOr("FACTORY_ADMIN", deployer);
        address marketAdmin = vm.envOr("MARKET_ADMIN", deployer);
        address marketTreasury = vm.envOr("MARKET_TREASURY", deployer);
        address peripheryOwner = vm.envOr("PERIPHERY_OWNER", deployer);
        address upgradeAuthority = vm.envOr("UPGRADE_AUTHORITY", factoryAdmin);

        // Production keeps the 7-day SY review window; bootstrap-only deploys
        // pass 0 to ship markets immediately.
        uint256 syReviewWindow = vm.envOr("SY_REVIEW_WINDOW", uint256(7 days));

        NetworkConfig.Config memory cfg = _resolveConfig();

        console2.log("=== Fission Brain Deploy (UUPS proxies) ===");
        console2.log("  chainId         =", block.chainid);
        console2.log("  deployer        =", deployer);
        console2.log("  factoryAdmin    =", factoryAdmin);
        console2.log("  marketAdmin     =", marketAdmin);
        console2.log("  marketTreasury  =", marketTreasury);
        console2.log("  peripheryOwner  =", peripheryOwner);
        console2.log("  upgradeAuthority=", upgradeAuthority);
        console2.log("  v2Router        =", cfg.v2Router);
        console2.log("  v3Npm           =", cfg.v3Npm);
        console2.log("  whbarContract   =", cfg.whbarContract);
        console2.log("  whbarToken      =", cfg.whbarToken);
        console2.log("  usdc            =", cfg.usdc);

        vm.startBroadcast();

        // ── Market deployers (plain, non-proxy helpers) ──
        StandardMarketDeployer standardDeployer = new StandardMarketDeployer();
        RewardsMarketDeployer rewardsDeployer = new RewardsMarketDeployer();

        // ── Brain 1: FissionFactory (UUPS) ──
        // impl ctor is empty bar _disableInitializers(); state is set by
        // initialize() invoked atomically inside the proxy constructor.
        FissionFactory factoryImpl = new FissionFactory();
        ERC1967Proxy factoryProxy = new ERC1967Proxy(
            address(factoryImpl),
            abi.encodeCall(
                FissionFactory.initialize,
                (factoryAdmin, marketAdmin, marketTreasury, standardDeployer, rewardsDeployer, syReviewWindow)
            )
        );
        FissionFactory factory = FissionFactory(address(factoryProxy));

        // ── Brain 2: FissionPeriphery (UUPS) ──
        // No markets at brain-deploy time → empty pre-register array. Markets
        // are registered later (post market-create) via periphery.registerMarket.
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

        vm.stopBroadcast();

        // ── Post-deploy assertions on the brains (read-backs) ──
        require(factory.SY_REVIEW_WINDOW() == syReviewWindow, "factory: SY_REVIEW_WINDOW mismatch");
        require(factory.hasRole(factory.DEFAULT_ADMIN_ROLE(), factoryAdmin), "factory: admin not set");
        require(factory.hasRole(factory.UPGRADER_ROLE(), factoryAdmin), "factory: upgrader not set");
        require(periphery.owner() == peripheryOwner, "periphery: owner mismatch");
        require(periphery.upgradeAuthority() == upgradeAuthority, "periphery: upgradeAuthority zero/mismatch");
        require(periphery.upgradeAuthority() != address(0), "periphery: upgradeAuthority zero");
        require(periphery.WHBAR_CONTRACT() == cfg.whbarContract, "periphery: whbarContract mismatch");
        require(periphery.V2_ROUTER() == cfg.v2Router, "periphery: v2Router mismatch");
        require(periphery.V3_NPM() == cfg.v3Npm, "periphery: v3Npm mismatch");
        require(lens.upgradeAuthority() == upgradeAuthority, "lens: upgradeAuthority mismatch");

        console2.log("=== Deployed brains ===");
        console2.log("  Factory   (proxy):", address(factory));
        console2.log("  Factory   (impl) :", address(factoryImpl));
        console2.log("  Periphery (proxy):", address(periphery));
        console2.log("  Periphery (impl) :", address(peripheryImpl));
        console2.log("  Lens      (proxy):", address(lens));
        console2.log("  Lens      (impl) :", address(lensImpl));
        console2.log("  StandardDeployer :", address(standardDeployer));
        console2.log("  RewardsDeployer  :", address(rewardsDeployer));

        // ── Optional bootstrap: SY review window == 0 + a pre-deployed SY ──
        // Exercises the full market-create + setPeriphery wiring + asserts.
        bool bootstrap = vm.envOr("BOOTSTRAP_MARKET", uint256(0)) == 1;
        if (bootstrap) {
            require(syReviewWindow == 0, "bootstrap requires SY_REVIEW_WINDOW=0");
            _bootstrapMarket(factory, periphery);
        }

        _writeJson(address(factory), address(periphery), address(lens), deployer);
    }

    /// @dev Resolve external deps from NetworkConfig, allowing per-field env
    ///      overrides. Reverts if the network config is unverified AND no
    ///      override is supplied (testnet must opt-in explicitly).
    function _resolveConfig() internal view returns (NetworkConfig.Config memory cfg) {
        cfg = NetworkConfig.get(block.chainid);
        cfg.v2Router = vm.envOr("SAUCER_V2_ROUTER", cfg.v2Router);
        cfg.v3Npm = vm.envOr("SAUCER_V2_NPM", cfg.v3Npm);
        cfg.whbarContract = vm.envOr("WHBAR_CONTRACT", cfg.whbarContract);
        cfg.whbarToken = vm.envOr("WHBAR_TOKEN", cfg.whbarToken);
        cfg.usdc = vm.envOr("USDC_TOKEN", cfg.usdc);

        require(cfg.v2Router != address(0), "config: v2Router zero");
        require(cfg.v3Npm != address(0), "config: v3Npm zero");
        require(cfg.whbarContract != address(0), "config: whbarContract zero");
        require(cfg.whbarToken != address(0), "config: whbarToken zero");
        require(cfg.usdc != address(0), "config: usdc zero");

        // For an unverified (testnet) config, require an explicit ack so the
        // TODO placeholders can never be silently broadcast.
        if (!cfg.verified) {
            require(
                vm.envOr("ALLOW_UNVERIFIED_CONFIG", uint256(0)) == 1,
                "config: unverified network - set ALLOW_UNVERIFIED_CONFIG=1 after verifying testnet addresses (see NetworkConfig.sol)"
            );
        }
    }

    /// @dev Bootstrap-only path. Proposes+confirms a pre-deployed SY (its
    ///      shareToken already initialized off-script), creates a rewards
    ///      market, wires the freeze-exempt periphery, and asserts. Deployer
    ///      must hold SY_REVIEWER / MARKET_CREATOR on the factory and ADMIN on
    ///      the market (solo testnet: FACTORY_ADMIN == MARKET_ADMIN == deployer).
    function _bootstrapMarket(FissionFactory factory, FissionPeriphery periphery) internal {
        address sy = vm.envAddress("SY_ADDRESS");
        uint256 expiry = vm.envOr("MARKET_EXPIRY", block.timestamp + 90 days);
        int256 scalarRoot = vm.envOr("SCALAR_ROOT", int256(5e18));
        string memory suffix = vm.envOr("MARKET_SUFFIX", string("TESTNET"));
        uint256 marketValue = vm.envOr("MARKET_CREATE_VALUE", uint256(30 ether));

        vm.startBroadcast();
        factory.proposeSY(sy);
        factory.confirmSY(sy); // window == 0 → confirmable immediately
        (, address marketAddr) = factory.createRewardsMarket{value: marketValue}(sy, expiry, scalarRoot, suffix);

        // MDS-2: wire the freeze-exempt periphery as the market ADMIN BEFORE
        // registering/cutover, else periphery-routed flows silently break.
        IMarketAdmin(marketAddr).setPeriphery(address(periphery));
        // Register the market on the periphery so its PT/LP/SY approvals + the
        // freeze-exempt routing are primed.
        periphery.registerMarket(marketAddr);
        vm.stopBroadcast();

        require(IMarketAdmin(marketAddr).periphery() == address(periphery), "wiring: market.periphery mismatch");
        require(periphery.marketRegistered(marketAddr), "wiring: market not registered on periphery");

        // Assert the PT was created WITH a freeze key (freeze-by-default PT is
        // the whole point of the rebuild). The market exposes the PT address;
        // its HTS freeze-key presence is verified by the .mjs path via Mirror
        // Node getTokenInfo. Here we at least assert PT exists + is non-zero.
        address pt = IMarketAdmin(marketAddr).pt();
        require(pt != address(0), "wiring: PT not created");
        console2.log("  Bootstrap market :", marketAddr);
        console2.log("  Bootstrap PT     :", pt);
        console2.log("  (verify PT freeze key via Mirror Node getTokenInfo - see runbook)");
    }

    function _writeJson(address factory, address periphery, address lens, address deployer) internal {
        string memory json = string.concat(
            "{\n",
            '  "chainId": ', _u(block.chainid), ",\n",
            '  "factory": "', vm.toString(factory), '",\n',
            '  "periphery": "', vm.toString(periphery), '",\n',
            '  "lens": "', vm.toString(lens), '",\n',
            '  "deployer": "', vm.toString(deployer), '"\n',
            "}\n"
        );
        string memory path = string.concat("./deployments/", _u(block.chainid), ".json");
        vm.writeFile(path, json);
        console2.log("Wrote", path);
    }

    function _u(uint256 x) internal pure returns (string memory) {
        if (x == 0) return "0";
        uint256 t = x;
        uint256 d;
        while (t != 0) {
            d++;
            t /= 10;
        }
        bytes memory b = new bytes(d);
        while (x != 0) {
            d--;
            b[d] = bytes1(uint8(48 + (x % 10)));
            x /= 10;
        }
        return string(b);
    }
}

/// @dev Minimal interface for the market admin surface used at deploy/wiring
///      time (FissionMarket + FissionRewardsMarket both expose these).
interface IMarketAdmin {
    function setPeriphery(address newPeriphery) external;
    function periphery() external view returns (address);
    function pt() external view returns (address);
}
