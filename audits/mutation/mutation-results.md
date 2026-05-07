# Mutation testing results

Ran at: `2026-05-07T03:34:57Z` — total elapsed `8108.3s`

**Overall:** 92/100 killed (92.0%)

## By file

| File | Mutants | Killed | Survived | Kill % |
|------|--------:|-------:|---------:|-------:|
| `contracts/src/libraries/MarketMath.sol` | 50 | 48 | 2 | 96.0 |
| `contracts/src/core/FissionMarket.sol` | 50 | 44 | 6 | 88.0 |

## Survived mutants

Mutants that survived (tests still passed despite the change) reveal coverage gaps. Each survived mutant should be reviewed: either the mutation is semantically equivalent, or a new test is needed.

### `contracts/src/libraries/MarketMath.sol` mutant #43 — UnaryOperatorMutation

_Test suite still passed with this mutation applied. Review the diff in_ `audits/mutation/gambit-out/mutants/43/contracts/src/libraries/MarketMath.sol` _and either add a test that catches it, or annotate as semantically-equivalent._

### `contracts/src/libraries/MarketMath.sol` mutant #44 — UnaryOperatorMutation

_Test suite still passed with this mutation applied. Review the diff in_ `audits/mutation/gambit-out/mutants/44/contracts/src/libraries/MarketMath.sol` _and either add a test that catches it, or annotate as semantically-equivalent._

### `contracts/src/core/FissionMarket.sol` mutant #6 — BinaryOpMutation

_Test suite still passed with this mutation applied. Review the diff in_ `audits/mutation/gambit-out/mutants/6/contracts/src/core/FissionMarket.sol` _and either add a test that catches it, or annotate as semantically-equivalent._

### `contracts/src/core/FissionMarket.sol` mutant #8 — IfStatementMutation

_Test suite still passed with this mutation applied. Review the diff in_ `audits/mutation/gambit-out/mutants/8/contracts/src/core/FissionMarket.sol` _and either add a test that catches it, or annotate as semantically-equivalent._

### `contracts/src/core/FissionMarket.sol` mutant #11 — IfStatementMutation

_Test suite still passed with this mutation applied. Review the diff in_ `audits/mutation/gambit-out/mutants/11/contracts/src/core/FissionMarket.sol` _and either add a test that catches it, or annotate as semantically-equivalent._

### `contracts/src/core/FissionMarket.sol` mutant #12 — IfStatementMutation

_Test suite still passed with this mutation applied. Review the diff in_ `audits/mutation/gambit-out/mutants/12/contracts/src/core/FissionMarket.sol` _and either add a test that catches it, or annotate as semantically-equivalent._

### `contracts/src/core/FissionMarket.sol` mutant #13 — IfStatementMutation

_Test suite still passed with this mutation applied. Review the diff in_ `audits/mutation/gambit-out/mutants/13/contracts/src/core/FissionMarket.sol` _and either add a test that catches it, or annotate as semantically-equivalent._

### `contracts/src/core/FissionMarket.sol` mutant #16 — DeleteExpressionMutation

_Test suite still passed with this mutation applied. Review the diff in_ `audits/mutation/gambit-out/mutants/16/contracts/src/core/FissionMarket.sol` _and either add a test that catches it, or annotate as semantically-equivalent._
