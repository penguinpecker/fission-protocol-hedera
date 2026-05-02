# Contributing

Thanks for considering a contribution. The protocol is in active development;
the bar for changes to `contracts/src/` is **audit-grade** quality:

## Process

1. Open an issue describing the change before writing code (unless it's a
   trivial fix — typo, dead-code removal).
2. Fork + branch + PR. Keep PRs focused; one logical change per PR.
3. CI must be green: `forge test`, `forge fmt --check`, `slither`, build.

## Quality bars for contracts

- Every new external function has a Foundry test or fuzz / invariant covering it.
- Mutation kill rate stays ≥ 85 % on math libraries (`PMath`, `MarketMath`).
- Halmos specs pass on any new code in `src/libraries/`.
- Round in the protocol's favour at every conversion. Document the rounding
  direction at the call site if non-obvious.
- Custom errors over revert strings.
- No new dependencies without discussion (they expand the audit surface).
- No external calls inside loops (gas + reentrancy risk).
- `nonReentrant` on every external entry that touches user funds.

## Quality bars for frontend / keeper

- TypeScript strict mode, `noUncheckedIndexedAccess: true`.
- No synthetic data on user-visible surfaces — every number must trace back to
  an on-chain or Mirror Node read.
- Build must succeed: `npx next build` (frontend), `npx tsc --noEmit` (keeper).

## Commit style

Conventional-ish but human-first. The first line is a summary; the body
explains *why*. Examples in the existing log:

```
Phase 4a: FissionMarket — AMM, yield accrual, post-expiry redemption

Three coupled changes:
  1. PT/YT decimals now match the SY/asset (per Pendle V2)...
```

`Co-Authored-By:` lines for AI assistance are appreciated.

## Architecture decisions

If your change touches the design space documented in `docs/ARCHITECTURE.md`,
update that doc in the same PR. Decisions land in code AND in docs together.
