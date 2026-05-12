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

const APP_METADATA = {
  name: "Fission Protocol",
  description: "Yield-stripping AMM on Hedera",
  url: "https://www.fissionp.com",
  icons: ["https://www.fissionp.com/icon.png"],
};

export function HederaWalletProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<HederaWalletState>(INITIAL);
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

    // Dynamic import + deep path. The package's top-level index.js re-exports
    // a Wallet class that pulls in @reown/walletkit and @hiero-ledger/sdk —
    // peers we don't need for the dApp-side. Importing from /dist/lib/dapp
    // skips the wallet code entirely.
    const [hwc, sdk] = await Promise.all([
      import("@hashgraph/hedera-wallet-connect/dist/lib/dapp/index.js"),
      import("@hashgraph/sdk"),
    ]);
    const { DAppConnector, HederaJsonRpcMethod, HederaSessionEvent, HederaChainId } =
      hwc as unknown as {
        DAppConnector: new (...args: unknown[]) => HederaConnectorShim;
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
    await connector.init({ logger: "error" });
    connectorRef.current = connector as unknown as { disconnectAll: () => Promise<void>; signers: unknown[] };
    return connector as unknown as HederaConnectorShim;
  }, []);

  const connect = useCallback(async () => {
    setState((s) => ({ ...s, status: "connecting", error: null }));
    try {
      const connector = await getOrInit();
      await connector.openModal();
      const signers = connector.signers;
      if (!signers || signers.length === 0) {
        throw new Error("No signer returned from wallet");
      }
      const signer = signers[0] as { getAccountId(): { toString(): string } };
      const accountId = signer.getAccountId().toString();
      const num = Number(accountId.split(".")[2]);
      const evmAddress = ("0x" + num.toString(16).padStart(40, "0")) as `0x${string}`;
      setState({ status: "connected", accountId, evmAddress, error: null });
    } catch (e) {
      setState({
        status: "error",
        accountId: null,
        evmAddress: null,
        error: e instanceof Error ? e.message : String(e),
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
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Only attempt restore if Reown-stored sessions exist — avoids loading
      // the big SDK on a cold page when nobody's used Hedera-native.
      if (typeof window === "undefined") return;
      const hasStoredSession =
        window.localStorage.getItem("wc@2:client:0.3//session") &&
        window.localStorage.getItem("wc@2:client:0.3//session") !== "[]";
      if (!hasStoredSession) return;

      try {
        const connector = await getOrInit();
        const signers = connector.signers ?? [];
        if (cancelled || signers.length === 0) return;
        const signer = signers[0] as { getAccountId(): { toString(): string } };
        const accountId = signer.getAccountId().toString();
        const num = Number(accountId.split(".")[2]);
        const evmAddress = ("0x" + num.toString(16).padStart(40, "0")) as `0x${string}`;
        setState({ status: "connected", accountId, evmAddress, error: null });
      } catch {
        /* swallow — user can manually reconnect */
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
