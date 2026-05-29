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
// caller falls through to a live wagmi multicall.
//
// F9: this was 5 min, but the refresher (Vercel cron) only runs ONCE A DAY on
// the Hobby plan. With a 5-min window the cache rows were almost always older
// than the TTL, so every list view discarded the whole cache and fell through
// to a live Hashio multicall — the cached path was effectively dead. Matching
// the TTL to the actual refresh cadence (~24h, with a little slack) means a
// normally-refreshed row is accepted and served from cache, which is the point
// of the cache. Genuinely stale data (cron stalled for >25h) still falls
// through to on-chain, and an empty cache still triggers the on-chain fallback.
const CACHE_TTL_MS = 25 * 60 * 60 * 1000; // ~25h — one daily refresh + slack

// Below this age the cached headline numbers (APY/TVL/seed badge) are treated
// as "fresh enough" to present without a stale caveat. Above it they're still
// served — the cache is the point — but the list labels the row + freshness
// line as stale so the displayed age is honest. (MARKETS-LIST-25H-STALE)
//
// With the once-a-day Hobby cron the rows are normally OLDER than this, so the
// list will usually render as "stale". That's the truthful state; the detail
// and trade pages read live on-chain, so a user acting on a number always sees
// fresh data there. We intentionally do NOT fall back to an always-live
// multicall on the list (that was the dead-cache behavior F9 removed).
export const FRESH_THRESHOLD_MS = 10 * 60 * 1000; // 10 min

export function useCachedMarkets(opts: { includeArchived?: boolean } = {}) {
  const [markets, setMarkets] = useState<CachedMarket[] | null>(null);
  // Freshest `last_synced` across the returned rows, in epoch ms. null until
  // loaded or when no row carries a usable timestamp.
  const [lastSynced, setLastSynced] = useState<number | null>(null);
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
        let newest = 0;
        const fresh = all.filter((m) => {
          const ts = m.last_synced ? Date.parse(m.last_synced) : 0;
          if (!Number.isFinite(ts) || now - ts >= CACHE_TTL_MS) return false;
          if (ts > newest) newest = ts;
          return true;
        });
        if (!cancelled) {
          setMarkets(fresh);
          setLastSynced(newest > 0 ? newest : null);
        }
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

  // `stale` = the freshest cached row is older than the short threshold, so the
  // headline numbers are out of date relative to chain. Unknown timestamp is
  // treated as stale (conservative).
  const stale =
    lastSynced === null ? markets !== null && markets.length > 0 : Date.now() - lastSynced >= FRESH_THRESHOLD_MS;

  return { markets, loading, error, lastSynced, stale };
}
