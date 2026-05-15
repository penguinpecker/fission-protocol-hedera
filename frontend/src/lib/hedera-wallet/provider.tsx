"use client";

/**
 * HederaWalletProvider — React context that owns a lazy-initialized
 * `DAppConnector` from @hashgraph/hedera-wallet-connect. Speaks the
 * `hedera:mainnet` WC namespace, which supports BOTH ECDSA (secp256k1)
 * and Ed25519 keys — unlike wagmi's `eip155:295` which is ECDSA-only.
 *
 * Coexists with the existing WagmiProvider:
 *   - Same NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID (Reown accepts shared use).
 *   - Each library spins up its own @walletconnect/sign-client instance;
 *     namespaces are different so sessions don't collide.
 *   - The "Hedera native" Connect button lazy-loads the SDK + DAppConnector
 *     on first use to keep the initial bundle small.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { diag } from "@/lib/diag";

type Status = "idle" | "connecting" | "connected" | "error";

interface HederaWalletState {
  status: Status;
  accountId: string | null;            // "0.0.NNNN"
  evmAddress: `0x${string}` | null;    // long-zero alias for Ed25519 accounts, real alias for ECDSA
  error: string | null;
}

interface HederaWalletAPI extends HederaWalletState {
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  /** Returns the live DAppConnector (after a successful connect). */
  getConnector: () => unknown | null;
}

const HederaWalletContext = createContext<HederaWalletAPI | null>(null);

const INITIAL: HederaWalletState = {
  status: "idle",
  accountId: null,
  evmAddress: null,
  error: null,
};

/** Sync localStorage probe used as the LAZY initial useState value. If the
 *  browser has any non-empty wc@2 session key we assume a restore is about
 *  to happen and bake `status: "connecting"` into the very first render —
 *  otherwise WalletGate sees `idle` for one frame and flashes the "Connect"
 *  prompt before the mount effect can mark us as connecting. */
function probeHasStoredWcSession(): boolean {
  if (typeof window === "undefined") return false;
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (!k) continue;
      if (k.startsWith("wc@2:") && k.includes("session")) {
        const v = window.localStorage.getItem(k);
        if (v && v !== "[]" && v !== "{}" && v !== "null") return true;
      }
    }
  } catch {
    /* localStorage disabled / private mode — fall through */
  }
  return false;
}

const APP_METADATA = {
  name: "Fission Protocol",
  description: "Yield-stripping AMM on Hedera",
  url: "https://www.fissionp.com",
  icons: ["https://www.fissionp.com/icon.png"],
};

export function HederaWalletProvider({ children }: { children: ReactNode }) {
  // Lazy initialiser — runs once on first render, BEFORE any paint. Reads
  // localStorage to decide whether to start in "connecting" (gate shows
  // skeleton) or "idle" (gate shows Connect). Eliminates the one-frame
  // flash that this session has been ping-ponging back to.
  const [state, setState] = useState<HederaWalletState>(() =>
    probeHasStoredWcSession() ? { ...INITIAL, status: "connecting" } : INITIAL,
  );
  const connectorRef = useRef<{ disconnectAll: () => Promise<void>; signers: unknown[] } | null>(null);

  /**
   * Lazy-load and initialize the DAppConnector on first connect() call.
   * Returns the singleton instance; safe to call multiple times.
   *
   * We keep the import behind a function so the SDK + Hedera-WC library
   * (~1MB+ uncompressed) stays out of the initial chunk.
   */
  const getOrInit = useCallback(async (): Promise<HederaConnectorShim> => {
    if (connectorRef.current) return connectorRef.current as unknown as HederaConnectorShim;

    const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
    if (!projectId) {
      throw new Error("NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is not set");
    }

    // Dynamic imports. We pull from two deep paths to dodge the wallet-side
    // code in the package's top-level index.js (it imports @reown/walletkit
    // which we don't need on the dApp side):
    //   - /dist/lib/dapp     → DAppConnector class
    //   - /dist/lib/shared   → HederaJsonRpcMethod, HederaSessionEvent,
    //                          HederaChainId enums (used in constructor)
    const [hwcDapp, hwcShared, sdk] = await Promise.all([
      import("@hashgraph/hedera-wallet-connect/dist/lib/dapp/index.js"),
      import("@hashgraph/hedera-wallet-connect/dist/lib/shared/index.js"),
      import("@hashgraph/sdk"),
    ]);
    const { DAppConnector } = hwcDapp as unknown as {
      DAppConnector: new (...args: unknown[]) => HederaConnectorShim;
    };
    const { HederaJsonRpcMethod, HederaSessionEvent, HederaChainId } =
      hwcShared as unknown as {
        HederaJsonRpcMethod: Record<string, string>;
        HederaSessionEvent: Record<string, string>;
        HederaChainId: Record<string, string>;
      };

    const connector = new DAppConnector(
      APP_METADATA,
      sdk.LedgerId.MAINNET,
      projectId,
      Object.values(HederaJsonRpcMethod),
      [HederaSessionEvent.ChainChanged, HederaSessionEvent.AccountsChanged],
      [HederaChainId.Mainnet],
      "error",
    );
    // `init` tries to rehydrate any persisted WC session. If that session
    // got serialized in an older library format, the lib can throw inside
    // `loadPersistedSession → setChainIds` ("Cannot read properties of
    // undefined (reading 'filter')"). When that happens we clear the WC
    // localStorage namespace, build a fresh connector, and retry once —
    // otherwise the user is stuck on every page load with a stale session
    // they can't recover from without devtools.
    try {
      await connector.init({ logger: "error" });
    } catch (e) {
      diag("HederaConnect", { step: "init_failed_clear_session", error: e instanceof Error ? e.message : String(e) });
      try {
        clearStaleWcStorage();
      } catch { /* ignore */ }
      const fresh = new DAppConnector(
        APP_METADATA,
        sdk.LedgerId.MAINNET,
        projectId,
        Object.values(HederaJsonRpcMethod),
        [HederaSessionEvent.ChainChanged, HederaSessionEvent.AccountsChanged],
        [HederaChainId.Mainnet],
        "error",
      );
      await fresh.init({ logger: "error" });
      connectorRef.current = fresh as unknown as { disconnectAll: () => Promise<void>; signers: unknown[] };
      return fresh as unknown as HederaConnectorShim;
    }
    connectorRef.current = connector as unknown as { disconnectAll: () => Promise<void>; signers: unknown[] };
    return connector as unknown as HederaConnectorShim;
  }, []);

  const connect = useCallback(async () => {
    diag("HederaConnect", { step: "click" });
    setState((s) => ({ ...s, status: "connecting", error: null }));
    try {
      diag("HederaConnect", { step: "before_init" });
      const connector = await getOrInit();
      diag("HederaConnect", { step: "init_ok", hasOpenModal: typeof (connector as { openModal?: unknown }).openModal === "function" });
      await connector.openModal();
      diag("HederaConnect", { step: "openModal_resolved", signerCount: connector.signers?.length ?? 0 });
      const signers = connector.signers;
      if (!signers || signers.length === 0) {
        throw new Error("No signer returned from wallet");
      }
      const signer = signers[0] as { getAccountId(): { toString(): string } };
      const accountId = signer.getAccountId().toString();
      const num = Number(accountId.split(".")[2]);
      const evmAddress = ("0x" + num.toString(16).padStart(40, "0")) as `0x${string}`;
      diag("HederaConnect", { step: "success", accountId, evmAddress });
      setState({ status: "connected", accountId, evmAddress, error: null });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      diag("HederaConnect", { step: "error", error: msg, stack: e instanceof Error ? e.stack?.slice(0, 400) : undefined });
      setState({
        status: "error",
        accountId: null,
        evmAddress: null,
        error: msg,
      });
    }
  }, [getOrInit]);

  const disconnect = useCallback(async () => {
    try {
      await connectorRef.current?.disconnectAll();
    } catch {
      /* swallow — orphaned session is fine */
    }
    setState(INITIAL);
  }, []);

  const getConnector = useCallback(() => connectorRef.current, []);

  // On mount, if a Hedera session already exists in storage, restore it.
  // Set status to "connecting" while the SDK + WC client load asynchronously
  // (1-3 s on a cold page) so the gate / nav can show a skeleton instead of
  // a "connect wallet" prompt that misleadingly suggests the user got
  // signed out.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (typeof window === "undefined") return;
      // Scan ALL wc@2 session-shaped keys, not a single hardcoded
      // `wc@2:client:0.3//session`. Different WC client builds store the
      // session under different version segments (e.g. `wc@2:client:0.4`),
      // and HashPack-side updates can rotate that path without notice. A
      // narrow check skips a perfectly-good session, leaving the user
      // staring at a "Sign In" button despite having an active wallet
      // connection and valid SIWE cookie.
      let hasStoredSession = false;
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        if (!k) continue;
        if (k.startsWith("wc@2:") && k.includes("session")) {
          const v = window.localStorage.getItem(k);
          if (v && v !== "[]" && v !== "{}" && v !== "null") {
            hasStoredSession = true;
            break;
          }
        }
      }
      if (!hasStoredSession) return;

      setState((s) => ({ ...s, status: "connecting" }));
      try {
        const connector = await getOrInit();
        const signers = connector.signers ?? [];
        if (cancelled) return;
        if (signers.length === 0) {
          // Persisted store said we had a session, but the connector found no
          // signers (session expired / wallet-side disconnect). Drop back to
          // idle so the connect button works.
          setState(INITIAL);
          return;
        }
        const signer = signers[0] as { getAccountId(): { toString(): string } };
        const accountId = signer.getAccountId().toString();
        const num = Number(accountId.split(".")[2]);
        const evmAddress = ("0x" + num.toString(16).padStart(40, "0")) as `0x${string}`;
        setState({ status: "connected", accountId, evmAddress, error: null });
      } catch {
        if (!cancelled) setState(INITIAL);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [getOrInit]);

  const api = useMemo<HederaWalletAPI>(
    () => ({ ...state, connect, disconnect, getConnector }),
    [state, connect, disconnect, getConnector],
  );

  return <HederaWalletContext.Provider value={api}>{children}</HederaWalletContext.Provider>;
}

export function useHederaWallet(): HederaWalletAPI {
  const ctx = useContext(HederaWalletContext);
  if (!ctx) throw new Error("useHederaWallet must be used within HederaWalletProvider");
  return ctx;
}

/**
 * Loose shim type for the DAppConnector instance — avoids importing the
 * concrete library type into the provider type signature (lets us keep
 * the dynamic import working).
 */
interface HederaConnectorShim {
  init(opts: { logger: string }): Promise<unknown>;
  openModal(): Promise<unknown>;
  disconnectAll(): Promise<void>;
  signers: unknown[];
}

/**
 * Clears all WalletConnect v2 client keys from localStorage. Used when a
 * persisted session fails to rehydrate (different library version, stale
 * topic, etc.). Safe to call on a fresh page — just no-ops.
 */
function clearStaleWcStorage(): void {
  if (typeof window === "undefined") return;
  const toRemove: string[] = [];
  for (let i = 0; i < window.localStorage.length; i++) {
    const k = window.localStorage.key(i);
    if (!k) continue;
    if (k.startsWith("wc@2:") || k.startsWith("WALLETCONNECT_DEEPLINK_CHOICE")) {
      toRemove.push(k);
    }
  }
  for (const k of toRemove) window.localStorage.removeItem(k);
}
