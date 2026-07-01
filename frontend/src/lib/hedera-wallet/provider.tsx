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
  evmAddress: `0x${string}` | null;    // real Mirror evm_address for ECDSA; long-zero only for Ed25519
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

const MIRROR_BASE = "https://mainnet-public.mirrornode.hedera.com/api/v1";

/**
 * Resolve the EVM address the rest of the app should use for HTS facade reads
 * (balanceOf / allowance) and as the on-chain receiver.
 *
 * Why this matters: HashPack/Hedera-native accounts (and any ECDSA account)
 * own a REAL EVM alias (the keccak of their public key), but Hedera also has a
 * deterministic "long-zero" form (`0x` + the account num). The HTS facade
 * `balanceOf`/`allowance` precompile only resolves contracts + ECDSA aliases —
 * it REVERTS with INVALID_ACCOUNT_ID when handed an Ed25519 long-zero. If we
 * hand the long-zero to the app for an ECDSA account, every facade read reverts
 * and the profile shows $0 while sells misread their inputs.
 *
 * Fix: fetch the account's real `evm_address` from the Mirror Node and use
 * THAT for ECDSA accounts. Only fall back to the long-zero for true Ed25519
 * accounts (Mirror returns a null/absent `evm_address`, i.e. there is no real
 * alias to use). Long-zero is the only address such accounts have; facade reads
 * will still revert for them, but that's intrinsic to Ed25519 + HTS and handled
 * elsewhere via contract-tracked balances.
 */
async function resolveEvmAddress(accountId: string): Promise<`0x${string}`> {
  const num = Number(accountId.split(".")[2]);
  const longZero = ("0x" + num.toString(16).padStart(40, "0")) as `0x${string}`;
  try {
    const res = await fetch(`${MIRROR_BASE}/accounts/${accountId}`);
    if (res.ok) {
      const data = (await res.json()) as { evm_address?: string | null };
      const evm = data.evm_address;
      // Mirror returns the long-zero form in `evm_address` for Ed25519 accounts
      // that never registered a real alias — treat that (and null/empty) as "no
      // real alias" and keep the long-zero. A genuine ECDSA alias is a distinct
      // non-long-zero 20-byte hex; use it verbatim.
      if (evm && /^0x[0-9a-fA-F]{40}$/.test(evm) && evm.toLowerCase() !== longZero.toLowerCase()) {
        return evm.toLowerCase() as `0x${string}`;
      }
    }
  } catch {
    /* Mirror unreachable — fall back to long-zero below. */
  }
  return longZero;
}

export function HederaWalletProvider({ children }: { children: ReactNode }) {
  // Always start in "connecting" — the rehydrate useEffect below always
  // initializes the SignClient on mount and drops to INITIAL only if no
  // live session is found. The brief "connecting" skeleton (1-3s on cold
  // page) is better UX than flashing a misleading "Connect Wallet"
  // prompt while the session restore is in flight.
  const [state, setState] = useState<HederaWalletState>(() => ({
    ...INITIAL,
    status: "connecting",
  }));
  const connectorRef = useRef<{ disconnectAll: () => Promise<void>; signers: unknown[] } | null>(null);

  /**
   * Lazy-load and initialize the DAppConnector on first connect() call.
   * Returns the singleton instance; safe to call multiple times.
   *
   * We keep the import behind a function so the SDK + Hedera-WC library
   * (~1MB+ uncompressed) stays out of the initial chunk.
   */
  const getOrInit = useCallback(async (): Promise<HederaConnectorShim> => {
    // Only reuse a cached connector that actually has a live WC client. If the
    // ref ever holds an un-initialized connector, openModal/connectURI throws
    // "WalletConnect is not initialized" — so fall through and rebuild instead.
    const cached = connectorRef.current as unknown as HederaConnectorShim | null;
    if (cached?.walletConnectClient) return cached;

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

    // One connect attempt: (re)get a READY connector, prefer a detected
    // extension, otherwise open the WC modal, then read the signer.
    const attempt = async (pass: number): Promise<{ accountId: string; evmAddress: `0x${string}` }> => {
      diag("HederaConnect", { step: "before_init", pass });
      const connector = await getOrInit();
      diag("HederaConnect", { step: "init_ok", pass, ready: !!connector.walletConnectClient });
      // Prefer a DIRECT connect to an installed HashPack / Hedera browser
      // extension when detected (Step 4) — no QR, no WC relay. Falls back to the
      // existing openModal() flow for everyone else and on any error.
      let usedExtension = false;
      try {
        if (typeof connector.connectExtension === "function") {
          const ext = (connector.extensions ?? []).find((e) => e.available);
          if (ext) {
            diag("HederaConnect", { step: "connectExtension", id: ext.id, name: ext.name });
            await connector.connectExtension(ext.id);
            usedExtension = true;
          }
        }
      } catch (err) {
        diag("HederaConnect", { step: "connectExtension_failed_fallback_modal", error: err instanceof Error ? err.message : String(err) });
        usedExtension = false;
      }
      if (!usedExtension) {
        await connector.openModal();
      }
      diag("HederaConnect", { step: "connect_resolved", pass, via: usedExtension ? "extension" : "modal", signerCount: connector.signers?.length ?? 0 });
      const signers = connector.signers;
      if (!signers || signers.length === 0) throw new Error("No signer returned from wallet");
      const signer = signers[0] as { getAccountId(): { toString(): string } };
      const accountId = signer.getAccountId().toString();
      // Resolve the REAL evm alias from Mirror so HTS facade reads don't revert
      // for ECDSA (HashPack) accounts. Falls back to long-zero for Ed25519.
      const evmAddress = await resolveEvmAddress(accountId);
      return { accountId, evmAddress };
    };

    try {
      let result: { accountId: string; evmAddress: `0x${string}` };
      try {
        result = await attempt(1);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // SELF-HEAL the classic "WalletConnect is not initialized" (WC client
        // not ready yet / stale-session init failure): tear down, clear the WC
        // localStorage namespace, rebuild a fresh connector, and retry ONCE.
        // This turns the prior hard failure ("Connect failed: WalletConnect is
        // not initialized") into a transparent retry that succeeds once init
        // completes. Only retries on this specific class of error.
        if (/not initialized|no matching key|cannot read prop/i.test(msg)) {
          diag("HederaConnect", { step: "retry_after_not_initialized", error: msg });
          try { await connectorRef.current?.disconnectAll(); } catch { /* ignore */ }
          connectorRef.current = null;
          try { clearStaleWcStorage(); } catch { /* ignore */ }
          result = await attempt(2);
        } else {
          throw e;
        }
      }
      diag("HederaConnect", { step: "success", accountId: result.accountId, evmAddress: result.evmAddress });
      setState({ status: "connected", accountId: result.accountId, evmAddress: result.evmAddress, error: null });
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
      // No localStorage probe — different WC builds (and HashPack
      // browser-extension variants) persist session metadata under
      // different keys (`wc@2:client:0.3//session`, `wc@2:client:0.4`,
      // HashConnect-legacy paths). A targeted probe drops valid
      // sessions stored under any unknown prefix and the user sees
      // "Connect Wallet" on every refresh despite an active wallet
      // connection. Trade-off: always pay the 1-3s SDK load on mount
      // even for users who never connected. The UI shows a skeleton
      // during that window so it doesn't flash a misleading Connect
      // prompt.
      console.log("[fission-rehydrate] always-init mode, status→connecting");
      setState((s) => ({ ...s, status: "connecting" }));
      try {
        const connector = await getOrInit();
        if (cancelled) return;
        console.log("[fission-rehydrate] connector init resolved");

        const client = connector.walletConnectClient;
        console.log("[fission-rehydrate] walletConnectClient present:", !!client);
        const sessions: WcSession[] = client?.session?.getAll?.() ?? [];
        console.log("[fission-rehydrate] sessions count:", sessions.length, sessions);
        const now = Math.floor(Date.now() / 1000);
        const live = sessions.find((s) => s.expiry > now);
        console.log("[fission-rehydrate] live session?:", !!live, live ? { topic: live.topic, expiry: live.expiry, namespaces: Object.keys(live.namespaces) } : null);
        if (!live) {
          // No stored session. If we're running INSIDE a wallet's dapp-browser
          // iframe (e.g. HashPack's in-app browser, now that framing is allowed),
          // auto-connect to the host extension so the user doesn't have to
          // manually tap Connect inside the embedded browser (Step 4 iframe path).
          // This ONLY runs when framed AND an available-in-iframe extension
          // responds; normal top-level desktop/mobile loads fall straight through
          // to INITIAL exactly as before.
          if (isInIframe() && typeof connector.connectExtension === "function") {
            try {
              const ext = await findAvailableExtension(connector, { iframe: true }, 2500);
              if (ext && !cancelled) {
                diag("HederaConnect", { step: "iframe_autoconnect", id: ext.id });
                await connector.connectExtension(ext.id);
                const signer = connector.signers?.[0] as
                  | { getAccountId(): { toString(): string } }
                  | undefined;
                const acct = signer?.getAccountId().toString();
                if (acct && !cancelled) {
                  const evmAddress = await resolveEvmAddress(acct);
                  console.log("[fission-rehydrate] iframe auto-connected", { acct, evmAddress });
                  setState({ status: "connected", accountId: acct, evmAddress, error: null });
                  return;
                }
              }
            } catch (err) {
              console.log("[fission-rehydrate] iframe auto-connect skipped/failed", err);
            }
          }
          console.log("[fission-rehydrate] dropping to INITIAL — no live session");
          setState(INITIAL);
          return;
        }

        const accountId = accountIdFromSession(live);
        console.log("[fission-rehydrate] extracted accountId:", accountId);
        if (!accountId) {
          console.log("[fission-rehydrate] dropping to INITIAL — accountId extract failed", live.namespaces);
          setState(INITIAL);
          return;
        }
        // Resolve the REAL evm alias from Mirror (ECDSA) so HTS facade reads
        // don't revert on session restore; fall back to long-zero for Ed25519.
        const evmAddress = await resolveEvmAddress(accountId);
        if (cancelled) return;
        console.log("[fission-rehydrate] CONNECTED", { accountId, evmAddress });
        setState({ status: "connected", accountId, evmAddress, error: null });
      } catch (e) {
        console.log("[fission-rehydrate] threw, dropping to INITIAL", e);
        if (!cancelled) setState(INITIAL);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [getOrInit]);

  // Subscribe to WC v2 lifecycle events so wallet-side actions (user
  // taps "Disconnect" in HashPack, session expires, dApp namespace
  // updates) propagate back to our state instead of leaving the UI
  // stuck on "connected" with a dead session underneath.
  useEffect(() => {
    let client: WcSignClient | undefined;
    let cancelled = false;
    const handleDelete = () => {
      // Wallet-initiated disconnect — drop state regardless of which
      // session triggered (we only support one at a time).
      setState(INITIAL);
    };
    const handleExpire = handleDelete;
    (async () => {
      // Wait for the connector to exist (it may not at first mount if
      // no stored session — that's fine, no events to listen for).
      // If a session DOES get added later via connect(), we'll catch
      // events for it because `client.on` is sticky across sessions.
      if (!connectorRef.current) {
        // Best effort — if probe says we should rehydrate, getOrInit
        // is already in flight from the effect above; wait a tick.
        if (probeHasStoredWcSession()) {
          for (let i = 0; i < 20 && !connectorRef.current; i++) {
            await new Promise((r) => setTimeout(r, 100));
            if (cancelled) return;
          }
        } else {
          return;
        }
      }
      const c = connectorRef.current as unknown as HederaConnectorShim | null;
      client = c?.walletConnectClient;
      if (!client) return;
      client.on("session_delete", handleDelete);
      client.on("session_expire", handleExpire);
    })();
    return () => {
      cancelled = true;
      client?.off?.("session_delete", handleDelete);
      client?.off?.("session_expire", handleExpire);
    };
  }, []);

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
  /** Auto-populated by the library's findExtensions (Step 4) with each detected
   *  Hedera wallet browser extension (HashPack, Blade, ...). */
  extensions?: ExtensionData[];
  /** Connects directly to a detected extension by id, bypassing the QR/relay
   *  modal. Rejects if the extension is not available. */
  connectExtension?(extensionId: string, pairingTopic?: string): Promise<unknown>;
  /** Underlying @walletconnect/sign-client. Populated after init(); used
   *  to read persisted sessions synchronously and subscribe to lifecycle
   *  events (session_delete / session_expire). */
  walletConnectClient?: WcSignClient;
}

/** Subset of the library's ExtensionData we read to detect installed wallets. */
interface ExtensionData {
  id: string;
  name?: string;
  available: boolean;
  availableInIframe: boolean;
}

/** True when the app runs inside an iframe (e.g. a wallet's dapp browser). */
function isInIframe(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.self !== window.top;
  } catch {
    // Cross-origin access to window.top throws → we are framed.
    return true;
  }
}

/** Poll connector.extensions (auto-populated by the library's findExtensions,
 *  which broadcasts a `hedera-extension-query` ~200ms after construction) for an
 *  available Hedera wallet extension. Returns the first match, or null on timeout. */
async function findAvailableExtension(
  connector: HederaConnectorShim,
  opts: { iframe: boolean },
  timeoutMs: number,
): Promise<ExtensionData | null> {
  const pick = (e: ExtensionData) => (opts.iframe ? e.availableInIframe : e.available);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = (connector.extensions ?? []).find(pick);
    if (found) return found;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Minimal slice of the @walletconnect/sign-client v2 surface we need.
 *  WC's full session shape is huge; we read accounts + topic + expiry. */
interface WcSession {
  topic: string;
  expiry: number; // unix seconds
  namespaces: Record<string, { accounts: string[]; chains?: string[] }>;
}
interface WcSignClient {
  session: {
    getAll(): WcSession[];
    get(topic: string): WcSession | undefined;
  };
  on(event: string, handler: (data: { topic: string }) => void): void;
  off(event: string, handler: (data: { topic: string }) => void): void;
}

/** Extract the Hedera accountId (`0.0.X`) from a WC session's namespaces.
 *  WC v2 stores accounts in CAIP-10 format: `hedera:mainnet:0.0.123`. */
function accountIdFromSession(session: WcSession): string | null {
  for (const ns of Object.values(session.namespaces)) {
    for (const acct of ns.accounts ?? []) {
      // Expected: "hedera:mainnet:0.0.X" → split off the trailing Hedera ID.
      const parts = acct.split(":");
      const id = parts[parts.length - 1];
      if (id && /^\d+\.\d+\.\d+$/.test(id)) return id;
    }
  }
  return null;
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
