"use client";

/**
 * AssociationGate — UX wrapper that ensures the connected Hedera wallet
 * has associated every HTS token that an upcoming contract call will
 * try to deliver to them. Without this, the contract reverts with HTS
 * code 184 (`TOKEN_NOT_ASSOCIATED_TO_ACCOUNT`) and the user sees a
 * cryptic "execution failed" error.
 *
 * Behaviour:
 *   - In Hedera-native mode, we query Mirror Node for missing
 *     associations among `requiredTokens`. If any are missing, we
 *     render a single "Associate token(s)" button that batches them
 *     all into ONE `TokenAssociateTransaction` (one wallet prompt).
 *     On success the gate transparently un-mounts and renders
 *     `children`.
 *   - In EVM mode (wagmi / MetaMask via Hashio), most accounts get
 *     HIP-904 unlimited associations, but an ECDSA account imported
 *     into MetaMask with `max_automatic_token_associations: 0` can buy
 *     yet cannot RECEIVE an un-associated token — and MetaMask cannot
 *     submit a Hedera associate tx. So we still CHECK (resolving the
 *     account's evm_address via Mirror — which the /accounts and
 *     /accounts/{id}/tokens endpoints both accept) and, when something
 *     is missing, BLOCK with an actionable message instead of silently
 *     letting the delivery revert TOKEN_NOT_ASSOCIATED at consensus.
 *
 * Why batch and not per-token: HashPack signs `setTokenIds([...])` in
 * one prompt and Hedera charges $0.05/token-association regardless of
 * batching — so we save the user N-1 popups.
 */

import { useCallback, useEffect, useState } from "react";
import { useWalletAdapter } from "@/lib/hedera-wallet/adapter";
import { useHederaWallet } from "@/lib/hedera-wallet/provider";
import {
  associateTokens,
  evmAddressToTokenId,
  getMissingAssociations,
} from "@/lib/hedera-wallet/associations";
import { diag } from "@/lib/diag";

export interface AssociationGateProps {
  /**
   * EVM long-zero addresses of HTS tokens the next call will deliver.
   * The gate converts them to `0.0.NUM` form internally.
   */
  requiredTokens: `0x${string}`[];
  /**
   * Optional human-readable label per token (same order as `requiredTokens`),
   * shown in the prompt body so the user knows what they're approving.
   * Falls back to the token ID.
   */
  tokenLabels?: string[];
  /**
   * Optional reason shown above the button — e.g. "to receive SY shares".
   */
  reason?: string;
  children: React.ReactNode;
}

export function AssociationGate({
  requiredTokens,
  tokenLabels,
  reason,
  children,
}: AssociationGateProps) {
  const adapter = useWalletAdapter();
  const hedera = useHederaWallet();
  const [missing, setMissing] = useState<string[] | null>(null);
  const [isChecking, setIsChecking] = useState(true);
  const [isAssociating, setIsAssociating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accountId = adapter.accountId;
  const mode = adapter.mode;
  // EVM mode resolves the account via its evm_address (Mirror accepts it in the
  // /accounts and /accounts/{id}/tokens paths). Hedera mode uses the 0.0.X id.
  const lookupId = mode === "hedera" ? accountId : adapter.address;

  // Convert long-zero EVM addresses to "0.0.X" once per change.
  const tokenIds = requiredTokens.map((a) => {
    try {
      return evmAddressToTokenId(a);
    } catch {
      return null;
    }
  });
  const validTokenIds = tokenIds.filter((t): t is string => t !== null);

  // Build label map for display.
  const labelFor = (tid: string): string => {
    const idx = tokenIds.indexOf(tid);
    return tokenLabels?.[idx] ?? tid;
  };

  const runCheck = useCallback(async () => {
    if ((mode !== "hedera" && mode !== "evm") || !lookupId) {
      setMissing([]);
      setIsChecking(false);
      return;
    }
    if (validTokenIds.length === 0) {
      setMissing([]);
      setIsChecking(false);
      return;
    }
    setIsChecking(true);
    try {
      const miss = await getMissingAssociations(lookupId, validTokenIds);
      diag("AssociationGate", { step: "check_done", lookupId, mode, required: validTokenIds, missing: miss });
      setMissing(miss);
    } catch (e) {
      diag("AssociationGate", { step: "check_error", error: e instanceof Error ? e.message : String(e) });
      // On query error, surface a soft warning but let the user proceed —
      // the contract will revert clearly if anything is genuinely missing.
      setMissing([]);
    } finally {
      setIsChecking(false);
    }
    // We intentionally serialize tokenIds via .join to keep the dep array
    // stable across array-identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, lookupId, validTokenIds.join("|")]);

  useEffect(() => {
    runCheck();
  }, [runCheck]);

  const onAssociate = async () => {
    if (!accountId || !missing || missing.length === 0) return;
    setError(null);
    setIsAssociating(true);
    diag("AssociationGate", { step: "associate_click", tokens: missing });
    try {
      let txId: string;
      try {
        txId = await associateTokens(hedera.getConnector(), accountId, missing);
      } catch (assocErr) {
        const am = assocErr instanceof Error ? assocErr.message : String(assocErr);
        if (/record was recently deleted|no matching key|session topic|not initialized|missing or invalid/i.test(am)) {
          await hedera.refreshConnector();
          txId = await associateTokens(hedera.getConnector(), accountId, missing);
        } else {
          throw assocErr;
        }
      }
      diag("AssociationGate", { step: "associate_success", txId });
      // Re-check rather than optimistic-assume — Mirror Node is the source
      // of truth and usually lags receipt by <1s but can spike.
      await new Promise((r) => setTimeout(r, 1500));
      await runCheck();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      diag("AssociationGate", { step: "associate_error", error: msg });
      setError(msg);
    } finally {
      setIsAssociating(false);
    }
  };

  // Not connected (no mode / no resolvable account) or no tokens needed →
  // pass through immediately. We also pass through on first-render before the
  // async check resolves, but hide the children behind a skeleton-style
  // placeholder so the user doesn't click "Mint" and immediately get the
  // association banner afterwards.
  if ((mode !== "hedera" && mode !== "evm") || !lookupId || validTokenIds.length === 0) {
    return <>{children}</>;
  }

  if (isChecking && missing === null) {
    return (
      <div className="rounded-2xl border border-border bg-bgCard p-4">
        <div className="h-32 animate-pulse rounded-lg bg-white/[0.03]" />
      </div>
    );
  }

  if (!missing || missing.length === 0) {
    return <>{children}</>;
  }

  // EVM mode (MetaMask via Hashio): we found a missing association but MetaMask
  // CANNOT submit a Hedera TokenAssociateTransaction. Rather than letting the
  // delivery revert TOKEN_NOT_ASSOCIATED at consensus, block here with an
  // actionable message. (Common path is HIP-904 unlimited → no block at all.)
  if (mode === "evm") {
    return (
      <div className="rounded-2xl border border-warning/30 bg-warning/[0.06] p-4">
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-[2px] text-warning">
          One-time token setup
        </div>
        <p className="mb-3 text-[13px] leading-relaxed text-text">
          Your account hasn&apos;t associated {missing.length === 1 ? "this token" : "these tokens"} yet
          {reason ? ` ${reason}` : ""}. MetaMask can&apos;t associate Hedera tokens — enable unlimited
          auto-association on your account, or associate {missing.length === 1 ? "it" : "them"} first
          (e.g. in HashPack), then reload.
        </p>

        <ul className="space-y-1.5 rounded-lg border border-warning/20 bg-white/[0.02] p-3">
          {missing.map((tid) => (
            <li key={tid} className="flex items-center justify-between font-mono text-[11px]">
              <span className="text-textSec">{labelFor(tid)}</span>
              <a
                href={`https://hashscan.io/mainnet/token/${tid}`}
                target="_blank"
                rel="noreferrer"
                className="text-textDim underline-offset-2 hover:underline hover:text-textSec"
              >
                {tid}
              </a>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-warning/30 bg-warning/[0.06] p-4">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-[2px] text-warning">
        One-time token setup
      </div>
      <p className="mb-3 text-[13px] leading-relaxed text-text">
        Your wallet hasn&apos;t associated {missing.length === 1 ? "this token" : "these tokens"} yet
        {reason ? ` ${reason}` : ""}. Hedera requires a one-time on-chain association before any contract can transfer HTS tokens to you.
      </p>

      <ul className="mb-4 space-y-1.5 rounded-lg border border-warning/20 bg-white/[0.02] p-3">
        {missing.map((tid) => (
          <li key={tid} className="flex items-center justify-between font-mono text-[11px]">
            <span className="text-textSec">{labelFor(tid)}</span>
            <a
              href={`https://hashscan.io/mainnet/token/${tid}`}
              target="_blank"
              rel="noreferrer"
              className="text-textDim underline-offset-2 hover:underline hover:text-textSec"
            >
              {tid}
            </a>
          </li>
        ))}
      </ul>

      <button
        type="button"
        onClick={onAssociate}
        disabled={isAssociating}
        className="w-full rounded-[10px] bg-white px-7 py-3.5 text-sm font-semibold text-bg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isAssociating
          ? "Sign in HashPack…"
          : missing.length === 1
            ? "Associate token"
            : `Associate ${missing.length} tokens`}
      </button>

      <p className="mt-2 text-[10px] leading-relaxed text-textDim">
        Costs about ${(0.05 * missing.length).toFixed(2)} in HBAR. One wallet popup for all {missing.length === 1 ? "token" : "tokens"}.
      </p>

      {error && (
        <div className="mt-3 rounded-lg border border-error/30 bg-error/10 px-3 py-2.5 text-[12px] leading-relaxed text-error">
          <div className="font-mono text-[10px] uppercase tracking-[1.5px]">Association failed</div>
          <div className="mt-1 break-words font-mono">{error.slice(0, 240)}</div>
        </div>
      )}
    </div>
  );
}
