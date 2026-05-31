"use client";

import { useCallback, useEffect, useState } from "react";
import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";

type Row = {
  rank: number;
  account_id: string;
  total_xp: number;
  level: number;
  action_count: number;
  last_event_at: string | null;
};

type Resp = {
  rows: Row[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

export default function LeaderboardPage() {
  return (
    <main className="min-h-screen text-text">
      <Nav />
      <LeaderboardBody />
      <Footer />
    </main>
  );
}

function fmtAge(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function LeaderboardBody() {
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (p: number) => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/xp/leaderboard?page=${p}`, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json: Resp = await r.json();
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(page);
  }, [page, load]);

  const totalPages = data?.totalPages ?? 1;
  const total = data?.total ?? 0;
  const rows = data?.rows ?? [];

  return (
    <div className="mx-auto max-w-[1100px] px-4 py-10 sm:px-6">
      {/* breadcrumb / headline */}
      <div className="mb-1 font-mono text-[11px] uppercase tracking-[0.18em] text-textDim">
        protocol / leaderboard
      </div>
      <h1 className="text-[26px] font-semibold leading-tight text-text">Leaderboard</h1>
      <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-textSec">
        Top users ranked by XP. Every point is earned from verified on-chain activity —
        trading, providing liquidity, splitting/merging, and redeeming. Team wallets are
        excluded. Updates every couple of minutes.
      </p>

      {/* stats strip */}
      <div className="mt-5 flex flex-wrap items-center gap-2 font-mono text-[11px] text-textSec">
        <span className="inline-flex items-center gap-2 rounded-[2px] border border-border px-2.5 py-1.5">
          <span className="term-pulse-dot inline-block size-[6px] rounded-full bg-white" />
          {total} ranked {total === 1 ? "user" : "users"}
        </span>
        <span className="rounded-[2px] border border-border px-2.5 py-1.5">top 1,000 shown</span>
      </div>

      {/* table */}
      <div className="mt-5 overflow-hidden rounded-[6px] border border-border bg-bgCard">
        <div className="grid grid-cols-[64px_1fr_84px_120px_96px] gap-2 border-b border-border bg-white/[0.02] px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.14em] text-textDim">
          <div>Rank</div>
          <div>Account</div>
          <div className="text-center">Level</div>
          <div className="text-right">XP</div>
          <div className="text-right">Actions</div>
        </div>

        {loading ? (
          <div className="px-4 py-12 text-center font-mono text-[12px] text-textDim">Loading…</div>
        ) : error ? (
          <div className="px-4 py-12 text-center font-mono text-[12px] text-error">
            Failed to load leaderboard ({error})
          </div>
        ) : rows.length === 0 ? (
          <div className="px-4 py-12 text-center font-mono text-[12px] text-textDim">
            No ranked users yet — be the first to earn XP.
          </div>
        ) : (
          rows.map((r) => (
            <a
              key={r.account_id}
              href={`https://hashscan.io/mainnet/account/${r.account_id}`}
              target="_blank"
              rel="noreferrer"
              className="grid grid-cols-[64px_1fr_84px_120px_96px] items-center gap-2 border-b border-border/60 px-4 py-3 text-[13px] transition last:border-b-0 hover:bg-white/[0.03]"
            >
              <div className="font-mono text-textSec">
                {r.rank <= 3 ? (
                  <span className="text-white">#{r.rank}</span>
                ) : (
                  <span>#{r.rank}</span>
                )}
              </div>
              <div className="truncate font-mono text-text">{r.account_id}</div>
              <div className="text-center">
                <span className="inline-block rounded-[2px] border border-borderHover bg-white/[0.05] px-2 py-0.5 font-mono text-[11px] text-text">
                  L{r.level}
                </span>
              </div>
              <div className="text-right font-mono font-semibold text-text">
                {r.total_xp.toLocaleString()}
              </div>
              <div className="text-right font-mono text-textSec">
                {r.action_count.toLocaleString()}
                <span className="ml-1.5 text-[10px] text-textDim">· {fmtAge(r.last_event_at)}</span>
              </div>
            </a>
          ))
        )}
      </div>

      {/* pagination */}
      <div className="mt-4 flex items-center justify-between font-mono text-[12px] text-textSec">
        <button
          type="button"
          onClick={() => setPage((p) => Math.max(1, p - 1))}
          disabled={loading || page <= 1}
          className="rounded-[2px] border border-border px-3 py-1.5 transition hover:bg-white/[0.04] disabled:cursor-not-allowed disabled:opacity-40"
        >
          ← Prev
        </button>
        <span className="text-textDim">
          Page {data?.page ?? page} of {totalPages}
        </span>
        <button
          type="button"
          onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          disabled={loading || page >= totalPages}
          className="rounded-[2px] border border-border px-3 py-1.5 transition hover:bg-white/[0.04] disabled:cursor-not-allowed disabled:opacity-40"
        >
          Next →
        </button>
      </div>
    </div>
  );
}
