"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useChainId } from "wagmi";
import { useWalletAdapter } from "@/lib/hedera-wallet/adapter";
import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";
import { WalletGate } from "@/components/WalletGate";
import { ApprovalsCard } from "@/components/profile/ApprovalsCard";
import { useCachedMarkets } from "@/hooks/useCachedMarkets";
import { useMarketDetail, useUserPosition, type MarketDetail } from "@/hooks/useMarket";
import { useSyValueUsd, formatUsd } from "@/hooks/useSyValueUsd";
import { useWatchlist } from "@/hooks/useWatchlist";
import { impliedApyPct, daysUntil, formatCompact } from "@/hooks/useMarkets";
import { ptToSyRate, ytToSyRate, type UserPosition } from "@/components/MarketPositionCard";
import { getMarketDisplay } from "@/lib/markets-metadata";

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
  symbol: string;
  kind: PosKind;
  amountRaw: bigint;
  /** Decimals for the token represented by `amountRaw` (used to format the display). */
  decimals: number;
  costBasisSy: number;
  currentValueSy: number;
  unrealisedSy: number;
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
      if (t.ptPayoutUsd !== undefined)
        ptPayoutUsd = (ptPayoutUsd ?? 0) + t.ptPayoutUsd;
      if (t.unclaimedYieldUsd !== undefined)
        unclaimedYieldUsd = (unclaimedYieldUsd ?? 0) + t.unclaimedYieldUsd;
      if (t.unclaimedUsdc !== undefined)
        unclaimedUsdc = (unclaimedUsdc ?? 0) + t.unclaimedUsdc;
      if (t.unclaimedWhbar !== undefined)
        unclaimedWhbar = (unclaimedWhbar ?? 0) + t.unclaimedWhbar;
    }

    return { portfolioUsd, ptRaw, ytRaw, lpRaw, ptPayoutUsd, unclaimedYieldUsd, unclaimedUsdc, unclaimedWhbar };
  }, [totalsByMarket]);

  return (
    <div className="mx-auto max-w-[1440px] px-4 sm:px-6 md:px-7">
      <ProfileHead address={address} accountId={adapter.accountId ?? null} disconnect={adapter.disconnect} />

      <KpiStrip totals={totals} />

      <div className="mb-12 grid gap-8 sm:mb-16 lg:grid-cols-[1fr_320px]">
        {/* left — tabs + positions table */}
        <div className="min-w-0">
          <PositionsSection rows={allRows} />
        </div>

        {/* right — sidebars */}
        <aside className="flex flex-col gap-6">
          <PendingClaimsCard
            unclaimedYieldUsd={totals.unclaimedYieldUsd}
            unclaimedUsdc={totals.unclaimedUsdc}
            unclaimedWhbar={totals.unclaimedWhbar}
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
        value={formatCompact(totals.ptRaw)}
        sub={
          totals.ptPayoutUsd !== undefined
            ? `≈ ${formatUsd(totals.ptPayoutUsd) ?? "—"} at maturity`
            : "—"
        }
      />
      <Kpi
        label="YT · active stream"
        value={formatCompact(totals.ytRaw)}
        sub={
          totals.unclaimedYieldUsd !== undefined
            ? `${formatUsd(totals.unclaimedYieldUsd) ?? "$0.00"} unclaimed`
            : "—"
        }
      />
      <Kpi label="LP · provided" value={formatCompact(totals.lpRaw)} sub="$— fees earned" />
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

function PositionsSection({ rows }: { rows: PortfolioRow[] }) {
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
            filtered.map((r, i) => <PositionRow key={`${r.market}-${r.kind}-${i}`} row={r} />)
          )}
        </tbody>
        </table>
      </div>
    </div>
  );
}

function PositionRow({ row }: { row: PortfolioRow }) {
  // Per-kind action set per the spec. All actions deep-link to the strategy
  // sub-pages so they reuse existing forms — REDEEM is disabled pre-maturity.
  const base = `/markets/${row.market}`;
  interface RowAction {
    label: string;
    href: string;
    pri?: boolean;
    disabled?: boolean;
  }
  const actions: RowAction[] =
    row.kind === "SY"
      ? [
          // Sell SY → HBAR via FissionUnzap.unzapSy. The /sy page wraps it.
          { label: "Sell to HBAR", href: `${base}/sy`, pri: true },
        ]
      : row.kind === "PT"
        ? [
            { label: "Sell", href: `${base}/pt` },
            { label: "Redeem", href: base, pri: true, disabled: !row.expired },
          ]
        : row.kind === "YT"
          ? [
              { label: "Sell", href: `${base}/yt` },
              { label: "Claim", href: base, pri: true },
            ]
          : [
              { label: "Add", href: `${base}/lp` },
              { label: "Remove", href: `${base}/lp`, pri: true },
            ];

  const unrealisedColor =
    row.unrealisedSy > 0 ? "text-white" : row.unrealisedSy < 0 ? "text-error" : "text-textSec";

  return (
    <tr className="border-b border-border last:border-b-0">
      <PosTd>{row.symbol}</PosTd>
      <PosTd>
        <span className="font-mono text-[11.5px] uppercase tracking-[0.14em] text-white">
          {row.kind}
        </span>
      </PosTd>
      <PosNum>{formatRaw(row.amountRaw, row.decimals)}</PosNum>
      <PosNum>{row.costBasisSy.toFixed(4)} SY</PosNum>
      <PosNum>{row.currentValueSy.toFixed(4)} SY</PosNum>
      <PosNum>
        <span className={unrealisedColor}>
          {row.unrealisedOverride
            ? row.unrealisedOverride
            : `${row.unrealisedSy >= 0 ? "+" : ""}${row.unrealisedSy.toFixed(4)} SY`}
        </span>
      </PosNum>
      <PosNum dim={row.maturity.never}>{row.maturity.never ? "never" : `${row.maturity.days}d`}</PosNum>
      <PosTd>
        <div className="flex justify-end gap-1.5">
          {actions.map((a) =>
            a.disabled ? (
              <span
                key={a.label}
                className="cursor-not-allowed border border-border bg-white/[0.02] px-3 py-1.5 font-mono text-[10.5px] uppercase tracking-[0.14em] text-textDim/60"
              >
                {a.label}
              </span>
            ) : (
              <Link
                key={a.label}
                href={a.href}
                className={`border px-3 py-1.5 font-mono text-[10.5px] uppercase tracking-[0.14em] transition ${
                  a.pri
                    ? "border-white bg-white text-black hover:bg-white/85"
                    : "border-borderHover bg-white/[0.04] text-textSec hover:bg-white/[0.06] hover:text-white"
                }`}
              >
                {a.label}
              </Link>
            ),
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
}: {
  unclaimedYieldUsd: number | undefined;
  unclaimedUsdc: number | undefined;
  unclaimedWhbar: number | undefined;
}) {
  // Yield is paid in SY shares; at claim time those decompose into the SY's
  // underlying V3 LP balance (USDC + WHBAR). We show the equivalent each
  // would yield right now, derived from the V3 NFT amounts / total supply.
  const fmtTok = (n: number | undefined, decimals: number): string => {
    if (n === undefined) return "—";
    if (n === 0) return "0";
    if (n < 0.0001) return n.toExponential(2);
    return n.toFixed(decimals);
  };
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
        <Link
          href="#"
          className="mt-3 inline-flex w-full justify-center border border-white bg-white px-4 py-2.5 font-mono text-[12px] font-semibold uppercase tracking-[0.14em] text-black transition hover:bg-white/85"
        >
          Claim All
        </Link>
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

  const [entries, setEntries] = useState<ActivityEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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
          if (!cancelled) setError(`api_${r.status}`);
          return;
        }
        const j = (await r.json()) as { entries?: ActivityEntry[] };
        if (!cancelled) setEntries(j.entries ?? []);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "fetch_failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userEvm, accountId]);

  return (
    <div>
      <h4 className="mb-3.5 font-mono text-[10.5px] uppercase tracking-[0.2em] text-textDim">
        // recent_activity
      </h4>
      <div className="flex flex-col gap-px border border-border bg-border">
        {error ? (
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

  // SY-units valuations. We use raw bigint → Number with a 1e18 / decimals
  // round-trip ONLY for the cost-basis / current-value columns (UI-only), so
  // float precision at the cent level is fine.
  const dec = detail.syDecimals || 18;
  const div = 10 ** dec;

  const rows: PortfolioRow[] = [];

  // SY row — loose SY balance in wallet (not in LP, not split into PT/YT).
  // Value 1:1 in SY by definition. Surfaced so users can see + redeem to
  // HBAR (or use as input to Buy PT / YT / LP) instead of leaving it dust.
  if (position.sy > 0n) {
    const sySy = Number(position.sy) / div;
    rows.push({
      market,
      symbol,
      kind: "SY",
      amountRaw: position.sy,
      decimals: dec,
      costBasisSy: sySy,
      currentValueSy: sySy,
      unrealisedSy: 0,
      maturity: { days: 0, never: true },
      expired,
    });
  }

  // PT row — mark-to-AMM today vs. par at maturity (1 PT → 1 SY).
  if (position.pt > 0n) {
    const ptCount = Number(position.pt) / div;
    const currentSy = ptCount * ptRate;
    const projectedSy = ptCount; // pays 1:1 in SY at maturity
    const unrealisedSy = projectedSy - currentSy;
    rows.push({
      market,
      symbol,
      kind: "PT",
      amountRaw: position.pt,
      decimals: dec,
      costBasisSy: currentSy,
      currentValueSy: currentSy,
      unrealisedSy: unrealisedSy,
      maturity: { days, never: false },
      expired,
    });
  }

  // YT row — value decays to 0 at maturity. Claimable yield gets its own
  // override on the unrealised column so the user sees the $-equivalent.
  if (position.yt > 0n || position.claimableYield > 0n) {
    const ytCount = Number(position.yt) / div;
    const currentSy = ytCount * ytRate;
    const claimableSy = Number(position.claimableYield) / div;
    const usdClaim =
      usdPerShare !== undefined
        ? Number(position.claimableYield) * usdPerShare
        : undefined;
    rows.push({
      market,
      symbol,
      kind: "YT",
      amountRaw: position.yt,
      decimals: dec,
      costBasisSy: currentSy,
      currentValueSy: currentSy,
      unrealisedSy: claimableSy,
      unrealisedOverride: formatUsd(usdClaim)
        ? `${formatUsd(usdClaim)} unclaimed`
        : `${claimableSy.toFixed(4)} SY unclaimed`,
      maturity: { days, never: true },
      expired,
    });
  }

  // LP row — pro-rata composition. PT leg discounts via ptRate; SY leg is par.
  if (position.lp > 0n && detail.lpSupply > 0n) {
    const lpCount = Number(position.lp) / div;
    const userPtInLp = (Number(position.lp) * Number(detail.totalPt)) / Number(detail.lpSupply);
    const userSyInLp = (Number(position.lp) * Number(detail.totalSy)) / Number(detail.lpSupply);
    const currentSy = (userPtInLp * ptRate + userSyInLp) / div;
    const parSy = (userPtInLp + userSyInLp) / div;
    rows.push({
      market,
      symbol,
      kind: "LP",
      amountRaw: position.lp,
      decimals: dec,
      costBasisSy: currentSy,
      currentValueSy: currentSy,
      unrealisedSy: parSy - currentSy,
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
  const unclaimedYieldUsd =
    usdPerShare !== undefined
      ? Number(position.claimableYield) * usdPerShare
      : undefined;
  // Per-asset breakdown of the unclaimed yield — what redeeming this SY
  // amount through the V3 LP would land in the user's wallet.
  const unclaimedUsdc =
    usdcPerShare !== undefined
      ? Number(position.claimableYield) * usdcPerShare
      : undefined;
  const unclaimedWhbar =
    whbarPerShare !== undefined
      ? Number(position.claimableYield) * whbarPerShare
      : undefined;

  return {
    rows,
    totals: {
      portfolioUsd,
      ptRaw: position.pt,
      ytRaw: position.yt,
      lpRaw: position.lp,
      ptPayoutUsd,
      unclaimedYieldUsd,
      unclaimedUsdc,
      unclaimedWhbar,
    },
  };
}

function formatRaw(v: bigint, decimals: number): string {
  // Divide by the token's declared decimals so the table shows a human-readable
  // count (the template renders "52.4100"). For very large or very small magnitudes
  // we fall back to the compact bucket formatter so the column never overflows.
  if (v === 0n) return "0.0000";
  const div = 10 ** decimals;
  const n = Number(v) / div;
  if (!Number.isFinite(n)) return formatCompact(v);
  if (n >= 1e9) return formatCompact(v);
  if (n >= 1) return n.toFixed(4);
  if (n >= 0.0001) return n.toFixed(6);
  return n.toExponential(2);
}
