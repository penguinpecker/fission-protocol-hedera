// Read pre-indexed market state from /api/markets (markets_cache table).
// Use this on list views to avoid per-page Hashio reads. The detail page
// continues to use on-chain reads via useMarket() for live state.

"use client";

import { useEffect, useState } from "react";

export interface CachedMarket {
  chain_id: number;
  market_address: `0x${string}`;
  market_type: "standard" | "rewards";
  factory_address: string;
  sy_address: `0x${string}`;
  pt_address: `0x${string}` | null;
  yt_address: `0x${string}` | null;
  lp_address: `0x${string}` | null;
  expiry: string | null;
  scalar_root_e18: string | null;
  total_pt: string | null;
  total_sy_shares: string | null;
  last_ln_implied_rate: string | null;
  lp_total_supply: string | null;
  initialized: boolean;
  last_synced: string;
  is_archived?: boolean;
  archived_reason?: string | null;
  archived_at?: string | null;
}

// Cache freshness window. Rows older than this are treated as missing so the
// caller falls through to a live wagmi multicall. Picked at 5 min as a sweet
// spot between "definitely current" and "cheap to serve". The Vercel cron
// only runs once a day on the Hobby plan, so without this guard any pool
// movement (addLiquidity, swap) silently lingered as stale TVL for hours.
const CACHE_TTL_MS = 5 * 60 * 1000;

export function useCachedMarkets(opts: { includeArchived?: boolean } = {}) {
  const [markets, setMarkets] = useState<CachedMarket[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const includeArchived = opts.includeArchived ?? false;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const url = includeArchived ? "/api/markets?includeArchived=1" : "/api/markets";
        const r = await fetch(url, { cache: "no-store" });
        if (!r.ok) throw new Error(`markets_${r.status}`);
        const j = (await r.json()) as { markets: CachedMarket[] };
        const all = j.markets ?? [];
        // Drop stale rows. If everything is stale the caller sees [] and
        // falls through to its on-chain wagmi multicall path.
        const now = Date.now();
        const fresh = all.filter((m) => {
          const ts = m.last_synced ? Date.parse(m.last_synced) : 0;
          return Number.isFinite(ts) && now - ts < CACHE_TTL_MS;
        });
        if (!cancelled) setMarkets(fresh);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "unknown");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [includeArchived]);

  return { markets, loading, error };
}
