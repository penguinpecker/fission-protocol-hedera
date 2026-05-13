"use client";

import Link from "next/link";
import { use, useEffect, useMemo, useState } from "react";
import { useReadContracts, useWaitForTransactionReceipt } from "wagmi";
import { parseUnits } from "viem";
import { Nav } from "@/components/Nav";
import { diag } from "@/lib/diag";
import { Footer } from "@/components/Footer";
import { WalletGate } from "@/components/WalletGate";
import { useMarketDetail, useUserPosition, MarketDetail } from "@/hooks/useMarket";
import { ADDRESSES, isDeployed, HEDERA_TOKENS, USDC_DECIMALS, WHBAR_DECIMALS } from "@/lib/addresses";
import { erc20Abi } from "@/lib/abis";
import { erc20WriteAbi, routerAbi, marketWriteAbi, syWriteAbi, fissionZapAbi } from "@/lib/abis-write";
import { useWalletAdapter } from "@/lib/hedera-wallet/adapter";
import { useHederaWallet } from "@/lib/hedera-wallet/provider";
import { AssociationGate } from "@/components/AssociationGate";
import {
  impliedApyPct,
  daysUntil,
  formatBigInt,
  formatCompact,
} from "@/hooks/useMarkets";

type Strategy = "pt" | "yt" | "split" | "mint";

const STRATEGIES: { id: Strategy; title: string; sub: string; risk: string }[] = [
  { id: "mint", title: "Mint SY", sub: "Mint SY", risk: "—" },
  { id: "pt", title: "Fixed yield", sub: "Buy PT", risk: "Low" },
  { id: "yt", title: "Long yield", sub: "Buy YT", risk: "High" },
  { id: "split", title: "Split", sub: "Split SY", risk: "Med" },
];

export default function MarketDetailPage({ params }: { params: Promise<{ address: string }> }) {
  const { address: marketAddrParam } = use(params);
  const market = marketAddrParam as `0x${string}`;
  const { data: detail, isLoading } = useMarketDetail(market);
  // user comes from the wallet ADAPTER, not wagmi directly — Hedera-native
  // sessions don't show up in useAccount but the adapter unifies both paths
  // (mode='evm' → wagmi address; mode='hedera' → long-zero from accountId).
  const adapter = useWalletAdapter();
  const user = adapter.address ?? undefined;
  const { data: position } = useUserPosition(market, detail, user);

  const [strategy, setStrategy] = useState<Strategy>("pt");
  const [amount, setAmount] = useState("");
  const [slippageBps, setSlippageBps] = useState(50); // 0.5%

  const ptPriceApy = useMemo(() => {
    if (!detail) return null;
    const apy = impliedApyPct(detail.lastLnImpliedRate);
    return apy;
  }, [detail]);

  // Diag: surface whether the page entered the loading-skeleton branch or the
  // actual market detail render — and whether useMarketDetail ever resolved.
  useEffect(() => {
    diag("MarketDetailPage", {
      market,
      user,
      isLoading,
      detailLoaded: !!detail,
      syName: detail?.syName,
      totalSyZero: detail ? detail.totalSy === 0n : null,
    });
  }, [market, user, isLoading, detail]);

  if (isLoading || !detail) {
    return (
      <main className="min-h-screen">
        <Nav />
        <WalletGate>
          <div className="mx-auto max-w-[1100px] px-6 py-10">
            <div className="h-32 animate-pulse rounded-2xl border border-border bg-bgCard" />
          </div>
        </WalletGate>
        <Footer />
      </main>
    );
  }

  const expired = Date.now() / 1000 >= Number(detail.expiry);
  const dec = detail.syDecimals;

  return (
    <main className="min-h-screen">
      <Nav />

      <WalletGate>
      <div className="mx-auto max-w-[1100px] px-6 py-7">
        <div className="mb-7 flex items-center gap-2 text-[13px] text-textSec">
          <Link href="/markets" className="hover:text-text">
            Markets
          </Link>
          <span className="text-textDim">/</span>
          <span className="text-text">{detail.syName}</span>
        </div>

        <div className="mb-6">
          <h1 className="text-[26px] font-semibold tracking-tight">{detail.syName}</h1>
          <div className="mt-1 text-sm text-textDim">
            Matures{" "}
            {new Date(Number(detail.expiry) * 1000).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
              year: "numeric",
            })}{" "}
            · {daysUntil(detail.expiry)} days left
            {expired && <span className="ml-2 rounded bg-error/10 px-2 py-0.5 text-[10px] font-semibold text-error">EXPIRED</span>}
          </div>
        </div>

        <div className="mb-3 grid grid-cols-5 gap-px overflow-hidden rounded-2xl bg-border">
          <Stat label="Implied APY" value={ptPriceApy !== null ? `${ptPriceApy.toFixed(2)}%` : "—"} />
          <Stat label="SY locked" value={formatCompact(detail.totalSy)} mono />
          <Stat label="PT in pool" value={formatCompact(detail.totalPt)} mono />
          <Stat label="LP supply" value={formatCompact(detail.lpSupply)} mono />
          <Stat label="SY rate" value={formatBigInt(detail.syExchangeRate, 18, 4)} mono />
        </div>

        {position && user && (
          <div className="mb-6 grid grid-cols-5 gap-1.5">
            <UserStat label="Your SY" v={formatCompact(position.sy)} />
            <UserStat label="Your PT" v={formatCompact(position.pt)} />
            <UserStat label="Your YT" v={formatCompact(position.yt)} />
            <UserStat label="Your LP" v={formatCompact(position.lp)} />
            <UserStat label="Claimable yield" v={formatCompact(position.claimableYield)} accent="success" />
          </div>
        )}

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_360px]">
          <PositionInfoCard detail={detail} expired={expired} strategy={strategy} />

          <TradeCard
            market={market}
            detail={detail}
            strategy={strategy}
            setStrategy={setStrategy}
            amount={amount}
            setAmount={setAmount}
            slippageBps={slippageBps}
            setSlippageBps={setSlippageBps}
            user={user}
            syBalance={position?.sy ?? 0n}
          />
        </div>

        {expired && user && position && (position.pt > 0n || position.yt > 0n) && (
          <PostExpiryActions market={market} position={position} />
        )}
      </div>
      </WalletGate>
      <Footer />
    </main>
  );
}

function Stat({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="bg-bgCard px-5 py-4">
      <div className="mb-1 text-[10px] uppercase tracking-[1px] text-textDim">{label}</div>
      <div className={`text-[20px] font-bold tracking-tight text-text ${mono ? "font-mono" : ""}`}>{value}</div>
    </div>
  );
}

function UserStat({ label, v, accent }: { label: string; v: string; accent?: "success" }) {
  return (
    <div className="rounded-lg bg-white/[0.02] px-3 py-2">
      <div className="text-[10px] uppercase tracking-[0.5px] text-textDim">{label}</div>
      <div className={`font-mono text-[13px] font-semibold ${accent === "success" ? "text-success" : "text-text"}`}>{v}</div>
    </div>
  );
}

function PositionInfoCard({ detail, expired, strategy }: { detail: MarketDetail; expired: boolean; strategy: Strategy }) {
  const content = STRATEGY_EXPLAINERS[strategy];
  return (
    <div className="rounded-2xl border border-border bg-bgCard p-6">
      <div className="mb-4 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold">{content.title}</h3>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[1px] ${content.riskTone}`}>
          {content.riskLabel}
        </span>
      </div>

      <p className="mb-4 text-[13px] leading-relaxed text-textSec">{content.summary}</p>

      <div className="mb-4 space-y-3 text-[13px] leading-relaxed">
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-[1px] text-textDim">How yield reaches you</div>
          <p className="text-textSec">{content.yieldSource}</p>
        </div>
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-[1px] text-textDim">Worked example</div>
          <p className="whitespace-pre-line text-textSec">{content.example}</p>
        </div>
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-[1px] text-textDim">Risk profile</div>
          <p className="text-textSec">{content.risk}</p>
        </div>
      </div>

      {expired && (
        <p className="mb-4 rounded-lg border border-error/40 bg-error/5 px-3 py-2 text-[12px] text-error">
          Market expired — AMM is closed. PT redeems 1:1 with SY. YT keeps earning V3 fees forever; do not burn it.
        </p>
      )}

      <a
        href="https://github.com/penguinpecker/fission-protocol-hedera/blob/main/docs/ECONOMICS.md"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-[12px] font-medium text-textDim transition hover:text-text"
      >
        Read the full economics doc →
      </a>
    </div>
  );
}

const STRATEGY_EXPLAINERS = {
  mint: {
    title: "Mint SY — get into the protocol",
    riskLabel: "Entry",
    riskTone: "bg-textDim/10 text-textDim",
    summary:
      "Deposit USDC + WHBAR. The SY adapter adds liquidity to its underlying V3 NFT and mints fungible SY shares to your wallet. No AMM trade, no slippage at the SY layer — just a proportional contribution to the V3 LP position.",
    yieldSource:
      "Minting SY doesn't earn anything directly. Holding SY = holding a slice of a V3 LP NFT (USDC + WHBAR exposure). To turn that into PT, YT, or LP positions in this market, switch to the Split / Buy PT / Buy YT tabs after minting.",
    example:
      "• Deposit $100 USDC + $100 WHBAR → receive ~$200 worth of SY shares\n• Cost: ~5 HBAR for the V3 NPM fee (one-time per deposit)\n• Approvals: 1 each for USDC and WHBAR (or none if already approved)",
    risk:
      "Same risks as holding a full-range V3 LP: WHBAR/USDC price moves = impermanent-loss-style USD value drift. No protocol-side principal risk. Withdraw anytime via SY.redeemLiquidity (not yet exposed in UI).",
  },
  pt: {
    title: "Buy PT — fixed yield",
    riskLabel: "Low risk",
    riskTone: "bg-success/10 text-success",
    summary:
      "PT is a zero-coupon bond on SY. You buy at a discount today, redeem 1:1 for SY at maturity. The discount is your yield, locked in at buy time.",
    yieldSource:
      "Your yield is paid by YT buyers — speculators on the other side of the trade who pay a premium for variable yield. The protocol holds the SY for you the entire term; redemption is 1:1 and unconditional.",
    example:
      "• Buy 1 PT for 0.985 SY (1.5% discount over 90 days ≈ 6% APY)\n• 90 days later, redeem 1 PT → receive 1 SY\n• Profit: 0.015 SY (the discount), regardless of what V3 fees actually do",
    risk:
      "Fixed-rate from your perspective. Main risks: SY value moves with WHBAR/USDC pool (impermanent-loss style), smart contract risk, and Hedera/SaucerSwap platform risk. Protocol always has 1 SY waiting per PT — your principal is on-chain and reserved.",
  },
  yt: {
    title: "Buy YT — variable yield",
    riskLabel: "High risk",
    riskTone: "bg-error/10 text-error",
    summary:
      "YT is a leveraged claim on SaucerSwap V3 trading fees. You pay a premium today, receive USDC + WHBAR continuously as the V3 pool earns fees. YT does NOT expire — it earns forever.",
    yieldSource:
      "SaucerSwap V3 traders swap WHBAR↔USDC and pay a 0.3% fee. Our SY's NFT collects its pro-rata share. Anyone calling harvest() pulls those fees into the SY, which distributes them to YT holders proportional to YT balance. You can claim anytime.",
    example:
      "• Buy $100 of YT at 0.015 SY/YT (≈ 6% implied APY)\n• If V3 volume comes in HIGHER → claim $250 over 90 days = 150% gain\n• If V3 volume comes in LOWER → claim $33 over 90 days = 67% loss\n• Either way, YT keeps earning forever after expiry — your loss can recover with time",
    risk:
      "Variable. Effective leverage on V3 yield ≈ 1 / implied-rate (≈ 67× at 1.5%). You can lose most of your entry capital if fees underperform — but YT itself never goes to 0; it stays a perpetual fee claim. Maximum loss capped at entry cost.",
  },
  split: {
    title: "Split SY → PT + YT (no fee)",
    riskLabel: "Neutral",
    riskTone: "bg-textDim/10 text-textDim",
    summary:
      "Pure 1:1 mint. 1 SY in → 1 PT + 1 YT out. No AMM trade, no slippage, no fee. Use when you want both sides — to LP, to sell one half, or to hedge.",
    yieldSource:
      "You're not buying yield here — you're creating both halves of it. The PT side will pay back 1 SY at maturity. The YT side will earn V3 fees over time. Selling PT for SY locks in fixed-rate proceeds; selling YT for SY locks in the implied yield premium up front.",
    example:
      "• Deposit 1 SY → receive 1 PT + 1 YT\n• Common play: sell PT in AMM for ~0.985 SY, sell YT for ~0.015 SY → recover 1 SY (break-even, but you've taken zero directional risk)\n• LP play: deposit both sides into the AMM and earn 99% of swap fees",
    risk:
      "Neutral at the moment of split. Risk shows up in what you do with PT and YT after. Splitting itself can't lose you money beyond AMM fees on subsequent sells.",
  },
} satisfies Record<Strategy, {
  title: string;
  riskLabel: string;
  riskTone: string;
  summary: string;
  yieldSource: string;
  example: string;
  risk: string;
}>;

interface TradeCardProps {
  market: `0x${string}`;
  detail: MarketDetail;
  strategy: Strategy;
  setStrategy: (s: Strategy) => void;
  amount: string;
  setAmount: (v: string) => void;
  slippageBps: number;
  setSlippageBps: (n: number) => void;
  user: `0x${string}` | undefined;
  syBalance: bigint;
}

function TradeCard({
  market,
  detail,
  strategy,
  setStrategy,
  amount,
  setAmount,
  slippageBps,
  setSlippageBps,
  user,
  syBalance,
}: TradeCardProps) {
  const adapter = useWalletAdapter();
  const hedera = useHederaWallet();
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>(undefined);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  // In Hedera-native mode the adapter awaits receipt internally and
  // returns a Hedera tx ID (`0.0.X@SECS.NANOS`) which isn't a 0x hash —
  // wagmi's hook would poll Hashio with garbage and spin forever, so we
  // disable it. EVM mode keeps the wagmi-driven confirmation flow.
  const useWagmiReceipt = adapter.mode === "evm";
  const { isLoading: isConfirming, isSuccess: isConfirmed } = useWaitForTransactionReceipt({
    hash: useWagmiReceipt ? txHash : undefined,
    query: { enabled: useWagmiReceipt },
  });
  // Hedera-mode "isConfirmed" mirrors txHash presence — the adapter only
  // resolves after getReceiptWithSigner succeeded.
  const isConfirmedFinal = useWagmiReceipt ? isConfirmed : !!txHash;
  const isConfirmingFinal = useWagmiReceipt ? isConfirming : false;
  const routerDeployed = isDeployed(ADDRESSES.router);
  const isPending = isSubmitting || adapter.isWritePending;
  const resetWrite = () => {
    setTxHash(undefined);
    setWriteError(null);
  };

  // Parse the amount the user typed. If anything is invalid (empty, NaN,
  // negative), this is 0n and we'll treat it as no-amount in the gate.
  let parsedAmt = 0n;
  try {
    if (amount) parsedAmt = parseUnits(amount, detail.syDecimals);
  } catch {
    parsedAmt = 0n;
  }
  const insufficient = parsedAmt > syBalance;
  const needsSy = syBalance === 0n;

  // Spender of the SY shares depends on the strategy:
  //   split  → the market itself does the pull (market.split's transferFrom).
  //   pt/yt  → the ActionRouter pulls SY before invoking the market.
  //   mint   → not used here; handled by MintSyForm.
  const spender: `0x${string}` =
    strategy === "split" ? market : ADDRESSES.router;

  const allowanceRead = useReadContracts({
    contracts: user && parsedAmt > 0n && detail.syShare && strategy !== "mint"
      ? [
          {
            abi: [{ type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] }] as const,
            address: detail.syShare,
            functionName: "allowance",
            args: [user, spender],
          } as const,
        ]
      : [],
    query: { enabled: !!user && parsedAmt > 0n && strategy !== "mint" },
    allowFailure: true,
  });
  const allowance =
    allowanceRead.data?.[0]?.status === "success"
      ? (allowanceRead.data[0].result as bigint)
      : 0n;
  const needsApprove =
    strategy !== "mint" && parsedAmt > 0n && allowance < parsedAmt;

  const wrap = async <T,>(fn: () => Promise<T>) => {
    setWriteError(null);
    setIsSubmitting(true);
    try {
      return await fn();
    } catch (e) {
      setWriteError(e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
      setIsSubmitting(false);
    }
  };

  const onApprove = async () => {
    try {
      const { txHash: hash } = await wrap(() =>
        adapter.write({
          kind: "approveErc20",
          token: detail.syShare,
          spender,
          amount: parsedAmt,
        }),
      );
      setTxHash(hash as `0x${string}`);
    } catch { /* error already captured in writeError */ }
  };

  const onTrade = async () => {
    if (!user || !amount || !routerDeployed) return;
    if (parsedAmt > syBalance) return;
    if (needsApprove) return; // guard — UI button label routes to onApprove first
    const amt = parsedAmt;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    const minOut = (amt * BigInt(10_000 - slippageBps)) / 10_000n;

    // Pre-flight HTS associations. Different strategies deliver different
    // tokens to the user:
    //   split → PT + YT
    //   pt    → PT
    //   yt    → YT
    // Skip silently for EVM-mode wallets (HIP-904 auto-assoc) and for
    // accounts where Mirror Node returns nothing missing.
    if (adapter.mode === "hedera" && adapter.accountId) {
      const need: `0x${string}`[] =
        strategy === "split" ? [detail.pt, detail.yt] :
        strategy === "pt"    ? [detail.pt] :
        strategy === "yt"    ? [detail.yt] : [];
      if (need.length > 0) {
        try {
          const { getMissingAssociations, associateTokens, evmAddressToTokenId } =
            await import("@/lib/hedera-wallet/associations");
          const ids = need.map(evmAddressToTokenId);
          const missing = await getMissingAssociations(adapter.accountId, ids);
          if (missing.length > 0) {
            await wrap(() =>
              associateTokens(hedera.getConnector(), adapter.accountId!, missing),
            );
          }
        } catch (e) {
          setWriteError(e instanceof Error ? e.message : String(e));
          return;
        }
      }
    }

    try {
      let hash: string;
      if (strategy === "split") {
        ({ txHash: hash } = await wrap(() =>
          adapter.write({ kind: "split", market, amount: amt }),
        ));
      } else if (strategy === "pt") {
        ({ txHash: hash } = await wrap(() =>
          adapter.write({
            kind: "swapExactSyForPt",
            router: ADDRESSES.router,
            market,
            syIn: amt,
            minPtOut: minOut,
            receiver: user,
            deadline,
          }),
        ));
      } else if (strategy === "yt") {
        ({ txHash: hash } = await wrap(() =>
          adapter.write({
            kind: "buyYT",
            router: ADDRESSES.router,
            market,
            syBudget: amt,
            minSyOut: minOut,
            receiver: user,
            deadline,
          }),
        ));
      } else {
        return;
      }
      setTxHash(hash as `0x${string}`);
    } catch { /* error already captured */ }
  };

  const onPrimary = () => {
    if (needsApprove) onApprove();
    else onTrade();
  };

  return (
    <aside className="flex flex-col gap-3">
      <div className="rounded-2xl border border-border bg-bgCard p-4">
        <div className="mb-3 text-[10px] font-semibold uppercase tracking-[2px] text-textDim">Strategy</div>
        <div className="flex gap-1">
          {STRATEGIES.map((s) => {
            const active = strategy === s.id;
            return (
              <button
                key={s.id}
                onClick={() => setStrategy(s.id)}
                className={`flex-1 rounded-lg border px-2 py-2.5 text-[13px] font-medium transition ${
                  active
                    ? "border-borderHover bg-white/[0.06] text-text"
                    : "border-border text-textDim hover:bg-white/[0.04]"
                }`}
              >
                {s.sub}
              </button>
            );
          })}
        </div>
      </div>

      {strategy === "mint" ? (
        <MintSyForm sy={detail.sy} syShare={detail.syShare} user={user} />
      ) : (
      <div className="rounded-2xl border border-border bg-bgCard p-4">
        <div className="mb-3 text-[10px] font-semibold uppercase tracking-[2px] text-textDim">
          {strategy === "split" ? "Split SY → PT + YT" : strategy === "pt" ? "Buy PT" : "Buy YT"}
        </div>

        <label className="mb-3 block">
          <span className="mb-1.5 flex items-center justify-between text-xs text-textSec">
            <span>You pay (SY)</span>
            <span className="font-mono text-[11px] text-textDim">
              Balance: {formatCompact(syBalance)}
              {syBalance > 0n && (
                <button
                  type="button"
                  onClick={() => {
                    // Set the input to the user's full balance, denominated
                    // in the SY decimals. Use a string that exactly round-
                    // trips parseUnits → formatUnits.
                    const div = 10n ** BigInt(detail.syDecimals);
                    const whole = syBalance / div;
                    const frac = syBalance % div;
                    const fracStr = frac.toString().padStart(detail.syDecimals, "0").replace(/0+$/, "");
                    setAmount(fracStr ? `${whole}.${fracStr}` : `${whole}`);
                  }}
                  className="ml-2 rounded border border-borderHover bg-white/[0.04] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[1px] text-text transition hover:bg-white/[0.08]"
                >
                  Max
                </button>
              )}
            </span>
          </span>
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            inputMode="decimal"
            className={`w-full rounded-[10px] border bg-bgInput px-4 py-3.5 font-mono text-base text-text outline-none transition ${
              insufficient ? "border-error/60 focus:border-error" : "border-border focus:border-borderHover"
            }`}
          />
          {insufficient && (
            <span className="mt-1.5 block text-[11px] font-medium text-error">
              Insufficient SY — you have {formatCompact(syBalance)}.
            </span>
          )}
        </label>

        {user && needsSy && (
          <div className="mb-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5 text-[12px] leading-relaxed text-warning">
            <span className="font-semibold">You have 0 SY shares.</span> To trade on this market you need SY first — deposit USDC + WHBAR into the SY adapter (
            <a
              href={`https://hashscan.io/mainnet/contract/${detail.sy}`}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 hover:text-text"
            >
              SY contract
            </a>
            ) to mint shares. A guided UI for this lands in v1.1; for now use{" "}
            <a
              href="https://github.com/penguinpecker/fission-protocol-hedera/blob/main/scripts/top-up-market0.mjs"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 hover:text-text"
            >
              the top-up script
            </a>{" "}
            or split an existing SY balance.
          </div>
        )}

        {strategy !== "split" && (
          <label className="mb-3 block">
            <span className="mb-1.5 block text-xs text-textSec">
              Slippage tolerance: {(slippageBps / 100).toFixed(2)}%
            </span>
            <input
              type="range"
              min={5}
              max={500}
              value={slippageBps}
              onChange={(e) => setSlippageBps(Number(e.target.value))}
              className="w-full"
            />
          </label>
        )}

        <button
          type="button"
          disabled={
            !user ||
            !amount ||
            isPending ||
            isConfirmingFinal ||
            insufficient ||
            (strategy !== "split" && !routerDeployed)
          }
          onClick={onPrimary}
          className="w-full rounded-[10px] bg-white px-7 py-3.5 text-sm font-semibold text-bg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {!user
            ? "Connect wallet"
            : !amount
              ? "Enter amount"
              : insufficient
                ? "Insufficient SY"
                : isPending
                  ? "Sign in HashPack…"
                  : isConfirmingFinal
                    ? "Waiting for confirmation…"
                    : needsApprove
                      ? `Approve SY for ${strategy === "split" ? "Market" : "Router"}`
                      : strategy === "split"
                        ? `Split ${amount} SY`
                        : strategy === "pt"
                          ? "Buy PT"
                          : "Buy YT"}
        </button>

        {needsApprove && (
          <p className="mt-2 text-[10px] leading-relaxed text-textDim">
            One-time per allowance reset. After approval the button switches to the trade.
          </p>
        )}

        {writeError && (
          <div className="mt-2 rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-[11px] leading-relaxed text-error">
            <span className="font-mono">{writeError.slice(0, 240)}</span>
          </div>
        )}

        {isConfirmedFinal && txHash && (
          <div className="mt-3 rounded-lg border border-success/30 bg-success/10 px-3 py-2.5 text-[12px] leading-relaxed text-success">
            <div className="font-semibold">Transaction confirmed.</div>
            <div className="mt-1 break-all font-mono text-[10px] text-success/80">
              tx: {txHash.slice(0, 18)}…{txHash.slice(-8)}
            </div>
            <div className="mt-1.5 flex gap-3">
              <a
                href={`https://hashscan.io/mainnet/transaction/${txHash}`}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2 hover:text-text"
              >
                View on HashScan
              </a>
              <button
                type="button"
                onClick={() => { resetWrite(); setAmount(""); }}
                className="underline underline-offset-2 hover:text-text"
              >
                New trade
              </button>
            </div>
          </div>
        )}

        {strategy !== "split" && !routerDeployed && (
          <p className="mt-2 text-[11px] text-error">Router not deployed yet — split-only flow available.</p>
        )}
      </div>
      )}
    </aside>
  );
}

/* ─────────────────────────────────────────────────────── Mint SY form */

/**
 * Two-input deposit flow: user provides USDC + WHBAR, SY mints share tokens
 * by adding to its underlying V3 NFT. Sequence is approve(USDC) →
 * approve(WHBAR) → SY.depositLiquidity. The user sees one HashPack popup
 * per tx; the button label tracks progress.
 */
interface MintFormProps {
  sy: `0x${string}`;
  syShare: `0x${string}`;
  user: `0x${string}` | undefined;
}

function MintSyForm({ sy, syShare, user }: MintFormProps) {
  // Prefer the zap path: one HBAR input → one wallet popup → SY shares.
  // Fall back to the explicit USDC + WHBAR multi-step flow when the zap
  // hasn't been deployed yet for this environment.
  if (isDeployed(ADDRESSES.fissionZap)) {
    return <ZapMintForm sy={sy} syShare={syShare} user={user} />;
  }
  return <LegacyMintForm sy={sy} syShare={syShare} user={user} />;
}

function ZapMintForm({ sy, syShare, user }: MintFormProps) {
  // The zap mints SY shares to the user (receiver) and sweeps dust WHBAR
  // back to the caller. Both transfers require the user account to have
  // an HTS association — HIP-904-unlimited accounts skip this internally.
  // We check `syShare` (the actual HTS token returned by SY.shareToken())
  // NOT `sy` (the contract itself, which is not an HTS-listed token).
  return (
    <AssociationGate
      requiredTokens={[syShare, HEDERA_TOKENS.WHBAR]}
      tokenLabels={["SY share token", "WHBAR"]}
      reason="needed to receive SY shares and reclaim leftover WHBAR"
    >
      <ZapMintFormInner sy={sy} user={user} />
    </AssociationGate>
  );
}

function ZapMintFormInner({ sy, user }: { sy: `0x${string}`; user: `0x${string}` | undefined }) {
  const adapter = useWalletAdapter();
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>(undefined);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // EVM mode: wait via wagmi/Hashio. Hedera mode: adapter already awaited
  // receipt internally; treat tx as confirmed the instant we have a hash
  // (avoids Hashio 400s for non-0x Hedera tx IDs).
  const useWagmiReceipt = adapter.mode === "evm";
  const { isLoading: isConfirming, isSuccess: isConfirmed } = useWaitForTransactionReceipt({
    hash: useWagmiReceipt ? txHash : undefined,
    query: { enabled: useWagmiReceipt },
  });
  const isConfirmedFinal = useWagmiReceipt ? isConfirmed : !!txHash;
  const isConfirmingFinal = useWagmiReceipt ? isConfirming : false;
  const [hbar, setHbar] = useState("");
  const [hbarError, setHbarError] = useState<string | null>(null);

  // Parse user input as a positive number of whole HBAR. Negative/NaN
  // are coerced to 0 by the gate below.
  let userHbarN = 0;
  try {
    const n = parseFloat(hbar);
    if (Number.isFinite(n) && n > 0) userHbarN = n;
  } catch { /* keep 0 */ }

  const onZap = async () => {
    if (!user || userHbarN <= 0) return;
    setHbarError(null);
    setIsSubmitting(true);
    try {
      const { txHash: hash } = await adapter.write({
        kind: "zapHbarToSy",
        zap: ADDRESSES.fissionZap,
        sy,
        receiver: user,
        hbarIn: userHbarN,
      });
      // wagmi returns 0x-prefixed eth tx hash; Hedera path returns Hedera
      // tx ID. Both are strings — use as-is for the explorer link.
      setTxHash(hash as `0x${string}`);
    } catch (e) {
      setHbarError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsSubmitting(false);
    }
  };

  const resetWrite = () => {
    setTxHash(undefined);
    setHbarError(null);
  };

  const tooSmall = userHbarN > 0 && userHbarN < 1;
  const isPending = isSubmitting || adapter.isWritePending;

  return (
    <div className="rounded-2xl border border-border bg-bgCard p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <div className="text-[10px] font-semibold uppercase tracking-[2px] text-textDim">Mint SY from HBAR</div>
        <span className="rounded-full bg-success/10 px-2 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[1.5px] text-success">
          One tx
        </span>
      </div>

      <p className="mb-3 text-[12px] leading-relaxed text-textSec">
        Pay HBAR. The zap wraps half to WHBAR, swaps the other half to USDC on SaucerSwap V3, and deposits both into the SY. Net cost: your HBAR + ~5 HBAR for the V3 NPM fee.
      </p>

      <label className="mb-3 block">
        <span className="mb-1.5 flex items-center justify-between text-xs text-textSec">
          <span>HBAR to commit</span>
          <span className="font-mono text-[11px] text-textDim">
            +5 HBAR NPM fee
          </span>
        </span>
        <input
          type="number"
          value={hbar}
          onChange={(e) => setHbar(e.target.value)}
          placeholder="0.00"
          inputMode="decimal"
          className={`w-full rounded-[10px] border bg-bgInput px-4 py-3.5 font-mono text-base text-text outline-none transition ${
            tooSmall ? "border-warning/60 focus:border-warning" : "border-border focus:border-borderHover"
          }`}
        />
        {tooSmall && (
          <span className="mt-1 block text-[11px] font-medium text-warning">
            Tiny amounts get eaten by the 5 HBAR NPM fee — commit ≥1 HBAR.
          </span>
        )}
        {hbarError && (
          <span className="mt-1 block text-[11px] font-medium text-error">
            {hbarError.slice(0, 200)}
          </span>
        )}
      </label>

      <button
        type="button"
        disabled={!user || userHbarN === 0 || isPending || isConfirmingFinal}
        onClick={onZap}
        className="w-full rounded-[10px] bg-white px-7 py-3.5 text-sm font-semibold text-bg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {!user
          ? "Connect wallet"
          : userHbarN === 0
            ? "Enter HBAR amount"
            : isPending
              ? "Sign in HashPack…"
              : isConfirmingFinal
                ? "Waiting for confirmation…"
                : `Mint SY with ${hbar} HBAR`}
      </button>

      {isConfirmedFinal && txHash && (
        <div className="mt-3 rounded-lg border border-success/30 bg-success/10 px-3 py-2.5 text-[12px] leading-relaxed text-success">
          <div className="font-semibold">Mint confirmed.</div>
          <div className="mt-1 break-all font-mono text-[10px] text-success/80">
            tx: {txHash.slice(0, 18)}…{txHash.slice(-8)}
          </div>
          <div className="mt-1.5 flex gap-3">
            <a
              href={`https://hashscan.io/mainnet/transaction/${txHash}`}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 hover:text-text"
            >
              View on HashScan
            </a>
            <button
              type="button"
              onClick={() => { resetWrite(); setHbar(""); }}
              className="underline underline-offset-2 hover:text-text"
            >
              Mint another
            </button>
          </div>
        </div>
      )}

      <p className="mt-2 text-[10px] leading-relaxed text-textDim">
        One HashPack popup. Slippage is left wide on the underlying V3 swap and LP add — for production sizing we&apos;ll tighten via env-controlled floors.
      </p>
    </div>
  );
}

function LegacyMintForm({ sy, syShare, user }: MintFormProps) {
  return (
    <AssociationGate
      requiredTokens={[syShare]}
      tokenLabels={["SY share token"]}
      reason="needed to receive your SY shares"
    >
      <LegacyMintFormInner sy={sy} user={user} />
    </AssociationGate>
  );
}

function LegacyMintFormInner({ sy, user }: { sy: `0x${string}`; user: `0x${string}` | undefined }) {
  const adapter = useWalletAdapter();
  const [isPending, setIsPending] = useState(false);
  const [usdcAmt, setUsdcAmt] = useState("");
  const [whbarAmt, setWhbarAmt] = useState("");

  const reads = useReadContracts({
    contracts: user
      ? [
          { abi: erc20Abi, address: HEDERA_TOKENS.USDC, functionName: "balanceOf", args: [user] } as const,
          { abi: erc20Abi, address: HEDERA_TOKENS.WHBAR, functionName: "balanceOf", args: [user] } as const,
          // wagmi v2's erc20Abi includes allowance via the OZ abi; if missing we'll get failure and treat as 0
          { abi: [{ type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] }] as const, address: HEDERA_TOKENS.USDC, functionName: "allowance", args: [user, sy] } as const,
          { abi: [{ type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] }] as const, address: HEDERA_TOKENS.WHBAR, functionName: "allowance", args: [user, sy] } as const,
        ]
      : [],
    query: { enabled: !!user },
    allowFailure: true,
  });

  const pluck = <T,>(entry: { status: "success"; result: T } | { status: "failure"; error: Error } | undefined): T | undefined =>
    entry?.status === "success" ? entry.result : undefined;

  const usdcBal = (pluck<bigint>(reads.data?.[0] as never) ?? 0n);
  const whbarBal = (pluck<bigint>(reads.data?.[1] as never) ?? 0n);
  const usdcAllow = (pluck<bigint>(reads.data?.[2] as never) ?? 0n);
  const whbarAllow = (pluck<bigint>(reads.data?.[3] as never) ?? 0n);

  let usdcParsed = 0n;
  let whbarParsed = 0n;
  try { if (usdcAmt) usdcParsed = parseUnits(usdcAmt, USDC_DECIMALS); } catch { /* keep 0 */ }
  try { if (whbarAmt) whbarParsed = parseUnits(whbarAmt, WHBAR_DECIMALS); } catch { /* keep 0 */ }

  const needsUsdcApprove = usdcParsed > 0n && usdcAllow < usdcParsed;
  const needsWhbarApprove = whbarParsed > 0n && whbarAllow < whbarParsed;
  const insufficientUsdc = usdcParsed > usdcBal;
  const insufficientWhbar = whbarParsed > whbarBal;
  const ready = usdcParsed > 0n && whbarParsed > 0n && !insufficientUsdc && !insufficientWhbar;

  const setMax = (which: "usdc" | "whbar") => {
    const v = which === "usdc" ? usdcBal : whbarBal;
    const d = which === "usdc" ? USDC_DECIMALS : WHBAR_DECIMALS;
    const div = 10n ** BigInt(d);
    const whole = v / div;
    const frac = v % div;
    const fracStr = frac.toString().padStart(d, "0").replace(/0+$/, "");
    const s = fracStr ? `${whole}.${fracStr}` : `${whole}`;
    if (which === "usdc") setUsdcAmt(s); else setWhbarAmt(s);
  };

  const guarded = async (fn: () => Promise<unknown>) => {
    setIsPending(true);
    try { await fn(); } finally { setIsPending(false); }
  };
  const approveUsdc = () => guarded(() =>
    adapter.write({ kind: "approveErc20", token: HEDERA_TOKENS.USDC, spender: sy, amount: usdcParsed }),
  );
  const approveWhbar = () => guarded(() =>
    adapter.write({ kind: "approveErc20", token: HEDERA_TOKENS.WHBAR, spender: sy, amount: whbarParsed }),
  );
  const deposit = () => {
    if (!user) return;
    // 5% slippage on each leg, ≥1 share min — same posture as the top-up script.
    const a0Min = (usdcParsed * 95n) / 100n;
    const a1Min = (whbarParsed * 95n) / 100n;
    return guarded(() =>
      adapter.write({
        kind: "depositLiquidity",
        sy,
        amount0: usdcParsed,
        amount1: whbarParsed,
        amount0Min: a0Min,
        amount1Min: a1Min,
        receiver: user,
        minShares: 1n,
        npmHbar: 5,
      }),
    );
  };

  const nextStep = needsUsdcApprove
    ? { label: "Approve USDC", fn: approveUsdc }
    : needsWhbarApprove
      ? { label: "Approve WHBAR", fn: approveWhbar }
      : ready
        ? { label: "Deposit & mint SY", fn: deposit }
        : null;

  return (
    <div className="rounded-2xl border border-border bg-bgCard p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <div className="text-[10px] font-semibold uppercase tracking-[2px] text-textDim">Mint SY shares</div>
        <a
          href="https://www.saucerswap.finance/swap"
          target="_blank"
          rel="noreferrer"
          className="text-[10px] text-textDim underline underline-offset-2 hover:text-text"
        >
          Need USDC?
        </a>
      </div>

      <p className="mb-3 text-[12px] leading-relaxed text-textSec">
        Deposit USDC + WHBAR. The SY adapter adds them to its V3 NFT and mints fungible SY shares to your wallet. Costs ~5 HBAR (V3 NPM fee).
      </p>

      <MintInput
        label="USDC"
        value={usdcAmt}
        setValue={setUsdcAmt}
        balance={usdcBal}
        decimals={USDC_DECIMALS}
        insufficient={insufficientUsdc}
        onMax={() => setMax("usdc")}
      />
      <MintInput
        label="WHBAR"
        value={whbarAmt}
        setValue={setWhbarAmt}
        balance={whbarBal}
        decimals={WHBAR_DECIMALS}
        insufficient={insufficientWhbar}
        onMax={() => setMax("whbar")}
      />

      <button
        type="button"
        disabled={!user || !nextStep || isPending}
        onClick={() => nextStep?.fn()}
        className="mt-3 w-full rounded-[10px] bg-white px-7 py-3.5 text-sm font-semibold text-bg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {!user
          ? "Connect wallet"
          : isPending
            ? "Confirming…"
            : nextStep
              ? nextStep.label
              : insufficientUsdc || insufficientWhbar
                ? "Insufficient balance"
                : "Enter amounts"}
      </button>

      <p className="mt-2 text-[10px] leading-relaxed text-textDim">
        The deposit is a single tx; the two approvals before it are one-time per token (or until you reset allowance).
      </p>
    </div>
  );
}

function MintInput({
  label,
  value,
  setValue,
  balance,
  decimals,
  insufficient,
  onMax,
}: {
  label: string;
  value: string;
  setValue: (v: string) => void;
  balance: bigint;
  decimals: number;
  insufficient: boolean;
  onMax: () => void;
}) {
  return (
    <label className="mb-3 block">
      <span className="mb-1.5 flex items-center justify-between text-xs text-textSec">
        <span>{label}</span>
        <span className="font-mono text-[11px] text-textDim">
          Balance: {formatBigInt(balance, decimals, 4)}
          {balance > 0n && (
            <button
              type="button"
              onClick={onMax}
              className="ml-2 rounded border border-borderHover bg-white/[0.04] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[1px] text-text transition hover:bg-white/[0.08]"
            >
              Max
            </button>
          )}
        </span>
      </span>
      <input
        type="number"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="0.00"
        inputMode="decimal"
        className={`w-full rounded-[10px] border bg-bgInput px-4 py-3 font-mono text-sm text-text outline-none transition ${
          insufficient ? "border-error/60 focus:border-error" : "border-border focus:border-borderHover"
        }`}
      />
      {insufficient && (
        <span className="mt-1 block text-[11px] font-medium text-error">
          Insufficient {label}.
        </span>
      )}
    </label>
  );
}

function PostExpiryActions({
  market,
  position,
}: {
  market: `0x${string}`;
  position: { pt: bigint; yt: bigint };
}) {
  const adapter = useWalletAdapter();
  const user = adapter.address ?? undefined;
  const [isPending, setIsPending] = useState(false);

  const redeem = async () => {
    if (!user) return;
    setIsPending(true);
    try {
      await adapter.write({
        kind: "redeemAfterExpiry",
        market,
        ptIn: position.pt,
        ytIn: position.yt,
        receiver: user,
      });
    } finally {
      setIsPending(false);
    }
  };

  return (
    <div className="mt-6 rounded-2xl border border-error/20 bg-error/5 p-5">
      <div className="mb-2 text-sm font-semibold text-error">Market expired — redeem your PT/YT</div>
      <button
        type="button"
        disabled={isPending}
        onClick={redeem}
        className="rounded-lg bg-white px-5 py-2 text-sm font-semibold text-bg transition hover:opacity-90 disabled:opacity-40"
      >
        {isPending ? "Confirming…" : "Redeem PT + YT"}
      </button>
    </div>
  );
}
