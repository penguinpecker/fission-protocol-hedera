// useSiweAuth — bridges the wallet adapter to a server-side session.
//
// Two flows, routed by the adapter's mode:
//
//   mode: "evm"     → standard SIWE / EIP-191. Message built via siwe lib,
//                     signed via wagmi.signMessageAsync, posted to
//                     /api/auth/verify with {mode:"eip191", message, signature}.
//
//   mode: "hedera"  → Hedera-native. Message built as plain text with the
//                     SAME embedded `Nonce: <hex>` line so the server reuses
//                     auth_nonces unchanged. Signed via the DAppConnector's
//                     hedera_signMessage, posted to /api/auth/verify with
//                     {mode:"hedera", accountId, message, signatureMap}.
//
// Both flows ultimately set the same httpOnly session cookie keyed by
// lowercased EVM-style address (long-zero for Hedera-native users).

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SiweMessage } from "siwe";
import { useWalletAdapter } from "@/lib/hedera-wallet/adapter";

export type SiweAuthState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "authenticated"; address: `0x${string}` }
  | { status: "error"; error: string };

export function useSiweAuth() {
  const adapter = useWalletAdapter();
  const [state, setState] = useState<SiweAuthState>({ status: "idle" });

  // Probe the server for an existing session on mount and whenever the
  // connected wallet changes.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/me", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        if (data && typeof data.address === "string" && /^0x[a-f0-9]{40}$/.test(data.address)) {
          setState({ status: "authenticated", address: data.address as `0x${string}` });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [adapter.isConnected, adapter.address]);

  // Wallet disconnect or address change → clear server session.
  //
  // Tracks the previous `isConnected` state to distinguish a real
  // disconnect event ("was connected, now isn't") from the initial render
  // where `adapter.isConnected` is `false` purely because the Hedera
  // provider hasn't had a chance to restore its persisted WC session yet.
  // Without this guard, the SIWE cookie gets logged out on every refresh
  // before the wallet finishes restoring, and the user sees a Sign-In
  // prompt despite having a valid 7-day session.
  const prevConnectedRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (state.status !== "authenticated") {
      prevConnectedRef.current = adapter.isConnected;
      return;
    }
    const wasConnected = prevConnectedRef.current;
    prevConnectedRef.current = adapter.isConnected;

    // Real disconnect = previously saw `isConnected=true`, now `false`.
    if (wasConnected === true && !adapter.isConnected) {
      void fetch("/api/auth/logout", { method: "POST", credentials: "include" });
      setState({ status: "idle" });
      return;
    }
    // Address change = wallet switched accounts, kick the cookie.
    if (
      adapter.address &&
      adapter.address.toLowerCase() !== state.address.toLowerCase()
    ) {
      void fetch("/api/auth/logout", { method: "POST", credentials: "include" });
      setState({ status: "idle" });
    }
  }, [adapter.address, adapter.isConnected, state]);

  const signIn = useCallback(async () => {
    if (!adapter.isConnected || !adapter.address) {
      setState({ status: "error", error: "wallet_not_connected" });
      return;
    }
    setState({ status: "loading" });
    try {
      // Step 1: nonce keyed by the wallet's lowercased address. For Hedera
      // mode the long-zero EVM address is used here AND on the server when
      // it consumes the nonce — matching keys.
      const noncedFor = adapter.address.toLowerCase();
      const nonceRes = await fetch("/api/auth/nonce", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: noncedFor }),
        credentials: "include",
      });
      if (!nonceRes.ok) throw new Error("nonce_failed");
      const { nonce } = (await nonceRes.json()) as { nonce: string };

      // Step 2: build the message + sign. Different message shape per mode
      // (SIWE for EVM, plain text for Hedera) but both carry a Nonce: line.
      let verifyBody: Record<string, unknown>;
      if (adapter.mode === "evm") {
        const message = new SiweMessage({
          domain: window.location.host,
          address: adapter.address,
          statement: "Sign in to Fission Protocol",
          uri: window.location.origin,
          version: "1",
          chainId: adapter.chainId ?? 295,
          nonce,
          issuedAt: new Date().toISOString(),
        }).prepareMessage();

        const signed = await adapter.signMessage(message);
        if (signed.format !== "eip191") throw new Error("expected_eip191_signature");
        verifyBody = { mode: "eip191", message, signature: signed.signature };
      } else if (adapter.mode === "hedera") {
        const message = [
          `${window.location.host} wants you to sign in with your Hedera account:`,
          adapter.accountId ?? "?",
          ``,
          `Sign in to Fission Protocol`,
          ``,
          `URI: ${window.location.origin}`,
          `Version: 1`,
          `Chain ID: 295`,
          `Nonce: ${nonce}`,
          `Issued At: ${new Date().toISOString()}`,
        ].join("\n");

        const signed = await adapter.signMessage(message);
        if (signed.format !== "hedera") throw new Error("expected_hedera_signature");
        verifyBody = {
          mode: "hedera",
          accountId: signed.accountId,
          message,
          signatureMap: signed.signatureMap,
        };
      } else {
        throw new Error("wallet_not_connected");
      }

      // Step 3: verify.
      const verifyRes = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(verifyBody),
        credentials: "include",
      });
      if (!verifyRes.ok) {
        const j = await verifyRes.json().catch(() => ({}));
        const j2 = j as { error?: string; expected?: string; gotInMessage?: string; detail?: string };
        const parts = [
          j2.error ?? `http_${verifyRes.status}`,
          j2.expected ? `expected=${j2.expected}` : null,
          j2.gotInMessage ? `got=${j2.gotInMessage}` : null,
          j2.detail ? `detail=${j2.detail.slice(0, 80)}` : null,
        ].filter(Boolean);
        throw new Error(parts.join(" · "));
      }
      setState({ status: "authenticated", address: adapter.address as `0x${string}` });
    } catch (e) {
      setState({ status: "error", error: e instanceof Error ? e.message : "unknown" });
    }
  }, [adapter]);

  const signOut = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    setState({ status: "idle" });
  }, []);

  return { state, signIn, signOut };
}
