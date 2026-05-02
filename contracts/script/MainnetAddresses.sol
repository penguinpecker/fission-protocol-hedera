// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title  MainnetAddresses — pinned Hedera mainnet (chain 295) addresses for Fission.
/// @notice Sources verified 2026-05-02 via Mirror Node + Bonzo docs.
///         Anything marked UNVERIFIED is a constructor-time risk: the preflight
///         script ABI-pings each before deploy and reverts if the call shape
///         doesn't match expectations.
library MainnetAddresses {
    // ─── HTS tokens ───────────────────────────────────────────────────────

    /// @notice HBARX — Stader's liquid HBAR staking token. Verified via Mirror Node:
    ///         0.0.834116, 8 decimals, treasury 0.0.1412503.
    address internal constant HBARX = 0x00000000000000000000000000000000000cbA44;

    /// @notice USDC[HTS] -- Circle's native USDC on Hedera. 0.0.456858, 6 decimals.
    address internal constant USDC = 0x000000000000000000000000000000000006f89a;

    // ─── Stader (HBARX staking) ───────────────────────────────────────────

    /// @notice Stader's HBARX staking contract — holds the supply key for HBARX
    ///         (verified via Mirror Node: 0.0.834116's supply_key encodes contractID
    ///         0.0.1412503). Deployed 2022-11-06.
    /// @dev    UNVERIFIED that this exact contract exposes `getExchangeRate()` with
    ///         the selector our SY_HBARX expects. Preflight ABI-pings it.
    address internal constant STADER_STAKING = 0x0000000000000000000000000000000000158d97;

    // ─── Bonzo Finance (Aave V2 fork) ─────────────────────────────────────

    /// @notice Bonzo LendingPool — Aave V2 pool exposing
    ///         `getReserveNormalizedIncome(asset)` returning a 1e27 ray.
    ///         Verified via docs.bonzo.finance: 0.0.7308459.
    address internal constant BONZO_POOL = 0x236897c518996163E7b313aD21D1C9fCC7BA1afc;

    /// @notice Bonzo bUSDC aToken — receipt token for USDC supplied to the pool.
    ///         Verified: 0.0.7308496.
    address internal constant BONZO_BUSDC = 0xB7687538c7f4CAD022d5e97CC778d0b46457c5DB;

    // ─── SaucerSwap V1 (Uniswap V2 fork) ──────────────────────────────────

    /// @notice SaucerSwap V1 HBAR-USDC LP token. UNCONFIRMED — pending HashScan /
    ///         SaucerSwap subgraph lookup. The deploy script reads the actual address
    ///         from env (SAUCER_V1_LP) and the preflight script reverts if the contract
    ///         doesn't expose Uniswap-V2-style `getReserves`/`totalSupply`.
    /// @dev    `0xc5b707348da504e9be1bd4e21525459830e7b11d` is the SaucerSwap V2 HBAR-USDC
    ///         pool — that's a Uni V3 NFT fork and is NOT compatible with our SY_SaucerSwapV1LP
    ///         (it doesn't expose per-share virtual price). Do NOT use it for this adapter.
    address internal constant SAUCER_V1_HBAR_USDC_LP_PLACEHOLDER = address(0);
}
