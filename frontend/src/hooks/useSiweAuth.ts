// useSiweAuth — bridges wagmi's connected wallet to a Supabase auth session.
//
// Flow on `signIn()`:
//   1. POST /api/auth/nonce { address }  → nonce
//   2. Build SIWE message with nonce + domain + chainId
//   3. wagmi's signMessageAsync prompts the wallet
//   4. POST /api/auth/verify { message, signature } → { access_token, refresh_token, … }
//   5. supabase.auth.setSession({ access_token, refresh_token })
//
// After this, all supabase-js calls in the browser carry the user's JWT.
// RLS sees `auth.jwt() ->> 'sub'` == lowercased EVM address.

"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount, useSignMessage } from "wagmi";
import { SiweMessage } from "siwe";
import { createClient } from "@/lib/supabase/client";

export type SiweAuthState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "authenticated"; address: `0x${string}` }
  | { status: "error"; error: string };

export function useSiweAuth() {
  const { address, chain, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [state, setState] = useState<SiweAuthState>({ status: "idle" });

  // On mount, see if we already have a Supabase session.
  useEffect(() => {
    const supa = createClient();
    supa.auth.getSession().then(({ data }) => {
      const sub = data.session?.user?.id;
      if (sub && /^0x[a-f0-9]{40}$/.test(sub)) {
        setState({ status: "authenticated", address: sub as `0x${string}` });
      }
    });
  }, []);

  // If wallet disconnects, drop the Supabase session.
  useEffect(() => {
    if (!isConnected && state.status === "authenticated") {
      const supa = createClient();
      supa.auth.signOut().finally(() => setState({ status: "idle" }));
    }
  }, [isConnected, state.status]);

  // If connected wallet doesn't match the authed address, drop session too.
  useEffect(() => {
    if (
      isConnected &&
      address &&
      state.status === "authenticated" &&
      address.toLowerCase() !== state.address.toLowerCase()
    ) {
      const supa = createClient();
      supa.auth.signOut().finally(() => setState({ status: "idle" }));
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
      });
      if (!verifyRes.ok) throw new Error("verify_failed");
      const tokens = (await verifyRes.json()) as {
        access_token: string;
        refresh_token: string;
      };

      const supa = createClient();
      const { error } = await supa.auth.setSession({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
      });
      if (error) throw error;

      setState({ status: "authenticated", address: address as `0x${string}` });
    } catch (e) {
      setState({ status: "error", error: e instanceof Error ? e.message : "unknown" });
    }
  }, [address, chain?.id, isConnected, signMessageAsync]);

  const signOut = useCallback(async () => {
    const supa = createClient();
    await supa.auth.signOut();
    setState({ status: "idle" });
  }, []);

  return { state, signIn, signOut };
}
