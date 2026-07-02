// useHbarBalance — the connected account's native HBAR balance, in whole HBAR.
//
// Purpose: the buy flows send `input + 5 HBAR NPM fee + gas` as the payer
// amount, but only the input was ever validated — so an under-funded wallet
// sailed past the UI and hit HashPack's cryptic INSUFFICIENT_PAYER_BALANCE at
// the zap step. This hook lets the forms warn up-front with the REAL number.
//
// FAIL-OPEN by contract: returns `undefined` while loading, on any fetch/parse
// error, or on an implausible value. Callers must treat `undefined` as "unknown
// — do not block". Only a confidently-read, plausible balance is a number.
"use client";

import { useEffect, useState } from "react";

const MIRROR = "https://mainnet-public.mirrornode.hedera.com/api/v1"; // account balances

/**
 * @param idOrAddress Hedera account id (0.0.x) OR EVM address — the mirror node
 *        resolves either. Pass the connected wallet's accountId (preferred) or
 *        its 0x address. `null`/`undefined` → hook idles and returns undefined.
 */
export function useHbarBalance(idOrAddress: string | null | undefined): number | undefined {
  const [hbar, setHbar] = useState<number | undefined>(undefined);

  useEffect(() => {
    if (!idOrAddress) {
      setHbar(undefined);
      return;
    }
    let cancelled = false;

    const read = async () => {
      try {
        const res = await fetch(`${MIRROR}/accounts/${idOrAddress}?limit=1`, {
          headers: { Accept: "application/json" },
        });
        if (!res.ok) throw new Error(`mirror ${res.status}`);
        const data = (await res.json()) as { balance?: { balance?: number } };
        const tinybars = data?.balance?.balance;
        // Guard: must be a finite, non-negative number. Anything else → unknown.
        if (typeof tinybars !== "number" || !Number.isFinite(tinybars) || tinybars < 0) {
          if (!cancelled) setHbar(undefined);
          return;
        }
        // tinybars → HBAR (1 HBAR = 1e8 tinybars).
        if (!cancelled) setHbar(tinybars / 1e8);
      } catch {
        // Fail-open: unknown balance, never block.
        if (!cancelled) setHbar(undefined);
      }
    };

    void read();
    // Refresh periodically so the warning clears after the user tops up.
    const t = setInterval(read, 15_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [idOrAddress]);

  return hbar;
}
