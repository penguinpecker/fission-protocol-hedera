// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {SY_HBARX} from "../src/sy/SY_HBARX.sol";

/// @title DeploySY_HBARX — deploys an SY_HBARX adapter pointing at the live HBARX
///        token + Stader rate oracle. Reads addresses from env so the same script
///        works on testnet (with mocks) and mainnet (with real Stader).
/// @dev   Required env:
///          HBARX_ADDRESS            — HBARX HTS token, EVM-aliased
///          STADER_ORACLE_ADDRESS    — Stader contract exposing getExchangeRate()
///          SY_ADMIN                 — admin role on the SY (Safe)
///          KEEPER_ADDRESS           — gets KEEPER_ROLE post-deploy
contract DeploySY_HBARX is Script {
    function run() external {
        address hbarx = vm.envAddress("HBARX_ADDRESS");
        address stader = vm.envAddress("STADER_ORACLE_ADDRESS");
        address admin = vm.envAddress("SY_ADMIN");
        address keeper = vm.envAddress("KEEPER_ADDRESS");

        console2.log("Deploying SY_HBARX with:");
        console2.log("  hbarx  =", hbarx);
        console2.log("  stader =", stader);
        console2.log("  admin  =", admin);
        console2.log("  keeper =", keeper);

        vm.startBroadcast();
        SY_HBARX sy = new SY_HBARX(hbarx, stader, admin, 0);
        sy.grantRole(sy.KEEPER_ROLE(), keeper);
        vm.stopBroadcast();

        console2.log("SY_HBARX:", address(sy));
    }
}
