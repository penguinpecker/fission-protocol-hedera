# Fission Protocol — Hedera

**Tokenize the Yield.** Fixed-rate and perpetual yield markets on Hedera.

Fission splits a yield-bearing position into two on-chain tokens:

- **PT** — Principal Token, redeems 1:1 for the underlying at maturity (the bond).
- **YT** — Yield Token, perpetual claim on the yield stream (the variance bet).

PT and SY trade against each other on a Pendle-V2-style logit-curve AMM with a separate **LP** token for market-makers. Every primitive — PT, YT, LP, and SY shares — is a native HTS token, visible in HashPack and any Hedera-aware wallet.

- **Live:** https://www.fissionp.com
- **Network:** Hedera mainnet (chain ID 295)
- **Status:** v1 in production, single market live, internal audits closed (0 H / 0 M / 0 C). External audit pending.

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

**Why this shape:** SaucerSwap V2 positions are concentrated-liquidity NFTs (Uniswap V3 fork), so the standard "yield rate growth" pattern doesn't apply. Fission uses the **reward-streaming** pattern: SY's `exchangeRate` is constant at `1e18`; trading fees are pushed to YT holders proportionally via a per-share reward index. YT is therefore a **perpetual** claim — it does not expire at the term boundary, only the PT/YT split rate does.

---

## The three roles

| Role | What you hold | Pays out | Risk shape |
|---|---|---|---|
| **PT** | Principal Token (HTS) | 1 SY at maturity (fixed return = buy-time discount) | Low — return locked at buy; protected by SY held in the market |
| **YT** | Yield Token (HTS, AMM-only) | Continuous WHBAR + USDC from the SY's harvested fees | High — leveraged exposure to SaucerSwap V2 trading volume |
| **LP** | LP Token (HTS) | 99% of Fission AMM swap fees (1% → treasury) | Medium — Pendle-V2-style "imp-loss" on PT/SY divergence |

At maturity, **1 PT redeems for 1 SY** (1:1, unconditional). LP `removeLiquidity` post-expiry auto-redeems the LP's PT share for SY so post-expiry exits never compete with PT redeemers for backing.

PT and YT are minted in a 1:1 split: `1 SY = 1 PT + 1 YT`. By the Pendle identity, `PT price + YT price = 1 SY` at all times (pre- and post-expiry).

---

## Live contracts (chain 295)

All deployments tracked in [`deployments/295.json`](deployments/295.json). HashScan links open the contract page directly.

### Core protocol

| Contract | EVM | Hedera ID | HashScan |
|---|---|---|---|
| **FissionFactory** *(2026-05-22 Ed25519 fix)* | `0x...a00b4e` | `0.0.10488654` | [view](https://hashscan.io/mainnet/contract/0.0.10488654) |
| **ActionRouter v3** | `0x...009fdf89` | `0.0.10477449` | [view](https://hashscan.io/mainnet/contract/0.0.10477449) |
| **FissionZap** (HBAR→SY) | `0x...009fd984` | `0.0.10475908` | [view](https://hashscan.io/mainnet/contract/0.0.10475908) |
| **MegaZap** (HBAR→PT/YT/LP) | `0x...009fdf8c` | `0.0.10477452` | [view](https://hashscan.io/mainnet/contract/0.0.10477452) |
| **FissionUnzap** (PT/SY/LP→HBAR) *(new 2026-05-24)* | `0x...a01a63` | `0.0.10492515` | [view](https://hashscan.io/mainnet/contract/0.0.10492515) |
| **FissionLens** (read-helper) | `0x...a00fde` | `0.0.10489822` | [view](https://hashscan.io/mainnet/contract/0.0.10489822) |
| **SY_SaucerSwapV2LP** | `0x...009fb089` | `0.0.10465417` | [view](https://hashscan.io/mainnet/contract/0.0.10465417) |
| **Market 0 — `SS-V2-90D-FIX`** | `0x36ed8f34c9bfc0004f107153b1a16099f8910b58` | `0.0.10488661` | [view](https://hashscan.io/mainnet/contract/0.0.10488661) |
| StandardMarketDeployer | `0x...a00b46` | `0.0.10488646` | [view](https://hashscan.io/mainnet/contract/0.0.10488646) |
| RewardsMarketDeployer | `0x...a00b4b` | `0.0.10488651` | [view](https://hashscan.io/mainnet/contract/0.0.10488651) |

**HashScan verification** (chain 295, via [Sourcify](https://sourcify.dev/server)):
- ✅ FissionFactory — full match
- ✅ SY_SaucerSwapV2LP — full match
- ⏳ StandardMarketDeployer, RewardsMarketDeployer, Market 0 (FissionMarketRewards instance), ActionRouterV3, FissionZap — Foundry's `via_ir = true` produces bytecode that Sourcify can't exactly reproduce from the same metadata; manual upload via HashScan UI (`https://hashscan.io/mainnet/contract/<entity_id>/source`) is the workaround. Source code in this repo is byte-identical to what's deployed.

> **2026-05-22 redeploy** — addresses above replaced the pre-fix set. The old factory (`0x...009fb0b3`) and old market (`0xfa903b…8a6d`) had an Ed25519 reward-accrual bug where the Hedera HTS facade's `balanceOf(addr)` silently returned 0 for long-zero EVM addresses of Ed25519 accounts (HashPack's default key type), zeroing out reward + yield accrual for those users. Fixed by tracking YT balances internally in `_ytBal[address]`. Operator's $700+ V3 LP position has been migrated to the new market; old contracts remain on chain but archived in the dApp. Full forensic write-up: [`audits/internal/SECURITY_REVIEW_ED25519_BAL_2026-05-22.md`](audits/internal/SECURITY_REVIEW_ED25519_BAL_2026-05-22.md).

### Governance

| | EVM | Hedera ID | HashScan |
|---|---|---|---|
| **Timelock** (48h) | `0x...009fc1c0` | `0.0.10469824` | [view](https://hashscan.io/mainnet/contract/0.0.10469824) |
| **2-of-2 ThresholdKey** account | `0x...009fc1be` | `0.0.10469822` | [view](https://hashscan.io/mainnet/account/0.0.10469822) |

### Market 0 HTS tokens (new 2026-05-22 set)

| Token | Symbol | EVM | Hedera ID | HashScan |
|---|---|---|---|---|
| SY shares | `fSY-SS-V2` | `0x...009fb08b` | `0.0.10465419` | [view](https://hashscan.io/mainnet/token/0.0.10465419) |
| Principal Token | `fPT-SS-V2-90D-FIX` | `0x...a00b56` | `0.0.10488662` | [view](https://hashscan.io/mainnet/token/0.0.10488662) |
| Yield Token | `fYT-SS-V2-90D-FIX` | `0x...a00b57` | `0.0.10488663` | [view](https://hashscan.io/mainnet/token/0.0.10488663) |
| LP Token | `fLP-SS-V2-90D-FIX` | `0x...a00b58` | `0.0.10488664` | [view](https://hashscan.io/mainnet/token/0.0.10488664) |

SY share token is reused from the legacy deployment — the same V3 NFT-backed asset, just exposed via the fixed market. PT/YT/LP are freshly minted per market.

All four are HTS-native fungibles with 18 decimals. YT is frozen post-receive so user-to-user transfers revert — it's AMM-only by design, which closes a stale-yield-index exploit class.

### Trade surface

| Action | Where | Notes |
|---|---|---|
| Buy PT (HBAR-in, 1 tx) | `MegaZap.zapHbarToPt(market, sy, minPtOut, receiver, deadline)` | Auto-falls back to legacy 4-tx chain on Hedera `MAX_CHILD_RECORDS_EXCEEDED` |
| Buy PT (SY-in) | `ActionRouter.swapExactSyForPt(market, syIn, ptOut, …)` | |
| **Sell PT → HBAR (1 tx)** *(new 2026-05-24)* | `FissionUnzap.sellPtForHbar(market, ptIn, minHbarOut, receiver, deadline)` | Router swap PT→SY → `sy.redeemLiquidity` → V2 swap USDC→WHBAR → unwrap |
| Sell PT → SY | `ActionRouter.swapExactPtForSy(market, ptIn, minSyOut, …)` | |
| Buy YT (HBAR-in, 1 tx) | `MegaZap.zapHbarToYt(market, sy, minSyOutFromPtSale, receiver, deadline)` | Auto-falls back to legacy 4-tx chain on `MAX_CHILD_RECORDS_EXCEEDED` |
| Buy YT (SY-in) | `ActionRouter.buyYT(market, syBudget, …)` | Splits then sells PT internally |
| **Sell YT → HBAR (3 tx)** *(new 2026-05-24)* | `Market.swapExactYtForSy` → `FissionUnzap.unzapSy(sy, sharesIn, minHbarOut, receiver)` | YT freeze forces 3-step UX: market wipes YT in-place, then SY → HBAR via unzap |
| Sell YT → SY | `Market.swapExactYtForSy(ytIn, minSyOut, receiver)` | Direct on Market, no router proxy — YT is frozen-by-default so the Market uses its WIPE key to consume YT in-place + burns paired PT from the AMM pool |
| Add LP (HBAR-in, 1 tx) | `MegaZap.zapHbarToLp(market, sy, ptShareBps, minLpOut, receiver, deadline)` | |
| **Remove LP → HBAR (1 tx)** *(new 2026-05-24)* | `FissionUnzap.sellLpForHbar(market, lpIn, minHbarOut, receiver, deadline)` | |
| Add/Remove LP (SY-in) | `ActionRouter.addLiquidityProportional` / `removeLiquidityProportional` | |
| Redeem after expiry | `Market.redeemAfterExpiry(ptIn, ytIn, receiver)` | Rewards-type market: PT-only (1:1 to SY); standard market: both PT and YT |

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

- **DEFAULT_ADMIN_ROLE** = Timelock. Every parameter change is gated by a 48-hour public window.
- **PAUSER_ROLE** = ThresholdKey directly. Emergency pause has no delay because every other admin operation does.
- **Timelock admin** = `address(0)`. Self-governs; the delay cannot be removed except via the Timelock itself.
- **Mixed-curve threshold**: signers are ECDSA-secp256k1 + Ed25519. Hedera's consensus layer accepts both natively; on the EVM side the threshold account is just one address.

The operator EOA still holds DEFAULT_ADMIN_ROLE on the live contracts; `beginDefaultAdminTransfer(timelock)` is on-chain pending the threshold account's `acceptDefaultAdminTransfer` batch. See [`docs/MAINNET_DEPLOY.md`](docs/MAINNET_DEPLOY.md) for the runbook.

---

## Fees

| Where | Charged | Rate | Splits to |
|---|---|---|---|
| `Market.swapExactSyForPt` / `swapExactPtForSy` | Every PT/SY trade | `lnFeeRateRoot = 3e14` (~0.03% time-eq) | 99% to LPs · 1% to treasury |
| `SY.depositLiquidity` / `Market.split` / `merge` / `claimRewards` / `redeemAfterExpiry` | — | 0 | — |

The 99/1 LP/treasury split was set on-chain on 2026-05-10 via `setFee(lnFeeRateRoot, 1)`. Post-handoff, the reserve percentage is Timelock-mutable only.

---

## Audits & security

- **Internal pass 1** ([`audits/internal/SECURITY_REVIEW_2026-05-02.md`](audits/internal/SECURITY_REVIEW_2026-05-02.md)) — 24 findings; all H/M closed.
- **Internal pass 2** ([`audits/internal/SECURITY_REVIEW_2026-05-02-pass2.md`](audits/internal/SECURITY_REVIEW_2026-05-02-pass2.md)) — Hedera-aware + attack-vector taxonomy review; 9 more findings; all H/M closed.
- **0 open Critical / High / Medium** findings.
- **269 unit + invariant tests passing** · **8 invariants × 256K random calls** · **0 reverts**.
- Slither + Aderyn baselined; all flagged items classified as detector noise or accepted residuals.
- External paid audit — not yet completed; tracked as a follow-up.

External-audit handoff package: [`audits/external/HANDOFF.md`](audits/external/HANDOFF.md).

---

## Docs

- [`docs/ECONOMICS.md`](docs/ECONOMICS.md) — deep-dive on how PT, YT, LP, and SY accumulate value. Worked examples per role under upside and downside scenarios. **Required reading for end users.**
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — system design and contract topology.
- [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) — phased build plan and current state.
- [`docs/MAINNET_DEPLOY.md`](docs/MAINNET_DEPLOY.md) — operator runbook for mainnet ops, including the multisig handoff procedure.
- [`audits/internal/V1_LAUNCH_TEST_PLAN.md`](audits/internal/V1_LAUNCH_TEST_PLAN.md) — living checklist for the launch.

---

## License

MIT — see [`LICENSE`](LICENSE).
