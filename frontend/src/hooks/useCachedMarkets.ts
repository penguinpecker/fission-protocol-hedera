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
}

export function useCachedMarkets() {
  const [markets, setMarkets] = useState<CachedMarket[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/markets", { cache: "no-store" });
        if (!r.ok) throw new Error(`markets_${r.status}`);
        const j = (await r.json()) as { markets: CachedMarket[] };
        if (!cancelled) setMarkets(j.markets ?? []);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "unknown");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { markets, loading, error };
}
