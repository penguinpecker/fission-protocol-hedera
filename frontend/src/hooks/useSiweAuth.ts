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

import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { SiweMessage } from "siwe";
import { useWalletAdapter } from "@/lib/hedera-wallet/adapter";

export type SiweAuthState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "authenticated"; address: `0x${string}` }
  | { status: "error"; error: string };

export interface SiweAuthApi {
  state: SiweAuthState;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<SiweAuthApi | null>(null);

// The single shared auth engine — mounted ONCE via <AuthProvider>. All the
// wallet↔session logic lives here so every useSiweAuth() consumer (Nav, hero
// CTA, /claim, /profile) reads the SAME state and stays in sync. Previously
// each call site held its OWN copy that only re-synced via a best-effort
// `fp:auth-changed` event which signIn/signOut never even dispatched — so
// signing in on one button left the others showing "Sign In".
function useAuthEngine(): SiweAuthApi {
  const adapter = useWalletAdapter();
  const [state, setState] = useState<SiweAuthState>({ status: "idle" });
  // Refs for the mode-3 recovery path + a concurrent-run guard. adapterRef
  // mirrors the latest adapter so the fp:wallet-session-fresh listener (mounted
  // once, [] deps) always reads current wallet state; signInRef exposes the
  // latest signIn closure to that same listener.
  const signInInFlightRef = useRef(false);
  const signInRef = useRef<() => Promise<void>>(async () => {});
  const adapterRef = useRef(adapter);
  adapterRef.current = adapter;

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

  // Cross-instance re-sync. useSiweAuth is a per-component hook, so the Nav and a
  // page that drives its OWN sign-in (e.g. /claim) hold independent state. When
  // one signs in it dispatches `fp:auth-changed`; every other instance re-probes
  // /me so the Nav reflects the session without a navigation. Only ever upgrades
  // to authenticated — logout/disconnect stays owned by the effect below.
  useEffect(() => {
    const reprobe = () => {
      fetch("/api/auth/me", { credentials: "include" })
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (data && typeof data.address === "string" && /^0x[a-f0-9]{40}$/.test(data.address)) {
            setState({ status: "authenticated", address: data.address as `0x${string}` });
          }
        })
        .catch(() => {});
    };
    window.addEventListener("fp:auth-changed", reprobe);
    return () => window.removeEventListener("fp:auth-changed", reprobe);
  }, []);

  // MODE 3 recovery. HashPack's dapp-browser deletes + re-pairs the WC session;
  // the provider dispatches `fp:wallet-session-fresh` once a fresh iframe
  // session lands. Re-probe /me (a cookie may already be valid), otherwise
  // (re)sign on the NOW-live session — the only path out of a terminal 'error'
  // (every auto-sign gates on status==='idle', which a failed sign leaves).
  // kick() waits for the adapter hook to observe the new session before signing
  // (provider setState → adapter propagation is async), so the first attempt
  // doesn't hit the wallet_not_connected guard and re-error.
  useEffect(() => {
    const onFresh = () => {
      fetch("/api/auth/me", { credentials: "include" })
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (data && typeof data.address === "string" && /^0x[a-f0-9]{40}$/.test(data.address)) {
            setState({ status: "authenticated", address: data.address as `0x${string}` });
            return;
          }
          const kick = (tries: number) => {
            if (adapterRef.current.isConnected && adapterRef.current.address) {
              void signInRef.current();
              return;
            }
            if (tries > 0) setTimeout(() => kick(tries - 1), 400);
          };
          kick(6);
        })
        .catch(() => {
          void signInRef.current();
        });
    };
    window.addEventListener("fp:wallet-session-fresh", onFresh);
    return () => window.removeEventListener("fp:wallet-session-fresh", onFresh);
  }, []);

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
    if (signInInFlightRef.current) return;
    signInInFlightRef.current = true;
    setState({ status: "loading" });
    try {
    // TRANSIENT failures get an automatic retry (up to 3 attempts, 2.5s apart):
    //   - "Record was recently deleted" / stale-session WC errors: HashPack's
    //     dapp-browser deletes the app's persisted session on open and re-pairs
    //     a FRESH one; an auto-sign fired on the doomed session dies mid-flight.
    //     By the retry, onSessionIframeCreated has reconnected and the signer
    //     uses the live session.
    //   - fetch/network blips on the nonce/verify round-trips.
    // User rejections ("User rejected…") do NOT match — no nagging re-prompts.
    const TRANSIENT =
      /failed to fetch|load failed|network|record was recently deleted|no matching key|session topic|expired|not initialized/i;
      for (let attempt = 1; attempt <= 3; attempt++) {
        const err = await signInOnce();
        if (err === null) return; // authenticated
        if (attempt < 3 && TRANSIENT.test(err)) {
          await new Promise((r) => setTimeout(r, 2500));
          continue;
        }
        // Land on 'error' but NOT terminally: the entry guard only blocks
        // concurrent runs, and a fresh HashPack session re-arms sign-in via the
        // fp:wallet-session-fresh listener, so the app is no longer permanently
        // pinned at SIGN IN (mode 3).
        setState({ status: "error", error: err });
        return;
      }
    } finally {
      signInInFlightRef.current = false;
    }
    // signInOnce is a hoisted per-render function closing over the same
    // `adapter`; listing `adapter` covers its real dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adapter]);
  // Stable ref to the latest signIn so the fp:wallet-session-fresh listener
  // (mounted once) invokes the current closure.
  signInRef.current = signIn;

  /** One nonce→sign→verify attempt. Returns null on success, error string on
   *  failure. Hoisted function (not useCallback) so `signIn` above can reference
   *  it without a declaration-order/TDZ problem; it closes over the same
   *  render's `adapter`. */
  async function signInOnce(): Promise<string | null> {
    // Re-check inside the attempt: narrows adapter.address for TS and covers a
    // wallet that disconnected between retries.
    if (!adapter.isConnected || !adapter.address) return "wallet_not_connected";
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
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : "unknown";
    }
  }

  const signOut = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    setState({ status: "idle" });
  }, []);

  return { state, signIn, signOut };
}

/**
 * Mounts the single shared auth engine. Placed inside the wallet providers so
 * useWalletAdapter() resolves. Every useSiweAuth() below reads THIS instance.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const api = useAuthEngine();
  return createElement(AuthContext.Provider, { value: api }, children);
}

/** Reads the single shared SIWE auth state. Must be used within <AuthProvider>. */
export function useSiweAuth(): SiweAuthApi {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useSiweAuth must be used within <AuthProvider>");
  return ctx;
}
