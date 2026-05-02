import http from "node:http";

export interface HealthState {
  status: "ok" | "degraded" | "failing";
  lastSuccessfulPost: Record<string, number>;
  failureCount: Record<string, number>;
  startedAt: number;
}

export function startHealthServer(state: HealthState, port = 8080): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      const body = JSON.stringify({
        ...state,
        uptimeSec: Math.floor((Date.now() - state.startedAt) / 1000),
      });
      res.writeHead(state.status === "failing" ? 503 : 200, { "content-type": "application/json" });
      res.end(body);
      return;
    }
    if (req.url === "/metrics") {
      // minimal Prometheus exposition; expand as we add counters
      const lines: string[] = [];
      lines.push("# HELP fission_keeper_uptime_seconds Process uptime");
      lines.push("# TYPE fission_keeper_uptime_seconds gauge");
      lines.push(`fission_keeper_uptime_seconds ${Math.floor((Date.now() - state.startedAt) / 1000)}`);
      for (const [name, t] of Object.entries(state.lastSuccessfulPost)) {
        lines.push(`fission_keeper_last_post_seconds{adapter="${name}"} ${Math.floor(t / 1000)}`);
      }
      for (const [name, n] of Object.entries(state.failureCount)) {
        lines.push(`fission_keeper_failures_total{adapter="${name}"} ${n}`);
      }
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
      res.end(lines.join("\n") + "\n");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(port, () => log("info", "health server listening", { port }));
  return server;
}

export function log(level: "info" | "warn" | "error", msg: string, extra: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, msg, ts: new Date().toISOString(), ...extra });
  // structured JSON logs go to stdout (info/warn) or stderr (error) for log shippers.
  if (level === "error") console.error(line);
  else console.log(line);
}
