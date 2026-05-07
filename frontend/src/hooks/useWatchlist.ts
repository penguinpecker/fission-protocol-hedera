// Read + toggle the signed-in user's market watchlist via /api/watchlists.
// Optimistic updates: state flips locally, then the API call lands.

"use client";

import { useCallback, useEffect, useState } from "react";

export interface WatchlistItem {
  chain_id: number;
  market_address: string;
  added_at: string;
}

export function useWatchlist() {
  const [items, setItems] = useState<WatchlistItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [signedIn, setSignedIn] = useState<boolean>(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/watchlists", { credentials: "include" });
      if (r.status === 401) {
        setSignedIn(false);
        setItems([]);
        return;
      }
      setSignedIn(true);
      if (!r.ok) return;
      const j = (await r.json()) as { watchlist: WatchlistItem[] };
      setItems(j.watchlist ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const isWatched = useCallback(
    (chainId: number, marketAddress: string) =>
      items.some(
        (i) =>
          i.chain_id === chainId &&
          i.market_address.toLowerCase() === marketAddress.toLowerCase(),
      ),
    [items],
  );

  const toggle = useCallback(
    async (chainId: number, marketAddress: string): Promise<boolean> => {
      const lower = marketAddress.toLowerCase();
      const watched = isWatched(chainId, lower);
      if (watched) {
        setItems((prev) =>
          prev.filter(
            (i) => !(i.chain_id === chainId && i.market_address.toLowerCase() === lower),
          ),
        );
        const r = await fetch(
          `/api/watchlists?chain_id=${chainId}&market_address=${lower}`,
          { method: "DELETE", credentials: "include" },
        );
        if (!r.ok) await refresh();
        return false;
      }
      setItems((prev) => [
        { chain_id: chainId, market_address: lower, added_at: new Date().toISOString() },
        ...prev,
      ]);
      const r = await fetch("/api/watchlists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ chain_id: chainId, market_address: lower }),
      });
      if (r.status === 401) setSignedIn(false);
      if (!r.ok) await refresh();
      return true;
    },
    [isWatched, refresh],
  );

  return { items, loading, signedIn, isWatched, toggle, refresh };
}
