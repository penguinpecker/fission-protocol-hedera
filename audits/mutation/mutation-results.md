# Mutation testing — partial run, 2026-05-06

Tool: Gambit 0.2.1 (Certora). Runner: `audits/mutation/run_mutation_tests.py`.
Suite: `forge test --no-match-path "test/fork/*"`, 265 tests baseline.

This was an early run intentionally interrupted at the 60-mutant mark to
unblock a clean commit window (the runner holds source files mutated
between iterations). Two more rounds are scheduled before audit handoff:
a full 100-mutant run on these files, plus expanded targets (`PMath`,
`SY_HBARX`, `FissionMarketRewards`).

## Headline

| File | Mutants run | Killed | Survived | Kill rate |
|------|-----------:|-------:|---------:|----------:|
| `contracts/src/libraries/MarketMath.sol` | 50 | 36 | 14 | **72.0%** |
| `contracts/src/core/FissionMarket.sol`   | 10 | 7  | 3  | **70.0%** |
| **Total**                                | 60 | 43 | 17 | **71.7%** |

Pre-audit target: ≥ 85% per `docs/IMPLEMENTATION_PLAN.md` Phase 9.
**Gap:** 13.3 percentage points (would need ~12 of the 17 survivors to
turn into kills with extra tests).

## Survivor classification

Each survivor is a candidate test gap. Three categories:
1. **Equivalent mutant** — change is semantically a no-op given the
   surrounding code (e.g. `if (x == 0) return;` → `if (x <= 0) return;`
   when the precondition guarantees `x >= 0`). No new test will catch it.
2. **Real test gap** — mutation changes program behavior in a way the
   suite genuinely doesn't observe. New test required.
3. **Defense-in-depth code** — branch only fires under conditions the
   tests don't construct (e.g. `if (proportion > MAX_MARKET_PROPORTION)`
   when no fuzz round randomises into that band). Add a targeted test.

Survivor IDs (mutant#) by file are in `mutation-results.json` along with
the diffs (find them under `audits/mutation/gambit-out{,-fm}/mutants/`).

## MarketMath.sol survivors (14)

| Mutant# | Type | Likely category |
|--------:|------|------|
| 21 | AssignmentMutation       | TBD — review diff |
| 22 | BinaryOpMutation         | TBD |
| 24 | BinaryOpMutation         | TBD |
| 26 | SwapArgumentsOperator    | likely equivalent (commutative `+` / `*` swaps) |
| 33 | DeleteExpressionMutation | TBD |
| 34 | AssignmentMutation       | TBD |
| 35 | AssignmentMutation       | TBD |
| 36 | BinaryOpMutation         | TBD |
| 37 | BinaryOpMutation         | TBD |
| 43 | UnaryOperatorMutation    | likely equivalent (sign flip on already-zero) |
| 44 | UnaryOperatorMutation    | likely equivalent |
| 45 | BinaryOpMutation         | TBD |
| 48 | IfStatementMutation      | TBD |

Triage workflow: read the diff at
`audits/mutation/gambit-out/mutants/<id>/contracts/src/libraries/MarketMath.sol`,
classify, and either add a Foundry test or annotate as equivalent.

## FissionMarket.sol survivors (3, partial)

| Mutant# | Type | Likely category |
|--------:|------|------|
| 6  | BinaryOpMutation     | TBD |
| 8  | IfStatementMutation  | TBD |
| 10 | AssignmentMutation   | TBD |

The remaining 40 mutants (#11-50 of FissionMarket.sol) were not run.
Reschedule before audit handoff.

## Method notes

- Each `forge test` averaged 53s (CPU-bound; foundry's incremental cache
  partially helps but mutation diffs invalidate per-file artifacts).
- Total wall-clock for the 60-mutant partial run: ~53 minutes.
- Full 100-mutant target = ~90 min wall-clock, run unattended.

## Next steps

1. **Resume the run** — same config (`audits/mutation/gambit.config.json`),
   same handler script (`audits/mutation/run_mutation_tests.py`).
   Expected ~37 more minutes wall-clock (40 remaining FissionMarket
   mutants × ~53s).
2. **Triage the 17 survivors above** — open each diff, classify as
   equivalent / test-gap / defense-in-depth, add tests for the gaps.
3. **Expand mutation scope** before primary audit: `PMath`, `SY_HBARX`,
   `FissionMarketRewards`, `FissionFactory` (~150-200 additional
   mutants, ~3 hours).
4. **Re-run** after test additions — target ≥85% kill on the math libs
   and the AMM core.
