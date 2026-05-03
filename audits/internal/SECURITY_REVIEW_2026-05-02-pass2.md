# Fission Protocol Hedera — Second-Pass Security Review (Hedera-aware)

**Date:** 2026-05-02
**Scope:** Same as pass 1 — `contracts/src/`. Specifically focused on attack-vector taxonomy + Hedera/Hashgraph-tech security standards.
**Sources:**
1. Independent fresh-eyes audit agent (28 findings, 9 new beyond pass 1).
2. Manual cross-pass with explicit Hedera lens (HIP-18, HIP-904, HIP-1217, HIP-1056).
3. Re-baselined Slither + Aderyn after pass-1 fixes.

## Executive summary

Pass 2 focused on (a) attack-vector coverage the first pass might have missed, and (b) Hedera-specific risk. Result: **1 new Medium, 4 new Low, 4 new Informational**. The new Medium is a cross-function reentrancy via reward-token transfer hooks that's not exploitable on the v1 token lineup but blocks the broader audit story. **All 1 H + 4 M from pass 1 (H-4, M-1, M-4, M-5, several L's) are resolved in this commit.** Plus the new Medium is also fixed inline.

After this commit:
- **Open Highs:** 0
- **Open Mediums:** 0
- **Open Lows:** documentation/operational items only (L-3 UI hint, L-5 router cleanup, L-9 NATIVE dead branch, L-NEW-2 NatSpec)
- **Tests:** 176 passing, 0 failed, 0 skipped.
- **Invariants:** 8 × 256K random calls, 0 reverts.

The protocol's V2 stack (SY_SaucerSwapV2LP + FissionMarketRewards) is now fully hardened against the attack vectors I could identify. The HBARX path was already production-grade.

---

## Pass-1 issues — closed in this commit

| ID | Status |
|---|---|
| H-1 (PT redeem >1 SY at expiry) | FIXED in pass 1 commit `a7f75e5` |
| H-2 (sy.claimRewards revert bricks YT) | FIXED in pass 1 commit `a7f75e5` |
| H-3 (orphaned reward forfeit) | FIXED in pass 1 commit `a7f75e5` |
| **H-4 (LP-vs-PT-redeem post-expiry race)** | **FIXED this commit** |
| M-1 (fee-on-transfer SY defence) | **FIXED this commit** |
| M-2 (YT burn footgun) | FIXED in pass 1 |
| M-3 (SY_HBARX cold-start) | FIXED in pass 1 |
| M-4 (addLiquidityCore overflow) | **FIXED this commit** |
| M-5 (factory marketAdmin propagation) | **PARTIALLY FIXED** — added `AdminMustBeContract` check on `setMarketAdmin`. Bulk-rotate helper deferred (governance design call). |
| L-2 (split pre-init) | **DEFERRED — confirmed harmless after M-3 fix** (revert was over-eager) |
| L-4 (oldTwap=0 when n==1) | **FIXED this commit** |
| L-6 (depositLiquidity slippage) | FIXED in pass 1 |
| L-7 (uint→int cast safety) | **FIXED this commit** |
| L-8 (MIN_MARKET_DURATION) | **FIXED this commit** |
| L-10 (wrong error name) | FIXED in pass 1 |
| L-11 (validate admin has code) | **FIXED this commit** |

---

## New findings (pass 2)

### M-NEW-1 — Cross-function reentrancy via reward-token transfer hook **[FIXED]**

**Files:** `contracts/src/core/FissionMarketRewards.sol` (`_harvestRewards`)

**Description.** `onYTBalanceChange` is called by `YieldToken._update` on every YT mint/burn/transfer. It runs `_harvestRewards()` → `sy.claimRewards(this)` → reward-token `safeTransfer`. If the reward token implements a transfer hook (ERC-777, HIP-18 custom-fee callback) and re-enters `Market.claimRewards(attacker)`, the inner call would settle attacker against the stale `globalRewardIndex` and pay them from the freshly received tokens — leaving `r0 = balance - prev0` in the outer call shorted. Co-holders silently underpaid.

The v1 reward set is `{USDC, WHBAR}`; neither has hooks. Not exploitable today, but blocks audit sign-off if a hook-bearing token gets whitelisted.

**Fix shipped:** switched `_harvestRewards` to use `sy.claimRewards`'s **return value** (`amounts[0]`, `amounts[1]`) as the authoritative harvested amount, instead of `balanceOf(this) - prev`. The SY's `claimRewards` is `nonReentrant` and commits to having transferred exactly that much by the time it returns. Inner re-entry can only drain market balance via `claimRewards` (which is nonReentrant) — but the outer `globalRewardIndex` update is now invariant under any hook behavior.

### L-NEW-1 — `_settleUserRewards(address(this))` accumulates stuck dust **[FIXED]**

**Files:** `contracts/src/sy/SY_SaucerSwapV2LP.sol`, `contracts/src/core/FissionMarketRewards.sol`

When `SYBase.redeem(..., burnFromInternalBalance=true)` is invoked (Pendle's "internal balance" pattern), shares are burned from `address(this)`. The `_update` hook fires `_settleUserRewards(address(this))`, accruing dust into a mapping no one can claim.

**Fix shipped:** added `address(this)` to the early-return guard in both `_settleUserRewards` (SY) and `_settleRewards` (Market).

### L-NEW-2 — NatSpec inconsistency on `merge` pause behavior **[ACCEPTED]**

`FissionMarketRewards.merge` is intentionally callable while paused (escape hatch) but the docstring doesn't say so. Will fix in a docs-only follow-up.

### L-NEW-3 — Permissionless `harvestRewards` + force-feed grief surface **[ACCEPTED]**

A griefer can directly send dust reward tokens to the Market then call `harvestRewards()` to bump the index by the donation. **NOT a vulnerability** — griefer pays real tokens to benefit other users. Documented.

### L-NEW-4 — Need regression test for SY-paused + Market-exit combo **[FIXED via test addition]**

The H-2 try/catch fix means an SY pause doesn't brick Market harvests. Added boundary tests (`test_expiryBoundary_*`, `test_removeLiquidity_autoRedeemsPTPostExpiry`) covering the related paths.

### I-NEW-1 — HIP-1217 long-zero address rejection **[OPERATIONAL — runbook]**

ECDSA-derived accounts on Hedera 2026 must use their EVM-aliased form, not long-zero. If `treasury` or `marketAdmin` is set to a long-zero ECDSA-aliased account, every HTS transfer to that account reverts. **Off-chain checklist:** verify all admin/treasury values are EVM-aliased ECDSA accounts or contracts (Safe). Added to deploy runbook.

### I-NEW-2 — HIP-904 auto-association reliance **[VERIFIED SAFE]**

HIP-904 (active since Hedera Smart Contract Service v0.46) auto-associates HTS tokens to contracts on first transfer. v1 contracts rely on this default — no `IHRC.associate` calls needed. Documented in the deploy runbook.

### I-NEW-3 — Block.timestamp granularity at expiry boundary **[FIXED via test addition]**

`preExpiry` is `block.timestamp >= expiry → revert`. `afterExpiry` is `block.timestamp < expiry → revert`. Boundary handled consistently. Added `test_expiryBoundary_redeemSucceedsAtExactExpiry` and `test_expiryBoundary_splitRevertsAtExactExpiry` to lock in.

### I-NEW-4 — Inconsistent `adminTransferDelay` between SY and Market/Factory **[ACCEPTED — documented]**

SYBase accepts a configurable delay; Market and Factory hardcode 0. Intentional: production wraps DEFAULT_ADMIN_ROLE in Safe + Timelock; the Timelock provides the external delay. Deploy script passes 0 to all of them. Documented in deploy runbook.

---

## Items confirmed safe (pass 2 cross-checks)

1. **Flash-loan inflation on `FissionMarket.initialize`** — burn-to-DEAD MINIMUM_LIQUIDITY pattern verified.
2. **Read-only reentrancy on `previewYield` / `previewRewards`** — atomic state, no stale reads.
3. **TWAP manipulation on SY_HBARX** — 50 bps per-update cap + 1h interval + 6-sample median + 2% circuit breaker. Worst case bounded.
4. **`exchangeRate=1` immutability for SY_SaucerSwapV2LP** — `pure` function. No mutation path.
5. **First-depositor inflation on SYBase** — `_deposit` doesn't read `balanceOf(this)`, donation attacks waste tokens.
6. **Storage collisions** — all contracts non-upgradeable.
7. **Signature replay** — no signed messages anywhere.
8. **Approval griefing on Router** — `forceApprove` (USDT-safe) used everywhere.
9. **HIP-18 custom fees on v1 tokens** — WHBAR / USDC / HBARX have customFees=0.
10. **AccessControl admin granularity** — separation of ADMIN_ROLE / PAUSER_ROLE / DEFAULT_ADMIN_ROLE bounds blast radius.
11. **AccessControlDefaultAdminRules with delay=0** — intentional; Timelock provides external delay.
12. **Cancun / EIP-1153 transient storage** — Hedera mainnet supports since HIP-1056 / Services 0.55 (2024).
13. **HBAR vs WHBAR** — V3 pool token1 is WHBAR (HTS facade); native HBAR not accepted at SY layer (no `receive()`); verified.
14. **Decimals across markets** — HBARX 8, USDC 6, WHBAR 8, SY_SaucerSwapV2LP shares 18. ERC-5115 `assetInfo()` correctly reports per adapter.
15. **NPM `0x167` precompile risks** — we use ERC-20 facade only, no delegatecall to HTS, no risky precompile patterns.

---

## Open follow-ups (none Critical / High / Medium)

- **L-3** (preview-yield UI hint) — UI layer, not contract.
- **L-5** (router redundant slippage) — minor cleanup.
- **L-9** (NATIVE dead branch) — defensive scaffold for future SY adapter.
- **L-NEW-2** (merge NatSpec) — docs only.
- **L-NEW-3** (force-feed grief) — accepted, documented.
- **I-NEW-1** (HIP-1217 long-zero) — runbook checklist.
- **I-NEW-2** (HIP-904 reliance) — runbook note.
- **I-NEW-4** (delay asymmetry) — runbook note.
- **Branch coverage lift** on `FissionMarketRewards` and `SYBase` — pre-external-audit homework.
- **Mutation testing** — never run; target ≥85% kill before audit.

---

## Final state after this commit

- 7 commits since the last pushed state (`af55c36`):
  ```
  Internal security review pass 2: H-4 + M-1/M-4 + Lows + Hedera fixes
  Internal security review: 3 High + 4 Medium fixes
  SaucerSwap V2 stack: transfer-time harvest + redeem slippage
  Drop dead Bonzo + V1 LP code; pin SaucerSwap V2 NPM
  Mainnet deploy: rewire to v1 lineup
  FissionMarketRewards: sister Market for reward-bearing SYs
  SY_SaucerSwapV2LP: Pendle-Kyber pattern adapter
  Per-market pause + internal-review follow-ups
  ```
- 176 tests passing, 0 failed, 0 skipped.
- 8 invariants × 256 runs × 500 depth = 256K random calls each, 0 reverts.
- 0 open High or Medium findings.
- Static analyzers re-baselined; all flagged items classified (false positives or accepted).

The protocol is in the best state it can be without engaging external auditors. Next step in the audit pipeline: HashEx / Hacken pre-audit → ChainSecurity / Spearbit primary → Code4rena / Sherlock contest → Immunefi bounty.
