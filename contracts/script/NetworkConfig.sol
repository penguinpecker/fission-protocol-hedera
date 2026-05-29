// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title  NetworkConfig — per-network external dependency addresses for Fission.
/// @notice ONE place that resolves the SaucerSwap V2 router, V3
///         NonfungiblePositionManager, WHBAR system contract + WHBAR token, and
///         USDC token for the chain the deploy is running against. Both the
///         first-time `Deploy.s.sol` (testnet/mainnet) and the full
///         `MainnetDeploy.s.sol` read from here so the SAME deploy logic works
///         on Hedera testnet (chain 296) and mainnet (chain 295) with only this
///         address block differing.
///
///         MAINNET (295) values are PINNED + verified — sourced from
///         deployments/295.json (`external` block) and MainnetAddresses.sol.
///
///         TESTNET (296) values are RESEARCH PLACEHOLDERS — derived from the
///         SaucerSwap docs "Contract Deployments" page + Circle USDC docs
///         (2026-05-29). They are encoded as Hedera long-zero EVM addresses
///         (account-num → 20-byte). Anything marked `// TODO(testnet)` is NOT
///         confirmed against an authoritative on-chain source and MUST be
///         verified (Mirror Node ABI-ping) before any testnet broadcast — see
///         docs/DEPLOY_RUNBOOK.md.
library NetworkConfig {
    struct Config {
        // SaucerSwap V2 SwapRouter (Uniswap-V3-style router used by the
        // Periphery's zap/unzap swap legs).
        address v2Router;
        // SaucerSwap V2 NonfungiblePositionManager — the SY adapter mints its
        // fixed V3-style LP position here; the Periphery also references it.
        address v3Npm;
        // WHBAR *system contract* (wrap/unwrap native HBAR <-> WHBAR token).
        address whbarContract;
        // WHBAR HTS *token* (the ERC-20 facade WHBAR).
        address whbarToken;
        // USDC HTS token.
        address usdc;
        // Whether every field above is confirmed for this network. Forge
        // scripts hard-revert when this is false unless explicitly overridden
        // by env, so a half-known testnet config can never be silently
        // broadcast.
        bool verified;
    }

    // ─────────────────────────── chain ids ───────────────────────────
    uint256 internal constant HEDERA_MAINNET = 295;
    uint256 internal constant HEDERA_TESTNET = 296;

    // ─────────────────────── mainnet (295) — PINNED ──────────────────
    // Source: deployments/295.json `external` + script/MainnetAddresses.sol.
    address internal constant MAINNET_V2_ROUTER = 0x00000000000000000000000000000000003c437A; // 0.0.3949434
    address internal constant MAINNET_V3_NPM = 0x00000000000000000000000000000000003DDbb9; // 0.0.4053945
    address internal constant MAINNET_WHBAR_CONTRACT = 0x0000000000000000000000000000000000163B59; // 0.0.1456985
    address internal constant MAINNET_WHBAR_TOKEN = 0x0000000000000000000000000000000000163B5a; // 0.0.1456986
    address internal constant MAINNET_USDC = 0x000000000000000000000000000000000006f89a; // 0.0.456858

    // ───────────────── testnet (296) — RESEARCH PLACEHOLDERS ─────────
    // Sourced 2026-05-29 from docs.saucerswap.finance "Contract Deployments"
    // (testnet section) + Circle USDC-on-testing-networks. Long-zero EVM forms
    // computed from the documented Hedera account IDs.
    //
    //   SaucerSwapV2SwapRouter        0.0.1414040 -> 0x0000…00159398
    //   SaucerSwapV2 NPM              0.0.1308184 -> 0x0000…0013f618
    //   WHBAR system contract         0.0.15057   -> 0x0000…00003ad1
    //   WHBAR HTS token               0.0.15058   -> 0x0000…00003ad2
    //   USDC (Circle testnet)         0.0.13078?  -> 0x0000…00003316  (UNCONFIRMED)
    //
    // The WhbarHelper (0.0.5286055 -> 0x0000…0050a8a7) is a SEPARATE convenience
    // contract; the Periphery wants the WHBAR *system contract* whose token is
    // exactly token-1 (15057 ↔ 15058), mirroring the mainnet 163B59 ↔ 163B5a
    // pairing. Verify which one the live Periphery flow needs on testnet.
    address internal constant TESTNET_V2_ROUTER = 0x0000000000000000000000000000000000159398; // TODO(testnet): verify 0.0.1414040
    address internal constant TESTNET_V3_NPM = 0x000000000000000000000000000000000013F618; // TODO(testnet): verify 0.0.1308184
    address internal constant TESTNET_WHBAR_CONTRACT = 0x0000000000000000000000000000000000003aD1; // TODO(testnet): verify 0.0.15057
    address internal constant TESTNET_WHBAR_TOKEN = 0x0000000000000000000000000000000000003aD2; // TODO(testnet): verify 0.0.15058
    address internal constant TESTNET_USDC = 0x0000000000000000000000000000000000003316; // TODO(testnet): UNCONFIRMED (0.0.13078 vs others)

    /// @notice Resolve the external-dependency config for the current chain id.
    /// @dev    Reverts on an unrecognised chain so a deploy can never run with a
    ///         zeroed config. Testnet returns `verified = false`; callers should
    ///         gate broadcasts on it (or override each field via env).
    function get(uint256 chainId) internal pure returns (Config memory c) {
        if (chainId == HEDERA_MAINNET) {
            return Config({
                v2Router: MAINNET_V2_ROUTER,
                v3Npm: MAINNET_V3_NPM,
                whbarContract: MAINNET_WHBAR_CONTRACT,
                whbarToken: MAINNET_WHBAR_TOKEN,
                usdc: MAINNET_USDC,
                verified: true
            });
        }
        if (chainId == HEDERA_TESTNET) {
            return Config({
                v2Router: TESTNET_V2_ROUTER,
                v3Npm: TESTNET_V3_NPM,
                whbarContract: TESTNET_WHBAR_CONTRACT,
                whbarToken: TESTNET_WHBAR_TOKEN,
                usdc: TESTNET_USDC,
                verified: false // TODO(testnet): flip to true once the addresses above are on-chain-verified
            });
        }
        revert("NetworkConfig: unsupported chainId");
    }
}
