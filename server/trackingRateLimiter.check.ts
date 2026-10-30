// Run: npx tsx server/trackingRateLimiter.check.ts
import assert from "node:assert/strict";
import express from "express";
import { trackingRateLimiter } from "./security";

async function main() {
  const app = express();
  app.post("/t", trackingRateLimiter, (_req, res) => res.json({ ok: true }));
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;

  const statuses: number[] = [];
  for (let i = 0; i < 70; i++) statuses.push((await fetch(`http://127.0.0.1:${port}/t`, { method: "POST" })).status);
  server.close();

  assert.ok(statuses.slice(0, 60).every((s) => s === 200), "normal browsing (60 hits/min) must pass");
  assert.ok(statuses.slice(60).every((s) => s === 429), "hits beyond 60/min must be rejected");
  console.log("trackingRateLimiter: ok");
  process.exit(0); // security.ts pulls in the DB pool, which would keep the process open
}

main();
