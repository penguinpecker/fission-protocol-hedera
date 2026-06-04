// Starter-HBAR drip — server only. Hardened per the 2026-06-05 security review.
//
// A fresh MetaMask wallet has no Hedera account and no gas, so it can't make its
// first Fission trade (and can't be funded from a CEX, which needs a 0.0.x). This
// sends a small amount of HBAR from a faucet wallet to the claimer's 0x address;
// that native transfer auto-creates the Hedera account (lazy creation) AND gives
// them gas. Sent via viem over the Hedera JSON-RPC relay.
//
// Robustness properties (see the review for the failure modes these defend):
//   - Budget cap + per-wallet lock are ATOMIC (gas_drip_acquire RPC, advisory-locked),
//     so a concurrent burst can't overspend and the same wallet can't be sent twice.
//   - Balance check FAILS CLOSED: a mirror outage never funds an already-funded wallet
//     (we only proceed on a definitive 404 "no account", not on errors).
//   - The tx hash is persisted as 'submitted' BEFORE awaiting the receipt, so a
//     receipt timeout never loses the record or mis-marks a landed tx as failed.
//   - Concurrent faucet sends manage the nonce explicitly and retry past finality on
//     nonce collisions; only a pre-broadcast throw marks the row 'failed', and 'failed'
//     rows are retryable (gas_drip_acquire revives them).
//   - Gas is estimated (lazy account creation costs far more than a 21k transfer).
//   - Fully disabled (no-op) until FAUCET_KEY is set → safe to deploy unconfigured.

import { createWalletClient, createPublicClient, http, parseEther, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createServiceRoleClient } from "@/lib/supabase/server";

const MIRROR = "https://mainnet-public.mirrornode.hedera.com";
const RPC = process.env.NEXT_PUBLIC_RPC_URL || "https://mainnet.hashio.io/api";
const CHAIN_ID = Number(process.env.NEXT_PUBLIC_HEDERA_CHAIN_ID ?? "295");

const hedera = defineChain({
  id: CHAIN_ID,
  name: "Hedera",
  nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 }, // EVM side is 18-dec
  rpcUrls: { default: { http: [RPC] } },
});

export type DripStatus =
  | "disabled"
  | "sent"
  | "already_sent"
  | "in_progress"
  | "not_claimed"
  | "skipped_funded"
  | "budget_exhausted"
  | "deferred"
  | "failed";

export type DripResult = { status: DripStatus; txHash?: string | null; amountHbar?: number };

function faucetConfig() {
  const raw = process.env.FAUCET_KEY?.trim();
  if (!raw) return null;
  const amount = Number(process.env.GAS_DRIP_AMOUNT_HBAR ?? "2");
  const budget = Number(process.env.GAS_DRIP_BUDGET_HBAR ?? "1000");
  const skipAbove = Number(process.env.GAS_DRIP_SKIP_IF_BALANCE_ABOVE_HBAR ?? "1");
  const gasFallback = BigInt(process.env.GAS_DRIP_GAS_LIMIT ?? "1000000"); // used only if estimateGas fails
  if (!(amount > 0) || !(budget > 0)) return null;
  const key = (raw.startsWith("0x") ? raw : `0x${raw}`) as `0x${string}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    console.error("FAUCET_KEY is set but is not a raw 64-hex ECDSA key — drip disabled (must be ECDSA, not Ed25519/DER)");
    return null;
  }
  return { key, amount, budget, skipAbove, gasFallback, maxDrips: Math.floor(budget / amount) };
}

/** True if the faucet is configured. */
export function gasDripEnabled(): boolean {
  return faucetConfig() !== null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Resolve a 0x → Hedera 0.0.x + HBAR balance. `ok:false` means the mirror was
 * UNREACHABLE (don't trust the balance → fail closed). `ok:true, accountId:null`
 * means a definitive 404 (no account yet → safe to fund).
 */
async function mirrorAccount(addr: string): Promise<{ ok: boolean; accountId: string | null; balanceHbar: number }> {
  try {
    const r = await fetch(`${MIRROR}/api/v1/accounts/${addr}`, { cache: "no-store" });
    if (r.status === 404) return { ok: true, accountId: null, balanceHbar: 0 }; // no account → fund it
    if (!r.ok) return { ok: false, accountId: null, balanceHbar: 0 }; // mirror error → unknown
    const j = (await r.json()) as { account?: string; balance?: { balance?: number } };
    return { ok: true, accountId: j.account ?? null, balanceHbar: (j.balance?.balance ?? 0) / 1e8 };
  } catch {
    return { ok: false, accountId: null, balanceHbar: 0 };
  }
}

/**
 * Send the one-time starter HBAR to `address` (lowercased 0x). Idempotent, gated,
 * budget-capped, and safe under concurrency. Safe to call repeatedly.
 */
export async function dripGas(address: string): Promise<DripResult> {
  const cfg = faucetConfig();
  if (!cfg) return { status: "disabled" };

  const addr = address.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) return { status: "failed" };
  const supa = createServiceRoleClient();

  // Fast pre-check (the authoritative gate is the atomic RPC). 'failed' falls through
  // so a transient earlier failure can be retried.
  const { data: existing } = await supa.from("gas_drips").select("status").eq("address", addr).maybeSingle();
  if (existing && existing.status !== "failed") {
    if (existing.status === "sent" || existing.status === "submitted") return { status: "already_sent" };
    if (existing.status === "pending") return { status: "in_progress" };
    if (existing.status === "skipped_funded") return { status: "skipped_funded" };
  }

  // Gate 1: must have redeemed a code.
  const { data: claim } = await supa.from("claim_codes").select("code").eq("claimed_by_address", addr).maybeSingle();
  if (!claim) return { status: "not_claimed" };

  // Gate 2: balance check — FAIL CLOSED on mirror errors; only fund a definitive 404
  // (or a real <= skipAbove balance).
  const bal = await mirrorAccount(addr);
  if (!bal.ok) return { status: "deferred" }; // mirror down → a later trigger retries
  if (bal.balanceHbar > cfg.skipAbove) {
    await supa
      .from("gas_drips")
      .upsert({ address: addr, account_id: bal.accountId, amount_hbar: 0, status: "skipped_funded" }, {
        onConflict: "address",
        ignoreDuplicates: true,
      });
    return { status: "skipped_funded" };
  }

  // Gate 3 + lock: ATOMIC budget cap + per-wallet lock + failed-retry, all under one
  // advisory lock in the DB. Only 'acquired' proceeds to an on-chain send.
  const { data: acq, error: acqErr } = await supa.rpc("gas_drip_acquire", {
    p_address: addr,
    p_account_id: bal.accountId,
    p_amount: cfg.amount,
    p_max_drips: cfg.maxDrips,
  });
  if (acqErr) {
    console.error("gas_drip_acquire failed", acqErr.message);
    return { status: "failed" };
  }
  if (acq !== "acquired") return { status: acq as DripStatus };

  // ── Send. Persist the hash BEFORE the receipt wait. Retry past finality on
  // nonce collisions (the single faucet may send to several recipients at once).
  try {
    const account = privateKeyToAccount(cfg.key);
    const wallet = createWalletClient({ account, chain: hedera, transport: http(RPC) });
    const pub = createPublicClient({ chain: hedera, transport: http(RPC) });
    const value = parseEther(String(cfg.amount));

    let gas: bigint;
    try {
      gas = ((await pub.estimateGas({ account, to: addr as `0x${string}`, value })) * 13n) / 10n;
    } catch {
      gas = cfg.gasFallback; // lazy-create estimate failed → over-provision (Hedera refunds excess)
    }
    const gasPrice = ((await pub.getGasPrice()) * 11n) / 10n; // +10% over the relay floor

    let hash: `0x${string}` | null = null;
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 3 && !hash; attempt++) {
      try {
        const nonce = await pub.getTransactionCount({ address: account.address, blockTag: "pending" });
        hash = await wallet.sendTransaction({ to: addr as `0x${string}`, value, gas, gasPrice, nonce });
      } catch (e) {
        lastErr = e;
        if (/nonce|already known|replacement|INTERNAL_ERROR/i.test(String(e)) && attempt < 2) {
          await sleep(4000 + Math.floor(Math.random() * 1500)); // wait past ~3-5s finality, re-read nonce
          continue;
        }
        throw e;
      }
    }
    if (!hash) throw lastErr ?? new Error("no tx hash after retries");

    await supa
      .from("gas_drips")
      .update({ status: "submitted", tx_hash: hash, updated_at: new Date().toISOString() })
      .eq("address", addr);

    try {
      await pub.waitForTransactionReceipt({ hash, timeout: 30_000 });
      await supa.from("gas_drips").update({ status: "sent", updated_at: new Date().toISOString() }).eq("address", addr);
    } catch {
      // Receipt didn't arrive in time. The tx is broadcast (we hold the hash) and most
      // likely landed — leave it 'submitted' (still counts toward budget) for out-of-band
      // reconciliation rather than wrongly marking it failed and double-spending the slot.
    }
    return { status: "sent", txHash: hash, amountHbar: cfg.amount };
  } catch (e) {
    // Threw before any broadcast → safe to mark failed; gas_drip_acquire makes 'failed'
    // retryable on the next trigger.
    await supa.from("gas_drips").update({ status: "failed", updated_at: new Date().toISOString() }).eq("address", addr);
    console.error("gas drip send failed", e instanceof Error ? e.message : e);
    return { status: "failed" };
  }
}
