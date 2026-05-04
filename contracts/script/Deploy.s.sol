// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {FissionFactory} from "../src/core/FissionFactory.sol";
import {StandardMarketDeployer} from "../src/core/StandardMarketDeployer.sol";
import {RewardsMarketDeployer} from "../src/core/RewardsMarketDeployer.sol";
import {ActionRouter} from "../src/periphery/ActionRouter.sol";

/// @title  Deploy — first-time deploy of Factory + Router on Hedera (testnet/mainnet).
/// @notice Run as:
///   forge script script/Deploy.s.sol \
///     --rpc-url $HEDERA_TESTNET_RPC \
///     --private-key $HEDERA_OPERATOR_KEY \
///     --broadcast --slow
/// @dev    Reads all gov addresses from env so a deploy is reproducible from CI:
///           - FACTORY_ADMIN          (Safe; default = deployer for testnet)
///           - MARKET_ADMIN           (Safe; default = deployer)
///           - MARKET_TREASURY        (Safe; default = deployer)
///         Writes deployed addresses to /deployments/{chainId}.json post-broadcast.
contract Deploy is Script {
    function run() external {
        address deployer = msg.sender;
        address factoryAdmin = vm.envOr("FACTORY_ADMIN", deployer);
        address marketAdmin = vm.envOr("MARKET_ADMIN", deployer);
        address marketTreasury = vm.envOr("MARKET_TREASURY", deployer);

        console2.log("Deploying with:");
        console2.log("  deployer       =", deployer);
        console2.log("  factory admin  =", factoryAdmin);
        console2.log("  market admin   =", marketAdmin);
        console2.log("  treasury       =", marketTreasury);
        console2.log("  chainId        =", block.chainid);

        vm.startBroadcast();
        StandardMarketDeployer standardDeployer = new StandardMarketDeployer();
        RewardsMarketDeployer rewardsDeployer = new RewardsMarketDeployer();
        // Production deploys keep the 7-day SY review window; bootstrap-only
        // deploys can pass 0 to ship markets immediately.
        uint256 syReviewWindow = vm.envOr("SY_REVIEW_WINDOW", uint256(7 days));
        FissionFactory factory = new FissionFactory(
            factoryAdmin, marketAdmin, marketTreasury, standardDeployer, rewardsDeployer, syReviewWindow
        );
        ActionRouter router = new ActionRouter();
        vm.stopBroadcast();

        console2.log("Factory:", address(factory));
        console2.log("Router :", address(router));

        // Write addresses for the frontend / keeper to consume.
        string memory json = string.concat(
            "{\n",
            '  "chainId": ', _u(block.chainid), ",\n",
            '  "factory": "', vm.toString(address(factory)), '",\n',
            '  "router":  "', vm.toString(address(router)), '",\n',
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
