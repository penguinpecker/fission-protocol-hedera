// Best-effort in-memory per-IP rate limiter.
//
// WEB2-07 (partial): /api/auth/nonce and /api/diag are unauthenticated and were
// previously uncapped. This adds a lightweight fixed-window limiter with NO new
// infrastructure (no Redis, no paid WAF).
//
// LIMITATIONS — read before relying on this:
//   - State lives in module scope, so it is PER serverless instance. On Vercel
//     a burst can be spread across many warm/cold instances, weakening the cap.
//     It still throttles a single hot instance and bounds memory, which is the
//     realistic abuse vector for these two cheap endpoints.
//   - For a hard global limit, front these routes with the Vercel Firewall /
//     WAF rate-limit rules (platform-level, survives across instances). This
//     module is the no-infra floor, not a substitute for that.
//   - The map is swept lazily on access to keep memory bounded.

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
let lastSweep = 0;

function sweep(now: number) {
  // Sweep at most once per 60s to keep the map from growing unbounded under
  // a wide spread of client IPs.
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [k, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(k);
  }
}

export interface RateLimitResult {
  ok: boolean;
  /** Seconds until the window resets (for Retry-After). */
  retryAfter: number;
}

/**
 * Fixed-window limiter. Returns ok=false once `limit` is exceeded within
 * `windowMs` for the given key.
 */
export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  sweep(now);
  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfter: 0 };
  }
  existing.count += 1;
  if (existing.count > limit) {
    return { ok: false, retryAfter: Math.ceil((existing.resetAt - now) / 1000) };
  }
  return { ok: true, retryAfter: 0 };
}

/**
 * Best-effort client IP from proxy headers. Vercel sets x-forwarded-for; we
 * take the left-most (original client) hop. Falls back to a constant bucket so
 * a missing header still shares one limited bucket rather than bypassing.
 *
 * NOTE: the left-most hop is shared by everyone behind a NAT/CGNAT/corporate/
 * conference egress, so callers that gate a *per-user* action (e.g. minting a
 * SIWE nonce) MUST NOT key on this IP alone — that locks out co-located users.
 * Compose it with a per-user discriminator (e.g. the address being signed):
 * `nonce:${clientIp(req)}:${address}`. The IP component still bounds abuse from
 * a single host; the per-user component keeps distinct users from colliding.
 */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip") ?? "unknown";
}
