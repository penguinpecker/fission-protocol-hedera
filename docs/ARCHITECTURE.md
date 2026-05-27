# Architecture

> Status: design v0.1, post-research. The math, SY strategy, and Hedera conventions below are decided. Implementation begins after this is reviewed.

## Goals

1. **Real on-chain rate sources.** No mock SY, no synthetic underlyings, no TVL theatre. Every market backed by a verifiable Hedera mainnet yield-bearing asset.
2. **Hedera-native UX.** PT/YT minted via HTS precompile so they appear in HashPack/Blade as native tokens. SY/AMM/Router stay as plain Solidity for tooling support. Every token-holding contract sets `maxAutomaticTokenAssociations = -1` (HIP-904).
3. **Audit-ready.** Foundry invariants in CI, Medusa nightly, Halmos on math libs, ≥85 % mutation kill before audit.
4. **Hedera-native multisig governance.** A 2-of-2 Hedera threshold-key account (`ThresholdKey{2, [ECDSA_a, ECDSA_b]}`) sits above an OZ `TimelockController` (48 h delay). No Gnosis Safe contract — the Hedera account itself enforces the 2-of-2 at consensus, matching the HTS-native shape of the rest of the protocol. Immutable cores; Router/adapters upgradeable (UUPS).
5. **No keeper-as-trust-root.** Rate updates TWAP-smoothed and bps-bounded; reverting on suspected manipulation is a feature.

---

## Component map

```
                      ┌─────────────────────┐
  2-of-2 ThresholdKey │ TimelockController  │ ──▶ owner of all admin ops
  (Hedera account)──▶ └─────────────────────┘                (48 h delay)
                                 │
                                 ▼
              ┌───────────────────────────────────┐
              │   FissionFactory  (immutable)     │
              │   - createMarket(SY, maturity)    │
              │   - whitelistSY(addr)  ◀── Penpie │
              │   - HTS create PT/YT via 0x167    │
              └───────────────────────────────────┘
                          │ deploys + HTS-creates
              ┌───────────┴────────────────────────────┐
              ▼                                        ▼
    ┌──────────────────┐                    ┌──────────────────┐
    │ PrincipalToken   │                    │   YieldToken     │
    │ (HTS fungible)   │                    │  (HTS fungible)  │
    └──────────────────┘                    └──────────────────┘
              ▲                                        ▲
              │ supply key = market contract           │
              ▼                                        ▼
              ┌─────────────────────────────────────────┐
              │   FissionMarket  (one per maturity)     │
              │   - Pendle V2 logit + rateAnchor        │
              │   - persists lastLnImpliedRate          │
              │   - LP shares as ERC20                  │
              │   - holds SY, PT, YT                    │
              │   - YT yield via global-index accrual   │
              └─────────────────────────────────────────┘
                          ▲
                          │ multi-step user flows
                          │
              ┌─────────────────────────────────────────┐
              │   FissionPeriphery v3 (owner-only       │
              │     transferOwnership → 48h Timelock)   │
              │   Deterministic 2-tx flows:             │
              │   - zapHbarToSy   → buySyForPt          │
              │   - zapHbarToSy   → buySyForYt          │
              │   - zapHbarToSy   → buySyForLp          │
              │   - sellPtForSy   → unzapSyToHbar       │
              │   - sellYtForSy   → unzapSyToHbar       │
              │   - sellLpForSy   → unzapSyToHbar       │
              │   X-3/X-4/X-5 audit hardenings live:    │
              │     per-side _checkSize, registeredSy   │
              │     adapter gate, isProtectedToken      │
              │     rescue gate.                        │
              └─────────────────────────────────────────┘
                          │
                          ▼
              ┌─────────────────────────────────────────┐
              │   SY adapters  (Pendle-superset 5115)   │
              │   - SaucerSwapLPYieldSource v2          │
              │     (USDC/WHBAR V3 NPM-backed)          │
              │     - sweepHbar() admin recovery        │
              │     - maxAutomaticTokenAssociations=-1  │
              └─────────────────────────────────────────┘
                          │
                          ▼
                    real Hedera mainnet
                    yield-bearing tokens
```

---

## Mathematics (decided — Pendle V2 faithful port)

The previous codebase recomputed price from `(reserveSY, reservePT, scalarRoot, timeToExpiry)` only. That makes price drift between blocks with no trades and lets large swaps drain at pre-swap prices. **We do not repeat that.** Instead we port `MarketMathCore` faithfully.

### Pool state (persisted)

```solidity
struct MarketState {
    int256  totalSY;        // SY balance
    int256  totalPT;        // PT balance
    int256  totalLP;        // LP supply
    int256  scalarRoot;     // immutable per market
    uint256 expiry;         // immutable
    uint256 lnFeeRateRoot;  // governance-set, capped
    uint256 lastLnImpliedRate;  // persists between trades — THE anchor
}
```

### Per-trade computation

Let `t = expiry − now`, `IMPLIED_RATE_TIME = 365 days`.

```
rateScalar      = scalarRoot * IMPLIED_RATE_TIME / t
preTradeExchRate = exp( lastLnImpliedRate * t / IMPLIED_RATE_TIME )
proportion0     = totalPT / (totalPT + totalAsset)        // totalAsset = totalSY * sy.exchangeRate / 1e18
lnProportion0   = ln( proportion0 / (1 − proportion0) )
rateAnchor      = preTradeExchRate − lnProportion0 / rateScalar

# trade: netPtToAccount > 0 means user is buying PT
proportion      = (totalPT − netPtToAccount) / (totalPT + totalAsset)
preFeeExchRate  = ln( proportion / (1 − proportion) ) / rateScalar + rateAnchor

# fee on the rate, sign depends on direction
feeRate         = exp( lnFeeRateRoot * IMPLIED_RATE_TIME / t )
postFeeExchRate = preFeeExchRate * (buy ? feeRate : 1/feeRate)

netSyToAccount  = − netPtToAccount * 1e18 / postFeeExchRate    # what the user pays/receives in SY

# state update
lastLnImpliedRate = ln(postFeeExchRate) * IMPLIED_RATE_TIME / t
totalPT += −netPtToAccount
totalSY += −netSyToAccount
```

Adding/removing liquidity is **strictly proportional** — does NOT touch `lastLnImpliedRate`.

### YT yield accrual (the v1 bug we are not repeating)

The previous codebase paid yield from `SY.balanceOf(core)` while the only inflow was `split()`. Insolvent by design.

Correct pattern (from `PendleYieldToken`):

```
# at every external entry that touches a user:
currentSyExchangeRate = SY.exchangeRate()
globalIndex = max(globalIndex, currentSyExchangeRate)

userYieldOwed += YTBalance * (globalIndex − userIndex) / globalIndex
userIndex = globalIndex
```

PT redeems for `pt * 1e18 / globalIndex` SY at maturity (NOT 1:1). The growth surplus is what funds YT yield. **Conservation invariant**: `totalSyHeld * globalIndex >= PT.totalSupply * 1e18 + sum(userYieldOwed) * globalIndex` always — Halmos-proven, Foundry-fuzzed.

After expiry, undistributed yield flows to a treasury address (configurable, defaults to the Safe).

---

## ERC-5115 (Pendle superset) — the SY interface

Implement the full Pendle interface, not the minimal EIP:

```solidity
enum AssetType { TOKEN, LIQUIDITY }

interface IStandardizedYield is IERC20 {
    function deposit(address receiver, address tokenIn, uint256 amountIn, uint256 minSharesOut)
        external payable returns (uint256 sharesOut);
    function redeem(address receiver, uint256 shares, address tokenOut, uint256 minOut, bool burnFromInternal)
        external returns (uint256 amountOut);

    function exchangeRate() external view returns (uint256);                  // 1e18-scaled, asset per share
    function previewDeposit(address tokenIn, uint256 amountIn) external view returns (uint256);
    function previewRedeem(address tokenOut, uint256 shares) external view returns (uint256);

    function getTokensIn() external view returns (address[] memory);
    function getTokensOut() external view returns (address[] memory);
    function isValidTokenIn(address) external view returns (bool);
    function isValidTokenOut(address) external view returns (bool);

    function assetInfo() external view returns (AssetType, address asset, uint8 decimals);

    function getRewardTokens() external view returns (address[] memory);
    function claimRewards(address user) external returns (uint256[] memory);
    function accruedRewards(address user) external view returns (uint256[] memory);
    function rewardIndexesCurrent() external returns (uint256[] memory);
    function rewardIndexesStored() external view returns (uint256[] memory);

    function yieldToken() external view returns (address);
}
```

Markets only accept SY tokens whitelisted by `FissionFactory` (Penpie defence).

---

## SY adapter strategy

| Adapter            | Underlying                       | `assetType` | Rate source                                 |
|--------------------|----------------------------------|-------------|---------------------------------------------|
| `SY_HBARX`         | HBARX (`0.0.834116`)             | TOKEN       | Stader staking contract direct read         |
| `SY_SaucerSwapV1LP`| SaucerSwap **V1** HBAR-USDC LP   | LIQUIDITY   | `(reserve0_now * twapPrice + reserve1_now) / totalSupply` |
| `SY_BonzoUSDC`     | Bonzo bUSDC (Aave-fork bToken)   | TOKEN       | Bonzo `getReserveNormalizedIncome` direct read |

**No SaucerSwap V2 in v1 of the protocol.** V2 NFT positions are a future feature — wrapped via a custom ERC-4626 vault that holds a single fixed-range NFT and recycles on rebalance.

### Why V1 LPs work and V2 doesn't (yet)

SaucerSwap V1 is a Uniswap V2 fork. V1 LP tokens are HTS-fungible — they respond to `IERC20.balanceOf/totalSupply/transfer`. The pool's reserves grow from swap fees in-place, so `(reserves) / totalSupply` rises monotonically at a rate proportional to fee APR. This is exactly the "single ERC20 with a fee-on-balance" semantics ERC-5115 wants.

SaucerSwap V2 is Uniswap V3-style — concentrated liquidity, NFT positions, no per-share global price. To use V2 we'd need a vault that owns one NFT, rebalances on out-of-range events, and exposes ERC-5115 share semantics. That's a separate audit scope; not v1.

### Rate-keeper hardening

Keeper posts rate hourly. Hardening (from Pendle Boros lessons + Penpie post-mortem):

- **Bps-bounded delta**: max 50 bps per update.
- **Min interval**: 1 h between posts.
- **TWAP**: contract stores last 6 posts as a ring buffer; `exchangeRate()` returns the median. Atomic sandwich attacks see the median, not the spike.
- **Bidirectional**: rate CAN decrease (slashing path); accept negative deltas but bps-cap them too.
- **Circuit breaker**: if any single post would deviate >200 bps from current TWAP, revert and pause the SY automatically. Owner unpauses with timelock.

---

## Governance — final shape

- **Owner**: a Hedera account whose key is `ThresholdKey{2, [ECDSA_a, ECDSA_b]}`. Created via SDK (`AccountCreateTransaction.setKey(threshold)`). Enforces 2-of-2 signing at the Hedera consensus layer; from the EVM's perspective the account is just one address (its EVM alias). No Gnosis Safe contract is deployed.
- **TimelockController** (OZ, EVM): 48 h delay on every owner-gated function. Proposers + executors = the threshold account's EVM alias; admin = `address(0)` (renounced). Cancel reserved to the same 2-of-2 (no separate emergency multisig in v1).
- **Roles** (`AccessControlDefaultAdminRules`):
  - `DEFAULT_ADMIN_ROLE`: Timelock only.
  - `PAUSER_ROLE`: 2-of-2 threshold account directly (no timelock — must act fast).
  - `KEEPER_ROLE`: keeper EOA, rate-post-only
  - `TREASURY_ROLE`: receives post-expiry yield surplus
- **No EOA roles in production.** Deployer revokes itself after handoff.
- **Upgradeability**: cores immutable (Factory, Market, PT, YT). Router + SY adapters UUPS, owned by timelock. New SY adapters added via factory whitelist after a public 7-day review window.

---

## Hedera EVM 2026 conventions (decided)

| Convention                                                       | Decision                                          |
|------------------------------------------------------------------|---------------------------------------------------|
| Token association                                                | All token-holding contracts set `maxAutomaticTokenAssociations = -1` (HIP-904). Auto-assoc on user receive via Router. |
| Address aliases                                                  | Always EVM-address alias from Mirror Node. Never construct long-zero (HIP-1217). |
| HTS calls                                                        | ERC-20 facade for transfer/approve/balanceOf. 0x167 only for create/mint/burn. Never `delegatecall` HTS. |
| Production RPC                                                   | Validation Cloud (primary) + Arkhia (fallback). Hashio is dev/test only. |
| Local dev                                                        | Solo (replaces deprecated Hiero local node by Sept 2026) for HTS-faithful sims; `anvil --fork-url Hashio` for fast EVM-only fuzz loops. |
| Solidity                                                         | 0.8.27, Cancun EVM, viaIR, optimizer 1M runs, transient-storage reentrancy guards. |

---

## Security assumptions and mitigations

| Assumption                                                | Mitigation                                       |
|-----------------------------------------------------------|--------------------------------------------------|
| Underlying SY has bounded rate movement                   | per-update bps cap + circuit breaker             |
| Keeper key is honest                                      | TWAP smoothing + bounded posts; multisig fallback|
| HTS precompile is non-reentrant                           | `ReentrancyGuardTransient` + post-Cancun verify  |
| External SY contracts are non-malicious (Penpie pattern)  | factory whitelist + 7-day review window          |
| Hedera mirror node is eventually consistent               | never used on hot path                           |
| User account is ECDSA (has EVM alias)                     | Router rejects long-zero callers                 |

---

## Audit pipeline

1. **Internal**: Slither + Aderyn + Mythril in CI; Foundry invariants every PR; Medusa nightly; ≥85 % mutation kill (Vertigo / Gambit) before external review.
2. **Hedera-specialist pre-audit**: HashEx or Hacken (~$30-50 K, 2-3 weeks) — HTS / precompile / association edge cases.
3. **Primary audit**: ChainSecurity (Pendle V2 + Boros experience) or Spearbit/Cantina (~$150-200 K, 6 weeks).
4. **Public contest**: Code4rena or Sherlock (~$80-120 K, 14 days) post-fix.
5. **Bug bounty**: Immunefi at launch, $50 K cap scaling to 10 % TVL.

Total audit budget: **$280-380 K**, calendar time: **~4 months from feature-freeze to mainnet**.
