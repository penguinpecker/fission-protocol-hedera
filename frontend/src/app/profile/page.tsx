"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useChainId } from "wagmi";
import { useWalletAdapter } from "@/lib/hedera-wallet/adapter";
import { useHederaWallet } from "@/lib/hedera-wallet/provider";
import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";
import { WalletGate } from "@/components/WalletGate";
import { ApprovalsCard } from "@/components/profile/ApprovalsCard";
import { useCachedMarkets } from "@/hooks/useCachedMarkets";
import { useMarketDetail, useUserPosition, type MarketDetail } from "@/hooks/useMarket";
import { useSyValueUsd, formatUsd } from "@/hooks/useSyValueUsd";
import { useWatchlist } from "@/hooks/useWatchlist";
import { useSiweAuth } from "@/hooks/useSiweAuth";
import { impliedApyPct, daysUntil, formatCompact } from "@/hooks/useMarkets";
import { ptToSyRate, ytToSyRate, type UserPosition } from "@/components/MarketPositionCard";
import { getMarketDisplay } from "@/lib/markets-metadata";
import { ADDRESSES, HEDERA_TOKENS, USDC_DECIMALS, WHBAR_DECIMALS, isDeployed } from "@/lib/addresses";

/**
 * Terminal-style portfolio page. Sections:
 *
 *   - profile-head: avatar + address + HashScan + Copy/Disconnect buttons
 *   - 4-up KPI strip (portfolio / PT / YT / LP)
 *   - left  → tabs (All / PT / YT / LP / History) + positions table
 *   - right → pending_claims, recent_activity, watchlist
 *
 * Per-row position math + USD values are computed inside `PositionsTable` so
 * `useMarketDetail` + `useUserPosition` + `useSyValueUsd` each have a stable
 * hook call site — see `PositionAccumulator` for the per-market subcomponent.
 */

export default function ProfilePage() {
  return (
    <main className="min-h-screen text-text">
      <Nav />
      <WalletGate>
        <ProfileBody />
      </WalletGate>
      <Footer />
    </main>
  );
}

type PosKind = "SY" | "PT" | "YT" | "LP";

interface PortfolioRow {
  market: `0x${string}`;
  /** HTS SY-share token for this market — needed to pre-associate before a claim. */
  syShare: `0x${string}`;
  symbol: string;
  kind: PosKind;
  amountRaw: bigint;
  /** Decimals for the token represented by `amountRaw` (used to format the display). */
  decimals: number;
  costBasisSy: number;
  currentValueSy: number;
  unrealisedSy: number;
  /** USD values (sy × usdPerShare). undefined when the SY price feed is down —
   *  callers fall back to the token count / "—" rather than showing $0. */
  costBasisUsd?: number;
  currentValueUsd?: number;
  unrealisedUsd?: number;
  /** Display string for the unrealised column when SY-units don't fit (e.g. YT). */
  unrealisedOverride?: string;
  maturity: { days: number; never?: boolean };
  expired: boolean;
}

interface PortfolioTotals {
  portfolioUsd: number | undefined;
  ptRaw: bigint;
  ytRaw: bigint;
  lpRaw: bigint;
  /** Per-kind current USD value (mark-to-market), for the KPI strip. */
  ptUsd: number | undefined;
  ytUsd: number | undefined;
  lpUsd: number | undefined;
  ptPayoutUsd: number | undefined;
  unclaimedYieldUsd: number | undefined;
  /** Per-asset breakdown of the unclaimed yield — what the user would
   *  receive if they redeemed their SY-denominated claim right now. */
  unclaimedUsdc: number | undefined;
  unclaimedWhbar: number | undefined;
}

function ProfileBody() {
  const adapter = useWalletAdapter();
  const address = adapter.address ?? undefined;
  const { markets: cached } = useCachedMarkets();

  const marketAddrs = useMemo(
    () => (cached ?? []).map((m) => m.market_address as `0x${string}`),
    [cached],
  );

  // Each per-market accumulator pushes its rows + per-token totals up here.
  const [rowsByMarket, setRowsByMarket] = useState<Record<string, PortfolioRow[]>>({});
  const [totalsByMarket, setTotalsByMarket] = useState<Record<string, Partial<PortfolioTotals>>>({});

  useEffect(() => {
    setRowsByMarket({});
    setTotalsByMarket({});
  }, [address, marketAddrs.length]);

  // Stable handler so PositionAccumulator's effect doesn't refire every render
  // and pin the main thread (which starved the header's click handlers).
  const handleReport = useCallback(
    (m: string, rows: PortfolioRow[], t: Partial<PortfolioTotals>) => {
      setRowsByMarket((prev) => ({ ...prev, [m]: rows }));
      setTotalsByMarket((prev) => ({ ...prev, [m]: t }));
    },
    [],
  );

  const allRows = useMemo(() => Object.values(rowsByMarket).flat(), [rowsByMarket]);

  const totals: PortfolioTotals = useMemo(() => {
    let portfolioUsd: number | undefined = undefined;
    let ptRaw = 0n;
    let ytRaw = 0n;
    let lpRaw = 0n;
    let ptUsd: number | undefined = undefined;
    let ytUsd: number | undefined = undefined;
    let lpUsd: number | undefined = undefined;
    let ptPayoutUsd: number | undefined = undefined;
    let unclaimedYieldUsd: number | undefined = undefined;
    let unclaimedUsdc: number | undefined = undefined;
    let unclaimedWhbar: number | undefined = undefined;

    for (const t of Object.values(totalsByMarket)) {
      if (t.portfolioUsd !== undefined)
        portfolioUsd = (portfolioUsd ?? 0) + t.portfolioUsd;
      if (t.ptRaw !== undefined) ptRaw += t.ptRaw;
      if (t.ytRaw !== undefined) ytRaw += t.ytRaw;
      if (t.lpRaw !== undefined) lpRaw += t.lpRaw;
      if (t.ptUsd !== undefined) ptUsd = (ptUsd ?? 0) + t.ptUsd;
      if (t.ytUsd !== undefined) ytUsd = (ytUsd ?? 0) + t.ytUsd;
      if (t.lpUsd !== undefined) lpUsd = (lpUsd ?? 0) + t.lpUsd;
      if (t.ptPayoutUsd !== undefined)
        ptPayoutUsd = (ptPayoutUsd ?? 0) + t.ptPayoutUsd;
      if (t.unclaimedYieldUsd !== undefined)
        unclaimedYieldUsd = (unclaimedYieldUsd ?? 0) + t.unclaimedYieldUsd;
      if (t.unclaimedUsdc !== undefined)
        unclaimedUsdc = (unclaimedUsdc ?? 0) + t.unclaimedUsdc;
      if (t.unclaimedWhbar !== undefined)
        unclaimedWhbar = (unclaimedWhbar ?? 0) + t.unclaimedWhbar;
    }

    return { portfolioUsd, ptRaw, ytRaw, lpRaw, ptUsd, ytUsd, lpUsd, ptPayoutUsd, unclaimedYieldUsd, unclaimedUsdc, unclaimedWhbar };
  }, [totalsByMarket]);

  return (
    <div className="mx-auto max-w-[1440px] px-4 sm:px-6 md:px-7">
      <ProfileHead address={address} accountId={adapter.accountId ?? null} disconnect={adapter.disconnect} />

      <KpiStrip totals={totals} />

      <div className="mb-12 grid gap-8 sm:mb-16 lg:grid-cols-[1fr_320px]">
        {/* left — tabs + positions table */}
        <div className="min-w-0">
          <PositionsSection rows={allRows} user={address} />
        </div>

        {/* right — sidebars */}
        <aside className="flex flex-col gap-6">
          <PendingClaimsCard
            unclaimedYieldUsd={totals.unclaimedYieldUsd}
            unclaimedUsdc={totals.unclaimedUsdc}
            unclaimedWhbar={totals.unclaimedWhbar}
            user={address}
          />
          <ApprovalsCard user={address} />
          <RecentActivityCard userEvm={address} />
          <WatchlistCard />
        </aside>
      </div>

      {/* Hidden per-market accumulators — each runs its own hooks and reports
          rows + totals up via callbacks. Rendering them as siblings keeps the
          hook call site stable across renders (React rules-of-hooks). */}
      <div className="hidden">
        {marketAddrs.map((m) => (
          <PositionAccumulator
            key={m}
            market={m}
            user={address}
            onReport={handleReport}
          />
        ))}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────── head + buttons */

function ProfileHead({
  address,
  accountId,
  disconnect,
}: {
  address: `0x${string}` | undefined;
  accountId: string | null;
  disconnect: () => Promise<void>;
}) {
  const [copied, setCopied] = useState(false);
  if (!address) return null;
  const short = `${address.slice(0, 6)}…${address.slice(-4)}`;
  const onCopy = async () => {
    await navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const hashscan = accountId
    ? `https://hashscan.io/mainnet/account/${accountId}`
    : `https://hashscan.io/mainnet/account/${address}`;

  return (
    <div className="flex flex-wrap items-end justify-between gap-4 border-b border-border py-6 sm:gap-6 sm:py-8">
      <div className="term-fade flex min-w-0 items-center gap-3 sm:gap-5">
        <div className="grid size-[44px] flex-shrink-0 place-items-center border border-borderHover bg-white/[0.04] font-mono text-[16px] text-white sm:size-[54px] sm:text-[18px]">
          ◐
        </div>
        <div className="min-w-0">
          <div className="font-mono text-[15px] tracking-[0.02em] text-white sm:text-[18px]">{short}</div>
          <div className="mt-1 font-mono text-[10.5px] uppercase tracking-[0.14em] text-textDim sm:text-[11px]">
            HEDERA · {accountId ?? "—"} ·{" "}
            <a href={hashscan} target="_blank" rel="noreferrer" className="text-textSec hover:text-white">
              View on HashScan ↗
            </a>
          </div>
        </div>
      </div>
      <div className="term-fade term-fade-d1 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onCopy}
          className="inline-flex items-center gap-2 border border-borderHover bg-white/[0.04] px-3.5 py-2 font-mono text-[12px] uppercase tracking-[0.14em] text-text transition hover:bg-white/[0.06]"
        >
          {copied ? "Copied" : "Copy address"}
        </button>
        <button
          type="button"
          onClick={() => void disconnect()}
          className="inline-flex items-center gap-2 border border-borderHover bg-white/[0.04] px-3.5 py-2 font-mono text-[12px] uppercase tracking-[0.14em] text-text transition hover:bg-white/[0.06]"
        >
          Disconnect
        </button>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────── KPI strip */

function KpiStrip({ totals }: { totals: PortfolioTotals }) {
  return (
    <div className="term-fade term-fade-d2 my-6 grid gap-px border border-border bg-border sm:grid-cols-2 sm:my-8 lg:grid-cols-4">
      <Kpi
        label="Portfolio value"
        value={totals.portfolioUsd !== undefined ? (formatUsd(totals.portfolioUsd) ?? "—") : "—"}
        sub="across all markets"
      />
      <Kpi
        label="PT · fixed locked"
        value={totals.ptUsd !== undefined ? (formatUsd(totals.ptUsd) ?? "—") : "—"}
        sub={
          totals.ptPayoutUsd !== undefined
            ? `≈ ${formatUsd(totals.ptPayoutUsd) ?? "—"} at maturity`
            : "—"
        }
      />
      <Kpi
        label="YT · active stream"
        value={totals.ytUsd !== undefined ? (formatUsd(totals.ytUsd) ?? "—") : "—"}
        sub={
          totals.unclaimedYieldUsd !== undefined
            ? `${formatUsd(totals.unclaimedYieldUsd) ?? "$0.00"} unclaimed`
            : "—"
        }
      />
      <Kpi
        label="LP · provided"
        value={totals.lpUsd !== undefined ? (formatUsd(totals.lpUsd) ?? "—") : "—"}
        sub="fees earned in pool"
      />
    </div>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="bg-white/[0.015] p-4 sm:p-5">
      <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-textDim">{label}</div>
      <div className="mt-2 break-words font-mono text-[24px] font-medium tracking-[-0.02em] text-white tabular-nums sm:text-[30px]">
        {value}
      </div>
      <div className="mt-1 font-mono text-[11px] text-textSec sm:text-[11.5px]">{sub}</div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────── positions table */

function PositionsSection({ rows, user }: { rows: PortfolioRow[]; user: `0x${string}` | undefined }) {
  const [tab, setTab] = useState<"All" | "SY" | "PT" | "YT" | "LP" | "History">("All");
  const filtered =
    tab === "All"
      ? rows
      : tab === "History"
        ? []
        : rows.filter((r) => r.kind === tab);

  return (
    <div>
      <div className="flex w-fit max-w-full gap-px overflow-x-auto border border-border bg-border">
        {(["All", "SY", "PT", "YT", "LP", "History"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`whitespace-nowrap px-3 py-2.5 font-mono text-[11px] uppercase tracking-[0.16em] transition sm:px-4 sm:py-3 ${
              tab === t
                ? "bg-white text-black"
                : "bg-white/[0.015] text-textSec hover:bg-white/[0.04] hover:text-white"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="overflow-x-auto border border-t-0 border-border bg-white/[0.015]">
        <table className="w-full min-w-[820px] border-collapse">
        <thead className="bg-white/[0.04]">
          <tr>
            <PosTh>Market</PosTh>
            <PosTh>Type</PosTh>
            <PosTh align="right">Amount</PosTh>
            <PosTh align="right">Cost basis</PosTh>
            <PosTh align="right">Current value</PosTh>
            <PosTh align="right">Unrealised</PosTh>
            <PosTh align="right">Maturity</PosTh>
            <PosTh></PosTh>
          </tr>
        </thead>
        <tbody>
          {tab === "History" ? (
            <tr>
              <td colSpan={8} className="px-4 py-12 text-center font-mono text-[12px] text-textDim">
                History view — Mirror Node activity feed lives in the recent_activity panel.
              </td>
            </tr>
          ) : filtered.length === 0 ? (
            <tr>
              <td colSpan={8} className="px-4 py-12 text-center font-mono text-[12px] text-textDim">
                No {tab === "All" ? "" : `${tab} `}positions yet.
              </td>
            </tr>
          ) : (
            filtered.map((r, i) => <PositionRow key={`${r.market}-${r.kind}-${i}`} row={r} user={user} />)
          )}
        </tbody>
        </table>
      </div>
    </div>
  );
}

function PositionRow({ row, user }: { row: PortfolioRow; user: `0x${string}` | undefined }) {
  // W2-03: Claim/Redeem now fire real on-chain txs via the adapter instead of
  // dead-linking to a page with no claim/redeem action. Sell/Add/Remove stay
  // navigation links to the existing strategy forms (those forms do the work).
  const adapter = useWalletAdapter();
  const hedera = useHederaWallet();
  const base = `/markets/${row.market}`;
  const [txState, setTxState] = useState<"idle" | "pending" | "done" | "error">("idle");
  const [txHash, setTxHash] = useState<string | undefined>(undefined);
  const [txErr, setTxErr] = useState<string | null>(null);

  // PT Redeem (post-expiry only): burn PT 1:1 for SY via redeemAfterExpiry.
  const onRedeem = useCallback(async () => {
    if (!user || !row.expired || row.amountRaw === 0n) return;
    setTxErr(null);
    setTxState("pending");
    try {
      // REDEEM-NEEDS-SYSHARE-ASSOC: redeemAfterExpiry delivers the SY-share to
      // the receiver. A limited-association wallet (max_auto_assoc=0) that got
      // its PT via SY-mode/transfer would revert TOKEN_NOT_ASSOCIATED at
      // consensus on the SY-share leg (invisible to the eth_call gas estimate).
      // Reuse the SELL-01 helper to pre-associate it. No-op in EVM mode / when
      // already associated.
      await ensureRewardAssociations(
        adapter.mode,
        adapter.accountId,
        hedera.getConnector(),
        [row.syShare],
        adapter.address,
      );
      const { txHash: h } = await adapter.write({
        kind: "redeemAfterExpiry",
        market: row.market,
        ptIn: row.amountRaw,
        ytIn: 0n, // contract requires ytIn == 0 (YT cannot be burned this way)
        receiver: user,
      });
      setTxHash(h);
      setTxState("done");
    } catch (e) {
      setTxErr(e instanceof Error ? e.message : String(e));
      setTxState("error");
    }
  }, [adapter, hedera, row.market, row.syShare, row.amountRaw, row.expired, user]);

  // YT Claim: claim accrued AMM-fee share (SY-share) + SY-yield rewards. Both
  // are owed to YT holders on the rewards market; fire them back-to-back.
  const onClaim = useCallback(async () => {
    if (!user) return;
    setTxErr(null);
    setTxState("pending");
    // F5: the two claim legs (AMM-fee share + SY yield) are independent txs.
    // Track per-leg success so a leg-B failure doesn't mask a leg-A success
    // with a blanket error — the user has already claimed (and paid gas for)
    // the AMM fees and must not be told the whole thing failed.
    let ammClaimed = false;
    try {
      // SELL-01: associate USDC + WHBAR (claimRewards) and the SY-share
      // (claimAmmRewards) before claiming, or a limited-association wallet
      // reverts TOKEN_NOT_ASSOCIATED at consensus.
      await ensureRewardAssociations(
        adapter.mode,
        adapter.accountId,
        hedera.getConnector(),
        [HEDERA_TOKENS.USDC, HEDERA_TOKENS.WHBAR, row.syShare],
        adapter.address,
      );
      const a = await adapter.write({ kind: "claimAmmRewards", market: row.market, receiver: user });
      ammClaimed = true;
      setTxHash(a.txHash);
      const b = await adapter.write({ kind: "claimRewards", market: row.market, receiver: user });
      setTxHash(b.txHash);
      setTxState("done");
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      setTxErr(
        ammClaimed
          ? `AMM-fee claim succeeded; yield claim failed — retry. (${detail})`
          : detail,
      );
      setTxState("error");
    }
  }, [adapter, hedera, row.market, row.syShare, user]);

  interface RowAction {
    label: string;
    href?: string;
    onClick?: () => void | Promise<void>;
    pri?: boolean;
    disabled?: boolean;
  }
  const busy = txState === "pending";
  const actions: RowAction[] =
    row.kind === "SY"
      ? [
          // Sell SY → HBAR via FissionUnzap.unzapSy. The /sy page wraps it.
          { label: "Sell to HBAR", href: `${base}/sy`, pri: true },
        ]
      : row.kind === "PT"
        ? [
            { label: "Sell", href: `${base}/pt` },
            { label: "Redeem", onClick: onRedeem, pri: true, disabled: !row.expired || busy || !user },
          ]
        : row.kind === "YT"
          ? [
              { label: "Sell", href: `${base}/yt` },
              { label: "Claim", onClick: onClaim, pri: true, disabled: busy || !user },
            ]
          : [
              { label: "Add", href: `${base}/lp` },
              { label: "Remove", href: `${base}/lp`, pri: true },
            ];

  const unrealisedColor =
    row.unrealisedSy > 0 ? "text-white" : row.unrealisedSy < 0 ? "text-error" : "text-textSec";

  const btnClass = (pri?: boolean) =>
    `border px-3 py-1.5 font-mono text-[10.5px] uppercase tracking-[0.14em] transition ${
      pri
        ? "border-white bg-white text-black hover:bg-white/85"
        : "border-borderHover bg-white/[0.04] text-textSec hover:bg-white/[0.06] hover:text-white"
    }`;

  return (
    <tr className="border-b border-border last:border-b-0">
      <PosTd>{row.symbol}</PosTd>
      <PosTd>
        <span className="font-mono text-[11.5px] uppercase tracking-[0.14em] text-white">
          {row.kind}
        </span>
      </PosTd>
      <PosNum>
        {row.currentValueUsd !== undefined ? (
          <span className="flex flex-col items-end leading-tight">
            <span>{formatUsd(row.currentValueUsd) ?? "—"}</span>
            <span className="text-[10px] text-textDim">{formatRaw(row.amountRaw, row.decimals)}</span>
          </span>
        ) : (
          formatRaw(row.amountRaw, row.decimals)
        )}
      </PosNum>
      <PosNum>{row.costBasisUsd !== undefined ? (formatUsd(row.costBasisUsd) ?? "—") : "—"}</PosNum>
      <PosNum>{row.currentValueUsd !== undefined ? (formatUsd(row.currentValueUsd) ?? "—") : "—"}</PosNum>
      <PosNum>
        <span className={unrealisedColor}>
          {row.unrealisedOverride
            ? row.unrealisedOverride
            : row.unrealisedUsd !== undefined
              ? `${row.unrealisedUsd >= 0 ? "+" : ""}${formatUsd(row.unrealisedUsd) ?? "—"}`
              : "—"}
        </span>
      </PosNum>
      <PosNum dim={row.maturity.never}>{row.maturity.never ? "never" : `${row.maturity.days}d`}</PosNum>
      <PosTd>
        <div className="flex flex-col items-end gap-1">
          <div className="flex justify-end gap-1.5">
            {actions.map((a) =>
              a.disabled ? (
                <span
                  key={a.label}
                  className="cursor-not-allowed border border-border bg-white/[0.02] px-3 py-1.5 font-mono text-[10.5px] uppercase tracking-[0.14em] text-textDim/60"
                >
                  {busy && a.pri ? "…" : a.label}
                </span>
              ) : a.onClick ? (
                <button
                  key={a.label}
                  type="button"
                  onClick={() => void a.onClick!()}
                  className={btnClass(a.pri)}
                >
                  {busy && a.pri ? "…" : a.label}
                </button>
              ) : (
                <Link key={a.label} href={a.href!} className={btnClass(a.pri)}>
                  {a.label}
                </Link>
              ),
            )}
          </div>
          {txState === "done" && txHash && (
            <a
              href={hashscanTxUrl(txHash)}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-[10px] text-success underline underline-offset-2 hover:text-white"
            >
              ✓ submitted ↗
            </a>
          )}
          {txState === "error" && txErr && (
            <span className="max-w-[220px] truncate font-mono text-[10px] text-error" title={txErr}>
              {txErr.slice(0, 60)}
            </span>
          )}
        </div>
      </PosTd>
    </tr>
  );
}

function PosTh({
  children,
  align,
}: {
  children?: React.ReactNode;
  align?: "right";
}) {
  return (
    <th
      className={`whitespace-nowrap border-b border-border bg-white/[0.04] px-3 py-3 font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-textDim sm:px-4 sm:py-3.5 ${
        align === "right" ? "text-right" : "text-left"
      }`}
    >
      {children}
    </th>
  );
}

function PosTd({ children }: { children: React.ReactNode }) {
  return (
    <td className="whitespace-nowrap border-b border-border px-3 py-3.5 font-mono text-[13px] text-text last:border-b-0 sm:px-4 sm:py-4">
      {children}
    </td>
  );
}

function PosNum({
  children,
  dim,
}: {
  children: React.ReactNode;
  dim?: boolean;
}) {
  return (
    <td
      className={`whitespace-nowrap border-b border-border px-3 py-3.5 text-right font-mono text-[13px] tabular-nums last:border-b-0 sm:px-4 sm:py-4 ${
        dim ? "text-textDim" : "text-white"
      }`}
    >
      {children}
    </td>
  );
}

/* ─────────────────────────────────────────────────────── sidebar cards */

function PendingClaimsCard({
  unclaimedYieldUsd,
  unclaimedUsdc,
  unclaimedWhbar,
  user,
}: {
  unclaimedYieldUsd: number | undefined;
  unclaimedUsdc: number | undefined;
  unclaimedWhbar: number | undefined;
  user: `0x${string}` | undefined;
}) {
  const adapter = useWalletAdapter();
  const hedera = useHederaWallet();
  // SELL-01: the live market's SY-share address, so "Claim All" can
  // pre-associate it (alongside USDC/WHBAR) before claiming.
  const { data: marketDetail } = useMarketDetail(
    isDeployed(ADDRESSES.market) ? ADDRESSES.market : undefined,
  );
  // Yield is paid in SY shares; at claim time those decompose into the SY's
  // underlying V3 LP balance (USDC + WHBAR). We show the equivalent each
  // would yield right now, derived from the V3 NFT amounts / total supply.
  const fmtTok = (n: number | undefined, decimals: number): string => {
    if (n === undefined) return "—";
    if (n === 0) return "0";
    if (n < 0.0001) return n.toExponential(2);
    return n.toFixed(decimals);
  };

  // W2-03: "Claim All" was href="#" (inert). Wire it to claim the user's
  // accrued AMM-fee share + SY-yield rewards from the live market.
  const [txState, setTxState] = useState<"idle" | "pending" | "done" | "error">("idle");
  const [txHash, setTxHash] = useState<string | undefined>(undefined);
  const [txErr, setTxErr] = useState<string | null>(null);
  const canClaim = !!user && isDeployed(ADDRESSES.market);

  const onClaimAll = useCallback(async () => {
    if (!user || !isDeployed(ADDRESSES.market)) return;
    setTxErr(null);
    setTxState("pending");
    // F5: the two legs (AMM-fee share + SY yield) are independent txs. Track
    // per-leg success so a leg-B failure doesn't mask a successful leg-A claim.
    let ammClaimed = false;
    // F5 (optional): skip the yield leg when its preview is DEFINITIVELY 0
    // (all of usdc/whbar/yieldUsd are loaded and zero) — saves the user a
    // pointless second tx + gas. `undefined` means "still loading", so we do
    // NOT skip then (claim both to be safe).
    const yieldPreviewLoaded =
      unclaimedUsdc !== undefined &&
      unclaimedWhbar !== undefined &&
      unclaimedYieldUsd !== undefined;
    const yieldPreviewZero =
      yieldPreviewLoaded &&
      unclaimedUsdc === 0 &&
      unclaimedWhbar === 0 &&
      unclaimedYieldUsd === 0;
    try {
      // SELL-01: associate the reward tokens this claim delivers before firing
      // it. USDC + WHBAR come from claimRewards; the SY-share from
      // claimAmmRewards. Skipping this reverts TOKEN_NOT_ASSOCIATED at
      // consensus on a limited-association wallet (invisible to eth_call).
      const rewardTokens: `0x${string}`[] = [HEDERA_TOKENS.USDC, HEDERA_TOKENS.WHBAR];
      if (marketDetail?.syShare) rewardTokens.push(marketDetail.syShare);
      await ensureRewardAssociations(
        adapter.mode,
        adapter.accountId,
        hedera.getConnector(),
        rewardTokens,
        adapter.address,
      );
      const a = await adapter.write({ kind: "claimAmmRewards", market: ADDRESSES.market, receiver: user });
      ammClaimed = true;
      setTxHash(a.txHash);
      if (!yieldPreviewZero) {
        const b = await adapter.write({ kind: "claimRewards", market: ADDRESSES.market, receiver: user });
        setTxHash(b.txHash);
      }
      setTxState("done");
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      setTxErr(
        ammClaimed
          ? `AMM-fee claim succeeded; yield claim failed — retry. (${detail})`
          : detail,
      );
      setTxState("error");
    }
  }, [adapter, hedera, marketDetail?.syShare, user, unclaimedUsdc, unclaimedWhbar, unclaimedYieldUsd]);

  return (
    <div className="flex flex-col gap-px border border-border bg-border">
      <div className="bg-white/[0.015] p-5">
        <h4 className="mb-3.5 font-mono text-[10.5px] uppercase tracking-[0.2em] text-textDim">
          // pending_claims
        </h4>
        <SideRow k="USDC" v={fmtTok(unclaimedUsdc, 6)} />
        <SideRow k="WHBAR" v={fmtTok(unclaimedWhbar, 4)} />
        <SideRow
          k="Total ≈"
          v={unclaimedYieldUsd !== undefined ? (formatUsd(unclaimedYieldUsd) ?? "$0.00") : "$0.00"}
        />
        <button
          type="button"
          onClick={() => void onClaimAll()}
          disabled={!canClaim || txState === "pending"}
          className="mt-3 inline-flex w-full justify-center border border-white bg-white px-4 py-2.5 font-mono text-[12px] font-semibold uppercase tracking-[0.14em] text-black transition hover:bg-white/85 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {txState === "pending" ? "Claiming…" : "Claim All"}
        </button>
        {txState === "done" && txHash && (
          <a
            href={hashscanTxUrl(txHash)}
            target="_blank"
            rel="noreferrer"
            className="mt-2 block font-mono text-[10px] text-success underline underline-offset-2 hover:text-white"
          >
            ✓ claim submitted ↗
          </a>
        )}
        {txState === "error" && txErr && (
          <span className="mt-2 block font-mono text-[10px] text-error" title={txErr}>
            {txErr.slice(0, 80)}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Decoded activity row returned by `/api/activity`. Shape mirrors the route's
 * `ActivityEntry` interface — we duplicate it here so the client doesn't have
 * to import from a server-only module path. If the two ever drift, the route
 * is the source of truth.
 */
interface ActivityAmount {
  token: string;
  raw: string;
  formatted: string;
  usd?: number;
}
interface ActivityEntry {
  txId: string;
  timestamp: number;
  contract: { address: `0x${string}`; id: string | null; label: string };
  action: string;
  result: string;
  amount?: ActivityAmount;
  side?: "in" | "out";
  hashscanUrl: string;
}

function RecentActivityCard({ userEvm }: { userEvm: `0x${string}` | undefined }) {
  const adapter = useWalletAdapter();
  const accountId = adapter.accountId;
  // ACTIVITY-401-NOSESSION: the profile renders on wallet-CONNECT, but
  // /api/activity is SIWE-session-bound (WEB2-IDOR-02). A connected-but-not-
  // signed-in user (declined the auto-sign, or a returning user whose 7-day
  // cookie expired and session-restore didn't re-fire SIWE) gets HTTP 401. We
  // surface a friendly "Sign in to view your activity" state with a button
  // that fires the existing SIWE signIn, instead of a dead "api_401" string.
  const { state: siwe, signIn } = useSiweAuth();

  const [entries, setEntries] = useState<ActivityEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Tracked separately from `error` so the 401 case renders the sign-in prompt
  // (recoverable) while non-401 errors keep the existing error display.
  const [needsSignIn, setNeedsSignIn] = useState(false);

  // Re-run the fetch when the SIWE session becomes authenticated so a fresh
  // sign-in (via the prompt below or the Nav) immediately populates the feed
  // without a page reload.
  const authed = siwe.status === "authenticated";

  useEffect(() => {
    if (!userEvm && !accountId) return;
    let cancelled = false;
    (async () => {
      try {
        // Server-side decoder. Returns a clean envelope with action, token,
        // amount + optional USD value. Falls back to the selector decoder for
        // any contract not in the on-server registry.
        const acc = userEvm ?? accountId;
        const r = await fetch(`/api/activity?address=${acc}&limit=10`, {
          cache: "no-store",
        });
        if (!r.ok) {
          if (cancelled) return;
          // 401 = no/expired session → recoverable via SIWE sign-in.
          if (r.status === 401) {
            setNeedsSignIn(true);
            setError(null);
          } else {
            setNeedsSignIn(false);
            setError(`api_${r.status}`);
          }
          return;
        }
        const j = (await r.json()) as { entries?: ActivityEntry[] };
        if (!cancelled) {
          setNeedsSignIn(false);
          setError(null);
          setEntries(j.entries ?? []);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "fetch_failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userEvm, accountId, authed]);

  const signingIn = siwe.status === "loading";

  return (
    <div>
      <h4 className="mb-3.5 font-mono text-[10.5px] uppercase tracking-[0.2em] text-textDim">
        // recent_activity
      </h4>
      <div className="flex flex-col gap-px border border-border bg-border">
        {needsSignIn ? (
          <div className="bg-white/[0.015] p-4 font-mono text-[11.5px] text-textDim">
            <p className="leading-relaxed">Sign in to view your activity.</p>
            <button
              type="button"
              onClick={() => void signIn()}
              disabled={signingIn}
              className="mt-3 inline-flex w-full justify-center border border-white bg-white px-4 py-2.5 font-mono text-[12px] font-semibold uppercase tracking-[0.14em] text-black transition hover:bg-white/85 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {signingIn ? "Signing in…" : "Sign in"}
            </button>
            {siwe.status === "error" && (
              <span className="mt-2 block font-mono text-[10px] text-error" title={siwe.error}>
                {siwe.error.slice(0, 80)}
              </span>
            )}
          </div>
        ) : error ? (
          <div className="bg-white/[0.015] p-4 font-mono text-[11.5px] text-textDim">
            Activity feed unavailable — {error}
          </div>
        ) : entries === null ? (
          <div className="bg-white/[0.015] p-4 font-mono text-[11.5px] text-textDim">
            Loading activity…
          </div>
        ) : entries.length === 0 ? (
          <div className="bg-white/[0.015] p-4 font-mono text-[11.5px] text-textDim">
            No contract calls yet on this account.
          </div>
        ) : (
          entries.map((e) => <ActivityRow key={e.txId} entry={e} />)
        )}
      </div>
    </div>
  );
}

function ActivityRow({ entry }: { entry: ActivityEntry }) {
  const when = formatAgo(entry.timestamp * 1000);
  const failed = entry.result !== "SUCCESS";

  // Sign + color rule per the spec:
  //   - failed → warning amber on the action line, no sign on the amount
  //   - side === "in" → "+" prefix in success green (received tokens)
  //   - side === "out" → "−" prefix in neutral (sent / spent)
  //   - no side → no prefix
  const amountSign = failed
    ? ""
    : entry.side === "in"
      ? "+"
      : entry.side === "out"
        ? "−"
        : "";
  const amountColor = failed
    ? "text-textSec"
    : entry.side === "in"
      ? "text-success"
      : "text-white";

  // Prefer USD on the primary line when we have it — user wants the activity
  // feed denominated in dollars, not raw token tickers. The token-amount line
  // moves to the secondary slot for context. Falls back to token amount only
  // when no USD price is available (rare).
  const hasUsd = entry.amount && typeof entry.amount.usd === "number";
  const primaryText = hasUsd
    ? `${amountSign}${formatUsd(entry.amount!.usd!) ?? ""}`
    : entry.amount
      ? `${amountSign}${entry.amount.formatted} ${entry.amount.token}`
      : null;
  const secondaryText = hasUsd && entry.amount
    ? `${entry.amount.formatted} ${entry.amount.token}`
    : null;

  return (
    <a
      href={entry.hashscanUrl}
      target="_blank"
      rel="noreferrer"
      className="group flex items-start justify-between gap-3 bg-white/[0.015] px-4 py-3.5 font-mono text-[11.5px] transition hover:bg-white/[0.04]"
    >
      <div className="min-w-0 flex flex-col gap-0.5">
        <span className={failed ? "text-warning" : "text-white"}>
          {entry.action}
          {failed ? ` · ${entry.result}` : ""}
        </span>
        <span className="text-textDim text-[10.5px]">
          {when} · {entry.contract.label}
        </span>
      </div>
      <div className="flex flex-col items-end gap-0.5 whitespace-nowrap text-right">
        {primaryText ? (
          <span className={`tabular-nums ${amountColor}`}>{primaryText}</span>
        ) : (
          <span className="text-textSec">↗</span>
        )}
        {secondaryText ? (
          <span className="text-textDim text-[10.5px] tabular-nums">{secondaryText}</span>
        ) : null}
      </div>
    </a>
  );
}

/**
 * F6: build a working HashScan transaction URL from whatever the adapter
 * returns as `txHash`.
 *
 *   - Hedera-native mode returns a Hedera transaction ID in the form
 *     `0.0.X@SECONDS.NANOS`. HashScan's /transaction/ route 400s on that raw
 *     id — it wants `0.0.X-SECONDS-NANOS` (the `@` and the seconds/nanos dot
 *     become dashes; the payer's `0.0.` dots stay).
 *   - EVM mode returns a `0x…` hash, which has no `@` and is already valid.
 *
 * Splitting on `@` handles both: with no `@` we pass the value through
 * untouched; with one we dash-join the payer and the timestamp.
 */
function hashscanTxUrl(txHash: string): string {
  const [acct, ts] = txHash.split("@");
  const id = ts === undefined ? acct : `${acct}-${ts.replace(".", "-")}`;
  return `https://hashscan.io/mainnet/transaction/${id}`;
}

/**
 * SELL-01 / REALUSE-01: associate the reward tokens a claim/redeem will deliver
 * BEFORE submitting it.
 *
 * `claimRewards` safe-transfers USDC (+ WHBAR) to the user, `claimAmmRewards`
 * delivers the SY-share token, and `redeemAfterExpiry` delivers the SY-share.
 * On a limited-association wallet (HIP-904 `max_automatic_token_associations:
 * 0`) a transfer of an un-associated token reverts with TOKEN_NOT_ASSOCIATED at
 * consensus — invisible to the eth_call gas estimate, so the action silently
 * fails in the wallet. None of the buy flows pre-associate USDC, so a wallet
 * that only ever bought PT/YT/LP can hit this.
 *
 *   - Hedera-native mode: we can submit a TokenAssociateTransaction, so we
 *     batch the missing ones into a single associate prompt (mirrors the buy
 *     forms' `stepAssociate`) and proceed.
 *   - EVM mode (MetaMask via Hashio): an ECDSA account imported into MetaMask
 *     with `max_automatic_token_associations: 0` CAN buy but cannot receive a
 *     delivery for an un-associated token, and MetaMask CANNOT submit a Hedera
 *     associate tx. So we still CHECK (resolve evm_address → 0.0.id via Mirror,
 *     GET /accounts/{id}/tokens) and, if anything is missing, BLOCK with an
 *     actionable error instead of letting the delivery revert. The check
 *     short-circuits for HIP-904-unlimited accounts (max_auto === -1), which is
 *     the common case for EVM-aliased wallets.
 */
async function ensureRewardAssociations(
  adapterMode: "evm" | "hedera" | null,
  accountId: string | null,
  connector: unknown,
  tokens: `0x${string}`[],
  evmAddress?: `0x${string}` | null,
): Promise<void> {
  if (adapterMode === null) return;
  const { getMissingAssociations, associateTokens, evmAddressToTokenId } =
    await import("@/lib/hedera-wallet/associations");
  // Some tokens (e.g. an un-resolved SY-share) may not be long-zero; skip
  // those rather than throwing — the contract still reverts clearly if one is
  // genuinely missing, and USDC/WHBAR (the at-risk ones) always resolve.
  const ids = tokens
    .map((t) => {
      try {
        return evmAddressToTokenId(t);
      } catch {
        return null;
      }
    })
    .filter((t): t is string => t !== null);
  if (ids.length === 0) return;

  if (adapterMode === "hedera") {
    if (!accountId) return;
    const missing = await getMissingAssociations(accountId, ids);
    if (missing.length === 0) return;
    await associateTokens(connector, accountId, missing);
    return;
  }

  // EVM mode. Mirror Node resolves an ECDSA evm_address directly in both the
  // /accounts/{id} and /accounts/{id}/tokens paths, so we pass the evm address
  // straight through. MetaMask can't submit an associate tx, so any missing
  // association is a hard block — surface an actionable message.
  if (!evmAddress) return;
  const missing = await getMissingAssociations(evmAddress, ids);
  if (missing.length === 0) return;
  throw new Error(
    `Your account hasn't associated ${missing.length === 1 ? "this token" : "these tokens"}: ${missing.join(", ")}. ` +
      `MetaMask can't associate Hedera tokens — enable unlimited auto-association on your account, ` +
      `or associate ${missing.length === 1 ? "it" : "them"} first (e.g. in HashPack), then retry.`,
  );
}

function formatAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function WatchlistCard() {
  const chainId = useChainId();
  const { items } = useWatchlist();
  const { markets: cached } = useCachedMarkets();
  const list = items.filter((i) => i.chain_id === chainId);

  return (
    <div className="flex flex-col gap-px border border-border bg-border">
      <div className="bg-white/[0.015] p-5">
        <h4 className="mb-3.5 font-mono text-[10.5px] uppercase tracking-[0.2em] text-textDim">
          // watchlist
        </h4>
        {list.length === 0 ? (
          <div className="font-mono text-[12.5px] text-textDim">no starred markets</div>
        ) : (
          list.map((w) => {
            const cm = cached?.find(
              (m) => m.market_address.toLowerCase() === w.market_address.toLowerCase(),
            );
            const meta = getMarketDisplay(w.market_address);
            const symbol = meta?.shortName ?? cm?.market_type ?? "Market";
            const apy = cm?.last_ln_implied_rate
              ? impliedApyPct(BigInt(cm.last_ln_implied_rate))
              : null;
            return (
              <Link
                key={w.market_address}
                href={`/markets/${w.market_address}`}
                className="flex justify-between border-b border-border py-1.5 font-mono text-[12.5px] last:border-b-0 hover:text-white"
              >
                <span className="text-textDim">{symbol} ★</span>
                <span className="text-white tabular-nums">
                  {apy !== null ? `${apy.toFixed(2)}%` : "—"}
                </span>
              </Link>
            );
          })
        )}
      </div>
    </div>
  );
}

function SideRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between border-b border-border py-1.5 font-mono text-[12.5px] last:border-b-0">
      <span className="text-textDim">{k}</span>
      <span className="text-white tabular-nums">{v}</span>
    </div>
  );
}

/* ─────────────────────────────────────────────────────── per-market hook host */

function PositionAccumulator({
  market,
  user,
  onReport,
}: {
  market: `0x${string}`;
  user: `0x${string}` | undefined;
  onReport: (
    market: string,
    rows: PortfolioRow[],
    totals: Partial<PortfolioTotals>,
  ) => void;
}) {
  const { data: detail } = useMarketDetail(market);
  const { data: position } = useUserPosition(market, detail, user);
  const { usdPerShare, usdcPerShare, whbarPerShare } = useSyValueUsd(detail?.sy);

  useEffect(() => {
    if (!detail || !position) {
      onReport(market, [], {});
      return;
    }
    const { rows, totals } = buildRows(market, detail, position, usdPerShare, usdcPerShare, whbarPerShare);
    onReport(market, rows, totals);
  }, [market, detail, position, usdPerShare, usdcPerShare, whbarPerShare, onReport]);

  return null;
}

function buildRows(
  market: `0x${string}`,
  detail: MarketDetail,
  position: UserPosition,
  usdPerShare: number | undefined,
  usdcPerShare: number | undefined,
  whbarPerShare: number | undefined,
): { rows: PortfolioRow[]; totals: Partial<PortfolioTotals> } {
  const meta = getMarketDisplay(market);
  const symbol = meta?.shortName ?? detail.syName ?? "Market";

  const expired = Date.now() / 1000 >= Number(detail.expiry);
  const days = daysUntil(detail.expiry);
  const apy = impliedApyPct(detail.lastLnImpliedRate);
  const ptRate = ptToSyRate(apy, days);
  const ytRate = ytToSyRate(apy, days);

  // F1: SY/PT/YT/LP tokens declare decimals()=18 but are ISSUED + TRACKED as
  // RAW INTEGER COUNTS (the whole app — KPI strip, trade forms — renders them
  // with `formatCompact`, NO division by 10**18). So the SY-denominated
  // cost-basis / current-value / unrealised columns are computed in RAW COUNTS
  // too (no `/ 10**18`), then rendered via the same compact formatter. Dividing
  // here produced "3.02e-9 PT" / "0.0000 SY" rows that contradicted the KPIs.
  const dec = detail.syDecimals || 18;

  // DECIMALS-01 follow-up (2026-05-30): the position page shows $ values, not
  // raw token counts. usdPerShare is $/raw-SY-unit, and the costBasis/current/
  // unrealised figures below are raw-SY counts, so sy × usdPerShare = USD.
  // Returns undefined when the price feed is down so the UI falls back to the
  // token count instead of a misleading $0.
  const toUsd = (sy: number): number | undefined =>
    usdPerShare !== undefined ? sy * usdPerShare : undefined;

  const rows: PortfolioRow[] = [];

  // F7: the real accrued rewards come straight off the position object, which
  // `useUserPosition` populates from market.previewRewards (USDC 6dec + WHBAR
  // 8dec) plus the Lens AMM-fee pending. `UserPosition` (owned by
  // MarketPositionCard) doesn't declare these fields, but the runtime object
  // carries them — read them through a narrow optional view so this compiles
  // regardless of the interface shape. Exact field names from useMarket.ts:
  // `unclaimedRewardsUsd` (number) + `unclaimedRewardsRaw.{usdc,whbar}` (bigints).
  const f7 = position as Partial<{
    unclaimedRewardsUsd: number;
    unclaimedRewardsRaw: { usdc: bigint; whbar: bigint; pendingPtAmm: bigint; pendingYtAmm: bigint };
  }>;

  // SY row — loose SY balance in wallet (not in LP, not split into PT/YT).
  // Value 1:1 in SY by definition. Surfaced so users can see + redeem to
  // HBAR (or use as input to Buy PT / YT / LP) instead of leaving it dust.
  if (position.sy > 0n) {
    const sySy = Number(position.sy); // raw count — 1 SY share == 1 unit
    rows.push({
      market,
      syShare: detail.syShare,
      symbol,
      kind: "SY",
      amountRaw: position.sy,
      decimals: dec,
      costBasisSy: sySy,
      currentValueSy: sySy,
      unrealisedSy: 0,
      costBasisUsd: toUsd(sySy),
      currentValueUsd: toUsd(sySy),
      unrealisedUsd: toUsd(0),
      maturity: { days: 0, never: true },
      expired,
    });
  }

  // PT row — mark-to-AMM today vs. par at maturity (1 PT → 1 SY).
  if (position.pt > 0n) {
    const ptCount = Number(position.pt); // raw count
    const currentSy = ptCount * ptRate;
    const projectedSy = ptCount; // pays 1:1 in SY at maturity
    const unrealisedSy = projectedSy - currentSy;
    rows.push({
      market,
      syShare: detail.syShare,
      symbol,
      kind: "PT",
      amountRaw: position.pt,
      decimals: dec,
      costBasisSy: currentSy,
      currentValueSy: currentSy,
      unrealisedSy: unrealisedSy,
      costBasisUsd: toUsd(currentSy),
      currentValueUsd: toUsd(currentSy),
      unrealisedUsd: toUsd(unrealisedSy),
      maturity: { days, never: false },
      expired,
    });
  }

  // YT row — value decays to 0 at maturity. Claimable yield gets its own
  // override on the unrealised column so the user sees the $-equivalent.
  if (position.yt > 0n || position.claimableYield > 0n || (f7.unclaimedRewardsUsd ?? 0) > 0) {
    const ytCount = Number(position.yt); // raw count
    const currentSy = ytCount * ytRate;
    const claimableSy = Number(position.claimableYield); // raw count
    // F7: show the real accrued rewards (previewRewards USDC/WHBAR + AMM-fee
    // pending) when available; fall back to the legacy per-share estimate.
    const usdClaim =
      f7.unclaimedRewardsUsd !== undefined
        ? f7.unclaimedRewardsUsd
        : usdPerShare !== undefined
          ? Number(position.claimableYield) * usdPerShare
          : undefined;
    rows.push({
      market,
      syShare: detail.syShare,
      symbol,
      kind: "YT",
      amountRaw: position.yt,
      decimals: dec,
      costBasisSy: currentSy,
      currentValueSy: currentSy,
      unrealisedSy: claimableSy,
      costBasisUsd: toUsd(currentSy),
      currentValueUsd: toUsd(currentSy),
      unrealisedUsd: usdClaim,
      unrealisedOverride: formatUsd(usdClaim)
        ? `${formatUsd(usdClaim)} unclaimed`
        : `${claimableSy.toFixed(4)} SY unclaimed`,
      maturity: { days, never: true },
      expired,
    });
  }

  // LP row — pro-rata composition. PT leg discounts via ptRate; SY leg is par.
  if (position.lp > 0n && detail.lpSupply > 0n) {
    const lpCount = Number(position.lp); // raw count
    const userPtInLp = (Number(position.lp) * Number(detail.totalPt)) / Number(detail.lpSupply);
    const userSyInLp = (Number(position.lp) * Number(detail.totalSy)) / Number(detail.lpSupply);
    // Raw-count SY value (no `/ 10**18`) — userPtInLp / userSyInLp are already
    // raw counts (pro-rata of the raw totals), so the SY-denominated value is too.
    const currentSy = userPtInLp * ptRate + userSyInLp;
    const parSy = userPtInLp + userSyInLp;
    rows.push({
      market,
      syShare: detail.syShare,
      symbol,
      kind: "LP",
      amountRaw: position.lp,
      decimals: dec,
      costBasisSy: currentSy,
      currentValueSy: currentSy,
      unrealisedSy: parSy - currentSy,
      costBasisUsd: toUsd(currentSy),
      currentValueUsd: toUsd(currentSy),
      unrealisedUsd: toUsd(parSy - currentSy),
      maturity: { days, never: false },
      expired,
    });
    // lpCount intentionally unused beyond context — formatRaw renders the raw bigint.
    void lpCount;
  }

  // Per-market totals → propagated up for the KPI strip.
  const portfolioRaw =
    Number(position.sy) +
    Number(position.pt) * ptRate +
    Number(position.yt) * ytRate +
    (detail.lpSupply > 0n
      ? (Number(position.lp) *
          (Number(detail.totalPt) * ptRate + Number(detail.totalSy))) /
        Number(detail.lpSupply)
      : 0) +
    Number(position.claimableYield);
  const portfolioUsd =
    usdPerShare !== undefined ? portfolioRaw * usdPerShare : undefined;

  const ptPayoutUsd =
    usdPerShare !== undefined ? Number(position.pt) * usdPerShare : undefined;

  // Per-kind current (mark-to-market) USD value for the KPI strip.
  const ptUsd = toUsd(Number(position.pt) * ptRate);
  const ytUsd = toUsd(Number(position.yt) * ytRate);
  const lpUsd = toUsd(
    detail.lpSupply > 0n
      ? (Number(position.lp) *
          (Number(detail.totalPt) * ptRate + Number(detail.totalSy))) /
          Number(detail.lpSupply)
      : 0,
  );

  // F7: the real accrued rewards come off the position object (see `f7` above).
  // The old path multiplied an always-0 `previewYield`-derived claimableYield by
  // a per-share price, so the column read $0. We read the explicit F7 fields and
  // only fall back to the legacy per-share estimate if they aren't present yet.
  const unclaimedYieldUsd =
    f7.unclaimedRewardsUsd !== undefined
      ? f7.unclaimedRewardsUsd
      : usdPerShare !== undefined
        ? Number(position.claimableYield) * usdPerShare
        : undefined;

  // Per-asset breakdown of the unclaimed yield. Prefer the real raw reward
  // amounts (USDC 6dec, WHBAR 8dec) converted to human units; fall back to the
  // legacy per-share estimate when the F7 raw fields aren't available.
  const unclaimedUsdc =
    f7.unclaimedRewardsRaw !== undefined
      ? Number(f7.unclaimedRewardsRaw.usdc) / 10 ** USDC_DECIMALS
      : usdcPerShare !== undefined
        ? Number(position.claimableYield) * usdcPerShare
        : undefined;
  const unclaimedWhbar =
    f7.unclaimedRewardsRaw !== undefined
      ? Number(f7.unclaimedRewardsRaw.whbar) / 10 ** WHBAR_DECIMALS
      : whbarPerShare !== undefined
        ? Number(position.claimableYield) * whbarPerShare
        : undefined;

  return {
    rows,
    totals: {
      portfolioUsd,
      ptRaw: position.pt,
      ytRaw: position.yt,
      lpRaw: position.lp,
      ptUsd,
      ytUsd,
      lpUsd,
      ptPayoutUsd,
      unclaimedYieldUsd,
      unclaimedUsdc,
      unclaimedWhbar,
    },
  };
}

function formatRaw(v: bigint, decimals: number): string {
  // DECIMALS-01 (2026-05-30): the position table only holds the protocol's
  // SY/PT/YT/LP tokens, which declare decimals()=18. We render them with the
  // shared `formatCompact`, which now shows the CANONICAL 18-decimal value
  // (raw / 1e18) so a balance reconciles 1:1 with what HashPack / MetaMask /
  // HashScan display. `decimals` is always 18 for these tokens; formatCompact
  // applies the divisor internally.
  void decimals;
  return formatCompact(v);
}
