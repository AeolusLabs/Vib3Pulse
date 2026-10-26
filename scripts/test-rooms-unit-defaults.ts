// Hosting defaults + quick controls checks (no database):   npx tsx scripts/test-rooms-unit-defaults.ts   (also run by npm run test:rooms)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULT_ROOM_DEFAULTS, resolveRoomDefaults, validateRoomDefaults } from "../shared/rooms";

let passed = 0, failed = 0;
const t = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`PASS ${name}`); } catch (e: any) { failed++; console.log(`FAIL ${name}  ${e.message.split("\n")[0]}`); }
};
const src = (p: string) => readFileSync(p, "utf8");
const ok = { voice: true, liveVideo: false, slowModeSec: 5, sprayEnabled: true };

t("a valid body is accepted as is", () => assert.deepEqual(validateRoomDefaults(ok), { ok: true, value: ok }));
t("unknown keys, wrong types and odd slow modes name the bad field", () => {
  assert.deepEqual(validateRoomDefaults({ ...ok, evil: 1 }), { ok: false, field: "evil" });
  assert.deepEqual(validateRoomDefaults({ ...ok, voice: "yes" }), { ok: false, field: "voice" });
  assert.deepEqual(validateRoomDefaults({ ...ok, slowModeSec: 7 }), { ok: false, field: "slowModeSec" });
  assert.deepEqual(validateRoomDefaults({ ...ok, slowModeSec: "5" }), { ok: false, field: "slowModeSec" });
  assert.deepEqual(validateRoomDefaults({ ...ok, sprayEnabled: 1 }), { ok: false, field: "sprayEnabled" });
  for (const bad of [null, undefined, 5, "x", [], true]) assert.equal(validateRoomDefaults(bad).ok, false);
});
t("live video without voice is refused", () => assert.deepEqual(validateRoomDefaults({ ...ok, voice: false, liveVideo: true }), { ok: false, field: "liveVideo" }));
t("a stored value is read tolerantly", () => {
  assert.deepEqual(resolveRoomDefaults(null), DEFAULT_ROOM_DEFAULTS);
  assert.deepEqual(resolveRoomDefaults({ voice: false, liveVideo: true, slowModeSec: 99, sprayEnabled: "x" }), { voice: false, liveVideo: false, slowModeSec: 0, sprayEnabled: false });
  assert.deepEqual(resolveRoomDefaults(ok), ok);
});
t("the saved value is private to its owner and read through its own route", () => {
  assert.match(src("server/auth.ts"), /PUBLIC_HIDDEN_USER_FIELDS = \[[^\]]*"roomDefaults"/);
  const routes = src("server/rooms/roomRoutes.ts");
  assert.match(routes, /app\.get\("\/api\/users\/me\/room-defaults", requireAuth/);
  assert.match(routes, /app\.put\("\/api\/users\/me\/room-defaults", requireAuth, roomLimiter/);
  assert.match(src("migrations/add_user_room_defaults.sql"), /ADD COLUMN IF NOT EXISTS room_defaults jsonb/);
});
t("the create form starts from the saved defaults and an explicit preset wins", () => {
  const w = src("client/src/components/rooms/create/CreateRoomWizard.tsx");
  assert.ok(w.includes("defaultWizardState({ ...mine, ...defaults })"));
  assert.ok(w.includes("fit({ ...s, ...mine, ...defaults })"));
});
t("the rail opens quick controls for a host or co-host and options for a viewer", () => {
  const shell = src("client/src/components/rooms/shell/RoomShell.tsx");
  assert.match(shell, /onOptions=\{\(\) => \(isCoHostOrHost \? setQuickOpen\(true\) : setMoreOpen\(true\)\)\}/);
  assert.match(shell, /<QuickControlsSheet[\s\S]*?onAll=\{\(\) => \{ setControlsFrom\(null\); setControlsOpen\(true\); \}\}/);
});
t("lock and slow mode in quick controls are host only", () => {
  const q = src("client/src/components/rooms/shell/QuickControlsSheet.tsx");
  assert.match(q, /\{isHost && \(\s*<>[\s\S]*quick-lock[\s\S]*quick-slow-/);
});
t("settings home lists the new topics", () => {
  const home = src("client/src/pages/SettingsPage.tsx");
  for (const k of ["/settings/hosting", "/settings/spray", "/map?sharing=1"]) assert.ok(home.includes(k), k);
  assert.ok(src("client/src/pages/MapPage.tsx").includes('get("sharing") === "1"'));
  const app = src("client/src/App.tsx");
  assert.ok(app.includes('path="/settings/hosting"') && app.includes('path="/settings/spray"'));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
