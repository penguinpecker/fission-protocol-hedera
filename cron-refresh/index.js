#!/usr/bin/env node
// Long-running worker that POSTs /api/markets/refresh every INTERVAL_MS.
// Runs as a regular Railway service (restart-on-failure); we don't rely on
// Railway's cron-schedule feature because the CLI doesn't expose it and
// railway.json `cronSchedule` was being ignored on this deployment.

const url = process.env.REFRESH_URL;
const secret = process.env.CRON_SECRET;
const intervalMs = Number(process.env.INTERVAL_MS ?? 60_000);

if (!url || !secret) {
  console.error("missing REFRESH_URL or CRON_SECRET env");
  process.exit(1);
}

async function tick() {
  const started = Date.now();
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
    });
    const body = await r.text();
    const ms = Date.now() - started;
    console.log(JSON.stringify({ t: new Date().toISOString(), status: r.status, ms, body: body.slice(0, 200) }));
  } catch (e) {
    console.error(JSON.stringify({ t: new Date().toISOString(), error: e instanceof Error ? e.message : String(e) }));
  }
}

console.log(JSON.stringify({ t: new Date().toISOString(), msg: "worker_started", intervalMs }));
await tick();
setInterval(tick, intervalMs);
