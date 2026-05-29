// Constant-time string comparison for secrets (CRON_SECRET bearer tokens, etc).
//
// A plain `a === b` short-circuits on the first differing byte, leaking the
// length of the matching prefix via response timing. `crypto.timingSafeEqual`
// compares in constant time but throws if the two buffers differ in length —
// which itself leaks length. We hash both inputs to a fixed-width digest first
// so length never affects the comparison or its timing.

import { createHash, timingSafeEqual } from "node:crypto";

/** Constant-time equality for two UTF-8 strings. */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  // Digests are always 32 bytes, so timingSafeEqual never throws on length.
  return timingSafeEqual(ha, hb);
}
