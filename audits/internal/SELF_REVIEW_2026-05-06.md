# Self-review pass — 2026-05-06

Triggered by an architectural mistake on my part: I drafted a Gnosis Safe
2-of-2 governance plan for a protocol whose entire token surface is HTS-native.
The user called this out, and the right answer was a Hedera ThresholdKey
account (already corrected in commit). This document captures everything else
I checked for the same failure pattern — "imported a convention without
validating it fits the architecture."

## Method

Read each in-scope contract from canonical commit (using `git show HEAD:`
to bypass any in-flight mutation-test mutation), check math, decimals,
HTS bug-fix coverage, reentrancy posture, post-expiry behaviour. Cross-
checked against `docs/`, `audits/internal/SECURITY_REVIEW_2026-05-02*.md`,
`audits/static-analysis/`, and the test invariants.

## What I verified clean

| Area | Verdict | Evidence |
|------|---------|----------|
| `PMath` (1e18 fixed-point math) | ✅ Wraps audited Solady primitives; rounding-direction helpers explicit at call site | `PMath.sol`, lines 23-118 |
| `MarketMath` (Pendle V2 logit curve) | ✅ Faithful port. Sign convention, `rateAnchor` recompute, `lastLnImpliedRate` persistence, fee direction, post-trade rate update — all match Pendle reference. First-add LP = sqrt(sy·pt) − MIN_LIQ, matches | `MarketMath.sol` |
| Decimals consistency | ✅ HBARX market: PT/YT/SY all 8-dec; LP=18; rate=1e18-scale. V2-LP market: PT/YT/SY all 18-dec; LP=18; rate=1e18 constant. `assetInfo()` returns matching dec on each adapter | SY_HBARX:83, SY_SaucerSwapV2LP:142,403 |
| 12 Hedera bug fixes | ✅ All in source: 2-step init, gas-cap deployer split, msg.value/3 in setTokens, auto-association via `_afterInitShareToken`, response code 194 idempotency, msg.value forwarding to NPM mint, `_burnYt` unfreeze→wipe→refreeze, `_mintLp(this, MIN)` not `0xdEaD`, optimizer_runs=200 | `MAINNET_DEPLOY.md` Appendix A |
| Audit pass-1/2 fixes | ✅ All 9 fixes in source (H-1 SY rate floor; H-2 try/catch on claimRewards; H-3 no-pull-on-empty; H-4 post-expiry LP auto-redeem; M-1 fee-on-transfer pre-balance snapshot; M-2 YT burn rejected in rewards-redeemAfterExpiry; M-3 cold-start ONE; M-NEW-1 harvest uses claimRewards return value) | grep `H-1`/`H-2`/`H-3`/`H-4`/`M-NEW-1` across `core/` and `sy/` |
| Reentrancy posture | ✅ `nonReentrant` on every external entry; cross-function reentrancy on `positionTokenId` blocked by guard sharing | `SY_SaucerSwapV2LP.sol`:237,330,488 |
| Conservation invariant testing | ✅ `invariant_solvency` + `invariant_poolPtMatchesBalance` + `invariant_ptYtSupplyParityPreExpiry` exercised at 256K random calls / depth 500 in CI, 0 reverts | `test/invariant/FissionMarketInvariant.t.sol`:91-128 |
| Static analysis | ✅ Slither 102 findings, Aderyn 16 — all classified as detector noise (nonReentrant-unaware, Pendle-fidelity divide-before-multiply, integer strict-equality) | `audits/static-analysis/TRIAGE-2026-05-06.md` |
| Stader rate ABI | ✅ 18-decimal verified live (1.4e18) at `0x...158d97`, selector `0xe6aa216c` | fork test `test_fork_staderRateInRange` |
| SaucerSwap V2 NPM ABI | ✅ V3 `positions()` tuple verified live at `0x...3DDbb9`; WHBAR-USDC pool has bytecode | fork test `SY_SaucerSwapV2LP.fork.t.sol` |

## What I found and corrected in this pass

### Same-pattern blindspots (critic-style review)

1. **Governance was Gnosis Safe — corrected**
   Defaulted to Gnosis Safe at multisig.hedera.foundation purely from EVM
   convention. The protocol is HTS-native end-to-end (PT/YT/LP HTS, contracts
   self-associate via 0x167, deploys via SDK FileService). The right shape is
   a Hedera 2-of-2 `ThresholdKey` account directly above the OZ Timelock —
   ~1 HBAR vs ~50 HBAR to deploy, native HashPack signing, no Safe contract
   layer. **Fixed in this commit batch:** README, ARCHITECTURE, IMPLEMENTATION_PLAN,
   DEPLOY_AND_VERIFY, MAINNET_DEPLOY (env vars + Step 8 + Appendix B), HANDOFF.
   Memory updated. Feedback memory saved (`feedback_native_governance.md`).
   New helper scripts: `scripts/create-threshold-account.mjs`,
   `scripts/deploy-timelock.mjs`, rewritten `scripts/prep-handoff.mjs`.

### Documentation drift — to fix in this pass

2. **ARCHITECTURE.md component diagram listed "HBAR ↔ WHBAR auto-wrap" as a
   Router feature** but the code has the comment `"A future helper can add
   HBAR ↔ WHBAR auto-wrap"` (`ActionRouter.sol`:64). Phase 5 in
   IMPLEMENTATION_PLAN.md is marked done, but the "HBAR↔WHBAR auto-wrap" sub-
   item was never shipped. **Fixed:** ARCHITECTURE.md diagram now shows actual
   shipped surface and v1.1 backlog. IMPLEMENTATION_PLAN Phase 5 status is
   "done (partial scope)" with explicit deferred list.

3. **IMPLEMENTATION_PLAN.md test count was 252** — actual is 265 (verified
   via `forge test` 2026-05-06). **Fixed.**

### Acceptable risk — documented, not changing for v1

4. **`SY_SaucerSwapV2LP.depositLiquidity` forwards full `msg.value` to
   `npm.mint{value: msg.value}`** instead of just the required mint fee.
   SaucerSwap V2 NPM keeps the excess. Operator-only flow (init script
   only); estimated waste ~4 HBAR per init call. Acceptable for v1; not
   adding refund logic now (refund-via-call has its own attack surface and
   would need fresh fuzz tests). Documented as known limitation.

5. **`swapExactYtForSy` (sell YT) is not in v1 router.** Pendle V2 implements
   this via flash-mint; we don't. YT holders exit by buying matching PT and
   calling `merge`, OR by holding to expiry (YT has no SY claim post-expiry,
   yield was claimed via `claimYield`). Acceptable for v1 launch. Documented
   in IMPLEMENTATION_PLAN.md Phase 5 deferred list.

6. **`market.claimYieldFor(user)` not implemented**, so the one-tx
   claim+unwrap in `ActionRouter.unwrapSY` requires two txs (claim, then
   unwrap). Documented in router docstring + IMPLEMENTATION_PLAN. Acceptable.

7. **`SY_HBARX.fork.t.sol` line 31 has a stale comment** ("8 decimals") that
   contradicts line 56 (correctly says 18-decimal). Fix queued for after
   the in-flight mutation run completes — touching test files now risks
   confusing the runner mid-flight. Trivial follow-up commit.

### Confirmed *not* a bug — investigated due to complexity

8. **Post-expiry `removeLiquidity` accounting**: traced through three
   scenarios (LP-only-holder; LP-then-PT-redeem; PT-redeem-then-LP).
   Each leaves `sy.balanceOf(market) >= 0` and `pt.totalSupply == 0` at
   end-state. The `_burnPt(address(this), ptOut)` call burns from market
   treasury, freeing exactly `ptOut * 1e18 / globalIndex` SY worth of
   backing for the LP's auto-redeem. Conservation holds. The
   `invariant_solvency` test catches any drift.

9. **`_burnYt` unfreeze→wipe→refreeze**: verified the reset-on-zero-balance
   path (`_ytFrozen[from] = false`) so a user who burns all their YT can
   later receive YT again as a fresh recipient. Checked via the merge tests.

10. **Cross-function reentrancy on `positionTokenId`** (Slither H finding):
    every function that reads/writes `positionTokenId` is `nonReentrant`,
    and they share the same transient-storage slot via OZ `ReentrancyGuard
    Transient`. Cross-function reentrancy is impossible inside a
    `nonReentrant`-guarded scope.

## Mutation testing

In flight: 100 mutants (50 on `MarketMath.sol`, 50 on `FissionMarket.sol`).
Each iteration ~2 min wall-clock; total ETA ~2-3 hours from kickoff. Result
will land in `audits/mutation/mutation-results.{json,md}` as a follow-up
commit.

## Verdict

**No production-blocking code issues found.** The 3 doc/runbook fixes
above land in this commit. The 4 deferred items (HBAR auto-wrap, sell-YT,
claimYieldFor, V2 LP HBAR overpay) are explicitly v1.1 / acceptable-risk
and documented as such. External audit is the next gate.
