import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { fetchSourceRate } from "./sources/index.ts";
import { postIfDue } from "./post.ts";
import { startHealthServer, log, type HealthState } from "./health.ts";
import type { AdapterConfig } from "./types.ts";

// ─── chain ───────────────────────────────────────────────────────

const HEDERA_MAINNET = defineChain({
  id: 295,
  name: "Hedera Mainnet",
  nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
  rpcUrls: { default: { http: [process.env.HEDERA_MAINNET_RPC ?? "https://mainnet.hashio.io/api"] } },
});

// ─── config from env ─────────────────────────────────────────────

function envRequired(key: string): string {
  const v = process.env[key];
  if (!v || v.length === 0) {
    log("error", "missing required env var", { key });
    process.exit(1);
  }
  return v;
}

function envOptional(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function parseAddress(s: string, key: string): Address {
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) {
    log("error", "invalid address", { key, value: s });
    process.exit(1);
  }
  return s as Address;
}

const KEEPER_KEY = envRequired("KEEPER_PRIVATE_KEY") as `0x${string}`;
const POLL_INTERVAL_SEC = Number(envOptional("KEEPER_INTERVAL_SECONDS", "3600"));
const MAX_DELTA_BPS = Number(envOptional("KEEPER_MAX_DELTA_BPS", "50"));
const HEALTH_PORT = Number(envOptional("PORT", "8080"));

// Adapters: each `KEEPER_ADAPTER_*` set wires up one SY adapter to a source.
//   KEEPER_ADAPTER_HBARX_SY=0x...
//   KEEPER_ADAPTER_HBARX_STADER=0x...
// Adding a new adapter is one config block here + restart.
const adapters: AdapterConfig[] = [];

if (process.env.KEEPER_ADAPTER_HBARX_SY) {
  adapters.push({
    name: "hbarx",
    sy: parseAddress(process.env.KEEPER_ADAPTER_HBARX_SY, "KEEPER_ADAPTER_HBARX_SY"),
    source: {
      kind: "stader",
      staderContract: parseAddress(envRequired("KEEPER_ADAPTER_HBARX_STADER"), "KEEPER_ADAPTER_HBARX_STADER"),
    },
    minIntervalSec: POLL_INTERVAL_SEC,
    maxDeltaBps: MAX_DELTA_BPS,
    bootstrap: true,
  });
}

if (process.env.KEEPER_ADAPTER_SAUCER_SY) {
  const sy = parseAddress(process.env.KEEPER_ADAPTER_SAUCER_SY, "KEEPER_ADAPTER_SAUCER_SY");
  adapters.push({
    name: "saucer-v1",
    sy,
    source: { kind: "saucerswap-v1", sy },
    minIntervalSec: POLL_INTERVAL_SEC,
    maxDeltaBps: MAX_DELTA_BPS,
    bootstrap: true,
  });
}

if (adapters.length === 0) {
  log("error", "no adapters configured — set KEEPER_ADAPTER_* env vars");
  process.exit(1);
}

// ─── viem clients ─────────────────────────────────────────────────

const publicClient = createPublicClient({ chain: HEDERA_MAINNET, transport: http() });
const account = privateKeyToAccount(KEEPER_KEY);
const walletClient = createWalletClient({ account, chain: HEDERA_MAINNET, transport: http() });

log("info", "keeper starting", {
  account: account.address,
  rpc: HEDERA_MAINNET.rpcUrls.default.http[0],
  adapters: adapters.map((a) => a.name),
  intervalSec: POLL_INTERVAL_SEC,
});

// ─── state ────────────────────────────────────────────────────────

const state: HealthState = {
  status: "ok",
  lastSuccessfulPost: {},
  failureCount: Object.fromEntries(adapters.map((a) => [a.name, 0])),
  startedAt: Date.now(),
};
const healthServer = startHealthServer(state, HEALTH_PORT);

// ─── main loop ────────────────────────────────────────────────────

async function tickAdapter(a: AdapterConfig): Promise<void> {
  try {
    const newRate = await fetchSourceRate(publicClient, a.source);
    const result = await postIfDue(publicClient, walletClient, a.sy, newRate, a.maxDeltaBps);
    if (result.posted) {
      log("info", "posted rate", {
        adapter: a.name,
        oldRate: result.oldRate?.toString() ?? null,
        newRate: result.newRate.toString(),
        deltaBps: result.deltaBps ?? null,
        txHash: result.txHash,
      });
      state.lastSuccessfulPost[a.name] = Date.now();
    } else {
      log("info", "skipped", {
        adapter: a.name,
        reason: result.reason,
        oldRate: result.oldRate?.toString() ?? null,
        newRate: result.newRate.toString(),
        deltaBps: result.deltaBps ?? null,
      });
    }
  } catch (err) {
    state.failureCount[a.name] = (state.failureCount[a.name] ?? 0) + 1;
    log("error", "tick failed", { adapter: a.name, err: errMsg(err) });
  }
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

let stopping = false;
async function loop(): Promise<void> {
  while (!stopping) {
    for (const a of adapters) {
      if (stopping) break;
      await tickAdapter(a);
    }
    if (stopping) break;
    await sleep(POLL_INTERVAL_SEC * 1000);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function shutdown(signal: string): void {
  log("info", "shutdown requested", { signal });
  stopping = true;
  healthServer.close();
  // give the in-flight loop a few seconds to finish a tick
  setTimeout(() => process.exit(0), 5_000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

loop().catch((err) => {
  log("error", "main loop crashed", { err: errMsg(err) });
  process.exit(1);
});
