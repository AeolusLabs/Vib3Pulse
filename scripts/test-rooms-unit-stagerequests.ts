// Stage request + settings home wiring checks (no database):   npx tsx scripts/test-rooms-unit-stagerequests.ts   (also run by npm run test:rooms)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { requestQueue, roleChange } from "../client/src/lib/hostControls";

let passed = 0, failed = 0;
const t = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`PASS ${name}`); } catch (e: any) { failed++; console.log(`FAIL ${name}  ${e.message.split("\n")[0]}`); }
};
const src = (p: string) => readFileSync(p, "utf8");

t("the request card shows the oldest waiting request first, hands before camera asks", () => {
  const q = requestQueue(["a", "b"], ["c"], true, new Set());
  assert.deepEqual(q.map((i) => `${i.kind}:${i.userId}`), ["hand:a", "hand:b", "live:c"]);
});
t("a handled request is hidden until the server drops it", () => {
  assert.deepEqual(requestQueue(["a", "b"], [], false, new Set(["hand:a"])).map((i) => i.userId), ["b"]);
});
t("only a host can change a role, never their own or the host's", () => {
  assert.equal(roleChange("host", { userId: "x", role: "guest" }, "me"), "make-cohost");
  assert.equal(roleChange("host", { userId: "x", role: "cohost" }, "me"), "remove-cohost");
  assert.equal(roleChange("cohost", { userId: "x", role: "guest" }, "me"), null);
  assert.equal(roleChange("host", { userId: "me", role: "guest" }, "me"), null);
});

const shell = src("client/src/components/rooms/shell/RoomShell.tsx");
const cards = src("client/src/components/rooms/shell/StageRequests.tsx");
t("host and co-host get the request card; a viewer gets the waiting card", () => {
  assert.match(shell, /isCoHostOrHost && state\.phase === "live" && \(\s*<HostRequestCard/);
  assert.match(shell, /role === "guest" && !listenOnly && \(\s*<ViewerAskCard/);
});
t("accepting a mic sends the same room:stage accept the Requests tab sends; Undo takes it back", () => {
  assert.match(shell, /stageAction\("accept", i\.userId\)/);
  assert.match(shell, /onUndo=\{\(uid\) => sock\.stageAction\("remove", uid\)\}/);
});
t("a declined viewer sees the agreed line", () => assert.ok(cards.includes("The host isn't taking requests right now")));
t("the avatar sheet offers co-host only to the host, via the socket's setRole", () => {
  assert.match(shell, /onRole=\{role === "host" \?/);
  assert.match(shell, /sock\.setRole\(uid, to\)/);
});
t("the rail has a one-tap Room options button with the waiting count", () => {
  const rail = src("client/src/components/rooms/shell/ImmersiveRail.tsx");
  assert.ok(rail.includes('testId="button-rail-options"') && rail.includes("badge={waiting}"));
  assert.match(shell, /onOptions=\{\(\) => \(isCoHostOrHost \? setQuickOpen\(true\) : setMoreOpen\(true\)\)\}/);
});
t("a viewer can ask to go on stage from the options sheet", () => assert.ok(src("client/src/components/rooms/shell/RoomMoreSheet.tsx").includes('testid="more-ask"')));
t("Settings home links every topic and the nav points at it", () => {
  const home = src("client/src/pages/SettingsPage.tsx");
  for (const k of ["${A}account", "${A}notifications", "${A}privacy", "${A}verify", "/buddy/settings", "/avatar"]) assert.ok(home.includes(k), k);
  assert.match(src("client/src/App.tsx"), /<Route path="\/settings">/);
  assert.match(src("client/src/components/Navigation.tsx"), /href="\/settings"/);
});
t("the account page shows one topic for ?section= and everything without it", () => {
  const page = src("client/src/pages/AccountSettingsPage.tsx");
  assert.ok(page.includes("const show = (key: string) => !section || section === key"));
  for (const k of ["account", "privacy", "notifications", "verify"]) assert.ok(page.includes(`show("${k}")`), k);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
