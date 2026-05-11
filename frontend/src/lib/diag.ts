// Lightweight client → server diag logger. POSTs JSON to /api/diag which
// console.logs with [fission-diag] prefix for `vercel logs` grep.
//
// Address is truncated (0xab12…7c8d) to avoid full-address logging. No
// PII otherwise — just wallet wire-state + render branches we care about.

function shortAddr(a: string | undefined): string | undefined {
  if (!a) return a;
  if (a.length < 12) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function diag(tag: string, payload: Record<string, unknown>): void {
  if (typeof window === "undefined") return;
  const body = JSON.stringify({
    t: Date.now(),
    tag,
    route: typeof location !== "undefined" ? location.pathname : "?",
    ua: navigator.userAgent.slice(0, 80),
    ...payload,
    address: shortAddr(payload.address as string | undefined),
  });
  // Fire-and-forget; never block the UI on this.
  void fetch("/api/diag", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: true,
  }).catch(() => {});
}
