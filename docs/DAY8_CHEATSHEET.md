# Day 8 finish — paste-and-execute cheat sheet

This is the single sheet to follow on **Day 8 of the Phase C cutover**, after the
7-day SY-review window has elapsed. Every command below assumes:

- Day 0 already happened: fresh prod factory + new SY (if redeploying) deployed,
  `proposeSY` already broadcast, 7-day clock started.
- Threshold account + Timelock already provisioned (task #12).
- Operator HBAR ≥ ~150 HBAR + your chosen seed amount.

If any of those isn't true, **stop** and resolve first.

---

## Snapshot — operator state (live, 2026-05-07)

| Asset | Balance | Token ID | Notes |
|-------|--------:|----------|-------|
| HBAR  | **351.30** | — | Need ~100 HBAR for protocol + ~5 for handoff + your seed budget. ✅ enough for ~$50/side seed. |
| USDC  | **$1.76** | `0.0.456858` | Need to top up before Day 8 if seeding >$1 in USDC. |
| WHBAR | **0** | `0.0.1456986` | Wrap HBAR via WHBAR contract OR via SaucerSwap router. |

If seeding production-sized ($1000+ each side):
- Need ~$1000 of USDC ⇒ ~4000 HBAR equivalent at current rate.
- Need ~$1000 of WHBAR ⇒ ~4000 HBAR.
- That's ~8000 HBAR total → operator needs to top up by ~7700 HBAR before Day 8.

---

## 0. Before any tx — sanity checks

```sh
cd ~/Desktop/Projects/fission-protocol-hedera
source scripts/load-env.sh

# Operator + new factory + Timelock + threshold all match deployments/295.json.governance:
jq '.governance, .factory, .sy_saucer_v2_lp' deployments/295.json

# Operator HBAR ≥ 150 + your seed amount:
node -e "fetch('https://mainnet-public.mirrornode.hedera.com/api/v1/accounts/0.0.10463169').then(r=>r.json()).then(d=>console.log('HBAR:', d.balance.balance/1e8))"

# Validate live state of the SY adapter (must already have positionTokenId):
node scripts/validate-market0.mjs
```

If any of those misalign — stop, fix, retry.

---

## 1. confirmSY (both — if you redeployed any)

```sh
NEW_FACTORY=$(jq -r '.factory.evm' deployments/295.json)
SY_SAUCER=$(jq -r '.sy_saucer_v2_lp.evm' deployments/295.json)

node scripts/confirm-sy.mjs $NEW_FACTORY $SY_SAUCER
# (HBARX is dropped from v1 — only V2 LP)
```

**Expected:** `SYConfirmed` event for `SY_SaucerSwapV2LP` on the factory.

---

## 2. createRewardsMarket — V2 LP, 90-day

```sh
EXPIRY_UNIX=$(($(date +%s) + 90*24*3600))
echo "Maturity: $(date -r $EXPIRY_UNIX)"

FACTORY_ADDRESS=$NEW_FACTORY \
SY_SAUCER_V2_LP_ADDRESS=$SY_SAUCER \
RWD_EXPIRY=$EXPIRY_UNIX \
RWD_SCALAR_ROOT=75e18 \
RWD_SUFFIX="SS-V2-90D" \
node scripts/create-markets.mjs --rewards-only
```

**Expected:** Market deployed; `MarketCreated` event with PT/YT/LP HTS tokens
spawned (~60 HBAR used on this tx).

```sh
# Capture new market address into deployments/295.json
NEW_MARKET=<paste from create-markets stdout>
```

---

## 3. Acquire seed assets (skip if already topped up)

Decide seed size upfront. Recommend **$X/side** (your call). Below assumes
$1000/side as an example.

```sh
# Wrap HBAR → WHBAR (1:1, on-chain)
node scripts/wrap-hbar.mjs 4000   # wraps 4000 HBAR ≈ $1000 worth

# Swap WHBAR → USDC via SaucerSwap router. Use the existing initialize-saucer
# script's swap step or do via SaucerSwap UI manually.
```

Verify balances post-acquire:
```sh
node -e "/* same as section 0 — confirm USDC and WHBAR balances ≥ seed */"
```

---

## 4. Initialize the new market

```sh
MARKET_ADDRESS=$NEW_MARKET \
SY_SAUCER_V2_LP_ADDRESS=$SY_SAUCER \
USDC_DEPOSIT=<microUSDC>           # e.g. 1000000000 = $1000
WHBAR_DEPOSIT=<weiWHBAR>           # e.g. 4000_00000000 (8 dec) for 4000 WHBAR
INITIAL_ANCHOR_E18=1020000000000000000   # 1.02e18 = 2% implied yield
LN_FEE_RATE_ROOT_E18=300000000000000     # 3e14 = ~0.03% trade fee
RESERVE_FEE_PERCENT=80 \
SKIP_WRAP=1 SKIP_SWAP=1 \
node scripts/initialize-saucer-market.mjs
```

**Expected:** `Initialized` event on Market; `lp_total_supply > 0`;
`lastLnImpliedRate` set; SY shares minted; Market holds them.

---

## 5. Handoff to threshold + Timelock

```sh
PROD_THRESHOLD_EVM=$(jq -r '.governance.threshold.evm' deployments/295.json) \
PROD_TIMELOCK=$(jq -r '.governance.timelock.evm' deployments/295.json) \
PROD_FACTORY=$NEW_FACTORY \
node scripts/prep-handoff.mjs

# That writes deployments/handoff/{deployer-side.json,timelock-batch.json,RUNBOOK.md}.
# Then:
#   - Deployer broadcasts each tx in deployer-side.json (cast send / SDK).
#   - Threshold account broadcasts the Timelock.scheduleBatch tx.
#   - Wait `minDelay` (0 first cutover; raise to 48h after).
#   - Threshold account broadcasts Timelock.executeBatch.
# Verify with cast call: hasRole(0x0..0, deployer) == false on every contract.
```

---

## 6. Update deployments/295.json

```sh
# Move old factory to abandoned, write new addresses, write new market entry.
# Then:
git add deployments/295.json
git commit -m "Phase C complete: new prod factory + V2 LP market live; admin handed off"
git push origin main
```

---

## 7. Vercel env-var update + redeploy

```sh
# Update .env.local with new addresses:
sed -i '' "s|^NEXT_PUBLIC_FACTORY_ADDRESS=.*|NEXT_PUBLIC_FACTORY_ADDRESS=$NEW_FACTORY|" frontend/.env.local
sed -i '' "s|^NEXT_PUBLIC_SY_SAUCER_V2_LP_ADDRESS=.*|NEXT_PUBLIC_SY_SAUCER_V2_LP_ADDRESS=$SY_SAUCER|" frontend/.env.local
# (NEXT_PUBLIC_ROUTER_ADDRESS is unchanged — router is reused.)

bash scripts/deploy-vercel.sh prod
```

**Expected:** new deploy at https://frontend-nine-red-31.vercel.app pointing at
the new prod factory + market. `vercel ls --prod` shows the new deployment Ready.

---

## 8. Smoke test the live UI

- Open https://frontend-nine-red-31.vercel.app
- Connect wallet (HashPack)
- Open the new market's page; deposit a tiny amount; split → swap → claim
- Confirm flow end-to-end before announcing publicly

---

## Total Day-8 wall time estimate

| Step | Cost | Time |
|------|------|------|
| 0    | 0    | 5 min |
| 1    | <1 HBAR | 2 min |
| 2    | ~60 HBAR | 5 min |
| 3    | seed amount | 10–30 min (depends on UI interactions) |
| 4    | ~3 HBAR | 5 min |
| 5    | ~5 HBAR | 15 min (multi-tx with 2/2 sigs) |
| 6    | 0    | 2 min |
| 7    | 0    | 5 min |
| 8    | 0    | 10 min |
| **Total** | **~70 HBAR + seed** | **~1 hour active** |
