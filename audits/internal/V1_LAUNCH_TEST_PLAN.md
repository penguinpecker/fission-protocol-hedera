# Fission Protocol Hedera — v1 Launch Test Plan

**Scope:** SaucerSwap V2 LP rewards market only (HBARX out of scope for v1).
**Mainnet (chain 295):** Factory `0x...009fb0b3`, SY_SaucerSwapV2LP `0x...009fb089`, Market 0 `0xfa90...8a6d`.
**Date opened:** 2026-05-10. Cooldown change (7d→3d) is queued as the LAST step.

---

## 0. Status snapshot (verified 2026-05-10)

| Resume step | State | Notes |
|---|---|---|
| 1. CRON_SECRET set | DONE | `frontend/.env.local` has 64-hex secret; Vercel cron protected |
| 2. Vercel prod redeploy | LIKELY DONE | Last commit triggered redeploy for WC project ID |
| 3. Top up Market 0 seed | NOT STARTED | `scripts/top-up-market0.mjs` ready; current seed ~$0.10/side |
| 4. Browser-test SIWE + HashPack | READY TO TEST | WalletConnect just wired (`db11f25`); never live-tested |
| 5. Smoke-test live UI | NOT STARTED | Walk every page/button (§2 below) |
| 6. Multisig handoff | NOT STARTED | Artifacts in `deployments/handoff/`; needs Cosigner B available |
| 7. Raise Timelock minDelay 0→48h | NOT STARTED | After handoff |
| 8. Finalize 295.json | NOT STARTED | After handoff + minDelay raise |
| 9. Cooldown 7d→3d (THIS WORK) | QUEUED LAST | §5 — source change + factory redeploy decision |

**Mainnet roles in `deployments/295.json`:** all four (factoryAdmin/marketAdmin/syAdmin/keeper) still on operator EOA `0x32e8...ab90`. Pending `beginDefaultAdminTransfer(timelock)` from 2026-05-08 still pending — Timelock has not called `acceptDefaultAdminTransfer()`.

**Live factory `SY_REVIEW_WINDOW = 0`** (bootstrap). Changing source default to 3 days only affects future factory redeploys.

---

## 1. Contract test plan — Market 0 (on-chain interactions)

All commands are read-only validation OR a single tx from a fresh test EOA holding HBAR. Use `cast`/`viem` against Hashio mainnet RPC. Each row: action → expected result → how to verify.

### 1.1 Read-only state checks (no tx)

Run **`scripts/validate-market0.mjs`** first — it asserts 33 invariants. Then the spot checks below.

| # | Check | Read | Expected |
|---|---|---|---|
| R1 | Factory admin pending | `FissionFactory.pendingDefaultAdmin()` | `(timelock, schedule)` matching `governance.timelock.evm` |
| R2 | SY admin pending | `SYBase.pendingDefaultAdmin()` on `0x...009fb089` | same as R1 |
| R3 | Market admin pending | `FissionMarketRewards.pendingDefaultAdmin()` | same as R1 |
| R4 | SY exchangeRate | `SY.exchangeRate()` | `1e18` exactly (Pendle-Kyber pattern) |
| R5 | Market expiry | `Market.expiry()` | `1785737506` |
| R6 | Market initialized | `Market.lastLnImpliedRate()` | non-zero (was set at init) |
| R7 | LP supply | `IERC20(lp).totalSupply()` | `500_000` (initial seed) |
| R8 | LP locked supply | `IERC20(lp).balanceOf(market)` | `1_000` (Pendle MIN_LIQUIDITY lock) |
| R9 | Market reserves | `Market.totalSy()`, `Market.totalPt()` | both ≈ `500_000` |
| R10 | Reward tokens | `Market.rewardToken0()`, `rewardToken1()` | USDC + WHBAR HTS addresses |
| R11 | NPM positionTokenId | `SY.positionTokenId()` | non-zero (V3 NFT minted) |
| R12 | Pause state | `Market.paused()`, `SY.paused()` | both `false` |
| R13 | Auto-association | `getContractInfo(market).maxAutomaticTokenAssociations` | `-1` (HIP-904) |
| R14 | sy_review_window | `Factory.SY_REVIEW_WINDOW()` | `0` (bootstrap; will become 259200 after §5 redeploy) |

### 1.2 Write-path tests (small amounts, fresh test EOA)

Set up: a clean Hedera EOA with ≥10 HBAR. Each test reuses the prior state.

| # | Action | Tx | Expected outcome | Verify |
|---|---|---|---|---|
| W1 | Wrap 1 HBAR → WHBAR | `WHBAR.deposit{value: 1e8}()` | balance(WHBAR) += 1 HBAR | `IERC20(whbar).balanceOf(eoa)` |
| W2 | Swap WHBAR → USDC on SaucerSwap V2 | router swap | USDC received | balance check |
| W3 | Associate PT, YT, LP, SY tokens | HTS associate | tokens associated | mirror node `account/tokens` |
| W4 | `SY.depositLiquidity(amt0, amt1, ...)` w/ msg.value≥5 HBAR | mint LP NFT path | SY shares minted; positionTokenId stays same | balance(SY) > 0; PT, YT not yet |
| W5 | `Market.split(syIn)` | mint PT + YT 1:1 | PT and YT balances increase | erc20.balanceOf(eoa) for PT, YT |
| W6 | `Market.merge(amount)` | burn PT + YT 1:1 → SY | SY returned; PT/YT decrease | balance deltas; YT was frozen — must unfreeze→wipe→refreeze internally (audit fix #9) |
| W7 | `ActionRouter.swapExactSyForPt(...)` | AMM trade | PT received; SY decrease + fee | check `lastLnImpliedRate` updates |
| W8 | `ActionRouter.swapExactPtForSy(...)` | reverse trade | SY received; PT decrease | rate updates again |
| W9 | `ActionRouter.addLiquidityProportional(...)` | mint LP token | LP balance += amount; reserves grow proportionally | both totalSy and totalPt grow |
| W10 | `Market.claimRewards(eoa)` | settle reward indexes | reward0/1 token balances increase | USDC + WHBAR fees claimed |
| W11 | `ActionRouter.removeLiquidityProportional(...)` | burn LP | SY + PT returned | LP supply decreases |
| W12 | Post-expiry only: `redeemAfterExpiry(pt=X, yt=0)` | PT redeems for SY at frozen `globalIndex` (1:1 since rate=1e18) | SY = pt * 1e18 / globalIndex | rewards-market REJECTS yt > 0 (audit fix M-2) |

### 1.3 Negative tests (should revert)

| # | Action | Expected revert |
|---|---|---|
| N1 | `redeemAfterExpiry` BEFORE expiry | `MarketNotExpired` |
| N2 | `swap` AFTER expiry | `MarketExpired` |
| N3 | `addLiquidity` w/ slippage too tight | slippage revert |
| N4 | `redeemAfterExpiry(pt=0, yt>0)` on rewards market | rejects (M-2 fix) |
| N5 | Non-pauser calls `pause()` | AccessControl revert |
| N6 | Operator calls SY admin function after handoff completes | revert (post step 6) |
| N7 | Anyone calls `Factory.proposeSY(addr)` w/o ADMIN_ROLE | AccessControl revert |
| N8 | `confirmSY` before review-window elapses (will matter post-§5) | `SYReviewPending` |

### 1.4 Indexer / cache verification

| # | Action | Expected |
|---|---|---|
| I1 | `curl -X GET https://<vercel-url>/api/markets/refresh -H "Authorization: Bearer $CRON_SECRET"` | 200 OK; cache row in Supabase `markets_cache` |
| I2 | `curl https://<vercel-url>/api/markets` | 200 OK; market 0 listed with current implied APY |
| I3 | After W5+W7, run I1 again | `markets_cache.lastLnImpliedRate` and reserves updated |

---

## 2. Frontend test plan — page/button/popup walk

Use a fresh Chrome profile with HashPack installed. Open dev tools → Network tab. Test mainnet build (Vercel preview or prod), not local dev.

### 2.1 Landing `/`

| # | Action | Expected |
|---|---|---|
| F1 | Load `/` | Hero renders with logo, three strategy cards (Buy PT / Buy YT / Split SY), no console errors |
| F2 | Click "Explore markets" | navigate to `/markets` |
| F3 | Click "View source" | external GitHub link opens in new tab |

### 2.2 `/markets` (unauthenticated)

| # | Action | Expected |
|---|---|---|
| F4 | Load `/markets` | Market 0 row appears (cached + fallback live multicall); shows implied APY %, SY locked, PT in pool, LP supply |
| F5 | Star button on Market 0 row (no auth) | clicking triggers SIWE prompt OR no-op with toast "Sign in required" |
| F6 | "My watchlist" toggle (no auth) | shows empty state with "Sign in" CTA |
| F7 | Click market row | navigate to `/markets/0xfa90...8a6d` |

### 2.3 `/markets/[address]`

| # | Action | Expected |
|---|---|---|
| F8 | Load detail page | Strategy guide card; stats card with five values; YTD/days-to-expiry shown |
| F9 | Switch tabs Buy PT / Buy YT / Split SY | active tab styled; trade card form changes |
| F10 | Without wallet connected, click "Connect wallet" | dropdown shows: HashPack, Blade, MetaMask, WalletConnect |
| F11 | Click HashPack option | HashPack extension popup; user approves; address shown in nav |
| F12 | (Optional) Try Blade or WalletConnect | each shows respective popup/QR |
| F13 | After connect, "Sign In" button appears | one-click triggers wallet sign popup with SIWE message |
| F14 | Approve sign | green dot in nav + Profile link visible; cookie `fission_session` set, httpOnly |
| F15 | Slippage slider | move 0.5% → 5%, value updates |
| F16 | Enter amount in Split tab → submit | wallet popup with `Market.split(amt)` calldata; approve → tx hash shown; success state |
| F17 | Buy PT tab → enter SY → submit | wallet popup w/ `Router.swapExactSyForPt(...)` |
| F18 | Buy YT tab → enter SY budget → submit | wallet popup w/ `Router.buyYT(...)` |
| F19 | Add Liquidity (if exposed in UI) | popup w/ `Router.addLiquidityProportional` |
| F20 | Disconnect | nav reverts; calls `signOut()` then `disconnect()`; cookie cleared |

### 2.4 `/profile`

| # | Action | Expected |
|---|---|---|
| F21 | Load `/profile` while signed in | Wallet address + member-since visible; form fields editable |
| F22 | Edit display_name → Save | `PATCH /api/profile` 200; toast success |
| F23 | Set bad avatar URL (`javascript:alert(1)`) → Save | currently accepted; **HARDENING: see §4** |
| F24 | Sign out from nav | redirects; profile gates with "Sign in required" |

### 2.5 Watchlist flow

| # | Action | Expected |
|---|---|---|
| F25 | Star Market 0 row (signed in) | star fills; `POST /api/watchlists` 200; optimistic flip |
| F26 | Reload `/markets` | star still filled (server state) |
| F27 | "My watchlist" toggle | only Market 0 visible |
| F28 | Unstar | star empties; `DELETE /api/watchlists?...` 200 |

### 2.6 Negative / edge UX

| # | Action | Expected |
|---|---|---|
| F29 | Submit trade with no amount | button disabled, label "Enter amount" |
| F30 | Submit trade not connected | button disabled, label "Connect wallet" |
| F31 | Reject sign-in popup | UI returns to idle; no cookie set; no console crash |
| F32 | Reject trade popup | trade card returns to idle |
| F33 | Hit `/api/markets/refresh` without `CRON_SECRET` | 401 |
| F34 | Hit `/api/profile` GET without cookie | 401 |
| F35 | Cron empty data: `markets_cache` empty | UI falls back to on-chain multicall, still renders |

### 2.7 Console / network audit (per page)

For each page F1, F4, F8, F21:
- 0 console errors
- 0 console warnings besides Next.js dev-only ones (in prod)
- All network calls return 200 or expected 401
- No third-party tracker pixels

---

## 3. End-to-end live-mainnet smoke sequence

Do these in order. Stop on first failure.

1. `scripts/validate-market0.mjs` → expect 33/33 green.
2. `curl https://<prod>/api/markets/refresh -H "Authorization: Bearer $CRON_SECRET"` → 200.
3. Browser walk §2.1–§2.6 with HashPack, then with WalletConnect (Reown QR).
4. `scripts/top-up-market0.mjs` to grow seed from $0.10/side to $50–100/side. (Use SKIP_WRAP/SKIP_SWAP env on resume if mid-run fails.)
5. Re-run §1.1 R7–R9: LP supply and reserves grew proportionally.
6. UI flow: Split → Swap PT → Swap back → Claim Rewards → Add LP → Remove LP. Each succeeds; balances reconcile.
7. Force a tx revert in UI (e.g. set slippage 0.01%, submit a trade that moves price 0.5%) → user sees graceful error toast, not a crash.

---

## 4. Pre-handoff hardening (small)

Before step 6 (multisig handoff), apply:

- **`frontend/src/app/api/profile/route.ts`** — add URL allowlist for `avatar_url` (block `javascript:`, `data:`, only allow `https?://`).
- **`frontend/src/lib/auth/session.ts`** — assert `SESSION_SECRET.length >= 32` at module top so server boots with a clear error if misconfigured.
- **`frontend/src/lib/wagmi.ts:38`** — leave `any` (EIP-6963 migration is v1.1).

These are tiny — can land in one commit titled "frontend: pre-handoff input hardening" before walking the §2 plan.

---

## 5. Multisig handoff (steps 6–8)

Only after §3 smoke green and Cosigner B available.

### 5.1 Broadcast deployer side
```
node scripts/broadcast-deployer-handoff.mjs
```
This sends 4 `beginDefaultAdminTransfer(timelock)` txs (already prepared in `deployments/handoff/deployer-side.json`).

Verify each: `cast call <addr> "pendingDefaultAdmin()" --rpc-url $HASHIO_RPC` returns `(timelock, schedule)`.

### 5.2 Threshold scheduleBatch on Timelock
Calldata in `deployments/handoff/timelock-batch.json`. Threshold (operator + Cosigner B) signs the same Hedera `ContractExecuteTransaction` calling `Timelock.scheduleBatch(...)` with:
- 4× `acceptDefaultAdminTransfer()` (factory, sy, market, sy_hbarx if still admin'd)
- N× `revokeRole(role, deployer)` for any auxiliary roles

minDelay=0 → executable immediately.

### 5.3 Threshold executeBatch
Same threshold, second tx: `Timelock.executeBatch(...)`. After this:
- `cast call <factory> "hasRole(0x00...,deployer)" → false`
- `cast call <factory> "hasRole(0x00...,timelock) → true`
- Repeat for SY, Market.

### 5.4 Raise minDelay 0 → 48h
Threshold `scheduleBatch` + `executeBatch` on `Timelock.updateDelay(172800)`. From this point every admin op waits 48h.

### 5.5 Finalize `deployments/295.json`
Bump `deployedAt`, append note describing handoff completion + new `factoryAdmin = timelock`. Commit.

---

## 6. COOLDOWN 7d→3d (LAST step, after §5 complete)

**Source-only change (cheap):**

```diff
contracts/src/core/FissionFactory.sol:31
-    /// @notice Review window between proposeSY and confirmSY. Can be 0 for testnet,
-    ///         production deploys pass 7 days for the Penpie defence; configurable
-    ///         per-deployment.
+    /// @notice Review window between proposeSY and confirmSY. Can be 0 for testnet,
+    ///         production deploys pass 3 days for the Penpie defence; configurable
+    ///         per-deployment.

contracts/script/Deploy.s.sol:42
-        uint256 syReviewWindow = vm.envOr("SY_REVIEW_WINDOW", uint256(7 days));
+        uint256 syReviewWindow = vm.envOr("SY_REVIEW_WINDOW", uint256(3 days));

contracts/script/MainnetDeploy.s.sol:104
-        uint256 syReviewWindow = vm.envOr("SY_REVIEW_WINDOW", uint256(7 days));
+        uint256 syReviewWindow = vm.envOr("SY_REVIEW_WINDOW", uint256(3 days));

contracts/script/MainnetDeploy.s.sol:161
-        console2.log("2. Wait 7 days (contract-enforced).");
+        console2.log("2. Wait 3 days (contract-enforced).");
```

Plus update `docs/MAINNET_DEPLOY.md` and `docs/ARCHITECTURE.md` "7-day Penpie review window" → "3-day".

**Important caveat — does NOT change the live factory.**
The deployed factory at `0x...009fb0b3` has `SY_REVIEW_WINDOW=0` baked in (immutable). To enforce 3 days on mainnet, pick one:

**Option A (simple, deferred):** Source-only change. Next factory redeploy enforces 3 days. The current SaucerSwap-only factory keeps `SY_REVIEW_WINDOW=0` for v1 — fine because the only SY in it is already proposed+confirmed and 2-of-2 ThresholdKey + 48h Timelock provides defense-in-depth.

**Option B (full enforcement, ~half-day op):** After §5 handoff completes, deploy a NEW factory with `SY_REVIEW_WINDOW=259200`, propose SY_SaucerSwapV2LP, wait 3 days, confirm; then leave old factory alongside (Market 0 keeps working — markets are admin'd by Timelock independently of factory). Old factory becomes legacy.

**Recommendation:** Option A. The bootstrap factory's missing window is mitigated by Timelock + ThresholdKey. Save Option B for if/when we add a second SY token.

**Procedure for Option A (last commit before declaring v1 done):**
1. Apply the 4 source edits above
2. Run `forge build` — must compile clean
3. Run `forge test` — full suite must stay green (no test asserts the 7d default)
4. Update docs (`MAINNET_DEPLOY.md`, `ARCHITECTURE.md`)
5. Update memory: `~/.claude/projects/-Users-pp/memory/project_fission_protocol_hedera_rebuild.md`
6. Commit: `contracts: narrow SY_REVIEW_WINDOW default 7d → 3d for future redeploys`
7. Push

Done. v1 ships.

---

## Appendix — quick command index

```bash
# Validate Market 0 (read-only, 33 checks)
node scripts/validate-market0.mjs

# Top up Market 0
HBAR_TO_WRAP=10 HBAR_TO_SWAP_FOR_USDC=5 USDC_AMOUNT_OUT_MIN=0 \
  node scripts/top-up-market0.mjs

# Trigger indexer manually
curl -X POST https://<prod>/api/markets/refresh \
  -H "Authorization: Bearer $CRON_SECRET"

# Read public markets cache
curl https://<prod>/api/markets

# Broadcast deployer-side handoff (step 5.1)
node scripts/broadcast-deployer-handoff.mjs

# Verify role state on a contract
cast call 0x...009fb0b3 "hasRole(bytes32,address)(bool)" \
  0x0000000000000000000000000000000000000000000000000000000000000000 \
  0x32e8fd8434badbcc5d79e70e1fe0d16f86a7ab90 \
  --rpc-url $HASHIO_RPC
```
