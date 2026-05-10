// useSiweAuth — bridges wagmi's connected wallet to a server-side session.
//
// Flow on `signIn()`:
//   1. POST /api/auth/nonce { address }       → nonce
//   2. Build SIWE message with nonce, domain, chainId
//   3. wagmi's signMessageAsync prompts the wallet
//   4. POST /api/auth/verify { message, signature }
//        → server validates SIWE, sets httpOnly session cookie
//
// After signIn, all /api/* requests carry the cookie. Frontend can call
// /api/auth/me to confirm session, or just optimistically render the
// "authenticated" UI based on this hook's state.

"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount, useSignMessage } from "wagmi";
import { SiweMessage } from "siwe";

export type SiweAuthState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "authenticated"; address: `0x${string}` }
  | { status: "error"; error: string };

export function useSiweAuth() {
  const { address, chain, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [state, setState] = useState<SiweAuthState>({ status: "idle" });

  // Ask the server who we are (cookie-based) on mount AND whenever the wallet
  // connection state changes — keeps Nav and Profile instances in sync after
  // a successful sign-in even if they mounted before the cookie existed.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/me", { credentials: "include" })
      .then(r => (r.ok ? r.json() : null))
      .then(data => {
        if (cancelled) return;
        if (data && typeof data.address === "string" && /^0x[a-f0-9]{40}$/.test(data.address)) {
          setState({ status: "authenticated", address: data.address as `0x${string}` });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isConnected, address]);

  // Wallet disconnect or address change → clear server session.
  useEffect(() => {
    if (state.status !== "authenticated") return;
    if (!isConnected) {
      void fetch("/api/auth/logout", { method: "POST", credentials: "include" });
      setState({ status: "idle" });
      return;
    }
    if (address && address.toLowerCase() !== state.address.toLowerCase()) {
      void fetch("/api/auth/logout", { method: "POST", credentials: "include" });
      setState({ status: "idle" });
    }
  }, [address, isConnected, state]);

  const signIn = useCallback(async () => {
    if (!address || !isConnected) {
      setState({ status: "error", error: "wallet_not_connected" });
      return;
    }
    setState({ status: "loading" });
    try {
      const nonceRes = await fetch("/api/auth/nonce", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address }),
        credentials: "include",
      });
      if (!nonceRes.ok) throw new Error("nonce_failed");
      const { nonce } = (await nonceRes.json()) as { nonce: string };

      const message = new SiweMessage({
        domain: window.location.host,
        address,
        statement: "Sign in to Fission Protocol",
        uri: window.location.origin,
        version: "1",
        chainId: chain?.id ?? Number(process.env.NEXT_PUBLIC_HEDERA_CHAIN_ID ?? "295"),
        nonce,
        issuedAt: new Date().toISOString(),
      }).prepareMessage();

      const signature = await signMessageAsync({ message });

      const verifyRes = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, signature }),
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
      setState({ status: "authenticated", address: address as `0x${string}` });
    } catch (e) {
      setState({ status: "error", error: e instanceof Error ? e.message : "unknown" });
    }
  }, [address, chain?.id, isConnected, signMessageAsync]);

  const signOut = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    setState({ status: "idle" });
  }, []);

  return { state, signIn, signOut };
}
