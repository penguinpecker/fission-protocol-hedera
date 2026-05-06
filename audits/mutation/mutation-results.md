# Mutation testing results

Ran at: `2026-05-06T21:58:03Z` — total elapsed `5020.8s`

**Overall:** 64/100 killed (64.0%)

## By file

| File | Mutants | Killed | Survived | Kill % |
|------|--------:|-------:|---------:|-------:|
| `contracts/src/libraries/MarketMath.sol` | 50 | 37 | 13 | 74.0 |
| `contracts/src/core/FissionMarket.sol` | 50 | 27 | 23 | 54.0 |

## Survived mutants

Mutants that survived (tests still passed despite the change) reveal coverage gaps. Each survived mutant should be reviewed: either the mutation is semantically equivalent, or a new test is needed.

### `contracts/src/libraries/MarketMath.sol` mutant #21 — AssignmentMutation

_Test suite still passed with this mutation applied. Review the diff in_ `audits/mutation/gambit-out/mutants/21/contracts/src/libraries/MarketMath.sol` _and either add a test that catches it, or annotate as semantically-equivalent._

### `contracts/src/libraries/MarketMath.sol` mutant #22 — BinaryOpMutation

_Test suite still passed with this mutation applied. Review the diff in_ `audits/mutation/gambit-out/mutants/22/contracts/src/libraries/MarketMath.sol` _and either add a test that catches it, or annotate as semantically-equivalent._

### `contracts/src/libraries/MarketMath.sol` mutant #24 — BinaryOpMutation

_Test suite still passed with this mutation applied. Review the diff in_ `audits/mutation/gambit-out/mutants/24/contracts/src/libraries/MarketMath.sol` _and either add a test that catches it, or annotate as semantically-equivalent._

### `contracts/src/libraries/MarketMath.sol` mutant #26 — SwapArgumentsOperatorMutation

_Test suite still passed with this mutation applied. Review the diff in_ `audits/mutation/gambit-out/mutants/26/contracts/src/libraries/MarketMath.sol` _and either add a test that catches it, or annotate as semantically-equivalent._

### `contracts/src/libraries/MarketMath.sol` mutant #33 — DeleteExpressionMutation

_Test suite still passed with this mutation applied. Review the diff in_ `audits/mutation/gambit-out/mutants/33/contracts/src/libraries/MarketMath.sol` _and either add a test that catches it, or annotate as semantically-equivalent._

### `contracts/src/libraries/MarketMath.sol` mutant #34 — AssignmentMutation

_Test suite still passed with this mutation applied. Review the diff in_ `audits/mutation/gambit-out/mutants/34/contracts/src/libraries/MarketMath.sol` _and either add a test that catches it, or annotate as semantically-equivalent._

### `contracts/src/libraries/MarketMath.sol` mutant #35 — AssignmentMutation

_Test suite still passed with this mutation applied. Review the diff in_ `audits/mutation/gambit-out/mutants/35/contracts/src/libraries/MarketMath.sol` _and either add a test that catches it, or annotate as semantically-equivalent._

### `contracts/src/libraries/MarketMath.sol` mutant #36 — BinaryOpMutation

_Test suite still passed with this mutation applied. Review the diff in_ `audits/mutation/gambit-out/mutants/36/contracts/src/libraries/MarketMath.sol` _and either add a test that catches it, or annotate as semantically-equivalent._

### `contracts/src/libraries/MarketMath.sol` mutant #37 — BinaryOpMutation

_Test suite still passed with this mutation applied. Review the diff in_ `audits/mutation/gambit-out/mutants/37/contracts/src/libraries/MarketMath.sol` _and either add a test that catches it, or annotate as semantically-equivalent._

### `contracts/src/libraries/MarketMath.sol` mutant #43 — UnaryOperatorMutation

_Test suite still passed with this mutation applied. Review the diff in_ `audits/mutation/gambit-out/mutants/43/contracts/src/libraries/MarketMath.sol` _and either add a test that catches it, or annotate as semantically-equivalent._

### `contracts/src/libraries/MarketMath.sol` mutant #44 — UnaryOperatorMutation

_Test suite still passed with this mutation applied. Review the diff in_ `audits/mutation/gambit-out/mutants/44/contracts/src/libraries/MarketMath.sol` _and either add a test that catches it, or annotate as semantically-equivalent._

### `contracts/src/libraries/MarketMath.sol` mutant #45 — BinaryOpMutation

_Test suite still passed with this mutation applied. Review the diff in_ `audits/mutation/gambit-out/mutants/45/contracts/src/libraries/MarketMath.sol` _and either add a test that catches it, or annotate as semantically-equivalent._

### `contracts/src/libraries/MarketMath.sol` mutant #48 — IfStatementMutation

_Test suite still passed with this mutation applied. Review the diff in_ `audits/mutation/gambit-out/mutants/48/contracts/src/libraries/MarketMath.sol` _and either add a test that catches it, or annotate as semantically-equivalent._

### `contracts/src/core/FissionMarket.sol` mutant #6 — BinaryOpMutation

_Test suite still passed with this mutation applied. Review the diff in_ `audits/mutation/gambit-out/mutants/6/contracts/src/core/FissionMarket.sol` _and either add a test that catches it, or annotate as semantically-equivalent._

### `contracts/src/core/FissionMarket.sol` mutant #8 — IfStatementMutation

_Test suite still passed with this mutation applied. Review the diff in_ `audits/mutation/gambit-out/mutants/8/contracts/src/core/FissionMarket.sol` _and either add a test that catches it, or annotate as semantically-equivalent._

### `contracts/src/core/FissionMarket.sol` mutant #10 — AssignmentMutation

_Test suite still passed with this mutation applied. Review the diff in_ `audits/mutation/gambit-out/mutants/10/contracts/src/core/FissionMarket.sol` _and either add a test that catches it, or annotate as semantically-equivalent._

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

### `contracts/src/core/FissionMarket.sol` mutant #17 — DeleteExpressionMutation

_Test suite still passed with this mutation applied. Review the diff in_ `audits/mutation/gambit-out/mutants/17/contracts/src/core/FissionMarket.sol` _and either add a test that catches it, or annotate as semantically-equivalent._

### `contracts/src/core/FissionMarket.sol` mutant #18 — AssignmentMutation

_Test suite still passed with this mutation applied. Review the diff in_ `audits/mutation/gambit-out/mutants/18/contracts/src/core/FissionMarket.sol` _and either add a test that catches it, or annotate as semantically-equivalent._

### `contracts/src/core/FissionMarket.sol` mutant #20 — IfStatementMutation

_Test suite still passed with this mutation applied. Review the diff in_ `audits/mutation/gambit-out/mutants/20/contracts/src/core/FissionMarket.sol` _and either add a test that catches it, or annotate as semantically-equivalent._

### `contracts/src/core/FissionMarket.sol` mutant #21 — UnaryOperatorMutation

_Test suite still passed with this mutation applied. Review the diff in_ `audits/mutation/gambit-out/mutants/21/contracts/src/core/FissionMarket.sol` _and either add a test that catches it, or annotate as semantically-equivalent._

### `contracts/src/core/FissionMarket.sol` mutant #24 — AssignmentMutation

_Test suite still passed with this mutation applied. Review the diff in_ `audits/mutation/gambit-out/mutants/24/contracts/src/core/FissionMarket.sol` _and either add a test that catches it, or annotate as semantically-equivalent._

### `contracts/src/core/FissionMarket.sol` mutant #27 — IfStatementMutation

_Test suite still passed with this mutation applied. Review the diff in_ `audits/mutation/gambit-out/mutants/27/contracts/src/core/FissionMarket.sol` _and either add a test that catches it, or annotate as semantically-equivalent._

### `contracts/src/core/FissionMarket.sol` mutant #30 — DeleteExpressionMutation

_Test suite still passed with this mutation applied. Review the diff in_ `audits/mutation/gambit-out/mutants/30/contracts/src/core/FissionMarket.sol` _and either add a test that catches it, or annotate as semantically-equivalent._

### `contracts/src/core/FissionMarket.sol` mutant #31 — BinaryOpMutation

_Test suite still passed with this mutation applied. Review the diff in_ `audits/mutation/gambit-out/mutants/31/contracts/src/core/FissionMarket.sol` _and either add a test that catches it, or annotate as semantically-equivalent._

### `contracts/src/core/FissionMarket.sol` mutant #32 — BinaryOpMutation

_Test suite still passed with this mutation applied. Review the diff in_ `audits/mutation/gambit-out/mutants/32/contracts/src/core/FissionMarket.sol` _and either add a test that catches it, or annotate as semantically-equivalent._

### `contracts/src/core/FissionMarket.sol` mutant #40 — BinaryOpMutation

_Test suite still passed with this mutation applied. Review the diff in_ `audits/mutation/gambit-out/mutants/40/contracts/src/core/FissionMarket.sol` _and either add a test that catches it, or annotate as semantically-equivalent._

### `contracts/src/core/FissionMarket.sol` mutant #41 — SwapArgumentsOperatorMutation

_Test suite still passed with this mutation applied. Review the diff in_ `audits/mutation/gambit-out/mutants/41/contracts/src/core/FissionMarket.sol` _and either add a test that catches it, or annotate as semantically-equivalent._

### `contracts/src/core/FissionMarket.sol` mutant #42 — BinaryOpMutation

_Test suite still passed with this mutation applied. Review the diff in_ `audits/mutation/gambit-out/mutants/42/contracts/src/core/FissionMarket.sol` _and either add a test that catches it, or annotate as semantically-equivalent._

### `contracts/src/core/FissionMarket.sol` mutant #43 — BinaryOpMutation

_Test suite still passed with this mutation applied. Review the diff in_ `audits/mutation/gambit-out/mutants/43/contracts/src/core/FissionMarket.sol` _and either add a test that catches it, or annotate as semantically-equivalent._

### `contracts/src/core/FissionMarket.sol` mutant #47 — DeleteExpressionMutation

_Test suite still passed with this mutation applied. Review the diff in_ `audits/mutation/gambit-out/mutants/47/contracts/src/core/FissionMarket.sol` _and either add a test that catches it, or annotate as semantically-equivalent._

### `contracts/src/core/FissionMarket.sol` mutant #48 — AssignmentMutation

_Test suite still passed with this mutation applied. Review the diff in_ `audits/mutation/gambit-out/mutants/48/contracts/src/core/FissionMarket.sol` _and either add a test that catches it, or annotate as semantically-equivalent._
