// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {FissionFactory} from "../../src/core/FissionFactory.sol";
import {StandardMarketDeployer} from "../../src/core/StandardMarketDeployer.sol";
import {RewardsMarketDeployer} from "../../src/core/RewardsMarketDeployer.sol";

/// @dev Tests previously called `new FissionFactory(admin, marketAdmin, treasury)` —
///      the post-Hedera factory takes two extra deployer addresses for bytecode
///      isolation. The factory is now UUPS-upgradeable, so this helper deploys the
///      implementation, wraps it in an ERC1967Proxy, and initializes through the
///      proxy in one call. The returned handle is the PROXY (stable across upgrades).
library FactoryTestHelper {
    function deploy(address admin, address marketAdmin, address treasury) internal returns (FissionFactory) {
        StandardMarketDeployer s = new StandardMarketDeployer();
        RewardsMarketDeployer r = new RewardsMarketDeployer();
        // 7 days for tests so the existing window-revert tests still validate the logic.
        return deployWithDeployers(admin, marketAdmin, treasury, s, r, 7 days);
    }

    /// @notice Lower-level variant exposing the deployers + review window, used by
    ///         tests that need to construct the impl/proxy themselves or assert
    ///         on the zero-address reverts.
    function deployWithDeployers(
        address admin,
        address marketAdmin,
        address treasury,
        StandardMarketDeployer s,
        RewardsMarketDeployer r,
        uint256 reviewWindow
    ) internal returns (FissionFactory) {
        FissionFactory impl = new FissionFactory();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(impl),
            abi.encodeCall(FissionFactory.initialize, (admin, marketAdmin, treasury, s, r, reviewWindow))
        );
        return FissionFactory(address(proxy));
    }
}
