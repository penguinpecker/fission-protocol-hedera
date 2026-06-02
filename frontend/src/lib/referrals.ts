// Referral system — server-only helpers. All access is via the service-role
// client (the referral tables are RLS-locked). Attribution hooks into the SIWE
// verify route, so both MetaMask + HashPack are tracked through the one
// canonical EVM address the auth layer already produces.
//
// Identity: referral XP is keyed by 0.0.x account id (to fold into xp_balances +
// the leaderboard), so we resolve the canonical EVM address -> 0.0.x. Long-zero
// addresses decode directly; ECDSA aliases resolve via the mirror node (may be
// null for a brand-new MetaMask account with no on-chain presence yet — it gets
// backfilled on a later sign-in once the account exists).

import { createServiceRoleClient } from "@/lib/supabase/server";

const MIRROR = "https://mainnet-public.mirrornode.hedera.com";
// lowercase base36, no ambiguous chars trimmed — 6 chars = 36^6 ≈ 2.2B space.
const CODE_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const CODE_LEN = 6;

export const REF_COOKIE = "fp_ref";
export const REF_CODE_RE = /^[a-z0-9]{4,6}$/;

function randomCode(): string {
  const bytes = new Uint8Array(CODE_LEN);
  globalThis.crypto.getRandomValues(bytes);
  let s = "";
  for (const byte of bytes) s += CODE_ALPHABET.charAt(byte % CODE_ALPHABET.length);
  return s;
}

/** Canonical EVM address -> "0.0.x" account id, or null if unresolvable. */
export async function resolveAccountId(evm: string): Promise<string | null> {
  const a = evm.toLowerCase().replace(/^0x/, "");
  if (a.length !== 40) return null;
  if (a.slice(0, 24) === "0".repeat(24)) {
    const num = parseInt(a.slice(24), 16); // long-zero: entity num in the low bytes
    return Number.isFinite(num) && num > 0 ? `0.0.${num}` : null;
  }
  try {
    const r = await fetch(`${MIRROR}/api/v1/accounts/0x${a}`, { cache: "no-store" });
    if (!r.ok) return null;
    const j = (await r.json()) as { account?: string };
    return typeof j?.account === "string" ? j.account : null;
  } catch {
    return null;
  }
}

/** Ensure `address` has a referral code; returns it (or null on failure). */
export async function ensureReferralCode(
  address: string,
  accountId: string | null,
): Promise<string | null> {
  const supa = createServiceRoleClient();
  const { data: existing } = await supa
    .from("referral_codes")
    .select("code, owner_account_id")
    .eq("owner_address", address)
    .maybeSingle();
  if (existing) {
    if (accountId && !existing.owner_account_id) {
      await supa
        .from("referral_codes")
        .update({ owner_account_id: accountId })
        .eq("owner_address", address);
    }
    return existing.code;
  }
  for (let i = 0; i < 8; i++) {
    const code = randomCode();
    const { error } = await supa
      .from("referral_codes")
      .insert({ code, owner_address: address, owner_account_id: accountId });
    if (!error) return code;
    // Unique-violation on owner_address means a concurrent insert won — re-read.
    if (error.code === "23505") {
      const { data: row } = await supa
        .from("referral_codes")
        .select("code")
        .eq("owner_address", address)
        .maybeSingle();
      if (row) return row.code;
      // else it was a code-PK collision; loop + retry a fresh code.
    }
  }
  return null;
}

/** Record a referral (first-touch wins; no self-referral). Returns true if newly bound. */
export async function recordReferral(
  refereeAddress: string,
  refereeAccountId: string | null,
  code: string,
): Promise<boolean> {
  const supa = createServiceRoleClient();
  const { data: codeRow } = await supa
    .from("referral_codes")
    .select("owner_address, owner_account_id")
    .eq("code", code)
    .maybeSingle();
  if (!codeRow || codeRow.owner_address === refereeAddress) return false; // unknown code / self-referral
  const { error } = await supa.from("referrals").insert({
    referee_address: refereeAddress,
    referrer_address: codeRow.owner_address,
    code,
    referrer_account_id: codeRow.owner_account_id,
    referee_account_id: refereeAccountId,
  });
  return !error; // PK conflict (already referred) -> error -> false, benign
}

/** Backfill a referee's 0.0.x once known, so first-tx XP can be awarded. */
export async function backfillRefereeAccount(
  refereeAddress: string,
  refereeAccountId: string | null,
): Promise<void> {
  if (!refereeAccountId) return;
  const supa = createServiceRoleClient();
  await supa
    .from("referrals")
    .update({ referee_account_id: refereeAccountId })
    .eq("referee_address", refereeAddress)
    .is("referee_account_id", null);
}

/** True if no `users` row exists yet for this address (i.e. first sign-in). */
export async function isNewUser(address: string): Promise<boolean> {
  const supa = createServiceRoleClient();
  const { data } = await supa.from("users").select("address").eq("address", address).maybeSingle();
  return !data;
}

/**
 * Keep users.account_id fresh — the SINGLE resolution source recompute_xp +
 * referral_stats use to map a referrer/referee address -> 0.0.x. Setting it on
 * every sign-in (and the periodic sweep) is what stops a stale/null snapshot
 * from silently zeroing referral XP. account_id is stable per address, so we
 * only fill it when currently null.
 */
export async function setUserAccountId(address: string, accountId: string | null): Promise<void> {
  if (!accountId) return;
  const supa = createServiceRoleClient();
  await supa.from("users").update({ account_id: accountId }).eq("address", address).is("account_id", null);
}

/** True if this 0.0.x account has >=1 successful on-chain action (bounds late attribution). */
export async function accountHasTx(accountId: string | null): Promise<boolean> {
  if (!accountId) return false;
  const supa = createServiceRoleClient();
  const { data } = await supa
    .from("xp_balances")
    .select("account_id")
    .eq("account_id", accountId)
    .gt("action_count", 0)
    .maybeSingle();
  return !!data;
}
