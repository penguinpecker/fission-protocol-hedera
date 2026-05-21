# SECURITY_REVIEW: Ed25519 HTS facade balanceOf reverts silently zero reward / yield accrual

**Date:** 2026-05-22
**Severity:** HIGH (silent loss of user-earned rewards/yield; chain math + solvency unaffected)
**Found via:** real-mainnet observation on Market 0 (`0xfa90...8a6d`), cosigner-B wallet (`0.0.10457309` / Ed25519)

## Summary

On Hedera mainnet, the HTS ERC-20 facade `balanceOf(addr)` reverts (`CONTRACT_REVERT_EXECUTED`) when `addr` is the long-zero EVM representation of an **Ed25519** HAPI account. It only resolves correctly for contract addresses and for the EVM aliases of **ECDSA** accounts.

The Pendle-Kyber reward distribution in `FissionMarketRewards` and the global-index yield distribution in `FissionMarket` both relied on `IERC20(yt).balanceOf(user)` to compute per-user accrual. Consequence: any user whose Hedera key type is Ed25519 (the HashPack native default) silently accrued **zero** rewards and yield, no matter how long they held YT or how much fee volume flowed in.

The chain-side math, AMM curve, and PT solvency invariants are unaffected — only the user-facing distribution bookkeeping was wrong.

## Reproduction (mainnet, 2026-05-22)

Market 0 = `0xfa903b938b3bbb0d2836010e5f45edc95fd08a6d` (FissionMarketRewards, V2 LP, 90d).

| Account | Key | YT bal (raw) | `previewRewards` |
|---|---|---|---|
| Operator `0.0.10463169` | ECDSA, alias `0x32e8fd…7ab90` | 8,829,135,893 | `(46,778, 58,179,061)` ✅ |
| Cosigner B `0.0.10457309` | Ed25519, long-zero `0x…009f90dd` | 244,562,805 | `(0, 0)` ❌ |

Direct calls:

```
balanceOf(YT, ECDSA-alias)    → 8,829,135,893
balanceOf(YT, Ed25519-longzero) → CONTRACT_REVERT_EXECUTED
```

Both observed via `mainnet-public.mirrornode.hedera.com/api/v1/contracts/call` (i.e. not a Hashio cache artifact).

## Root cause

`previewRewards`, `_settleRewards`, `_accrueUser`, and `previewYield` all called `IERC20(yt).balanceOf(user)` directly through the HTS facade. Inside the contract execution context this read either reverts (propagating to a top-level revert) or silently returns 0 (Hedera precompile behavior differs subtly between eth_call from outside and execution-context from inside; in our observation the inner read returned 0, leading to silent zero accrual).

The same flaw affected the `_burnYt` refreeze branch, which used the facade `balanceOf` to decide whether to refreeze post-wipe.

## Fix

Added a contract-tracked YT balance mapping `_ytBal[address] uint256` in both `FissionMarket.sol` and `FissionMarketRewards.sol`. This mapping is updated atomically in `_mintYt` (`+= amount`) and `_burnYt` (`-= amount`). It is sound as the source of truth because YT is freeze-by-default on Hedera and the Market is the only mint/burn authority — there is no user-to-user YT transfer path that bypasses the Market.

Replaced every per-user `IERC20(yt).balanceOf(user)` call in reward/yield logic with `_ytBal[user]`:

- `FissionMarketRewards._settleRewards`
- `FissionMarketRewards.previewRewards`
- `FissionMarketRewards._burnYt` (refreeze decision)
- `FissionMarket._accrueUser`
- `FissionMarket.previewYield`
- `FissionMarket._burnYt` (refreeze decision)

`IERC20(yt).totalSupply()` reads in `_harvestRewards` are intentionally kept — `totalSupply()` is not address-resolved by the HTS precompile and is unaffected by the Ed25519 quirk; the existing 188-test suite plus 8-invariant fuzz confirm consistency.

A new public view `ytBalanceOf(address)` exposes `_ytBal` to off-chain consumers (front-end position panels, sell-YT path).

## Regression tests added

`test/unit/FissionMarketRewards.t.sol`:
- `test_ed25519_user_earns_rewards_despite_facade_revert` — flags a user as Ed25519-like via a new mock hook (`MockHederaTokenService.__setFacadeReadBroken`), then drives a full split → harvest → previewRewards → claimRewards cycle. Verifies both users (ECDSA + Ed25519) get correct pro-rata rewards.
- `test_ed25519_user_merge_and_redeem_work` — verifies `_burnYt`'s refreeze path no longer reverts on Ed25519 users.

`test/unit/FissionMarket.t.sol`:
- `test_ed25519_user_earns_yield_despite_facade_revert` — analogous regression for the global-index variant.

Full suite: **320 passed / 0 failed / 2 skipped** (up from 308). All 8 invariants × 256 runs × 128K random calls remain green.

## Mainnet impact

- Market 0 (`0xfa90...8a6d`): live since 2026-05. Two known YT holders, both pre-fix. The operator (ECDSA) has accrued correctly; cosigner B (Ed25519) has accrued nothing on-record (math says ~11,380 raw SAUCE + ~11.88M raw WHBAR were owed, real-dollar value ≈ $0.01 because seed liquidity is only $0.10/side).
- The fix is **non-upgradeable** — these are immutable contracts. The current Market 0 will continue to under-distribute to Ed25519 holders. Workarounds for the existing live market:
  1. **No Ed25519 YT holders other than cosigner B**, and her YT-side claim is sub-cent. Acceptable to absorb.
  2. Top up Market 0 seed only after redeploy with the fix, so meaningful flows happen on the patched code path.
- The fixed contracts (`FissionMarket.sol`, `FissionMarketRewards.sol`) need to be redeployed before any production traffic. See REDEPLOY PLAN below.

## Adjacent change: `swapExactYtForSy` (sell YT)

While in the contracts, added `swapExactYtForSy(uint256 ytIn, uint256 minSyOut, address receiver)` to both markets. Sells YT pre-expiry for SY in a single atomic call:

- Reads `_ytBal[msg.sender]` (Ed25519-safe).
- Settles `_settleRewards` / `_accrue` before any burn so accrued yield is preserved.
- Computes `syOwed` via the same AMM math as `swapExactSyForPt(ptOut=ytIn)`.
- Updates pool: `totalPt -= ytIn`, `totalSy += syOwed`, `lastLnImpliedRate = newRate`.
- Burns `ytIn` PT from the Market's own AMM-pool inventory (`_burnPt(address(this), ytIn)`); wipes `ytIn` YT from `msg.sender` (`_burnYt`).
- Sends `ytIn - syOwed` SY to `receiver`.

Why not a router/flash-swap pattern: YT is freeze-by-default and cannot be transferred to a Router. The Market itself holds the WIPE key on YT and SUPPLY key on PT, so it can do the equivalent of "buy PT from AMM → merge PT+YT → pay net SY to user" entirely in-place. No callback, no flash, no router custody, no reentrancy surface beyond the existing `nonReentrant`.

12 new tests cover happy path, slippage floor, insufficient YT, zero amount, zero receiver, post-expiry revert, yield/reward settling before burn, and the Ed25519 user case.

## REDEPLOY PLAN

The fix is in immutable contracts; existing Market 0 stays as a deprecated artifact. New deployment set:

1. New `StandardMarketDeployer` + `RewardsMarketDeployer` (constructor pulls fixed bytecode automatically when rebuilt).
2. New `FissionFactory` referencing the new deployers. Reuse `SY_REVIEW_WINDOW=0` for bootstrap (per `feedback_operator_first_handoff_last`).
3. New `FissionMarketRewards` for the V2 LP underlying (SY_SaucerSwapV2LP is unchanged — no Ed25519 reads in the SY itself).
4. Migrate Market 0 seed: drain via `removeLiquidity` on operator → reseed new market via `initialize`. The two existing YT holders (operator + cosigner B) cannot be migrated automatically — cosigner B's $0.005 of phantom rewards stays orphaned in Market 0's V3 NFT. Operator can claim their portion before migration.
5. Update `deployments/295.json` — mark old Market 0 as `abandoned`, add new market.
6. Update `frontend/src/lib/addresses.ts` — point at new market.
7. Multisig handoff sequence at the very end (per `feedback_operator_first_handoff_last`).

ActionRouter does NOT need redeploy — the new `swapExactYtForSy` is called directly on the market by the frontend (YT can't be proxied through a router because it's frozen).

## Files touched

```
contracts/src/core/FissionMarket.sol             (+_ytBal mapping, swapExactYtForSy, fix _accrueUser/previewYield/_burnYt)
contracts/src/core/FissionMarketRewards.sol      (+_ytBal mapping, swapExactYtForSy, fix _settleRewards/previewRewards/_burnYt)
contracts/src/interfaces/IFissionMarketCommon.sol (+swapExactYtForSy)
contracts/test/mocks/MockHederaTokenService.sol  (+__setFacadeReadBroken test hook)
contracts/test/unit/FissionMarketRewards.t.sol   (+ed25519 + sellYt tests)
contracts/test/unit/FissionMarket.t.sol          (+ed25519 + sellYt tests)
frontend/src/lib/hedera-wallet/adapter.ts        (+swapExactPtForSy, +swapExactYtForSy write-ops)
frontend/src/lib/abis-write.ts                   (+swapExactYtForSy on routerAbi + marketWriteAbi)
frontend/src/components/forms/SellPtForm.tsx     (new)
frontend/src/components/forms/SellYtForm.tsx     (new)
frontend/src/app/markets/[address]/pt/page.tsx   (Buy/Sell tab)
frontend/src/app/markets/[address]/yt/page.tsx   (Buy/Sell tab)
```
