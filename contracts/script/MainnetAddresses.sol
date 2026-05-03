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
    /// @dev    Verified 2026-05-02: `getExchangeRate()` selector `0xe6aa216c` returns
    ///         uint256 scaled to 8 decimals. 30-day strict monotonicity confirmed via
    ///         721 hourly samples; ~5.79% APY. Preflight script still ABI-pings to
    ///         catch any contract upgrade between research and deploy.
    address internal constant STADER_STAKING = 0x0000000000000000000000000000000000158d97;

    // ─── Bonzo Finance (Aave V2 fork) ─────────────────────────────────────

    /// @notice Bonzo LendingPool — Aave V2 pool exposing
    ///         `getReserveNormalizedIncome(asset)` returning a 1e27 ray.
    ///         Verified via docs.bonzo.finance: 0.0.7308459.
    address internal constant BONZO_POOL = 0x236897c518996163E7b313aD21D1C9fCC7BA1afc;

    /// @notice Bonzo bUSDC aToken — receipt token for USDC supplied to the pool.
    ///         Verified: 0.0.7308496.
    address internal constant BONZO_BUSDC = 0xB7687538c7f4CAD022d5e97CC778d0b46457c5DB;

    // ─── SaucerSwap V2 (Uniswap V3 fork) ──────────────────────────────────

    /// @notice SaucerSwap V2 WHBAR-USDC 0.15% pool. Verified 2026-05-02 via Mirror
    ///         Node + GeckoTerminal: $7.9M TVL, ~$400K daily volume, tickSpacing 30.
    ///         token0 = USDC (6 dec), token1 = WHBAR (8 dec).
    address internal constant SAUCER_V2_WHBAR_USDC_POOL = 0xC5B707348dA504E9Be1bD4E21525459830e7B11d;

    /// @notice SaucerSwap V2 NonFungiblePositionManager. UNCONFIRMED at compile time —
    ///         deploy script reads from `SAUCER_V2_NPM` env var, and preflight ABI-pings
    ///         `mint`/`positions` selectors before broadcast. See
    ///         https://docs.saucerswap.finance/developerx/contract-deployments for the
    ///         current canonical address (matches Uniswap V3 NPM ABI).
    address internal constant SAUCER_V2_NPM_PLACEHOLDER = address(0);

    /// @notice WHBAR (wrapped HBAR ERC-20 facade). Used as token1 of the V2 pool.
    ///         Source: SaucerSwap docs.
    address internal constant WHBAR = 0x0000000000000000000000000000000000163B5a;

    /// @notice V2 pool fee tier — 1500 = 0.15%.
    uint24 internal constant SAUCER_V2_FEE = 1500;

    /// @notice Default tick range for the SaucerSwap V2 SY's fixed position. Full-range
    ///         is the conservative default — earns ~1.84% APR (per 30-day analysis) but
    ///         is never out-of-range and requires no rebalance. Tighter ranges (e.g.
    ///         ±5% / ±10%) earn meaningfully more but go to zero yield when price exits.
    ///         Override via `SAUCER_V2_TICK_LOWER` / `SAUCER_V2_TICK_UPPER` env vars.
    int24 internal constant SAUCER_V2_TICK_LOWER_DEFAULT = -887220; // tickSpacing 30 * -29574
    int24 internal constant SAUCER_V2_TICK_UPPER_DEFAULT = 887220;  // tickSpacing 30 *  29574
}
