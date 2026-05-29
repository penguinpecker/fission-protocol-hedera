// POST /api/auth/verify
//
// Two signing flows supported. Body discriminator: `mode`.
//
//   mode: "eip191" (default, ECDSA / EVM wallets via wagmi)
//     { mode: "eip191", message: SIWE-string, signature: 0x... }
//
//   mode: "hedera" (NEW — Ed25519 or ECDSA via @hashgraph/hedera-wallet-connect)
//     { mode: "hedera", accountId: "0.0.X", message: string, signatureMap: base64 }
//
// Both flows:
//   1. Validate the signature against the claimed identity.
//   2. Parse the embedded `Nonce: <hex>` line, atomically flip its
//      consumed_at in auth_nonces.
//   3. Upsert the user (keyed by EVM/long-zero address).
//   4. Sign + attach the same httpOnly session cookie.

import { NextResponse, type NextRequest } from "next/server";
import { SiweMessage } from "siwe";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { signSession, attachSessionCookie } from "@/lib/auth/session";

const EXPECTED_CHAIN_ID = Number(process.env.NEXT_PUBLIC_HEDERA_CHAIN_ID ?? "295");

type Mode = "eip191" | "hedera";

interface CommonBody {
  mode?: Mode;
}

interface Eip191Body extends CommonBody {
  mode?: "eip191";
  message: string;
  signature: string;
}

interface HederaBody extends CommonBody {
  mode: "hedera";
  accountId: string;     // "0.0.NNNNN"
  message: string;
  signatureMap: string;  // base64-encoded protobuf SignatureMap
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const mode: Mode = ((body as CommonBody)?.mode ?? "eip191") as Mode;

  // Origin gate. WEB2-02 fix: in production we fail CLOSED on a missing or
  // untrusted Origin header. Previously a request with NO Origin fell back to
  // the (attacker-uncontrolled-but-also-unbound) Host header, so an attacker
  // who simply omitted the Origin header bypassed the gate. Now: prod requires
  // a present, parseable, allowlisted Origin; dev keeps the Host fallback for
  // local tooling that doesn't send Origin.
  const isProd = process.env.NODE_ENV === "production";
  const origin = req.headers.get("origin");
  let originHost: string | null = null;
  if (origin) {
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = null;
    }
  }
  if (isProd) {
    // Fail closed: no Origin (or unparseable) → untrusted.
    if (!originHost || !isTrustedProdHost(originHost)) {
      return NextResponse.json({ error: "untrusted_origin" }, { status: 401 });
    }
  } else if (!originHost) {
    // Dev only: tolerate missing Origin by falling back to Host.
    originHost = req.headers.get("host") ?? "localhost";
  }

  // From here originHost is a trusted host (prod) or best-effort (dev).
  const effectiveHost = originHost ?? (req.headers.get("host") ?? "localhost");

  if (mode === "hedera") {
    return verifyHedera(body as HederaBody, req, effectiveHost);
  }
  return verifyEip191(body as Eip191Body, effectiveHost, req);
}

/**
 * Server-side host allowlist for production logins.
 *
 * LP-1 fix: include the canonical Vercel production alias
 * (fission-protocol.vercel.app) alongside the custom domains so logins work on
 * that alias too (previously only www.fissionp.com / fissionp.com were trusted,
 * and the alias returned untrusted_origin).
 *
 * Preview-host logic is preserved: `frontend-*.vercel.app` deploy previews and
 * localhost remain trusted.
 */
const PROD_HOSTS = new Set([
  "fissionp.com",
  "www.fissionp.com",
  "fission-protocol.vercel.app", // LP-1: canonical Vercel production alias
]);

function isTrustedProdHost(host: string): boolean {
  if (PROD_HOSTS.has(host)) return true;
  // Deploy previews: frontend-<hash>-<scope>.vercel.app
  if (host.endsWith(".vercel.app") && host.startsWith("frontend-")) return true;
  // Local tooling pointed at a prod build.
  if (/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return true;
  return false;
}

/* ───────────────────────────────────────────────── EIP-191 / SIWE path */

async function verifyEip191(body: Eip191Body, originHost: string, req: NextRequest) {
  const { message, signature } = body;
  if (typeof message !== "string" || typeof signature !== "string") {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  let siwe: SiweMessage;
  try {
    siwe = new SiweMessage(message);
  } catch {
    return NextResponse.json({ error: "siwe_parse" }, { status: 400 });
  }

  let verified;
  try {
    verified = await siwe.verify({ signature, domain: originHost, nonce: siwe.nonce });
  } catch (e) {
    // WEB2-04: log diagnostics server-side, return an opaque code to the client.
    console.error("siwe_verify_threw", { expected: originHost, gotInMessage: siwe.domain, detail: String(e) });
    return NextResponse.json({ error: "siwe_verify_threw" }, { status: 401 });
  }
  if (!verified.success) {
    console.error("siwe_verify_failed", { expected: originHost, gotInMessage: siwe.domain });
    return NextResponse.json({ error: "siwe_verify_failed" }, { status: 401 });
  }
  if (siwe.chainId !== EXPECTED_CHAIN_ID) {
    return NextResponse.json({ error: "wrong_chain" }, { status: 400 });
  }

  const lower = siwe.address.toLowerCase();
  return consumeNonceAndIssueCookie(lower, siwe.nonce, req, siwe.chainId);
}

/* ─────────────────────────────────────────────── Hedera-native sig path */

/**
 * WEB2-01: verify the signed Hedera message commits to OUR host.
 *
 * The client builds the first line as
 *   `<host> wants you to sign in with your Hedera account:`
 * (see useSiweAuth.ts). We require that exact prefix with the server-trusted
 * host, so a message signed for some other domain can't be replayed here.
 */
function messageBindsHost(message: string, host: string): boolean {
  const firstLine = message.split("\n", 1)[0] ?? "";
  return firstLine === `${host} wants you to sign in with your Hedera account:`;
}

/**
 * WEB2-AUTH-03: verify the signed Hedera message commits to the expected chain.
 * Mirrors the EIP-191 path's `siwe.chainId !== EXPECTED_CHAIN_ID` check.
 * The client emits a literal `Chain ID: <n>` line.
 */
function messageBindsChainId(message: string, chainId: number): boolean {
  const m = message.match(/^Chain ID:\s*(\d+)\s*$/m);
  return m !== null && Number(m[1]) === chainId;
}

/** Construct the canonical long-zero EVM address from a Hedera account ID. */
function longZeroFromAccountId(accountId: string): string {
  const parts = accountId.split(".");
  if (parts.length !== 3) throw new Error("bad accountId");
  const num = Number(parts[2]);
  if (!Number.isFinite(num) || num < 0) throw new Error("bad accountId num");
  return "0x" + num.toString(16).padStart(40, "0");
}

/**
 * CSPK-01: pick the ONE canonical EVM address that keys this account's session,
 * nonce, profile, and watchlist — it MUST match the address the client minted
 * the nonce under.
 *
 * The frontend provider (hedera-wallet/provider.tsx `resolveEvmAddress`) resolves
 * the account's REAL ECDSA alias from Mirror Node's `evm_address` and the SIWE
 * hook (useSiweAuth.ts) mints the nonce under THAT alias. So the server must
 * consume the nonce under the same real alias. Only fall back to the long-zero
 * for true Ed25519 accounts, which never registered a real alias — for those
 * Mirror returns the long-zero (or null) in `evm_address`, so there is nothing
 * else to key on. This mirrors the provider's logic exactly: one wallet → one
 * identity on both sides.
 */
function canonicalAddressForHedera(accountId: string, mirrorEvmAddress: string | null): string {
  const longZero = longZeroFromAccountId(accountId).toLowerCase();
  if (
    mirrorEvmAddress &&
    /^0x[0-9a-fA-F]{40}$/.test(mirrorEvmAddress) &&
    mirrorEvmAddress.toLowerCase() !== longZero
  ) {
    // Genuine ECDSA alias — the form the client minted under.
    return mirrorEvmAddress.toLowerCase();
  }
  // Ed25519 (no real alias): long-zero is the only address such accounts have.
  return longZero;
}

async function verifyHedera(body: HederaBody, req: NextRequest, originHost: string) {
  const { accountId, message, signatureMap } = body;
  if (typeof accountId !== "string" || typeof message !== "string" || typeof signatureMap !== "string") {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  if (!/^0\.0\.\d+$/.test(accountId)) {
    return NextResponse.json({ error: "bad_account_id" }, { status: 400 });
  }

  // WEB2-01 + WEB2-AUTH-03 fix: the Hedera path previously validated only the
  // Nonce line, so a signed message harvested for one domain/chain was replayable
  // against this server. Mirror the EIP-191/SIWE binding: require the signed
  // message to carry BOTH the server-allowlisted host AND the expected Chain ID.
  // The client constructs the message; we refuse to honor a signature unless the
  // signed text commits to our host + chain.
  if (!messageBindsHost(message, originHost)) {
    return NextResponse.json({ error: "domain_mismatch" }, { status: 401 });
  }
  if (!messageBindsChainId(message, EXPECTED_CHAIN_ID)) {
    return NextResponse.json({ error: "wrong_chain" }, { status: 400 });
  }

  // 1. Fetch the account's current public key from Mirror Node — authoritative
  //    source of truth. Never trust a key embedded in the signatureMap.
  //    The SAME response also carries `evm_address`, which we use below to pick
  //    the canonical session/nonce key (CSPK-01) — so this is one round trip.
  let publicKeyString: string;
  let mirrorEvmAddress: string | null = null;
  try {
    const r = await fetch(
      `https://mainnet-public.mirrornode.hedera.com/api/v1/accounts/${accountId}`,
      { cache: "no-store" },
    );
    if (!r.ok) throw new Error(`mirror node ${r.status}`);
    const j = (await r.json()) as { key?: { key?: string }; evm_address?: string | null };
    if (!j.key?.key) throw new Error("no key in mirror response");
    publicKeyString = j.key.key;
    mirrorEvmAddress = j.evm_address ?? null;
  } catch (e) {
    // WEB2-04: opaque code out, detail to server logs only.
    console.error("mirror_lookup_failed", String(e));
    return NextResponse.json({ error: "mirror_lookup_failed" }, { status: 502 });
  }

  // 2. Verify the signature using the library helper. This re-applies the
  //    Hedera message prefix ("\x19Hedera Signed Message:\n<len>") internally
  //    and validates the protobuf-wrapped sig against the public key.
  let ok = false;
  try {
    // Deep import from /shared to dodge the wallet-side code that pulls in
    // @reown/walletkit (not needed server-side).
    const [hwc, sdk] = await Promise.all([
      import("@hashgraph/hedera-wallet-connect/dist/lib/shared/utils.js"),
      import("@hashgraph/sdk"),
    ]);
    const publicKey = sdk.PublicKey.fromString(publicKeyString);
    ok = (hwc as { verifyMessageSignature: (m: string, s: string, k: typeof publicKey) => boolean }).verifyMessageSignature(message, signatureMap, publicKey);
  } catch (e) {
    // WEB2-04: opaque code out, detail to server logs only.
    console.error("hedera_verify_threw", String(e));
    return NextResponse.json({ error: "hedera_verify_threw" }, { status: 401 });
  }
  if (!ok) {
    return NextResponse.json({ error: "hedera_verify_failed" }, { status: 401 });
  }

  // 3. Parse the nonce out of the message. Same `Nonce: <hex>` line we use
  //    in the SIWE flow, so the auth_nonces table is reused unchanged.
  const nonceMatch = message.match(/^Nonce:\s*([0-9a-fA-F]+)\s*$/m);
  if (!nonceMatch) {
    return NextResponse.json({ error: "no_nonce_in_message" }, { status: 400 });
  }
  const nonce = nonceMatch[1];
  if (!nonce) {
    return NextResponse.json({ error: "no_nonce_in_message" }, { status: 400 });
  }

  // 4. CSPK-01: key the session/nonce/profile on the SAME canonical address the
  //    client minted the nonce under. For ECDSA accounts that's the real Mirror
  //    `evm_address` alias (the provider resolves it; the SIWE hook nonces under
  //    it). For true Ed25519 accounts it's the long-zero. Consuming under the
  //    long-zero for an ECDSA account matched 0 rows → invalid_or_expired_nonce
  //    401 after a valid signature, breaking every ECDSA HashPack login.
  const address = canonicalAddressForHedera(accountId, mirrorEvmAddress);
  return consumeNonceAndIssueCookie(address, nonce, req, EXPECTED_CHAIN_ID);
}

/* ────────────────────────────────────────── shared nonce + session step */

async function consumeNonceAndIssueCookie(
  lowerAddress: string,
  nonce: string,
  req: NextRequest,
  chainId: number,
) {
  if (!/^0x[a-f0-9]{40}$/.test(lowerAddress)) {
    return NextResponse.json({ error: "bad_address_normalized" }, { status: 500 });
  }
  const supa = createServiceRoleClient();
  const { data: flipped, error: flipErr } = await supa
    .from("auth_nonces")
    .update({ consumed_at: new Date().toISOString() })
    .eq("nonce", nonce)
    .eq("address", lowerAddress)
    .is("consumed_at", null)
    .gt("expires_at", new Date().toISOString())
    .select()
    .single();
  if (flipErr || !flipped) {
    return NextResponse.json({ error: "invalid_or_expired_nonce" }, { status: 401 });
  }

  // Atomic upsert + sign-in-count increment via the record_sign_in RPC
  // (added in 20260525000000_track_session_metadata.sql). No IP collection —
  // only an anonymized "browser/os" summary. Failure here is non-fatal: the
  // nonce is already consumed and the session cookie still issues.
  const uaSummary = summarizeUserAgent(req.headers.get("user-agent"));
  const { error: rpcErr } = await supa.rpc("record_sign_in", {
    p_address: lowerAddress,
    p_user_agent_summary: uaSummary,
    p_chain_id: chainId,
  });
  if (rpcErr) {
    console.error("record_sign_in failed", rpcErr.message);
  }

  const token = await signSession(lowerAddress);
  const res = NextResponse.json({ ok: true, address: lowerAddress });
  attachSessionCookie(res, token);
  return res;
}

// Reduce a full user-agent string to "Browser / OS" — no version flood, no
// full UA storage. Returns null for missing / unparseable input.
function summarizeUserAgent(ua: string | null): string | null {
  if (!ua) return null;
  const browser =
    /edg\//i.test(ua) ? "Edge"
    : /opera|opr\//i.test(ua) ? "Opera"
    : /chrome\//i.test(ua) ? "Chrome"
    : /firefox\//i.test(ua) ? "Firefox"
    : /safari\//i.test(ua) ? "Safari"
    : "Other";
  const os =
    /windows nt/i.test(ua) ? "Windows"
    : /android/i.test(ua) ? "Android"
    : /iphone|ipad|ipod/i.test(ua) ? "iOS"
    : /mac os x/i.test(ua) ? "macOS"
    : /linux/i.test(ua) ? "Linux"
    : "Other";
  return `${browser} / ${os}`;
}
