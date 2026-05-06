# Mutation testing results

Ran at: `2026-05-06T23:30:27Z` — total elapsed `5062.7s`

**Overall:** 85/100 killed (85.0%)

## By file

| File | Mutants | Killed | Survived | Kill % |
|------|--------:|-------:|---------:|-------:|
| `contracts/src/libraries/MarketMath.sol` | 50 | 47 | 3 | 94.0 |
| `contracts/src/core/FissionMarket.sol` | 50 | 38 | 12 | 76.0 |

## Survived mutants

Mutants that survived (tests still passed despite the change) reveal coverage gaps. Each survived mutant should be reviewed: either the mutation is semantically equivalent, or a new test is needed.

### `contracts/src/libraries/MarketMath.sol` mutant #43 — UnaryOperatorMutation

_Test suite still passed with this mutation applied. Review the diff in_ `audits/mutation/gambit-out/mutants/43/contracts/src/libraries/MarketMath.sol` _and either add a test that catches it, or annotate as semantically-equivalent._

### `contracts/src/libraries/MarketMath.sol` mutant #44 — UnaryOperatorMutation

_Test suite still passed with this mutation applied. Review the diff in_ `audits/mutation/gambit-out/mutants/44/contracts/src/libraries/MarketMath.sol` _and either add a test that catches it, or annotate as semantically-equivalent._

### `contracts/src/libraries/MarketMath.sol` mutant #45 — BinaryOpMutation

_Test suite still passed with this mutation applied. Review the diff in_ `audits/mutation/gambit-out/mutants/45/contracts/src/libraries/MarketMath.sol` _and either add a test that catches it, or annotate as semantically-equivalent._

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

### `contracts/src/core/FissionMarket.sol` mutant #14 — AssignmentMutation

_Test suite still passed with this mutation applied. Review the diff in_ `audits/mutation/gambit-out/mutants/14/contracts/src/core/FissionMarket.sol` _and either add a test that catches it, or annotate as semantically-equivalent._

### `contracts/src/core/FissionMarket.sol` mutant #16 — DeleteExpressionMutation

_Test suite still passed with this mutation applied. Review the diff in_ `audits/mutation/gambit-out/mutants/16/contracts/src/core/FissionMarket.sol` _and either add a test that catches it, or annotate as semantically-equivalent._

### `contracts/src/core/FissionMarket.sol` mutant #20 — IfStatementMutation

_Test suite still passed with this mutation applied. Review the diff in_ `audits/mutation/gambit-out/mutants/20/contracts/src/core/FissionMarket.sol` _and either add a test that catches it, or annotate as semantically-equivalent._

### `contracts/src/core/FissionMarket.sol` mutant #21 — UnaryOperatorMutation

_Test suite still passed with this mutation applied. Review the diff in_ `audits/mutation/gambit-out/mutants/21/contracts/src/core/FissionMarket.sol` _and either add a test that catches it, or annotate as semantically-equivalent._

### `contracts/src/core/FissionMarket.sol` mutant #24 — AssignmentMutation

_Test suite still passed with this mutation applied. Review the diff in_ `audits/mutation/gambit-out/mutants/24/contracts/src/core/FissionMarket.sol` _and either add a test that catches it, or annotate as semantically-equivalent._

### `contracts/src/core/FissionMarket.sol` mutant #27 — IfStatementMutation

_Test suite still passed with this mutation applied. Review the diff in_ `audits/mutation/gambit-out/mutants/27/contracts/src/core/FissionMarket.sol` _and either add a test that catches it, or annotate as semantically-equivalent._

### `contracts/src/core/FissionMarket.sol` mutant #32 — BinaryOpMutation

_Test suite still passed with this mutation applied. Review the diff in_ `audits/mutation/gambit-out/mutants/32/contracts/src/core/FissionMarket.sol` _and either add a test that catches it, or annotate as semantically-equivalent._
