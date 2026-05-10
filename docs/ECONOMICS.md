# Fission Protocol — How yield, risk, and value flow

This doc is the plain-English explanation of how money moves through the protocol. It covers the SaucerSwap V2 LP market only — that's the only market type live in v1.

If you want the math, read `MarketMath.sol` and the Pendle V2 whitepaper. This doc is for understanding what you actually own.

---

## TL;DR

Three roles, three different yield streams, all sourced from real on-chain economic activity:

| Role | What you hold | Yield comes from | Risk profile |
|---|---|---|---|
| **PT** (fixed yield) | Principal Token | A discount at buy time → 1:1 SY at maturity | Low — fixed at buy time, protected by SY held in market |
| **YT** (variable yield) | Yield Token | SaucerSwap V3 swap fees harvested by the SY's NFT | Variable — leveraged exposure to V3 trading volume |
| **LP** (market maker) | LP Token | Fission AMM swap fees (99% to LPs, 1% to treasury) | AMM exposure to PT/SY divergence + post-expiry auto-redeem |

**The protocol is delta-neutral** — it has zero P&L exposure. All gains and losses are between user roles.

---

## What is the SY token, really?

`SY_SaucerSwapV2LP` is a wrapper around **one Uniswap-V3-style LP NFT** in the SaucerSwap WHBAR-USDC pool.

When you call `SY.depositLiquidity(amount0, amount1, ...)`:
1. Your USDC + WHBAR are added to the SY's NFT (it grows the existing position's liquidity)
2. You receive SY shares proportional to how much liquidity you added
3. **No swap happens** — you just contribute proportionally to the pool at the current price

When traders use SaucerSwap to swap WHBAR↔USDC, the V3 pool charges a 0.3% fee. That fee accrues pro-rata to every LP in the pool — including our SY's NFT.

```
Anyone can call SY.harvest() → SY collects the accrued fees from the NFT
                              → fees become USDC + WHBAR balances on the SY contract
                              → those balances are distributed as "reward tokens"
```

**Important quirk of our design:** the SY's underlying value (one share = your slice of the NFT's principal liquidity) **does not grow over time**. The exchangeRate stays constant at `1e18` forever. The yield is paid out separately as harvested fees, not by SY price appreciation.

This is called the **"Pendle-Kyber pattern"** — distinct from standard Pendle where SY grows like wstETH.

---

## What is PT, exactly?

PT is a **zero-coupon bond on the SY**.

- 1 PT can be redeemed for 1 SY at maturity (the market's expiry timestamp)
- PT trades at a discount before maturity (you pay less than 1 SY for 1 PT)
- The discount IS your yield. There's no separate accrual.

### Concrete example

Market expiry is 90 days from today. Implied APY is 6%.

- Today: you buy 1 PT for **0.985 SY** (a 1.5% discount over 90 days = 6% annualized)
- Next 90 days: nothing happens. PT just sits in your wallet.
- At expiry: you redeem 1 PT → receive 1 SY
- **You earned 0.015 SY = 1.5% over 90 days = ~6% APY, locked in at buy time**

### Where does that 0.015 SY actually come from?

Trace the flow:
1. Some splitter (Alice) deposited 1 SY into the market by calling `split(1 SY)` → received 1 PT + 1 YT
2. Alice sold the PT to you for 0.985 SY
3. Alice sold the YT to a yield speculator (Charlie) for 0.015 SY
4. **Alice broke even** — she put in 1 SY and got back 0.985 + 0.015 = 1 SY

Now:
- The original 1 SY is sitting in the Market contract
- You hold 1 PT (paid 0.985 from your pocket)
- Charlie holds 1 YT (paid 0.015 from his pocket)
- 90 days later, you redeem 1 PT and receive that original 1 SY

So your 0.015 SY profit came from **Charlie's pocket**, not from the protocol. You and Charlie made a peer-to-peer trade where Charlie took the variable side and you took the fixed side. The protocol just brokered.

### What if Charlie's bet goes badly?

If V3 fees over the term are less than 0.015 SY, Charlie loses money. **You are unaffected.** PT is genuinely fixed-rate from your perspective. Your 1 SY is in the Market the whole time, waiting for you.

PT downside risks (you should know):
- **SY value risk**: 1 SY = your share of the V3 NFT's principal. If WHBAR price moves a lot vs. USDC, the LP's USD value can change (impermanent-loss style). PT is denominated in SY, not USD.
- **Smart contract risk**: protocol bugs, audit gaps. Mitigated by audits + multisig + Timelock.
- **Counterparty risk on protocol funds**: zero — your 1 SY is on-chain and reserved.

PT is the closest thing to a "savings account" the protocol offers. The rate you see at buy time is the rate you get.

---

## What is YT, exactly?

YT is a **claim on the future fee stream of the SY's V3 NFT**.

- 1 YT entitles its holder to a proportional slice of harvested V3 fees, distributed continuously
- Fees come as **USDC + WHBAR** (the two tokens of the V3 pool)
- **YT does not expire in our design** — the SY's NFT keeps earning fees forever, and YT keeps claiming forever

### Concrete example

Charlie buys $100 worth of YT today, when the implied 90-day APY is 6%. So 1 YT costs him 0.015 SY.

#### Scenario 1 — V3 volume came in **higher** than implied

Over 90 days, his slice of V3 fees pays out **$250 worth of USDC + WHBAR**.

| Day | Event | Charlie's running P&L |
|---|---|---|
| 0 | Buys $100 of YT | −$100 |
| 0–90 | Claims $250 of fees | +$150 |
| 90 (expiry) | YT still alive, still earning | +$150 realized + perpetuity value |

**Net: 150% return on capital + still owns YT (which keeps earning forever).**

#### Scenario 2 — V3 volume came in **lower** than implied

Over 90 days, his slice of V3 fees pays out only **$33 worth of USDC + WHBAR**.

| Day | Event | Charlie's running P&L |
|---|---|---|
| 0 | Buys $100 of YT | −$100 |
| 0–90 | Claims $33 of fees | −$67 |
| 90 (expiry) | YT still alive, still earning | −$67 realized + perpetuity value |

**Net: 67% loss on capital, but YT is still alive.** If Charlie holds for another ~6 months at the same fee rate, he claws back to break-even, and beyond that it's pure profit.

### YT is leveraged exposure to V3 fee yield

The math:
- Implied 90-day rate = 1.5%
- YT cost per SY of exposure = 0.015 / 1 = 1.5% of capital
- Effective leverage on V3 yield delta = `1 / 0.015 ≈ 67×`

So if V3 yield comes in 1% above implied, YT gains ~67%. If it comes in 1% below, YT loses ~67%.

YT is for traders who think SaucerSwap V3 volume will exceed expectations. It's NOT a savings product.

### YT does not go to 0 at expiry

This is the key difference from standard Pendle. In our Kyber-pattern design:
- The SY has no expiry mechanic
- The V3 NFT keeps earning fees indefinitely
- YT keeps claiming forever

The contract literally rejects burning YT in `redeemAfterExpiry` (audit fix M-2) — burning your YT would forfeit a perpetual income stream you may not realize you have.

The only way YT goes to ~0: if SaucerSwap V3 stops trading WHBAR↔USDC entirely. Realistically: low.

YT downside risks (you should know):
- Realized fees < entry price → mark-to-market loss
- Maximum loss is bounded by entry cost (you cannot lose more than you paid)
- Holding past expiry is fine — fees keep flowing
- The same SY-value (impermanent-loss-style) risks that affect PT also affect YT

---

## What is the LP token, exactly?

The Fission market is itself an AMM that quotes PT/SY trades using a Pendle V2 logit curve. LPs provide liquidity to that AMM.

### How LPs earn

When traders swap PT↔SY on the Fission AMM, they pay a small fee:
- `lnFeeRateRoot = 3e14` (~0.03% per trade in time-equivalent units)
- After today's update, **99% of that fee stays in the pool reserves** → LP token value grows
- 1% goes to the treasury

LPs do NOT earn V3 fees directly. Those go entirely to YT holders. LPs earn **only** from PT/YT trading volume on this market.

### Where does LP value come from at expiry?

Pre-expiry: `removeLiquidity` returns proportional SY + PT.
Post-expiry: `removeLiquidity` auto-redeems the PT portion to SY (audit fix H-4) so LPs always recover full SY value, plus accumulated AMM fees.

### LP risks

- **No PT/YT trading volume** → no AMM fees → no yield
- **One-sided divergence** between PT price and SY price (Pendle's analog of impermanent loss)
- **Locked until you remove**: you can `removeLiquidity` anytime, but in size you eat AMM slippage

LPs are bull-on-protocol-volume players. If you think Fission will see lots of PT/YT trading, LPing is a good play.

---

## The two fee streams (don't confuse them)

| | Stream A: Fission AMM fees | Stream B: SaucerSwap V3 fees |
|---|---|---|
| **Where it's charged** | Our protocol's PT/SY swap | SaucerSwap's WHBAR/USDC swap |
| **Who pays** | Anyone trading PT or YT | Anyone using SaucerSwap to swap WHBAR↔USDC |
| **Rate** | ~0.03% per trade | 0.3% per trade |
| **Splits to** | 99% LPs, 1% treasury | 100% YT holders |
| **PT receives** | Nothing | Nothing |
| **YT receives** | Nothing | Everything |
| **LP receives** | Almost everything | Nothing |

The two streams are completely independent. PT/YT trading volume on Fission has no effect on YT yield. SaucerSwap V3 volume has no effect on LP yield.

---

## What happens at expiry?

| Action | Pre-expiry | Post-expiry |
|---|---|---|
| `split` | ✓ (mint 1 PT + 1 YT from 1 SY) | ✗ reverts (`MarketExpired`) |
| `merge` | ✓ (burn 1 PT + 1 YT for 1 SY) | ✗ reverts |
| Swap PT↔SY (AMM) | ✓ | ✗ reverts |
| `redeemAfterExpiry(pt, 0)` | ✗ reverts (`MarketNotExpired`) | ✓ (1 PT → 1 SY) |
| `redeemAfterExpiry(0, yt)` | ✗ reverts | ✗ rejected (M-2 fix — burning YT forfeits perpetual stream) |
| `removeLiquidity` (LP) | ✓ returns SY + PT proportional | ✓ returns SY + PT, PT auto-redeemed |
| `claimRewards` (YT holder) | ✓ | ✓ (still works forever) |
| `harvest` (anyone) | ✓ | ✓ (still works forever) |

So post-expiry the AMM is closed, but YT continues to function as a perpetual fee claim. PT redeems 1:1 with SY whenever you want.

---

## Implied APY vs. realized APY (the most-asked-about UI number)

The market detail page shows an "Implied APY" derived from the AMM curve. **This is not a forecast.**

What it really is: the rate that makes PT_price + YT_price = 1 SY at the current AMM state. In other words, **the market's collective bet on what V3 fees will deliver**.

- If realized V3 fees > implied APY → YT buyers win, PT buyers got a "low" fixed rate
- If realized V3 fees < implied APY → PT buyers got a "great" fixed rate, YT buyers lose
- If realized = implied → everyone gets exactly what was priced in

**For PT buyers**: the implied APY at your buy time is locked in. Realized doesn't matter.

**For YT buyers**: implied is what you're paying. Realized determines if you profit.

**For LPs**: neither directly affects you — your yield depends on AMM trading volume, not the rate level.

---

## Bootstrap-stage caveats

This protocol launches with small TVL. Two things to communicate clearly:

1. **YT yield is volume-bound and bootstrap-capped.** Our SY's NFT competes with concentrated V3 LPs in the same pool. At low TVL, our fee share is small. Yield grows linearly with SY TVL — at $50k SY, YT yield is ~25× what it is at $2k SY. Display realized fees, not just implied.

2. **AMM slippage is liquidity-bound.** With $1k/side, $100 trades are <0.1% slippage. $1k+ single trades start to feel it. The pool will grow as volume comes in — but in early days, expect tighter sizing.

---

## Risks the protocol does NOT cover

- **SaucerSwap V3 protocol risk**: the underlying NFT depends on SaucerSwap. If SaucerSwap is exploited, our SY is at risk.
- **Hedera platform risk**: HTS quirks, network outages, HIP changes.
- **Smart contract risk**: bugs in our own code. Mitigated by 269 tests, internal audits, mainnet fork tests, and (eventually) external audit.
- **Governance risk**: until multisig handoff completes, the deployer EOA can pause and update fees. After handoff, all admin actions go through 2-of-2 ThresholdKey + 48h Timelock.
- **WHBAR/USDC price risk**: SY value tracks the V3 LP, which has impermanent-loss-style price exposure. If WHBAR price moves a lot vs. USDC, the LP's USD value changes.

---

## How the protocol pays for itself

The protocol takes **1% of Fission AMM swap fees** as treasury revenue. That's it.

- No fee on SY mint
- No fee on YT yield claims
- No fee on PT redemption
- No fee on harvest
- No fee on watching, listing, or holding

If PT/YT trading volume is healthy, treasury accumulates real revenue. If volume is zero, treasury earns nothing. **The protocol is aligned with users — it only earns when users are trading.**

---

## Quick mental models

- **PT = a CD at the bank.** You lock in a rate, get principal back at maturity. Boring on purpose.
- **YT = a leveraged bet on SaucerSwap volume.** Long V3 trading activity, with implied-rate-dependent leverage.
- **LP = an AMM market-maker.** You earn from PT/YT churn, like Uniswap LPs earn from token churn.
- **SY = a V3 LP NFT in token form.** Holds underlying liquidity, earns external fees, doesn't appreciate in share price.

The protocol's only "magic": it splits one cash-generating asset (the SY's V3 NFT) into a fixed-rate slice (PT) and a variable-rate slice (YT). Everything else is plumbing.
