# Fission Protocol — Hedera

**Tokenize the Yield.** Fixed-rate and perpetual yield markets on Hedera.

Fission splits a yield-bearing position into two on-chain tokens:

| Token | Role |
|-------|------|
| **PT** | Principal Token — redeems 1:1 for the underlying at maturity (the bond) |
| **YT** | Yield Token — perpetual claim on the yield stream (the variance bet) |

PT and SY trade against each other on a Pendle-V2-style logit-curve AMM with a separate **LP** token for market-makers. Every primitive — PT, YT, LP, and SY shares — is a native HTS token, visible in HashPack and any Hedera-aware wallet.

| | |
|---|---|
| **Live** | [fissionp.com](https://www.fissionp.com) |
| **Network** | Hedera mainnet (chain ID 295) |
| **Status** | v1 in production · single market live · internal audits closed (0 H / 0 M / 0 C) · external audit pending |

---

## Contents

- [Architecture](#architecture)
- [The three roles](#the-three-roles)
- [Live contracts](#live-contracts-chain-295)
- [Governance](#governance)
- [Fees](#fees)
- [Audits & security](#audits--security)
- [Docs](#docs)
- [License](#license)

---

## Architecture

```
                                ┌──────────────────────────────────────┐
                                │  SaucerSwap V2 WHBAR/USDC 0.15% pool │
                                │  (external — the yield source)       │
                                └─────────────────┬────────────────────┘
                                                  │ trading fees pro-rata
                                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                       SY_SaucerSwapV2LP (ERC-5115)                      │
│   wraps one V3-style LP NFT  ·  mints SY shares 1:1 with NFT liquidity  │
│   harvests WHBAR + USDC fees on demand (claimRewards)                   │
└──────────────────────────┬──────────────────────────────────────────────┘
                           │ SY shares
                           ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                FissionMarketRewards  (Market 0, 90-day term)            │
│                                                                         │
│   split(SY)            ──►  PT + YT                                     │
│   merge(PT, YT)        ──►  SY                                          │
│   swapExactSyForPt     ◄──►  PT  ⟷  SY  via logit-curve AMM             │
│   addLiquidity(SY+PT)  ──►  LP   (market-maker side)                    │
│   reward index per YT  ──►  WHBAR + USDC payouts                        │
└─────┬────────┬──────────────────────────────────────────────────────────┘
      │        │
      │        └─────► HTS tokens (in user wallets)
      │                  PT  · YT (frozen, AMM-only) · LP
      │
      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                       ActionRouter v3 (periphery)                       │
│   depositAndSplit · swapExactSyForPt · buyYT · addLiquidityProportional │
│   removeLiquidityProportional · redeemAfterExpiryAndUnwrap              │
│   FissionZap (one-tx HBAR → SY) wraps WHBAR, swaps half to USDC, deposit│
└─────────────────────────────────────────────────────────────────────────┘
                           ▲
                           │ user-facing entry points
                           │
                ┌──────────┴──────────┐
                │  /markets · /trade  │
                │   Next.js dApp      │
                └─────────────────────┘

Governance:  2-of-2 Hedera ThresholdKey  ──►  Timelock (48h)  ──►  contracts
             (operator ECDSA + cosigner Ed25519)
```

**Why this shape:** SaucerSwap V2 positions are concentrated-liquidity NFTs (Uniswap V3 fork), so the standard "yield rate growth" pattern doesn't apply. Fission uses the **reward-streaming** pattern:

- SY's `exchangeRate` is constant at `1e18`
- Trading fees are pushed to YT holders proportionally via a per-share reward index
- YT is a **perpetual** claim — it does not expire at the term boundary; only the PT/YT split rate does

---

## The three roles

| Role | What you hold | Pays out | Risk shape |
|------|---------------|----------|------------|
| **PT** | Principal Token (HTS) | 1 SY at maturity (fixed return = buy-time discount) | Low — return locked at buy; protected by SY held in the market |
| **YT** | Yield Token (HTS, AMM-only) | Continuous WHBAR + USDC from the SY's harvested fees | High — leveraged exposure to SaucerSwap V2 trading volume |
| **LP** | LP Token (HTS) | 99% of Fission AMM swap fees (1% → treasury) | Medium — Pendle-V2-style "imp-loss" on PT/SY divergence |

**Redemption & pricing**

- At maturity, **1 PT redeems for 1 SY** (1:1, unconditional).
- LP `removeLiquidity` post-expiry auto-redeems the LP's PT share for SY so post-expiry exits never compete with PT redeemers for backing.
- PT and YT are minted in a 1:1 split: `1 SY = 1 PT + 1 YT`.
- By the Pendle identity, `PT price + YT price = 1 SY` at all times (pre- and post-expiry).

---

## Live contracts (chain 295)

All deployments are tracked in [`deployments/295.json`](deployments/295.json). HashScan links open the contract page directly.

### Core protocol *(2026-05-27 clean-slate redeploy + audit-pass-2 fixes)*

| Contract | EVM | Hedera ID | HashScan |
|----------|-----|-----------|----------|
| **FissionFactory** | `0x799549F698bBBAc90B9e1C37eF3946A1A1d3397c` | `0.0.10495346` | [view](https://hashscan.io/mainnet/contract/0.0.10495346) |
| **FissionPeriphery v3** *(consolidates Zap+MegaZap+Unzap+Gateway+Router)* | `0x0000000000000000000000000000000000a02731` | `0.0.10495793` | [view](https://hashscan.io/mainnet/contract/0.0.10495793) |
| **FissionLens** | `0xa1aAfc8C11A686a3Dee5DfE8B19D9eB43d321969` | `0.0.10495350` | [view](https://hashscan.io/mainnet/contract/0.0.10495350) |
| **SaucerSwapLPYieldSource v2** *(with `sweepHbar`)* | `0x0000000000000000000000000000000000a0289a` | `0.0.10496154` | [view](https://hashscan.io/mainnet/contract/0.0.10496154) |
| **Market — `USDC-WHBAR-2026-08-25-v3`** | `0xfD33CCB2385EC20C4B7bc682712fb92e01e87D5f` | `0.0.10496157` | [view](https://hashscan.io/mainnet/contract/0.0.10496157) |
| StandardMarketDeployer | `0xdbDf8da50240F21DFc1ed6c44e3a5806AFDcC9bF` | `0.0.10495325` | [view](https://hashscan.io/mainnet/contract/0.0.10495325) |
| RewardsMarketDeployer | `0x63A75EaaB07feeBc48226A6eaF3Cbb057614e537` | `0.0.10495326` | [view](https://hashscan.io/mainnet/contract/0.0.10495326) |

**User flow (2-tx deterministic):**
- Buy: `Periphery.zapHbarToSy` → `Periphery.buySyForPt / buySyForYt / buySyForLp`
- Sell: `Periphery.sellPtForSy / sellYtForSy / sellLpForSy` → `Periphery.unzapSyToHbar`

Old contracts (ActionRouter v3, FissionZap, MegaZap, FissionUnzap, FissionGateway v2/v2.1, prior Peripheries v1/v2) are abandoned but on-chain; they receive no new traffic from the dApp. See `deployments/295.json` for the full historical record.

#### Sourcify verification

Programmatic Sourcify verification against the HashScan endpoint is currently flaky for `via_ir = true` artifacts (HTTP 500 "unexpected end of form"). Manual upload via HashScan UI (`https://hashscan.io/mainnet/contract/<entity_id>/source`) is the workaround. Source in this repo is byte-identical to what's deployed; anyone can recompile + cross-reference against the deployed bytecode (`cast code <addr>`).

> **2026-05-27 clean-slate redeploy + audit pass-2**
>
> The current contract set replaces every prior on-chain instance (going back through three Periphery iterations + two SY adapters + two markets). Reasons across the cycle:
>
> - **Ed25519 reward-accrual bug** (2026-05-22 cycle, now fixed) — HTS facade `balanceOf` returned 0 for long-zero Ed25519 EVM addresses. Resolved by tracking YT balances in `_ytBal[address]` mapping.
> - **Periphery consolidation** (2026-05-27) — collapsed FissionZap + MegaZap + FissionUnzap + FissionGateway + ActionRouter into a single `FissionPeriphery` with deterministic 2-tx flow.
> - **Periphery v3 audit pass-2** — added `registeredSyAdapter` gate (H-4), `isProtectedToken` rescue gate (X-5), per-side `_checkSize`, `ptOutFromSwap` param on `buySyForLp`, raised V3 NPM fee cap.
> - **SY adapter v2 (X-2 fix)** — added `sweepHbar()` so HBAR refunded by the V3 NPM is recoverable. Old SY adapter has 6.26 HBAR permanently stuck (no sweep).
>
> Full forensic write-up: [`records.txt`](records.txt) at repo root.

### Governance contracts

| Contract | EVM | Hedera ID | HashScan |
|----------|-----|-----------|----------|
| **Timelock** (48h) | `0x...009fc1c0` | `0.0.10469824` | [view](https://hashscan.io/mainnet/contract/0.0.10469824) |
| **2-of-2 ThresholdKey** account | `0x...009fc1be` | `0.0.10469822` | [view](https://hashscan.io/mainnet/account/0.0.10469822) |

### Live market HTS tokens *(USDC-WHBAR-2026-08-25-v3)*

| Token | EVM | Hedera ID | HashScan |
|-------|-----|-----------|----------|
| SY share | `0x0000000000000000000000000000000000a0289b` | `0.0.10496155` | [view](https://hashscan.io/mainnet/token/0.0.10496155) |
| Principal Token (PT) | `0x0000000000000000000000000000000000a028aa` | `0.0.10496170` | [view](https://hashscan.io/mainnet/token/0.0.10496170) |
| Yield Token (YT) | `0x0000000000000000000000000000000000a028ab` | `0.0.10496171` | [view](https://hashscan.io/mainnet/token/0.0.10496171) |
| LP Token | `0x0000000000000000000000000000000000a028ac` | `0.0.10496172` | [view](https://hashscan.io/mainnet/token/0.0.10496172) |

All four are HTS-native fungibles. YT is frozen post-receive so user-to-user transfers revert — AMM-only by design, which closes a stale-yield-index exploit class.

### Trade surface (`FissionPeriphery` — single user-facing contract)

All Buy and Sell flows go through Periphery v3 (`0x...a02731`). Each flow is **two transactions** (deterministic, no atomic 1-tx, no fallback):

#### Buy path (HBAR-in)

| Action | Tx 1 | Tx 2 |
|--------|------|------|
| Buy PT  | `Periphery.zapHbarToSy(market, receiver, deadline)` | `Periphery.buySyForPt(market, syIn, minPtOut, receiver, deadline)` |
| Buy YT  | `Periphery.zapHbarToSy(...)` | `Periphery.buySyForYt(market, syIn, minSyOutFromPtSale, receiver, deadline)` |
| Buy LP  | `Periphery.zapHbarToSy(...)` | `Periphery.buySyForLp(market, syIn, ptShareBps, ptOutFromSwap, minLpOut, receiver, deadline)` |
| Mint SY only | `Periphery.zapHbarToSy(...)` | *(stop after Tx 1)* |

#### Sell path (HBAR-out)

| Action | Tx 1 | Tx 2 |
|--------|------|------|
| Sell PT | `Periphery.sellPtForSy(market, ptIn, minSyOut, receiver, deadline)` | `Periphery.unzapSyToHbar(syAdapter, sharesIn, minHbarOut, deadline)` |
| Sell YT | `Periphery.sellYtForSy(market, ytIn, minSyOut, receiver, deadline)` *(requires `market.setOperator(periphery, true)` first)* | `Periphery.unzapSyToHbar(...)` |
| Sell LP | `Periphery.sellLpForSy(market, lpIn, minSyOut, receiver, deadline)` | `Periphery.unzapSyToHbar(...)` |
| Unzap SY only | *(skip)* | `Periphery.unzapSyToHbar(...)` |

#### One-time setup (per user)

1. Approve PT, LP, SY-share to Periphery (`int64.max`)
2. `market.setOperator(periphery, true)` — only needed for Sell YT

#### Direct Market calls (advanced)

For users who already hold SY shares and want to skip the Periphery:

| Action | Entry point |
|--------|-------------|
| Split SY → PT + YT | `Market.split(amount)` |
| Merge PT + YT → SY | `Market.merge(amount)` |
| Add liquidity (SY + PT in) | `Market.addLiquidity(syIn, ptIn, minLpOut, receiver)` |
| Remove liquidity | `Market.removeLiquidity(lpIn, minSyOut, minPtOut, receiver)` |
| Redeem after expiry | `Market.redeemAfterExpiry(ptIn, 0, receiver)` *(YT burn not permitted on rewards market)* |

---

## Governance

```
   Operator (ECDSA)              Cosigner (Ed25519)
   0x32e8...ab90                 0.0.10457309
        │                              │
        └──────────────┬───────────────┘
                       ▼
            2-of-2 Hedera ThresholdKey
                0.0.10469822
                       │
                       │  proposer + executor
                       ▼
              TimelockController · 48h
                0.0.10469824
                       │
                       │  DEFAULT_ADMIN_ROLE
                       ▼
          Factory · Market · SY adapter
```

| Role / property | Holder | Detail |
|-----------------|--------|--------|
| **DEFAULT_ADMIN_ROLE** | Timelock | Every parameter change is gated by a 48-hour public window |
| **PAUSER_ROLE** | ThresholdKey directly | Emergency pause has no delay |
| **Timelock admin** | `address(0)` | Self-governs; delay cannot be removed except via the Timelock itself |
| **Mixed-curve threshold** | ECDSA-secp256k1 + Ed25519 | Hedera consensus accepts both natively; on EVM the threshold account is one address |

The operator EOA still holds `DEFAULT_ADMIN_ROLE` on live contracts; `beginDefaultAdminTransfer(timelock)` is on-chain pending the threshold account's `acceptDefaultAdminTransfer` batch. See [`docs/MAINNET_DEPLOY.md`](docs/MAINNET_DEPLOY.md) for the runbook.

---

## Fees

| Where | Charged | Rate | Splits to |
|-------|---------|------|-----------|
| `Market.swapExactSyForPt` / `swapExactPtForSy` | Every PT/SY trade | `lnFeeRateRoot = 3e14` (~0.03% time-eq) | 99% to LPs · 1% to treasury |
| `SY.depositLiquidity` / `Market.split` / `merge` / `claimRewards` / `redeemAfterExpiry` | — | 0 | — |

The 99/1 LP/treasury split was set on-chain on 2026-05-10 via `setFee(lnFeeRateRoot, 1)`. Post-handoff, the reserve percentage is Timelock-mutable only.

---

## Audits & security

| Item | Status |
|------|--------|
| Internal pass 1 ([`SECURITY_REVIEW_2026-05-02.md`](audits/internal/SECURITY_REVIEW_2026-05-02.md)) | 24 findings; all H/M closed |
| Internal pass 2 ([`SECURITY_REVIEW_2026-05-02-pass2.md`](audits/internal/SECURITY_REVIEW_2026-05-02-pass2.md)) | Hedera-aware + attack-vector taxonomy; 9 more findings; all H/M closed |
| Open Critical / High / Medium | **0** |
| Tests | 269 unit + invariant · 8 invariants × 256K random calls · 0 reverts |
| Static analysis | Slither + Aderyn baselined; flagged items classified as noise or accepted residuals |
| External paid audit | Not yet completed (follow-up) |

External-audit handoff: [`audits/external/HANDOFF.md`](audits/external/HANDOFF.md)

---

## Docs

| Document | Description |
|----------|-------------|
| [`docs/ECONOMICS.md`](docs/ECONOMICS.md) | How PT, YT, LP, and SY accumulate value — worked examples per role. **Required reading for end users.** |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | System design and contract topology |
| [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) | Phased build plan and current state |
| [`docs/MAINNET_DEPLOY.md`](docs/MAINNET_DEPLOY.md) | Operator runbook for mainnet ops, including multisig handoff |
| [`audits/internal/V1_LAUNCH_TEST_PLAN.md`](audits/internal/V1_LAUNCH_TEST_PLAN.md) | Living checklist for the launch |

---

## License

MIT — see [`LICENSE`](LICENSE).
