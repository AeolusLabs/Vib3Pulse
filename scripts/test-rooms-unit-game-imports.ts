// Module init order: spray, teamSpray, game and stage sit in import cycles (via roomSocket, clawbacks, RoomHub). Importing them
// in ANY order must not throw (a top-level call into a const of a half-loaded module is a ReferenceError).
// Each order runs in its own process so the module cache never hides a problem.   npx tsx scripts/test-rooms-unit-game-imports.ts
import { spawnSync } from "node:child_process";

const mods = ["spray", "teamSpray", "game", "stage", "clawbacks", "sprayJobs", "sprayRoutes", "roomSocket", "roomRoutes"];
const orders: string[][] = [
  ["teamSpray", "spray", "game", "stage"], ["spray", "teamSpray", "game", "stage"], ["game", "stage", "spray", "teamSpray"],
  ["stage", "game", "teamSpray", "spray"], ["stage", "teamSpray"], ["game", "teamSpray"], ["clawbacks", "teamSpray", "spray"],
  ["sprayJobs"], ["roomSocket", "teamSpray"], ["roomRoutes", "spray"], ...mods.map((m) => [m]),
];
let passed = 0, failed = 0;
for (const order of orders) {
  const code = order.map((m) => `await import("./server/rooms/${m}");`).join(" ") + " process.exit(0);"; // some modules start timers
  const r = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
    cwd: process.cwd(), encoding: "utf8", shell: false, timeout: 60_000,
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL || "postgres://u:p@127.0.0.1:1/none_unit_import_test", DISABLE_GEOCODING: "1", RESEND_API_KEY: process.env.RESEND_API_KEY || "re_dummy_not_real", SESSION_SECRET: process.env.SESSION_SECRET || "imports-test-secret" },
  });
  const ok = r.status === 0;
  if (ok) passed++; else failed++;
  console.log(`${ok ? "PASS" : "FAIL"} import order: ${order.join(" -> ")}${ok ? "" : `  ${(r.stderr || "").split("\n").filter((l) => /Error/.test(l))[0] ?? r.status}`}`);
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
