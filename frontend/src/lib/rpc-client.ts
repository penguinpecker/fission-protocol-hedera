// Resilient Hedera read layer.
//
// The public Hashio JSON-RPC relay (mainnet.hashio.io) rate-limits (429) under
// load — during a user spike a single throttled eth_call was returning 0n and
// hard-aborting Buy-PT with "Price quoter unreachable". Every on-chain READ in
// the app (wagmi hooks + the trade-time Lens quoter + trade-cap + the adapter's
// evm client) used a bare `http()` with no retry and no fallback.
//
// This module provides:
//   - hederaReadTransport(): a viem transport that RETRIES each endpoint (viem
//     retries 429/5xx/network) and FANS OUT across any extra endpoints listed in
//     NEXT_PUBLIC_RPC_URLS (comma-separated) — so ops can add relay capacity for
//     a spike WITHOUT a redeploy, and a throttled primary falls through instead
//     of killing the read.
//   - mirrorContractRead(): a fallback eth_call via the Hedera MIRROR NODE's
//     contracts/call endpoint. Separate infrastructure from the JSON-RPC relay,
//     keyless, and not subject to Hashio's rate limits — used by the Buy-PT
//     quoter so pricing survives even a full Hashio throttle storm.

import { http, fallback, type Transport } from "viem";

const PRIMARY_RPC = process.env.NEXT_PUBLIC_RPC_URL ?? "https://mainnet.hashio.io/api";
const EXTRA_RPCS = (process.env.NEXT_PUBLIC_RPC_URLS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
export const RPC_URLS = Array.from(new Set([PRIMARY_RPC, ...EXTRA_RPCS]));

/**
 * Resilient read transport for Hedera mainnet eth_calls. Retries each endpoint
 * (viem retries 429/408/5xx/network) with backoff, then falls through to any
 * extra endpoints from NEXT_PUBLIC_RPC_URLS. Use for every read client.
 */
export function hederaReadTransport(): Transport {
  return fallback(
    RPC_URLS.map((url) => http(url, { retryCount: 4, retryDelay: 300, timeout: 9000 })),
    { retryCount: 1, retryDelay: 300 },
  );
}

const MIRROR_BASE = "https://mainnet-public.mirrornode.hedera.com/api/v1";

/**
 * Fallback read-only eth_call via the mirror node's contracts/call endpoint.
 * Not the JSON-RPC relay → not subject to Hashio's rate limits. Returns the raw
 * ABI-encoded result hex, or null on error / revert (caller decodes).
 */
export async function mirrorContractRead(
  to: string,
  data: string,
): Promise<`0x${string}` | null> {
  try {
    const r = await fetch(`${MIRROR_BASE}/contracts/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to, data, estimate: false, block: "latest" }),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { result?: string };
    return j.result && j.result.startsWith("0x") ? (j.result as `0x${string}`) : null;
  } catch {
    return null;
  }
}
