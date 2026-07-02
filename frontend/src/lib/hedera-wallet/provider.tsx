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
  /**
   * Tear down the current connector, rebuild it, and re-acquire a signer from
   * the CURRENT live WC session (or the iframe extension when framed). Returns
   * the fresh connector. Callers on the tx/sign path invoke this when they hit
   * a 'record was recently deleted' / 'no matching key' / 'not initialized'
   * error — HashPack's dapp-browser deletes+re-pairs the session out from under
   * us, leaving connector.signers[0] bound to a dead topic. No-op-safe on the
   * top-level (non-iframe) path: it rebuilds and reconnects to the live session.
   */
  refreshConnector: () => Promise<unknown | null>;
  /** True when the connector's signer is bound to a topic still present in the
   *  live WC session set. Cheap pre-flight guard for the tx/sign path. */
  isSessionLive: () => boolean;
  /** True while the DAppConnector is being (re)built + initialized — on mount
   *  and during any rebuild. Connect buttons gate on this so a tap can't race a
   *  half-initialized WC client and trigger "WalletConnect is not initialized". */
  initializing: boolean;
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
  // RETRY before falling back to long-zero. For an ECDSA account the long-zero
  // is the WRONG identity (its real alias differs), and the whole session keys
  // on this address — a transient Mirror blip here would otherwise pin the
  // session to a wrong long-zero, breaking HTS balance reads AND SIWE (the
  // server resolves the real alias → nonce address mismatch → 401). A HashPack
  // account always exists, so a non-ok/throw is transient and worth retrying.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${MIRROR_BASE}/accounts/${accountId}`);
      if (res.ok) {
        const data = (await res.json()) as { evm_address?: string | null };
        const evm = data.evm_address;
        // A genuine ECDSA alias is a distinct non-long-zero 20-byte hex; use it.
        if (evm && /^0x[0-9a-fA-F]{40}$/.test(evm) && evm.toLowerCase() !== longZero.toLowerCase()) {
          return evm.toLowerCase() as `0x${string}`;
        }
        // res.ok with no distinct alias → genuine Ed25519 (long-zero is the only
        // address it has). Authoritative — don't retry.
        return longZero;
      }
      // non-ok (transient 5xx/429) → fall through to retry.
    } catch {
      /* network error → retry */
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  }
  // Mirror stayed unreachable across retries. Long-zero is wrong for an ECDSA
  // account, but the server-side nonce fix accepts either form so SIWE still
  // succeeds; a later connect/switch re-resolve corrects the rest.
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
  // Shared in-flight init promise. The mount rehydrate effect AND a user Connect
  // tap both call getOrInit(); without sharing this promise they each build a
  // SEPARATE DAppConnector and init() them concurrently against the same WC
  // storage — corrupting the SignClient and surfacing as "WalletConnect is not
  // initialized" on the first tap. Memoizing collapses them onto ONE connector.
  const initPromiseRef = useRef<Promise<HederaConnectorShim> | null>(null);
  const [initializing, setInitializing] = useState(false);
  // Mirror of the live accountId for the [] -deps WC event listener, which must
  // read the CURRENT account (its closure captures the initial state otherwise).
  const accountIdRef = useRef<string | null>(null);
  accountIdRef.current = state.accountId;

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

    // CONCURRENCY GUARD: share the single in-flight build. A second caller
    // (e.g. the mount effect + a Connect tap) must NOT spin up a competing
    // DAppConnector — see initPromiseRef comment above.
    if (initPromiseRef.current) return initPromiseRef.current;

    const build = async (): Promise<HederaConnectorShim> => {
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

      const mkConnector = () =>
        new DAppConnector(
          APP_METADATA,
          sdk.LedgerId.MAINNET,
          projectId,
          Object.values(HederaJsonRpcMethod),
          [HederaSessionEvent.ChainChanged, HederaSessionEvent.AccountsChanged],
          [HederaChainId.Mainnet],
          "error",
        );

      let connector = mkConnector();
      // `init` tries to rehydrate any persisted WC session. If that session
      // got serialized in an older library format, the lib can throw inside
      // `loadPersistedSession → setChainIds` ("Cannot read properties of
      // undefined (reading 'filter')"). When that happens we clear the WC
      // localStorage namespace, build a fresh connector, and retry once —
      // otherwise the user is stuck on every page load with a stale session
      // they can't recover from without devtools. A SECOND failure propagates
      // to the caller's connect-time self-heal (no unhandled rejection).
      try {
        await connector.init({ logger: "error" });
      } catch (e) {
        diag("HederaConnect", { step: "init_failed_clear_session", error: e instanceof Error ? e.message : String(e) });
        try {
          clearStaleWcStorage();
        } catch { /* ignore */ }
        connector = mkConnector();
        await connector.init({ logger: "error" });
      }
      connectorRef.current = connector as unknown as { disconnectAll: () => Promise<void>; signers: unknown[] };
      return connector as unknown as HederaConnectorShim;
    };

    setInitializing(true);
    initPromiseRef.current = build();
    try {
      return await initPromiseRef.current;
    } finally {
      // Clear on both success and failure: on success the cached-client early
      // return covers subsequent calls; on failure the next call must be free
      // to rebuild rather than await a rejected promise.
      initPromiseRef.current = null;
      setInitializing(false);
    }
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

    // SELF-HEAL the classic "WalletConnect is not initialized" (WC client not
    // ready yet / stale-session init failure): tear down, clear the WC
    // localStorage namespace, rebuild a fresh connector, and retry — up to 3
    // attempts with a short backoff so init has time to actually settle before
    // the next try (an immediate retry races the same half-torn-down state).
    // Only retries this specific class of error; user rejections fail fast.
    const RETRIABLE = /not initialized|no matching key|cannot read prop/i;
    try {
      let result: { accountId: string; evmAddress: `0x${string}` } | null = null;
      let lastErr: unknown = null;
      for (let pass = 1; pass <= 3; pass++) {
        try {
          result = await attempt(pass);
          break;
        } catch (e) {
          lastErr = e;
          const msg = e instanceof Error ? e.message : String(e);
          if (pass < 3 && RETRIABLE.test(msg)) {
            diag("HederaConnect", { step: "retry_after_not_initialized", pass, error: msg });
            try { await connectorRef.current?.disconnectAll(); } catch { /* ignore */ }
            connectorRef.current = null;
            initPromiseRef.current = null;
            try { clearStaleWcStorage(); } catch { /* ignore */ }
            await new Promise((r) => setTimeout(r, 600));
            continue;
          }
          throw e;
        }
      }
      if (!result) throw lastErr ?? new Error("connect_failed");
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

  // Is the current signer's topic still in the live WC session set? When
  // HashPack deletes/re-pairs the session, signers[0] keeps pointing at the
  // dead topic — this returns false so the caller knows to refresh first.
  const isSessionLive = useCallback((): boolean => {
    const c = connectorRef.current as unknown as HederaConnectorShim | null;
    if (!c) return false;
    const client = c.walletConnectClient;
    const signers = c.signers as Array<{ topic?: string; getAccountId?: () => { toString(): string } }> | undefined;
    if (!client?.session?.getAll || !signers?.length) return false;
    const live = client.session.getAll();
    const now = Math.floor(Date.now() / 1000);
    const liveTopics = new Set(live.filter((s) => s.expiry > now).map((s) => s.topic));
    if (liveTopics.size === 0) return false;
    // Prefer matching the signer's own topic when the library exposes it;
    // otherwise fall back to "there is at least one live session".
    const signerTopic = signers[0]?.topic;
    if (typeof signerTopic === "string") return liveTopics.has(signerTopic);
    return true;
  }, []);

  // Rebuild the connector and re-acquire a signer from the CURRENT live session
  // (or the iframe extension). This is the mode-2 self-heal: on a HashPack
  // session delete/re-pair we mint a fresh DAppSigner bound to the live topic
  // so the retried tx/sign lands on a real session instead of the dead one.
  const refreshConnector = useCallback(async (): Promise<unknown | null> => {
    diag("HederaConnect", { step: "refreshConnector" });
    try { await connectorRef.current?.disconnectAll(); } catch { /* ignore orphan */ }
    connectorRef.current = null;
    try { clearStaleWcStorage(); } catch { /* ignore */ }
    const connector = await getOrInit();
    // Prefer a direct extension connect inside a wallet dapp-browser; otherwise
    // adopt the live session the library rehydrated during init.
    try {
      if (isInIframe() && typeof connector.connectExtension === "function") {
        const ext = await findAvailableExtension(connector, { iframe: true }, 2500);
        if (ext) await connector.connectExtension(ext.id);
      } else if ((connector.signers?.length ?? 0) === 0) {
        await connector.openModal();
      }
    } catch (err) {
      diag("HederaConnect", { step: "refreshConnector_reconnect_failed", error: err instanceof Error ? err.message : String(err) });
    }
    // Sync React state to whatever signer we now hold.
    try {
      const signer = connector.signers?.[0] as { getAccountId(): { toString(): string } } | undefined;
      const acct = signer?.getAccountId().toString();
      if (acct) {
        const evmAddress = await resolveEvmAddress(acct);
        setState({ status: "connected", accountId: acct, evmAddress, error: null });
      }
    } catch { /* leave state as-is; caller will surface a real error if the retry also fails */ }
    return connectorRef.current;
  }, [getOrInit]);

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

        // HashPack's dapp-browser frequently DELETES the app's persisted WC
        // session on open and immediately re-pairs a fresh one (see the
        // session_delete → new pairing sequence in the iframe logs). Register
        // the library's iframe-session callback so we auto-connect to that
        // fresh session — otherwise the first Connect tap lands on the dead
        // session and the user has to tap a SECOND time. No-op top-level.
        connector.onSessionIframeCreated = (session: WcSession) => {
          if (cancelled) return;
          const acct = accountIdFromSession(session);
          if (!acct) return;
          console.log("[fission-rehydrate] onSessionIframeCreated → reconnecting", acct);
          setState((s) => ({ ...s, status: "connecting", error: null }));
          resolveEvmAddress(acct)
            .then((evmAddress) => {
              if (cancelled) return;
              // A fresh iframe session landed. Broadcast so the auth engine can
              // (re)sign even if it was previously pinned at 'error'/'loading'
              // on the now-dead session (mode 3). The 'connected' transition
              // below re-arms the Nav auto-sign; this event forces a /me
              // re-probe + re-sign for consumers that already left 'idle'.
              setState({ status: "connected", accountId: acct, evmAddress, error: null });
              try { window.dispatchEvent(new Event("fp:wallet-session-fresh")); } catch { /* ignore */ }
            })
            .catch(() => {});
        };

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
      // The deleted session's signer is now dead. NULL the connector ref so the
      // very next getConnector()/write/sign is forced to rebuild+reconnect to a
      // live session instead of executing against the dead topic (mode 2 root
      // cause: session_delete previously only mutated React state, leaving the
      // stale connector+signer in place). connectorRef is repopulated by
      // getOrInit() on the next refresh/rehydrate.
      try { void connectorRef.current?.disconnectAll(); } catch { /* ignore orphan */ }
      connectorRef.current = null;
      // Inside a wallet dapp-browser (HashPack), a delete is usually the wallet
      // swapping the app's persisted session for a fresh iframe pairing — which
      // onSessionIframeCreated catches and reconnects moments later. Show
      // "connecting" rather than flashing a Connect prompt; fall back to INITIAL
      // if no re-pair lands within 10s (a genuine wallet-side disconnect).
      // Top-level (non-iframe) loads drop straight to INITIAL as before.
      if (isInIframe()) {
        setState((s) => (s.status === "connected" ? { ...s, status: "connecting", error: null } : s));
        setTimeout(() => setState((s) => (s.status === "connecting" ? INITIAL : s)), 10000);
      } else {
        setState(INITIAL);
      }
    };
    const handleExpire = handleDelete;
    // A HashPack in-wallet ACCOUNT SWITCH surfaces as session_update (the
    // session's namespaces change) or session_event (accountsChanged). Re-derive
    // the account from the now-current session and, if it changed, FOLLOW it so
    // balances, the tx-signer selection, and SIWE all move to the new account.
    // Without this the app stays pinned to the account that was active at connect
    // time — the user sees the wrong balance and a false "NEED ~N HBAR".
    const handleSessionChanged = (data: { topic?: string }) => {
      void (async () => {
        try {
          const c = client;
          if (!c?.session) return;
          let session: WcSession | undefined;
          if (data?.topic && c.session.get) session = c.session.get(data.topic);
          if (!session && c.session.getAll) {
            const now = Math.floor(Date.now() / 1000);
            session = c.session.getAll().find((s) => s.expiry > now);
          }
          if (!session) return;
          const acct = accountIdFromSession(session);
          if (!acct || acct === accountIdRef.current) return;
          const evmAddress = await resolveEvmAddress(acct);
          // Re-check after the async Mirror lookup: bail if unmounted or if a
          // concurrent handler already applied this exact switch.
          if (cancelled || accountIdRef.current === acct) return;
          diag("HederaConnect", { step: "account_switched", to: acct });
          setState({ status: "connected", accountId: acct, evmAddress, error: null });
        } catch { /* ignore */ }
      })();
    };
    (async () => {
      // The mount rehydrate effect ALWAYS calls getOrInit() (always-init mode),
      // so connectorRef becomes available within ~1-3s even for users with NO
      // stored session. Poll for it (bounded ~6s) so the lifecycle + account-
      // switch listeners attach for EVERYONE — not only users who arrived with a
      // persisted session. (The old probe-gated early-return meant a fresh user
      // who connected later never got these listeners.)
      for (let i = 0; i < 60 && !connectorRef.current; i++) {
        await new Promise((r) => setTimeout(r, 100));
        if (cancelled) return;
      }
      const c = connectorRef.current as unknown as HederaConnectorShim | null;
      client = c?.walletConnectClient;
      if (!client) return;
      client.on("session_delete", handleDelete);
      client.on("session_expire", handleExpire);
      client.on("session_update", handleSessionChanged);
      client.on("session_event", handleSessionChanged);
    })();
    return () => {
      cancelled = true;
      client?.off?.("session_delete", handleDelete);
      client?.off?.("session_expire", handleExpire);
      client?.off?.("session_update", handleSessionChanged);
      client?.off?.("session_event", handleSessionChanged);
    };
  }, []);

  const api = useMemo<HederaWalletAPI>(
    () => ({ ...state, initializing, connect, disconnect, getConnector, refreshConnector, isSessionLive }),
    [state, initializing, connect, disconnect, getConnector, refreshConnector, isSessionLive],
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
  /** Set by us; the library invokes it when its in-iframe pairing (HashPack
   *  dapp-browser) establishes a FRESH session. HashPack often DELETES the
   *  app's persisted session on open and immediately re-pairs, so we catch the
   *  new session here instead of stranding the user at a Connect prompt that
   *  only works on the second tap. No-op for top-level (non-iframe) loads. */
  onSessionIframeCreated?: ((session: WcSession) => void) | null;
}

/** Subset of the library's ExtensionData we read to detect installed wallets. */
interface ExtensionData {
  id: string;
  name?: string;
  available: boolean;
  availableInIframe: boolean;
}

/** True when the app runs inside an iframe (e.g. a wallet's dapp browser). */
export function isInIframe(): boolean {
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
