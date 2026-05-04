// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FissionFactory} from "../../src/core/FissionFactory.sol";
import {StandardMarketDeployer} from "../../src/core/StandardMarketDeployer.sol";
import {RewardsMarketDeployer} from "../../src/core/RewardsMarketDeployer.sol";

/// @dev Tests previously called `new FissionFactory(admin, marketAdmin, treasury)` —
///      the post-Hedera factory takes two extra deployer addresses for bytecode
///      isolation. This helper deploys both deployers + the factory in one call.
library FactoryTestHelper {
    function deploy(address admin, address marketAdmin, address treasury) internal returns (FissionFactory) {
        StandardMarketDeployer s = new StandardMarketDeployer();
        RewardsMarketDeployer r = new RewardsMarketDeployer();
        return new FissionFactory(admin, marketAdmin, treasury, s, r);
    }
}
