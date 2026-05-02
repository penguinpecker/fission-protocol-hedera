# Security policy

## Status

Pre-audit. **Do not use in production with real funds.** Mainnet deploy is gated on
the Phase 9 audit pipeline (see `docs/IMPLEMENTATION_PLAN.md`).

## Scope

Smart contracts in `contracts/src/` are in scope. The frontend (`frontend/`) and
keeper (`keeper/`) are operational components; security issues there are also
welcome but the smart contracts are the primary attack surface for funds.

## Reporting

Until the bug bounty is live on Immunefi (target: post-audit):

- Open a private security advisory at
  https://github.com/penguinpecker/fission-protocol-hedera/security/advisories
- Or email the maintainers (address in `CODEOWNERS`).

We acknowledge within 48 hours and aim for a fix or written explanation within
14 days for high-severity issues.

## Known severity classes

We use Sherlock's framework: Critical / High / Medium / Low / Info. Anything that
breaks one of the **conservation invariants** below is at minimum High.

### Conservation invariants (the things that MUST hold)

1. **Solvency**:
   ```
   sy.balanceOf(market) * sy.exchangeRate()  >=
       pt.totalSupply() * 1e18 + sum(userOwed) * sy.exchangeRate()
   ```
2. **Pool PT consistency**: `pt.balanceOf(market) == market.totalPt()`.
3. **Supply parity pre-expiry**: `pt.totalSupply() == yt.totalSupply()`.
4. **Round-trip cost is non-negative**: a user buying and selling the same PT
   amount in the same block can never extract value from the pool.
5. **Trade reversibility bounds**: round-trip SY out ≤ SY in.
6. **lastLnImpliedRate consistency**: a swap's post-state implied rate matches
   the new (totalPt, totalSy) configuration.

These are tested as Foundry invariants in `test/invariant/` and as Halmos specs
in `test/symbolic/`.

## Out of scope

- Issues that require admin compromise (the multisig + timelock are the trust
  root; their compromise is an organisational, not a code, issue).
- Frontend phishing replicas.
- Hedera consensus / network bugs.
- Already-known issues listed in audit reports under `audits/`.

## Bug bounty (post-launch)

Live on Immunefi at protocol mainnet launch with $50K initial cap, scaling to
10% of TVL up to a fixed maximum. Tier breakdown follows Immunefi's standard
high/medium/low pay-out scale.
